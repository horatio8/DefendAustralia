// GET /api/share-context — who is this visitor, and what is their share link?
//
// The share page has to answer "what is my code" for three different arrivals,
// and it tries them in this order because that is the order of confidence:
//
//   1. ?session_id=cs_...  they have just donated. Stripe knows their email.
//   2. ?code=...           they already have a code in local storage.
//   3. neither             the page asks for their email instead.
//
// The Stripe route polls. The webhook that writes the donation and the browser
// coming back from Stripe are a race, and the browser usually wins, so a first
// call can legitimately find a session that is paid but not yet expanded. That
// answers `polling` rather than `unknown`, because telling a donor we do not
// know who they are, seconds after they gave money, is its own kind of failure.
//
// Nothing here echoes stored personal data back. The response carries a first
// name and a referral code: the first name because the page greets them with
// it, the code because it is theirs and it is in the URL they are about to
// send. No email, no address, no history.
const h = require("./_lib/http");
const at = require("./_lib/airtable");

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET")) return;

  const q = req.query || {};
  const sessionId = h.clean(q.session_id, 90);
  const code = h.clean(q.code, 12).toUpperCase();

  res.setHeader("Cache-Control", "private, no-store");

  try {
    if (sessionId) return res.status(200).json(await fromStripe(sessionId));
    if (code) return res.status(200).json(await fromCode(code));
    return res.status(200).json({ state: "ask_email" });
  } catch (err) {
    console.error("SHARE_CONTEXT_FAIL", err.message);
    return res.status(200).json({ state: "ask_email", note: "We could not look you up automatically." });
  }
};

async function fromStripe(sessionId) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return { state: "ask_email" };
  if (!process.env.STRIPE_SECRET_KEY) return { state: "ask_email" };

  const Stripe = require("stripe");
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let s;
  try { s = await stripe.checkout.sessions.retrieve(sessionId); }
  catch (e) { return { state: "ask_email" }; }

  const email = at.normEmail((s.customer_details || {}).email);
  const first = String((s.customer_details || {}).name || "").trim().split(/\s+/)[0] || "";
  // client_reference_id carries the petition they came from, so the share
  // links point at the campaign they actually cared about.
  const petition = h.clean(s.client_reference_id, 120);

  if (!email) return { state: "ask_email" };

  const contact = at.configured()
    ? await at.findOne(at.T.contacts, "LOWER({email})='" + at.esc(email) + "'")
    : null;

  if (contact && contact.fields.referral_code) {
    return {
      state: "ready",
      first_name: first || contact.fields.first_name || "",
      code: String(contact.fields.referral_code).toUpperCase(),
      petition
    };
  }

  // Paid, but the webhook has not landed yet. The page keeps asking.
  return { state: "polling", first_name: first, petition };
}

async function fromCode(code) {
  if (!at.configured()) return { state: "ready", code };
  const owner = await at.findOne(at.T.contacts, "UPPER({referral_code})='" + at.esc(code) + "'");
  // An unrecognised code still works as a link: it is a stable string and the
  // rollup will simply have nobody to credit. Answering "no such code" would
  // turn this into a way to enumerate them.
  return {
    state: "ready",
    code,
    first_name: (owner && owner.fields.first_name) || ""
  };
}
