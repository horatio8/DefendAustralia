// GET /api/link-report — how many people followed a link in a text.
//
// The clicks have been recorded since the tracked links went in, but nowhere
// that answers the question. /api/ab-report aggregates the nightly rollup by
// test and variant, which is right for the lapse chases and useless for the
// welcome text: that one is deliberately not split, so it has no variant and
// never appears in that table at all.
//
// This counts the raw Link Click events by slug, and puts the sends beside
// them so the number means something. A click count on its own is a number
// nobody can act on: 300 clicks is excellent from 800 sends and dismal from
// 40,000.
//
// Bots were already filtered at the redirect: iMessage, WhatsApp, Slack and
// the rest fetch a URL the moment it appears in a message, and counting those
// roughly doubles the figure. Nothing here needs to filter again.
//
// HTML by default so it can be read in a meeting, ?json=1 for anything that
// consumes it, ?days=N to change the window.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const { LINKS } = require("./track-redirect");

const PAGE = 100;
const MAX_PAGES = 40;

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET")) return;
  if (!h.requireBasicAuth(req, res)) return;
  if (!at.configured()) return res.status(503).json({ error: "airtable not configured" });

  const days = Math.min(365, Math.max(1, Number((req.query && req.query.days) || 30)));
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const rows = {};
  for (const key of Object.keys(LINKS)) {
    rows[key] = { link: key, destination: LINKS[key].path, campaign: LINKS[key].campaign, clicks: 0, people: 0, sends: 0 };
  }

  try {
    // Clicks. The slug lives in the event payload, which is text, so the
    // counting is done here rather than in a formula per slug: one read of
    // the window beats one query per link and stays inside Airtable's rate
    // limit when a fifth link is added later.
    const seen = {};
    await eachPage(at.T.events,
      "AND({event_type}='Link Click',IS_AFTER({timestamp},'" + since + "'))",
      (r) => {
        const p = parsePayload(r.fields.payload);
        const key = String((p && p.link) || "").toLowerCase();
        if (!rows[key]) return;
        rows[key].clicks++;
        // A person who taps the link, closes the page and taps again is one
        // supporter, not two. Counted separately rather than instead, since
        // total taps is the right denominator for cost and unique people is
        // the right one for reach.
        const who = r.fields.contact_id || r.fields.referral_code_used || "";
        if (who) {
          seen[key] = seen[key] || new Set();
          if (!seen[key].has(who)) { seen[key].add(who); rows[key].people++; }
        }
      });

    // Sends, so a click count has a denominator.
    await eachPage(at.T.smsSends,
      "AND({status}='Sent',IS_AFTER({created_at},'" + since + "'))",
      (r) => {
        const t = templateToLink(String(r.fields.template || ""));
        if (rows[t]) rows[t].sends++;
      });
  } catch (err) {
    console.error("LINK_REPORT_FAIL", err.message);
    return res.status(502).json({ error: "could not read the events" });
  }

  const out = Object.values(rows).map((r) => ({
    ...r,
    click_rate: r.sends ? Number(((r.clicks / r.sends) * 100).toFixed(2)) : null
  })).sort((a, b) => b.clicks - a.clicks);

  const totals = out.reduce((a, r) => ({ clicks: a.clicks + r.clicks, sends: a.sends + r.sends }), { clicks: 0, sends: 0 });

  if ((req.query || {}).json === "1") {
    return res.status(200).json({ days, since, totals, links: out });
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(html(out, totals, days));
};

/* Which text a link belongs to. The welcome text is the one this was built
 * for, so its template maps to its own slug; the lapse chases share the two
 * older links. An unmapped template contributes no sends rather than being
 * silently attributed to whichever link sorts first. */
function templateToLink(template) {
  if (template === "petition_welcome") return "give";
  if (template === "lapse_donation") return "fund";
  if (template === "lapse_petition") return "fight";
  return "";
}

function parsePayload(v) {
  if (!v) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}

async function eachPage(table, formula, fn) {
  let offset = "";
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await at.call("GET", table,
      "filterByFormula=" + encodeURIComponent(formula) +
      "&pageSize=" + PAGE + (offset ? "&offset=" + encodeURIComponent(offset) : ""));
    for (const r of (res && res.records) || []) fn(r);
    offset = (res && res.offset) || "";
    if (!offset) return;
  }
}

function html(rows, totals, days) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  return "<!doctype html><meta charset=utf-8><title>Link clicks</title>" +
    "<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f6f6f4;color:#111}" +
    "header{padding:28px 24px 8px;max-width:860px;margin:0 auto}h1{font-size:20px;margin:0 0 6px}" +
    "p{color:#555;margin:0;max-width:60ch}main{padding:12px 24px 48px;max-width:860px;margin:0 auto}" +
    "table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e3e3df}" +
    "th,td{padding:10px 12px;border-bottom:1px solid #eee;text-align:left}" +
    "th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#666}" +
    ".n{text-align:right;font-variant-numeric:tabular-nums}.s{color:#888;font-size:12px;margin-left:6px}" +
    "tr:last-child td{border-bottom:0}</style>" +
    "<header><h1>Link clicks, last " + days + " days</h1>" +
    "<p>Taps on a tracked link in a text message. Bots are already excluded at the redirect: " +
    "iMessage, WhatsApp and Slack all fetch a link the moment it appears in a message, and counting " +
    "those roughly doubles the number. <b>give</b> is the welcome text sent the moment somebody signs. " +
    "Add ?json=1 for raw data, ?days=N to change the window.</p></header><main><table>" +
    "<tr><th>Link</th><th>Goes to</th><th class=n>Sends</th><th class=n>Clicks</th><th class=n>People</th></tr>" +
    rows.map((r) =>
      "<tr><td><b>/" + esc(r.link) + "</b><span class=s>" + esc(r.campaign) + "</span></td>" +
      "<td>" + esc(r.destination) + "</td>" +
      "<td class=n>" + (r.sends || "—") + "</td>" +
      "<td class=n>" + r.clicks + (r.click_rate != null ? "<span class=s>" + r.click_rate + "%</span>" : "") + "</td>" +
      "<td class=n>" + (r.people || "—") + "</td></tr>").join("") +
    "<tr><td colspan=2><b>Total</b></td><td class=n><b>" + (totals.sends || "—") + "</b></td>" +
    "<td class=n><b>" + totals.clicks + "</b></td><td class=n></td></tr>" +
    "</table></main>";
}
