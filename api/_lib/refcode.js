// The referral code, derived from the email.
//
// Deriving rather than generating is what lets the browser know a supporter's
// code the instant they type their email, with no round trip, which is why the
// petition form can redirect to the donation screen in 40ms and still put a
// working share link on the page after it.
//
// There are three implementations of this function and they must agree
// exactly: this one, the twin in js/app.jsx, and nothing else. If this changes,
// every code already in circulation changes with it, so it does not change.
//
// The alphabet drops 0, 1, I and O, which is what breaks every ambiguous pair:
// 0/O and 1/I are gone, and L is unambiguous once the digit 1 is absent and
// codes are uppercase. A code gets read down a phone and typed back in, and
// those are the characters that go wrong when it is.
//
// This is 32 characters and must stay 32: the digest is consumed by repeated
// division by the alphabet length, so changing the size changes every code.

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function refCodeFor(email) {
  const e = String(email || "").trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < e.length; i++) h = ((h * 33) ^ e.charCodeAt(i)) >>> 0;
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += ALPHABET[h % ALPHABET.length];
    h = Math.floor(h / ALPHABET.length) + 7919;
  }
  return code;
}

// Storage is uppercase and matching ignores case. Lowercased codes arriving
// from email clients minted duplicate contacts in the reference build.
const normCode = (c) => String(c || "").trim().toUpperCase().slice(0, 12);

module.exports = { refCodeFor, normCode, ALPHABET };
