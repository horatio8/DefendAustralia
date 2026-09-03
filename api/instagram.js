// GET /api/instagram — the News page Instagram grid.
//
// Instagram publishes no feed. The only reliable, permitted route to a
// business account's posts is Meta's Graph API with a token, so unlike the
// YouTube rail this one needs configuration before it shows anything: a
// Page access token carrying instagram_basic, from a Page the Instagram
// account is linked to. Until then the page keeps showing the curated tiles
// from site.json, and this answers 503 with a reason a human can act on.
//
// The account id is resolved from the token rather than typed in: the token
// knows which Pages it can see, and each Page knows its linked Instagram
// account. Memoised, so it is one lookup a day rather than one a visitor.
//
// Edge-cached ten minutes with a long stale window, same as the video rail.
const h = require("./_lib/http");

const MAX = 12;
const API = "https://graph.facebook.com/v21.0";
let memo = null;           // { items, at }
let userMemo = null;       // { id, username, at }
const MEMO_MS = 300000;
const USER_MEMO_MS = 86400000;

function token() {
  // Its own variable first, so the Instagram grant can be a narrower token
  // than the one that reads leads. Falls back to the lead page token because
  // on a small campaign they are usually the same system user, and a token
  // that is sitting right there should not be ignored for want of a second
  // copy of it.
  return process.env.INSTAGRAM_ACCESS_TOKEN || process.env.META_LEAD_PAGE_TOKEN || "";
}

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET")) return;

  if (!token()) {
    return res.status(503).json({ error: "instagram not configured: set INSTAGRAM_ACCESS_TOKEN", items: [] });
  }

  if (memo && Date.now() - memo.at < MEMO_MS) {
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
    return res.status(200).json({ items: memo.items, cached: true });
  }

  let items = [];
  try {
    const user = await resolveUser();
    items = await fromGraph(user.id);
  } catch (err) {
    console.error("INSTAGRAM_FEED_FAIL", err.message);
  }

  if (!items.length) {
    if (memo) return res.status(200).json({ items: memo.items, stale: true });
    return res.status(502).json({ error: "instagram feed unavailable", items: [] });
  }

  memo = { items, at: Date.now() };
  res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
  return res.status(200).json({ items });
};

/* Which Instagram account this token can read. INSTAGRAM_USER_ID short-cuts
 * the lookup when it is known; otherwise every Page the token can see is
 * asked for its linked account and the first one wins, which on a campaign
 * with one Page and one Instagram is the right one. */
async function resolveUser() {
  if (process.env.INSTAGRAM_USER_ID) return { id: process.env.INSTAGRAM_USER_ID, username: "" };
  if (userMemo && Date.now() - userMemo.at < USER_MEMO_MS) return userMemo;

  const r = await fetch(API + "/me/accounts?fields=" +
    encodeURIComponent("name,instagram_business_account{id,username}") +
    "&access_token=" + encodeURIComponent(token()));
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("pages " + r.status + ": " + graphError(body));

  const found = pickInstagram(body);
  if (!found) throw new Error("no Instagram account linked to any Page this token can see");
  userMemo = { ...found, at: Date.now() };
  return userMemo;
}

function pickInstagram(pagesBody) {
  for (const page of (pagesBody && pagesBody.data) || []) {
    const ig = page.instagram_business_account;
    if (ig && ig.id) return { id: String(ig.id), username: String(ig.username || "") };
  }
  return null;
}

async function fromGraph(userId) {
  const r = await fetch(API + "/" + encodeURIComponent(userId) + "/media?limit=" + MAX +
    "&fields=" + encodeURIComponent("id,caption,media_type,media_url,thumbnail_url,permalink,timestamp") +
    "&access_token=" + encodeURIComponent(token()));
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("media " + r.status + ": " + graphError(body));
  return parseMedia(body);
}

/* One shape for the page, whatever Instagram sent.
 *
 * A video's media_url is the video file; the grid wants a still, which is
 * thumbnail_url. A carousel's media_url is its first image. The caption is
 * cut to its first line for the tile, since the rest is hashtags, and the
 * full permalink is kept so a tap opens the actual post rather than the
 * profile. */
function parseMedia(body) {
  const out = [];
  for (const m of (body && body.data) || []) {
    if (!m || !m.id) continue;
    const image = m.media_type === "VIDEO" ? (m.thumbnail_url || m.media_url) : m.media_url;
    if (!image) continue;
    const caption = String(m.caption || "").trim();
    out.push({
      id: String(m.id),
      type: String(m.media_type || ""),
      image,
      caption,
      title: firstLine(caption),
      url: m.permalink || "",
      published: m.timestamp || ""
    });
    if (out.length >= MAX) break;
  }
  return out;
}

function firstLine(caption) {
  const line = caption.split(/\r?\n/).map((s) => s.trim()).find((s) => s && !/^#/.test(s)) || "";
  return line.replace(/\s*#\w+/g, "").trim().slice(0, 110);
}

function graphError(body) {
  const e = body && body.error;
  return e ? (e.message || e.type || "unknown") : "unknown";
}

module.exports.parseMedia = parseMedia;
module.exports.pickInstagram = pickInstagram;
module.exports.firstLine = firstLine;
