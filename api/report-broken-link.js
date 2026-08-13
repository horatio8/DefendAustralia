// POST /api/report-broken-link — someone hit a dead URL and told us.
//
// The visitor already had a bad experience, so nothing here is allowed to give
// them a second one. Every failure path still answers 200: a missing table, a
// rate limit or a cold datastore must never surface as "that didn't send".
//
// The durable record is the log line, not the Airtable row. A greppable
// BROKEN_LINK_REPORT line survives whatever the base is doing, so the report is
// never actually lost even when the row write fails.
//
// Repeat reports of the same path increment a counter rather than stacking
// rows, because one broken link shared to ten thousand people is one problem.
const h = require("./_lib/http");
const at = require("./_lib/airtable");

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "POST")) return;

  const b = h.body(req) || {};
  const path = h.clean(b.path, 300);
  const referrer = h.clean(b.referrer, 300);
  const ua = h.clean(req.headers && req.headers["user-agent"], 250);

  if (!path) return res.status(200).json({ ok: true, recorded: false });

  // The durable record. Everything after this is a convenience.
  console.log("BROKEN_LINK_REPORT", JSON.stringify({ path, referrer, ua, at: at.nowIso() }));

  // One report per path per minute per instance: a script hammering the button
  // must not turn into a thousand Airtable writes.
  const limited = !h.rateLimit("brokenlink:" + path, 1, 60000).ok;
  if (limited || !at.configured()) return res.status(200).json({ ok: true, recorded: true });

  try {
    const existing = await at.findOne(at.T.brokenLinks, "{path}='" + at.esc(path) + "'");
    if (existing) {
      await at.update(at.T.brokenLinks, existing.id, {
        count: Number(existing.fields.count || 1) + 1,
        last_seen: at.nowIso(),
        referrer: referrer || existing.fields.referrer || ""
      });
    } else {
      await at.create(at.T.brokenLinks, {
        report_id: at.uuid(), path, referrer, user_agent: ua,
        count: 1, status: "New", first_seen: at.nowIso(), last_seen: at.nowIso()
      });
    }
  } catch (err) {
    // Deliberately swallowed. The log line above is the record.
    console.error("BROKEN_LINK_ROW_FAIL", err.message);
  }

  return res.status(200).json({ ok: true, recorded: true });
};
