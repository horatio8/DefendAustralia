// GET/POST /api/rally-claim — comp and VIP tickets.
//
// A campaign event always has people who are not paying: veterans the campaign
// invited, family of the fallen, press, speakers. They get a token instead of
// a payment link, and it redeems here.
//
// GET validates without spending. The page needs to know how many places a
// token is good for before it renders a quantity selector, and a token that
// has been fully used should say so rather than failing at the last step.
//
// POST redeems. The usage count is re-read at redemption rather than trusted
// from the GET, because the two calls are minutes apart and a token shared
// between four people would otherwise let all four claim the last place.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const queue = require("./_lib/queue");

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;
  res.setHeader("Cache-Control", "private, no-store");
  if (!at.configured()) return res.status(503).json({ error: "Ticketing is not switched on yet." });

  const src = req.method === "GET" ? (req.query || {}) : (h.body(req) || {});
  const token = h.clean(src.token, 64);
  if (!token) return res.status(400).json({ error: "That link is missing its ticket code." });

  let comp;
  try {
    comp = await at.findOne(at.T.rallyTickets,
      "AND({comp_token}='" + at.esc(token) + "',{payment_status}='Comped')");
  } catch (err) {
    console.error("RALLY_CLAIM_LOOKUP_FAIL", err.message);
    return res.status(502).json({ error: "We could not check that code. Try again in a moment." });
  }

  // An unknown token and a spent token give the same message. Telling them
  // apart would let someone test codes until one came back "already used",
  // which confirms it was real.
  if (!comp) return res.status(404).json({ error: "That ticket code is not valid. Check the link in your email." });

  const maxQty = Number(comp.fields.qty || 1);
  const used = Number(comp.fields.checked_in ? maxQty : 0);
  const remaining = Math.max(0, maxQty - used);

  if (req.method === "GET") {
    return res.status(200).json({
      valid: remaining > 0,
      event: comp.fields.event_slug || "",
      max_qty: maxQty, remaining,
      message: remaining > 0 ? "" : "Every place on this code has been claimed."
    });
  }

  const qty = Math.max(1, Math.min(remaining, Number(src.qty) || 1));
  const first = h.clean(src.first_name, 60);
  const last = h.clean(src.last_name, 60);
  const email = at.normEmail(h.clean(src.email, 160));
  const mobile = h.e164(h.clean(src.mobile, 32));

  if (!first) return res.status(400).json({ error: "Enter your name so we can find you on the door." });
  if (!h.validEmail(email)) return res.status(400).json({ error: "Enter a valid email so we can send your ticket." });

  // Re-read, because the GET was minutes ago and a token shared between four
  // people would otherwise let all four claim the last place.
  let fresh;
  try {
    fresh = await at.findOne(at.T.rallyTickets, "{comp_token}='" + at.esc(token) + "'");
  } catch (err) {
    return res.status(502).json({ error: "We could not confirm that code. Try again in a moment." });
  }
  if (!fresh || fresh.fields.checked_in) {
    return res.status(409).json({ error: "Every place on this code has been claimed." });
  }

  const orderRef = "COMP-" + token.slice(0, 6).toUpperCase();
  try {
    await at.update(at.T.rallyTickets, fresh.id, {
      first_name: first, last_name: last, email, mobile,
      qty, order_ref: orderRef, checked_in: qty >= maxQty
    });
  } catch (err) {
    console.error("RALLY_CLAIM_WRITE_FAIL", err.message);
    return res.status(502).json({ error: "We could not save that. Try again in a moment." });
  }

  // Through the same pipeline as everyone else: a comped attendee is a contact
  // like any other and belongs on the same door list.
  try {
    await queue.enqueue("rally_ticket", {
      first_name: first, last_name: last, email, mobile,
      event_slug: fresh.fields.event_slug || "", qty, amount: 0,
      payment_status: "Comped", order_ref: orderRef, comp_token: token
    }, null);
  } catch (err) { console.error("QUEUE_RALLY_COMP_FAIL", err.message); }

  return res.status(200).json({ ok: true, order_ref: orderRef, qty, event: fresh.fields.event_slug || "" });
};
