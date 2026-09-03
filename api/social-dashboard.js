// GET /api/social-dashboard — what people are saying, and who needs an answer.
//
// The top of this page is the part that matters: messages carrying an
// escalation flag, unhandled, oldest first. A threat, a lawyer's letter, a
// press enquiry or somebody asking how to donate — each of those has a cost
// per hour it sits unread, and none of them is visible in a volume chart.
//
// Under it, the trend: how many people are talking, in what tone, about what.
// People rather than messages, because one furious person posting forty times
// is one person, and a chart that counts messages calls that a crisis.
//
// ?days=N sets the window (default 14). ?json=1 for raw figures.

const h = require("./_lib/http");
const at = require("./_lib/airtable");

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET")) return;
  if (!h.requireBasicAuth(req, res)) return;
  if (!at.configured()) return res.status(503).json({ error: "airtable not configured" });

  const q = req.query || {};
  const days = Math.min(120, Math.max(1, Number(q.days) || 14));
  const data = await gather(days);

  if (String(q.json || "") === "1") return res.status(200).json(data);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(html(data, days));
};

async function gather(days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const out = { needs_reply: [], daily: [], totals: null, unscored: 0, configured: true };

  if (!(await at.hasTable(at.T.socialMessages))) {
    return { ...out, configured: false, why: "The Social Messages table does not exist in this base." };
  }

  // Anything flagged and not yet dealt with, oldest first — the ones that
  // have been waiting longest are the ones that have cost the most.
  await at.walk(at.T.socialMessages, {
    pageSize: 100,
    filterByFormula: "AND({handled}=0,{escalation_flags}!='')",
    fields: ["received_at", "platform", "kind", "author_name", "text", "escalation_flags", "stance", "topic"],
    sort: [{ field: "received_at", direction: "asc" }],
    maxRecords: 40,
    deadline: Date.now() + 10000
  }, (r) => out.needs_reply.push({
    at: r.fields.received_at,
    platform: r.fields.platform,
    kind: pick(r.fields.kind),
    who: r.fields.author_name || "unknown",
    text: String(r.fields.text || "").slice(0, 400),
    flags: r.fields.escalation_flags || [],
    stance: pick(r.fields.stance),
    topic: r.fields.topic || "",
    waiting_hours: r.fields.received_at
      ? Math.round((Date.now() - Date.parse(r.fields.received_at)) / 3600000)
      : null
  }));

  // How much is waiting to be scored. A dashboard reading a half-analysed
  // table without saying so is a dashboard that under-reports every count.
  await at.walk(at.T.socialMessages, {
    pageSize: 100, fields: [],
    filterByFormula: "AND({analysed_at}=BLANK(),{text}!='')",
    maxRecords: 1000,
    deadline: Date.now() + 6000
  }, () => { out.unscored++; });

  if (await at.hasTable(at.T.socialDaily)) {
    const byDate = new Map();
    await at.walk(at.T.socialDaily, {
      pageSize: 100,
      filterByFormula: "NOT(IS_BEFORE({date},'" + since.slice(0, 10) + "'))",
      deadline: Date.now() + 10000
    }, (r) => {
      const f = r.fields || {};
      const d = byDate.get(f.date) || {
        date: f.date, comments: 0, dms: 0, people: 0,
        positive: 0, neutral: 0, negative: 0, supporters: 0, opponents: 0, flagged: 0,
        topics: [], scores: []
      };
      d.comments += f.comments || 0;
      d.dms += f.dms || 0;
      // Summed across platforms, which slightly over-counts anybody active on
      // two. Deduplicating would need the identity list per day; the error is
      // small and the alternative is a much more expensive rollup.
      d.people += f.people || 0;
      d.positive += f.positive || 0;
      d.neutral += f.neutral || 0;
      d.negative += f.negative || 0;
      d.supporters += f.supporters || 0;
      d.opponents += f.opponents || 0;
      d.flagged += f.flagged || 0;
      if (typeof f.avg_sentiment === "number") d.scores.push(f.avg_sentiment);
      if (f.top_topics) d.topics.push(f.top_topics);
      byDate.set(f.date, d);
    });
    out.daily = Array.from(byDate.values())
      .map((d) => ({
        ...d,
        avg_sentiment: d.scores.length
          ? Math.round((d.scores.reduce((s, n) => s + n, 0) / d.scores.length) * 100) / 100
          : null
      }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    out.totals = out.daily.reduce((t, d) => ({
      comments: t.comments + d.comments, dms: t.dms + d.dms, people: t.people + d.people,
      positive: t.positive + d.positive, negative: t.negative + d.negative,
      supporters: t.supporters + d.supporters, opponents: t.opponents + d.opponents,
      flagged: t.flagged + d.flagged
    }), { comments: 0, dms: 0, people: 0, positive: 0, negative: 0, supporters: 0, opponents: 0, flagged: 0 });
  }

  return out;
}

const pick = (v) => (v && v.name) || (typeof v === "string" ? v : "") || "";
const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function html(d, days) {
  if (!d.configured) {
    return "<!doctype html><meta charset=utf-8><title>Social listening</title>" +
      "<body style='font:15px/1.6 system-ui;margin:40px'><h1>Social listening</h1><p>" + esc(d.why) + "</p>";
  }
  const t = d.totals || { comments: 0, dms: 0, people: 0, positive: 0, negative: 0, supporters: 0, opponents: 0, flagged: 0 };
  const cards = [
    ["People heard from", String(t.people)],
    ["Comments", String(t.comments)],
    ["Direct messages", String(t.dms)],
    ["Positive vs negative", t.positive + " / " + t.negative],
    ["Supporters vs opponents", t.supporters + " / " + t.opponents]
  ];

  return "<!doctype html><meta charset=utf-8><title>Social listening</title>" +
    "<meta name=robots content=noindex><meta name=viewport content='width=device-width,initial-scale=1'>" +
    "<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f6f6f4;color:#111}" +
    "header{padding:28px 24px 8px;max-width:980px;margin:0 auto}h1{font-size:20px;margin:0 0 6px}" +
    "h2{font-size:15px;margin:30px 0 4px}main{padding:12px 24px 48px;max-width:980px;margin:0 auto}" +
    ".note{color:#555;margin:0 0 10px;max-width:70ch;font-size:13px}" +
    ".warn{color:#8a4b00;background:#fff5e6;border:1px solid #f0dcc0;padding:8px 10px;font-size:13px;margin:0 0 10px}" +
    ".cards{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0 4px}" +
    ".card{background:#fff;border:1px solid #e3e3df;padding:12px 14px;min-width:150px;flex:1}" +
    ".card b{display:block;font-size:22px;font-variant-numeric:tabular-nums}" +
    ".card span{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#666}" +
    "table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e3e3df}" +
    "th,td{padding:9px 12px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}" +
    "th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#666}" +
    ".n{text-align:right;font-variant-numeric:tabular-nums}tr:last-child td{border-bottom:0}" +
    ".flag{display:inline-block;background:#fde8e8;color:#8a1a1a;font-size:11px;padding:1px 6px;margin-right:4px}" +
    ".msg{color:#333;font-size:13px;margin-top:4px}.who{font-weight:600}" +
    ".age{color:#8a1a1a;font-size:12px}.topics{color:#666;font-size:12px}</style>" +
    "<header><h1>Social listening, last " + days + " days</h1>" +
    "<p class=note>People rather than messages: one furious person posting forty times is one " +
    "person, and counting messages would call that a crisis. Labels are deliberately " +
    "conservative — the model answers Unclear rather than guessing — so the flagged list " +
    "below stays short enough to actually read.</p>" +
    (d.unscored ? '<p class="warn">' + d.unscored + " message" + (d.unscored > 1 ? "s are" : " is") +
      " waiting to be scored, so the counts below are behind. /api/social-analyse clears the backlog.</p>" : "") +
    "</header><main>" +
    '<div class=cards>' + cards.map(([k, v]) =>
      '<div class=card><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join("") + "</div>" +
    "<h2>Needs an answer</h2>" +
    (d.needs_reply.length
      ? "<p class=note>Flagged and not yet marked handled, oldest first. Tick <b>handled</b> in Airtable to clear one.</p><table>" +
        "<tr><th>Waiting</th><th>Who</th><th>Message</th></tr>" +
        d.needs_reply.map((m) =>
          "<tr><td class=age>" + (m.waiting_hours == null ? "—" : m.waiting_hours + "h") +
          "<div class=topics>" + esc(m.platform) + "</div></td>" +
          "<td><span class=who>" + esc(m.who) + "</span><div class=topics>" + esc(m.stance) + "</div></td>" +
          "<td>" + m.flags.map((f) => '<span class=flag>' + esc(f) + "</span>").join("") +
          "<div class=msg>" + esc(m.text) + "</div></td></tr>").join("") + "</table>"
      : "<p class=note>Nothing is flagged and waiting. Flags are only set when unmistakable, so an empty list here is the normal state, not a broken pipeline.</p>") +
    "<h2>By day</h2>" +
    (d.daily.length
      ? "<table><tr><th>Date</th><th class=n>People</th><th class=n>Comments</th><th class=n>DMs</th>" +
        "<th class=n>Positive</th><th class=n>Negative</th><th class=n>Tone</th><th>Topics</th></tr>" +
        d.daily.map((r) =>
          "<tr><td>" + esc(r.date) + "</td><td class=n>" + r.people + "</td>" +
          "<td class=n>" + r.comments + "</td><td class=n>" + r.dms + "</td>" +
          "<td class=n>" + r.positive + "</td><td class=n>" + r.negative + "</td>" +
          "<td class=n>" + (r.avg_sentiment == null ? "—" : r.avg_sentiment) + "</td>" +
          "<td class=topics>" + esc(r.topics.join("; ")) + "</td></tr>").join("") + "</table>"
      : "<p class=note>No daily rows yet. /api/social-rollup builds them from the messages each night.</p>") +
    "</main>";
}

module.exports.gather = gather;
