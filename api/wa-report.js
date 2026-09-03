// GET /api/wa-report — did /wa1 or /wa2 bring more people to the channel?
//
// Open it in a browser and it prints the scoreboard. That is the whole point:
// a test nobody can check in ten seconds is a test nobody checks, and an
// unchecked test is worse than no test because a decision still gets made
// from it, just later and from memory.
//
// Counts the WhatsApp Click events written by /api/wa-redirect. Preview
// fetchers were never logged in the first place, so every row here is a tap
// by a person.
//
// ?days=N narrows the window (default: everything). ?json=1 for raw numbers.

const h = require("./_lib/http");
const at = require("./_lib/airtable");

const LABELS = {
  A: "/wa1 — first wording",
  B: "/wa2 — second wording"
};

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET")) return;
  if (!h.requireBasicAuth(req, res)) return;
  if (!at.configured()) return res.status(503).json({ error: "airtable not configured" });

  const q = req.query || {};
  const days = Number(q.days || 0) > 0 ? Math.min(365, Number(q.days)) : null;
  const data = await tally(days);

  if (String(q.json || "") === "1") return res.status(200).json(data);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(html(data, days));
};

async function tally(days) {
  const variants = { A: blank(), B: blank() };
  let total = 0;

  const filter = days
    ? "AND({event_type}='WhatsApp Click',IS_AFTER({timestamp},'" +
      new Date(Date.now() - days * 86400000).toISOString() + "'))"
    : "{event_type}='WhatsApp Click'";

  const walked = await at.walk(at.T.events, {
    pageSize: 100,
    filterByFormula: filter,
    fields: ["payload", "timestamp"],
    deadline: Date.now() + 20000
  }, (r) => {
    const p = parse(r.fields.payload);
    const v = variants[p.variant] || variants.A;
    v.clicks++;
    total++;
    bump(v.platforms, String(p.ua || "").split("/")[0] || "other");
    bump(v.apps, String(p.ua || "").split("/")[1] || "browser");
    const day = String(r.fields.timestamp || "").slice(0, 10);
    if (day) bump(v.days, day);
  });

  const rows = Object.keys(variants).map((k) => ({
    variant: k,
    label: LABELS[k],
    clicks: variants[k].clicks,
    share: total > 0 ? Math.round((variants[k].clicks / total) * 100) : 0,
    platforms: variants[k].platforms,
    apps: variants[k].apps,
    days: variants[k].days
  }));

  /* A winner is only named once there is enough to name one. Fifty taps split
   * 28/22 is a coin, and printing "A wins" over it is how a campaign commits
   * to the wrong wording for a month. */
  const [a, b] = rows;
  const lead = Math.abs(a.clicks - b.clicks);
  const verdict = total < 50
    ? "Too early. " + total + " taps so far; wait for a few hundred."
    : lead / total < 0.1
      ? "No clear difference yet — the gap is inside the noise."
      : (a.clicks > b.clicks ? a.label : b.label) + " is ahead by " +
        Math.round((lead / total) * 100) + " points.";

  return { total, rows, verdict, complete: walked.done, window_days: days };
}

const blank = () => ({ clicks: 0, platforms: {}, apps: {}, days: {} });
const bump = (o, k) => { if (k) o[k] = (o[k] || 0) + 1; };

function parse(v) {
  if (!v) return {};
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch (e) { return {}; }
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const breakdown = (o) => Object.keys(o).sort((a, b) => o[b] - o[a])
  .map((k) => esc(k) + " " + o[k]).join(", ") || "—";

function html(d, days) {
  return "<!doctype html><meta charset=utf-8><title>Channel link test</title>" +
    "<meta name=robots content=noindex><meta name=viewport content='width=device-width,initial-scale=1'>" +
    "<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f6f6f4;color:#111}" +
    "header{padding:28px 24px 8px;max-width:820px;margin:0 auto}h1{font-size:20px;margin:0 0 6px}" +
    "p{color:#555;margin:0 0 8px;max-width:64ch;font-size:13px}main{padding:12px 24px 48px;max-width:820px;margin:0 auto}" +
    "table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e3e3df}" +
    "th,td{padding:10px 12px;border-bottom:1px solid #eee;text-align:left}" +
    "th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#666}" +
    ".n{text-align:right;font-variant-numeric:tabular-nums}.s{color:#888;font-size:12px}" +
    ".v{background:#fff;border:1px solid #e3e3df;padding:12px 14px;margin:14px 0;font-size:14px}" +
    "tr:last-child td{border-bottom:0}</style>" +
    "<header><h1>Channel link test" + (days ? ", last " + days + " days" : "") + "</h1>" +
    "<p>Taps on the two tracked ways into the messaging channel. Channel followers are " +
    "anonymous, so this is the only place a join can be attributed to the message that " +
    "caused it. Link previews from Messenger and Instagram are excluded at the redirect: " +
    "they fetch on every send, and counting them would measure sends rather than people. " +
    "Add ?json=1 for raw numbers, ?days=N to narrow the window.</p></header><main>" +
    "<div class=v><b>" + esc(d.verdict) + "</b></div>" +
    (d.complete ? "" : "<p><b>Partial:</b> the read ran out of time, so these are a lower bound.</p>") +
    "<table><tr><th>Link</th><th class=n>Taps</th><th class=n>Share</th><th>Platform</th><th>Opened from</th></tr>" +
    d.rows.map((r) =>
      "<tr><td><b>" + esc(r.label) + "</b></td><td class=n>" + r.clicks + "</td>" +
      "<td class=n>" + r.share + "%</td><td class=s>" + breakdown(r.platforms) + "</td>" +
      "<td class=s>" + breakdown(r.apps) + "</td></tr>").join("") +
    "<tr><td><b>Total</b></td><td class=n><b>" + d.total + "</b></td>" +
    "<td class=n></td><td></td><td></td></tr></table></main>";
}

module.exports.tally = tally;
