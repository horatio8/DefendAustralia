// GET/POST /api/reception-invites — issue the invitations, and see who opened them.
//
// GET  shows the ledger for an event: issued, opened, registered, declined,
//      and the links themselves so they can be pasted into a mail merge.
// POST issues invitations from a list of people.
//
// The ledger is the reason these tokens are stored rather than signed. A
// signed link is cheaper and stateless and tells you nothing afterwards; the
// question a campaign actually asks the day before an event is "who has not
// opened theirs", and only a stored token can answer it.
//
// Issuing is idempotent on email: asking twice for the same person returns
// their existing token rather than minting a second one. Two live links for
// one guest means two rows on the door list under one name, and the person on
// the door has no way to tell which is real.

const h = require("./_lib/http");
const at = require("./_lib/airtable");
const reception = require("./_lib/reception");

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;
  if (!h.requireBasicAuth(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  if (!at.configured()) return res.status(503).json({ error: "airtable not configured" });
  if (!(await at.hasTable(at.T.receptionInvites))) {
    return res.status(503).json({ error: "the Reception Invites table does not exist in this base" });
  }

  const q = req.query || {};
  const slug = h.clean(q.event || (h.body(req) || {}).event, 60) || process.env.RECEPTION_EVENT_SLUG || "";
  if (!slug) return res.status(400).json({ error: "Which event? Pass ?event=<slug> or set RECEPTION_EVENT_SLUG." });

  if (req.method === "POST") return res.status(200).json(await issue(slug, h.body(req) || {}));

  const data = await ledger(slug);
  if (String(q.json || "") === "1") return res.status(200).json(data);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(html(data));
};

/* Issue invitations.
 *
 * People arrive as {people:[{first_name,last_name,email,mobile,seats}]}, which
 * is what a spreadsheet paste turns into. An entry with no email is refused:
 * without one there is nowhere to send the link, and an invitation nobody
 * receives still occupies a seat on the ledger. */
async function issue(slug, body) {
  const people = Array.isArray(body.people) ? body.people.slice(0, 500) : [];
  const out = { event: slug, issued: 0, existing: 0, rejected: 0, invitations: [] };
  const base = (process.env.SITE_URL || "https://" + (process.env.SITE_DOMAIN || "defendsacredground.com")).replace(/\/+$/, "");

  for (const p of people) {
    const email = at.normEmail(p.email);
    if (!h.validEmail(email)) { out.rejected++; continue; }

    let rec = await at.findOne(at.T.receptionInvites,
      "AND({event_slug}='" + at.esc(slug) + "',LOWER({email})='" + at.esc(email) + "')");

    if (rec) {
      out.existing++;
    } else {
      const token = reception.mintToken();
      const res = await at.create(at.T.receptionInvites, {
        invite_token: token,
        event_slug: slug,
        first_name: h.clean(p.first_name, 80),
        last_name: h.clean(p.last_name, 80),
        email,
        mobile: h.e164(p.mobile),
        seats: Math.max(1, Math.min(10, Number(p.seats) || 1)),
        status: "Issued",
        issued_at: at.nowIso(),
        note: h.clean(p.note, 500)
      });
      rec = { id: res.id, fields: { invite_token: token, first_name: p.first_name, email } };
      out.issued++;
    }

    out.invitations.push({
      email,
      first_name: rec.fields.first_name || "",
      link: base + "/reception?t=" + encodeURIComponent(rec.fields.invite_token)
    });
  }
  return out;
}

async function ledger(slug) {
  const rows = [];
  await at.walk(at.T.receptionInvites, {
    pageSize: 100,
    filterByFormula: "{event_slug}='" + at.esc(slug) + "'",
    sort: [{ field: "issued_at", direction: "asc" }],
    deadline: Date.now() + 15000
  }, (r) => {
    const f = r.fields || {};
    rows.push({
      first_name: f.first_name || "", last_name: f.last_name || "",
      email: f.email || "", seats: f.seats || 1,
      status: reception.pick(f.status) || "Issued",
      issued_at: f.issued_at || null, opened_at: f.opened_at || null, registered_at: f.registered_at || null,
      token: f.invite_token || ""
    });
  });

  const counts = { issued: rows.length, opened: 0, registered: 0, declined: 0, unopened: 0, seats: 0 };
  for (const r of rows) {
    if (r.opened_at) counts.opened++; else counts.unopened++;
    if (r.status === "Registered") { counts.registered++; counts.seats += r.seats; }
    if (r.status === "Declined") counts.declined++;
  }
  return { event: slug, counts, rows };
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const when = (v) => (v ? String(v).slice(0, 16).replace("T", " ") : "—");

function html(d) {
  const base = (process.env.SITE_URL || "https://" + (process.env.SITE_DOMAIN || "defendsacredground.com")).replace(/\/+$/, "");
  const c = d.counts;
  return "<!doctype html><meta charset=utf-8><title>Invitations</title>" +
    "<meta name=robots content=noindex><meta name=viewport content='width=device-width,initial-scale=1'>" +
    "<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f6f6f4;color:#111}" +
    "header{padding:28px 24px 8px;max-width:960px;margin:0 auto}h1{font-size:20px;margin:0 0 6px}" +
    "main{padding:12px 24px 48px;max-width:960px;margin:0 auto}" +
    ".note{color:#555;margin:0 0 10px;max-width:70ch;font-size:13px}" +
    ".cards{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}" +
    ".card{background:#fff;border:1px solid #e3e3df;padding:12px 14px;min-width:130px;flex:1}" +
    ".card b{display:block;font-size:22px;font-variant-numeric:tabular-nums}" +
    ".card span{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#666}" +
    "table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e3e3df}" +
    "th,td{padding:8px 12px;border-bottom:1px solid #eee;text-align:left;font-size:13px}" +
    "th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#666}" +
    "tr:last-child td{border-bottom:0}code{font-size:11px;color:#666;word-break:break-all}" +
    ".no{color:#8a4b00}</style>" +
    "<header><h1>Invitations — " + esc(d.event) + "</h1>" +
    "<p class=note>One link per person, published nowhere but their own email. " +
    "Never send somebody else's link: it registers its holder, whoever opens it. " +
    "Add ?json=1 for the raw list, or POST {\"people\":[{\"first_name\",\"last_name\",\"email\",\"seats\"}]} " +
    "to issue more — asking twice for the same address returns their existing link rather than a second one.</p>" +
    '<div class=cards>' +
    [["Issued", c.issued], ["Opened", c.opened], ["Not opened", c.unopened],
     ["Coming", c.registered], ["Seats", c.seats], ["Declined", c.declined]]
      .map(([k, v]) => '<div class=card><span>' + k + '</span><b>' + v + "</b></div>").join("") +
    "</div></header><main><table>" +
    "<tr><th>Guest</th><th>Status</th><th>Opened</th><th>Answered</th><th>Link</th></tr>" +
    d.rows.map((r) =>
      "<tr><td>" + esc((r.first_name + " " + r.last_name).trim() || "—") +
      "<div class=note style='margin:0'>" + esc(r.email) + (r.seats > 1 ? " · " + r.seats + " seats" : "") + "</div></td>" +
      "<td>" + esc(r.status) + "</td>" +
      "<td" + (r.opened_at ? ">" : ' class=no>') + when(r.opened_at) + "</td>" +
      "<td>" + when(r.registered_at) + "</td>" +
      "<td><code>" + esc(base) + "/reception?t=" + esc(r.token) + "</code></td></tr>").join("") +
    "</table></main>";
}

module.exports.issue = issue;
module.exports.ledger = ledger;
