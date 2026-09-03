// GET /api/ad-insights — what the ads cost, and which one is burning money.
//
// Runs every half hour. Three things happen, in order:
//
//   1. Per-ad spend is pulled from Meta for yesterday and today as daily
//      rows, and for today again broken down by hour.
//   2. Our own signature count per ad per day is counted from the Petition
//      Signatures table — not Meta's lead count. Meta counts a lead when the
//      form is submitted inside Facebook; we count one when the person
//      actually lands in the CRM, and the gap between those two numbers is
//      the thing a campaign needs to see.
//   3. An ad whose recent spend has cleared the floor with a cost per
//      signature above the threshold produces one alert per ad per day.
//
// Nothing here pauses an ad. A cron that switches off spend on a metric it
// computed itself will eventually switch off the campaign's best performer
// during an hour when the CRM write queue was backed up. It reports; a human
// decides.

const h = require("./_lib/http");
const at = require("./_lib/airtable");
const econ = require("./_lib/econ");
const sms = require("./_lib/sms");

// Meta's own count of a form completion, whatever it chose to call it.
const LEAD_ACTION = /lead|complete_registration/;

const INSIGHT_FIELDS =
  "ad_id,ad_name,adset_id,campaign_id,campaign_name,spend,impressions,clicks,actions";

const num = (v) => Number(v || 0) || 0;

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;
  if (!h.requireCron(req, res)) return;
  return res.status(200).json(await run());
};

async function run() {
  const out = { daily_rows: 0, hourly_rows: 0, alerts: 0 };
  if (!at.configured()) return { ...out, error: "airtable not configured" };
  if (!econ.configured()) return { ...out, error: "meta ad account not configured" };
  if (!(await at.hasTable(at.T.adPerformance))) {
    return { ...out, error: "the Ad Performance table does not exist in this base" };
  }

  const today = econ.localDate(0);
  const yesterday = econ.localDate(-1);
  const cfg = await econ.settings(at);
  const now = at.nowIso();

  // Our signatures per ad per day, over the same window as the spend.
  const signups = await signupCounts(yesterday);

  // ---- Daily rows ----
  const daily = await econ.graph(econ.adAccountId() + "/insights", {
    level: "ad",
    fields: INSIGHT_FIELDS,
    time_range: JSON.stringify({ since: yesterday, until: today }),
    time_increment: 1,
    limit: 200
  });

  const dailyRows = (daily.data || []).map((i) => {
    const base = shape(i);
    const date = i.date_start;
    const n = signups[date + "|" + base.ad_id] || 0;
    const row = {
      perf_id: date + "|day|" + base.ad_id,
      date, ...base, signups: n, updated_at: now
    };
    // A cost per signature only exists once there is a signature. Writing
    // zero there would make an ad that has produced nothing look free.
    if (n > 0) row.cpa = round2(base.spend / n);
    return row;
  });
  if (dailyRows.length) await at.upsertBy(at.T.adPerformance, dailyRows, ["perf_id"]);
  out.daily_rows = dailyRows.length;

  // ---- Hourly rows, today only ----
  const hourly = await econ.graph(econ.adAccountId() + "/insights", {
    level: "ad",
    fields: INSIGHT_FIELDS,
    breakdowns: "hourly_stats_aggregated_by_advertiser_time_zone",
    time_range: JSON.stringify({ since: today, until: today }),
    limit: 500
  });

  const hourlyRows = [];
  const byAd = {};
  for (const i of hourly.data || []) {
    const base = shape(i);
    const hour = parseInt(String(i.hourly_stats_aggregated_by_advertiser_time_zone || "").slice(0, 2), 10);
    if (Number.isNaN(hour)) continue;
    hourlyRows.push({ perf_id: today + "|" + hour + "|" + base.ad_id, date: today, hour, ...base, updated_at: now });
    (byAd[base.ad_id] = byAd[base.ad_id] || []).push({ hour, spend: base.spend, name: base.ad_name });
  }
  if (hourlyRows.length) await at.upsertBy(at.T.adPerformance, hourlyRows, ["perf_id"]);
  out.hourly_rows = hourlyRows.length;

  // ---- The guardrail ----
  out.alerts = await alerts(byAd, signups, today, cfg);
  return out;
}

function shape(i) {
  const lead = (i.actions || []).find((a) => LEAD_ACTION.test(a.action_type || ""));
  return {
    ad_id: String(i.ad_id || ""),
    ad_name: i.ad_name || "",
    adset_id: String(i.adset_id || ""),
    campaign_id: String(i.campaign_id || ""),
    campaign_name: i.campaign_name || "",
    spend: num(i.spend),
    impressions: num(i.impressions),
    clicks: num(i.clicks),
    meta_leads: num(lead && lead.value)
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

/* Signatures per (advertiser-local date, ad id).
 *
 * The date has to be computed in the advertiser's timezone rather than read
 * off the ISO string, or every signature between midnight and 10am UTC counts
 * against the previous day's spend and both days' CPA is wrong. */
async function signupCounts(sinceDate) {
  const counts = {};
  await at.walk(at.T.signatures, {
    pageSize: 100,
    filterByFormula: "IS_AFTER({timestamp}, '" + sinceDate + "T00:00:00.000Z')",
    fields: ["meta_ad_id", "utm_content", "timestamp"]
  }, (r) => {
    const f = r.fields || {};
    const ad = econ.adIdOf(f);
    if (!ad || !f.timestamp) return;
    const d = econ.localDate(0, Date.parse(f.timestamp));
    counts[d + "|" + ad] = (counts[d + "|" + ad] || 0) + 1;
  });
  return counts;
}

/* One alert per ad per day, recorded whether or not anyone is texted.
 *
 * The record is the point: the dashboard reads these, and a campaign that
 * turns off the SMS number still wants the history. The text is best effort
 * on top, and only inside sending hours — an ad overspending at 3am is worth
 * knowing about at 8am, not worth waking somebody who cannot act until then.
 */
async function alerts(byAd, signups, today, cfg) {
  if (!(await at.hasTable(at.T.syncState))) return 0;
  const hour = econ.localHour();
  const from = hour - cfg.window_hours + 1;
  let sent = 0;

  for (const adId of Object.keys(byAd)) {
    const rows = byAd[adId];
    const windowSpend = rows
      .filter((r) => r.hour >= from && r.hour <= hour)
      .reduce((s, r) => s + r.spend, 0);
    if (windowSpend < cfg.min_spend) continue;

    const n = signups[today + "|" + adId] || 0;
    const daySpend = rows.reduce((s, r) => s + r.spend, 0);
    const cpa = n > 0 ? daySpend / n : Infinity;
    if (cpa <= cfg.cpa_threshold) continue;

    const key = "cpa_alert|" + today + "|" + adId;
    if (await at.findOne(at.T.syncState, "{key}='" + at.esc(key) + "'")) continue;

    const name = String(rows[0].name || adId).slice(0, 40);
    const message = 'Ad too expensive: "' + name + '" spent $' + windowSpend.toFixed(0) +
      " in " + cfg.window_hours + "h, today " +
      (n > 0 ? "$" + cpa.toFixed(2) + " a signature" : "no signatures yet") +
      " (threshold $" + cfg.cpa_threshold + "). Ad id " + adId + ".";

    await at.create(at.T.syncState, { key, value: message, updated_at: at.nowIso() });
    sent++;

    if (cfg.sms_mobile && sms.configured() && !sms.paused() && sms.withinSendingHours()) {
      try {
        await sms.send(h.e164(cfg.sms_mobile), message);
      } catch (err) {
        console.error("CPA_ALERT_SMS_FAIL", err.message);
      }
    }
  }
  return sent;
}

module.exports.run = run;
module.exports.signupCounts = signupCounts;
