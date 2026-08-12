// POST /api/petition-signup — a signature.
//
// Campaign Nucleus is written first and always. It is the system of record,
// the site's counter reads from it, and it is the only place a signature has
// to be for the campaign to have it. Only once Nucleus has answered does the
// submission go to Airtable, and it goes as a single queued row rather than
// five relational writes, because Airtable allows five requests a second per
// base and a launch surge is far faster than that.
//
// The supporter is told they signed when at least one durable store accepted
// them. If neither did, the payload is logged in full for replay and the form
// says so rather than thanking them for nothing.
const nucleus = require("./_lib/nucleus");
const queue = require("./_lib/queue");
const at = require("./_lib/airtable");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  const b = req.body && typeof req.body === "object" ? req.body : safeParse(req.body);
  if (!b) return res.status(400).json({ error: "bad payload" });

  const first = str(b.first), last = str(b.last), email = at.normEmail(b.email);
  if (!first || !last || !email) return res.status(400).json({ error: "name and email required" });

  const utm = utmsFrom(str(b.source_url));
  const p = {
    first_name: first, last_name: last, email,
    mobile: str(b.mobile), postcode: str(b.postcode),
    campaign: str(b.campaign) || "defend-sacred-ground",
    consent: b.consent !== false,
    ref: str(b.ref), source_url: str(b.source_url),
    referral_code: makeRefCode(email),
    ...utm
  };

  // 1. Nucleus, first and foremost.
  let cnEntryId = null, cnError = "";
  try {
    cnEntryId = await nucleus.submitEntry("petition", {
      first_name: p.first_name, last_name: p.last_name, email: p.email,
      phone: p.mobile, postcode: p.postcode,
      utm_source: utm.utm_source, utm_medium: utm.utm_medium,
      utm_campaign: utm.utm_campaign, utm_term: utm.utm_term, utm_content: utm.utm_content
    });
  } catch (err) {
    // A duplicate email is a re-signature, not a failure.
    cnError = err.status === 422 ? "" : String(err.message || err);
    if (cnError) console.error("CN_PETITION_FAIL", cnError);
  }
  const cnOk = !!cnEntryId || (!cnError && nucleus.configured());

  // 2. Airtable, one queued row, expanded later by the drain worker.
  let queued = { queued: false };
  try { queued = await queue.enqueue("petition", p, { entryId: cnEntryId, error: cnError }); }
  catch (err) { console.error("QUEUE_PETITION_FAIL", err.message); }

  const stored = cnOk || queued.queued;
  if (!stored) console.error("PETITION_UNSTORED", JSON.stringify(p));

  return res.status(200).json({
    ok: true, stored,
    referral_code: p.referral_code,
    cn: !!cnEntryId,
    fallback: HOSTED_FORM
  });
};

const HOSTED_FORM = process.env.CN_HOSTED_PETITION_URL || "https://teller.nucleuspages.com/landing/dsg-beazley";

function str(v) { return v == null ? "" : String(v).trim(); }
function safeParse(v) { try { return JSON.parse(v); } catch (e) { return null; } }

function utmsFrom(sourceUrl) {
  const out = {};
  try {
    const q = new URL(sourceUrl).searchParams;
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach((k) => {
      const v = q.get(k);
      if (v) out[k] = v;
    });
  } catch (e) { /* no or unparseable URL */ }
  return out;
}

// Stable per-email share code, so the same supporter always gets the same one.
function makeRefCode(email) {
  let h = 5381;
  for (let i = 0; i < email.length; i++) h = ((h * 33) ^ email.charCodeAt(i)) >>> 0;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) { code += alphabet[h % alphabet.length]; h = Math.floor(h / alphabet.length) + 7919; }
  return code;
}
