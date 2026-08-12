// POST /api/event-log — the contact-us and volunteer forms.
//
// Both land in their own Campaign Nucleus form. Two site fields have no column
// on the CN form (see the FIELD NOTES in _lib/nucleus.js), so they are carried
// through in ways CN can still act on:
//   contact.topic  -> prefixed onto the message body
//   volunteer roles/postcode -> profile note plus tags
// Airtable always gets the full submission regardless.
const nucleus = require("./_lib/nucleus");
const at = require("./_lib/airtable");

const HANDLERS = { volunteer_signup: volunteer, contact_message: contact };

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  const b = req.body && typeof req.body === "object" ? req.body : safeParse(req.body);
  if (!b || !HANDLERS[b.type]) return res.status(400).json({ error: "unknown event type" });

  const email = at.normEmail(b.email);
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    const out = await HANDLERS[b.type]({ ...b, email });
    return res.status(200).json({ ok: true, cn: out.cn });
  } catch (err) {
    console.error("EVENT_LOG_FAIL", b.type, err.message);
    // The supporter has done their part; never show them a failure for ours.
    return res.status(200).json({ ok: true, cn: false });
  }
};

async function contact(b) {
  const p = {
    first_name: str(b.first), last_name: str(b.last), email: b.email,
    mobile: str(b.mobile), topic: str(b.topic), message: str(b.message),
    source_url: str(b.source_url)
  };
  const body = p.topic ? "[" + p.topic + "] " + p.message : p.message;
  const r = await push("contact", {
    first_name: p.first_name, last_name: p.last_name, email: p.email,
    phone: p.mobile, message: body
  }, { ...p, tags: ["Defend Sacred Ground"] });
  await store("Contact us", "Contact Message", "Contact page", p, r);
  return r;
}

async function volunteer(b) {
  const roles = Array.isArray(b.roles) ? b.roles.filter(Boolean) : [];
  const p = {
    first_name: str(b.first), last_name: str(b.last), email: b.email,
    mobile: str(b.mobile), postcode: str(b.postcode),
    roles: roles.join(", "), source_url: str(b.source_url)
  };
  const note = [p.postcode ? "Postcode " + p.postcode : "", p.roles ? "Can help with: " + p.roles : ""]
    .filter(Boolean).join(". ");
  const r = await push("volunteer", {
    first_name: p.first_name, last_name: p.last_name, email: p.email, phone: p.mobile
  }, { ...p, note, tags: ["Defend Sacred Ground", "Volunteer"] });
  await store("Volunteer", "Volunteer Signup", "Volunteer page", p, r);
  return r;
}

// Form entry plus profile upsert. The profile carries what the form cannot.
async function push(formKey, entryFields, profile) {
  let cnEntryId = null, cnError = "";
  try { cnEntryId = await nucleus.submitEntry(formKey, entryFields); }
  catch (err) { cnError = err.status === 422 ? "" : String(err.message || err); }
  try { await nucleus.upsertProfile(profile); }
  catch (err) { if (!cnError) cnError = "profile: " + String(err.message || err); }
  if (cnError) console.error("CN_" + formKey.toUpperCase() + "_FAIL", cnError);
  return { cn: !!cnEntryId, cnEntryId, cnError };
}

async function store(form, eventType, channel, p, r) {
  if (!at.configured()) return;
  const contact = await at.upsertContact({
    first_name: p.first_name, last_name: p.last_name, email: p.email,
    mobile: p.mobile, postcode: p.postcode, consent: true,
    source_channel: form === "Volunteer" ? "Volunteer" : "Contact form",
    status: form === "Volunteer" ? "Volunteer" : "Lead"
  });
  const ev = await at.logEvent({
    contactRecId: contact.id, event_type: eventType, source_channel: channel,
    source_url: p.source_url, payload: p
  });
  try {
    await at.create(at.T.submissions, {
      submission_id: at.uuid(), contact: [contact.id], event: [ev.id], form,
      first_name: p.first_name, last_name: p.last_name, email: p.email,
      mobile: p.mobile, postcode: p.postcode || "", topic: p.topic || "",
      message: p.message || "", roles: p.roles || "",
      cn_synced: !!r.cnEntryId, cn_entry_id: r.cnEntryId || "", cn_error: r.cnError,
      source_url: p.source_url, timestamp: at.nowIso(), payload: JSON.stringify(p, null, 1)
    });
    await at.markFanout(ev.id, true);
  } catch (err) {
    await at.markFanout(ev.id, false, err.message);
    throw err;
  }
}

function str(v) { return v == null ? "" : String(v).trim(); }
function safeParse(v) { try { return JSON.parse(v); } catch (e) { return null; } }
