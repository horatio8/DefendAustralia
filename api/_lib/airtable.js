// Airtable client and fan-out writer, modelled on the Farmers Fightback base.
//
// The shape is: every interaction appends one immutable row to Events, then a
// fan-out writes a typed projection row (Petition Signatures, Donations, Form
// Submissions) and upserts the person into Contacts. Events is the source of
// truth; the typed tables exist so a human can open the base and read it.
//
// Nothing here throws into the request path. A failed Airtable write must
// never cost a signature, so callers log and carry on.
//
// Env: AIRTABLE_TOKEN, AIRTABLE_BASE_ID.

const { withRetry } = require("./retry");

const T = {
  contacts: "Contacts",
  events: "Events",
  signatures: "Petition Signatures",
  donations: "Donations",
  submissions: "Form Submissions",
  signups: "Signups",
  lapse: "Lapse Queue",
  stats: "Site Stats",
  queue: "Ingest Queue",
  aiUsage: "AI Usage",
  brokenLinks: "Broken Links",
  smsSends: "SMS Sends",
  smsReplies: "SMS Replies",
  referralRollup: "Referral Rollup",
  abDaily: "AB Daily",
  webinars: "Webinars",
  registrations: "Registrations",
  questions: "Questions",
  surveyContacts: "Survey Contacts",
  surveyResponses: "Survey Responses",
  rallyTickets: "Rally Tickets",
  // Added with the economics and listening work. Every one of these is
  // optional: the endpoint that reads it answers "not configured" when the
  // table is absent, rather than the site breaking because a base was not
  // migrated.
  adPerformance: "Ad Performance",
  syncState: "Sync State",
  socialMessages: "Social Messages",
  socialDaily: "Social Daily",
  receptionInvites: "Reception Invites"
};

function configured() {
  return !!(process.env.AIRTABLE_TOKEN && process.env.AIRTABLE_BASE_ID);
}

function url(table, qs) {
  return "https://api.airtable.com/v0/" + process.env.AIRTABLE_BASE_ID +
    "/" + encodeURIComponent(table) + (qs ? "?" + qs : "");
}

// Every call goes through withRetry: Airtable allows five requests per second
// per base and answers 429 with a Retry-After, which a burst will hit.
async function call(method, table, qs, body) {
  if (!configured()) throw new Error("Airtable not configured");
  const r = await withRetry(() => fetch(url(table, qs), {
    method,
    headers: { Authorization: "Bearer " + process.env.AIRTABLE_TOKEN, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  }), { label: method + " " + table });

  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON */ }
  if (!r.ok) {
    const err = new Error("airtable " + r.status + ": " + (text || "").slice(0, 300));
    err.status = r.status;
    throw err;
  }
  return json;
}

function esc(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function uuid() {
  // No crypto dependency: this only needs to be unique, not unguessable.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const nowIso = () => new Date().toISOString();

async function findOne(table, formula) {
  const res = await call("GET", table, "filterByFormula=" + encodeURIComponent(formula) + "&maxRecords=1");
  return (res && res.records && res.records[0]) || null;
}

async function create(table, fields) {
  const res = await call("POST", table, null, { fields, typecast: true });
  return res;
}

async function update(table, id, fields) {
  return call("PATCH", table, null, { records: [{ id, fields }], typecast: true });
}

const normEmail = (e) => String(e || "").trim().toLowerCase();

// Identity match on email first, then mobile. Postcode plus name is not used
// as a key here: a wrong merge is worse than a duplicate.
async function upsertContact(p) {
  const email = normEmail(p.email);
  let rec = null;
  if (email) rec = await findOne(T.contacts, "LOWER({email})='" + esc(email) + "'");
  if (!rec && p.mobile) rec = await findOne(T.contacts, "{mobile}='" + esc(p.mobile) + "'");

  if (rec) {
    const patch = { last_updated: nowIso() };
    // Only fill blanks. A later form must not overwrite what someone already gave us.
    const fill = (key, val) => { if (val && !rec.fields[key]) patch[key] = val; };
    fill("first_name", p.first_name);
    fill("last_name", p.last_name);
    fill("email", email);
    fill("mobile", p.mobile);
    fill("postcode", p.postcode);
    fill("fbclid", p.fbclid);
    fill("fbp", p.fbp);
    if (p.status && p.status !== rec.fields.status) patch.status = p.status;
    if (p.consent) patch.consent = true;
    await update(T.contacts, rec.id, patch);
    // The fields come back too: the Meta fires need this person's first-touch
    // fbclid and fbp, and re-reading the row to get them would double the cost.
    return { id: rec.id, contact_id: rec.fields.contact_id, created: false, fields: { ...rec.fields, ...patch } };
  }

  const contact_id = uuid();
  const res = await create(T.contacts, {
    contact_id,
    first_name: p.first_name || "",
    last_name: p.last_name || "",
    email: email || "",
    mobile: p.mobile || "",
    postcode: p.postcode || "",
    fbclid: p.fbclid || "",
    fbp: p.fbp || "",
    referral_code: p.referral_code || "",
    first_source_channel: p.source_channel || "Unknown",
    status: p.status || "Lead",
    consent: !!p.consent,
    date_first_seen: nowIso(),
    last_updated: nowIso()
  });
  return { id: res.id, contact_id, created: true, fields: (res && res.fields) || {} };
}

// Append to the log. dedup_key makes webhook re-delivery a no-op.
async function logEvent(e) {
  if (e.dedup_key) {
    const existing = await findOne(T.events, "{dedup_key}='" + esc(e.dedup_key) + "'");
    if (existing) return { id: existing.id, duplicate: true };
  }
  const event_id = uuid();
  const res = await create(T.events, {
    event_id,
    contact: e.contactRecId ? [e.contactRecId] : undefined,
    event_type: e.event_type,
    timestamp: e.timestamp || nowIso(),
    payload: JSON.stringify(e.payload || {}, null, 1),
    source_channel: e.source_channel || "Unknown",
    source_url: e.source_url || undefined,
    fbclid: e.fbclid || undefined,
    fbp: e.fbp || undefined,
    referral_code_used: e.referral_code_used || undefined,
    dedup_key: e.dedup_key || undefined,
    fanout_status: "No Typed Table"
  });
  return { id: res.id, event_id, duplicate: false };
}

async function markFanout(eventRecId, ok, error) {
  try {
    await update(T.events, eventRecId, {
      fanout_status: ok ? "Written" : "Failed",
      fanout_error: error ? String(error).slice(0, 250) : ""
    });
  } catch (e) { /* the log row already exists; the status flag is best effort */ }
}

/* Paging and batching.
 *
 * The single-record helpers above are what a form submission needs. Everything
 * that rolls up — spend against signups, donations against contacts — has to
 * walk a whole table, and Airtable hands that back 100 rows at a time behind
 * an opaque offset. Doing it by hand in each cron is how one of them ends up
 * silently reading only the first page and reporting a tenth of the truth.
 *
 * Every walk takes a deadline. A serverless function is killed at its
 * maxDuration with no chance to write, so a rollup that cannot finish must
 * stop early and say so rather than be cut off mid-write. `done` is the
 * caller's signal that the answer is complete; a watermark must never be
 * advanced on a walk that came back false. */
function qs(params) {
  const parts = [];
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (v === undefined || v === null || v === "") continue;
    if (k === "fields") {
      for (const f of v) parts.push("fields%5B%5D=" + encodeURIComponent(f));
    } else if (k === "sort") {
      v.forEach((sortSpec, i) => {
        parts.push("sort%5B" + i + "%5D%5Bfield%5D=" + encodeURIComponent(sortSpec.field));
        parts.push("sort%5B" + i + "%5D%5Bdirection%5D=" + encodeURIComponent(sortSpec.direction || "asc"));
      });
    } else {
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
    }
  }
  return parts.join("&");
}

async function page(table, opts) {
  const o = opts || {};
  const res = await call("GET", table, qs({
    pageSize: o.pageSize || 100,
    maxRecords: o.maxRecords,
    filterByFormula: o.filterByFormula,
    fields: o.fields,
    sort: o.sort,
    view: o.view,
    offset: o.offset
  }));
  return { records: (res && res.records) || [], offset: (res && res.offset) || null };
}

/* Walk every page, calling back per record. Returns { done, seen, pages }.
 * `done` is false when the deadline stopped the walk with pages still to
 * read — the caller then knows its totals are partial. */
async function walk(table, opts, onRecord) {
  const o = opts || {};
  const deadline = o.deadline || Infinity;
  let offset = null, seen = 0, pages = 0;
  do {
    if (Date.now() > deadline) return { done: false, seen, pages };
    const p = await page(table, { ...o, offset });
    for (const r of p.records) { onRecord(r); seen++; }
    pages++;
    offset = p.offset;
  } while (offset);
  return { done: true, seen, pages };
}

// Airtable takes ten records per write. Anything larger is chunked here so a
// caller cannot accidentally send eleven and lose the eleventh.
async function inChunks(items, size, fn) {
  let n = 0;
  for (let i = 0; i < items.length; i += size) {
    await fn(items.slice(i, i + size));
    n += Math.min(size, items.length - i);
  }
  return n;
}

async function createMany(table, rows) {
  return inChunks(rows, 10, (batch) =>
    call("POST", table, null, { records: batch.map((fields) => ({ fields })), typecast: true }));
}

async function updateMany(table, items) {
  return inChunks(items, 10, (batch) =>
    call("PATCH", table, null, { records: batch, typecast: true }));
}

/* Upsert on a natural key. Airtable matches on fieldsToMergeOn and creates
 * what it cannot match, which is what makes a poller safe to re-run: the same
 * hour of ad spend fetched twice updates one row instead of making two. */
async function upsertBy(table, rows, mergeOn) {
  return inChunks(rows, 10, (batch) =>
    call("PATCH", table, null, {
      records: batch.map((fields) => ({ fields })),
      typecast: true,
      performUpsert: { fieldsToMergeOn: mergeOn }
    }));
}

/* Does this base have the table at all? A deployment that predates a
 * migration should report "not configured" from the one endpoint that needs
 * it, not 500 on a cron every five minutes. */
async function hasTable(table) {
  try {
    await call("GET", table, "maxRecords=1");
    return true;
  } catch (err) {
    if (err.status === 404 || /NOT_FOUND|TABLE_NOT_FOUND/i.test(err.message || "")) return false;
    throw err;
  }
}

// Key-value read/write for the numbers the site serves.
async function getStat(key) {
  const rec = await findOne(T.stats, "{key}='" + esc(key) + "'");
  return rec ? { id: rec.id, num: rec.fields.num_value, text: rec.fields.text_value, updated_at: rec.fields.updated_at } : null;
}

async function setStat(key, num, text) {
  const rec = await findOne(T.stats, "{key}='" + esc(key) + "'");
  const fields = { key, num_value: num, text_value: text || "", updated_at: nowIso() };
  if (rec) return update(T.stats, rec.id, fields);
  return create(T.stats, fields);
}

module.exports = {
  T, configured, call, create, update, findOne, upsertContact, logEvent,
  markFanout, getStat, setStat, uuid, nowIso, esc, normEmail,
  page, walk, createMany, updateMany, upsertBy, hasTable
};
