// POST /api/partial — someone typed their details and did not finish.
//
// A partial is a real lead. The browser fires this on blur of the name and
// email fields, so a person who fills half the petition and leaves is still
// captured. Nothing here is treated as a signature: it never touches the
// petition form in Nucleus and never moves the counter. The drain worker
// creates a Nucleus profile tagged as an unfinished starter, which is what
// makes the follow-up possible.
//
// Rows are keyed on email and replaced rather than stacked, so one hesitant
// supporter is one row no matter how many times the beacon fires.
const queue = require("./_lib/queue");
const at = require("./_lib/airtable");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  const b = req.body && typeof req.body === "object" ? req.body : safeParse(req.body);
  if (!b) return res.status(200).json({ ok: true });

  const email = at.normEmail(b.email);
  // Without an email there is no one to follow up and nothing to dedupe on.
  if (!email) return res.status(200).json({ ok: true, captured: false });

  const p = {
    form: b.form === "donation" ? "Donation" : "Petition",
    first_name: str(b.first), last_name: str(b.last), email,
    mobile: str(b.mobile), postcode: str(b.postcode),
    source_url: str(b.source_url)
  };

  let queued = { queued: false };
  try { queued = await queue.enqueue("partial", p, null); }
  catch (err) { console.error("QUEUE_PARTIAL_FAIL", err.message); }
  if (!queued.queued) console.error("PARTIAL_UNSTORED", JSON.stringify(p));

  return res.status(200).json({ ok: true, captured: !!queued.queued });
};

function str(v) { return v == null ? "" : String(v).trim(); }
function safeParse(v) { try { return JSON.parse(v); } catch (e) { return null; } }
