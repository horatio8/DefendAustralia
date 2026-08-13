// SMS: Cellcast client and the outbound queue.
//
// The rule that shapes this file: one automation text per person, ever.
//
// A campaign SMS costs money and goodwill, and the failure mode is not a
// dropped message, it is the same person receiving the same nudge four times
// because four triggers fired. So every queued send carries a dedupe key of
// the phone number and the template, and a row whose key already exists is
// never created. That check is the queue, not the sender: by the time a
// message reaches the provider it is too late to take it back.
//
// Opt-outs are absolute and are checked twice, once when queueing and again
// immediately before sending, because someone can reply STOP in the hours
// between those two moments and frequently does.
//
// Env: CELLCAST_API_KEY, optionally CELLCAST_API_BASE, CELLCAST_SENDER_ID.

const crypto = require("crypto");
const at = require("./airtable");
const { withRetry } = require("./retry");

function configured() {
  return !!process.env.CELLCAST_API_KEY;
}

function base() {
  return (process.env.CELLCAST_API_BASE || "https://api.cellcast.com.au/v1").replace(/\/+$/, "");
}

// One key per person per template. Hashed so the table does not carry a
// second plaintext copy of everyone's phone number.
function dedupeKey(phone, template) {
  return crypto.createHash("sha256")
    .update(String(phone || "").replace(/[^\d+]/g, "") + "|" + String(template || ""))
    .digest("hex").slice(0, 32);
}

/* Queue a message. Returns why it was not queued rather than throwing, because
 * every caller is a capture path that must not fail over an SMS. */
async function queue(msg) {
  if (!at.configured()) return { queued: false, reason: "airtable not configured" };
  const phone = String(msg.phone || "").trim();
  if (!phone) return { queued: false, reason: "no phone" };

  const key = dedupeKey(phone, msg.template);
  try {
    const existing = await at.findOne(at.T.smsSends, "{dedupe_key}='" + at.esc(key) + "'");
    if (existing) return { queued: false, reason: "already sent to this person" };

    // Opt-out check one of two. The second is in the drain, immediately
    // before the message goes.
    if (await optedOut(phone)) return { queued: false, reason: "opted out" };

    await at.create(at.T.smsSends, {
      send_id: at.uuid(), phone, dedupe_key: key,
      contact_id: msg.contact_id || "",
      template: msg.template || "", test: msg.test || "", variant: msg.variant || "",
      message: msg.message || "", status: "Queued",
      not_before: msg.not_before || at.nowIso(),
      attempts: 0, created_at: at.nowIso()
    });
    return { queued: true };
  } catch (err) {
    console.error("SMS_QUEUE_FAIL", err.message);
    return { queued: false, reason: String(err.message || err) };
  }
}

async function optedOut(phone) {
  try {
    const c = await at.findOne(at.T.contacts, "{mobile}='" + at.esc(phone) + "'");
    return !!(c && c.fields.sms_opt_out);
  } catch (err) {
    // Unknown means do not send. An unwanted text after a STOP is a
    // regulatory problem; a missed nudge is not.
    console.error("SMS_OPTOUT_CHECK_FAIL", err.message);
    return true;
  }
}

/* Hand one message to the provider. */
async function send(phone, message) {
  if (!configured()) throw new Error("CELLCAST_API_KEY not set");
  const body = {
    sms_text: message,
    numbers: [phone],
    from: process.env.CELLCAST_SENDER_ID || undefined
  };
  const r = await withRetry(() => fetch(base() + "/gateway", {
    method: "POST",
    headers: {
      "APPKEY": process.env.CELLCAST_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(body)
  }), { label: "cellcast send" });

  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON error body */ }
  if (!r.ok) {
    const err = new Error("cellcast " + r.status + ": " + (text || "").slice(0, 200));
    err.status = r.status;
    throw err;
  }
  return (json && json.data && (json.data.message_id || json.data.messages)) || (json && json.message_id) || "";
}

/* Pull inbound messages. Used by the hourly poll, which exists because a
 * webhook that is down for an hour must not mean an hour of ignored STOPs. */
async function inbound(sinceIso) {
  if (!configured()) return [];
  const qs = sinceIso ? "?start=" + encodeURIComponent(sinceIso.slice(0, 10)) : "";
  const r = await withRetry(() => fetch(base() + "/responses" + qs, {
    headers: { "APPKEY": process.env.CELLCAST_API_KEY, Accept: "application/json" }
  }), { label: "cellcast inbound" });
  if (!r.ok) throw new Error("cellcast inbound " + r.status);
  const json = await r.json().catch(() => null);
  const rows = (json && (json.data || json.responses)) || [];
  return rows.map(normaliseInbound).filter((x) => x.phone);
}

function normaliseInbound(r) {
  return {
    phone: String(r.from || r.sender || r.number || "").trim(),
    message: String(r.body || r.message || r.sms_text || "").trim(),
    received_at: r.received_at || r.date_received || r.timestamp || new Date().toISOString()
  };
}

// STOP, STOPALL, UNSUB, UNSUBSCRIBE, OPTOUT, QUIT, END, CANCEL. Case and
// punctuation ignored: people reply "Stop." and mean it.
const STOP = /^(stop|stopall|unsub|unsubscribe|optout|opt out|quit|end|cancel)\b/i;
const isStop = (body) => STOP.test(String(body || "").trim().replace(/^[^\w]+/, ""));

module.exports = { configured, queue, send, inbound, isStop, dedupeKey, optedOut };
