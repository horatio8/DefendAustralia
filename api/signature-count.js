// GET /api/signature-count — the live petition total.
//
// The number on the site is the Campaign Nucleus entry count for the petition
// form and nothing else, so the two can never drift. The form id and the
// request shape come from the shared client, so this endpoint cannot fall out
// of step with the handler that writes signatures.
const nucleus = require("./_lib/nucleus");

const CACHE_SECONDS = 60;
let cached = null; // { count, at }

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });
  if (!nucleus.configured()) return res.status(503).json({ error: "signature count not configured" });

  if (cached && Date.now() - cached.at < CACHE_SECONDS * 1000) {
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=60");
    return res.status(200).json({ count: cached.count, cached: true });
  }

  try {
    const count = await nucleus.entryCount("petition");
    cached = { count, at: Date.now() };
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=60");
    return res.status(200).json({ count });
  } catch (err) {
    console.error("SIGNATURE_COUNT_FAIL", err.message);
    // Serve a stale number rather than none: the count must never read as zero
    // because an upstream call blipped.
    if (cached) return res.status(200).json({ count: cached.count, stale: true });
    return res.status(502).json({ error: "signature count unavailable" });
  }
};
