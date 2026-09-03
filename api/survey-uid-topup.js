// GET /api/survey-uid-topup — nightly, so new contacts get survey tokens.
//
// This cron is the difference between a survey link that identifies someone
// and one that does not. Every contact created since the last run has a
// referral code but no token in the CRM, so an invitation sent to them
// tomorrow would arrive with an empty uid and dump them on the capture screen
// having already been asked their name once.
//
// It only ever looks at recent contacts. A full re-push every night would be
// tens of thousands of CRM writes to set values that are already correct.
//
// There is one exception, and it exists because "recent" is not the same as
// "changed". /api/referral-integrity repairs colliding codes on contacts that
// may be months old, and those would never fall inside the lookback window
// again. It leaves their record ids in a Sync State queue, which this job
// drains alongside the new arrivals. That queue is why the repair cron does
// not push to the CRM itself: exactly one job owns the token field, because a
// second writer once wrote a timestamp into it and destroyed every survey
// token in the account.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const nucleus = require("./_lib/nucleus");
const { allRows } = require("./_lib/ab");
const { REPUSH_KEY } = require("./referral-integrity");

const UID_FIELD = process.env.CRM_UID_FIELD || "custom2";
const LOOKBACK_HOURS = 30;   // a daily job with six hours of overlap
const MAX_PER_RUN = 300;

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;
  if (!h.requireCron(req, res)) return;
  if (!at.configured() || !nucleus.configured()) {
    return res.status(200).json({ ok: true, skipped: "not configured" });
  }

  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600000).toISOString();
  let rows = [];
  try {
    rows = await allRows(at.T.contacts,
      "AND({referral_code}!='',{email}!='',IS_AFTER({date_first_seen},'" + since + "'))", 1000);
  } catch (err) {
    console.error("UID_TOPUP_READ_FAIL", err.message);
    return res.status(200).json({ ok: false, error: String(err.message || err) });
  }

  // The repaired contacts, whatever their age. Read before the push and
  // cleared after it, so a run that dies halfway leaves them queued rather
  // than silently dropped.
  const repaired = await repairedRows();
  const seen = new Set(rows.map((r) => r.id));
  for (const r of repaired) if (!seen.has(r.id)) rows.push(r);

  let pushed = 0, failed = 0;
  for (const r of rows.slice(0, MAX_PER_RUN)) {
    const email = r.fields.email;
    const uid = String(r.fields.referral_code || "").toUpperCase();
    if (!email || !uid) continue;
    try {
      await nucleus.upsertProfile({
        email, first_name: r.fields.first_name, last_name: r.fields.last_name,
        mobile: r.fields.mobile, postcode: r.fields.postcode,
        uidField: UID_FIELD, uid
      });
      pushed++;
    } catch (err) { failed++; console.error("UID_TOPUP_PUSH_FAIL", email, err.message); }
  }

  // Only clear the repair queue when nothing failed. A contact whose push
  // failed must stay queued: the alternative is a supporter holding a code
  // the CRM has never heard of, and no record anywhere that it happened.
  if (repaired.length && !failed) await clearRepushQueue();

  await at.setStat("survey_uid_topup_last_run", pushed, at.nowIso()).catch(() => {});
  return res.status(200).json({
    ok: true, candidates: rows.length, repaired_included: repaired.length, pushed, failed
  });
};

/* Contacts whose referral code was repaired since the last drain. The queue
 * is a list of record ids in one Sync State row; a missing table or a missing
 * row simply means there is nothing to do. */
async function repairedRows() {
  try {
    if (!(await at.hasTable(at.T.syncState))) return [];
    const rec = await at.findOne(at.T.syncState, "{key}='" + REPUSH_KEY + "'");
    const ids = rec && rec.fields.value ? JSON.parse(rec.fields.value) : [];
    if (!Array.isArray(ids) || !ids.length) return [];
    const out = [];
    for (let i = 0; i < ids.length && i < 500; i += 50) {
      const slice = ids.slice(i, i + 50);
      const p = await at.page(at.T.contacts, {
        pageSize: 100,
        filterByFormula: "OR(" + slice.map((id) => "RECORD_ID()='" + at.esc(id) + "'").join(",") + ")",
        fields: ["referral_code", "email", "first_name", "last_name", "mobile", "postcode"]
      });
      for (const r of p.records) out.push(r);
    }
    return out;
  } catch (err) {
    console.error("UID_TOPUP_REPAIR_READ_FAIL", err.message);
    return [];
  }
}

async function clearRepushQueue() {
  try {
    const rec = await at.findOne(at.T.syncState, "{key}='" + REPUSH_KEY + "'");
    if (rec) await at.update(at.T.syncState, rec.id, { value: "[]", updated_at: at.nowIso() });
  } catch (err) { console.error("UID_TOPUP_QUEUE_CLEAR_FAIL", err.message); }
}
