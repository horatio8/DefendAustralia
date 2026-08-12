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
  const r = await fetch(base() + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
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

// Profile upsert, matched on email. Carries the fields no form column exists
// for, plus tags used for segmentation (donor, volunteer, recurring).
async function upsertProfile(p) {
  const body = {
    email: p.email,
    first_name: p.first_name,
    last_name: p.last_name,
    phone: p.mobile || undefined,
    postcode: p.postcode || undefined
  };
  if (p.tags && p.tags.length) body.tags = p.tags;
  if (p.note) body.notes = p.note;
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
  const res = await call("POST", "/profiles/match-or-create", body);
  return (res && res.data && res.data.id) || null;
}

module.exports = { FORMS, configured, submitEntry, entryCount, upsertProfile };
