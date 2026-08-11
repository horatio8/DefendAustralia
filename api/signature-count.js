// GET /api/signature-count — the live petition total.
//
// The number on the site is the Campaign Nucleus entry count for the petition
// form and nothing else, so the two can never drift. Nucleus returns the total
// in the pagination meta of the entries collection, which is why this asks for
// a single row rather than the whole list.
//
// Env: CN_API_TOKEN, CN_PETITION_FORM_ID, optionally CN_API_BASE and
// CN_ACCOUNT_SLUG. Without them the endpoint reports unconfigured and the
// frontend keeps its fallback.
const CACHE_SECONDS = 60;
let cached = null; // { count, at }

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });

  const token = process.env.CN_API_TOKEN;
  const formId = process.env.CN_PETITION_FORM_ID;
  if (!token || !formId) return res.status(503).json({ error: "signature count not configured" });

  if (cached && Date.now() - cached.at < CACHE_SECONDS * 1000) {
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=60");
    return res.status(200).json({ count: cached.count, cached: true });
  }

  const base = (process.env.CN_API_BASE || "https://api.campaignnucleus.com/v1").replace(/\/+$/, "");
  const url = base + "/forms/" + encodeURIComponent(formId) + "/entries?page[size]=1&page[number]=1";
  const headers = { Authorization: "Bearer " + token, Accept: "application/json" };
  if (process.env.CN_ACCOUNT_SLUG) headers["X-Account"] = process.env.CN_ACCOUNT_SLUG;

  try {
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error("nucleus " + r.status);
    const body = await r.json();
    const count = readTotal(body);
    if (typeof count !== "number") throw new Error("no total in response");
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

// Nucleus nests the total under meta.pagination; tolerate the flatter shapes too.
function readTotal(body) {
  const m = body && body.meta;
  const candidates = [
    m && m.pagination && m.pagination.total,
    m && m.total,
    body && body.total,
    body && Array.isArray(body.data) ? body.data.length : undefined
  ];
  return candidates.find((v) => typeof v === "number");
}
