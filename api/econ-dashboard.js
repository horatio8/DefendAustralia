// GET /api/econ-dashboard — the two numbers that decide whether this works.
//
// What a supporter costs to acquire, and what a supporter gives back. Every
// other number on this page is one of those two cut a different way.
//
// The topline and the channel splits are read from the snapshot
// /api/unit-economics writes, because recomputing them per page load would
// walk the whole Donations table on every refresh. The per-ad table is read
// live from Ad Performance, which is small and changes every half hour.
//
// ?days=N sets the ad window (default 7). ?json=1 for the raw figures.

const h = require("./_lib/http");
const at = require("./_lib/airtable");
const econ = require("./_lib/econ");

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET")) return;
  if (!h.requireBasicAuth(req, res)) return;
  if (!at.configured()) return res.status(503).json({ error: "airtable not configured" });

  const q = req.query || {};
  const days = Math.min(90, Math.max(1, Number(q.days || 7)));
  const data = await gather(days);

  if (String(q.json || "") === "1") return res.status(200).json(data);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(html(data, days));
};

async function gather(days) {
  const since = econ.localDate(-days);
  const out = { summary: null, ads: [], alerts: [], since, stale: null };

  const stat = await at.getStat("econ_summary");
  if (stat && stat.text) {
    try { out.summary = JSON.parse(stat.text); } catch (e) { /* shown as missing */ }
  }
  // How old the snapshot is matters more than what it says. A dashboard that
  // shows yesterday's cost per supporter as though it were now is worse than
  // one that admits it has not run.
  if (out.summary && out.summary.as_at) {
    out.stale = Math.round((Date.now() - Date.parse(out.summary.as_at)) / 60000);
  }

  if (await at.hasTable(at.T.adPerformance)) {
    const byAd = {};
    await at.walk(at.T.adPerformance, {
      pageSize: 100,
      filterByFormula: "AND({hour} = BLANK(), NOT(IS_BEFORE({date}, '" + since + "')))",
      fields: ["ad_id", "ad_name", "campaign_name", "date", "spend", "signups", "revenue_attributed", "roas"],
      deadline: Date.now() + 15000
    }, (r) => {
      const f = r.fields || {};
      if (!f.ad_id) return;
      const a = byAd[f.ad_id] || (byAd[f.ad_id] = {
        ad_id: f.ad_id, ad_name: f.ad_name || f.ad_id, campaign_name: f.campaign_name || "",
        spend: 0, signups: 0, revenue: 0, roas: 0, last: ""
      });
      a.spend += f.spend || 0;
      a.signups += f.signups || 0;
      // Revenue and return are written onto the ad's most recent daily row as
      // all-time totals, so they are taken from that row rather than summed.
      if (f.date >= a.last) {
        a.last = f.date;
        a.revenue = f.revenue_attributed || 0;
        a.roas = f.roas || 0;
      }
    });
    out.ads = Object.values(byAd)
      .map((a) => ({
        ...a,
        spend: round2(a.spend),
        cpa: a.signups > 0 ? round2(a.spend / a.signups) : null
      }))
      .sort((x, y) => y.spend - x.spend);
  }

  if (await at.hasTable(at.T.syncState)) {
    await at.walk(at.T.syncState, {
      pageSize: 100,
      filterByFormula: "FIND('cpa_alert|', {key}) = 1",
      fields: ["key", "value", "updated_at"],
      sort: [{ field: "updated_at", direction: "desc" }],
      maxRecords: 20,
      deadline: Date.now() + 8000
    }, (r) => out.alerts.push({
      key: r.fields.key, message: r.fields.value, at: r.fields.updated_at
    }));
    out.alerts = out.alerts.slice(0, 20);
  }

  return out;
}

const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => "$" + Number(n || 0).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function bucketRows(bucket, order) {
  const keys = Object.keys(bucket || {});
  keys.sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return keys.map((k) => {
    const v = bucket[k] || { donors: 0, total: 0 };
    return {
      label: k, donors: v.donors, total: v.total,
      per: v.donors > 0 ? round2(v.total / v.donors) : 0
    };
  });
}

function table(title, note, rows) {
  if (!rows.length) return "";
  const total = rows.reduce((s, r) => s + r.total, 0);
  const donors = rows.reduce((s, r) => s + r.donors, 0);
  return "<h2>" + esc(title) + "</h2><p class=note>" + note + "</p><table>" +
    "<tr><th>" + esc(title) + "</th><th class=n>Donors</th><th class=n>Raised</th><th class=n>Per donor</th><th class=n>Share</th></tr>" +
    rows.map((r) =>
      "<tr><td>" + esc(r.label) + "</td><td class=n>" + r.donors + "</td>" +
      "<td class=n>" + money(r.total) + "</td><td class=n>" + money(r.per) + "</td>" +
      "<td class=n>" + (total > 0 ? Math.round((r.total / total) * 100) : 0) + "%</td></tr>").join("") +
    "<tr><td><b>Total</b></td><td class=n><b>" + donors + "</b></td>" +
    "<td class=n><b>" + money(total) + "</b></td><td class=n><b>" +
    money(donors > 0 ? total / donors : 0) + "</b></td><td class=n></td></tr></table>";
}

function html(d, days) {
  const s = d.summary;
  const cards = s ? [
    ["Spent today", money(s.spend_today)],
    ["Signatures from ads", String(s.paid_signups_today || 0)],
    ["Cost each", s.cpa_today == null ? "—" : money(s.cpa_today)],
    ["Ads tracked", String(s.ads_tracked || 0)],
    ["Attributed supporters", String(s.attributed_contacts || 0)]
  ] : [];

  const staleNote = d.stale == null
    ? '<p class="warn">No snapshot yet. Run <code>/api/unit-economics</code> once and this fills in.</p>'
    : d.stale > 1500
      ? '<p class="warn">The snapshot is ' + Math.round(d.stale / 60) + ' hours old. The nightly job may not be running.</p>'
      : '<p class=note>Snapshot taken ' + d.stale + ' minutes ago.</p>';

  return "<!doctype html><meta charset=utf-8><title>Campaign economics</title>" +
    "<meta name=robots content=noindex><meta name=viewport content='width=device-width,initial-scale=1'>" +
    "<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f6f6f4;color:#111}" +
    "header{padding:28px 24px 8px;max-width:960px;margin:0 auto}h1{font-size:20px;margin:0 0 6px}" +
    "h2{font-size:15px;margin:32px 0 4px}main{padding:12px 24px 48px;max-width:960px;margin:0 auto}" +
    ".note{color:#555;margin:0 0 10px;max-width:70ch;font-size:13px}" +
    ".warn{color:#8a4b00;background:#fff5e6;border:1px solid #f0dcc0;padding:8px 10px;border-radius:4px;font-size:13px;margin:0 0 10px}" +
    ".cards{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0 4px}" +
    ".card{background:#fff;border:1px solid #e3e3df;padding:12px 14px;min-width:150px;flex:1}" +
    ".card b{display:block;font-size:22px;font-variant-numeric:tabular-nums}" +
    ".card span{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#666}" +
    "table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e3e3df;margin-bottom:6px}" +
    "th,td{padding:9px 12px;border-bottom:1px solid #eee;text-align:left}" +
    "th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#666}" +
    ".n{text-align:right;font-variant-numeric:tabular-nums}" +
    ".s{color:#888;font-size:12px;display:block}tr:last-child td{border-bottom:0}" +
    "ul{padding-left:18px;margin:0}li{font-size:13px;color:#444;margin:3px 0}</style>" +
    "<header><h1>Campaign economics</h1>" +
    "<p class=note>What a supporter costs, and what a supporter gives back. " +
    "Cost is Meta spend divided by the signatures that reached our own database, " +
    "not the lead count Meta reports — the gap between those is the point. " +
    "Add ?json=1 for raw figures, ?days=N to change the ad window.</p>" +
    staleNote + "</header><main>" +
    (cards.length ? '<div class=cards>' + cards.map(([k, v]) =>
      '<div class=card><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join("") + "</div>" : "") +
    (s ? table("Raised by how we recruited them", "How the person first arrived. A supporter recruited by an ad is credited here forever, whatever raised their later gifts.", bucketRows(s.revenue_by_channel, econ.CHANNELS)) : "") +
    (s ? table("Raised by what asked for the gift", "How the first gift itself was raised. Untagged gifts from existing supporters are counted as email, because the CRM's links carry no tags.", bucketRows(s.revenue_by_journey, econ.JOURNEYS)) : "") +
    "<h2>Ads, last " + days + " days</h2>" +
    (d.ads.length
      ? "<table><tr><th>Ad</th><th class=n>Spend</th><th class=n>Signatures</th><th class=n>Cost each</th><th class=n>Raised</th><th class=n>Return</th></tr>" +
        d.ads.map((a) =>
          "<tr><td>" + esc(a.ad_name) + "<span class=s>" + esc(a.campaign_name) + "</span></td>" +
          "<td class=n>" + money(a.spend) + "</td><td class=n>" + a.signups + "</td>" +
          "<td class=n>" + (a.cpa == null ? "—" : money(a.cpa)) + "</td>" +
          "<td class=n>" + money(a.revenue) + "</td>" +
          "<td class=n>" + (a.roas ? a.roas.toFixed(2) + "×" : "—") + "</td></tr>").join("") +
        "</table>"
      : "<p class=note>No ad spend recorded in this window. <code>/api/ad-insights</code> fills this in every half hour once <code>META_AD_ACCOUNT_ID</code> and an ads token are set.</p>") +
    "<h2>Recent alerts</h2>" +
    (d.alerts.length
      ? "<ul>" + d.alerts.map((a) => "<li>" + esc(a.message) + "</li>").join("") + "</ul>"
      : "<p class=note>Nothing has crossed the threshold. Thresholds live in the Site Stats row <code>econ_settings</code> and can be changed in Airtable without a deploy.</p>") +
    "</main>";
}

module.exports.gather = gather;
