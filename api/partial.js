// POST /api/partial — a petition form someone started and did not finish.
//
// Dropped into the Lapse Queue keyed on email. A sweep later checks whether a
// signature arrived and, if not, the person is worth one follow-up. Waiting
// rows are replaced rather than stacked, so one hesitant supporter is one row.
const at = require("./_lib/airtable");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  const b = req.body && typeof req.body === "object" ? req.body : safeParse(req.body);
  res.status(200).json({ ok: true });
  if (!b) return;
  try { await queue(b); } catch (err) { console.error("PARTIAL_FAIL", err.message); }
};

async function queue(b) {
  if (!at.configured()) return;
  const email = at.normEmail(b.email);
  if (!email) return; // nothing to follow up

  // Already signed? Then this was just a keystroke on the way to finishing.
  const signed = await at.findOne(at.T.signatures, "LOWER({email})='" + at.esc(email) + "'");
  if (signed) return;

  const fields = {
    form: b.form === "donation" ? "Donation" : "Petition",
    first_name: str(b.first), last_name: str(b.last), email,
    mobile: str(b.mobile), status: "Waiting", created_at: at.nowIso()
  };
  const existing = await at.findOne(at.T.lapse,
    "AND(LOWER({email})='" + at.esc(email) + "',{status}='Waiting')");
  if (existing) await at.update(at.T.lapse, existing.id, fields);
  else await at.create(at.T.lapse, { ...fields, lapse_id: at.uuid() });
}

function str(v) { return v == null ? "" : String(v).trim(); }
function safeParse(v) { try { return JSON.parse(v); } catch (e) { return null; } }
