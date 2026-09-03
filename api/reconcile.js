// GET /api/reconcile?store=… — do the three systems agree?
//
// A campaign runs on three ledgers that are written at different moments by
// different code: Campaign Nucleus, Airtable, and Stripe. Each is right about
// something the others are not, and none of them will ever tell you they have
// drifted. This counts them and puts the numbers beside each other.
//
// One store per call, deliberately. Counting everything in one request means
// the slowest store decides whether any answer arrives, and the answer that
// matters is usually the one that would have come back first.
//
//   ?store=nucleus     signatures the CRM holds
//   ?store=airtable    contacts, signatures, donations and the queue
//   ?store=stripe      charges Stripe has settled
//   ?store=queue       what is stuck, and for how long
//
// Read-only. Nothing here repairs anything, because a reconciliation that
// also writes cannot be run to find out whether writing is safe.

const h = require("./_lib/http");
const at = require("./_lib/airtable");
const nucleus = require("./_lib/nucleus");
const stripe = require("./_lib/stripe");

const STORES = ["nucleus", "airtable", "stripe", "queue"];

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET")) return;
  if (!h.requireBasicAuth(req, res)) return;
  res.setHeader("Cache-Control", "no-store");

  const store = String((req.query || {}).store || "").toLowerCase();
  if (STORES.indexOf(store) === -1) {
    return res.status(200).json({
      stores: STORES,
      how: "Add ?store=<name>. One store per call: counting all of them in one request lets the slowest decide whether any answer arrives."
    });
  }

  const started = Date.now();
  try {
    const data = await ({ nucleus: fromNucleus, airtable: fromAirtable, stripe: fromStripe, queue: fromQueue })[store]();
    return res.status(200).json({ store, ms: Date.now() - started, ...data });
  } catch (err) {
    return res.status(200).json({ store, ms: Date.now() - started, error: String(err.message || err) });
  }
};

async function fromNucleus() {
  if (!nucleus.configured()) return { configured: false };
  const petition = await nucleus.entryCount("petition");
  return {
    configured: true,
    petition_entries: petition,
    note: "This is the number the site shows. It is the CRM's own count, so the public figure and the CRM can never disagree."
  };
}

async function fromAirtable() {
  if (!at.configured()) return { configured: false };
  const deadline = Date.now() + 20000;
  const counts = {};
  const partial = [];

  for (const [label, table, filter] of [
    ["contacts", at.T.contacts, null],
    ["signatures", at.T.signatures, null],
    ["donations", at.T.donations, null],
    ["contacts_without_code", at.T.contacts, "{referral_code}=''"],
    ["contacts_without_email", at.T.contacts, "{email}=''"],
    ["signatures_not_in_crm", at.T.signatures, "AND({cn_synced}=0,{cn_error}!='')"]
  ]) {
    let n = 0;
    const walked = await at.walk(table, {
      pageSize: 100, fields: [], filterByFormula: filter, deadline
    }, () => { n++; });
    counts[label] = n;
    if (!walked.done) partial.push(label);
  }

  return {
    configured: true,
    counts,
    partial: partial.length ? partial : null,
    note: partial.length
      ? "Counts marked partial ran out of time and are a lower bound."
      : "Contacts exceeding signatures is normal: donors and volunteers are contacts who may never have signed."
  };
}

async function fromStripe() {
  if (!stripe.configured()) return { configured: false };
  // Thirty days is far enough back to catch a webhook outage and near enough
  // that the walk stays cheap. Older gaps are what /api/stripe-backfill is for.
  const since = Math.floor((Date.now() - 30 * 86400000) / 1000);
  const sdk = stripe.client();
  let charges = 0, cents = 0, refunded = 0, cursor = null, pages = 0;

  do {
    const page = await sdk.charges.list({
      limit: 100, created: { gte: since }, ...(cursor ? { starting_after: cursor } : {})
    });
    for (const c of page.data || []) {
      if (c.status !== "succeeded") continue;
      charges++;
      cents += c.amount - (c.amount_refunded || 0);
      if (c.amount_refunded) refunded++;
    }
    cursor = page.has_more && page.data.length ? page.data[page.data.length - 1].id : null;
    pages++;
  } while (cursor && pages < 20);

  let recorded = 0;
  if (at.configured()) {
    await at.walk(at.T.donations, {
      pageSize: 100, fields: [],
      filterByFormula: "IS_AFTER({timestamp},'" + new Date(since * 1000).toISOString() + "')",
      deadline: Date.now() + 12000
    }, () => { recorded++; });
  }

  return {
    configured: true,
    live_key: stripe.liveKey(process.env.STRIPE_SECRET_KEY),
    window_days: 30,
    stripe_charges: charges,
    stripe_net: Math.round(cents) / 100,
    partially_refunded: refunded,
    airtable_donation_rows: recorded,
    gap: charges - recorded,
    note: charges > recorded
      ? "Stripe has settled charges that Airtable has no row for. That is what /api/stripe-backfill recovers."
      : "Every settled charge in the window has a row."
  };
}

async function fromQueue() {
  if (!at.configured()) return { configured: false };
  const byStatus = {};
  let oldestWaiting = null;
  await at.walk(at.T.queue, {
    pageSize: 100, fields: ["status", "created_at", "attempts", "error"],
    deadline: Date.now() + 15000
  }, (r) => {
    const f = r.fields || {};
    const s = (f.status && f.status.name) || f.status || "unknown";
    byStatus[s] = (byStatus[s] || 0) + 1;
    if (s === "Waiting" && f.created_at && (!oldestWaiting || f.created_at < oldestWaiting)) {
      oldestWaiting = f.created_at;
    }
  });

  const waitingMin = oldestWaiting ? Math.round((Date.now() - Date.parse(oldestWaiting)) / 60000) : null;
  return {
    configured: true,
    by_status: byStatus,
    oldest_waiting: oldestWaiting,
    oldest_waiting_minutes: waitingMin,
    note: waitingMin != null && waitingMin > 15
      ? "Something has been waiting " + waitingMin + " minutes. The drain runs every minute, so this means it is failing or not firing."
      : "Nothing is stuck."
  };
}

module.exports.STORES = STORES;
