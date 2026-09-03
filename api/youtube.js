// GET /api/youtube?channelId=UC... — the News page video feed.
//
// No API key. YouTube publishes a public RSS feed per channel, which is enough
// for titles, ids and dates and costs nothing. If the feed is unavailable the
// channel page is scraped for video ids and oEmbed fills in the titles, so the
// rail degrades to fewer videos rather than to an empty box.
//
// Edge-cached for ten minutes with a long stale window: a campaign News page
// does not need to be within ten minutes of a new upload, and every cached hit
// is a request YouTube does not rate-limit us for.
const h = require("./_lib/http");

const MAX = 12;
let memo = null; // { key, items, at }
const MEMO_MS = 300000;

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET")) return;

  /* Either a channel id or a handle.
   *
   * The RSS feed only takes a UC… id, but nobody who runs a campaign knows
   * their channel id; they know it is @DefendSacredGround. A handle is
   * resolved by reading the channel page for the feed link it advertises, and
   * the answer is memoised, so the cost is one extra fetch a day rather than
   * one per visitor. Both are accepted so the config can carry whichever a
   * human has to hand. */
  let channelId = h.clean((req.query && req.query.channelId) || "", 40);
  const handle = h.clean((req.query && req.query.handle) || "", 60).replace(/^@/, "");
  if (!/^UC[A-Za-z0-9_-]{20,30}$/.test(channelId)) {
    if (!/^[A-Za-z0-9._-]{3,50}$/.test(handle)) {
      return res.status(400).json({ error: "bad channel id or handle" });
    }
    try {
      channelId = await resolveHandle(handle);
    } catch (err) {
      console.error("YOUTUBE_HANDLE_FAIL", err.message);
      return res.status(502).json({ error: "could not resolve channel handle", items: [] });
    }
  }

  if (memo && memo.key === channelId && Date.now() - memo.at < MEMO_MS) {
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
    return res.status(200).json({ items: memo.items, cached: true });
  }

  let items = [];
  try {
    items = await fromFeed(channelId);
  } catch (err) {
    console.error("YOUTUBE_FEED_FAIL", err.message);
  }

  if (!items.length) {
    try {
      items = await fromScrape(channelId);
    } catch (err) {
      console.error("YOUTUBE_SCRAPE_FAIL", err.message);
    }
  }

  if (!items.length) {
    // Serve the last good answer rather than an empty rail.
    if (memo && memo.key === channelId) {
      return res.status(200).json({ items: memo.items, stale: true });
    }
    return res.status(502).json({ error: "video feed unavailable", items: [] });
  }

  memo = { key: channelId, items, at: Date.now() };
  res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
  return res.status(200).json({ items });
};

/* @handle → UC… id, from the feed link the channel page itself advertises.
 * Memoised per handle: a handle-to-id mapping changes about never. */
const handleMemo = {}; // handle -> { id, at }
const HANDLE_MEMO_MS = 86400000;
async function resolveHandle(handle) {
  const hit = handleMemo[handle];
  if (hit && Date.now() - hit.at < HANDLE_MEMO_MS) return hit.id;
  const r = await fetch("https://www.youtube.com/@" + encodeURIComponent(handle), {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; DefendSacredGround/1.0)", "Accept-Language": "en" }
  });
  if (!r.ok) throw new Error("channel page HTTP " + r.status);
  const id = channelIdFrom(await r.text());
  if (!id) throw new Error("no channel id on page");
  handleMemo[handle] = { id, at: Date.now() };
  return id;
}

function channelIdFrom(html) {
  const m = String(html).match(/feeds\/videos\.xml\?channel_id=(UC[A-Za-z0-9_-]{20,30})/) ||
    String(html).match(/"(?:externalId|channelId)":"(UC[A-Za-z0-9_-]{20,30})"/);
  return m ? m[1] : "";
}

async function fromFeed(channelId) {
  const r = await fetch("https://www.youtube.com/feeds/videos.xml?channel_id=" + encodeURIComponent(channelId), {
    headers: { "User-Agent": "DefendSacredGround/1.0" }
  });
  if (!r.ok) throw new Error("feed HTTP " + r.status);
  return parseFeed(await r.text());
}

function parseFeed(xml) {
  const out = [];
  const entries = xml.split("<entry>").slice(1);
  for (const e of entries.slice(0, MAX)) {
    const id = pick(e, "yt:videoId");
    if (!id) continue;
    out.push({
      id,
      title: decode(pick(e, "title")),
      published: pick(e, "published"),
      url: "https://www.youtube.com/watch?v=" + id,
      embed: "https://www.youtube-nocookie.com/embed/" + id,
      thumb: "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg"
    });
  }
  return out;
}

// Fallback: the channel page carries the same video ids in its bootstrap JSON.
// Titles come from oEmbed, which is a public endpoint and needs no key.
async function fromScrape(channelId) {
  const r = await fetch("https://www.youtube.com/channel/" + encodeURIComponent(channelId) + "/videos", {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; DefendSacredGround/1.0)" }
  });
  if (!r.ok) throw new Error("channel HTTP " + r.status);
  const html = await r.text();

  const ids = [];
  const re = /"videoId":"([A-Za-z0-9_-]{11})"/g;
  let m;
  while ((m = re.exec(html)) && ids.length < MAX) {
    if (ids.indexOf(m[1]) === -1) ids.push(m[1]);
  }
  if (!ids.length) return [];

  const titled = await Promise.all(ids.map(async (id) => {
    let title = "";
    try {
      const o = await fetch("https://www.youtube.com/oembed?format=json&url=" +
        encodeURIComponent("https://www.youtube.com/watch?v=" + id));
      if (o.ok) title = ((await o.json()) || {}).title || "";
    } catch (e) { /* a missing title is survivable; a missing video is not */ }
    return {
      id, title, published: "",
      url: "https://www.youtube.com/watch?v=" + id,
      embed: "https://www.youtube-nocookie.com/embed/" + id,
      thumb: "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg"
    };
  }));
  return titled;
}

function pick(chunk, tag) {
  const m = chunk.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">"));
  return m ? m[1].trim() : "";
}

function decode(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

module.exports.parseFeed = parseFeed;
module.exports.channelIdFrom = channelIdFrom;
