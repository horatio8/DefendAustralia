// POST /api/share-signup — mint a share code for someone we do not know.
//
// The last resort on the share page: no Stripe session, no stored code, so the
// visitor typed their email. If we already have them, they get the code they
// already own, because minting a second one would split their results across
// two rows. If we do not, they become a contact and get one.
//
// The code is derived from the email rather than randomly generated, so it is
// the same code every time whichever path produces it, including the one the
// browser computes for itself before it has spoken to the server at all.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const queue = require("./_lib/queue");
const { refCodeFor } = require("./_lib/refcode");

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "POST")) return;

  const b = h.body(req) || {};
  const email = at.normEmail(h.clean(b.email, 160));
  if (!h.validEmail(email)) {
    return res.status(400).json({ error: "That does not look like an email address. Check it and try again." });
  }

  const first = h.clean(b.first || b.first_name, 60);
  const code = refCodeFor(email);

  // Existing supporter: hand back the code that is already theirs.
  if (at.configured()) {
    try {
      const existing = await at.findOne(at.T.contacts, "LOWER({email})='" + at.esc(email) + "'");
      if (existing) {
        const owned = String(existing.fields.referral_code || "").toUpperCase();
        if (owned) {
          return res.status(200).json({ ok: true, code: owned, first_name: existing.fields.first_name || first });
        }
        // A contact from before codes existed. Fill it rather than mint a row.
        await at.update(at.T.contacts, existing.id, { referral_code: code, last_updated: at.nowIso() });
        return res.status(200).json({ ok: true, code, first_name: existing.fields.first_name || first });
      }
    } catch (err) {
      // Fall through to the queue: a lookup failure must not cost them a link.
      console.error("SHARE_SIGNUP_LOOKUP_FAIL", err.message);
    }
  }

  try {
    await queue.enqueue("share_signup", {
      email, first_name: first, referral_code: code,
      source_url: h.clean(b.source_url, 300)
    }, null);
  } catch (err) {
    console.error("QUEUE_SHARE_SIGNUP_FAIL", err.message);
  }

  // The code is a pure function of the email, so it is correct to return it
  // even when the row write is still in the queue behind this response.
  return res.status(200).json({ ok: true, code, first_name: first });
};
