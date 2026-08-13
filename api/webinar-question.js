// POST /api/webinar-question — a question for the host's run sheet.
//
// Ten per token, which is generous for a person and cheap to enforce.
//
// Each question gets an AI triage suggestion: include or skip, plus a line of
// reasoning. It is a suggestion and the column says so. The decision column is
// separate, defaults to Undecided, and is never written by code. A host
// scanning forty questions ten minutes before going live wants them sorted,
// not chosen for them, and a model deciding which supporter gets heard is not
// something to hand over quietly.
//
// Triage failure is fine. The question is stored either way and lands as
// Unrated, which sorts to the top of a run sheet rather than disappearing.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const token = require("./_lib/token");

const PER_TOKEN = 10;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "POST")) return;
  res.setHeader("Cache-Control", "private, no-store");

  const b = h.body(req) || {};
  const slug = h.clean(b.slug, 60);
  const t = h.clean(b.token, 600);
  const question = h.cleanMultiline(b.question, 1200);

  if (!question) return res.status(400).json({ error: "Type your question first." });
  if (!at.configured()) return res.status(503).json({ error: "Questions are not switched on yet." });

  const claim = t ? token.verify(t) : null;
  const event = await at.findOne(at.T.webinars, "AND({slug}='" + at.esc(slug) + "',{active}=1)")
    .catch(() => null);
  if (!event) return res.status(404).json({ error: "That briefing is not open." });
  if (!event.fields.open_registration && !claim) {
    return res.status(403).json({ error: "Use the link from your email to ask a question." });
  }

  const email = at.normEmail(claim && claim.email ? claim.email : h.clean(b.email, 160));
  const bucket = claim ? "wq:" + (claim.contact_id || email) : "wq:ip:" + h.hashIp(req);
  if (!h.rateLimit(bucket, PER_TOKEN, 6 * 3600000).ok) {
    return res.status(429).json({ error: "That is as many questions as we can take from one person. The host has them." });
  }

  const first = h.clean(b.first_name, 60);
  const triage = await rate(question, event.fields.title || "supporter briefing");

  try {
    await at.create(at.T.questions, {
      question_id: at.uuid(), webinar_slug: slug,
      contact_id: (claim && claim.contact_id) || "",
      first_name: first, email, question,
      ai_include: triage.include || "Unrated",
      ai_rationale: triage.rationale || "",
      decision: "Undecided",       // the host's, never set here
      created_at: at.nowIso()
    });
  } catch (err) {
    console.error("WEBINAR_QUESTION_FAIL", err.message);
    return res.status(502).json({ error: "That did not send. Try again in a moment." });
  }

  return res.status(200).json({ ok: true });
};

/* Best effort. A blank triage is a fine outcome; a lost question is not. */
async function rate(question, title) {
  if (!process.env.ANTHROPIC_API_KEY) return { include: "Unrated", rationale: "" };
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        system: [
          "You are sorting supporter questions for the host of a campaign briefing called \"" + title + "\".",
          "Suggest Include for a question that is on topic, answerable in a couple of minutes, and likely to be on other people's minds.",
          "Suggest Skip for one that is a personal admin matter, abusive, unanswerable, or a duplicate of an obvious FAQ.",
          "You are advising, not deciding. When it is genuinely borderline, suggest Include: a host can skip a question on the night, but cannot ask one they never saw.",
          'Reply with strict JSON only: {"include":"Include"|"Skip","rationale":"one short sentence"}'
        ].join("\n"),
        messages: [{ role: "user", content: question }]
      })
    });
    if (!r.ok) return { include: "Unrated", rationale: "" };
    const json = await r.json();
    const raw = ((json.content || []).find((c) => c.type === "text") || {}).text || "";
    const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) return { include: "Unrated", rationale: "" };
    const parsed = JSON.parse(raw.slice(start, end + 1));
    const include = parsed.include === "Skip" ? "Skip" : parsed.include === "Include" ? "Include" : "Unrated";
    return { include, rationale: String(parsed.rationale || "").slice(0, 300) };
  } catch (err) {
    console.error("WEBINAR_TRIAGE_FAIL", err.message);
    return { include: "Unrated", rationale: "" };
  }
}
