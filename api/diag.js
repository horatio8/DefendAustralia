// GET /api/diag?key=dsg-diag — TEMPORARY. Delete once the pipeline is green.
//
// Reports whether the runtime has the credentials the form handlers need, and
// probes Campaign Nucleus both with and without auth so we know whether a
// token is actually required to record a signature. Returns booleans and HTTP
// status codes only: no secret is ever echoed.
const PETITION_FORM = process.env.CN_PETITION_FORM_ID || "0ea069ec-0257-4b7c-81c3-a8e6cc3a0f28";

module.exports = async function handler(req, res) {
  if ((req.query && req.query.key) !== "dsg-diag") return res.status(404).json({ error: "not found" });

  const env = {
    CN_API_TOKEN: !!process.env.CN_API_TOKEN,
    CN_ACCOUNT_SLUG: process.env.CN_ACCOUNT_SLUG || null,
    CN_API_BASE: process.env.CN_API_BASE || null,
    AIRTABLE_TOKEN: !!process.env.AIRTABLE_TOKEN,
    AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID || null,
    STRIPE_SECRET_KEY: !!process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: !!process.env.STRIPE_WEBHOOK_SECRET
  };

  const base = (process.env.CN_API_BASE || "https://api.campaignnucleus.com/v1").replace(/\/+$/, "");
  const url = base + "/forms/" + PETITION_FORM + "/entries?page%5Bsize%5D=1";
  const probes = {};

  probes.anonymous_get = await probe(url, { Accept: "application/json" });
  if (process.env.CN_API_TOKEN) {
    probes.authed_get = await probe(url, {
      Accept: "application/json",
      Authorization: "Bearer " + process.env.CN_API_TOKEN
    });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ env, probes, node: process.version });
};

async function probe(url, headers) {
  try {
    const r = await fetch(url, { headers });
    const text = (await r.text()).slice(0, 200);
    return { status: r.status, body: text };
  } catch (err) {
    return { status: 0, error: String(err.message || err).slice(0, 200) };
  }
}
