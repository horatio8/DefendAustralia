// GET /api/survey-uids — put the survey token into the CRM.
//
// A survey invitation is only tokenised if the CRM has somewhere to merge the
// token from. This endpoint fills that field, in two modes:
//
//   ?mode=csv   download a CSV to feed the CRM's contact import. Right for the
//               first run, when there are tens of thousands of contacts and a
//               bulk import is one operation instead of forty thousand.
//   ?mode=push  write directly, in batches, cursored. Right for topping up the
//               few hundred contacts added since the last run.
//
// Contacts without a referral code are skipped, never minted. Minting a code
// here would create one for people who have never shared anything, and the
// referral rollup would then carry thousands of rows with no activity.
//
// The token is the referral code, uppercase. One value is both the survey
// identity and the referral attribution, so a supporter who forwards their
// survey link is credited for whoever follows it.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const nucleus = require("./_lib/nucleus");
const { allRows } = require("./_lib/ab");

const UID_FIELD = process.env.CRM_UID_FIELD || "custom2";
const PUSH_BATCH = 50;

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;
  // Either a human with the admin password, or the nightly top-up cron.
  const cron = !!(req.headers && req.headers["x-vercel-cron"]);
  if (!cron && !h.requireBasicAuth(req, res)) return;
  if (!at.configured()) return res.status(503).json({ error: "airtable not configured" });

  const mode = h.clean((req.query && req.query.mode) || (cron ? "push" : "csv"), 10);
  const since = h.clean((req.query && req.query.since) || "", 40);

  let rows;
  try {
    rows = await eligible(since);
  } catch (err) {
    console.error("SURVEY_UIDS_READ_FAIL", err.message);
    return res.status(502).json({ error: "could not read contacts" });
  }

  if (mode === "csv") {
    const csv = "email,first_name,last_name," + UID_FIELD + "\n" +
      rows.map((r) => [
        csvCell(r.email), csvCell(r.first_name), csvCell(r.last_name), csvCell(r.uid)
      ].join(",")).join("\n") + "\n";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="survey-uids.csv"');
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).send(csv);
  }

  if (!nucleus.configured()) return res.status(503).json({ error: "nucleus not configured" });

  let pushed = 0, failed = 0;
  for (const r of rows.slice(0, PUSH_BATCH)) {
    try {
      await nucleus.upsertProfile({
        email: r.email, first_name: r.first_name, last_name: r.last_name,
        uidField: UID_FIELD, uid: r.uid
      });
      pushed++;
    } catch (err) {
      failed++;
      console.error("SURVEY_UID_PUSH_FAIL", r.email, err.message);
    }
  }

  return res.status(200).json({
    ok: true, eligible: rows.length, pushed, failed,
    remaining: Math.max(0, rows.length - PUSH_BATCH),
    field: UID_FIELD
  });
};

async function eligible(since) {
  const clauses = ["{referral_code}!=''", "{email}!=''"];
  if (since) clauses.push("IS_AFTER({date_first_seen},'" + at.esc(since) + "')");
  const records = await allRows(at.T.contacts, "AND(" + clauses.join(",") + ")", 5000);
  return records.map((r) => ({
    email: r.fields.email || "",
    first_name: r.fields.first_name || "",
    last_name: r.fields.last_name || "",
    uid: String(r.fields.referral_code || "").toUpperCase()
  })).filter((r) => r.email && r.uid);
}

// A supporter called O'Brien, Jr. in a CSV is a quoting bug waiting to happen.
function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
