// GET /api/meta-lead-pull — fetch leads from Meta instead of waiting for them.
//
// The webhook is the fast path and it stays the fast path. This is the other
// half, and the campaign needs both for the same reason the Stripe backfill
// exists: a webhook only ever delivers what happened after it was subscribed,
// and there is no way to make Meta redeliver a leadgen event that predates the
// subscription. The 467 people who filled in the form before anyone wired this
// up are real supporters sitting in a spreadsheet, and no webhook will ever
// hand them over.
//
// It is also the safety net. Meta drops webhook deliveries — a deploy mid
// flight, a token that lapsed over a weekend, an outage on either side — and
// nothing in a push-only design ever notices. Run on a schedule, this closes
// that gap on its own: anything the webhook missed is picked up on the next
// pass, and anything it caught is skipped, because both paths dedupe on the
// same leadgen_id.
//
// Dry run by default, like the Stripe backfill. Reading 467 leads and telling
// you what it would do costs nothing; writing them is a decision, and with
// these particular 467 it is a decision that has to wait on the consent
// wording of the form. Writing requires ?apply=1.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const { withRetry } = require("./_lib/retry");
const webhook = require("./meta-lead-webhook");

const API_VERSION = "v21.0";
const PAGE = 100;
// Twenty pages of a hundred is two thousand leads in one invocation, which is
// comfortably inside a function timeout and far past any real backlog. The cap
// exists so a paging bug cannot spin until the platform kills it.
const MAX_PAGES = 20;

function token() {
  // A page access token with leads_retrieval, which is a different grant from
  // the CAPI token. Falling back to the CAPI token is deliberate: on a small
  // campaign they are often the same system user, and failing with "not
  // configured" when a usable token is sitting right there helps nobody.
  return process.env.META_LEAD_PAGE_TOKEN || process.env.META_CAPI_TOKEN || "";
}

function formIds() {
  // The same map the webhook routes on, so a form added for one is known to
  // the other. Read as ids only; what each maps to is the webhook's business.
  let map = {};
  try { map = JSON.parse(process.env.META_LEAD_FORM_MAP || "{}"); } catch (e) { /* below */ }
  const ids = Object.keys(map);
  return ids.length ? ids : String(process.env.META_LEAD_FORM_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;

  // Two callers, two ways in. Vercel's scheduler sets x-vercel-cron; a human
  // running a backfill by hand has the admin password. Either is enough, and
  // neither is optional.
  //
  // Deliberately not h.requireCron: that one treats an unset CRON_SECRET as
  // open, which is the right call for the idempotent sweeps but not here.
  // This endpoint reads every supporter's name, email and phone number out of
  // Meta, so an unset secret has to close the door rather than remove it.
  if (!(req.headers && req.headers["x-vercel-cron"])) {
    if (!h.requireBasicAuth(req, res)) return;
  }

  if (!token()) return res.status(503).json({ error: "no Meta token with leads_retrieval" });
  if (!at.configured()) return res.status(503).json({ error: "airtable not configured" });

  const q = req.query || {};
  const apply = q.apply === "1";
  const forms = q.form ? [String(q.form)] : formIds();
  if (!forms.length) {
    return res.status(400).json({ error: "no form ids; set META_LEAD_FORM_MAP or pass ?form=" });
  }

  // Default to a week, which covers any plausible webhook outage without
  // rereading the whole history on every scheduled run. A backfill passes a
  // wider window explicitly.
  const days = Math.min(400, Math.max(1, Number(q.days || 7)));
  const since = Math.floor((Date.now() - days * 86400000) / 1000);

  const out = {
    dry_run: !apply, days, forms: forms.length,
    scanned: 0, already: 0, missing: 0, written: 0, skipped: 0, failed: 0,
    by_form: {}, examples: []
  };

  for (const formId of forms) {
    const tally = { scanned: 0, already: 0, missing: 0, written: 0, skipped: 0, failed: 0 };
    out.by_form[formId] = tally;
    try {
      await pullForm(formId, since, apply, out, tally);
    } catch (err) {
      tally.error = String(err.message || err).slice(0, 200);
      console.error("META_LEAD_PULL_FAIL", formId, err.message);
    }
  }

  return res.status(200).json({ ok: true, ...out });
};

async function pullForm(formId, since, apply, out, tally) {
  let url = "https://graph.facebook.com/" + API_VERSION + "/" + encodeURIComponent(formId) +
    "/leads?limit=" + PAGE +
    "&fields=" + encodeURIComponent("id,created_time,ad_id,adset_id,campaign_id,form_id,platform,is_organic,field_data") +
    "&filtering=" + encodeURIComponent(JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: since }])) +
    "&access_token=" + encodeURIComponent(token());

  for (let page = 0; page < MAX_PAGES && url; page++) {
    const r = await withRetry(() => fetch(url), { label: "meta leads", attempts: 3 });
    const text = await r.text();
    if (!r.ok) {
      // Meta says exactly which permission is missing. A bare 400 does not,
      // and the difference between "no leads_retrieval" and "wrong form id"
      // is the entire diagnosis.
      throw new Error("graph " + r.status + ": " + text.slice(0, 240));
    }

    let body = {};
    try { body = JSON.parse(text); } catch (e) { throw new Error("graph returned non-JSON"); }

    for (const row of body.data || []) {
      out.scanned++; tally.scanned++;
      try {
        const done = await handleLead(row, formId, apply, out, tally);
        if (!done) continue;
      } catch (err) {
        out.failed++; tally.failed++;
        console.error("META_LEAD_PULL_ROW", row && row.id, err.message);
      }
    }

    url = (body.paging && body.paging.next) || "";
  }
}

async function handleLead(row, formId, apply, out, tally) {
  const lead = {
    leadgen_id: String(row.id || ""),
    form_id: String(row.form_id || formId),
    ad_id: String(row.ad_id || ""), adset_id: String(row.adset_id || ""),
    campaign_id: String(row.campaign_id || ""),
    platform: String(row.platform || ""),
    created_time: row.created_time ? new Date(row.created_time).toISOString() : "",
    // Organic leads come from a form on the Page with no ad behind it. They
    // are still supporters; they simply have no attribution to record.
    meta_partner: row.is_organic ? "organic" : "",
    fields: webhook.fieldsFrom(row.field_data),
    raw: row
  };

  // Asked before writing, so a dry run reports a real number rather than
  // pretending every lead is new.
  if (lead.leadgen_id) {
    const seen = await at.findOne(at.T.signatures,
      "{meta_leadgen_id}='" + at.esc(lead.leadgen_id) + "'");
    if (seen) { out.already++; tally.already++; return false; }
  }

  out.missing++; tally.missing++;

  // The first few are echoed back so a dry run can be read rather than
  // trusted. Names only, no email or phone: this response goes down a
  // browser connection and into a log, and the rest of the campaign is
  // careful never to echo a supporter's contact details.
  if (out.examples.length < 5) {
    out.examples.push({
      leadgen_id: lead.leadgen_id, created: lead.created_time,
      name: [lead.fields.first_name, lead.fields.last_name].filter(Boolean).join(" ") || "(no name)",
      has_email: !!lead.fields.email, has_phone: !!lead.fields.phone
    });
  }

  if (!apply) return true;

  // One function, shared with the webhook. The test-lead drop, the name
  // splitting, the Nucleus entry and the queue write all happen in there.
  await webhook.ingest(lead);
  out.written++; tally.written++;
  return true;
}
