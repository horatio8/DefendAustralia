// POST /api/petition-signup — a signature.
//
// Order matters. Campaign Nucleus is written first and its result is recorded,
// because the count on the site is the CN entry total: if CN rejects the
// signature the site must not act as though it holds one. Airtable is written
// either way, with cn_synced false and the error on the row, so a broken sync
// is visible in the base instead of silently losing people.
//
// The response is deliberately forgiving. A supporter who has already signed
// gets the same success state rather than an error.
const nucleus = require("./_lib/nucleus");
const at = require("./_lib/airtable");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  const b = req.body && typeof req.body === "object" ? req.body : safeParse(req.body);
  if (!b) return res.status(400).json({ error: "bad payload" });

  const first = str(b.first), last = str(b.last), email = at.normEmail(b.email);
  if (!first || !last || !email) return res.status(400).json({ error: "name and email required" });

  const p = {
    first_name: first,
    last_name: last,
    email,
    mobile: str(b.mobile),
    postcode: str(b.postcode),
    campaign: str(b.campaign) || "defend-sacred-ground",
    consent: b.consent !== false,
    ref: str(b.ref),
    source_url: str(b.source_url)
  };
  const utm = utmsFrom(p.source_url);

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

  const referral_code = makeRefCode(p.email);
  try { await writeAirtable(p, utm, cnEntryId, cnError, referral_code); }
  catch (err) { console.error("AIRTABLE_PETITION_FAIL", err.message); }

  // Signed is signed as far as the supporter is concerned.
  return res.status(200).json({ ok: true, referral_code, cn: !!cnEntryId });
};

async function writeAirtable(p, utm, cnEntryId, cnError, referral_code) {
  if (!at.configured()) return;
  const contact = await at.upsertContact({
    first_name: p.first_name, last_name: p.last_name, email: p.email,
    mobile: p.mobile, postcode: p.postcode, consent: p.consent,
    referral_code, source_channel: "Petition", status: "Signed"
  });
  const ev = await at.logEvent({
    contactRecId: contact.id, event_type: "Petition Signed",
    source_channel: p.source_url && p.source_url.indexOf("/take-action/") > -1 ? "Petition page" : "Home page",
    source_url: p.source_url, referral_code_used: p.ref, payload: p
  });
  try {
    await at.create(at.T.signatures, {
      signature_id: at.uuid(),
      contact: [contact.id], event: [ev.id],
      first_name: p.first_name, last_name: p.last_name, email: p.email,
      mobile: p.mobile, postcode: p.postcode, campaign: p.campaign,
      consent: !!p.consent,
      cn_synced: !!cnEntryId, cn_entry_id: cnEntryId || "", cn_error: cnError,
      ref_used: p.ref, source_url: p.source_url,
      utm_source: utm.utm_source, utm_medium: utm.utm_medium, utm_campaign: utm.utm_campaign,
      utm_term: utm.utm_term, utm_content: utm.utm_content,
      timestamp: at.nowIso(), payload: JSON.stringify(p, null, 1)
    });
    await at.markFanout(ev.id, true);
  } catch (err) {
    await at.markFanout(ev.id, false, err.message);
    throw err;
  }
}

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
