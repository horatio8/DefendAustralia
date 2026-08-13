// POST /api/cellcast-inbound — a supporter replied to a text.
//
// This endpoint answers 200 to everything. Providers retry non-2xx responses,
// and a retry storm against an endpoint that is already struggling turns one
// bad minute into an outage. Anything that goes wrong is logged and the
// provider is told the message was received, because it was.
//
// STOP handling is the part that must not fail. A reply of STOP sets the
// opt-out flag on the contact, cancels every message still queued for that
// number, tags the profile in the CRM and logs the event. Doing three of those
// four is a compliance problem, so the flag and the queue cancellation are
// done first and the slower CRM call last.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const sms = require("./_lib/sms");
const nucleus = require("./_lib/nucleus");

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "POST")) return;

  const secret = process.env.CELLCAST_WEBHOOK_SECRET;
  if (secret) {
    const given = h.clean((req.headers && req.headers["x-webhook-token"]) || (h.body(req) || {}).token, 200);
    if (given !== secret) return res.status(200).json({ ok: true, ignored: "bad token" });
  }

  const b = h.body(req) || {};
  const messages = Array.isArray(b.messages) ? b.messages : [b];

  for (const m of messages) {
    try { await record(m, "Webhook"); }
    catch (err) { console.error("SMS_INBOUND_FAIL", err.message); }
  }

  return res.status(200).json({ ok: true, received: messages.length });
};

async function record(m, source) {
  const phone = h.e164(m.from || m.sender || m.number || m.phone);
  const message = h.cleanMultiline(m.body || m.message || m.sms_text, 1600);
  if (!phone) return;

  const receivedAt = m.received_at || m.date_received || m.timestamp || at.nowIso();
  // Phone plus timestamp: the webhook and the hourly poll both deliver the
  // same message, and this is what stops it landing twice.
  const replyId = phone + "|" + String(receivedAt).slice(0, 19);
  const stop = sms.isStop(message);

  if (at.configured()) {
    const seen = await at.findOne(at.T.smsReplies, "{reply_id}='" + at.esc(replyId) + "'");
    if (seen) return;
    await at.create(at.T.smsReplies, {
      reply_id: replyId, phone, message, is_stop: stop,
      source, received_at: receivedAt, created_at: at.nowIso()
    });
  }

  if (!stop) return;
  await optOut(phone, message);
}

async function optOut(phone, message) {
  let contact = null;
  if (at.configured()) {
    try {
      contact = await at.findOne(at.T.contacts, "{mobile}='" + at.esc(phone) + "'");
      // The flag first. Everything else can be retried; a text sent after a
      // STOP cannot be taken back.
      if (contact) await at.update(at.T.contacts, contact.id, { sms_opt_out: true, last_updated: at.nowIso() });
    } catch (err) { console.error("SMS_OPTOUT_FLAG_FAIL", err.message); }

    // Then the queue, so nothing already scheduled goes out.
    try {
      const pending = await at.call("GET", at.T.smsSends,
        "filterByFormula=" + encodeURIComponent("AND({phone}='" + at.esc(phone) + "',{status}='Queued')") +
        "&maxRecords=50");
      for (const row of (pending && pending.records) || []) {
        await at.update(at.T.smsSends, row.id, { status: "Cancelled", error: "recipient replied STOP" }).catch(() => {});
      }
    } catch (err) { console.error("SMS_OPTOUT_CANCEL_FAIL", err.message); }

    try {
      await at.logEvent({
        contactRecId: contact ? contact.id : undefined,
        event_type: "SMS Opt Out", source_channel: "SMS",
        dedup_key: "smsoptout:" + phone,
        payload: { phone, message }
      });
    } catch (err) { console.error("SMS_OPTOUT_EVENT_FAIL", err.message); }
  }

  // Last, because it is the slowest and the least urgent of the four.
  const email = contact && contact.fields.email;
  if (email && nucleus.configured()) {
    try {
      await nucleus.upsertProfile({
        email, first_name: contact.fields.first_name, last_name: contact.fields.last_name,
        mobile: phone, tags: ["SMS opted out"]
      });
    } catch (err) { console.error("CN_OPTOUT_TAG_FAIL", err.message); }
  }
}

module.exports.record = record;
