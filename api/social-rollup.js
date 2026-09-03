// GET /api/social-rollup — one row a day per platform, rebuilt from source.
//
// Rebuilt, never incremented. A rollup that adds to yesterday's number drifts
// the moment a run is missed or repeated, and by the time anybody notices the
// drift there is no way to tell which day it started or how far back to
// correct. Recomputing costs one walk of a small window and is always right.
//
// ?days=N sets how far back to rebuild (default 3, so a missed night and the
// scoring that lands after midnight are both picked up).

const h = require("./_lib/http");
const at = require("./_lib/airtable");

const TOP_TOPICS = 6;

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;
  if (!h.requireCron(req, res)) return;
  const days = Math.min(120, Math.max(1, Number((req.query || {}).days) || 3));
  return res.status(200).json(await run(days));
};

async function run(days) {
  const out = { days, rows: 0 };
  if (!at.configured()) return { ...out, error: "airtable not configured" };
  if (!(await at.hasTable(at.T.socialMessages))) return { ...out, error: "the Social Messages table does not exist" };

  const since = new Date(Date.now() - days * 86400000).toISOString();
  const buckets = new Map();

  const walked = await at.walk(at.T.socialMessages, {
    pageSize: 100,
    filterByFormula: "IS_AFTER({received_at},'" + since + "')",
    fields: ["received_at", "kind", "platform", "identity_key", "sentiment_label",
      "sentiment_score", "stance", "topic", "escalation_flags"],
    deadline: Date.now() + 30000
  }, (r) => {
    const f = r.fields || {};
    if (!f.received_at) return;
    const date = String(f.received_at).slice(0, 10);
    const platform = f.platform || "unknown";
    const key = date + "|" + platform;
    const b = buckets.get(key) || {
      row_key: key, date, platform,
      comments: 0, dms: 0, positive: 0, neutral: 0, negative: 0,
      supporters: 0, opponents: 0, flagged: 0,
      _people: new Set(), _scores: [], _topics: {}
    };

    const kind = pick(f.kind);
    if (kind === "Comment") b.comments++;
    else if (kind === "Direct message") b.dms++;

    if (f.identity_key) b._people.add(f.identity_key);

    const sentiment = pick(f.sentiment_label);
    if (sentiment === "Positive") b.positive++;
    else if (sentiment === "Neutral") b.neutral++;
    else if (sentiment === "Negative") b.negative++;
    if (typeof f.sentiment_score === "number") b._scores.push(f.sentiment_score);

    const stance = pick(f.stance);
    if (stance === "Supporter") b.supporters++;
    else if (stance === "Opponent") b.opponents++;

    if ((f.escalation_flags || []).length) b.flagged++;

    const topic = String(f.topic || "").trim().toLowerCase();
    // "general" is the model's answer for "no clear subject", so promoting it
    // into a top-topics list would put it first every single day and push out
    // the topics somebody could act on.
    if (topic && topic !== "general") b._topics[topic] = (b._topics[topic] || 0) + 1;

    buckets.set(key, b);
  });

  const now = at.nowIso();
  const rows = Array.from(buckets.values()).map((b) => ({
    row_key: b.row_key, date: b.date, platform: b.platform,
    comments: b.comments, dms: b.dms, people: b._people.size,
    positive: b.positive, neutral: b.neutral, negative: b.negative,
    avg_sentiment: b._scores.length
      ? Math.round((b._scores.reduce((s, n) => s + n, 0) / b._scores.length) * 100) / 100
      : null,
    supporters: b.supporters, opponents: b.opponents, flagged: b.flagged,
    top_topics: Object.keys(b._topics)
      .sort((x, y) => b._topics[y] - b._topics[x])
      .slice(0, TOP_TOPICS)
      .map((t) => t + " (" + b._topics[t] + ")")
      .join(", "),
    updated_at: now
  }));

  if (rows.length && (await at.hasTable(at.T.socialDaily))) {
    await at.upsertBy(at.T.socialDaily, rows, ["row_key"]);
    out.rows = rows.length;
  }
  out.complete = walked.done;
  out.messages_read = walked.seen;
  return out;
}

const pick = (v) => (v && v.name) || (typeof v === "string" ? v : "") || "";

module.exports.run = run;
