// GET /api/social-analyse — read the inbox and say what is in it.
//
// Scores every social message that has no analysed_at yet, then recomputes
// the person's rollup from all their scored messages.
//
// Finding work by "unscored" rather than by a date window is what makes this
// resumable, idempotent, and the same code path for both jobs it does: the
// historical backfill is simply the first few runs, when the pile is large.
// It can be called repeatedly, survives being killed, and never rescores a
// message.
//
// Two budgets, not one, because the second phase used to overrun. Scoring
// yields well before the limit so the rollups have room to finish and the
// last call in flight is not cut off mid-write.
//
// A message whose model call fails is left unscored for the next run. A gap
// is recoverable; a wrong label written confidently is counted forever.

const h = require("./_lib/http");
const at = require("./_lib/airtable");
const social = require("./_lib/social");

const SCORE_UNTIL_MS = 32000;
const ROLLUP_UNTIL_MS = 48000;
const BATCH = 100;

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;
  if (!h.requireCron(req, res)) return;
  return res.status(200).json(await run(Number((req.query || {}).limit) || 0));
};

async function run(limit) {
  const started = Date.now();
  const out = { scored: 0, failed: 0, skipped: 0, identities_rolled: 0, cost: 0 };
  if (!at.configured()) return { ...out, error: "airtable not configured" };
  if (!process.env.ANTHROPIC_API_KEY) return { ...out, error: "ANTHROPIC_API_KEY not set" };
  if (!(await at.hasTable(at.T.socialMessages))) return { ...out, error: "the Social Messages table does not exist" };

  const page = await at.page(at.T.socialMessages, {
    pageSize: Math.min(BATCH, limit || BATCH),
    filterByFormula: "AND({analysed_at}=BLANK(),{text}!='')",
    // Oldest first. A backlog cleared newest-first leaves the oldest messages
    // permanently unscored whenever new ones keep arriving faster than the
    // budget clears them.
    sort: [{ field: "received_at", direction: "asc" }]
  });

  const touched = new Set();

  for (const rec of page.records) {
    if (Date.now() - started > SCORE_UNTIL_MS) break;
    const f = rec.fields || {};
    const text = String(f.text || "").trim();
    if (!text) {
      // Nothing to read. Stamped so it is not picked up forever.
      await at.update(at.T.socialMessages, rec.id, { analysed_at: at.nowIso(), sentiment_label: "Unclear" });
      out.skipped++;
      continue;
    }
    try {
      const scored = await social.analyse(text);
      if (!scored) { out.skipped++; continue; }
      await at.update(at.T.socialMessages, rec.id, {
        sentiment_label: scored.result.sentiment_label,
        sentiment_score: scored.result.sentiment_score,
        stance: scored.result.stance,
        topic: scored.result.topic,
        escalation_flags: scored.result.escalation_flags,
        analysed_at: at.nowIso()
      });
      out.scored++;
      out.cost += scored.usage.cost;
      if (f.identity_key) touched.add(f.identity_key);
      await logUsage(scored.usage, f.message_id);
    } catch (err) {
      // Left unscored on purpose. The next run tries again.
      out.failed++;
      console.error("SOCIAL_ANALYSE_FAIL", f.message_id, err.message);
    }
  }

  for (const key of touched) {
    if (Date.now() - started > ROLLUP_UNTIL_MS) break;
    try {
      await rollupIdentity(key);
      out.identities_rolled++;
    } catch (err) { console.error("SOCIAL_ROLLUP_FAIL", key, err.message); }
  }

  out.cost = Math.round(out.cost * 100000) / 100000;
  out.more = page.records.length >= Math.min(BATCH, limit || BATCH);
  return out;
}

/* Recompute one person's summary from all their scored messages.
 *
 * Read back rather than incremented. Incrementing is correct only if every
 * run completes exactly once, and this one is designed to be killed and
 * resumed — so an average built by addition would drift every time a run was
 * cut short, in a direction nobody could reconstruct. */
async function rollupIdentity(identityKey) {
  const rec = await at.findOne(at.T.socialIdentities, "{identity_key}='" + at.esc(identityKey) + "'");
  if (!rec) return;

  let sum = 0, scored = 0, flagged = false;
  const stances = {};
  await at.walk(at.T.socialMessages, {
    pageSize: 100,
    filterByFormula: "AND({identity_key}='" + at.esc(identityKey) + "',{analysed_at}!=BLANK())",
    fields: ["sentiment_score", "stance", "escalation_flags"],
    maxRecords: 200,
    deadline: Date.now() + 8000
  }, (r) => {
    const f = r.fields || {};
    if (typeof f.sentiment_score === "number") { sum += f.sentiment_score; scored++; }
    const st = (f.stance && f.stance.name) || f.stance;
    // Unclear is not a position. Counting it would let a person with one
    // clear opinion and nine ambiguous remarks be summarised as ambiguous.
    if (st && st !== "Unclear") stances[st] = (stances[st] || 0) + 1;
    if ((f.escalation_flags || []).length) flagged = true;
  });
  if (!scored && !Object.keys(stances).length && !flagged) return;

  const dominant = Object.keys(stances).sort((a, b) => stances[b] - stances[a])[0] || null;
  await at.update(at.T.socialIdentities, rec.id, {
    avg_sentiment: scored ? Math.round((sum / scored) * 100) / 100 : null,
    ...(dominant ? { stance: dominant } : {}),
    flagged
  });
}

/* AI spend is recorded in the same table as every other model call, so the
 * question "what is the AI costing" has one answer rather than two. */
async function logUsage(usage, messageId) {
  try {
    await at.create(at.T.aiUsage, {
      usage_id: at.uuid(),
      timestamp: at.nowIso(),
      session_id: String(messageId || ""),
      campaign: "social-listening",
      model: social.MODEL(),
      tokens_in: usage.tokens_in,
      tokens_out: usage.tokens_out,
      estimated_cost: usage.cost,
      outcome: "Success"
    });
  } catch (err) { /* the analysis is the point; the meter is not */ }
}

module.exports.run = run;
module.exports.rollupIdentity = rollupIdentity;
