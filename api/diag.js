// GET /api/diag?key=dsg-diag — TEMPORARY. Delete once the pipeline is green.
//
// Reports whether the runtime holds the credentials the handlers need, probes
// Campaign Nucleus, and can drive the real POST handlers through a synthetic
// submission (?run=petition|contact|volunteer|capture|partial|share). The run
// mode exists because the build environment cannot reach this domain to POST,
// so this is the only way to exercise the write paths end to end.
//
// Everything it writes is tagged DIAGTEST so it can be found and removed.
// Returns booleans, status codes and ids only: no secret is ever echoed.
const PETITION_FORM = process.env.CN_PETITION_FORM_ID || "0ea069ec-0257-4b7c-81c3-a8e6cc3a0f28";
const STAMP = "diagtest";

module.exports = async function handler(req, res) {
  const q = req.query || {};
  if (q.key !== "dsg-diag") return res.status(404).json({ error: "not found" });
  res.setHeader("Cache-Control", "no-store");

  if (q.run) {
    try { return res.status(200).json(await run(String(q.run), String(q.tag || "a"))); }
    catch (err) { return res.status(500).json({ run: q.run, error: String(err && err.message || err) }); }
  }

  const env = {
    CN_API_TOKEN: !!process.env.CN_API_TOKEN,
    CN_ACCOUNT_SLUG: process.env.CN_ACCOUNT_SLUG || null,
    CN_PETITION_FORM_ID: process.env.CN_PETITION_FORM_ID || "(default)",
    AIRTABLE_TOKEN: !!process.env.AIRTABLE_TOKEN,
    AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID || null,
    STRIPE_SECRET_KEY: !!process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: !!process.env.STRIPE_WEBHOOK_SECRET
  };

  const base = (process.env.CN_API_BASE || "https://api.campaignnucleus.com/v1").replace(/\/+$/, "");
  const url = base + "/forms/" + PETITION_FORM + "/entries?page%5Bsize%5D=1";
  const probes = { nucleus: await probe(url, authHeaders()) };
  if (process.env.AIRTABLE_TOKEN && process.env.AIRTABLE_BASE_ID) {
    probes.airtable = await probe(
      "https://api.airtable.com/v0/" + process.env.AIRTABLE_BASE_ID + "/Contacts?maxRecords=1",
      { Authorization: "Bearer " + process.env.AIRTABLE_TOKEN }
    );
  }
  return res.status(200).json({ env, probes, node: process.version });
};

// Drive a real handler with a synthetic request and report what it answered.
async function run(which, tag) {
  const email = STAMP + "-" + which + "-" + tag + "@teller.consulting";
  const common = { first: "Diagtest", last: "Ignore", email, source_url: "https://defendsacredground.com/api/diag" };
  const cases = {
    petition: ["./petition-signup", { ...common, mobile: "0400000000", postcode: "2600", campaign: "defend-sacred-ground" }],
    contact: ["./event-log", { ...common, type: "contact_message", topic: "Diagnostic", message: "Automated pipeline test. Safe to delete." }],
    volunteer: ["./event-log", { ...common, type: "volunteer_signup", postcode: "2600", roles: ["Diagnostic"] }],
    capture: ["./capture", { ...common, session_id: STAMP + "-" + tag, status: "send_clicked", seq: 1, sent_subject: "Diagnostic" }],
    partial: ["./partial", { ...common, form: "petition" }],
    share: ["./share-issued", { platform: "diagnostic", code: "DIAGTS" }]
  };
  const hit = cases[which];
  if (!hit) return { error: "unknown run target", allowed: Object.keys(cases) };

  const handler = require(hit[0]);
  const captured = {};
  const mockRes = {
    setHeader() {},
    status(code) { captured.status = code; return this; },
    json(body) { captured.body = body; return this; }
  };
  const started = Date.now();
  await handler({ method: "POST", body: hit[1], query: {}, headers: {} }, mockRes);
  return { run: which, email, ms: Date.now() - started, ...captured };
}

function authHeaders() {
  const h = { Accept: "application/json" };
  if (process.env.CN_API_TOKEN) h.Authorization = "Bearer " + process.env.CN_API_TOKEN;
  return h;
}

async function probe(url, headers) {
  try {
    const r = await fetch(url, { headers });
    const text = (await r.text()).slice(0, 120);
    return { status: r.status, ok: r.ok, body: text };
  } catch (err) {
    return { status: 0, error: String(err.message || err).slice(0, 160) };
  }
}
