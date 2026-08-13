// GET/POST /api/drain — expands the Ingest Queue into the relational tables.
//
// The request path deliberately does almost no Airtable work, so this is where
// a submission becomes a Contact, an Event and a typed row. It runs on a cron
// and is also nudged after writes, so the queue drains continuously rather
// than in one lurch.
//
// Two properties matter. It is rate-aware: it processes a bounded slice and
// stops well inside the function timeout, leaving the rest for the next pass,
// so a 5,000 signature surge drains steadily instead of hammering Airtable
// into 429s. And it is idempotent: a row is marked Done only after its
// expansion succeeded, and a row already Done is skipped, so a retry or an
// overlapping run cannot double-write a person.
const at = require("./_lib/airtable");
const nucleus = require("./_lib/nucleus");

const SLICE = 25;          // queue rows per invocation
const TIME_BUDGET_MS = 45000;

module.exports = async function handler(req, res) {
  if (!at.configured()) return res.status(503).json({ error: "airtable not configured" });
  // Cron calls carry Vercel's header; a manual call needs the key.
  const authed = !!req.headers["x-vercel-cron"] || (req.query && req.query.key) === process.env.DRAIN_KEY;
  if (!authed && process.env.DRAIN_KEY) return res.status(404).json({ error: "not found" });

  const started = Date.now();
  const out = { processed: 0, failed: 0, skipped: 0 };
  try {
    const rows = await waiting(SLICE);
    for (const row of rows) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      try {
        await expand(row);
        await at.update(at.T.queue, row.id, { status: "Done", drained_at: at.nowIso() });
        out.processed++;
      } catch (err) {
        out.failed++;
        const attempts = Number(row.fields.attempts || 0) + 1;
        // Five failures means the row needs a human, not another retry.
        await at.update(at.T.queue, row.id, {
          attempts,
          status: attempts >= 5 ? "Failed" : "Waiting",
          error: String(err.message || err).slice(0, 250)
        }).catch(() => {});
      }
    }
    out.remaining = rows.length >= SLICE ? "more" : "none";
    out.lapsed_cleared = await clearCompletedLapses();
  } catch (err) {
    console.error("DRAIN_FAIL", err.message);
    return res.status(500).json({ error: String(err.message || err), ...out });
  }
  return res.status(200).json({ ok: true, ms: Date.now() - started, ...out });
};

// A partial fires before the signature, so someone who hesitates for ten
// seconds and then signs leaves a Waiting lapse row behind them. Sweep those
// out on every pass: chasing a supporter who already signed is worse than not
// chasing at all.
async function clearCompletedLapses() {
  let cleared = 0;
  try {
    const res = await at.call("GET", at.T.lapse,
      "filterByFormula=" + encodeURIComponent("{status}='Waiting'") + "&maxRecords=50");
    const rows = (res && res.records) || [];
    for (const row of rows) {
      const email = at.normEmail(row.fields.email);
      if (!email) continue;
      const signed = await at.findOne(at.T.signatures, "LOWER({email})='" + at.esc(email) + "'");
      if (!signed) continue;
      await at.update(at.T.lapse, row.id, {
        status: "Completed", note: "Signed after the partial fired", triggered_at: at.nowIso()
      });
      cleared++;
    }
  } catch (err) { console.error("LAPSE_SWEEP_FAIL", err.message); }
  return cleared;
}

async function waiting(limit) {
  const res = await at.call("GET", at.T.queue,
    "filterByFormula=" + encodeURIComponent("{status}='Waiting'") +
    "&maxRecords=" + limit + "&sort%5B0%5D%5Bfield%5D=created_at&sort%5B0%5D%5Bdirection%5D=asc");
  return (res && res.records) || [];
}

async function expand(row) {
  const type = row.fields.type;
  const p = JSON.parse(row.fields.payload || "{}");
  const cn = { synced: !!row.fields.cn_synced, entryId: row.fields.cn_entry_id || "", error: row.fields.cn_error || "" };
  const handler = EXPAND[type];
  if (!handler) throw new Error("unknown queue type: " + type);
  return handler(p, cn);
}

const EXPAND = {
  petition: async (p, cn) => {
    const contact = await at.upsertContact({ ...p, source_channel: "Petition", status: "Signed" });
    // Credit the recruiter, once. referred_by is first-touch: a supporter who
    // arrives again later on somebody else's link still belongs to whoever
    // brought them in the first time, or the last sharer would steal the
    // credit for every re-visit.
    if (p.ref && contact.created) {
      await at.update(at.T.contacts, contact.id, { referred_by: p.ref }).catch(() => {});
    }
    // A repeat press still updates the person, but it must not add a second
    // signature row: the base would then disagree with Nucleus about the count.
    const already = p.email
      ? await at.findOne(at.T.signatures, "LOWER({email})='" + at.esc(at.normEmail(p.email)) + "'")
      : null;
    if (already) return;
    const ev = await at.logEvent({
      contactRecId: contact.id, event_type: "Petition Signed",
      source_channel: (p.source_url || "").indexOf("/take-action/") > -1 ? "Petition page" : "Home page",
      source_url: p.source_url, referral_code_used: p.ref, payload: p
    });
    await at.create(at.T.signatures, {
      signature_id: at.uuid(), contact: [contact.id], event: [ev.id],
      first_name: p.first_name, last_name: p.last_name, email: p.email,
      mobile: p.mobile || "", postcode: p.postcode || "", campaign: p.campaign || "",
      consent: !!p.consent, cn_synced: cn.synced, cn_entry_id: cn.entryId, cn_error: cn.error,
      ref_used: p.ref || "", source_url: p.source_url || "",
      utm_source: p.utm_source || "", utm_medium: p.utm_medium || "", utm_campaign: p.utm_campaign || "",
      utm_term: p.utm_term || "", utm_content: p.utm_content || "",
      timestamp: at.nowIso(), payload: JSON.stringify(p, null, 1)
    });
    await at.markFanout(ev.id, true);
  },

  // A lead ad signature. Same tables as a website signature, plus the ad
  // attribution columns that are the whole reason for running lead ads.
  meta_lead: async (p, cn) => {
    const contact = await at.upsertContact({ ...p, source_channel: "Meta Lead Ad", status: "Signed" });
    const already = await at.findOne(at.T.signatures,
      "{meta_leadgen_id}='" + at.esc(p.meta_leadgen_id || "") + "'");
    if (already) return;
    const ev = await at.logEvent({
      contactRecId: contact.id, event_type: "Petition Signed",
      source_channel: "Meta Lead Ad", source_url: p.source_url, payload: p
    });
    await at.create(at.T.signatures, {
      signature_id: at.uuid(), contact: [contact.id], event: [ev.id],
      first_name: p.first_name, last_name: p.last_name, email: p.email,
      mobile: p.mobile || "", postcode: p.postcode || "", campaign: p.campaign || "",
      consent: true, lead_source: "Meta Lead Ad",
      cn_synced: cn.synced, cn_entry_id: cn.entryId, cn_error: cn.error,
      utm_source: "meta", utm_medium: "lead_ad", utm_campaign: p.meta_campaign_name || "",
      meta_leadgen_id: p.meta_leadgen_id || "", meta_form_id: p.meta_form_id || "",
      meta_form_name: p.meta_form_name || "", meta_ad_id: p.meta_ad_id || "",
      meta_ad_name: p.meta_ad_name || "", meta_adset_id: p.meta_adset_id || "",
      meta_adset_name: p.meta_adset_name || "", meta_campaign_id: p.meta_campaign_id || "",
      meta_campaign_name: p.meta_campaign_name || "", meta_platform: p.meta_platform || "",
      meta_partner: p.meta_partner || "",
      meta_created_time: p.meta_created_time || undefined,
      source_url: p.source_url || "", timestamp: at.nowIso(),
      payload: JSON.stringify(p, null, 1)
    });
    await at.markFanout(ev.id, true);
  },

  contact: (p, cn) => submission("Contact us", "Contact Message", "Contact page", "Contact form", "Lead", p, cn),
  volunteer: (p, cn) => submission("Volunteer", "Volunteer Signup", "Volunteer page", "Volunteer", "Volunteer", p, cn),

  minister: async (p, cn) => {
    const existing = await at.findOne(at.T.signups, "{session_id}='" + at.esc(p.session_id) + "'");
    if (existing && Number(existing.fields.seq || 0) > Number(p.seq || 0)) return; // stale beacon
    const fields = {
      session_id: p.session_id, first_name: p.first_name, last_name: p.last_name,
      email: p.email || "", mobile: p.mobile || "", status: p.status, seq: p.seq,
      send_clicked: p.status === "send_clicked", cn_synced: !cn.error && p.status === "send_clicked",
      updated_at: at.nowIso()
    };
    if (p.sent_subject) fields.sent_subject = p.sent_subject;
    if (p.sent_body) fields.sent_body = p.sent_body;
    if (p.variation_shown != null) fields.variation_shown = p.variation_shown;
    if (p.ai_rewrite_count != null) fields.ai_rewrite_count = p.ai_rewrite_count;

    if (existing) await at.update(at.T.signups, existing.id, fields);
    else await at.create(at.T.signups, { ...fields, created_at: at.nowIso() });

    if (p.status !== "send_clicked" || !p.email) return;
    const contact = await at.upsertContact({ ...p, consent: true, source_channel: "Minister email", status: "Lead" });
    await at.logEvent({
      contactRecId: contact.id, event_type: "Minister Email Sent",
      source_channel: "Minister page", payload: { session_id: p.session_id, subject: p.sent_subject }
    });
  },

  // A partial is a lead, never a signature. If the person has since signed,
  // the row is dropped rather than nagging someone who already finished.
  partial: async (p) => {
    const signed = p.email
      ? await at.findOne(at.T.signatures, "LOWER({email})='" + at.esc(p.email) + "'")
      : null;
    if (signed) return;

    const fields = {
      form: p.form || "Petition", first_name: p.first_name, last_name: p.last_name,
      email: p.email, mobile: p.mobile || "", status: "Waiting", created_at: at.nowIso()
    };
    const existing = await at.findOne(at.T.lapse,
      "AND(LOWER({email})='" + at.esc(p.email) + "',{status}='Waiting')");
    if (existing) await at.update(at.T.lapse, existing.id, fields);
    else await at.create(at.T.lapse, { ...fields, lapse_id: at.uuid() });

    // Tagged in Nucleus so the follow-up can actually be sent. Deliberately a
    // profile and not a petition entry: they have not signed.
    if (nucleus.configured() && p.email) {
      await nucleus.upsertProfile({
        email: p.email, first_name: p.first_name, last_name: p.last_name,
        mobile: p.mobile, postcode: p.postcode,
        tags: ["Defend Sacred Ground", "Started petition, did not finish"]
      }).catch((err) => console.error("CN_PARTIAL_PROFILE_FAIL", err.message));
    }
  },

  share: async (p) => {
    const owner = await ownerOf(p.code);
    await at.logEvent({
      contactRecId: owner ? owner.id : undefined,
      event_type: "Share Issued", source_channel: "Share page",
      referral_code_used: p.code, payload: p
    });
  },

  // Someone followed a supporter's link. Logged against the supporter who
  // owns the code, not the visitor, because the visitor is still anonymous:
  // this is a measure of the sharer's reach.
  share_click: async (p) => {
    const owner = await ownerOf(p.code);
    await at.logEvent({
      contactRecId: owner ? owner.id : undefined,
      event_type: "Share Click", source_channel: "Referral link",
      source_url: p.landing, referral_code_used: p.code, payload: p
    });
  },

  // A visitor who asked for a share link without ever having signed.
  share_signup: async (p) => {
    const contact = await at.upsertContact({
      ...p, source_channel: "Share page", status: "Lead",
      referral_code: p.referral_code
    });
    await at.logEvent({
      contactRecId: contact.id, event_type: "Share Signup",
      source_channel: "Share page", source_url: p.source_url, payload: p
    });
  }
};

// Codes are matched case-insensitively: a link that has been through a mail
// client may come back lowercased, and treating that as a different code
// splits one supporter's results in two.
async function ownerOf(code) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  try {
    return await at.findOne(at.T.contacts, "UPPER({referral_code})='" + at.esc(c) + "'");
  } catch (err) {
    console.error("REF_OWNER_LOOKUP_FAIL", err.message);
    return null;
  }
}

async function submission(form, eventType, channel, sourceChannel, status, p, cn) {
  const contact = await at.upsertContact({ ...p, consent: true, source_channel: sourceChannel, status });
  const ev = await at.logEvent({
    contactRecId: contact.id, event_type: eventType, source_channel: channel,
    source_url: p.source_url, payload: p
  });
  await at.create(at.T.submissions, {
    submission_id: at.uuid(), contact: [contact.id], event: [ev.id], form,
    first_name: p.first_name, last_name: p.last_name, email: p.email,
    mobile: p.mobile || "", postcode: p.postcode || "", topic: p.topic || "",
    message: p.message || "", roles: p.roles || "",
    cn_synced: cn.synced, cn_entry_id: cn.entryId, cn_error: cn.error,
    source_url: p.source_url || "", timestamp: at.nowIso(), payload: JSON.stringify(p, null, 1)
  });
  await at.markFanout(ev.id, true);
}
