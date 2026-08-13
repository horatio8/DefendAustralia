// POST /api/survey/resolve — bootstrap a survey session from a tokenised link.
//
// Invitations go out from the CRM as ?uid=<referral code>&src=email. One value
// serves as both survey identity and referral attribution, so a supporter who
// forwards their survey link also gets credit for whoever follows it.
//
// Three rules govern this file and each of them was learned expensively.
//
// The uid is uppercased before it is stored and matched case-insensitively.
// Mail clients lowercase URLs. A lowercased uid that misses its row mints a
// second row for a person who already exists, and the campaign then has two
// half-answered surveys from one supporter.
//
// The bootstrap payload masks personal values. The browser is told that a
// postcode is known, not what it is. Screens the server intends to skip are
// stripped from the resume echo entirely rather than sent and hidden, because
// a value sent to the browser is a value that has left the building.
//
// An unknown uid and a malformed uid return the same neutral response. Telling
// the difference apart would turn this endpoint into a way to test whether a
// given code belongs to a real supporter.
const h = require("../_lib/http");
const at = require("../_lib/airtable");
const { normCode } = require("../_lib/refcode");

const MAX_UID = 64;

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "POST")) return;
  res.setHeader("Cache-Control", "private, no-store");

  const b = h.body(req) || {};
  const slug = h.clean(b.slug, 40) || "memorial";
  const src = h.clean(b.src, 40);
  const raw = h.clean(b.uid, MAX_UID);

  // Shape check first: URL-safe, bounded. Anything else is treated exactly
  // like an unknown code.
  if (!raw || raw.length > MAX_UID || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    return res.status(200).json({ state: "needs_capture" });
  }
  const uid = normCode(raw);

  if (!at.configured()) return res.status(200).json({ state: "needs_capture" });

  try {
    let row = await at.findOne(at.T.surveyContacts, "UPPER({uid})='" + at.esc(uid) + "'");

    // Not in the survey mirror yet. Adopt from the main base if the code is a
    // real supporter's referral code. Never mint: a code that matches nobody
    // is treated as unknown.
    if (!row) {
      const contact = await at.findOne(at.T.contacts, "UPPER({referral_code})='" + at.esc(uid) + "'");
      if (!contact) return res.status(200).json({ state: "needs_capture" });

      // Check again for an uppercase row before creating, because two
      // invitations opened at once would otherwise both adopt.
      row = await at.findOne(at.T.surveyContacts, "{uid}='" + at.esc(uid) + "'");
      if (!row) {
        const created = await at.create(at.T.surveyContacts, {
          uid,
          contact_id: contact.fields.contact_id || "",
          first_name: contact.fields.first_name || "",
          last_name: contact.fields.last_name || "",
          email: contact.fields.email || "",
          mobile: contact.fields.mobile || "",
          postcode: contact.fields.postcode || "",
          source: src, adopted_from_main: true,
          created_at: at.nowIso(), updated_at: at.nowIso()
        });
        row = { id: created.id, fields: created.fields || {} };
      }
    }

    const f = row.fields || {};
    // Screens the server already knows the answer to. They are not asked, and
    // the known values are seeded server side at completion.
    const known = {};
    if (f.postcode) known.postcode = true;
    if (f.mobile) known.phone_optin = false; // having a number is not consent

    const resumed = await resume(uid, slug);

    return res.status(200).json({
      state: "ready",
      // The only personal value that crosses: their first name, because the
      // greeting says it. Everything else is a boolean.
      first_name: f.first_name || "",
      has_email: !!f.email,
      has_mobile: !!f.mobile,
      skip: Object.keys(known).filter((k) => known[k]),
      answers: resumed.answers,
      status: resumed.status,
      src
    });
  } catch (err) {
    console.error("SURVEY_RESOLVE_FAIL", err.message);
    return res.status(200).json({ state: "needs_capture" });
  }
};

/* An in-progress response, looked up by the contact's own stored uid rather
 * than by the raw string from the URL. Two invitations to one person can carry
 * different-cased uids; resuming on the raw string would start a second
 * response and lose the first. */
async function resume(uid, slug) {
  try {
    const rec = await at.findOne(at.T.surveyResponses,
      "{response_key}='" + at.esc(uid + "|" + slug) + "'");
    if (!rec) return { answers: {}, status: "new" };
    let answers = {};
    try { answers = JSON.parse(rec.fields.raw_json || "{}"); } catch (e) { /* corrupt row, start clean */ }
    // Skipped-but-known answers are stripped from the echo: the browser gets
    // back what it sent, never what the server knew already.
    delete answers.postcode;
    return { answers, status: rec.fields.status === "Complete" ? "complete" : "in_progress" };
  } catch (err) {
    console.error("SURVEY_RESUME_FAIL", err.message);
    return { answers: {}, status: "new" };
  }
}
