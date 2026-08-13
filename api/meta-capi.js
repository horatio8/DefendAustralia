// POST /api/meta-capi — the server half of a browser pixel event.
//
// The browser fires the pixel and posts the same event here with the same
// event_id. Meta collapses the pair, so a visitor whose pixel was blocked is
// still counted once and a visitor whose pixel worked is still counted once.
//
// The browser is not trusted with much. It supplies the event name from a
// short allowlist, the event id, and the identity fields the visitor typed on
// this page. The IP and user agent are read from the request rather than the
// body, because a client that can set its own IP can poison an ad account's
// attribution.
const h = require("./_lib/http");
const meta = require("./_lib/meta");

// Standard events only. An open event name would let anyone write arbitrary
// conversions into the ad account.
const ALLOWED = new Set([
  "PageView", "ViewContent", "Lead", "CompleteRegistration",
  "InitiateCheckout", "Purchase", "Subscribe", "Contact", "Search"
]);

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "POST")) return;

  const b = h.body(req) || {};
  const name = h.clean(b.event_name, 40);
  if (!ALLOWED.has(name)) return res.status(400).json({ error: "unknown event" });
  if (!meta.configured()) return res.status(200).json({ ok: true, sent: false });

  // Twenty events per visitor per minute. A page that fires more than that is
  // looping, and the ad account should not pay for the loop.
  if (!h.rateLimit("capi:" + h.hashIp(req), 20, 60000).ok) {
    return res.status(200).json({ ok: true, sent: false, reason: "rate limited" });
  }

  const custom = {};
  if (b.value != null && !Number.isNaN(Number(b.value))) custom.value = Number(b.value);
  if (custom.value != null) custom.currency = h.clean(b.currency, 8).toUpperCase() || "AUD";
  if (b.content_name) custom.content_name = h.clean(b.content_name, 120);

  await meta.send({
    event_name: name,
    event_id: h.clean(b.event_id, 80) || meta.eventId(name, h.hashIp(req) + Date.now()),
    source_url: h.clean(b.source_url, 400),
    custom: Object.keys(custom).length ? custom : undefined,
    user: {
      email: h.clean(b.email, 160),
      mobile: h.clean(b.mobile, 32),
      first_name: h.clean(b.first_name, 60),
      last_name: h.clean(b.last_name, 60),
      postcode: h.clean(b.postcode, 12),
      fbp: h.clean(b.fbp, 120),
      fbc: h.clean(b.fbc, 200) || meta.fbcFrom(h.clean(b.fbclid, 200)),
      // From the request, never from the body.
      ip: h.clientIp(req),
      ua: String((req.headers && req.headers["user-agent"]) || "").slice(0, 400)
    }
  });

  // Write-only, and deliberately uninformative: whether Meta accepted the
  // event is not the browser's business.
  return res.status(200).json({ ok: true });
};
