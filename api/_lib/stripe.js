// Stripe access, and the one question that matters before dunning somebody:
// did this person actually pay?
//
// The mode check is here rather than inline because a test key is the most
// convincing kind of wrong. It authenticates, it retrieves an account, it
// creates sessions, and it cannot see a single live payment. Anything that
// reads "no payment found" from a test key against live data is about to chase
// a donor for money they already gave.
const Stripe = require("stripe");

function configured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

/* Secret keys carry their mode in the prefix, so this needs no API call:
 * sk_live_ is a full key, rk_live_ a restricted one. Anything else, including
 * an empty value or a publishable key pasted by mistake, is not live. */
function liveKey(k) {
  const key = k === undefined ? process.env.STRIPE_SECRET_KEY : k;
  return /^(sk|rk)_live_[A-Za-z0-9]/.test(String(key == null ? "" : key).trim());
}

function client() {
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

/* Has this person paid, according to Stripe itself?
 *
 * Three outcomes, and the third is the important one. "paid" and "not paid"
 * are answers; "unknown" means the question could not be answered and the
 * caller must not treat that as a no.
 *
 * sessionId is the checkout the queue row came from. It settles this abandon.
 * The email search is the backstop for the failure that actually happens:
 * a donor taps an amount, goes back, taps another, and pays on the second
 * session. The first session stays unpaid for ever and looks exactly like an
 * abandon, because it is one, by somebody who has already given. */
async function hasPaid(opts) {
  const o = opts || {};
  if (!configured()) return { unknown: true, why: "stripe not configured" };
  if (!liveKey()) return { unknown: true, why: "stripe key is test mode, cannot see live payments" };

  const stripe = client();
  const sinceUnix = o.since ? Math.floor(new Date(o.since).getTime() / 1000) : 0;

  // 1. The session this row is about.
  if (o.sessionId && /^cs_[A-Za-z0-9_]+$/.test(o.sessionId)) {
    try {
      const s = await stripe.checkout.sessions.retrieve(o.sessionId);
      if (s && (s.payment_status === "paid" || s.status === "complete")) {
        return { paid: true, why: "session " + o.sessionId + " is paid" };
      }
    } catch (err) {
      // A session that cannot be read is not a session that was not paid.
      return { unknown: true, why: "session lookup failed: " + String(err.message || err).slice(0, 120) };
    }
  }

  // 2. Any successful payment by this person, on any session.
  const email = String(o.email || "").trim().toLowerCase();
  if (!email) return { paid: false, why: "no session payment and no email to check" };
  try {
    const customers = await stripe.customers.list({ email, limit: 10 });
    for (const c of (customers && customers.data) || []) {
      const pis = await stripe.paymentIntents.list({ customer: c.id, limit: 20 });
      for (const pi of (pis && pis.data) || []) {
        if (pi.status === "succeeded" && (!sinceUnix || pi.created >= sinceUnix)) {
          return { paid: true, why: "payment intent " + pi.id + " succeeded" };
        }
      }
    }
  } catch (err) {
    return { unknown: true, why: "payment search failed: " + String(err.message || err).slice(0, 120) };
  }

  return { paid: false, why: "no paid session and no succeeded payment for " + email };
}

module.exports = { configured, liveKey, client, hasPaid };
