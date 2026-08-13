// POST /api/rally-checkout — tickets for an event.
//
// Embedded Checkout rather than a redirect: an event page is a one-page pitch
// with a hero image and a time and a place, and sending someone to a Stripe
// domain in the middle of it loses people who were reading. The payment form
// mounts inline and the page never changes.
//
// A second Stripe account. Ticket money and donation money are different money
// with different reporting, and mixing them means every donation report has to
// be filtered for tickets forever. The keys fall back to the main account so a
// campaign that has not set up a second one still works.
//
// GET ?session_id= reads the order back for the confirmation panel. The client
// is never trusted to preserve what it was told: quantity and amount come from
// Stripe, not from whatever the browser still has in memory.
const h = require("./_lib/http");
const Stripe = require("stripe");

const MAX_QTY = 20;

function keys() {
  return {
    secret: process.env.RALLY_STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY,
    price: process.env.RALLY_TICKET_PRICE_ID || ""
  };
}

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;

  const { secret, price } = keys();
  if (!secret) return res.status(503).json({ error: "Ticketing is not switched on yet." });
  const stripe = new Stripe(secret);

  if (req.method === "GET") return summary(req, res, stripe);

  const b = h.body(req) || {};
  const eventSlug = h.clean(b.event, 60) || "rally";
  const qty = Math.max(1, Math.min(MAX_QTY, Number(b.qty) || 1));
  const email = h.clean(b.email, 160);
  const code = h.clean(b.ref, 12).toUpperCase();

  if (email && !h.validEmail(email)) {
    return res.status(400).json({ error: "That does not look like an email address." });
  }

  const site = process.env.SITE_URL || ("https://" + (process.env.SITE_DOMAIN || "defendsacredground.com"));

  try {
    const session = await stripe.checkout.sessions.create({
      ui_mode: "embedded",
      mode: "payment",
      line_items: price
        ? [{ price, quantity: qty }]
        : [{
            quantity: qty,
            price_data: {
              currency: "aud",
              unit_amount: Math.max(100, Number(process.env.RALLY_TICKET_CENTS || 2500)),
              product_data: { name: "Ticket: " + eventSlug }
            }
          }],
      customer_email: email || undefined,
      // Read back by the webhook. The event and the referrer have to survive
      // the round trip through Stripe, and metadata is the only thing that does.
      metadata: { campaign: "defend-sacred-ground", event: eventSlug, qty: String(qty), ref: code },
      client_reference_id: eventSlug,
      return_url: site + "/events/" + encodeURIComponent(eventSlug) + "?session_id={CHECKOUT_SESSION_ID}"
    });

    return res.status(200).json({ client_secret: session.client_secret, session_id: session.id });
  } catch (err) {
    console.error("RALLY_CHECKOUT_FAIL", err.message);
    return res.status(502).json({ error: "We could not open the ticket form. Try again in a moment." });
  }
};

async function summary(req, res, stripe) {
  const id = h.clean((req.query && req.query.session_id) || "", 90);
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ error: "bad session id" });
  try {
    const s = await stripe.checkout.sessions.retrieve(id);
    const d = s.customer_details || {};
    res.setHeader("Cache-Control", "private, no-store");
    // Deliberately thin: enough to render a confirmation, nothing more.
    return res.status(200).json({
      paid: s.payment_status === "paid",
      qty: Number((s.metadata && s.metadata.qty) || 1),
      amount: (s.amount_total || 0) / 100,
      currency: (s.currency || "aud").toUpperCase(),
      first_name: String(d.name || "").trim().split(/\s+/)[0] || "",
      event: (s.metadata && s.metadata.event) || ""
    });
  } catch (err) {
    return res.status(404).json({ error: "We could not find that order." });
  }
}
