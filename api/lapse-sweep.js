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
const sms = require("./_lib/sms");
const smsQueue = require("./sms-queue");

const WAIT_MINUTES = 30;
const SLICE = 40;

// One automation per form. The tag is what the CRM automation listens on, and
// it is per-form config rather than a constant: a single hardcoded tag made
// three different campaigns indistinguishable in the CRM in the reference
// build, and nobody noticed until the reporting was needed.
const AUTOMATIONS = {
  Petition: {
    tags: ["Defend Sacred Ground", "Lapsed petition"],
    sms: "You started signing the petition to defend the Australian War Memorial and did not finish. It takes ten seconds: {link}"
  },
  Donation: {
    tags: ["Defend Sacred Ground", "Lapsed donation"],
    sms: "Your donation to Defend Sacred Ground did not go through. You can finish it here: {link}"
  }
};

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;
  if (!h.requireCron(req, res)) return;
  if (!at.configured()) return res.status(503).json({ error: "airtable not configured" });

  const out = { checked: 0, completed: 0, enrolled: 0, texted: 0, failed: 0 };
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

      if (nucleus.configured()) {
        await nucleus.upsertProfile({
          email, first_name: f.first_name, last_name: f.last_name, mobile: f.mobile,
          tags: plan.tags,
          note: "Started " + (f.form || "petition").toLowerCase() + ", did not finish"
        });
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
          test: "lapse_copy", variant: "a",
          message: plan.sms.replace("{link}", link)
        });
        if (queued.queued) out.texted++;
      }

      await close(row, "Triggered", "enrolled in the " + (f.form || "petition") + " follow-up");
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

function close(row, status, note) {
  return at.update(at.T.lapse, row.id, { status, note, triggered_at: at.nowIso() });
}
