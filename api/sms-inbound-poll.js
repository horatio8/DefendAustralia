// GET /api/sms-inbound-poll — hourly safety net under the inbound webhook.
//
// The webhook is the fast path and this is the one that means an hour of
// provider trouble does not become an hour of ignored STOPs. Everything it
// finds goes through the same recorder as the webhook, keyed on phone plus
// timestamp, so a message delivered by both routes lands once.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const sms = require("./_lib/sms");
const { record } = require("./cellcast-inbound");

const LOOKBACK_HOURS = 26; // an hourly job with a day of overlap, so a gap self-heals

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;
  if (!h.requireCron(req, res)) return;
  if (!sms.configured()) return res.status(200).json({ ok: true, polled: 0, note: "cellcast not configured" });

  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600000).toISOString();
  let rows = [];
  try {
    rows = await sms.inbound(since);
  } catch (err) {
    console.error("SMS_POLL_FAIL", err.message);
    return res.status(200).json({ ok: false, error: String(err.message || err) });
  }

  let stored = 0, stops = 0;
  for (const m of rows) {
    try {
      await record(m, "Poll");
      stored++;
      if (sms.isStop(m.message)) stops++;
    } catch (err) { console.error("SMS_POLL_RECORD_FAIL", err.message); }
  }

  // A note of when the poll last succeeded, so a silent failure is visible in
  // the base rather than only in the logs.
  if (at.configured()) {
    await at.setStat("sms_poll_last_run", rows.length, at.nowIso()).catch(() => {});
  }

  return res.status(200).json({ ok: true, polled: rows.length, stored, stops });
};
