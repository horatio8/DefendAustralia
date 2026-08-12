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
  } catch (err) {
    console.error("DRAIN_FAIL", err.message);
    return res.status(500).json({ error: String(err.message || err), ...out });
  }
  return res.status(200).json({ ok: true, ms: Date.now() - started, ...out });
};

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
    const owner = p.code
      ? await at.findOne(at.T.contacts, "{referral_code}='" + at.esc(p.code) + "'")
      : null;
    await at.logEvent({
      contactRecId: owner ? owner.id : undefined,
      event_type: "Share Issued", source_channel: "Share page",
      referral_code_used: p.code, payload: p
    });
  }
};

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
