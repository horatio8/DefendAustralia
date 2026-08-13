// POST /api/survey/capture — identity for someone who arrived without a token.
//
// The survey is normally reached from a CRM email carrying a uid. Anyone who
// forwards that link to a friend, or opens it on a device that mangled the
// query string, lands here instead and types their name and email.
//
// The uid they get is derived from their email rather than generated, so it is
// the same value they would have had if the invitation had reached them
// properly, and a later invitation will resume this response rather than
// starting a second one.
const h = require("../_lib/http");
const at = require("../_lib/airtable");
const queue = require("../_lib/queue");
const { refCodeFor } = require("../_lib/refcode");

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "POST")) return;
  res.setHeader("Cache-Control", "private, no-store");

  const b = h.body(req) || {};
  const email = at.normEmail(h.clean(b.email, 160));
  const first = h.clean(b.first_name || b.first, 60);
  const last = h.clean(b.last_name || b.last, 60);
  const mobile = h.e164(h.clean(b.mobile, 32));
  const src = h.clean(b.src, 40);

  if (!first) return res.status(400).json({ error: "Enter your first name so we know who is answering." });
  if (!h.validEmail(email)) return res.status(400).json({ error: "That does not look like an email address. Check it and try again." });

  if (!h.rateLimit("surveycap:" + h.hashIp(req), 10, 600000).ok) {
    return res.status(429).json({ error: "Too many attempts from this connection. Try again shortly." });
  }

  const uid = refCodeFor(email);

  if (at.configured()) {
    try {
      const existing = await at.findOne(at.T.surveyContacts, "UPPER({uid})='" + at.esc(uid) + "'");
      if (existing) {
        // Fill blanks only. Someone re-entering their details must not be able
        // to blank out what the CRM already knew about them.
        const patch = { updated_at: at.nowIso() };
        if (first && !existing.fields.first_name) patch.first_name = first;
        if (last && !existing.fields.last_name) patch.last_name = last;
        if (mobile && !existing.fields.mobile) patch.mobile = mobile;
        await at.update(at.T.surveyContacts, existing.id, patch);
      } else {
        await at.create(at.T.surveyContacts, {
          uid, first_name: first, last_name: last, email, mobile,
          source: src || "capture", adopted_from_main: false,
          created_at: at.nowIso(), updated_at: at.nowIso()
        });
      }
    } catch (err) {
      console.error("SURVEY_CAPTURE_FAIL", err.message);
      return res.status(502).json({ error: "We could not start your survey. Try again in a moment." });
    }
  }

  // Into the main base too, through the same queue as every other capture, so
  // a survey respondent is a contact like any other rather than a person who
  // exists only in the survey tables.
  try {
    await queue.enqueue("survey_contact", {
      first_name: first, last_name: last, email, mobile,
      referral_code: uid, source_url: h.clean(b.source_url, 300)
    }, null);
  } catch (err) { console.error("QUEUE_SURVEY_CONTACT_FAIL", err.message); }

  // Write-only: the uid is returned because the browser needs it to save
  // answers, and it is derivable from the email the browser just supplied.
  return res.status(200).json({ state: "ready", uid, first_name: first });
};
