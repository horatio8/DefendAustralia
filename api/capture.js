// POST /api/capture — minister email-action page session captures.
//
// Exists so a person who types their email and then leaves is still a lead.
// Captures are keyed on session_id and guarded by a monotonic seq, because
// beacons sent with keepalive can arrive out of order.
//
// A completed send is a real supporter: Nucleus first, then the queue. An
// earlier keystroke capture is not, and only goes to the queue.
const nucleus = require("./_lib/nucleus");
const queue = require("./_lib/queue");
const at = require("./_lib/airtable");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  const b = req.body && typeof req.body === "object" ? req.body : safeParse(req.body);
  if (!b || !str(b.session_id)) return res.status(200).json({ ok: true });

  const email = at.normEmail(b.email);
  const status = str(b.status) || (email ? "partial" : "started");
  const p = {
    session_id: str(b.session_id),
    first_name: str(b.first), last_name: str(b.last),
    email, mobile: str(b.mobile),
    status, seq: Number(b.seq) || 0,
    sent_subject: b.sent_subject ? String(b.sent_subject).slice(0, 250) : "",
    sent_body: b.sent_body ? String(b.sent_body) : "",
    variation_shown: b.variation_shown != null ? Number(b.variation_shown) : null,
    ai_rewrite_count: b.ai_rewrite_count != null ? Number(b.ai_rewrite_count) : null
  };

  // Only a completed send is worth a Nucleus profile. Everything earlier is a
  // keystroke and would put half-typed addresses into the CRM.
  let cnError = "";
  if (status === "send_clicked" && email) {
    try {
      await nucleus.upsertProfile({
        email, first_name: p.first_name, last_name: p.last_name, mobile: p.mobile,
        tags: ["Defend Sacred Ground", "Contacted the Minister"]
      });
    } catch (err) {
      cnError = String(err.message || err);
      console.error("CN_MINISTER_FAIL", cnError);
    }
  }

  let queued = { queued: false };
  try { queued = await queue.enqueue("minister", p, { entryId: null, error: cnError }); }
  catch (err) { console.error("QUEUE_CAPTURE_FAIL", err.message); }
  if (!queued.queued) console.error("CAPTURE_UNSTORED", JSON.stringify(p));

  return res.status(200).json({ ok: true });
};

function str(v) { return v == null ? "" : String(v).trim(); }
function safeParse(v) { try { return JSON.parse(v); } catch (e) { return null; } }
