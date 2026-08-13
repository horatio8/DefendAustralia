// POST /api/rally-webhook — a ticket was paid for.
//
// Its own signing secret and its own endpoint, separate from the donation
// webhook. Two reasons. Ticket money is not donation money and must not land
// in the Donations table, or every fundraising report has to be filtered for
// tickets forever. And a shared endpoint verifying against two secrets in turn
// is a way to accidentally accept an event signed by the wrong account.
//
// Only rally events are handled. Anything else that reaches this endpoint is
// acknowledged and ignored, because it means the wrong URL is configured
// somewhere and a 400 would just make Stripe retry it forever.
const at = require("./_lib/airtable");
const queue = require("./_lib/queue");
const meta = require("./_lib/meta");
const Stripe = require("stripe");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  const secret = process.env.RALLY_STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY;
  const signing = process.env.RALLY_STRIPE_WEBHOOK_SECRET;
  if (!secret || !signing) return res.status(503).json({ error: "rally webhook not configured" });

  const stripe = new Stripe(secret);
  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, req.headers["stripe-signature"], signing);
  } catch (err) {
    console.error("RALLY_WEBHOOK_SIGNATURE_FAIL", err.message);
    return res.status(400).json({ error: "invalid signature" });
  }

  try {
    if (event.type === "checkout.session.completed") await onPaid(event);
  } catch (err) {
    // 200 regardless: the dedup key makes a retry safe, but a stuck retry loop
    // helps nobody and the error is in the log.
    console.error("RALLY_WEBHOOK_FAIL", err.message);
  }
  return res.status(200).json({ received: true });
};

async function onPaid(event) {
  const s = event.data.object;
  if (s.payment_status !== "paid") return;

  const d = s.customer_details || {};
  const parts = String(d.name || "").trim().split(/\s+/).filter(Boolean);
  const meta_ = s.metadata || {};

  const row = {
    event_slug: meta_.event || s.client_reference_id || "rally",
    first_name: parts[0] || "", last_name: parts.slice(1).join(" "),
    email: at.normEmail(d.email), mobile: d.phone || "",
    qty: Number(meta_.qty || 1),
    amount: (s.amount_total || 0) / 100,
    currency: (s.currency || "aud").toUpperCase(),
    payment_status: "Paid",
    // Short enough to read down a phone at the door.
    order_ref: "T-" + String(s.id).slice(-8).toUpperCase(),
    stripe_session: s.id,
    stripe_payment_intent: typeof s.payment_intent === "string" ? s.payment_intent : "",
    referral_used: (meta_.ref || "").toUpperCase(),
    dedup_key: event.id
  };

  console.log("RALLY_TICKET", JSON.stringify({ event_id: event.id, ...row }));

  try { await queue.enqueue("rally_ticket", row, null); }
  catch (err) { console.error("QUEUE_RALLY_FAIL", err.message); }

  // A ticket is a purchase. It goes to Meta as one, keyed on the Stripe event
  // id so a redelivery cannot double-count.
  try {
    await meta.send({
      event_name: "Purchase",
      event_id: meta.eventId("rally", event.id),
      event_time: (event.created || Math.floor(Date.now() / 1000)) * 1000,
      custom: { value: row.amount, currency: row.currency, content_name: "ticket " + row.event_slug },
      user: {
        email: row.email, mobile: row.mobile,
        first_name: row.first_name, last_name: row.last_name, country: "au"
      }
    });
  } catch (err) { console.error("META_RALLY_FAIL", err.message); }
}

module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
