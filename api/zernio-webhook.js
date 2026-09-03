// POST /api/zernio-webhook — somebody said something to the campaign.
//
// Comments, direct messages and lead-form submissions arrive here from the
// social inbox. Each one becomes an Identity (who) and a Social Message
// (what), and nothing else happens on this request.
//
// Two constraints shape everything below, and both come from how the provider
// retries.
//
// Delivery is at-least-once, over days, with the subscription auto-disabled
// after enough consecutive failures. So once the signature checks out this
// endpoint answers 200 even when a handler hits a payload shape it does not
// recognise — the error goes to the log, not to the provider. A 500 here does
// not get the message redelivered usefully; it gets the subscription turned
// off, and then nothing arrives at all and nobody notices for a week.
//
// And the same message will be delivered twice. Every write is keyed on the
// provider's own event id, so a retry updates nothing and returns quietly.
//
// The signature is checked against the raw body, before parsing. An HMAC over
// a re-serialised object verifies whatever the JSON parser produced, which is
// not what was signed.

const crypto = require("crypto");
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const social = require("./_lib/social");

// The body must be read raw for the signature, so Vercel's parser is off.
module.exports.config = { api: { bodyParser: false } };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s()-]{8,}$/;

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "POST")) return;

  const secret = process.env.ZERNIO_WEBHOOK_SECRET;
  // No secret means no way to tell a real delivery from anybody who found the
  // URL. An unsigned endpoint that writes to the identity graph is a way to
  // fill it with invented people, so it is closed rather than open.
  if (!secret) return res.status(404).json({ error: "not found" });

  const raw = await readRaw(req);
  if (!verify(raw, req.headers["x-zernio-signature"], secret)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  let evt;
  try { evt = JSON.parse(raw.toString("utf8")); } catch (err) {
    return res.status(400).json({ error: "invalid json" });
  }
  if (!at.configured()) return res.status(200).json({ ok: false, error: "airtable not configured" });

  try {
    const handler = HANDLERS[evt.event];
    const result = handler ? await handler(evt) : { skipped: "unhandled event " + evt.event };
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    // The signature was valid, so this was a real delivery. Acknowledge it:
    // retrying will not fix a payload shape we do not handle, and enough
    // failures disable the subscription entirely.
    console.error("ZERNIO_WEBHOOK_FAIL", evt && evt.event, err.message);
    return res.status(200).json({ ok: false, error: String(err.message || err) });
  }
};

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verify(raw, header, secret) {
  if (!header || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  // Compared in constant time, and only when the lengths match — timingSafeEqual
  // throws on a length mismatch, which would itself be a signal.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const HANDLERS = {
  "comment.received": async (evt) => {
    const c = evt.comment || {};
    const author = c.author || {};
    if (!author.id) return { skipped: "no author id" };

    const key = social.socialKey(c.platform, author.id);
    const identity = await social.upsertIdentity(key, {
      platform: c.platform, platform_user_id: author.id,
      display_name: author.name, username: author.username,
      account_id: accountOf(evt), interaction_type: "comment"
    });

    const written = await social.recordMessage({
      message_id: "zrn_" + evt.id,
      kind: "Comment",
      platform: c.platform,
      identity_key: key,
      author_name: author.name,
      author_id: author.id,
      text: h.cleanMultiline(c.text, 4000),
      post_id: c.postId || c.platformPostId,
      account_id: accountOf(evt)
    });
    return { identity: key, written, contact: linked(identity) };
  },

  "message.received": async (evt) => {
    const m = evt.message || {};
    // Our own replies come back through the same feed. Scoring the campaign's
    // outgoing messages would put the campaign's own tone in its sentiment
    // chart, which is a mirror, not a measurement.
    if (m.direction && m.direction !== "incoming") return { skipped: "outgoing" };

    const sender = m.sender || m.from || m.author || {};
    let userId = sender.id || null;
    let name = sender.name || sender.username || null;

    /* Direct messages often carry a conversation and no sender. Look in our
     * own table first — an identity that has messaged before already knows
     * this conversation — and only then spend a call on the provider. */
    if (!userId && m.conversationId) {
      const cached = await at.findOne(at.T.socialIdentities,
        "{conversation_id}='" + at.esc(m.conversationId) + "'");
      if (cached) {
        userId = cached.fields.platform_user_id || null;
        name = name || cached.fields.display_name || null;
      }
    }
    if (!userId && m.conversationId) {
      const p = await social.conversationParticipant(m.conversationId);
      if (p && p.participantId) { userId = p.participantId; name = name || p.participantName; }
    }

    // Last resort: key on the conversation. Worse than a person, and far
    // better than losing the message.
    const key = userId ? social.socialKey(m.platform, userId) : "conv|" + m.platform + "|" + m.conversationId;
    const identity = await social.upsertIdentity(key, {
      platform: m.platform, platform_user_id: userId || undefined,
      display_name: name || undefined, conversation_id: m.conversationId,
      account_id: accountOf(evt), interaction_type: "dm"
    });

    const written = await social.recordMessage({
      message_id: "zrn_" + evt.id,
      kind: "Direct message",
      platform: m.platform,
      identity_key: key,
      author_name: name,
      author_id: userId,
      text: h.cleanMultiline(m.text, 4000),
      conversation_id: m.conversationId,
      account_id: accountOf(evt)
    });
    return { identity: key, written, contact: linked(identity) };
  },

  "conversation.started": async (evt) => {
    const c = evt.conversation || {};
    const pid = c.participantId || (c.participant && c.participant.id) || null;
    const name = c.participantName || (c.participant && c.participant.name) || null;
    const key = pid ? social.socialKey(c.platform, pid) : "conv|" + c.platform + "|" + c.id;

    await social.upsertIdentity(key, {
      platform: c.platform, platform_user_id: pid || undefined,
      display_name: name || undefined, conversation_id: c.id,
      account_id: accountOf(evt), interaction_type: "conversation_started"
    });
    // Recorded with no text, so the analyser will skip it. The row exists to
    // date the first contact, which is what makes a response-time number
    // possible later.
    const written = await social.recordMessage({
      message_id: "zrn_" + evt.id,
      kind: "Conversation started",
      platform: c.platform,
      identity_key: key,
      author_name: name,
      author_id: pid,
      conversation_id: c.id,
      account_id: accountOf(evt),
      analysed_at: at.nowIso()
    });
    return { identity: key, written };
  },

  "lead.received": async (evt) => {
    const lead = evt.lead || {};
    const { email, phone } = leadContact(lead.fields);
    if (!email && !phone) return { skipped: "no contact fields on lead" };

    const key = email ? social.emailKey(email) : social.phoneKey(phone);
    const identity = await social.upsertIdentity(key, {
      platform: "lead", email: email || undefined, phone: phone || undefined,
      account_id: accountOf(evt), interaction_type: "lead"
    });

    /* Keyed on the provider's leadgen id rather than the event id, so that a
     * lead arriving both here and through the Meta webhook is one row and not
     * two. The two paths are deliberately redundant — either can be down —
     * and redundancy is only useful if it does not double-count. */
    const written = await social.recordMessage({
      message_id: "lead_" + (lead.leadgenId || evt.id),
      kind: "Lead",
      platform: "lead",
      identity_key: key,
      author_name: nameFrom(lead.fields),
      account_id: accountOf(evt),
      // Nothing to score, and the field values are somebody's personal
      // details rather than an opinion.
      analysed_at: at.nowIso()
    });
    return { identity: key, written, contact: linked(identity) };
  }
};

const linked = (identity) =>
  !!(identity && identity.fields && identity.fields.contact && identity.fields.contact.length);

// Attribution is optional and never blocks capture: knowing which of our own
// accounts a comment landed on is useful, and losing the comment is not.
function accountOf(evt) {
  const o = evt.comment || evt.message || evt.conversation || evt.lead || {};
  return o.accountId || o.socialAccountId || evt.accountId || undefined;
}

/* Pull an email and phone out of a lead's answers without knowing the
 * question wording. Campaigns rename form fields constantly, and a map of
 * expected keys is a map that is wrong by the second form. */
function leadContact(fields) {
  const f = fields || {};
  let email = null, phone = null;
  for (const k of Object.keys(f)) {
    const v = typeof f[k] === "string" ? f[k].trim() : "";
    if (!v) continue;
    if (!email && EMAIL_RE.test(v)) email = v.toLowerCase();
    else if (!phone && PHONE_RE.test(v) && /phone|mobile|number/i.test(k)) phone = v;
  }
  // Second pass: any phone-shaped answer, when the key naming gave nothing.
  if (!phone) {
    for (const k of Object.keys(f)) {
      const v = typeof f[k] === "string" ? f[k].trim() : "";
      if (v && PHONE_RE.test(v) && !EMAIL_RE.test(v)) { phone = v; break; }
    }
  }
  return { email, phone };
}

function nameFrom(fields) {
  const f = fields || {};
  for (const k of Object.keys(f)) {
    if (/name/i.test(k) && typeof f[k] === "string" && f[k].trim()) return f[k].trim().slice(0, 120);
  }
  return undefined;
}

module.exports.HANDLERS = HANDLERS;
module.exports.leadContact = leadContact;
module.exports.verify = verify;
