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

  const channelId = h.clean((req.query && req.query.channelId) || "", 40);
  if (!/^UC[A-Za-z0-9_-]{20,30}$/.test(channelId)) {
    return res.status(400).json({ error: "bad channel id" });
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

async function fromFeed(channelId) {
  const r = await fetch("https://www.youtube.com/feeds/videos.xml?channel_id=" + encodeURIComponent(channelId), {
    headers: { "User-Agent": "DefendSacredGround/1.0" }
  });
  if (!r.ok) throw new Error("feed HTTP " + r.status);
  const xml = await r.text();

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
