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
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const nucleus = require("./_lib/nucleus");
const { allRows } = require("./_lib/ab");

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

  await at.setStat("survey_uid_topup_last_run", pushed, at.nowIso()).catch(() => {});
  return res.status(200).json({ ok: true, candidates: rows.length, pushed, failed });
};
