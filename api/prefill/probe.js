// GET /api/prefill/probe?p=…&p2=… — which merge tag does the CRM actually fill in?
//
// Nucleus publishes neither its merge-tag list nor a way to render one, so
// the only way to learn the tag that carries a profile id is to send an email
// containing a guess and look at what arrives. This is that test, made into
// one click: put the probe link in a test send to yourself, click it, and it
// tells you which parameter came through as a real id.
//
// It deliberately says almost nothing about the person. It reports tag NAMES,
// whether each one resolved, and whether the resolved id matched a profile.
// The only personal thing it echoes is a masked first initial, which is
// enough to confirm it found the right human and not enough to be worth
// anything to anyone who finds the URL.

const h = require("../_lib/http");
const nucleus = require("../_lib/nucleus");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function classify(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "empty";
  // Nucleus leaves a tag verbatim when it has no variable of that name, so a
  // leading % is the signature of a guess that missed.
  if (s.charAt(0) === "%" || s.indexOf("%recipient") !== -1) return "unresolved";
  if (UUID.test(s)) return "uuid";
  return "resolved, but not an id";
}

const mask = (s) => {
  const v = String(s || "");
  return v ? v.slice(0, 1) + "*".repeat(Math.max(1, v.length - 1)) : "";
};

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET")) return;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");

  const rl = h.rateLimit("probe:" + h.hashIp(req), 20, 600000);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    return res.status(429).json({ ok: false });
  }

  const params = {};
  let winner = null;
  for (const k of Object.keys(req.query || {})) {
    const kind = classify(req.query[k]);
    params[k] = kind;
    if (kind === "uuid" && !winner) winner = { param: k, id: String(req.query[k]).trim() };
  }

  const out = {
    ok: true,
    verdict: winner
      ? 'The CRM fills the profile id into "' + winner.param + '". Prefill will work with that tag.'
      : "No parameter arrived as a profile id. Below, 'unresolved' means the CRM has no merge tag by that name.",
    params
  };

  if (winner && nucleus.configured()) {
    try {
      const p = await nucleus.profile(winner.id);
      out.profile_found = !!p;
      if (p) out.matched = { first: mask(p.first_name), has_email: !!p.email, has_mobile: !!(p.mobile || p.phone) };
    } catch (err) {
      out.profile_found = false;
    }
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).send(JSON.stringify(out, null, 2));
};

module.exports.classify = classify;
