// GET /api/leaderboard — who is actually bringing people in.
//
// Internal, behind basic auth, because it is a ranked list of supporters by
// name and email. HTML by default so it can be opened in a browser during a
// campaign meeting, ?json=1 for anything that wants to consume it.
//
// It reads the nightly Referral Rollup rather than recomputing from Events,
// so opening this page during a surge costs one Airtable read rather than
// paginating the whole log.
const h = require("./_lib/http");
const at = require("./_lib/airtable");

const TOP = 100;

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET")) return;
  if (!h.requireBasicAuth(req, res)) return;
  if (!at.configured()) return res.status(503).json({ error: "airtable not configured" });

  let rows = [];
  try {
    const r = await at.call("GET", at.T.referralRollup,
      "maxRecords=" + TOP +
      "&sort%5B0%5D%5Bfield%5D=signups&sort%5B0%5D%5Bdirection%5D=desc");
    rows = ((r && r.records) || []).map((rec) => ({
      code: rec.fields.code || "",
      name: rec.fields.owner_name || "",
      email: rec.fields.owner_email || "",
      shares: Number(rec.fields.shares_issued || 0),
      clicks: Number(rec.fields.clicks || 0),
      signups: Number(rec.fields.signups || 0),
      donations: Number(rec.fields.donations || 0),
      dollars: Number(rec.fields.dollars || 0)
    }));
  } catch (err) {
    console.error("LEADERBOARD_FAIL", err.message);
    return res.status(502).json({ error: "could not read the rollup" });
  }

  const updated = rows.length ? "rebuilt by the nightly rollup" : "not built yet";

  if ((req.query && req.query.json) === "1") {
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({ rows, count: rows.length, updated });
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).send(html(rows, updated));
};

function html(rows, updated) {
  const body = rows.length
    ? rows.map((r, i) => "<tr><td class=n>" + (i + 1) + "</td><td class=c>" + esc(r.code) + "</td><td>" +
        esc(r.name) + "<span class=e>" + esc(r.email) + "</span></td><td class=n>" + r.shares +
        "</td><td class=n>" + r.clicks + "</td><td class=n><b>" + r.signups + "</b></td><td class=n>" +
        r.donations + "</td><td class=n>$" + r.dollars.toFixed(2) + "</td></tr>").join("")
    : '<tr><td colspan=8 class=empty>No rollup rows yet. The nightly job builds this.</td></tr>';

  return "<!doctype html><meta charset=utf-8><title>Referral leaderboard</title>" +
    "<meta name=robots content=noindex><meta name=viewport content='width=device-width,initial-scale=1'>" +
    "<style>" +
    "body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#FAF6EF;color:#1B1917}" +
    "header{background:#1F3157;color:#FAF6EF;padding:22px 24px}" +
    "h1{margin:0;font-size:21px;font-weight:600}" +
    "p{margin:6px 0 0;font-size:13px;opacity:.75}" +
    "main{padding:24px;overflow-x:auto}" +
    "table{border-collapse:collapse;width:100%;min-width:720px;background:#fff}" +
    "th{background:#EFE7DA;text-align:left;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5A5248;padding:10px 12px;border-bottom:1px solid #D8CBB4}" +
    "td{padding:10px 12px;border-bottom:1px solid #EFE7DA;vertical-align:top}" +
    "td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}" +
    "td.c{font-family:ui-monospace,monospace;font-weight:600;color:#9E1B24}" +
    ".e{display:block;font-size:12px;color:#8A7A5E}" +
    ".empty{text-align:center;color:#8A7A5E;padding:36px}" +
    "</style>" +
    "<header><h1>Referral leaderboard</h1><p>" + rows.length + " codes with activity, " + esc(updated) + ". Ranked by signups. Add ?json=1 for the raw data.</p></header>" +
    "<main><table><tr><th class=n>#</th><th>Code</th><th>Supporter</th><th class=n>Shares</th><th class=n>Clicks</th><th class=n>Signups</th><th class=n>Gifts</th><th class=n>Raised</th></tr>" +
    body + "</table></main>";
}

// The rows carry supporter-supplied names. They are rendered into HTML here,
// so they are escaped here.
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
