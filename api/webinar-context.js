// GET /api/webinar-context?slug=&token= — what the briefing page needs.
//
// Two ways in. A webinar marked open_registration is public and needs no
// token. Everything else needs a magic link, because a donor briefing is where
// the campaign says things it would not say in a press release.
//
// The rule this file exists to enforce: a verified token may only ever return
// its own contact. There is no contact id parameter, and there could not be
// one, because a handler that accepted one after verifying a token would let
// anyone holding a single valid link read every registration in the base.
//
// Everything that fails answers the same way: a neutral "private event" state
// with the event's own details withheld. An expired token, a forged token, a
// token for a different event and a slug that does not exist are
// indistinguishable from outside, because the differences between them are
// exactly what an attacker would use to work out which half to attack.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const token = require("./_lib/token");

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET")) return;
  res.setHeader("Cache-Control", "private, no-store");

  const q = req.query || {};
  const slug = h.clean(q.slug, 60);
  const t = h.clean(q.token, 600);

  if (!at.configured()) return res.status(200).json(PRIVATE);

  let event;
  try {
    event = slug
      ? await at.findOne(at.T.webinars, "AND({slug}='" + at.esc(slug) + "',{active}=1)")
      : await nextUpcoming();
  } catch (err) {
    console.error("WEBINAR_LOOKUP_FAIL", err.message);
    return res.status(200).json(PRIVATE);
  }
  if (!event) return res.status(200).json(PRIVATE);

  const f = event.fields;
  const open = !!f.open_registration;

  let claim = null;
  if (t) {
    claim = token.verify(t);
    // A token minted for a different event is as good as no token. Otherwise
    // one link to a public briefing would open every private one.
    if (claim && claim.slug && claim.slug !== f.slug) claim = null;
  }

  if (!open && !claim) return res.status(200).json(PRIVATE);

  // Prefill comes from the token's own contact and from nowhere else.
  let prefill = {};
  let registered = null;
  if (claim && claim.email) {
    try {
      const c = await at.findOne(at.T.contacts, "LOWER({email})='" + at.esc(at.normEmail(claim.email)) + "'");
      if (c) {
        prefill = {
          first_name: c.fields.first_name || "", last_name: c.fields.last_name || "",
          email: c.fields.email || "", mobile: c.fields.mobile || "",
          is_donor: Number(c.fields.lifetime_donations || 0) > 0
        };
      }
      const reg = await at.findOne(at.T.registrations,
        "{reg_key}='" + at.esc(f.slug + "|" + at.normEmail(claim.email)) + "'");
      if (reg) registered = { attending: reg.fields.attending || "", send_briefing: !!reg.fields.send_briefing };
    } catch (err) { console.error("WEBINAR_PREFILL_FAIL", err.message); }
  }

  return res.status(200).json({
    state: "ready",
    event: {
      slug: f.slug, title: f.title || "", lede: f.lede || "",
      starts_at: f.starts_at || "", timezone: f.timezone || "Australia/Sydney",
      duration_minutes: Number(f.duration_minutes || 60),
      host: f.host || "",
      // Filled minutes before, so the page reads it live rather than baking it
      // into a link that was emailed days ago.
      join_url: registered || open ? (f.join_url || "") : "",
      open_registration: open
    },
    prefill, registered,
    // Echoed so the register call can prove the same claim without re-deriving
    // identity from anything the browser supplies.
    token: t || ""
  });
};

// Deliberately says nothing: not the title, not the date, not whether the slug
// exists at all.
const PRIVATE = {
  state: "private",
  message: "This briefing is for invited supporters. Check the link in your email, or ask us to send it again."
};

async function nextUpcoming() {
  const res = await at.call("GET", at.T.webinars,
    "filterByFormula=" + encodeURIComponent("AND({active}=1,IS_AFTER({starts_at},NOW()))") +
    "&maxRecords=1&sort%5B0%5D%5Bfield%5D=starts_at&sort%5B0%5D%5Bdirection%5D=asc");
  return ((res && res.records) || [])[0] || null;
}
