// POST /api/survey/answer — one screen's answer.
//
// Saved per screen rather than in one submit at the end, because an abandoned
// survey is still data. Someone who answers six of fourteen questions and puts
// their phone down has told the campaign six things, and a design that only
// records completions throws all six away.
//
// The row is keyed uid|slug and updated in place, so answering the same screen
// twice corrects it rather than appending. Airtable answers 429 readily and
// this endpoint fires once per tap, so every write goes through the shared
// retry with jitter.
const h = require("../_lib/http");
const at = require("../_lib/airtable");
const { normCode } = require("../_lib/refcode");

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "POST")) return;
  res.setHeader("Cache-Control", "private, no-store");

  const b = h.body(req) || {};
  const uid = normCode(h.clean(b.uid, 64));
  const slug = h.clean(b.slug, 40) || "memorial";
  const screen = h.clean(b.screen, 60);
  const version = h.clean(b.version, 12) || "1";

  if (!uid || !screen) return res.status(400).json({ error: "bad payload" });
  if (!at.configured()) return res.status(200).json({ ok: true, saved: false });

  // A tap a second is generous for a human and cheap for us; a script gets
  // stopped well before it can fill the table.
  if (!h.rateLimit("surveyans:" + uid, 60, 60000).ok) {
    return res.status(429).json({ error: "Slow down a moment." });
  }

  const value = normaliseValue(b.value);
  const key = uid + "|" + slug;

  try {
    const existing = await at.findOne(at.T.surveyResponses, "{response_key}='" + at.esc(key) + "'");
    let answers = {};
    if (existing) {
      try { answers = JSON.parse(existing.fields.raw_json || "{}"); } catch (e) { /* start clean */ }
    }
    answers[screen] = value;

    const fields = {
      response_key: key, uid, survey_slug: slug, version,
      status: "In progress",
      raw_json: JSON.stringify(answers),
      screens_answered: Object.keys(answers).length,
      updated_at: at.nowIso()
    };
    // The columns that get filtered and grouped on, lifted out of the JSON so
    // a human can read the table without parsing anything.
    if (screen === "motivation") fields.primary_motivation = String(value || "");
    if (screen === "postcode") fields.postcode = String(value || "").slice(0, 8);
    if (screen === "phone_optin") fields.phone_optin = value === "yes" || value === true;

    if (existing) await at.update(at.T.surveyResponses, existing.id, fields);
    else await at.create(at.T.surveyResponses, {
      ...fields, response_id: at.uuid(), src: h.clean(b.src, 40), created_at: at.nowIso()
    });

    return res.status(200).json({ ok: true, saved: true, answered: Object.keys(answers).length });
  } catch (err) {
    console.error("SURVEY_ANSWER_FAIL", err.message);
    // The browser holds the answers and sends them all again at completion, so
    // one failed save is recoverable. It is still reported rather than hidden.
    return res.status(502).json({ error: "That answer did not save. It will be sent again at the end." });
  }
};

// Values are one of: a string, a list of strings from a multi-select, or a
// number from a scale. Anything else is not a survey answer.
function normaliseValue(v) {
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => String(x).slice(0, 60));
  if (typeof v === "number") return Math.max(0, Math.min(10, Math.round(v)));
  if (typeof v === "boolean") return v;
  return String(v == null ? "" : v).slice(0, 300);
}
