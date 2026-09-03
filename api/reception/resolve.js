// GET /api/reception/resolve?t=<invite token>  or  ?code=<shared passcode>
//
// Opens a private invitation: returns the event and, for a personal token,
// the invitee's own details so the RSVP form is already filled in.
//
// Two ways in, and they are not equivalent.
//
// A personal token identifies one named person, so it prefills. It is also
// recorded: the first open stamps the invitation, which is what lets the
// campaign chase the people who never opened theirs.
//
// The shared passcode identifies nobody. It exists for the people the
// campaign wants in the room but holds no email address for — read out on the
// phone, dropped in a group chat — and because it is shared it buys strictly
// less: no prefill, every field typed by hand. It is off unless somebody sets
// one, rather than defaulting to something nobody knows is there.
//
// Rate limited, no-store, and a wrong token and a missing token give the same
// answer so the endpoint cannot be used to test whether one exists.

const h = require("../_lib/http");
const at = require("../_lib/airtable");
const reception = require("../_lib/reception");

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET")) return;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");

  const rl = h.rateLimit("reception:" + h.hashIp(req), 30, 600000);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    return res.status(429).json({ ok: false });
  }
  if (!at.configured()) return res.status(503).json({ error: "not configured" });

  const q = req.query || {};
  const slug = h.clean(q.event, 60) || process.env.RECEPTION_EVENT_SLUG || "";
  const token = h.clean(q.t, 64);
  const code = h.clean(q.code, 120);

  // One answer for every refusal.
  const denied = { ok: true, admitted: false };

  if (token) {
    const invite = await reception.inviteByToken(token);
    if (!invite) return res.status(200).json(denied);
    const ev = await reception.event(invite.fields.event_slug || slug);
    if (!ev) return res.status(200).json(denied);

    // Stamp the first open only. Overwriting it on every visit would turn the
    // one useful fact — when they first looked — into "when they last looked",
    // and the chase list needs the first.
    if (!invite.fields.opened_at) {
      await at.update(at.T.receptionInvites, invite.id, {
        opened_at: at.nowIso(),
        ...(reception.pick(invite.fields.status) === "Issued" ? { status: "Opened" } : {})
      }).catch((err) => console.error("RECEPTION_OPEN_STAMP_FAIL", err.message));
    }

    return res.status(200).json({
      ok: true,
      admitted: true,
      via: "invitation",
      event: ev,
      seats: invite.fields.seats || 1,
      already_registered: !!invite.fields.registered_at,
      prefill: {
        first: invite.fields.first_name || "",
        last: invite.fields.last_name || "",
        email: invite.fields.email || "",
        mobile: invite.fields.mobile || ""
      }
    });
  }

  if (code) {
    if (!reception.passcodeSet() || !reception.passcodeOk(code)) return res.status(200).json(denied);
    const ev = await reception.event(slug);
    if (!ev) return res.status(200).json(denied);
    // No prefill. A shared secret says somebody knows the password, not who
    // they are, and filling a name in for them would be an invention.
    return res.status(200).json({ ok: true, admitted: true, via: "passcode", event: ev, seats: 1, prefill: null });
  }

  return res.status(200).json({ ...denied, passcode_accepted: reception.passcodeSet() });
};
