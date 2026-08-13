// A/B tests: variant assignment and the nightly rollup.
//
// Assignment happens at send time, not at read time. A test on SMS copy is a
// test on which message was posted to which person, and that is a fact about
// the send, recorded on the SMS Sends row. Deciding the variant when a page is
// rendered would mean the same supporter could see two variants across two
// visits, which is not a test, it is noise.
//
// The primary metric is revenue per thousand sends. Clicks are reported but
// they do not decide anything: a variant that wins on clicks and loses on
// money has cost the campaign the difference, and campaigns pick the
// click-winner surprisingly often when it is the number at the top of the page.

const crypto = require("crypto");
const at = require("./airtable");

/* Deterministic assignment: the same person in the same test always lands in
 * the same variant. Hashing the identity rather than rolling a die means a
 * resend does not move someone between arms and quietly poison the result. */
function assign(test, identity, variants) {
  const list = variants && variants.length ? variants : ["a", "b"];
  const hash = crypto.createHash("sha256").update(String(test) + "|" + String(identity)).digest();
  return list[hash.readUInt32BE(0) % list.length];
}

/* Rebuild every AB Daily row for one day, from the underlying tables.
 *
 * Rebuilt rather than incremented. A rollup that adds to yesterday's number
 * drifts the moment a run is missed or repeated, and by the time anyone
 * notices the drift there is no way to tell which day it started. */
async function rollupDay(dateIso) {
  const day = dateIso.slice(0, 10);
  const from = day + "T00:00:00.000Z";
  const to = day + "T23:59:59.999Z";

  const sends = await allRows(at.T.smsSends,
    "AND({status}='Sent',IS_AFTER({sent_at},'" + from + "'),IS_BEFORE({sent_at},'" + to + "'))");

  // Nothing was sent, so there is nothing to attribute. Return rather than
  // writing a row of zeroes for every test that has ever run.
  if (!sends.length) return { day, rows: 0 };

  const buckets = new Map();
  const key = (t, v) => t + "|" + v;
  const bucket = (t, v) => {
    const k = key(t, v);
    if (!buckets.has(k)) buckets.set(k, { test: t, variant: v, sends: 0, clicks: 0, gifts: 0, revenue: 0, optouts: 0 });
    return buckets.get(k);
  };

  const phoneToArm = new Map();
  for (const s of sends) {
    const t = s.fields.test || s.fields.template || "untested";
    const v = s.fields.variant || "default";
    bucket(t, v).sends++;
    if (s.fields.phone) phoneToArm.set(String(s.fields.phone), { test: t, variant: v });
  }

  // Clicks carry the variant on the event payload, so they need no join.
  const clicks = await allRows(at.T.events,
    "AND({event_type}='Link Click',IS_AFTER({timestamp},'" + from + "'),IS_BEFORE({timestamp},'" + to + "'))");
  for (const c of clicks) {
    let p = {};
    try { p = JSON.parse(c.fields.payload || "{}"); } catch (e) { /* unparseable payload, skip the join */ }
    if (!p.variant) continue;
    bucket(p.test || "untested", p.variant).clicks++;
  }

  // Gifts are attributed by the UTM the tracked link wrote, which is the only
  // honest link between a text and the money that followed it.
  const gifts = await allRows(at.T.donations,
    "AND(IS_AFTER({timestamp},'" + from + "'),IS_BEFORE({timestamp},'" + to + "'))");
  for (const g of gifts) {
    const src = String(g.fields.source_url || "");
    const m = src.match(/utm_content=([^&]+)/);
    if (!m) continue;
    const variant = decodeURIComponent(m[1]);
    const t = (src.match(/utm_campaign=([^&]+)/) || [])[1];
    const b = bucket(t ? decodeURIComponent(t) : "untested", variant);
    b.gifts++;
    b.revenue += Number(g.fields.amount || 0);
  }

  // Opt-outs belong to whichever arm last texted that number.
  const optouts = await allRows(at.T.smsReplies,
    "AND({is_stop}=1,IS_AFTER({received_at},'" + from + "'),IS_BEFORE({received_at},'" + to + "'))");
  for (const o of optouts) {
    const arm = phoneToArm.get(String(o.fields.phone || ""));
    if (arm) bucket(arm.test, arm.variant).optouts++;
  }

  let written = 0;
  for (const b of buckets.values()) {
    const rowKey = day + "|" + b.test + "|" + b.variant;
    const fields = {
      row_key: rowKey, date: day, test: b.test, variant: b.variant,
      sends: b.sends, clicks: b.clicks, gifts: b.gifts,
      revenue: Number(b.revenue.toFixed(2)), optouts: b.optouts,
      revenue_per_1k: b.sends ? Number(((b.revenue / b.sends) * 1000).toFixed(2)) : 0,
      updated_at: at.nowIso()
    };
    try {
      const existing = await at.findOne(at.T.abDaily, "{row_key}='" + at.esc(rowKey) + "'");
      if (existing) await at.update(at.T.abDaily, existing.id, fields);
      else await at.create(at.T.abDaily, fields);
      written++;
    } catch (err) { console.error("AB_ROLLUP_ROW_FAIL", rowKey, err.message); }
  }
  return { day, rows: written };
}

// Airtable pages at 100. A day of sends during a launch is more than that.
async function allRows(table, formula, cap) {
  const limit = cap || 2000;
  let out = [], offset = "";
  do {
    const qs = "filterByFormula=" + encodeURIComponent(formula) + "&pageSize=100" +
      (offset ? "&offset=" + encodeURIComponent(offset) : "");
    const res = await at.call("GET", table, qs);
    out = out.concat((res && res.records) || []);
    offset = (res && res.offset) || "";
  } while (offset && out.length < limit);
  return out;
}

module.exports = { assign, rollupDay, allRows };
