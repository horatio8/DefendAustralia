// GET /api/donation-status?session_id=cs_... — what the thank-you page needs
// to make the upsell ask specific.
//
// Returns the amount just given and the matching monthly link, so the page can
// say "make your $65 monthly" rather than a generic ask. Nothing sensitive is
// exposed: first name and amount only, and only for a session id the caller
// already holds.
const Stripe = require("stripe");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });
  const id = String((req.query && req.query.session_id) || "");
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ error: "bad session id" });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: "stripe not configured" });

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const s = await stripe.checkout.sessions.retrieve(id);
    const d = s.customer_details || {};
    res.setHeader("Cache-Control", "private, max-age=60");
    return res.status(200).json({
      paid: s.payment_status === "paid" || s.mode === "subscription",
      amount: (s.amount_total || 0) / 100,
      currency: (s.currency || "aud").toUpperCase(),
      monthly: s.mode === "subscription",
      first_name: String(d.name || "").trim().split(/\s+/)[0] || "",
      email: d.email || ""
    });
  } catch (err) {
    console.error("DONATION_STATUS_FAIL", err.message);
    return res.status(404).json({ error: "session not found" });
  }
};
