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

  let accepted = 0;
  for (const lead of leads) {
    try { await ingest(lead); accepted++; }
    catch (err) { console.error("META_LEAD_FAIL", err.message, JSON.stringify(lead).slice(0, 500)); }
  }

  // Always 200. Meta retries aggressively on anything else and every lead here
  // is deduped on leadgen_id, so a retry is safe but a retry storm is not.
  return res.status(200).json({ ok: true, leads: leads.length, accepted });
};

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

  // Flat relay payload.
  const f = b.fields && typeof b.fields === "object" ? b.fields : b;
  out.push({
    leadgen_id: str(b.leadgen_id || b.lead_id || b.id),
    form_id: str(b.form_id), form_name: str(b.form_name),
    ad_id: str(b.ad_id), ad_name: str(b.ad_name),
    adset_id: str(b.adset_id), adset_name: str(b.adset_name),
    campaign_id: str(b.campaign_id), campaign_name: str(b.campaign_name),
    platform: str(b.platform), partner: str(b.partner || b.source),
    created_time: str(b.created_time),
    fields: {
      first_name: titleName(f.first_name || f["First name"] || f.firstname),
      last_name: titleName(f.last_name || f["Last name"] || f.lastname),
      email: str(f.email || f["Email"]),
      phone: str(f.phone_number || f.phone || f["Phone number"] || f.mobile),
      postcode: str(f.post_code || f.postcode || f.zip || f["Post code"])
    },
    raw: b
  });
  return out;
}

// Meta's field_data is an array of {name, values:[]} rather than an object.
function fieldsFrom(fieldData) {
  const o = {};
  for (const f of fieldData || []) {
    o[String(f.name || "").toLowerCase()] = (f.values || [])[0] || "";
  }
  return {
    first_name: titleName(o.first_name), last_name: titleName(o.last_name),
    email: str(o.email), phone: str(o.phone_number || o.phone),
    postcode: str(o.post_code || o.zip)
  };
}

async function ingest(lead) {
  if (isTestLead(lead.fields)) return;
  const email = at.normEmail(lead.fields.email);
  if (!email) throw new Error("lead has no email");

  // leadgen_id is Meta's own id for this submission and is the idempotency
  // key: Meta redelivers, and a redelivery must not become a second signature.
  if (lead.leadgen_id && at.configured()) {
    const seen = await at.findOne(at.T.signatures,
      "{meta_leadgen_id}='" + at.esc(lead.leadgen_id) + "'");
    if (seen) return;
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
  let cnEntryId = null, cnError = "";
  try {
    cnEntryId = await nucleus.submitEntry("petition", {
      first_name: p.first_name, last_name: p.last_name, email: p.email,
      phone: p.mobile, postcode: p.postcode,
      utm_source: "meta", utm_medium: "lead_ad", utm_campaign: lead.campaign_name || campaign
    });
  } catch (err) {
    cnError = err.status === 422 ? "" : String(err.message || err);
    if (cnError) console.error("CN_META_LEAD_FAIL", cnError);
  }

  await queue.enqueue("meta_lead", p, { entryId: cnEntryId, error: cnError });
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
