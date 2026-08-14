// POST /api/rewrite — "Say it my way" on the Minister page.
//
// The supporter has written to a minister in their own words and wants it to
// read better. The model rewrites it; the guardrails in _lib/prompts.js decide
// what it is allowed to change. The demands survive verbatim and in order,
// because a rewrite that softens the first demand quietly rewrites the
// campaign's position.
//
// The API key never reaches the browser, so this endpoint exists purely to
// hold it. Three limits sit in front of it: three rewrites per session (the
// client shows the count), twenty per IP per hour (in memory, per instance),
// and a hard daily spend cap counted from the AI Usage table, which is the one
// that actually bounds the bill because it survives a cold start.
//
// Every attempt is logged with its token counts and estimated cost against a
// salted hash of the IP. The IP itself is never stored.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const prompts = require("./_lib/prompts");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const PER_SESSION = 3;
const PER_IP_HOUR = 20;
const MAX_CHARS = 1400;

// Haiku 4.5 list price, USD per million tokens. Only used for the cost column;
// a stale number here misreports spend but never changes behaviour.
const COST_IN = 1.0 / 1e6;
const COST_OUT = 5.0 / 1e6;

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "POST")) return;

  const b = h.body(req);
  if (!b) return res.status(400).json({ error: "bad payload" });

  const campaign = h.clean(b.campaign, 40) || "minister";
  const session_id = h.clean(b.session_id, 80);
  const subject = h.clean(b.subject, 300);
  const bodyText = h.cleanMultiline(b.body, 6000);
  const firstName = h.clean(b.first_name, 60);

  if (!bodyText) return res.status(400).json({ error: "There is nothing to rewrite yet. Write your message first." });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "The rewrite service is not switched on yet. Your own words will send just fine." });
  }

  const ipHash = h.hashIp(req);

  // Per-IP, then per-session. Both answer 429 with a human sentence, because
  // this message is rendered straight onto the page.
  const ipLimit = h.rateLimit("rewrite:ip:" + ipHash, PER_IP_HOUR, 3600000);
  if (!ipLimit.ok) {
    await logUsage({ session_id, campaign, ipHash, outcome: "Rate limited", error: "ip hourly cap" });
    res.setHeader("Retry-After", String(ipLimit.retryAfter || 600));
    return res.status(429).json({ error: "That is as many rewrites as we can run for now. Try again in an hour, or send it in your own words." });
  }

  const used = await sessionCount(session_id);
  if (used >= PER_SESSION) {
    await logUsage({ session_id, campaign, ipHash, outcome: "Rate limited", error: "session cap" });
    return res.status(429).json({ error: "You have used all " + PER_SESSION + " rewrites for this letter. Edit it yourself and send it." });
  }

  const capped = await overDailyCap();
  if (capped) {
    await logUsage({ session_id, campaign, ipHash, outcome: "Rate limited", error: "daily cap" });
    return res.status(429).json({ error: "The rewrite service has hit its limit for today. Your letter still sends exactly as you wrote it." });
  }

  let out;
  try {
    out = await callModel(campaign, subject, bodyText, firstName);
  } catch (err) {
    console.error("REWRITE_FAIL", err.message);
    await logUsage({ session_id, campaign, ipHash, outcome: "Error", error: String(err.message || err) });
    return res.status(502).json({ error: "The rewrite did not come back. Your letter is untouched, so you can send it as it is." });
  }

  await logUsage({
    session_id, campaign, ipHash, outcome: "Rewritten",
    tokens_in: out.tokens_in, tokens_out: out.tokens_out,
    cost: out.tokens_in * COST_IN + out.tokens_out * COST_OUT
  });

  // Write-only response: nothing stored about this person comes back out.
  return res.status(200).json({
    subject: out.subject,
    body: out.body,
    remaining: Math.max(0, PER_SESSION - used - 1)
  });
};

async function callModel(campaign, subject, bodyText, firstName) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      system: prompts.systemPrompt(campaign),
      messages: [{
        role: "user",
        content: [
          firstName ? "The supporter's first name is " + firstName + "." : "",
          "Their subject line: " + (subject || "(none)"),
          "Their message:",
          bodyText,
          "",
          "Rewrite it. Reply with JSON only."
        ].filter(Boolean).join("\n")
      }]
    })
  });

  const text = await r.text();
  if (!r.ok) throw new Error("anthropic " + r.status + ": " + text.slice(0, 200));

  const json = JSON.parse(text);
  const raw = ((json.content || []).find((c) => c.type === "text") || {}).text || "";
  const parsed = parseJson(raw);
  if (!parsed || !parsed.body) throw new Error("model did not return usable JSON");

  const usage = json.usage || {};
  return {
    subject: String(parsed.subject || subject || "").slice(0, 300),
    body: stripDashes(String(parsed.body)).slice(0, MAX_CHARS),
    tokens_in: usage.input_tokens || 0,
    tokens_out: usage.output_tokens || 0
  };
}

// Models sometimes wrap JSON in a fence or a sentence. Take the outermost
// braces rather than trusting the whole string to parse.
function parseJson(raw) {
  try { return JSON.parse(raw); } catch (e) { /* fall through */ }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch (e) { return null; }
}

// House copy rule, enforced rather than requested. A stray em dash in a letter
// to a minister reads as machine-written, which is the one thing it must not.
function stripDashes(s) {
  return s.replace(/\s*[—–]\s*/g, ", ").replace(/,\s*,/g, ",");
}

// The session's own count, read from the row /api/capture already maintains.
async function sessionCount(session_id) {
  if (!session_id || !at.configured()) return 0;
  try {
    const rec = await at.findOne(at.T.signups, "{session_id}='" + at.esc(session_id) + "'");
    return Number((rec && rec.fields.ai_rewrite_count) || 0);
  } catch (err) {
    // Unknown rather than blocked: a datastore blip must not cost a supporter
    // the feature. The IP and daily caps still hold the line.
    console.error("REWRITE_SESSION_COUNT_FAIL", err.message);
    return 0;
  }
}

// A default cap, because the safe value of "unset" is not unlimited.
//
// This endpoint is public and it spends money on someone else's key. Reading
// an unset variable as "no ceiling" means the one configuration mistake nobody
// notices is also the expensive one, and a campaign finds out through a bill.
// 500 rewrites a day is far above what this campaign's traffic produces and
// far below anything that would hurt. Set AI_REWRITE_DAILY_CAP to raise it, or
// to 0 to deliberately remove the ceiling.
const DEFAULT_DAILY_CAP = 500;

async function overDailyCap() {
  const raw = String(process.env.AI_REWRITE_DAILY_CAP || "").trim();
  const cap = raw === "" ? DEFAULT_DAILY_CAP : Number(raw);
  if (!Number.isFinite(cap) || cap <= 0 || !at.configured()) return false;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const res = await at.call("GET", at.T.aiUsage,
      "filterByFormula=" + encodeURIComponent("DATETIME_FORMAT({timestamp},'YYYY-MM-DD')='" + today + "'") +
      "&maxRecords=" + (cap + 1) + "&fields%5B%5D=usage_id");
    return ((res && res.records) || []).length >= cap;
  } catch (err) {
    console.error("REWRITE_CAP_CHECK_FAIL", err.message);
    return false;
  }
}

async function logUsage(u) {
  if (!at.configured()) return;
  try {
    await at.create(at.T.aiUsage, {
      usage_id: at.uuid(),
      timestamp: at.nowIso(),
      session_id: u.session_id || "",
      campaign: u.campaign || "",
      model: MODEL,
      tokens_in: u.tokens_in || 0,
      tokens_out: u.tokens_out || 0,
      estimated_cost: Number((u.cost || 0).toFixed(6)),
      ip_hash: u.ipHash || "",
      outcome: u.outcome || "Error",
      error: (u.error || "").slice(0, 250)
    });
  } catch (err) { console.error("AI_USAGE_LOG_FAIL", err.message); }
}
