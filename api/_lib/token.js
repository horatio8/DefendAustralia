// HMAC magic-link tokens.
//
// A donor briefing is a private event. The link in the email is the only
// credential, so the token has to carry who it is for, which event, and when
// it stops working, and it has to be impossible to edit any of those three.
//
// Signed rather than stored: there is no token table to look up, so a link
// works the instant it is minted and revocation is by expiry. For an event
// that happens on a Tuesday and is invited on the Monday, that is the right
// trade.
//
// The invariant that matters is on the reading side, not here: a verified
// token may only ever be used to return its own contact's details. A handler
// that took a contact id from a query parameter after verifying a token would
// let anyone with one valid link read every registration.

const crypto = require("crypto");

function secret() {
  const s = process.env.WEBINAR_TOKEN_SECRET;
  if (!s) throw new Error("WEBINAR_TOKEN_SECRET not set");
  return s;
}

const b64 = (buf) => Buffer.from(buf).toString("base64url");
const unb64 = (s) => Buffer.from(String(s), "base64url");

/* Mint. payload is {contact_id, email, slug}; days is how long it lives. */
function mint(payload, days) {
  const body = {
    c: payload.contact_id || "",
    e: payload.email || "",
    s: payload.slug || "",
    x: Date.now() + Math.max(1, days || 14) * 86400000
  };
  const data = b64(JSON.stringify(body));
  return data + "." + sign(data);
}

function sign(data) {
  return b64(crypto.createHmac("sha256", secret()).update(data).digest());
}

/* Verify. Returns null for anything wrong: bad shape, bad signature, expired.
 * The caller must not distinguish between them to the visitor, because the
 * difference tells an attacker which half of the token to keep working on. */
function verify(token) {
  const t = String(token || "");
  const dot = t.lastIndexOf(".");
  if (dot < 1) return null;
  const data = t.slice(0, dot);
  const given = t.slice(dot + 1);

  let expected;
  try { expected = sign(data); } catch (e) { return null; }

  // Constant time, and length-checked first because timingSafeEqual throws on
  // a length mismatch rather than returning false.
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let body;
  try { body = JSON.parse(unb64(data).toString("utf8")); } catch (e) { return null; }
  if (!body || typeof body.x !== "number" || Date.now() > body.x) return null;

  return { contact_id: body.c || "", email: body.e || "", slug: body.s || "", expires: body.x };
}

const configured = () => !!process.env.WEBINAR_TOKEN_SECRET;

module.exports = { mint, verify, configured };
