// POST /api/share-issued — a supporter opened a share sheet.
//
// Top of the referral funnel. Queued like everything else; the drain worker
// resolves the code back to the supporter who owns it, so the signature that
// arrives later can be credited to them.
const queue = require("./_lib/queue");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  const b = req.body && typeof req.body === "object" ? req.body : safeParse(req.body);
  if (!b) return res.status(200).json({ ok: true });

  try {
    await queue.enqueue("share", {
      platform: String(b.platform || "").slice(0, 40),
      code: String(b.code || "").toUpperCase().slice(0, 12)
    }, null);
  } catch (err) { console.error("QUEUE_SHARE_FAIL", err.message); }

  return res.status(200).json({ ok: true });
};

function safeParse(v) { try { return JSON.parse(v); } catch (e) { return null; } }
