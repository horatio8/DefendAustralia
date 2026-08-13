// POST /api/webinar-register — I am coming, or I am not but send me the notes.
//
// Keyed on the event slug plus the email, so someone who changes their mind
// updates their answer rather than appearing twice on the door list.
//
// "Cannot make it" is a real answer and is recorded as one. A supporter who
// says they cannot come but wants the briefing is worth more to the campaign
// than a blank, and a form that only accepts yes just collects fewer answers.
//
// join_url is only returned to someone who has registered, and only once it is
// set. It goes in late, often minutes before, so a link emailed days ahead
// cannot carry it.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const nucleus = require("./_lib/nucleus");
const token = require("./_lib/token");

const ATTENDING = new Set(["Yes", "Maybe", "Cannot make it"]);

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "POST")) return;
  res.setHeader("Cache-Control", "private, no-store");

  const b = h.body(req) || {};
  const slug = h.clean(b.slug, 60);
  const t = h.clean(b.token, 600);
  if (!slug) return res.status(400).json({ error: "Which briefing? The link looks incomplete." });
  if (!at.configured()) return res.status(503).json({ error: "Registrations are not switched on yet." });

  let event;
  try {
    event = await at.findOne(at.T.webinars, "AND({slug}='" + at.esc(slug) + "',{active}=1)");
  } catch (err) {
    console.error("WEBINAR_REG_LOOKUP_FAIL", err.message);
    return res.status(502).json({ error: "We could not reach the briefing. Try again in a moment." });
  }
  if (!event) return res.status(404).json({ error: "That briefing is not open." });

  const claim = t ? token.verify(t) : null;
  if (!event.fields.open_registration && !claim) {
    return res.status(403).json({ error: "This briefing is for invited supporters. Use the link from your email." });
  }
  if (claim && claim.slug && claim.slug !== slug) {
    return res.status(403).json({ error: "That link is for a different briefing." });
  }

  // The token's email wins over anything the browser sends: a valid link
  // registers its own holder and nobody else.
  const email = at.normEmail(claim && claim.email ? claim.email : h.clean(b.email, 160));
  if (!h.validEmail(email)) {
    return res.status(400).json({ error: "We need a valid email address to send you the joining details." });
  }

  const attending = ATTENDING.has(h.clean(b.attending, 20)) ? h.clean(b.attending, 20) : "Yes";
  const first = h.clean(b.first_name, 60);
  const last = h.clean(b.last_name, 60);
  const mobile = h.e164(h.clean(b.mobile, 32));
  const sendBriefing = b.send_briefing !== false;

  const regKey = slug + "|" + email;
  let isDonor = false;
  try {
    const contact = await at.findOne(at.T.contacts, "LOWER({email})='" + at.esc(email) + "'");
    isDonor = !!(contact && Number(contact.fields.lifetime_donations || 0) > 0);

    const fields = {
      reg_key: regKey, webinar_slug: slug,
      contact_id: (contact && contact.fields.contact_id) || (claim && claim.contact_id) || "",
      first_name: first || (contact && contact.fields.first_name) || "",
      last_name: last || (contact && contact.fields.last_name) || "",
      email, mobile: mobile || (contact && contact.fields.mobile) || "",
      attending, is_donor: isDonor, send_briefing: sendBriefing,
      updated_at: at.nowIso()
    };

    const existing = await at.findOne(at.T.registrations, "{reg_key}='" + at.esc(regKey) + "'");
    if (existing) await at.update(at.T.registrations, existing.id, fields);
    else await at.create(at.T.registrations, { ...fields, registration_id: at.uuid(), created_at: at.nowIso() });

    await at.logEvent({
      contactRecId: contact ? contact.id : undefined,
      event_type: "Webinar Registered", source_channel: "Webinar",
      dedup_key: "webinarreg:" + regKey,
      payload: { slug, attending, send_briefing: sendBriefing }
    }).catch(() => {});
  } catch (err) {
    console.error("WEBINAR_REG_FAIL", err.message);
    return res.status(502).json({ error: "We could not record that. Try again in a moment." });
  }

  // Best effort and last: a CRM hiccup must not cost a registration.
  if (nucleus.configured()) {
    try {
      await nucleus.upsertProfile({
        email, first_name: first, last_name: last, mobile,
        tags: ["Defend Sacred Ground", "Briefing " + slug, "Briefing " + attending]
      });
    } catch (err) { console.error("CN_WEBINAR_FAIL", err.message); }
  }

  return res.status(200).json({
    ok: true, attending,
    join_url: event.fields.join_url || "",
    starts_at: event.fields.starts_at || "",
    timezone: event.fields.timezone || "Australia/Sydney"
  });
};
