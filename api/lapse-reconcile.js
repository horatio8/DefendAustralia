// GET /api/lapse-reconcile — undo a follow-up that should never have gone.
//
// The lapse sweep enrols people who did not finish. It re-checks completion
// before enrolling, but the check and the enrolment are not one atomic act, so
// a supporter who signs in that window gets a nudge about something they have
// already done. There are also the rows enrolled before the sweep existed at
// all, when nothing checked anything.
//
// This finds those people and marks them, so the CRM automation can be told to
// drop them and so the next report does not count them as lapsed. It is the
// cleanup for a class of mistake that is cheap to make and expensive to leave:
// nothing annoys a donor like being chased for a donation they already made.
//
// Dry run by default, like the backfill, because it writes to rows a human may
// be mid-way through interpreting.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const nucleus = require("./_lib/nucleus");
const { allRows } = require("./_lib/ab");

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;
  if (!h.requireBasicAuth(req, res)) return;
  if (!at.configured()) return res.status(503).json({ error: "airtable not configured" });

  const apply = (req.query && req.query.apply) === "1";
  const out = { dry_run: !apply, checked: 0, wrongly_enrolled: 0, corrected: 0, failed: 0, people: [] };

  let rows = [];
  try {
    rows = await allRows(at.T.lapse, "OR({status}='Triggered',{status}='Waiting')", 3000);
  } catch (err) {
    console.error("RECONCILE_READ_FAIL", err.message);
    return res.status(502).json({ error: String(err.message || err) });
  }

  for (const row of rows) {
    out.checked++;
    const email = at.normEmail(row.fields.email);
    if (!email) continue;

    let done = false;
    try {
      const signed = await at.findOne(at.T.signatures, "LOWER({email})='" + at.esc(email) + "'");
      const gave = await at.findOne(at.T.donations, "LOWER({email})='" + at.esc(email) + "'");
      done = !!(signed || gave);
    } catch (err) {
      out.failed++;
      continue;
    }
    if (!done) continue;

    out.wrongly_enrolled++;
    if (out.people.length < 25) out.people.push({ email, form: row.fields.form, status: row.fields.status });
    if (!apply) continue;

    try {
      await at.update(at.T.lapse, row.id, {
        status: "Completed",
        note: "Reconciled: this person had already finished",
        triggered_at: at.nowIso()
      });
      // Tagged so the CRM automation can exclude them. The lapse tag is not
      // removed, because Nucleus has no reliable untag and a second tag the
      // automation checks for is more dependable than an absent first one.
      if (nucleus.configured()) {
        await nucleus.upsertProfile({
          email, tags: ["Defend Sacred Ground", "Lapse follow-up cancelled"]
        }).catch((err) => console.error("CN_RECONCILE_TAG_FAIL", err.message));
      }
      out.corrected++;
    } catch (err) {
      out.failed++;
      console.error("RECONCILE_WRITE_FAIL", email, err.message);
    }
  }

  res.setHeader("Cache-Control", "private, no-store");
  out.note = apply
    ? "Corrected. Exclude anyone tagged 'Lapse follow-up cancelled' in the CRM automation."
    : "Nothing was written. Add &apply=1 to correct these " + out.wrongly_enrolled + " row(s).";
  return res.status(200).json(out);
};
