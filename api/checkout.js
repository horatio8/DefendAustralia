// POST /api/checkout {amount, frequency} -> {url} (Stripe hosted Checkout)
// GET  /api/checkout?amount=65&frequency=monthly -> 303 to Stripe (SMS/email deeplinks)
//
// Hosted page only, no card data on-site. This is the one donation route with
// a server between the donor and Stripe: every preset amount is a Payment Link
// that goes straight to Stripe, and only a custom monthly amount comes through
// here, because Payment Links cannot do pay-what-you-want on a recurring price.
//
// The return URL is the dangerous part of this file. It is where Stripe sends
// a donor after their card has been charged, so a wrong value takes money and
// then shows them a browser error. That is not hypothetical: this default used
// to be a domain with no DNS record, and a donor paid $35, saw "server not
// found", assumed it had failed and paid again.
//
// So the domain is derived once, the fallback is the live apex, and there is a
// hard check that the resulting URL is a real absolute https URL before any
// session is created. A misconfigured deployment refuses to take the money
// rather than taking it and stranding the donor.
const Stripe = require("stripe");
const h = require("./_lib/http");

const MIN_AUD = 2;
const MAX_AUD = 20000;

function siteUrl() {
  const explicit = String(process.env.SITE_URL || "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const domain = String(process.env.SITE_DOMAIN || "defendsacredground.com").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return "https://" + domain;
}

// Absolute, https, with a host that has a dot in it. Anything else would be
// handed to Stripe as a return URL and become a dead end after payment.
const usable = (u) => /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(u);

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: "Donations are not switched on yet. Try one of the amounts above." });
  }

  const site = siteUrl();
  if (!usable(site)) {
    // Refuse rather than send someone to a URL that will not resolve after
    // their card has been charged.
    console.error("CHECKOUT_BAD_SITE_URL", site);
    return res.status(503).json({ error: "Checkout is misconfigured, so we have not taken your card. Please use one of the amounts above." });
  }

  const src = req.method === "POST" ? (h.body(req) || {}) : (req.query || {});
  const amount = Math.round(Number(src.amount));
  const frequency = src.frequency === "monthly" ? "monthly" : "once";
  if (!Number.isFinite(amount) || amount < MIN_AUD || amount > MAX_AUD) {
    return res.status(400).json({ error: "Enter an amount between $" + MIN_AUD + " and $" + fmt(MAX_AUD) + "." });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const lineItem = {
    quantity: 1,
    price_data: {
      currency: "aud",
      unit_amount: amount * 100,
      product_data: { name: frequency === "monthly" ? "Monthly donation, Defend Sacred Ground" : "Donation, Defend Sacred Ground" },
      ...(frequency === "monthly" ? { recurring: { interval: "month" } } : {})
    }
  };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: frequency === "monthly" ? "subscription" : "payment",
      line_items: [lineItem],
      // /thank-you, matching every Payment Link, so one screen handles every
      // donation route and the monthly upsell is offered consistently.
      success_url: site + "/thank-you?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: site + "/donate",
      client_reference_id: "defend-sacred-ground",
      submit_type: "donate",
      metadata: {
        campaign: "defend-sacred-ground",
        frequency,
        source_url: h.clean(src.source_url, 400),
        ref: h.clean(src.ref, 12).toUpperCase()
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
    return res.status(502).json({ error: "We could not open checkout. Nothing has been charged. Try again in a moment." });
  }
};

const fmt = (n) => Number(n).toLocaleString("en-AU");
