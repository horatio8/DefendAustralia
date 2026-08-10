// POST /api/checkout {amount, frequency} -> {url} (Stripe hosted Checkout)
// GET  /api/checkout?amount=65&frequency=monthly -> 303 to Stripe (SMS/email deeplinks)
// Spec §4.5/§9: hosted page only, no card data on-site.
const Stripe = require("stripe");

const SITE_URL = process.env.SITE_URL || "https://defendsacredground.au";
const MIN_AUD = 2;
const MAX_AUD = 20000;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", SITE_URL);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "method not allowed" });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: "checkout not configured" });
  }

  const src = req.method === "POST" ? (req.body || {}) : (req.query || {});
  const amount = Math.round(Number(src.amount));
  const frequency = src.frequency === "monthly" ? "monthly" : "once";
  if (!Number.isFinite(amount) || amount < MIN_AUD || amount > MAX_AUD) {
    return res.status(400).json({ error: "invalid amount" });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const lineItem = {
    quantity: 1,
    price_data: {
      currency: "aud",
      unit_amount: amount * 100,
      product_data: { name: frequency === "monthly" ? "Monthly donation — Defend Sacred Ground" : "Donation — Defend Sacred Ground" },
      ...(frequency === "monthly" ? { recurring: { interval: "month" } } : {})
    }
  };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: frequency === "monthly" ? "subscription" : "payment",
      line_items: [lineItem],
      success_url: SITE_URL + "/share?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: SITE_URL + "/donate",
      client_reference_id: "defend-sacred-ground",
      metadata: {
        campaign: "defend-sacred-ground",
        frequency,
        source_url: String(src.source_url || "").slice(0, 500)
      }
    });
    if (req.method === "GET") {
      res.statusCode = 303;
      res.setHeader("Location", session.url);
      return res.end();
    }
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("CHECKOUT_ERROR", err.message);
    return res.status(502).json({ error: "could not create checkout session" });
  }
};
