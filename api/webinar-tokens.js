// GET /api/webinar-tokens — mint the magic links for an invitation send.
//
//   ?slug=tuesday&mode=csv          every donor with an email, as CSV
//   ?slug=tuesday&email=a@b.com     one link, for resending to a person
//   &days=14                        how long the links live
//
// CSV is the normal mode: it goes straight into the CRM send as a merge
// column, so the invitation carries a per-recipient link without the CRM
// needing to know anything about how the tokens work.
//
// Filtered to donors by default, because that is who a donor briefing is for,
// and a briefing whose link reached the whole list is not a donor briefing any
// more. ?all=1 overrides it for a general supporter update.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const token = require("./_lib/token");
const { allRows } = require("./_lib/ab");

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET")) return;
  if (!h.requireBasicAuth(req, res)) return;
  if (!token.configured()) return res.status(503).json({ error: "WEBINAR_TOKEN_SECRET not set" });
  if (!at.configured()) return res.status(503).json({ error: "airtable not configured" });

  const q = req.query || {};
  const slug = h.clean(q.slug, 60);
  const days = Math.min(90, Math.max(1, Number(q.days || 14)));
  const one = at.normEmail(h.clean(q.email, 160));
  const all = q.all === "1";
  if (!slug) return res.status(400).json({ error: "slug required" });

  const site = "https://" + (process.env.SITE_DOMAIN || "defendsacredground.com");
  const linkFor = (contactId, email) =>
    site + "/supporters/" + encodeURIComponent(slug) + "?t=" +
    encodeURIComponent(token.mint({ contact_id: contactId, email, slug }, days));

  // A single resend.
  if (one) {
    const c = await at.findOne(at.T.contacts, "LOWER({email})='" + at.esc(one) + "'").catch(() => null);
    if (!c) return res.status(404).json({ error: "no such contact" });
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({
      email: one, name: (c.fields.first_name || "") + " " + (c.fields.last_name || ""),
      url: linkFor(c.fields.contact_id || "", one), expires_days: days
    });
  }

  let rows = [];
  try {
    const formula = all
      ? "{email}!=''"
      : "AND({email}!='',{lifetime_donations}>0)";
    rows = await allRows(at.T.contacts, formula, 20000);
  } catch (err) {
    console.error("WEBINAR_TOKENS_FAIL", err.message);
    return res.status(502).json({ error: "could not read contacts" });
  }

  const csv = "email,first_name,last_name,webinar_url\n" + rows.map((r) => {
    const email = at.normEmail(r.fields.email);
    if (!email) return "";
    return [
      cell(email), cell(r.fields.first_name || ""), cell(r.fields.last_name || ""),
      cell(linkFor(r.fields.contact_id || "", email))
    ].join(",");
  }).filter(Boolean).join("\n") + "\n";

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="webinar-' + slug + '-links.csv"');
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).send(csv);
};

function cell(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
