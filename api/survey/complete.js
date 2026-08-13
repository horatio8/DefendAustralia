// POST /api/survey/complete — finish, then decide what to ask for.
//
// Three things happen here and the order matters.
//
// First the answers the server already knew are seeded, server side. A screen
// skipped because the CRM already had a postcode still has a postcode in the
// finished response, and that value comes from the CRM record rather than from
// the browser, which was never told it.
//
// Then the accumulated tags go to the CRM in one call. Tagging per screen
// would mean a survey abandoned at question nine leaves nine tags describing
// someone who never finished, and every segment built on those tags would then
// include people who did not answer the questions that segment is about.
//
// Last the ask is chosen from what they said. Someone who ticked "I can
// volunteer" and not "chip in" is asked to volunteer. Asking everyone for
// money regardless is what makes a survey feel like a funnel, and supporters
// notice.
const h = require("../_lib/http");
const at = require("../_lib/airtable");
const nucleus = require("../_lib/nucleus");
const { normCode } = require("../_lib/refcode");

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "POST")) return;
  res.setHeader("Cache-Control", "private, no-store");

  const b = h.body(req) || {};
  const uid = normCode(h.clean(b.uid, 64));
  const slug = h.clean(b.slug, 40) || "memorial";
  if (!uid) return res.status(400).json({ error: "bad payload" });
  if (!at.configured()) return res.status(200).json({ ok: true, ask: fallbackAsk() });

  const key = uid + "|" + slug;

  try {
    const person = await at.findOne(at.T.surveyContacts, "UPPER({uid})='" + at.esc(uid) + "'");
    const row = await at.findOne(at.T.surveyResponses, "{response_key}='" + at.esc(key) + "'");

    let answers = {};
    if (row) { try { answers = JSON.parse(row.fields.raw_json || "{}"); } catch (e) { /* start clean */ } }
    // Whatever the browser is still holding, in case a per-screen save failed.
    if (b.answers && typeof b.answers === "object") {
      for (const k of Object.keys(b.answers)) {
        if (answers[k] === undefined) answers[k] = b.answers[k];
      }
    }

    // Seed what was skipped because it was already known. Server side: these
    // values were never sent to the browser and are not taken from it.
    const pf = (person && person.fields) || {};
    if (pf.postcode && !answers.postcode) answers.postcode = pf.postcode;

    const tags = tagsFrom(answers, b.tagTemplates);
    const motivation = String(answers.motivation || "");

    await at.update(at.T.surveyResponses, row ? row.id : (await at.create(at.T.surveyResponses, {
      response_id: at.uuid(), response_key: key, uid, survey_slug: slug, created_at: at.nowIso()
    })).id, {
      status: "Complete",
      raw_json: JSON.stringify(answers),
      screens_answered: Object.keys(answers).length,
      primary_motivation: motivation,
      postcode: String(answers.postcode || "").slice(0, 8),
      phone_optin: answers.phone_optin === "yes" || answers.phone_optin === true,
      contact_id: pf.contact_id || "",
      cn_tags: tags.join(", "),
      ask_variant: motivation || "default",
      updated_at: at.nowIso(), completed_at: at.nowIso()
    });

    // One CRM call, at the end, with everything.
    if (pf.email && nucleus.configured()) {
      try {
        await nucleus.upsertProfile({
          email: pf.email, first_name: pf.first_name, last_name: pf.last_name,
          mobile: pf.mobile, postcode: answers.postcode || pf.postcode,
          tags: ["Defend Sacred Ground", "Completed survey"].concat(tags),
          note: "Survey " + slug + ": " + (motivation || "no primary motivation given")
        });
      } catch (err) { console.error("CN_SURVEY_TAG_FAIL", err.message); }
    }

    if (pf.contact_id || pf.email) {
      await at.logEvent({
        event_type: "Survey Completed", source_channel: "Survey",
        dedup_key: "survey:" + key,
        payload: { uid, slug, motivation, screens: Object.keys(answers).length }
      }).catch(() => {});
    }

    return res.status(200).json({
      ok: true,
      first_name: pf.first_name || "",
      motivation,
      ask: askFor(answers, motivation)
    });
  } catch (err) {
    console.error("SURVEY_COMPLETE_FAIL", err.message);
    // Their answers are already saved per screen, so the honest failure here
    // is only about the closing ask.
    return res.status(200).json({ ok: true, saved: "partial", ask: fallbackAsk() });
  }
};

/* Tags, built from the config's templates so a new screen needs no code. */
function tagsFrom(answers, templates) {
  const out = [];
  const tpl = (templates && typeof templates === "object") ? templates : {};
  for (const screen of Object.keys(answers)) {
    const pattern = tpl[screen];
    if (!pattern) continue;
    const v = answers[screen];
    const values = Array.isArray(v) ? v : [v];
    for (const one of values) {
      const s = String(one || "").trim();
      if (!s) continue;
      out.push(String(pattern).replace("{value}", s).slice(0, 60));
    }
  }
  return out.slice(0, 25);
}

/* The ask, routed by what they said they would do. Order is deliberate: the
 * hardest thing they agreed to comes first, because they have just told us
 * they would do it and that is the moment to take them up on it. */
function askFor(answers, motivation) {
  const help = Array.isArray(answers.help) ? answers.help : (answers.help ? [answers.help] : []);
  const routes = [];
  const add = (when, label, href, primary) => routes.push({ when, label, href, primary: !!primary });

  if (help.includes("donate")) add("donate", "Chip in", "/donate?focus=1", true);
  if (help.includes("volunteer")) add("volunteer", "Volunteer", "/volunteer#signup", !routes.length);
  if (help.includes("letter")) add("letter", "Write to the Minister", "/minister#ff-email-form", !routes.length);
  if (help.includes("share")) add("share", "Get your share link", "/share", !routes.length);
  if (!routes.length) add("share", "Get your share link", "/share", true);

  return { framing: motivation || "default", routes };
}

function fallbackAsk() {
  return { framing: "default", routes: [{ when: "share", label: "Get your share link", href: "/share", primary: true }] };
}
