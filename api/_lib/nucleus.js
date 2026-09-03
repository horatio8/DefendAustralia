// Campaign Nucleus client.
//
// CN is the system of record for people. Every public form on the site lands
// in a CN form as an entry, and the person is upserted as a profile so they
// are segmentable even when a form field does not exist to hold the extra
// data (see FIELD NOTES below).
//
// Env: CN_API_TOKEN, optionally CN_API_BASE and CN_ACCOUNT_SLUG.
//
// FIELD NOTES. The CN form builder rejected the extra fields when these forms
// were created, so two forms are narrower than the site's forms:
//   dsg-contact   has no `topic`  — the topic is prefixed onto the message
//   dsg-volunteer has no `postcode` / `roles` — both ride on the profile as
//                 a note and tags, and both are always written to Airtable
// Anything CN drops is still captured in Airtable, so no submitted field is
// ever lost. If those form fields are added later, delete the workarounds in
// api/event-log.js and pass the values straight through.

const { withRetry } = require("./retry");

const FORMS = {
  petition: process.env.CN_PETITION_FORM_ID || "0ea069ec-0257-4b7c-81c3-a8e6cc3a0f28",
  contact: process.env.CN_CONTACT_FORM_ID || "e3a6dff2-91d1-4a3a-87e6-259116d840d7",
  volunteer: process.env.CN_VOLUNTEER_FORM_ID || "b2efb75b-d4b1-48e8-b84d-5149e0aea4df"
};

function base() {
  return (process.env.CN_API_BASE || "https://api.campaignnucleus.com/v1").replace(/\/+$/, "");
}

function configured() {
  return !!process.env.CN_API_TOKEN;
}

async function call(method, path, body) {
  if (!configured()) throw new Error("CN_API_TOKEN not set");
  const headers = {
    Authorization: "Bearer " + process.env.CN_API_TOKEN,
    Accept: "application/json",
    "Content-Type": "application/json"
  };
  if (process.env.CN_ACCOUNT_SLUG) headers["X-Account"] = process.env.CN_ACCOUNT_SLUG;
  // Nucleus is the system of record and is written first on every submission,
  // so a throttle here must be waited out rather than dropped.
  const r = await withRetry(
    () => fetch(base() + path, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    { label: method + " " + path }
  );
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON error body */ }
  if (!r.ok) {
    const msg = (json && (json.message || json.error)) || text.slice(0, 300) || ("HTTP " + r.status);
    const err = new Error("nucleus " + r.status + ": " + msg);
    err.status = r.status;
    throw err;
  }
  return json;
}

// One form entry. Returns the CN entry id so the Airtable row can prove the
// two systems agree.
async function submitEntry(formKey, fields) {
  const formId = FORMS[formKey];
  if (!formId) throw new Error("unknown CN form: " + formKey);
  const clean = {};
  Object.keys(fields || {}).forEach((k) => {
    const v = fields[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") clean[k] = v;
  });
  const res = await call("POST", "/forms/" + encodeURIComponent(formId) + "/entries", clean);
  return (res && res.data && res.data.id) || null;
}

// Has this email already signed this form? Used to keep a second press of the
// button, a back-button re-submit or a retry from adding another signature.
//
// The email is compared exactly against what Nucleus returns rather than
// trusting the search filter. If the filter were ever ignored the endpoint
// would return unrelated entries, and this would then report no duplicate and
// let the signature through, which is the safe direction to fail.
async function entryExists(formKey, email) {
  const formId = FORMS[formKey];
  const target = String(email || "").trim().toLowerCase();
  if (!formId || !target) return false;
  const res = await call("GET", "/forms/" + encodeURIComponent(formId) +
    "/entries?filter%5Bsearch%5D=" + encodeURIComponent(target) + "&page%5Bsize%5D=5");
  const rows = (res && res.data) || [];
  return rows.some((r) => String(r.email || "").trim().toLowerCase() === target);
}

// Live entry total for a form. This is what the site's counter reads, so the
// number on the page and the number in the CRM cannot drift.
async function entryCount(formKey) {
  const formId = FORMS[formKey];
  if (!formId) throw new Error("unknown CN form: " + formKey);
  const res = await call("GET", "/forms/" + encodeURIComponent(formId) + "/entries?page%5Bsize%5D=1&page%5Bnumber%5D=1");
  const m = res && res.meta && res.meta.pagination;
  if (m && typeof m.total === "number") return m.total;
  if (res && Array.isArray(res.data)) return res.data.length;
  throw new Error("no entry total in response");
}

// Profile upsert. Nucleus matches on its own identity strategies (email and
// mobile among them) and creates only when nothing matches. This carries the
// fields no form column exists for, plus the tags used for segmentation.
//
// The route is POST /profiles/match. Field names are Nucleus's, not ours:
// mobile rather than phone, zip rather than postcode.
async function upsertProfile(p) {
  const body = {
    email: p.email,
    first_name: p.first_name || undefined,
    last_name: p.last_name || undefined,
    mobile: p.mobile || undefined,
    zip: p.postcode || undefined,
    country: "AU"
  };
  if (p.tags && p.tags.length) body.tags = p.tags;
  if (p.note) body.custom1 = String(p.note).slice(0, 250);
  // The survey token. It goes into whichever custom slot the CRM has been set
  // up with, named by env rather than hardcoded.
  //
  // Nothing else may write to that slot. In the reference build a partial
  // capture wrote a timestamp into the same field and destroyed every survey
  // token in the account, which is why this is the only place it is set and
  // why the partial beacon never calls this function with a uid.
  if (p.uid && p.uidField) body[p.uidField] = String(p.uid).toUpperCase().slice(0, 64);
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
  const res = await call("POST", "/profiles/match", body);
  return (res && res.data && res.data.id) || null;
}

/* Drop a person into a Campaign Nucleus automation by id.
 *
 * POST /automations/{id}/profiles. The id has to come from the CN interface,
 * because automations are the one part of Nucleus with no create endpoint:
 * they can be driven by API and only built by hand. That asymmetry is why the
 * ids are env vars and why the caller has to survive them being absent.
 *
 * Enrolling by id rather than by tag is what makes an A/B arm possible. A tag
 * fires whichever single automation is listening for it, so two arms need two
 * automations and a choice between them at send time. */
async function automationAdd(automationId, p) {
  const id = String(automationId || "").trim();
  if (!id) return { ok: false, skipped: true, reason: "no automation id configured" };
  const body = {
    email: p.email || undefined,
    first_name: p.first_name || undefined,
    last_name: p.last_name || undefined,
    mobile: p.mobile || undefined,
    zip: p.postcode || undefined,
    country: "AU"
  };
  if (p.tags && p.tags.length) body.tags = p.tags;
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
  try {
    const res = await call("POST", "/automations/" + encodeURIComponent(id) + "/profiles", body);
    return { ok: true, id: (res && res.data && res.data.id) || null };
  } catch (err) {
    // Never throws to the caller. A follow-up that fails to enrol must not
    // take down the sweep for everyone behind it in the queue.
    console.error("CN_AUTOMATION_ADD_FAIL", id, err.message);
    return { ok: false, error: String(err.message || err).slice(0, 200) };
  }
}

/* One profile by its own id.
 *
 * Read-only, and the only caller is the prefill path. Nucleus is asked rather
 * than Airtable because Airtable holds only the people who have interacted
 * with this site, and an email goes to everyone on the list — most of whom
 * this site has never seen.
 *
 * A missing profile is null, not a throw. The caller must not be able to tell
 * "no such profile" from "malformed id", so both have to reach the same
 * uniform answer. */
async function profile(id) {
  try {
    const json = await call("GET", "/profiles/" + encodeURIComponent(id));
    const p = (json && (json.data || json)) || null;
    return p && p.id ? p : null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

module.exports = { FORMS, configured, submitEntry, entryExists, entryCount, upsertProfile, automationAdd, profile };
