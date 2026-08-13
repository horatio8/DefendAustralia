// GET /api/nightly-rollup — rebuild the numbers, once a day.
//
// Three jobs in one pass: the referral rollup, the A/B daily rows, and a full
// signature recount.
//
// The recount exists because the counter is event-driven and Airtable has no
// atomic increment, so drift is expected rather than exceptional. Reconciling
// once a night against Campaign Nucleus, which is the system of record, means
// the drift never accumulates past a day.
//
// Everything is rebuilt rather than incremented. A rollup that adds to
// yesterday's number goes wrong the first time a run is missed or repeated,
// and by then there is no way to tell which day it started.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const nucleus = require("./_lib/nucleus");
const { rollupDay, allRows } = require("./_lib/ab");

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;
  if (!h.requireCron(req, res)) return;
  if (!at.configured()) return res.status(503).json({ error: "airtable not configured" });

  const out = {};
  const started = Date.now();

  // Yesterday and today: the cron runs in the evening local time, so both days
  // are partly in play depending on the timezone the reader is in.
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  try { out.ab_today = await rollupDay(today); }
  catch (err) { console.error("ROLLUP_AB_TODAY_FAIL", err.message); out.ab_today = { error: err.message }; }

  try { out.ab_yesterday = await rollupDay(yesterday); }
  catch (err) { console.error("ROLLUP_AB_YDAY_FAIL", err.message); out.ab_yesterday = { error: err.message }; }

  try { out.referrals = await referralRollup(); }
  catch (err) { console.error("ROLLUP_REFERRAL_FAIL", err.message); out.referrals = { error: err.message }; }

  try { out.signatures = await recount(); }
  catch (err) { console.error("ROLLUP_RECOUNT_FAIL", err.message); out.signatures = { error: err.message }; }

  out.ms = Date.now() - started;
  await at.setStat("nightly_rollup_last_run", out.ms, at.nowIso()).catch(() => {});
  return res.status(200).json({ ok: true, ...out });
};

/* Per code: shares issued, clicks, signups, gifts, dollars. Built from Events
 * and Donations, which are the append-only record, so the rollup can be thrown
 * away and rebuilt at any time. */
async function referralRollup() {
  const codes = new Map();
  const get = (code) => {
    const c = String(code || "").toUpperCase();
    if (!c) return null;
    if (!codes.has(c)) codes.set(c, { code: c, shares: 0, clicks: 0, signups: 0, donations: 0, dollars: 0 });
    return codes.get(c);
  };

  const events = await allRows(at.T.events,
    "OR({event_type}='Share Issued',{event_type}='Share Click')", 10000);
  for (const e of events) {
    const b = get(e.fields.referral_code_used);
    if (!b) continue;
    if (e.fields.event_type === "Share Issued") b.shares++;
    else b.clicks++;
  }

  // Signups are counted from referred_by on the contact rather than from the
  // event, because referred_by is first-touch and set once. Counting the event
  // would credit the last sharer for every revisit.
  const referred = await allRows(at.T.contacts, "{referred_by}!=''", 20000);
  const byContactId = new Map();
  for (const c of referred) {
    const b = get(c.fields.referred_by);
    if (!b) continue;
    b.signups++;
    if (c.fields.email) byContactId.set(at.normEmail(c.fields.email), b);
  }

  const gifts = await allRows(at.T.donations, "{email}!=''", 20000);
  for (const g of gifts) {
    const b = byContactId.get(at.normEmail(g.fields.email));
    if (!b) continue;
    b.donations++;
    b.dollars += Number(g.fields.amount || 0);
  }

  // Owner names, so the leaderboard reads as people rather than codes.
  const owners = await allRows(at.T.contacts, "{referral_code}!=''", 20000);
  const ownerBy = new Map();
  for (const o of owners) ownerBy.set(String(o.fields.referral_code || "").toUpperCase(), o.fields);

  let written = 0;
  for (const b of codes.values()) {
    // A code with nothing against it is not a row. The leaderboard would
    // otherwise be thousands of zeroes with the real entries buried in them.
    if (!b.shares && !b.clicks && !b.signups && !b.donations) continue;
    const o = ownerBy.get(b.code) || {};
    const fields = {
      code: b.code,
      owner_name: [o.first_name, o.last_name].filter(Boolean).join(" "),
      owner_email: o.email || "",
      shares_issued: b.shares, clicks: b.clicks, signups: b.signups,
      donations: b.donations, dollars: Number(b.dollars.toFixed(2)),
      updated_at: at.nowIso()
    };
    try {
      const existing = await at.findOne(at.T.referralRollup, "{code}='" + at.esc(b.code) + "'");
      if (existing) await at.update(at.T.referralRollup, existing.id, fields);
      else await at.create(at.T.referralRollup, fields);
      written++;
    } catch (err) { console.error("REFERRAL_ROW_FAIL", b.code, err.message); }
  }
  return { codes: codes.size, written };
}

/* Reconcile the cached count against Nucleus, which is the system of record,
 * and fire the milestone hook when a goal step is crossed. */
async function recount() {
  if (!nucleus.configured()) return { skipped: "nucleus not configured" };
  const count = await nucleus.entryCount("petition");
  const prev = await at.getStat("signature_count").catch(() => null);
  const before = prev ? Number(prev.num || 0) : 0;

  await at.setStat("signature_count", count, at.nowIso());

  const step = Number(process.env.SIGNATURE_GOAL_STEP || 15000);
  const crossed = Math.floor(count / step) > Math.floor(before / step);
  if (crossed) {
    const milestone = Math.floor(count / step) * step;
    console.log("SIGNATURE_MILESTONE", milestone, "count", count);
    await at.logEvent({
      event_type: "Milestone", source_channel: "Rollup",
      dedup_key: "milestone:" + milestone,
      payload: { milestone, count, previous: before }
    }).catch(() => {});
  }
  return { count, previous: before, milestone: crossed };
}
