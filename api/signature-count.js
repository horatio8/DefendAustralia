// GET /api/signature-count — the live petition total.
//
// The number on the site is the Campaign Nucleus entry count for the petition
// form and nothing else, so the two can never drift. The form id and the
// request shape come from the shared client, so this endpoint cannot fall out
// of step with the handler that writes signatures.
const nucleus = require("./_lib/nucleus");
// Statically required so Vercel traces it into this function's bundle. A
// lazy require of a sibling handler is not packaged and fails at runtime with
// "Cannot find module", which is exactly how this was learned.
const smsQueue = require("./sms-queue");
const milestones = require("./_lib/milestones");

const CACHE_SECONDS = 60;
let cached = null; // { count, at }

// This is the busiest endpoint on the site, so it doubles as the SMS queue's
// heartbeat: during a surge the queue drains continuously off real traffic
// rather than waiting for a scheduled job, and in the quiet hours nothing runs
// and nothing is billed. Throttled hard, because a warm instance serving a
// thousand counter reads a minute must not start a thousand drains.
const KICK_EVERY_MS = 300000;
let lastKick = 0;

function kickSmsQueue() {
  if (Date.now() - lastKick < KICK_EVERY_MS) return;
  lastKick = Date.now();
  smsQueue.drain()
    .then((r) => { if (r && r.sent) console.log("SMS_KICK", JSON.stringify(r)); })
    .catch((err) => console.error("SMS_KICK_FAIL", err.message));
}

// Throttled the same way as the queue kick, and for the same reason: a warm
// instance serving a thousand counter reads a minute must not make a thousand
// datastore round trips to ask whether the number is round.
const MILESTONE_EVERY_MS = 300000;
let lastMilestoneCheck = 0;

function checkMilestones(count) {
  if (Date.now() - lastMilestoneCheck < MILESTONE_EVERY_MS) return;
  lastMilestoneCheck = Date.now();
  milestones.check(count)
    .then((hit) => { if (hit.length) console.log("MILESTONE", JSON.stringify(hit)); })
    .catch((err) => console.error("MILESTONE_FAIL", err.message));
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });
  if (!nucleus.configured()) return res.status(503).json({ error: "signature count not configured" });

  if (cached && Date.now() - cached.at < CACHE_SECONDS * 1000) {
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=60");
    return res.status(200).json({ count: cached.count, cached: true });
  }

  kickSmsQueue();
  try {
    const count = await nucleus.entryCount("petition");
    cached = { count, at: Date.now() };
    // Not awaited. A milestone is worth announcing and not worth a supporter
    // waiting on: the counter is the busiest endpoint on the site, and this
    // only does anything at all on the one request that crosses a threshold.
    checkMilestones(count);
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=60");
    return res.status(200).json({ count });
  } catch (err) {
    console.error("SIGNATURE_COUNT_FAIL", err.message);
    // Serve a stale number rather than none: the count must never read as zero
    // because an upstream call blipped.
    if (cached) return res.status(200).json({ count: cached.count, stale: true });
    return res.status(502).json({ error: "signature count unavailable" });
  }
};
