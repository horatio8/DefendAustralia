// POST /api/share-issued — a supporter opened a share sheet.
//
// Logged as an event only. This is the top of the referral funnel: the
// signature that arrives later carries ref_used, and the two join on the code.
const at = require("./_lib/airtable");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  const b = req.body && typeof req.body === "object" ? req.body : safeParse(req.body);
  res.status(200).json({ ok: true });
  if (!b || !at.configured()) return;
  try {
    const code = String(b.code || "").toUpperCase().slice(0, 12);
    const owner = code ? await at.findOne(at.T.contacts, "{referral_code}='" + at.esc(code) + "'") : null;
    await at.logEvent({
      contactRecId: owner ? owner.id : undefined,
      event_type: "Share Issued", source_channel: "Share page",
      referral_code_used: code,
      payload: { platform: String(b.platform || "").slice(0, 40), code }
    });
  } catch (err) { console.error("SHARE_ISSUED_FAIL", err.message); }
};

function safeParse(v) { try { return JSON.parse(v); } catch (e) { return null; } }
