// POST /api/share-click — someone opened a link carrying ?ref=CODE.
//
// The middle of the referral funnel, and the piece that was missing: codes
// were being minted and embedded in share URLs, but nothing was recorded when
// one was followed, so every share the campaign asked for was unmeasured.
//
// Two rules do most of the work here.
//
// Codes are matched case-insensitively and stored uppercase. Mail clients and
// messaging apps lowercase URLs in their own link previews and in some cases
// in what they hand the browser, and treating REDGUM and redgum as two codes
// splits one supporter's results in half.
//
// Link previewers are not people. iMessage, WhatsApp, Slack and Facebook all
// fetch a URL the moment it is pasted, which roughly doubled tracked-link
// counts in the reference build before they were filtered out.
const h = require("./_lib/http");
const queue = require("./_lib/queue");

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "POST")) return;

  const b = h.body(req) || {};
  const code = h.clean(b.code, 12).toUpperCase();
  if (!code) return res.status(200).json({ ok: true, counted: false });

  const ua = String((req.headers && req.headers["user-agent"]) || "");
  if (h.isBot(ua)) return res.status(200).json({ ok: true, counted: false, reason: "bot" });

  // One click per code per visitor per ten minutes. A supporter who opens
  // their own link four times to check it worked is one click.
  const key = "shareclick:" + code + ":" + h.hashIp(req);
  if (!h.rateLimit(key, 1, 600000).ok) return res.status(200).json({ ok: true, counted: false, reason: "repeat" });

  try {
    await queue.enqueue("share_click", {
      code,
      landing: h.clean(b.landing || b.source_url, 300),
      referrer: h.clean(b.referrer, 300)
    }, null);
  } catch (err) { console.error("QUEUE_SHARE_CLICK_FAIL", err.message); }

  // Write-only: the response says the click was counted and nothing about who
  // owns the code, so this cannot be used to test whether a code exists.
  return res.status(200).json({ ok: true, counted: true });
};
