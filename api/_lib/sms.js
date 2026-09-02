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

/* The sending switch.
 *
 * SMS_SENDING=off pauses without a deploy, which is the switch to reach for
 * in a hurry. It is a switch here rather than unsetting CELLCAST_API_KEY,
 * because the key is also what the inbound poll and the opt-out reads use:
 * pulling it would stop the campaign hearing a STOP, which is the one thing
 * that must keep working while nothing is going out.
 *
 * The code default is on. It was the pause for a night while the sender id
 * and the provider's opt-out behaviour were sorted out; both are now
 * confirmed live, and a default that silently re-pauses on any deploy that
 * happens to lack the variable is a way to lose a week of welcome texts
 * without a single error. */
const PAUSED_IN_CODE = false;

function paused() {
  const v = String(process.env.SMS_SENDING || "").trim().toLowerCase();
  if (v === "on" || v === "1" || v === "true") return false;
  if (v === "off" || v === "0" || v === "false") return true;
  return PAUSED_IN_CODE;
}

function configured() {
  return !!process.env.CELLCAST_API_KEY;
}

/* The host, the path and the auth header all come from Cellcast's current
 * documentation, which is not what this file was originally written against.
 *
 * It used https://api.cellcast.com.au/v1 with an APPKEY header and a "from"
 * field. The documented API is https://api.cellcast.com/api/v1 with
 * "Authorization: Bearer" and a "sender" field: different host, different
 * path, different header, different field name. Four things wrong in one
 * call, and every one of them fails the same silent way, because nothing had
 * ever exercised this path — CELLCAST_API_KEY was unset until today, so the
 * queue held messages and never tried to send one.
 *
 * Overridable, because a legacy key that still answers on the old host can be
 * pointed back at it without a deploy. */
function base() {
  return (process.env.CELLCAST_API_BASE || "https://api.cellcast.com/api/v1").replace(/\/+$/, "");
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
  // Nothing is written while paused, deliberately. Queueing through a pause
  // builds a pile of "thanks for signing" texts addressed to people who
  // signed days ago, and every one of them goes out the moment sending
  // resumes. A welcome text nobody receives is a missed ask; a welcome text
  // that arrives three days late is a campaign that looks broken.
  if (paused()) return { queued: false, reason: "sending paused" };
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
  // Last gate before the provider. The drain checks too, but this is the
  // function that actually spends money and reaches a stranger's phone, so it
  // refuses on its own account rather than trusting its caller.
  if (paused()) throw new Error("sms sending is paused");
  if (!configured()) throw new Error("CELLCAST_API_KEY not set");
  const body = {
    message,
    contacts: [phone],
    sender: process.env.CELLCAST_SENDER_ID || undefined,
    /* Cellcast does NOT append an opt-out unless asked. It is a per-request
     * flag and it defaults to false, so every message sent without it goes
     * out with no unsubscribe of any kind.
     *
     * That matters here more than usual: the body was deliberately shortened
     * on the understanding that the provider was adding one. It was not.
     * Set explicitly rather than left to an account default, because an
     * account default is a setting somebody can change without touching this
     * repository, and the Spam Act obligation does not move with it. */
    replyStopToOptOut: true
  };
  /* Sent once. Never retried at this layer, whatever comes back.
   *
   * Cellcast delivers the message and then answers 500 when its own storage
   * fails. This is observed, not theorised: a live trial on 31 Aug returned
   * "MISCONF Redis is configured to save RDB snapshots, but it is currently
   * not able to persist on disk" twice, HTTP 500 both times, and both texts
   * arrived on the handset. A 500 from this endpoint means "probably sent and
   * we could not write it down", not "not sent".
   *
   * withRetry treats 500 as retryable, which is right for Airtable and
   * Nucleus and dangerous here: four attempts inside one call is four texts to
   * one person. So this is the one caller in the codebase that opts out.
   * Under-delivering costs a donation; over-delivering costs a supporter. */
  const r = await withRetry(() => fetch(base() + "/gateway", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + process.env.CELLCAST_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(body)
  }), { label: "cellcast send", attempts: 1 });

  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON error body */ }
  if (!r.ok) {
    const err = new Error("cellcast " + r.status + ": " + (text || "").slice(0, 200));
    err.status = r.status;
    throw err;
  }
  // A 200 does not mean accepted. Cellcast answers 200 with status:false and
  // the reason in message, so a body that says it failed is a failure however
  // healthy the status line looks.
  if (json && json.status === false) {
    const err = new Error("cellcast refused: " + String(json.message || "unknown").slice(0, 200));
    err.status = 400;   // refused for a stated reason, so not worth retrying
    throw err;
  }
  const queued = json && json.data && json.data.queueResponse;
  return (Array.isArray(queued) && queued[0] && queued[0].MessageId) ||
    (json && json.data && json.data.message_id) || "";
}

/* Pull inbound messages. Used by the hourly poll, which exists because a
 * webhook that is down for an hour must not mean an hour of ignored STOPs. */
async function inbound(sinceIso) {
  if (!configured()) return [];
  const qs = sinceIso ? "?start=" + encodeURIComponent(sinceIso.slice(0, 10)) : "";
  const r = await withRetry(() => fetch(base() + "/responses" + qs, {
    // Same bearer as the send. The APPKEY header this used to carry is not
    // in the current documentation at all, and an inbound poll that 401s is
    // how a STOP goes unread for an hour at a time.
    headers: {
      "Authorization": "Bearer " + process.env.CELLCAST_API_KEY,
      Accept: "application/json"
    }
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
  configured, queue, send, inbound, isStop, dedupeKey, optedOut, paused,
  withinSendingHours, nextSendableTime, sydneyParts, OPEN_HOUR, CLOSE_HOUR
};
