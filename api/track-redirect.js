// GET /api/track-redirect?l=fund — a tracked short link.
//
// /fund and /fight in a text message rewrite to here. This logs the click and
// then 302s onward, carrying the campaign's own UTMs and the A/B variant so
// the donation that follows can be attributed to the message that caused it.
//
// The bot filter is the whole reason this endpoint is more than a redirect.
// iMessage, WhatsApp, Slack, Facebook and Telegram all fetch a URL the moment
// it appears in a message, before any human has touched it. Counting those
// roughly doubled click numbers in the reference build, and a doubled
// denominator makes every A/B test wrong in the same direction, so it looks
// consistent rather than broken.
//
// It redirects even when the logging fails. A supporter who clicked a link in
// a text should never see anything but the page they were promised.
const h = require("./_lib/http");
const queue = require("./_lib/queue");

// The destinations, kept here rather than in a query parameter so this cannot
// be used as an open redirect.
const LINKS = {
  fund: { path: "/donate", medium: "sms", campaign: "sms_fund" },
  fight: { path: "/take-action/defend-sacred-ground", medium: "sms", campaign: "sms_fight" },
  sign: { path: "/take-action/defend-sacred-ground", medium: "sms", campaign: "sms_sign" },
  share: { path: "/share", medium: "sms", campaign: "sms_share" }
};

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET")) return;

  const q = req.query || {};
  const key = h.clean(q.l, 20).toLowerCase();
  const link = LINKS[key];
  if (!link) return res.status(404).json({ error: "unknown link" });

  const code = h.clean(q.c, 12).toUpperCase();   // referral attribution
  const variant = h.clean(q.v, 20);              // A/B variant
  const test = h.clean(q.t, 40);

  const ua = String((req.headers && req.headers["user-agent"]) || "");
  const bot = h.isBot(ua);

  const dest = link.path + "?utm_source=sms&utm_medium=" + encodeURIComponent(link.medium) +
    "&utm_campaign=" + encodeURIComponent(link.campaign) +
    (variant ? "&utm_content=" + encodeURIComponent(variant) : "") +
    (code ? "&ref=" + encodeURIComponent(code) : "") +
    (key === "fund" ? "&focus=1" : "");

  // The redirect is sent first and the logging is not awaited past it: the
  // click matters, but not as much as the page loading.
  if (!bot) {
    try {
      await queue.enqueue("link_click", {
        link: key, code, variant, test,
        landing: dest, referrer: h.clean(req.headers && req.headers.referer, 300)
      }, null);
    } catch (err) { console.error("QUEUE_LINK_CLICK_FAIL", err.message); }
  }

  res.setHeader("Cache-Control", "private, no-store");
  res.writeHead(302, { Location: dest });
  return res.end();
};

module.exports.LINKS = LINKS;
