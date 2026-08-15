// GET /api/lapse-sweep — chase the people who nearly finished.
//
// Partial captures have been accumulating in the Lapse Queue and nothing has
// ever been done with them. This is the job that does something: every five
// minutes it looks at rows older than thirty minutes, closes the ones who went
// on to finish, and enrols the rest into the matching CRM automation.
//
// The thirty-minute wait is the whole design. Someone who fills in their name,
// gets interrupted, and comes back four minutes later must not receive an
// email saying "you did not finish" while they are still looking at the form.
// Half an hour is long enough that they have genuinely gone.
//
// Completion is re-checked at the moment of enrolment, not when the row was
// written. A supporter who signed twenty-nine minutes after their partial is
// the single most likely person to be nagged wrongly, and being nagged for
// something you already did is worse than never being contacted at all.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const nucleus = require("./_lib/nucleus");
const ab = require("./_lib/ab");
const sms = require("./_lib/sms");
const smsQueue = require("./sms-queue");

const WAIT_MINUTES = 30;
const SLICE = 40;

// One automation per form. The tag is what the CRM automation listens on, and
// it is per-form config rather than a constant: a single hardcoded tag made
// three different campaigns indistinguishable in the CRM in the reference
// build, and nobody noticed until the reporting was needed.
//
// Two SMS bodies per form, because an arm that sends identical copy is not an
// arm. A is the plain restatement, B names what the money or the signature is
// for. Both stay inside one segment.
const AUTOMATIONS = {
  Petition: {
    test: "petition_lapse",
    tags: ["Defend Sacred Ground", "Lapsed petition"],
    sms: {
      A: "You started signing the petition to defend the Australian War Memorial and did not finish. It takes ten seconds: {link}",
      B: "Your name is missing from the petition to keep activists out of the Australian War Memorial. Ten seconds to add it: {link}"
    }
  },
  Donation: {
    test: "donation_lapse",
    tags: ["Defend Sacred Ground", "Lapsed donation"],
    sms: {
      A: "Your donation to Defend Sacred Ground did not go through. You can finish it here: {link}",
      B: "Your donation to Defend Sacred Ground did not complete, so nothing was charged. Only supporters fund this campaign: {link}"
    }
  }
};

/* Which Nucleus automation this arm enrols into.
 *
 * Two ids per form, one per arm. Falling back to the unsuffixed variable means
 * a campaign that does not want to split can set one id and every person goes
 * to it, and falling back again to nothing means an unconfigured deployment
 * still tags the profile rather than doing nothing at all. */
function automationFor(form, variant) {
  const key = form === "Donation" ? "CN_AUTOMATION_DONATION_LAPSE" : "CN_AUTOMATION_PETITION_LAPSE";
  return process.env[key + "_" + variant] || process.env[key] || "";
}

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;
  if (!h.requireCron(req, res)) return;
  if (!at.configured()) return res.status(503).json({ error: "airtable not configured" });

  const out = { checked: 0, completed: 0, enrolled: 0, texted: 0, failed: 0, enrol_failed: 0, arms: {} };
  const cutoff = new Date(Date.now() - WAIT_MINUTES * 60000).toISOString();

  let rows = [];
  try {
    const r = await at.call("GET", at.T.lapse,
      "filterByFormula=" + encodeURIComponent("AND({status}='Waiting',IS_BEFORE({created_at},'" + cutoff + "'))") +
      "&maxRecords=" + SLICE + "&sort%5B0%5D%5Bfield%5D=created_at&sort%5B0%5D%5Bdirection%5D=asc");
    rows = (r && r.records) || [];
  } catch (err) {
    console.error("LAPSE_SWEEP_READ_FAIL", err.message);
    return res.status(200).json({ ok: false, error: String(err.message || err), ...out });
  }

  for (const row of rows) {
    out.checked++;
    const f = row.fields;
    const email = at.normEmail(f.email);
    if (!email) {
      await close(row, "Dropped", "no email to follow up").catch(() => {});
      continue;
    }

    try {
      // Re-checked now, not when the row was written.
      if (await finished(f.form, email)) {
        out.completed++;
        await close(row, "Completed", "finished before the follow-up went out");
        continue;
      }

      const plan = AUTOMATIONS[f.form] || AUTOMATIONS.Petition;

      // The arm. Hashed on the email rather than rolled, so the same person
      // stays in the same arm if this row is ever swept twice, and so a
      // reassignment cannot quietly poison the result halfway through a test.
      const variant = ab.assign(plan.test, email, ["A", "B"]);
      // Counted per run so a lopsided split shows up in the cron's own output
      // rather than only three days later in the report.
      out.arms[plan.test + ":" + variant] = (out.arms[plan.test + ":" + variant] || 0) + 1;
      const automationId = automationFor(f.form, variant);

      if (nucleus.configured()) {
        const armTags = plan.tags.concat([plan.test + "_" + variant.toLowerCase()]);
        // Enrol by id when there is one, because that is what puts the two
        // arms into two different CRM journeys. Tagging is the fallback, not
        // a lesser path: without automation ids configured this is exactly
        // what the sweep did before, so an unset variable costs the split and
        // nothing else.
        const enrolled = automationId
          ? await nucleus.automationAdd(automationId, {
              email, first_name: f.first_name, last_name: f.last_name,
              mobile: f.mobile, postcode: f.postcode, tags: armTags
            })
          : { ok: false, skipped: true };

        if (!enrolled.ok) {
          await nucleus.upsertProfile({
            email, first_name: f.first_name, last_name: f.last_name, mobile: f.mobile,
            tags: armTags,
            note: "Started " + (f.form || "petition").toLowerCase() + ", did not finish"
          });
          if (automationId && !enrolled.skipped) out.enrol_failed++;
        }
      }

      // One text, only to someone who gave a number, and only ever once: the
      // dedupe key in the SMS queue is what guarantees the second sweep to
      // touch this person cannot send it again.
      if (f.mobile && sms.configured() && plan.sms) {
        const site = "https://" + (process.env.SITE_DOMAIN || "defendsacredground.com");
        const link = site + (f.form === "Donation" ? "/fund" : "/fight");
        const queued = await sms.queue({
          phone: h.e164(f.mobile), contact_id: f.contact_id || "",
          template: "lapse_" + String(f.form || "petition").toLowerCase(),
          // The same arm the CRM enrolment used, so one person receives one
          // consistent treatment and the nightly rollup can attribute the
          // money to it. This used to be pinned to "a" for everybody, which
          // labelled the data without ever splitting it.
          test: plan.test, variant,
          message: (plan.sms[variant] || plan.sms.A).replace("{link}", link)
        });
        if (queued.queued) out.texted++;
      }

      await close(row, "Triggered",
        "enrolled in the " + (f.form || "petition") + " follow-up, arm " + variant, variant);
      out.enrolled++;
    } catch (err) {
      out.failed++;
      console.error("LAPSE_ENROL_FAIL", email, err.message);
      await at.update(at.T.lapse, row.id, { note: String(err.message || err).slice(0, 250) }).catch(() => {});
    }
  }

  // Tail-kick: anything this sweep queued goes out now rather than waiting for
  // the next burst of counter traffic to notice it.
  if (out.texted) {
    try { out.sms = await smsQueue.drain(); }
    catch (err) { console.error("LAPSE_SMS_KICK_FAIL", err.message); }
  }

  return res.status(200).json({ ok: true, ...out });
};

async function finished(form, email) {
  if (form === "Donation") {
    const gift = await at.findOne(at.T.donations, "LOWER({email})='" + at.esc(email) + "'");
    if (gift) return true;
  }
  const signed = await at.findOne(at.T.signatures, "LOWER({email})='" + at.esc(email) + "'");
  return !!signed;
}

function close(row, status, note, variant) {
  const fields = { status, note, triggered_at: at.nowIso() };
  // The arm is recorded on the row, not just derivable from the email. It is
  // what lets somebody open the queue and see the split without rerunning the
  // hash, and it survives the email being corrected later.
  if (variant) fields.variant = variant;
  return at.update(at.T.lapse, row.id, fields);
}
