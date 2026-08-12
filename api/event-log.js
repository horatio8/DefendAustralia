// POST /api/event-log — the contact-us and volunteer forms.
//
// Same order as every other submission: Campaign Nucleus first, then one
// queued row for Airtable. Two site fields have no column on their CN form
// (see the FIELD NOTES in _lib/nucleus.js), so they are carried in ways CN can
// still act on: the contact topic is prefixed onto the message body, and the
// volunteer roles and postcode ride on the profile. Airtable always receives
// the full submission regardless.
const nucleus = require("./_lib/nucleus");
const queue = require("./_lib/queue");
const at = require("./_lib/airtable");

const SHAPERS = { volunteer_signup: volunteer, contact_message: contact };

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  const b = req.body && typeof req.body === "object" ? req.body : safeParse(req.body);
  if (!b || !SHAPERS[b.type]) return res.status(400).json({ error: "unknown event type" });

  const email = at.normEmail(b.email);
  if (!email) return res.status(400).json({ error: "email required" });

  const shaped = SHAPERS[b.type]({ ...b, email });

  // 1. Nucleus: the form entry, then the profile that carries the rest.
  let cnEntryId = null, cnError = "";
  try { cnEntryId = await nucleus.submitEntry(shaped.formKey, shaped.entry); }
  catch (err) { cnError = err.status === 422 ? "" : String(err.message || err); }
  try { await nucleus.upsertProfile(shaped.profile); }
  catch (err) { if (!cnError) cnError = "profile: " + String(err.message || err); }
  if (cnError) console.error("CN_" + shaped.formKey.toUpperCase() + "_FAIL", cnError);

  // 2. Airtable, queued.
  let queued = { queued: false };
  try { queued = await queue.enqueue(shaped.formKey, shaped.record, { entryId: cnEntryId, error: cnError }); }
  catch (err) { console.error("QUEUE_" + shaped.formKey.toUpperCase() + "_FAIL", err.message); }

  if (!cnEntryId && !queued.queued) console.error("SUBMISSION_UNSTORED", JSON.stringify(shaped.record));
  return res.status(200).json({ ok: true, cn: !!cnEntryId });
};

function contact(b) {
  const p = {
    first_name: str(b.first), last_name: str(b.last), email: b.email,
    mobile: str(b.mobile), topic: str(b.topic), message: str(b.message),
    source_url: str(b.source_url)
  };
  return {
    formKey: "contact",
    entry: {
      first_name: p.first_name, last_name: p.last_name, email: p.email,
      phone: p.mobile, message: p.topic ? "[" + p.topic + "] " + p.message : p.message
    },
    profile: { ...p, tags: ["Defend Sacred Ground"] },
    record: p
  };
}

function volunteer(b) {
  const roles = Array.isArray(b.roles) ? b.roles.filter(Boolean) : [];
  const p = {
    first_name: str(b.first), last_name: str(b.last), email: b.email,
    mobile: str(b.mobile), postcode: str(b.postcode),
    roles: roles.join(", "), source_url: str(b.source_url)
  };
  const note = [p.postcode ? "Postcode " + p.postcode : "", p.roles ? "Can help with: " + p.roles : ""]
    .filter(Boolean).join(". ");
  return {
    formKey: "volunteer",
    entry: { first_name: p.first_name, last_name: p.last_name, email: p.email, phone: p.mobile },
    profile: { ...p, note, tags: ["Defend Sacred Ground", "Volunteer"] },
    record: p
  };
}

function str(v) { return v == null ? "" : String(v).trim(); }
function safeParse(v) { try { return JSON.parse(v); } catch (e) { return null; } }
