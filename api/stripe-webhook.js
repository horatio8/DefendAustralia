// POST /api/stripe-webhook — Stripe events (signature-verified, idempotent).
// Spec §3.4/§9: fires on one-off payments, first subscription charge and rebills.
// Downstream pushes (datastore Donations row, CRM profile, Meta CAPI Purchase)
// are marked TODO until those services are wired; logging here is the durable
// record in the meantime.
const Stripe = require("stripe");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: "webhook not configured" });
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("WEBHOOK_SIGNATURE_FAIL", err.message);
    return res.status(400).json({ error: "invalid signature" });
  }

  // Re-delivery must not double-write: downstream writers key on event.id.
  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object;
      console.log("DONATION", JSON.stringify({
        event_id: event.id, type: event.type, session_id: s.id,
        amount_total: s.amount_total, currency: s.currency, mode: s.mode,
        email: s.customer_details && s.customer_details.email,
        campaign: s.metadata && s.metadata.campaign, frequency: s.metadata && s.metadata.frequency
      }));
      // TODO: datastore Donations row + CRM push + Meta CAPI Purchase (event_id dedup)
      break;
    }
    case "invoice.paid": {
      const inv = event.data.object;
      console.log("DONATION_REBILL", JSON.stringify({
        event_id: event.id, invoice_id: inv.id, amount_paid: inv.amount_paid,
        currency: inv.currency, email: inv.customer_email
      }));
      // TODO: datastore Donations row + Meta CAPI Purchase for rebills
      break;
    }
    default:
      break;
  }
  return res.status(200).json({ received: true });
};

// Signature verification needs the exact raw payload.
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
