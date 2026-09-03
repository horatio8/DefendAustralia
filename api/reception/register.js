// POST /api/reception/register — I am coming to the private event.
//
// The RSVP behind an invitation. Writes the same Registrations row the online
// briefings use, so a door list is one query and not two, and stamps the
// invitation so the ledger shows who has answered.
//
// The invitation's own details win over anything the browser sends. A valid
// token admits its holder and nobody else: honouring a posted email would let
// one forwarded link register any number of strangers under any names they
// typed, which is precisely what an invitation-only event is guarding against.
// The passcode route has no holder, so there it is the form that speaks.
//
// Keyed on event plus email, so somebody who changes their mind updates their
// answer rather than appearing on the list twice.

const h = require("../_lib/http");
const at = require("../_lib/airtable");
const nucleus = require("../_lib/nucleus");
const reception = require("../_lib/reception");

const ATTENDING = new Set(["Yes", "Maybe", "Cannot make it"]);

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "POST")) return;
  res.setHeader("Cache-Control", "private, no-store");

  const b = h.body(req) || {};
  if (!at.configured()) return res.status(503).json({ error: "Registrations are not switched on yet." });

  const rl = h.rateLimit("recreg:" + h.hashIp(req), 10, 600000);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    return res.status(429).json({ error: "Too many attempts. Try again shortly." });
  }

  const token = h.clean(b.token, 64);
  const code = h.clean(b.code, 120);
  let invite = null;
  let slug = h.clean(b.slug, 60) || process.env.RECEPTION_EVENT_SLUG || "";

  if (token) {
    invite = await reception.inviteByToken(token);
    if (!invite) return res.status(403).json({ error: "That invitation link is not valid. Check the link in your email." });
    slug = invite.fields.event_slug || slug;
  } else if (!(code && reception.passcodeSet() && reception.passcodeOk(code))) {
    return res.status(403).json({ error: "This event is by invitation. Use the link from your email." });
  }

  const event = await reception.event(slug);
  if (!event) return res.status(404).json({ error: "That event is not open." });

  // From the invitation when there is one, from the form when there is not.
  const first = h.clean(invite ? invite.fields.first_name || b.first_name : b.first_name, 80);
  const last = h.clean(invite ? invite.fields.last_name || b.last_name : b.last_name, 80);
  const email = at.normEmail(invite && invite.fields.email ? invite.fields.email : h.clean(b.email, 160));
  const mobile = h.e164(invite && invite.fields.mobile ? invite.fields.mobile : b.mobile);

  if (!h.validEmail(email)) return res.status(400).json({ error: "That email address does not look right." });
  if (!first) return res.status(400).json({ error: "We need a first name for the door list." });

  const attending = ATTENDING.has(String(b.attending)) ? String(b.attending) : "Yes";
  // Never more seats than the invitation grants, and never fewer than one.
  // An unbounded party size on an invitation-only event is how a room built
  // for forty gets a hundred.
  const allowed = Number((invite && invite.fields.seats) || 1) || 1;
  const guests = Math.max(1, Math.min(allowed, Number(b.guests) || 1));

  const regKey = slug + "|" + email;
  const now = at.nowIso();
  let existing = null;
  try {
    existing = await at.findOne(at.T.registrations, "{reg_key}='" + at.esc(regKey) + "'");
  } catch (err) {
    console.error("RECEPTION_REG_LOOKUP_FAIL", err.message);
    return res.status(502).json({ error: "We could not reach the guest list. Try again in a moment." });
  }

  const fields = {
    reg_key: regKey, webinar_slug: slug,
    first_name: first, last_name: last, email, mobile,
    attending, updated_at: now
  };

  try {
    if (existing) await at.update(at.T.registrations, existing.id, fields);
    else await at.create(at.T.registrations, { registration_id: at.uuid(), ...fields, created_at: now });
  } catch (err) {
    console.error("RECEPTION_REG_WRITE_FAIL", err.message);
    return res.status(502).json({ error: "We could not record that. Try again in a moment." });
  }

  if (invite) {
    await at.update(at.T.receptionInvites, invite.id, {
      registered_at: now,
      status: attending === "Cannot make it" ? "Declined" : "Registered"
    }).catch((err) => console.error("RECEPTION_INVITE_STAMP_FAIL", err.message));
  }

  // Best effort, and after the row is safe. The guest list is the thing that
  // matters; the CRM copy is a convenience.
  if (nucleus.configured()) {
    nucleus.upsertProfile({ email, first_name: first, last_name: last, mobile })
      .catch((err) => console.error("RECEPTION_CN_FAIL", err.message));
  }

  return res.status(200).json({
    ok: true,
    attending,
    guests,
    event: { title: event.title, starts_at: event.starts_at, timezone: event.timezone, venue: event.venue }
  });
};
