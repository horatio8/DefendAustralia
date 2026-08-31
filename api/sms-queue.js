// GET/POST /api/sms-queue — send what is due.
//
// Kicked from the tail of the lapse sweep and opportunistically by traffic on
// the signature counter, and since the welcome text was added, also on a
// minute cron. The opportunistic kicks are what keep the queue moving during a
// surge, but they are not a delivery guarantee: they only fire when somebody
// happens to load a page. That was fine when everything in here was a
// follow-up hours after the fact, and is not fine for a text that says
// "thanks for signing" — at three in the morning, with no traffic, it would
// have sat until dawn. A bearer call drains it by hand.
//
// A message is claimed before it is sent and the row is written before the
// provider is called, so a crash mid-send leaves a row that reads Sent with no
// provider id rather than a message that goes twice. Sending twice is the
// worse failure: the supporter cannot unsee it.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const sms = require("./_lib/sms");

const SLICE = 20;
const TIME_BUDGET_MS = 40000;

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;
  if (!h.requireCron(req, res)) return;
  return res.status(200).json(await drain());
};

async function drain() {
  const out = { sent: 0, failed: 0, suppressed: 0 };
  if (!at.configured()) return { ...out, error: "airtable not configured" };
  if (!sms.configured()) return { ...out, error: "cellcast not configured" };

  const started = Date.now();
  let rows = [];
  try {
    rows = await due(SLICE);
  } catch (err) {
    console.error("SMS_DRAIN_READ_FAIL", err.message);
    return { ...out, error: String(err.message || err) };
  }

  for (const row of rows) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    const f = row.fields;

    // Opt-out check two of two. Someone can reply STOP in the hours between
    // a message being queued and being due, and often does.
    if (await sms.optedOut(f.phone)) {
      await at.update(at.T.smsSends, row.id, { status: "Suppressed", error: "opted out before send" }).catch(() => {});
      out.suppressed++;
      continue;
    }

    // Claimed first. If this instance dies mid-send the row reads Sent with no
    // provider id, which a human can investigate. The alternative is a row
    // still marked Queued and a message already delivered, which the next pass
    // would deliver again.
    try {
      await at.update(at.T.smsSends, row.id, {
        status: "Sent", attempts: Number(f.attempts || 0) + 1, sent_at: at.nowIso()
      });
    } catch (err) {
      out.failed++;
      continue;
    }

    try {
      const providerId = await sms.send(f.phone, f.message);
      await at.update(at.T.smsSends, row.id, { provider_id: String(providerId || "") }).catch(() => {});
      out.sent++;
    } catch (err) {
      out.failed++;
      const attempts = Number(f.attempts || 0) + 1;
      await at.update(at.T.smsSends, row.id, {
        status: attempts >= 3 ? "Failed" : "Queued",
        error: String(err.message || err).slice(0, 250)
      }).catch(() => {});
    }
  }

  out.remaining = rows.length >= SLICE ? "more" : "none";
  return out;
}

async function due(limit) {
  const now = at.nowIso();
  const formula = "AND({status}='Queued',OR({not_before}=BLANK(),IS_BEFORE({not_before},'" + now + "')))";
  const res = await at.call("GET", at.T.smsSends,
    "filterByFormula=" + encodeURIComponent(formula) +
    "&maxRecords=" + limit +
    "&sort%5B0%5D%5Bfield%5D=not_before&sort%5B0%5D%5Bdirection%5D=asc");
  return (res && res.records) || [];
}

// Exported so the lapse sweep and the counter can kick it without an HTTP hop.
module.exports.drain = drain;
