// GET /wa1, /wa2 — tracked links into the campaign's messaging channel.
//
// Both land on the same channel. The two paths exist because the messages
// carrying them are being tested against each other, and a channel follower
// is anonymous: WhatsApp will never tell us which message brought somebody
// in. Our own domain is the only place the click can be counted, so the
// variant has to be in the path.
//
// This is a function rather than a redirect in vercel.json, and that is not
// an accident. An edge redirect resolves before any code runs, so there is
// nothing to count — it would look like it was working and produce an empty
// scoreboard.
//
// 307, and no-store with it. A 301 or 308 is cached hard by browsers and by
// the in-app webviews inside Messenger and Instagram, so repeat clicks would
// stop reaching this function at all and the count would quietly fall behind
// the truth. 307 keeps every tap observable.
//
// What is recorded: the variant, the time, the referrer, and a deliberately
// lossy user agent — platform and app family, nothing more. No IP address, no
// full user-agent string, nothing that identifies a device. These are
// supporters, not traffic.

const h = require("./_lib/http");
const queue = require("./_lib/queue");

const VARIANTS = { wa1: "A", wa2: "B" };

// Set WHATSAPP_CHANNEL_URL to the channel invite. Until it is set these paths
// answer 404 rather than sending anybody somewhere arbitrary — a redirect to
// a default channel belonging to a different campaign is worse than a dead
// link, because nobody would notice it was wrong.
const channel = () => String(process.env.WHATSAPP_CHANNEL_URL || "").trim();

/* Deliberately lossy. Enough to know "an iPhone, opened from inside
 * Instagram" without keeping a string that identifies a handset. */
function coarseUA(ua) {
  const s = String(ua || "");
  const platform = /iPhone|iPad|iOS/i.test(s) ? "iOS"
    : /Android/i.test(s) ? "Android"
      : /Windows|Macintosh|X11|Linux/i.test(s) ? "desktop"
        : "other";
  // Meta's in-app browsers name themselves: Instagram by name, Messenger and
  // the Facebook app by their FBAN/FBAV build tokens.
  const app = /Instagram/i.test(s) ? "instagram"
    : /FBAN|FBAV|FB_IAB|Messenger/i.test(s) ? "facebook"
      : "browser";
  return platform + "/" + app;
}

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET")) return;

  const url = channel();
  if (!url) return res.status(404).json({ error: "no channel configured" });

  const key = h.clean((req.query || {}).v, 8).toLowerCase();
  const variant = VARIANTS[key] || VARIANTS.wa1;
  const ua = String((req.headers && req.headers["user-agent"]) || "");

  /* A preview fetcher must still get the redirect so the link's card renders
   * in the message, but it must not be counted. These links go into Messenger
   * and Instagram DMs, where a preview is fetched on every single send — so
   * counting them would measure how many messages were sent, not how many
   * people tapped, and the test would be meaningless while looking fine. */
  if (!h.isBot(ua)) {
    try {
      await queue.enqueue("wa_click", {
        variant,
        path: key || "wa1",
        ua: coarseUA(ua),
        referrer: h.clean(req.headers && (req.headers.referer || req.headers.referrer), 200)
      }, null);
    } catch (err) {
      console.error("WA_CLICK_LOG_FAIL", err.message);
    }
  }

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.writeHead(307, { Location: url });
  return res.end();
};

module.exports.VARIANTS = VARIANTS;
module.exports.coarseUA = coarseUA;
