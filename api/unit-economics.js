// GET /api/unit-economics — what a supporter costs and what they are worth.
//
// Nightly, and on demand. Five passes, each of which can stop early:
//
//   A  Acquisition. A contact whose signature carries a Meta ad id gets that
//      id and the day's cost per signature written onto them.
//   B  Channel. Every contact is classified by how they were first recruited,
//      walked oldest-first from a watermark so the historical backfill and
//      the nightly increment are the same code.
//   C  Lifetime value. Donors active in the last three days get their
//      lifetime total recomputed.
//   D  Per-ad revenue and return on spend, derived from the Donations table
//      each run rather than from the cached lifetime field, so a number
//      nobody has backfilled cannot quietly become the source of truth.
//   E  A topline snapshot into Site Stats for the dashboard to read.
//
// ?days=N widens pass A's lookback (default 7; a large value backfills, since
// lead-ad signatures carry their ad id all the way back).
// ?boost=classify spends nearly the whole run on pass B and returns, which is
// how a large historical backfill is driven without waiting a month of
// nightly runs.
//
// Everything here is budgeted against the clock. A serverless function killed
// at its limit gets no chance to write, so a pass that cannot finish stops
// itself and reports partial rather than being cut off mid-write. The one
// rule that must not be broken: a watermark is advanced only by a pass that
// both walked to the end AND checked everything it walked.

const h = require("./_lib/http");
const at = require("./_lib/airtable");
const econ = require("./_lib/econ");

const BUDGET_MS = 280000;
const WATERMARK = "contact_channel_watermark";
const EPOCH = "2000-01-01T00:00:00.000Z";

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;
  if (!h.requireCron(req, res)) return;
  const q = req.query || {};
  return res.status(200).json(await run({
    days: Math.min(Number(q.days || 0) || 7, 1000),
    boost: String(q.boost || "") === "classify"
  }));
};

async function run(opts) {
  const o = opts || {};
  const started = Date.now();
  const at_ms = (fraction) => started + BUDGET_MS * fraction;
  const stats = {
    attributed: 0, already_attributed: 0, classified: 0,
    ltv_updates: 0, ads_rolled: 0, journeys_classified: 0
  };
  if (!at.configured()) return { ...stats, error: "airtable not configured" };

  // The boost run gives pass B almost the whole budget. The nightly run
  // shares it out across all five.
  const cut = o.boost ? [0.45, 0.6, 0.96] : [0.6, 0.65, 0.7];

  /* ---- The spend grid: what each ad cost on each day, and how many
   * signatures it produced. Written by /api/ad-insights. ---- */
  const grid = {};
  const adMeta = {};
  const hasPerf = await at.hasTable(at.T.adPerformance);
  if (hasPerf) {
    await at.walk(at.T.adPerformance, {
      pageSize: 100,
      filterByFormula: "{hour} = BLANK()",
      fields: ["ad_id", "date", "spend", "signups"],
      deadline: at_ms(0.15)
    }, (r) => {
      const f = r.fields || {};
      if (!f.ad_id || !f.date) return;
      grid[f.date + "|" + f.ad_id] = { spend: f.spend || 0, signups: f.signups || 0 };
      if (!adMeta[f.ad_id] || f.date > adMeta[f.ad_id].date) adMeta[f.ad_id] = { date: f.date, id: r.id };
    });
  }

  /* ---- Who is attributed already.
   *
   * One prefetch, reused by pass A as a skip-set and by pass D as the join.
   * This is what lets pass A converge on a backfill without a cursor: each
   * run reads what is done, writes some of what is not, and the next run
   * reads a larger done-set. ---- */
  const acquiredBy = new Map();
  await at.walk(at.T.contacts, {
    pageSize: 100,
    filterByFormula: "{acquisition_ad_id} != ''",
    fields: ["acquisition_ad_id"],
    deadline: at_ms(o.boost ? 0.05 : 0.2)
  }, (r) => acquiredBy.set(r.id, (r.fields || {}).acquisition_ad_id));

  // ---- Pass A: attribute contacts from their signatures ----
  if (!o.boost) {
    const pending = new Map();
    await at.walk(at.T.signatures, {
      pageSize: 100,
      filterByFormula: "AND(IS_AFTER({timestamp}, '" + isoDaysAgo(o.days) +
        "'), OR({meta_ad_id} != '', {utm_content} != ''))",
      fields: ["meta_ad_id", "utm_content", "timestamp", "contact"],
      deadline: at_ms(0.35)
    }, (r) => {
      const f = r.fields || {};
      const ad = econ.adIdOf(f);
      const cid = linkedId(f.contact);
      if (!ad || !cid || !f.timestamp) return;
      if (acquiredBy.has(cid)) { stats.already_attributed++; return; }
      if (pending.has(cid)) return; // the first signature seen wins
      const cell = grid[econ.localDate(0, Date.parse(f.timestamp)) + "|" + ad];
      const cost = cell && cell.signups > 0 ? round2(cell.spend / cell.signups) : undefined;
      pending.set(cid, { ad, cost });
    });

    const items = [];
    for (const [id, u] of pending) {
      items.push({ id, fields: { acquisition_ad_id: u.ad, ...(u.cost === undefined ? {} : { acquisition_cost: u.cost }) } });
    }
    for (let i = 0; i < items.length; i += 10) {
      if (Date.now() > at_ms(0.55)) break;
      const batch = items.slice(i, i + 10);
      await at.updateMany(at.T.contacts, batch);
      for (const b of batch) acquiredBy.set(b.id, b.fields.acquisition_ad_id);
      stats.attributed += batch.length;
    }
    stats.attribution_pending = Math.max(0, items.length - stats.attributed);
  }

  // ---- Pass B: channel classification, resumable from a watermark ----
  const b = await classify(started, at_ms, cut);
  stats.classified = b.written;
  stats.classify_done = b.done;
  if (o.boost) return { ...stats, boost: "classify", walked_to: b.walkedTo };

  /* ---- Every donation, aggregated by contact.
   *
   * Also keeps each donor's earliest gift, because a donor who never signed
   * has no signature to classify from and their first checkout payload is the
   * only evidence of where they came from. ---- */
  const centsByContact = new Map();
  const firstGift = new Map();
  await at.walk(at.T.donations, {
    pageSize: 100,
    fields: ["contact", "amount_cents", "timestamp", "payload"],
    deadline: at_ms(0.8)
  }, (r) => {
    const f = r.fields || {};
    const cid = linkedId(f.contact);
    if (!cid) return;
    centsByContact.set(cid, (centsByContact.get(cid) || 0) + (f.amount_cents || 0));
    const prev = firstGift.get(cid);
    const ts = String(f.timestamp || "");
    if (!prev || ts < prev.ts) firstGift.set(cid, { ts, payload: f.payload });
  });

  // ---- Pass C: refresh lifetime totals for recently active donors ----
  const recent = new Set();
  await at.walk(at.T.donations, {
    pageSize: 100,
    filterByFormula: "IS_AFTER({timestamp}, '" + isoDaysAgo(3) + "')",
    fields: ["contact"],
    deadline: at_ms(0.83)
  }, (r) => {
    const cid = linkedId((r.fields || {}).contact);
    if (cid) recent.add(cid);
  });

  const ltv = Array.from(recent).map((id) => ({
    id, fields: { lifetime_donations: Math.round(centsByContact.get(id) || 0) / 100 }
  }));
  for (let i = 0; i < ltv.length; i += 10) {
    if (Date.now() > at_ms(0.85)) break;
    await at.updateMany(at.T.contacts, ltv.slice(i, i + 10));
    stats.ltv_updates += Math.min(10, ltv.length - i);
  }

  // ---- Pass D: revenue and return per ad ----
  if (hasPerf) {
    const revenueByAd = {};
    for (const [cid, ad] of acquiredBy) {
      const cents = centsByContact.get(cid);
      if (cents) revenueByAd[ad] = (revenueByAd[ad] || 0) + cents;
    }
    const spendByAd = {};
    for (const key of Object.keys(grid)) {
      const ad = key.split("|")[1];
      spendByAd[ad] = (spendByAd[ad] || 0) + (grid[key].spend || 0);
    }
    for (const ad of Object.keys(adMeta)) {
      if (Date.now() > at_ms(0.9)) break;
      const revenue = Math.round(revenueByAd[ad] || 0) / 100;
      const spend = spendByAd[ad] || 0;
      await at.update(at.T.adPerformance, adMeta[ad].id, {
        revenue_attributed: revenue,
        roas: spend > 0 ? round2(revenue / spend) : 0
      });
      stats.ads_rolled++;
    }
  }

  // ---- Revenue by channel and by journey ----
  const money = await attributeRevenue(centsByContact, firstGift, started, at_ms);
  stats.classified += money.written;
  stats.journeys_classified = money.journeys;

  // ---- Pass E: the topline ----
  const today = econ.localDate(0);
  let spendToday = 0, signupsToday = 0;
  for (const key of Object.keys(grid)) {
    if (key.indexOf(today + "|") === 0) {
      spendToday += grid[key].spend;
      signupsToday += grid[key].signups;
    }
  }
  const summary = {
    as_at: at.nowIso(),
    spend_today: round2(spendToday),
    paid_signups_today: signupsToday,
    cpa_today: signupsToday > 0 ? round2(spendToday / signupsToday) : null,
    ads_tracked: Object.keys(adMeta).length,
    attributed_contacts: acquiredBy.size,
    revenue_by_channel: money.byChannel,
    revenue_by_journey: money.byJourney
  };
  await at.setStat("econ_summary", null, JSON.stringify(summary));

  return { ...stats, summary };
}

/* Channel classification.
 *
 * Walks signatures oldest-first from a watermark and classifies each contact
 * from the first signature seen for them. Only blanks are written, so a
 * re-run is a backfill rather than a rewrite, and a hand-corrected channel is
 * never clobbered.
 *
 * Two strategies for finding the blanks, and the reason for the second one is
 * worth keeping: at scale the batched re-read deadlocks. It always re-checks
 * from the same watermark in walk order, so once the head of the queue is
 * classified every run spends its whole check budget re-verifying finished
 * work and writes nothing. The reference build did that for twenty-four runs
 * and wrote 650 rows. Above a few thousand pending, prefetching the entire
 * classified set once and subtracting is the same skip-set pattern that makes
 * pass A converge.
 */
async function classify(started, at_ms, cut) {
  const row = await at.findOne(at.T.syncState, "{key}='" + WATERMARK + "'").catch(() => null);
  const watermark = (row && row.fields && row.fields.value) || EPOCH;

  const pending = new Map();
  let walkedTo = watermark;
  const walked = await at.walk(at.T.signatures, {
    pageSize: 100,
    filterByFormula: "IS_AFTER({timestamp}, '" + watermark + "')",
    fields: ["timestamp", "contact", "meta_ad_id", "utm_content", "utm_campaign", "utm_source", "fbclid", "ref_used"],
    sort: [{ field: "timestamp", direction: "asc" }],
    deadline: at_ms(cut[0])
  }, (r) => {
    const f = r.fields || {};
    if (f.timestamp) walkedTo = f.timestamp;
    const cid = linkedId(f.contact);
    if (!cid || pending.has(cid)) return;
    pending.set(cid, econ.channelOf(f));
  });

  const ids = Array.from(pending.keys());
  const items = [];
  let checkedAll = true;

  if (ids.length > 3000) {
    const done = new Set();
    const prefetch = await at.walk(at.T.contacts, {
      pageSize: 100,
      filterByFormula: "{acquisition_channel} != ''",
      fields: [],
      deadline: at_ms(cut[1])
    }, (r) => done.add(r.id));
    checkedAll = prefetch.done;
    for (const id of ids) if (!done.has(id)) items.push({ id, fields: { acquisition_channel: pending.get(id) } });
  } else {
    for (let i = 0; i < ids.length; i += 50) {
      if (Date.now() > at_ms(cut[1])) { checkedAll = false; break; }
      const slice = ids.slice(i, i + 50);
      const have = await byRecordId(at.T.contacts, slice, ["acquisition_channel"]);
      for (const id of slice) {
        if (!(have.get(id) || {}).acquisition_channel) {
          items.push({ id, fields: { acquisition_channel: pending.get(id) } });
        }
      }
    }
  }

  let written = 0;
  for (let i = 0; i < items.length; i += 10) {
    if (Date.now() > at_ms(cut[2])) break;
    await at.updateMany(at.T.contacts, items.slice(i, i + 10));
    written += Math.min(10, items.length - i);
  }

  /* The watermark moves only when this run drained everything it walked AND
   * checked everything it drained. Without the second half of that condition
   * a run that reached the end of the signatures but ran out of check budget
   * advances past tens of thousands of contacts who are then skipped for
   * good. That happened once, on a live backfill. */
  const drained = walked.done && checkedAll && written >= items.length;
  if (drained && walkedTo > watermark && (await at.hasTable(at.T.syncState))) {
    const fields = { key: WATERMARK, value: walkedTo, updated_at: at.nowIso() };
    if (row) await at.update(at.T.syncState, row.id, fields);
    else await at.create(at.T.syncState, fields);
  }
  return { written, done: drained, walkedTo };
}

/* Every donor's all-time giving, grouped two ways: how the person was
 * recruited, and how their first gift was raised. Donor records are read in
 * batches of fifty, so the cost scales with the number of donors rather than
 * the size of the contact base. */
async function attributeRevenue(centsByContact, firstGift, started, at_ms) {
  const byChannel = {};
  const byJourney = {};
  const writes = new Map();
  const needJourney = [];
  let journeys = 0;

  const tally = (bucket, key, id) => {
    const b = bucket[key] || { donors: 0, total: 0 };
    b.donors++;
    b.total += centsByContact.get(id) || 0;
    bucket[key] = b;
  };

  const donorIds = Array.from(centsByContact.keys());
  for (let i = 0; i < donorIds.length; i += 50) {
    if (Date.now() > at_ms(0.93)) break;
    const slice = donorIds.slice(i, i + 50);
    const rows = await byRecordId(at.T.contacts, slice,
      ["acquisition_channel", "donor_journey", "date_first_seen", "Petition Signatures"]);
    for (const id of slice) {
      const f = rows.get(id) || {};
      let channel = pick(f.acquisition_channel);
      if (!channel) {
        const gift = firstGift.get(id);
        channel = gift ? econ.channelFromDonation(gift.payload) : "Unclassified";
        if (gift) writes.set(id, { ...(writes.get(id) || {}), acquisition_channel: channel });
      }
      tally(byChannel, channel, id);

      const journey = pick(f.donor_journey);
      if (journey) tally(byJourney, journey, id);
      else needJourney.push({
        id,
        sigIds: (f["Petition Signatures"] || []).map((v) => (v && v.id) || v).slice(0, 10),
        firstSeen: f.date_first_seen || null
      });
    }
  }

  // A journey needs the contact's earliest signature time. Fetch the linked
  // rows in batches, then classify.
  const sigTs = new Map();
  const allSigIds = needJourney.reduce((acc, c) => acc.concat(c.sigIds), []);
  for (let i = 0; i < allSigIds.length; i += 50) {
    if (Date.now() > at_ms(0.95)) break;
    const rows = await byRecordId(at.T.signatures, allSigIds.slice(i, i + 50), ["timestamp"]);
    for (const [id, f] of rows) sigTs.set(id, f.timestamp || null);
  }

  for (const c of needJourney) {
    const gift = firstGift.get(c.id);
    if (!gift) { tally(byJourney, "Unclassified", c.id); continue; }
    const earliest = c.sigIds.map((s) => sigTs.get(s)).filter(Boolean).sort()[0] || null;
    // Their signatures exist but were not fetched inside the budget. Guessing
    // now would write a wrong journey permanently; next run has the time.
    if (c.sigIds.length && !earliest) { tally(byJourney, "Unclassified", c.id); continue; }
    const j = econ.journeyOf({
      firstGiftTs: gift.ts,
      firstGiftPayload: gift.payload,
      earliestSigTs: earliest,
      firstSeenTs: c.firstSeen
    });
    writes.set(c.id, { ...(writes.get(c.id) || {}), donor_journey: j });
    journeys++;
    tally(byJourney, j, c.id);
  }

  for (const bucket of [byChannel, byJourney]) {
    for (const k of Object.keys(bucket)) bucket[k].total = Math.round(bucket[k].total) / 100;
  }

  const items = Array.from(writes.entries()).map(([id, fields]) => ({ id, fields }));
  let written = 0;
  for (let i = 0; i < items.length; i += 10) {
    if (Date.now() > at_ms(0.98)) break;
    await at.updateMany(at.T.contacts, items.slice(i, i + 10));
    written += Math.min(10, items.length - i);
  }

  return { byChannel, byJourney, written, journeys };
}

// Airtable has no "where record id in (...)", so it is spelled as an OR of
// RECORD_ID() comparisons. Fifty at a time keeps the formula inside the URL
// length Airtable accepts.
async function byRecordId(table, ids, fields) {
  const out = new Map();
  if (!ids.length) return out;
  const formula = "OR(" + ids.map((id) => "RECORD_ID()='" + at.esc(id) + "'").join(",") + ")";
  const p = await at.page(table, { pageSize: 100, filterByFormula: formula, fields });
  for (const r of p.records) out.set(r.id, r.fields || {});
  return out;
}

// A single-select comes back as an object, a text field as a string.
const pick = (v) => (v && v.name) || (typeof v === "string" ? v : "") || "";
const linkedId = (v) => (Array.isArray(v) && v.length ? (v[0].id || v[0]) : null);
const round2 = (n) => Math.round(n * 100) / 100;
const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

module.exports.run = run;
module.exports.byRecordId = byRecordId;
