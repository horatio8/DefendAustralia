// GET /api/identity-resolver — is this commenter somebody we already know?
//
// Links an Identity to a Contact, and only ever on a key that cannot be
// wrong: a matching email address or a matching mobile number. Never a name.
//
// The temptation is obvious and the answer is no. Matching "John Smith" on
// Facebook to "John Smith" in the contact list would link hundreds of people
// and be wrong about most of them, and a wrong link is not a cosmetic error —
// it attributes one person's donations, opt-outs and stance to another, and
// there is no way to find them again afterwards to unpick it. An unresolved
// identity costs nothing; a wrong one corrupts the record permanently.
//
// So most identities stay Unresolved forever, and that is the correct
// outcome. Somebody who comments from a Facebook account and never gives an
// email is not in the contact list, and pretending otherwise would inflate
// every number the campaign reports.
//
// ?limit=N caps the work. Runs nightly.

const h = require("./_lib/http");
const at = require("./_lib/airtable");

const BUDGET_MS = 50000;

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;
  if (!h.requireCron(req, res)) return;
  return res.status(200).json(await run(Math.min(2000, Number((req.query || {}).limit) || 500)));
};

async function run(limit) {
  const started = Date.now();
  const out = { examined: 0, linked: 0, no_key: 0, no_match: 0 };
  if (!at.configured()) return { ...out, error: "airtable not configured" };
  if (!(await at.hasTable(at.T.socialIdentities))) {
    return { ...out, error: "the Identities table does not exist in this base" };
  }

  const pending = [];
  await at.walk(at.T.socialIdentities, {
    pageSize: 100,
    // Ignored is a human saying "stop offering me this one". It is never
    // reconsidered by code.
    filterByFormula: "AND({resolution_status}!='Linked',{resolution_status}!='Ignored')",
    fields: ["identity_key", "email", "phone", "display_name"],
    maxRecords: limit,
    deadline: started + BUDGET_MS * 0.4
  }, (r) => pending.push(r));

  for (const rec of pending) {
    if (Date.now() - started > BUDGET_MS) break;
    out.examined++;
    const f = rec.fields || {};
    const email = at.normEmail(f.email);
    const phone = h.e164(f.phone);

    if (!email && !phone) { out.no_key++; continue; }

    let contact = null;
    if (email) {
      contact = await at.findOne(at.T.contacts, "LOWER({email})='" + at.esc(email) + "'");
    }
    if (!contact && phone) {
      contact = await at.findOne(at.T.contacts, "{mobile}='" + at.esc(phone) + "'");
    }
    if (!contact) { out.no_match++; continue; }

    await at.update(at.T.socialIdentities, rec.id, {
      contact: [contact.id],
      resolution_status: "Linked"
    });
    out.linked++;
  }

  out.complete = out.examined >= pending.length;
  return out;
}

module.exports.run = run;
