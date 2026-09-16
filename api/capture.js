// POST /api/capture — email-action page session captures.
//
// Exists so a person who types their email and then leaves is still a lead.
// Captures are keyed on session_id and guarded by a monotonic seq, because
// beacons sent with keepalive can arrive out of order.
//
// A completed send is a real supporter: Nucleus first, then the queue. An
// earlier keystroke capture is not, and only goes to the queue.
//
// The queue is what makes this survive a surge. The request path writes one
// row and returns; the drain expands it into Contacts, Events and the typed
// tables at a rate Airtable will accept. That is the difference between a
// page that can take a thousand people in an hour and one that starts
// returning errors to supporters at the two hundredth.
//
// Which campaign a capture belongs to decides the queue type, the CRM tags
// and which lead page it is posted to. Those live in one registry, because
// the writer and the reader of the queue have to agree on the type and the
// failure when they do not is silent.
const nucleus = require("./_lib/nucleus");
const queue = require("./_lib/queue");
const at = require("./_lib/airtable");
const actions = require("./_lib/actions");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  const b = req.body && typeof req.body === "object" ? req.body : safeParse(req.body);
  if (!b || !str(b.session_id)) return res.status(200).json({ ok: true });

  const email = at.normEmail(b.email);
  const status = str(b.status) || (email ? "partial" : "started");
  const campaign = actions.queueType(str(b.campaign));
  const action = actions.get(campaign);
  const p = {
    campaign,
    session_id: str(b.session_id),
    first_name: str(b.first), last_name: str(b.last),
    email, mobile: str(b.mobile),
    status, seq: Number(b.seq) || 0,
    sent_subject: b.sent_subject ? String(b.sent_subject).slice(0, 250) : "",
    sent_body: b.sent_body ? String(b.sent_body) : "",
    variation_shown: b.variation_shown != null ? Number(b.variation_shown) : null,
    ai_rewrite_count: b.ai_rewrite_count != null ? Number(b.ai_rewrite_count) : null
  };

  /* Only a completed send is worth a place in the CRM. Everything earlier is
   * a keystroke, and posting those would fill the lead page with half-typed
   * addresses that can never be mailed and can never be cleaned out. */
  let cnError = "";
  let entryId = null;
  if (status === "send_clicked" && email) {
    const person = {
      email, first_name: p.first_name, last_name: p.last_name, mobile: p.mobile
    };
    try {
      await nucleus.upsertProfile({ ...person, tags: action.tags });
    } catch (err) {
      cnError = String(err.message || err);
      console.error("CN_PROFILE_FAIL", campaign, cnError);
    }
    /* The lead page, when one is configured for this campaign. It is a second
     * write and a separate failure: a profile that lands without its form
     * entry is still a supporter the campaign can mail, so this must not be
     * allowed to take the profile down with it. */
    const form = actions.formId(campaign);
    if (form) {
      try {
        entryId = await nucleus.submitEntryTo(form, {
          ...person, campaign, source: "email-action"
        });
      } catch (err) {
        const msg = String(err.message || err);
        cnError = cnError ? cnError + "; " + msg : msg;
        console.error("CN_LEADPAGE_FAIL", campaign, msg);
      }
    }
  }

  let queued = { queued: false };
  try { queued = await queue.enqueue(campaign, p, { entryId, error: cnError }); }
  catch (err) { console.error("QUEUE_CAPTURE_FAIL", err.message); }
  if (!queued.queued) console.error("CAPTURE_UNSTORED", JSON.stringify(p));

  return res.status(200).json({ ok: true });
};

function str(v) { return v == null ? "" : String(v).trim(); }
function safeParse(v) { try { return JSON.parse(v); } catch (e) { return null; } }
