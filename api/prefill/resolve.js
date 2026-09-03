// GET /api/prefill/resolve?p=<Nucleus profile id> — fill the form in for them.
//
// An email goes out with a link carrying nothing but an opaque profile id.
// This exchanges it for the four fields the petition form needs, so a
// supporter who is already on the list does not retype their own name and
// mobile to sign something. Half the people who abandon a form abandon it at
// the second field.
//
// What this endpoint refuses is the important part.
//
// A Nucleus profile id is a UUID: 122 bits, not guessable, not enumerable,
// and it appears nowhere public. That is why it is the only accepted key.
//
//   * A referral code is NOT accepted. Those are printed in every share link
//     and posted to Facebook, so honouring one here would hand anybody who
//     has seen a shared post that supporter's email address and mobile
//     number.
//   * An email address is NOT accepted either. That would make this an
//     oracle returning a mobile number for any address somebody cares to
//     type.
//
// Every miss answers identically — no id, malformed id, unknown id, Nucleus
// down — so the endpoint cannot be used to test whether an id exists. The
// response is no-store and rate limited, and the API token never leaves the
// server.

const h = require("../_lib/http");
const nucleus = require("../_lib/nucleus");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Nucleus merge tags do not match its own profile field names — a live send
 * resolves %recipient.first%, not %recipient.first_name% — and no campaign
 * this account has sent contains an id tag, so the right name cannot be read
 * off history and the API does not publish the list. The link therefore
 * carries the id under every plausible name and the first that resolved to a
 * UUID wins. A wrong guess arrives as the literal "%recipient.x%" and is
 * ignored. /api/prefill/probe is how you find out which one worked. */
const PARAMS = ["p", "p2", "p3", "p4", "p5", "p6"];

function pickId(query) {
  for (const k of PARAMS) {
    const v = String((query && query[k]) || "").trim();
    if (UUID.test(v)) return { id: v, param: k };
  }
  return null;
}

// Nucleus returns Australian mobiles in whichever shape they were captured
// in: 61412…, +61412…, 0412…. The form wants the local form, because that is
// what somebody checking their own number expects to see.
function localMobile(v) {
  const d = String(v || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("61") && d.length >= 11) return "0" + d.slice(2);
  if (d.startsWith("0")) return d;
  if (d.length === 9) return "0" + d;
  return d;
}

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET")) return;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");

  const rl = h.rateLimit("prefill:" + h.hashIp(req), 30, 600000);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    return res.status(429).json({ ok: false });
  }

  // The uniform miss. Every failure below returns exactly this.
  const miss = { ok: true, found: false };

  const hit = pickId(req.query);
  if (!hit || !nucleus.configured()) return res.status(200).json(miss);

  try {
    const p = await nucleus.profile(hit.id);
    if (!p) return res.status(200).json(miss);
    return res.status(200).json({
      ok: true,
      found: true,
      // Which tag name won. This names a merge tag, not a person, so it is
      // safe to return and it is the only way to debug a send.
      via: hit.param,
      // Only the fields the form has boxes for. Whatever else the profile
      // holds stays on the server.
      prefill: {
        first: p.first_name || "",
        last: p.last_name || "",
        email: p.email || "",
        mobile: localMobile(p.mobile || p.phone || ""),
        postcode: p.zip || p.postcode || ""
      }
    });
  } catch (err) {
    console.error("PREFILL_RESOLVE_FAIL", err.message);
    return res.status(200).json(miss);
  }
};

module.exports.pickId = pickId;
module.exports.localMobile = localMobile;
