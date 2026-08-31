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

/* Quiet hours. Nothing goes out before 8am or after 8pm, Sydney time.
 *
 * This is not politeness, it is the rule: unsolicited marketing calls and
 * texts outside those hours are prohibited, and a campaign that wakes people
 * at 2am has bought itself complaints rather than donations. A signature at
 * midnight is exactly when this matters, because the welcome text would
 * otherwise go out sixty seconds later.
 *
 * Sydney rather than the supporter's own state, deliberately. We have a
 * postcode at best and often not even that, and Sydney is the latest
 * mainland clock: holding to it means a supporter in Perth is texted no
 * earlier than 5am their time, never at 4am. Erring the other way would let
 * an 8am Sydney send land at 5am in Perth, which is the mistake that costs.
 *
 * The zone is named rather than an offset because Sydney observes daylight
 * saving. A hardcoded +10 sends an hour early for half the year, and the half
 * it gets wrong is the half containing the campaign.
 */
const TZ = "Australia/Sydney";
const OPEN_HOUR = 8;    // 08:00, first minute a text may go
const CLOSE_HOUR = 20;  // 20:00, first minute it may not

const tzFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit"
});

function sydneyParts(date) {
  const o = {};
  for (const p of tzFormat.formatToParts(date)) {
    if (p.type !== "literal") o[p.type] = Number(p.value);
  }
  // Some ICU builds render midnight as hour 24 rather than 0.
  if (o.hour === 24) o.hour = 0;
  return o;
}

/* The UTC instant at which Sydney's wall clock reads the given date and hour.
 *
 * Done by correction rather than by adding an offset, because the offset is
 * what we are trying to find. Treat the wall clock as if it were UTC, see how
 * far off that lands, and shift by the difference. Twice, because a single
 * pass is wrong inside the hour daylight saving moves. */
function fromSydney(y, mo, d, hour) {
  const target = Date.UTC(y, mo - 1, d, hour, 0, 0);
  let ts = target;
  for (let i = 0; i < 2; i++) {
    const p = sydneyParts(new Date(ts));
    ts += target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  return ts;
}

/* Is it a civil hour in Sydney right now? */
function withinSendingHours(when) {
  const h = sydneyParts(when || new Date()).hour;
  return h >= OPEN_HOUR && h < CLOSE_HOUR;
}

/* The next moment a message may go: now, if now is fine, otherwise 8am. */
function nextSendableTime(when) {
  const now = when || new Date();
  const p = sydneyParts(now);
  if (p.hour >= OPEN_HOUR && p.hour < CLOSE_HOUR) return now.getTime();
  if (p.hour < OPEN_HOUR) return fromSydney(p.year, p.month, p.day, OPEN_HOUR);
  // Past closing, so the morning after. Stepped in calendar space rather than
  // by adding 24 hours, which is an hour wrong on the two days a year that
  // daylight saving changes.
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day) + 86400000);
  return fromSydney(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), OPEN_HOUR);
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

    // Held to the next civil hour. A caller's own not_before is a floor, not
    // an override: the quiet window is later of the two, always.
    const asked = msg.not_before ? new Date(msg.not_before).getTime() : Date.now();
    const notBefore = new Date(Math.max(
      isNaN(asked) ? Date.now() : asked,
      nextSendableTime(new Date(isNaN(asked) ? Date.now() : asked))
    )).toISOString();

    await at.create(at.T.smsSends, {
      send_id: at.uuid(), phone, dedupe_key: key,
      contact_id: msg.contact_id || "",
      template: msg.template || "", test: msg.test || "", variant: msg.variant || "",
      message: msg.message || "", status: "Queued",
      not_before: notBefore,
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

module.exports = {
  configured, queue, send, inbound, isStop, dedupeKey, optedOut,
  withinSendingHours, nextSendableTime, sydneyParts, OPEN_HOUR, CLOSE_HOUR
};
