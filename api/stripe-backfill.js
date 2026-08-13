// GET /api/stripe-backfill — recover donations the webhook never saw.
//
// This exists because it was needed. The webhook was registered days after the
// first payments came in, and there is no way to make Stripe redeliver events
// that predate a subscription. Those charges are real money from real donors
// who are simply absent from the base.
//
// Dry run by default. A backfill that writes on the first call is one typo
// away from duplicating every donation in the account, so the default answers
// "here is what I would do" and writing requires ?apply=1.
//
// Idempotent either way: each charge's payment intent is the dedup key, so a
// backfill run twice is a no-op the second time.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const Stripe = require("stripe");

const PAGE = 100;

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;
  if (!h.requireBasicAuth(req, res)) return;
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: "stripe not configured" });
  if (!at.configured()) return res.status(503).json({ error: "airtable not configured" });

  const q = req.query || {};
  const apply = q.apply === "1";
  const days = Math.min(365, Math.max(1, Number(q.days || 30)));
  const since = Math.floor((Date.now() - days * 86400000) / 1000);

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const out = { dry_run: !apply, days, scanned: 0, already: 0, missing: 0, written: 0, failed: 0, examples: [] };

  let starting_after;
  try {
    for (let page = 0; page < 20; page++) {
      const batch = await stripe.charges.list({ limit: PAGE, created: { gte: since }, starting_after });
      for (const ch of batch.data) {
        out.scanned++;
        if (ch.status !== "succeeded" || ch.refunded) continue;

        const key = "backfill:" + (ch.payment_intent || ch.id);
        const seen = await at.findOne(at.T.events, "{dedup_key}='" + at.esc(key) + "'");
        const alsoSeen = seen || await at.findOne(at.T.donations,
          "{stripe_payment_intent}='" + at.esc(ch.payment_intent || "") + "'");
        if (alsoSeen) { out.already++; continue; }

        out.missing++;
        const bd = ch.billing_details || {};
        const parts = String(bd.name || "").trim().split(/\s+/).filter(Boolean);
        const row = {
          amount_cents: ch.amount, currency: (ch.currency || "aud").toUpperCase(),
          frequency: (ch.metadata && ch.metadata.frequency) === "monthly" ? "Monthly" : "One off",
          first_name: parts[0] || "", last_name: parts.slice(1).join(" "),
          email: at.normEmail(bd.email), mobile: bd.phone || "",
          postcode: (bd.address && bd.address.postal_code) || "",
          country: (bd.address && bd.address.country) || "",
          stripe_object_type: "charge", stripe_object_id: ch.id,
          stripe_payment_intent: ch.payment_intent || "",
          stripe_customer: typeof ch.customer === "string" ? ch.customer : "",
          campaign: (ch.metadata && ch.metadata.campaign) || "defend-sacred-ground",
          created: new Date(ch.created * 1000).toISOString()
        };

        if (out.examples.length < 10) {
          out.examples.push({ id: ch.id, email: row.email, amount: ch.amount / 100, at: row.created });
        }
        if (!apply) continue;

        try { await write(row, key); out.written++; }
        catch (err) { out.failed++; console.error("BACKFILL_WRITE_FAIL", ch.id, err.message); }
      }
      if (!batch.has_more) break;
      starting_after = batch.data[batch.data.length - 1].id;
    }
  } catch (err) {
    console.error("BACKFILL_FAIL", err.message);
    return res.status(502).json({ error: String(err.message || err), ...out });
  }

  res.setHeader("Cache-Control", "private, no-store");
  out.note = apply
    ? "Written. Run again to confirm the missing count is now zero."
    : "Nothing was written. Add &apply=1 to write these " + out.missing + " donation(s).";
  return res.status(200).json(out);
};

async function write(row, dedupKey) {
  const contact = await at.upsertContact({
    first_name: row.first_name, last_name: row.last_name, email: row.email,
    mobile: row.mobile, postcode: row.postcode, consent: true,
    source_channel: "Donation", status: row.frequency === "One off" ? "Donor" : "Recurring donor"
  });
  const ev = await at.logEvent({
    contactRecId: contact.id, event_type: "Donation", source_channel: "Backfill",
    dedup_key: dedupKey, timestamp: row.created, payload: row
  });
  if (ev.duplicate) return;
  await at.create(at.T.donations, {
    donation_id: at.uuid(), contact: [contact.id], event: [ev.id],
    amount: row.amount_cents / 100, amount_cents: row.amount_cents,
    currency: row.currency, frequency: row.frequency,
    first_name: row.first_name, last_name: row.last_name, email: row.email,
    mobile: row.mobile, postcode: row.postcode, country: row.country,
    stripe_object_type: row.stripe_object_type, stripe_object_id: row.stripe_object_id,
    stripe_payment_intent: row.stripe_payment_intent, stripe_customer: row.stripe_customer,
    campaign: row.campaign,
    // Never offered: the thank-you page did not exist when this charge
    // happened, so recording it as Offered would overstate the upsell rate.
    upsell_outcome: "Not offered", upsell_offered: false,
    timestamp: row.created, payload: JSON.stringify(row, null, 1)
  });
  await at.markFanout(ev.id, true);
}
