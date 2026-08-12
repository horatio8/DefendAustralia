// POST /api/capture — minister email-action page, and
// POST /api/partial     — half-filled petition forms (same handler, see below).
//
// Both exist so that a person who types their email and then leaves is still a
// lead. Captures are upserted on session_id and guarded by a monotonic `seq`,
// because beacons sent with keepalive can arrive out of order.
const at = require("./_lib/airtable");
const nucleus = require("./_lib/nucleus");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  const b = req.body && typeof req.body === "object" ? req.body : safeParse(req.body);
  if (!b) return res.status(400).json({ error: "bad payload" });
  // Fire and forget from the browser's point of view: never block a beacon.
  res.status(200).json({ ok: true });
  try { await record(b); } catch (err) { console.error("CAPTURE_FAIL", err.message); }
};

async function record(b) {
  if (!at.configured()) return;
  const sid = str(b.session_id);
  if (!sid) return;
  const email = at.normEmail(b.email);
  const status = str(b.status) || (email ? "partial" : "started");
  const seq = Number(b.seq) || 0;

  const existing = await at.findOne(at.T.signups, "{session_id}='" + at.esc(sid) + "'");
  if (existing && Number(existing.fields.seq || 0) > seq) return; // stale beacon

  const fields = {
    session_id: sid,
    first_name: str(b.first), last_name: str(b.last),
    email: email || "", mobile: str(b.mobile),
    status, seq,
    send_clicked: status === "send_clicked",
    updated_at: at.nowIso()
  };
  if (b.sent_subject) fields.sent_subject = String(b.sent_subject).slice(0, 250);
  if (b.sent_body) fields.sent_body = String(b.sent_body);
  if (b.variation_shown != null) fields.variation_shown = Number(b.variation_shown);
  if (b.ai_rewrite_count != null) fields.ai_rewrite_count = Number(b.ai_rewrite_count);

  if (existing) await at.update(at.T.signups, existing.id, fields);
  else await at.create(at.T.signups, { ...fields, created_at: at.nowIso() });

  // Only a completed send is a real person worth pushing to the CRM and
  // logging as an event. Everything earlier stays a capture.
  if (status !== "send_clicked" || !email) return;

  const contact = await at.upsertContact({
    first_name: fields.first_name, last_name: fields.last_name, email,
    mobile: fields.mobile, consent: true,
    source_channel: "Minister email", status: "Lead"
  });
  await at.logEvent({
    contactRecId: contact.id, event_type: "Minister Email Sent",
    source_channel: "Minister page", payload: { session_id: sid, subject: b.sent_subject }
  });
  try {
    await nucleus.upsertProfile({
      email, first_name: fields.first_name, last_name: fields.last_name,
      mobile: fields.mobile, tags: ["Defend Sacred Ground", "Contacted the Minister"]
    });
    await at.update(at.T.signups, (existing && existing.id) ||
      (await at.findOne(at.T.signups, "{session_id}='" + at.esc(sid) + "'")).id, { cn_synced: true });
  } catch (err) { console.error("CN_MINISTER_FAIL", err.message); }
}

function str(v) { return v == null ? "" : String(v).trim(); }
function safeParse(v) { try { return JSON.parse(v); } catch (e) { return null; } }
