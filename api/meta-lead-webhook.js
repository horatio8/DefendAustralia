// POST /api/meta-lead-webhook — a signature captured inside Facebook.
//
// Meta Lead Ads collect the form inside the feed, so the supporter never
// touches the site and none of the site's capture paths ever run. The lead
// arrives here instead, relayed by Zapier or by Meta's own webhook, and has to
// come out the other side indistinguishable from a signature typed on the
// petition page: same Contact, same Event, same Petition Signatures row, same
// Campaign Nucleus entry.
//
// What it carries that a website signature cannot is the full ad attribution:
// which ad, in which ad set, in which campaign, produced this person. Those
// columns are the reason lead ads are worth running, so they are written even
// when they arrive with awkward names, and the raw payload is kept whole.
//
// GET on this path answers Meta's subscription handshake, which is the one
// thing that must work before any lead can arrive.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const nucleus = require("./_lib/nucleus");
const queue = require("./_lib/queue");
const { refCodeFor } = require("./_lib/refcode");

// Well inside the 60s maxDuration in vercel.json, so the answer goes back as
// a 200 with a count rather than as a gateway timeout with no information in
// it at all.
const TIME_BUDGET_MS = 45000;

// Which Meta form feeds which petition. Without a mapping a lead still lands,
// under the default campaign, rather than being dropped for being unexpected.
function campaignFor(formId) {
  let map = {};
  try { map = JSON.parse(process.env.META_LEAD_FORM_MAP || "{}"); } catch (e) { /* default below */ }
  return map[formId] || process.env.DEFAULT_PETITION_SLUG || "defend-sacred-ground";
}

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;

  // Meta's verification handshake: echo hub.challenge for the right token.
  if (req.method === "GET") {
    const q = req.query || {};
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] &&
        q["hub.verify_token"] === process.env.META_LEAD_VERIFY_TOKEN) {
      return res.status(200).send(String(q["hub.challenge"] || ""));
    }
    return res.status(403).json({ error: "verification failed" });
  }

  // A shared secret on the relay. Meta's own webhook signs with an app secret;
  // a Zapier relay cannot, so a token in the body or header covers both.
  const expected = process.env.META_LEAD_SECRET;
  if (expected) {
    const given = h.clean((req.headers && req.headers["x-lead-token"]) || (h.body(req) || {}).token, 200);
    if (given !== expected) return res.status(401).json({ error: "unauthorised" });
  }

  const b = h.body(req) || {};
  const leads = normaliseLeads(b);
  if (!leads.length) return res.status(200).json({ ok: true, leads: 0 });

  /* Bounded by the clock, not by the size of the batch.
   *
   * Each lead costs an Airtable dedupe read, a Nucleus write and a queue
   * write, and none of those has a guaranteed latency: Airtable throttles at
   * five requests a second per base and the retry helper backs off when it
   * does. A batch that is fine at noon is a timeout at eight, and a timeout
   * returns 504 having already written some of the leads, with no way for
   * the caller to know which.
   *
   * So the loop stops while there is still time to answer. What did not fit
   * is reported as remaining, and the caller sends the same rows again —
   * free, because everything already written is skipped on its leadgen_id.
   */
  const started = Date.now();
  let accepted = 0, processed = 0;
  for (const lead of leads) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    processed++;
    try { await ingest(lead); accepted++; }
    catch (err) { console.error("META_LEAD_FAIL", err.message, JSON.stringify(lead).slice(0, 500)); }
  }

  // Always 200. Meta retries aggressively on anything else and every lead here
  // is deduped on leadgen_id, so a retry is safe but a retry storm is not.
  return res.status(200).json({
    ok: true, leads: leads.length, accepted,
    remaining: leads.length - processed
  });
};

// The puller in meta-lead-pull.js runs leads through this same function
// rather than reimplementing it. Two paths that both create signatures must
// not be able to drift: the dedupe, the test-lead drop, the name splitting
// and the Nucleus call are the parts that matter, and there is exactly one
// copy of each.
module.exports.ingest = ingest;
module.exports.fieldsFrom = fieldsFrom;
module.exports.campaignFor = campaignFor;

/* Two shapes arrive at this endpoint and they look nothing alike.
 *
 * Meta's own webhook nests everything under entry[].changes[].value and gives
 * only ids, expecting the receiver to call the Graph API for the answers.
 * Zapier flattens the lead into top-level keys with human labels. Both are
 * normalised here so the ingest below sees one shape. */
function normaliseLeads(b) {
  const out = [];

  if (Array.isArray(b.entry)) {
    for (const entry of b.entry) {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        out.push({
          leadgen_id: str(v.leadgen_id),
          form_id: str(v.form_id),
          ad_id: str(v.ad_id), adgroup_id: str(v.adgroup_id),
          campaign_id: str(v.campaign_id), adset_id: str(v.adset_id),
          created_time: v.created_time ? new Date(v.created_time * 1000).toISOString() : "",
          platform: str(v.platform),
          fields: fieldsFrom(v.field_data),
          raw: v
        });
      }
    }
    return out;
  }

  // A batch of flat leads. The Apps Script that reads Meta's Google Sheets
  // export sends these: one request per row would be several hundred calls to
  // clear a backlog, and Apps Script is billed in execution minutes.
  if (Array.isArray(b.leads)) {
    for (const lead of b.leads) out.push(flatLead(lead));
    return out;
  }

  out.push(flatLead(b));
  return out;
}

/* One lead in the shape a relay sends: everything at the top level, human
 * labels, and whatever casing the source felt like using. */
function flatLead(b) {
  const f = b.fields && typeof b.fields === "object" ? b.fields : b;
  const named = splitName(
    f.first_name || f["First name"] || f.firstname,
    f.last_name || f["Last name"] || f.lastname,
    f.full_name || f["Full name"] || f.fullname || f.name
  );
  return {
    leadgen_id: str(b.leadgen_id || b.lead_id || b.id),
    form_id: str(b.form_id), form_name: str(b.form_name),
    ad_id: str(b.ad_id), ad_name: str(b.ad_name),
    adset_id: str(b.adset_id), adset_name: str(b.adset_name),
    campaign_id: str(b.campaign_id), campaign_name: str(b.campaign_name),
    platform: str(b.platform), partner: str(b.partner || b.source),
    created_time: str(b.created_time),
    fields: {
      first_name: named.first,
      last_name: named.last,
      email: str(f.email || f["Email"]),
      phone: str(f.phone_number || f.phone || f["Phone number"] || f.mobile),
      postcode: str(f.post_code || f.postcode || f.zip || f["Post code"])
    },
    raw: b
  };
}

// Meta's field_data is an array of {name, values:[]} rather than an object.
function fieldsFrom(fieldData) {
  const o = {};
  for (const f of fieldData || []) {
    o[String(f.name || "").toLowerCase()] = (f.values || [])[0] || "";
  }
  const named = splitName(o.first_name, o.last_name, o.full_name);
  return {
    first_name: named.first, last_name: named.last,
    email: str(o.email), phone: str(o.phone_number || o.phone),
    postcode: str(o.post_code || o.zip)
  };
}

async function ingest(lead) {
  if (isTestLead(lead.fields)) return;
  const email = at.normEmail(lead.fields.email);
  if (!email) throw new Error("lead has no email");

  // leadgen_id is Meta's own id for this submission and is the idempotency
  // key: Meta redelivers, a relay re-sends, and neither may become a second
  // signature.
  if (lead.leadgen_id && at.configured()) {
    if (await seenBefore(lead.leadgen_id)) return;
  }

  const campaign = campaignFor(lead.form_id);
  const p = {
    first_name: lead.fields.first_name, last_name: lead.fields.last_name,
    email, mobile: h.e164(lead.fields.phone), postcode: lead.fields.postcode,
    campaign, consent: true, referral_code: refCodeFor(email),
    lead_source: "Meta Lead Ad",
    source_url: "https://facebook.com/leadgen/" + (lead.form_id || ""),
    meta_leadgen_id: lead.leadgen_id, meta_form_id: lead.form_id,
    meta_form_name: lead.form_name, meta_ad_id: lead.ad_id, meta_ad_name: lead.ad_name,
    meta_adset_id: lead.adset_id, meta_adset_name: lead.adset_name,
    meta_campaign_id: lead.campaign_id, meta_campaign_name: lead.campaign_name,
    meta_platform: lead.platform, meta_partner: lead.partner,
    meta_created_time: lead.created_time
  };

  // Nucleus first, exactly as a website signature does, so the counter on the
  // site and the CRM stay one number.
  //
  // Asked whether it already has this person before being told about them.
  // The website signup has always done this; the lead path never did, and
  // Nucleus is the store that was actually being duplicated, so the check
  // belongs here more than anywhere.
  let cnEntryId = null, cnError = "", cnDuplicate = false;
  try {
    cnDuplicate = await nucleus.entryExists("petition", email);
  } catch (err) {
    // Unknown rather than false. A failed lookup must not become a reason to
    // write a second entry.
    console.error("CN_LEAD_DUP_CHECK_FAIL", err.message);
    cnDuplicate = true;
  }

  try {
    if (cnDuplicate) throw { skip: true };
    cnEntryId = await nucleus.submitEntry("petition", {
      first_name: p.first_name, last_name: p.last_name, email: p.email,
      phone: p.mobile, postcode: p.postcode,
      utm_source: "meta", utm_medium: "lead_ad", utm_campaign: lead.campaign_name || campaign
    });
  } catch (err) {
    // A duplicate is not a failure, and neither is a 422: Nucleus answers
    // that when it already holds the address.
    if (!err || !err.skip) {
      cnError = err.status === 422 ? "" : String(err.message || err);
      if (cnError) console.error("CN_META_LEAD_FAIL", cnError);
    }
  }

  // Queued regardless, so Airtable keeps the ad attribution for a supporter
  // Nucleus already had. The drain dedupes on leadgen_id before it writes a
  // signature row, so this cannot double the count either.
  await queue.enqueue("meta_lead", p, { entryId: cnEntryId, error: cnError });
}

/* Has this exact submission been through here before?
 *
 * Two tables, because the answer is in neither one alone.
 *
 * Petition Signatures is the durable record and the obvious place to look. It
 * is also the wrong place to look on its own, because this endpoint does not
 * write it: it appends to the Ingest Queue and the drain expands that into a
 * signature later. The drain moves 25 rows a minute. A relay clearing a
 * backlog moves nearer 200. So the queue grows about eight times faster than
 * it drains, the signature row for a lead received a minute ago does not
 * exist yet, and a re-send of that same lead finds nothing and writes a
 * second Nucleus entry.
 *
 * That is not a hypothetical. It is what emptied a 4,150 row spreadsheet into
 * a petition that counted 12,185.
 *
 * The queue is the missing half: its rows are written synchronously, on this
 * request, so anything already accepted is visible immediately. Searched
 * inside the stored payload because the queue keeps the submission as JSON
 * rather than as columns.
 */
async function seenBefore(leadgenId) {
  const id = at.esc(leadgenId);

  const signed = await at.findOne(at.T.signatures, "{meta_leadgen_id}='" + id + "'");
  if (signed) return true;

  const pending = await at.findOne(at.T.queue,
    "AND({type}='meta_lead',SEARCH('\"meta_leadgen_id\":\"" + id + "\"',{payload}))");
  return !!pending;
}

/* Meta prefixes its own exported values so a spreadsheet cannot mangle them:
 * l: on the lead id, f: on the form, ag:/as:/c: on the ad ids, p: on the
 * phone and z: on the postcode. The native webhook sends clean values, but a
 * relay built on Meta's Google Sheets destination forwards the prefixes
 * intact, and "z:5127" written into a postcode field is a silent corruption
 * nobody notices until somebody tries to sort by state. Stripped on the way
 * in, because the cost is nothing and the failure is invisible. */
function str(v) {
  return String(v == null ? "" : v).trim().replace(/^(?:l|f|ag|as|c|p|z):/, "").trim();
}

/* Meta writes one test lead into every destination the moment a form is first
 * connected: dummy field values wrapped in angle brackets and test@meta.com.
 * It is not a person, and left alone it becomes a signature on a public
 * counter and an enrolment in the donation ask. */
function isTestLead(fields) {
  const email = String(fields.email || "").toLowerCase();
  if (email === "test@meta.com" || email.endsWith("@meta.com")) return true;
  return Object.values(fields).some((v) => /^<test lead:/i.test(String(v || "")));
}

/* Meta's lead form builder offers "full name" as one question and it is the
 * default, so a form built in a hurry collects one box and the first/last
 * fields this endpoint was written around never arrive at all. Those leads
 * used to land with no name whatever, which turns every later email into
 * "Dear ," and makes the row useless for a phone bank.
 *
 * Split on the last space rather than the first: Australian given names run
 * to two words far more often than surnames do, so "Mary Anne Fitzgerald"
 * is Mary Anne Fitzgerald and not Mary Anne-Fitzgerald. A single word is a
 * given name with no surname, which is what a supporter who typed only
 * "Sue" actually gave us — inventing a surname from it would be worse. */
function splitName(first, last, full) {
  const f = titleName(first), l = titleName(last);
  if (f || l) return { first: f, last: l };

  const whole = titleName(full);
  if (!whole) return { first: "", last: "" };
  const cut = whole.lastIndexOf(" ");
  if (cut < 0) return { first: whole, last: "" };
  return { first: whole.slice(0, cut).trim(), last: whole.slice(cut + 1).trim() };
}

/* Lead ad forms take whatever the keyboard gives them, so a sixth of the
 * first names arrive entirely lower case. Titled per word rather than per
 * string, since a real given name here can be two words. Anything already
 * carrying an interior capital is left alone: McArthur and O'Brien are how
 * people spell their own names and this must not "fix" them. */
function titleName(s) {
  const v = str(s);
  if (!v) return "";
  // Shouted names get fixed; mixed case is left exactly as given.
  const shouted = v === v.toUpperCase() && /[A-Z]/.test(v);
  if (!shouted && /[A-Z]/.test(v.slice(1))) return v;
  return v.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
}
