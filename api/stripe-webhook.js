// POST /api/stripe-webhook — Stripe events (signature-verified, idempotent).
//
// Every successful charge becomes a Donation event in Airtable, a typed row in
// Donations, a Contact upsert, and a Campaign Nucleus profile tagged Donor (or
// Recurring donor). Re-delivery is a no-op: the Stripe event id is the dedup
// key on the Events row.
//
// The upsell is closed here, not on the thank-you page. When a monthly
// subscription starts for someone who gave a one-off in the last few days, the
// earlier gift's row is marked Accepted, so the conversion rate is measured
// from what actually happened rather than from clicks.
const Stripe = require("stripe");
const at = require("./_lib/airtable");
const nucleus = require("./_lib/nucleus");
const meta = require("./_lib/meta");

const UPSELL_WINDOW_DAYS = 7;

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

  try {
    if (event.type === "checkout.session.completed") await onCheckout(event, stripe);
    else if (event.type === "invoice.paid") await onInvoice(event);
  } catch (err) {
    // Answer 200 regardless: Stripe retries on non-2xx and the dedup key makes
    // a retry safe, but a stuck retry loop helps nobody. The error is logged.
    console.error("WEBHOOK_HANDLER_FAIL", event.type, err.message);
  }
  return res.status(200).json({ received: true });
};

async function onCheckout(event, stripe) {
  const s = event.data.object;
  if (s.payment_status !== "paid" && s.mode !== "subscription") return;
  const d = s.customer_details || {};
  const donor = splitName(d.name);
  const monthly = s.mode === "subscription";

  const row = {
    amount_cents: s.amount_total || 0,
    currency: (s.currency || "aud").toUpperCase(),
    frequency: monthly ? "Monthly" : "One off",
    first_name: donor.first, last_name: donor.last,
    email: at.normEmail(d.email),
    mobile: (d.phone || ""),
    postcode: (d.address && d.address.postal_code) || "",
    country: (d.address && d.address.country) || "",
    stripe_object_type: "checkout.session",
    stripe_object_id: s.id,
    stripe_payment_intent: s.payment_intent || "",
    stripe_customer: typeof s.customer === "string" ? s.customer : "",
    stripe_subscription: typeof s.subscription === "string" ? s.subscription : "",
    campaign: (s.metadata && s.metadata.campaign) || "defend-sacred-ground"
  };
  console.log("DONATION", JSON.stringify({ event_id: event.id, ...row }));
  await record(event, row, monthly ? "Donation" : "Donation");
  if (monthly) await closeUpsell(row, stripe);
}

async function onInvoice(event) {
  const inv = event.data.object;
  // The first invoice of a subscription is already covered by the checkout
  // event. Only rebills are new information here.
  if (inv.billing_reason && inv.billing_reason !== "subscription_cycle") return;
  const donor = splitName(inv.customer_name);
  const row = {
    amount_cents: inv.amount_paid || 0,
    currency: (inv.currency || "aud").toUpperCase(),
    frequency: "Monthly rebill",
    first_name: donor.first, last_name: donor.last,
    email: at.normEmail(inv.customer_email),
    stripe_object_type: "invoice",
    stripe_object_id: inv.id,
    stripe_payment_intent: inv.payment_intent || "",
    stripe_customer: typeof inv.customer === "string" ? inv.customer : "",
    stripe_subscription: typeof inv.subscription === "string" ? inv.subscription : "",
    campaign: "defend-sacred-ground"
  };
  console.log("DONATION_REBILL", JSON.stringify({ event_id: event.id, ...row }));
  await record(event, row, "Donation Rebill");
}

async function record(event, row, eventType) {
  if (!at.configured()) return;
  const recurring = row.frequency !== "One off";
  const contact = await at.upsertContact({
    first_name: row.first_name, last_name: row.last_name, email: row.email,
    mobile: row.mobile, postcode: row.postcode, consent: true,
    source_channel: "Donation", status: recurring ? "Recurring donor" : "Donor"
  });
  const ev = await at.logEvent({
    contactRecId: contact.id, event_type: eventType, source_channel: "Stripe webhook",
    dedup_key: event.id, payload: row,
    timestamp: new Date((event.created || Math.floor(Date.now() / 1000)) * 1000).toISOString()
  });
  if (ev.duplicate) return; // already processed this Stripe event

  try {
    await at.create(at.T.donations, {
      donation_id: at.uuid(), contact: [contact.id], event: [ev.id],
      amount: (row.amount_cents || 0) / 100, amount_cents: row.amount_cents,
      currency: row.currency, frequency: row.frequency,
      first_name: row.first_name, last_name: row.last_name, email: row.email,
      mobile: row.mobile || "", postcode: row.postcode || "", country: row.country || "",
      stripe_object_type: row.stripe_object_type, stripe_object_id: row.stripe_object_id,
      stripe_payment_intent: row.stripe_payment_intent || "",
      stripe_customer: row.stripe_customer || "", stripe_subscription: row.stripe_subscription || "",
      campaign: row.campaign,
      upsell_outcome: recurring ? "Not offered" : "Offered",
      upsell_offered: !recurring,
      timestamp: at.nowIso(), payload: JSON.stringify(row, null, 1)
    });
    await at.markFanout(ev.id, true);
  } catch (err) {
    await at.markFanout(ev.id, false, err.message);
  }

  await bumpLifetime(contact.id, (row.amount_cents || 0) / 100);

  // Purchase to Meta, from here rather than from the browser. The donor is on
  // Stripe's domain when the payment succeeds and may close the tab before
  // ever loading the thank-you page, so the browser pixel cannot be relied on
  // for the one event that carries the money. Rebills fire too: a monthly
  // donor's second year is revenue the original ad produced.
  //
  // The event id is the Stripe event id, which is also the Airtable dedup key,
  // so a Stripe redelivery cannot double-count in Meta either.
  try {
    const first = contact.fields || {};
    await meta.send({
      event_name: "Purchase",
      event_id: meta.eventId("purchase", event.id),
      event_time: (event.created || Math.floor(Date.now() / 1000)) * 1000,
      action_source: "website",
      custom: {
        value: (row.amount_cents || 0) / 100,
        currency: row.currency || "AUD",
        content_name: row.frequency
      },
      user: {
        email: row.email, mobile: row.mobile, postcode: row.postcode,
        first_name: row.first_name, last_name: row.last_name,
        country: row.country || "au",
        // First-touch values, carried on the contact from the visit that
        // produced them. This is the thread back to the ad.
        fbp: first.fbp || "",
        fbc: first.fbclid ? meta.fbcFrom(first.fbclid) : ""
      }
    });
  } catch (err) { console.error("META_PURCHASE_FAIL", err.message); }

  try {
    await nucleus.upsertProfile({
      email: row.email, first_name: row.first_name, last_name: row.last_name,
      mobile: row.mobile, postcode: row.postcode,
      tags: ["Defend Sacred Ground", "Donor"].concat(recurring ? ["Recurring donor"] : [])
    });
  } catch (err) { console.error("CN_DONOR_FAIL", err.message); }
}

async function bumpLifetime(contactRecId, amount) {
  try {
    const res = await at.call("GET", at.T.contacts, "filterByFormula=" +
      encodeURIComponent("RECORD_ID()='" + contactRecId + "'") + "&maxRecords=1");
    const rec = res && res.records && res.records[0];
    const prev = (rec && Number(rec.fields.lifetime_donations)) || 0;
    await at.update(at.T.contacts, contactRecId, { lifetime_donations: prev + amount });
  } catch (err) { /* the Donations rows remain the authoritative total */ }
}

// A monthly gift that follows a recent one-off from the same person is the
// upsell landing. Mark the one-off so the offer can be measured.
async function closeUpsell(row, stripe) {
  if (!at.configured() || !row.email) return;
  try {
    const cutoff = new Date(Date.now() - UPSELL_WINDOW_DAYS * 86400000).toISOString();
    const formula = "AND(LOWER({email})='" + at.esc(row.email) + "',{frequency}='One off'," +
      "IS_AFTER({timestamp},'" + cutoff + "'),{upsell_outcome}='Offered')";
    const prior = await at.findOne(at.T.donations, formula);
    if (!prior) return;
    await at.update(at.T.donations, prior.id, {
      upsell_outcome: "Accepted",
      upsell_converted_to: row.stripe_subscription || ""
    });
    await at.logEvent({
      contactRecId: (prior.fields.contact && prior.fields.contact[0]) || undefined,
      event_type: "Donation Upsell Accepted", source_channel: "Stripe webhook",
      dedup_key: "upsell:" + (row.stripe_subscription || row.stripe_object_id),
      payload: { from: prior.fields.donation_id, subscription: row.stripe_subscription, amount: row.amount_cents / 100 }
    });
  } catch (err) { console.error("UPSELL_CLOSE_FAIL", err.message); }
}

function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: "", last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

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
