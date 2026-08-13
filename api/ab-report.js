// GET /api/ab-report — which variant is actually winning.
//
// Behind basic auth. HTML by default so it can be read in a meeting, ?json=1
// for anything that consumes it, ?days=N to widen the window.
//
// Sorted by revenue per thousand sends and nothing else. Clicks are shown but
// deliberately not used to rank, because a variant that wins on clicks and
// loses on money has cost the campaign the difference, and whichever number
// sits at the top of the table is the one that gets acted on.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const { allRows } = require("./_lib/ab");

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET")) return;
  if (!h.requireBasicAuth(req, res)) return;
  if (!at.configured()) return res.status(503).json({ error: "airtable not configured" });

  const days = Math.min(90, Math.max(1, Number((req.query && req.query.days) || 14)));
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  let rows = [];
  try {
    rows = await allRows(at.T.abDaily, "IS_AFTER({date},'" + from + "')");
  } catch (err) {
    console.error("AB_REPORT_FAIL", err.message);
    return res.status(502).json({ error: "could not read the rollup" });
  }

  // Days are summed per test and variant: a single day is usually too small a
  // sample to read, and reading one anyway is how campaigns talk themselves
  // into the wrong variant.
  const agg = new Map();
  for (const r of rows) {
    const f = r.fields;
    const k = (f.test || "untested") + "|" + (f.variant || "default");
    const a = agg.get(k) || { test: f.test || "untested", variant: f.variant || "default", sends: 0, clicks: 0, gifts: 0, revenue: 0, optouts: 0 };
    a.sends += Number(f.sends || 0);
    a.clicks += Number(f.clicks || 0);
    a.gifts += Number(f.gifts || 0);
    a.revenue += Number(f.revenue || 0);
    a.optouts += Number(f.optouts || 0);
    agg.set(k, a);
  }

  const out = Array.from(agg.values()).map((a) => ({
    ...a,
    revenue: Number(a.revenue.toFixed(2)),
    revenue_per_1k: a.sends ? Number(((a.revenue / a.sends) * 1000).toFixed(2)) : 0,
    click_rate: a.sends ? Number(((a.clicks / a.sends) * 100).toFixed(2)) : 0,
    optout_rate: a.sends ? Number(((a.optouts / a.sends) * 100).toFixed(2)) : 0
  })).sort((x, y) => y.revenue_per_1k - x.revenue_per_1k);

  if ((req.query && req.query.json) === "1" || (req.query && req.query.html) !== "1") {
    if ((req.query && req.query.json) === "1") {
      res.setHeader("Cache-Control", "private, no-store");
      return res.status(200).json({ days, rows: out });
    }
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).send(html(out, days));
};

function html(rows, days) {
  // Each test's best arm is marked, so the answer is readable without doing
  // the comparison by eye.
  const best = new Map();
  for (const r of rows) {
    if (!best.has(r.test) || best.get(r.test).revenue_per_1k < r.revenue_per_1k) best.set(r.test, r);
  }

  const body = rows.length ? rows.map((r) => {
    const win = best.get(r.test) === r && r.sends > 0;
    return "<tr" + (win ? " class=win" : "") + "><td>" + esc(r.test) + "</td><td class=v>" + esc(r.variant) +
      (win ? " <span class=tag>best</span>" : "") + "</td><td class=n>" + r.sends + "</td><td class=n>" +
      r.clicks + "<span class=s>" + r.click_rate + "%</span></td><td class=n>" + r.gifts + "</td><td class=n>$" +
      r.revenue.toFixed(2) + "</td><td class=n><b>$" + r.revenue_per_1k.toFixed(2) + "</b></td><td class=n>" +
      r.optouts + "<span class=s>" + r.optout_rate + "%</span></td></tr>";
  }).join("") : '<tr><td colspan=8 class=empty>No sends in this window.</td></tr>';

  return "<!doctype html><meta charset=utf-8><title>A/B report</title>" +
    "<meta name=robots content=noindex><meta name=viewport content='width=device-width,initial-scale=1'>" +
    "<style>" +
    "body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#FAF6EF;color:#1B1917}" +
    "header{background:#1F3157;color:#FAF6EF;padding:22px 24px}" +
    "h1{margin:0;font-size:21px;font-weight:600}p{margin:6px 0 0;font-size:13px;opacity:.75}" +
    "main{padding:24px;overflow-x:auto}" +
    "table{border-collapse:collapse;width:100%;min-width:760px;background:#fff}" +
    "th{background:#EFE7DA;text-align:left;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5A5248;padding:10px 12px;border-bottom:1px solid #D8CBB4}" +
    "th.n{text-align:right}td{padding:10px 12px;border-bottom:1px solid #EFE7DA}" +
    "td.n{text-align:right;font-variant-numeric:tabular-nums}" +
    "td.v{font-family:ui-monospace,monospace}" +
    "tr.win{background:#F1F5F1}" +
    ".tag{font-size:10px;background:#4A5C4E;color:#fff;padding:2px 6px;letter-spacing:.06em;text-transform:uppercase}" +
    ".s{display:block;font-size:11px;color:#8A7A5E}" +
    ".empty{text-align:center;color:#8A7A5E;padding:36px}" +
    "</style>" +
    "<header><h1>A/B report</h1><p>Last " + days + " days, ranked by revenue per thousand sends. " +
    "Click rate is shown but does not decide the ranking: a variant that wins on clicks and loses on money has cost you the difference. Add ?json=1 for raw data, ?days=N to change the window.</p></header>" +
    "<main><table><tr><th>Test</th><th>Variant</th><th class=n>Sends</th><th class=n>Clicks</th><th class=n>Gifts</th><th class=n>Revenue</th><th class=n>Per 1k</th><th class=n>Opt-outs</th></tr>" +
    body + "</table></main>";
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
