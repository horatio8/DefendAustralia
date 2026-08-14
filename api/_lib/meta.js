// Meta Conversions API.
//
// Every conversion is reported twice: once by the browser pixel and once from
// the server. That is deliberate and it is not double counting, because both
// carry the same event_id and Meta collapses them. The pair exists because
// either half can be missing. An ad blocker or ITP kills the browser event; a
// visitor who closes the tab mid-redirect kills nothing server side, since the
// webhook fires regardless. Sending both is how a campaign keeps attribution
// when roughly a third of browser events never arrive.
//
// Everything that identifies a person is SHA-256 hashed before it leaves this
// process. Meta's matching works on the hashes, so there is no reason to send
// anything in the clear, and the normalisation below (trim, lowercase, strip
// punctuation from phone numbers) has to happen before hashing or the hashes
// will not match Meta's.
//
// fbclid and fbp are first-touch values threaded through from the contact
// record. They are what connects a signature back to the ad that produced it,
// and they are worth more than any other field here.
//
// Env: META_PIXEL_ID, META_CAPI_TOKEN, optionally META_TEST_EVENT_CODE.

const crypto = require("crypto");
const { withRetry } = require("./retry");

const API_VERSION = "v21.0";

function configured() {
  return !!(process.env.META_PIXEL_ID && process.env.META_CAPI_TOKEN);
}

const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

// Meta's normalisation rules. Getting these wrong does not error, it just
// silently fails to match, which is worse.
function hashed(v, kind) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (!s) return null;
  if (kind === "phone") {
    const digits = s.replace(/[^\d]/g, "");
    return digits ? sha(digits) : null;
  }
  if (kind === "postcode") {
    const p = s.replace(/\s/g, "");
    return p ? sha(p) : null;
  }
  return sha(s);
}

function userData(p) {
  const u = {};
  const put = (key, val) => { if (val) u[key] = [val]; };
  put("em", hashed(p.email));
  // Not a person: our own identifier for one, or a constant for an event that
  // has no person behind it at all. Meta counts it as a matching parameter,
  // which matters because an event carrying none of them is rejected outright.
  put("external_id", hashed(p.external_id));
  put("ph", hashed(p.mobile || p.phone, "phone"));
  put("fn", hashed(p.first_name));
  put("ln", hashed(p.last_name));
  put("zp", hashed(p.postcode, "postcode"));
  if (p.country !== null) put("country", hashed(p.country || "au"));
  // Not hashed: these are Meta's own identifiers, not personal data.
  if (p.fbc) u.fbc = p.fbc;
  if (p.fbp) u.fbp = p.fbp;
  if (p.ip) u.client_ip_address = p.ip;
  if (p.ua) u.client_user_agent = p.ua;
  return u;
}

// fbclid is a click id; fbc is the cookie-shaped value Meta wants. When the
// browser has not written the _fbc cookie yet, this reconstructs it, which is
// the difference between an attributed conversion and an unattributed one.
function fbcFrom(fbclid, ts) {
  if (!fbclid) return "";
  return "fb.1." + (ts || Date.now()) + "." + fbclid;
}

/* Send one or more events. Never throws: an ads pixel is not allowed to cost
 * a signature or a donation, so callers fire and forget. */
async function send(events, opts) {
  if (!configured()) return { sent: false, reason: "not configured" };
  const o = opts || {};
  const list = (Array.isArray(events) ? events : [events]).map((e) => ({
    event_name: e.event_name,
    event_time: Math.floor((e.event_time || Date.now()) / 1000),
    event_id: e.event_id,                       // the dedup key with the browser
    event_source_url: e.source_url || undefined,
    action_source: e.action_source || "website",
    user_data: userData(e.user || {}),
    custom_data: e.custom || undefined
  }));

  const url = "https://graph.facebook.com/" + API_VERSION + "/" +
    encodeURIComponent(process.env.META_PIXEL_ID) + "/events";

  const payload = { data: list, access_token: process.env.META_CAPI_TOKEN };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;

  try {
    const r = await withRetry(() => fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }), { label: "meta capi", attempts: o.attempts || 2 });

    const text = await r.text();
    if (!r.ok) {
      console.error("META_CAPI_FAIL", r.status, text.slice(0, 300));
      // Meta says exactly what is wrong, and a bare status code does not. The
      // difference between a revoked token and a malformed event is the whole
      // diagnosis, and without this it was only ever in a log nobody reads.
      return { sent: false, status: r.status, reason: metaError(text) };
    }
    return { sent: true, events: list.length };
  } catch (err) {
    console.error("META_CAPI_ERROR", err.message);
    return { sent: false, reason: String(err.message || err) };
  }
}

/* Meta's message, with the token scrubbed. The body does not normally echo the
 * access token, but this string is rendered on /api/env-check, and that page
 * has already been screenshotted and shared once. A surface that displays an
 * upstream error should never be the thing that discloses the credential. */
function metaError(text) {
  let msg = String(text || "").slice(0, 400);
  try {
    const j = JSON.parse(text);
    if (j && j.error) msg = [j.error.message, j.error.error_user_msg].filter(Boolean).join(" — ") || msg;
  } catch (e) {}
  const token = process.env.META_CAPI_TOKEN;
  if (token && token.length > 8) msg = msg.split(token).join("[token]");
  return msg.slice(0, 300);
}

// A stable id per logical conversion, so the browser and the server produce
// the same one without having to talk to each other. The Stripe event id or
// the signature's email plus day is enough: the same person signing twice on
// the same day is one conversion as far as Meta is concerned.
function eventId(kind, key) {
  return kind + "." + crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 20);
}

module.exports = { configured, send, userData, hashed, fbcFrom, eventId, API_VERSION };
