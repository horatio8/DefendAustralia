/* Private events: getting the right people into a room, and nobody else.
 *
 * The site already has token-gated briefings, signed statelessly with a
 * secret. This is the other kind of invitation — one per named person,
 * recorded, so the campaign can see who opened theirs and who has not. That
 * ledger is the whole reason for a stored token rather than a signed one: a
 * signed link is cheaper and tells you nothing about who read it.
 *
 * The token is never the contact's referral code. Referral codes travel in
 * public share links and get posted to Facebook, so honouring one here would
 * mean anybody who has seen a shared post can walk into an invitation-only
 * room. It is 24 characters of crypto randomness, issued once, and published
 * nowhere but that person's email.
 *
 * There is also a shared passcode, which is deliberately weaker and exists
 * for the people the campaign wants in the room but holds no email address
 * for: it gets read out on the phone or dropped in a group chat. Because it
 * is shared, it buys less — no prefill, every field typed by hand — and it is
 * off unless somebody sets one.
 */

const crypto = require("crypto");
const at = require("./airtable");

/* Ambiguous glyphs are out of the alphabet on purpose: 0 and O, 1 and l and
 * I. A token gets read off a printed card or dictated down a phone, and those
 * are the characters that go wrong when it is. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const TOKEN_LEN = 24;

function mintToken() {
  const bytes = crypto.randomBytes(TOKEN_LEN * 2);
  let out = "";
  // Values in the final partial block of the alphabet are rejected rather
  // than folded, so every character is equally likely. Modulo on its own
  // would quietly favour the first few letters.
  const ceiling = 256 - (256 % ALPHABET.length);
  for (let i = 0; out.length < TOKEN_LEN && i < bytes.length; i++) {
    if (bytes[i] >= ceiling) continue;
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

const validShape = (t) =>
  typeof t === "string" && t.length >= 16 && t.length <= 64 && /^[A-Za-z0-9_-]+$/.test(t);

// Constant time, so a timing difference cannot be used to grind out a token
// one character at a time.
function equals(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/* The shared passcode. Unset means there is no passcode route at all, rather
 * than a default one — a built-in password that a campaign does not know
 * about is a door they did not know was there.
 *
 * Matched case- and space-insensitively, because it is retyped on a phone
 * keyboard from a text message, and being refused for an autocapitalised
 * first letter is a support call rather than security. */
const passcodeSet = () => !!String(process.env.RECEPTION_PASSCODE || "").trim();

function passcodeOk(input) {
  const want = String(process.env.RECEPTION_PASSCODE || "").trim().toLowerCase().replace(/\s+/g, "");
  const given = String(input || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!want || !given || given.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

/* Look an invitation up by its token.
 *
 * Fetched by formula and then re-compared in constant time. Airtable's own
 * match is exact, so the second compare changes no outcome — it keeps the
 * guarantee visible in this file rather than resting on a remote service's
 * comparison semantics. */
async function inviteByToken(token) {
  if (!validShape(token)) return null;
  const rec = await at.findOne(at.T.receptionInvites, "{invite_token}='" + at.esc(token) + "'");
  if (!rec || !equals(rec.fields.invite_token || "", token)) return null;
  if (pick(rec.fields.status) === "Revoked") return null;
  return rec;
}

/* The event itself, read from the same table the briefings use. One event
 * system, not two: a private reception and an online briefing differ by
 * whether there is a venue or a join link, and nothing else. */
async function event(slug) {
  const rec = await at.findOne(at.T.webinars,
    "AND({slug}='" + at.esc(slug) + "',{active}=1)");
  if (!rec) return null;
  const f = rec.fields;
  return {
    id: rec.id,
    slug: f.slug,
    title: f.title || "",
    lede: f.lede || "",
    starts_at: f.starts_at || null,
    timezone: f.timezone || "Australia/Sydney",
    duration_minutes: f.duration_minutes || null,
    venue: f.venue || "",
    host: f.host || "",
    // The join link is deliberately withheld here. It is handed over by the
    // briefing endpoint after a token check; an in-person invitation has no
    // business carrying it.
    online: !!f.join_url
  };
}

const pick = (v) => (v && v.name) || (typeof v === "string" ? v : "") || "";

module.exports = {
  mintToken, validShape, equals, passcodeOk, passcodeSet,
  inviteByToken, event, ALPHABET, TOKEN_LEN, pick
};
