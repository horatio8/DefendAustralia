/* Signature milestones: notice when the number crosses something worth saying.
 *
 * A campaign crossing fifty thousand signatures is a press release, a text to
 * the list and a post — and it is worth exactly nothing if the first anyone
 * notices is a week later. The count is already read on every page load; this
 * is the two lines that make somebody aware of it.
 *
 * A crossing fires once, ever. The last total that was checked is kept in
 * Site Stats, so a serverless instance that has just cold-started does not
 * re-announce a milestone the previous one already announced — an in-memory
 * high-water mark would announce it once per instance, which on a busy day is
 * dozens of times.
 *
 * Nothing here is allowed to fail loudly. This runs behind the busiest
 * endpoint on the site, and a supporter must never see an error because a
 * webhook was slow.
 */

const at = require("./airtable");

const KEY = "signature_milestone_seen";

const targets = () => String(process.env.SIGNATURE_MILESTONES || "")
  .split(",")
  .map((s) => Number(String(s).trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
  .sort((a, b) => a - b);

/* Which milestones lie strictly between what we last saw and what we see now.
 * Pure, so the interesting half is testable without a datastore. */
function crossed(previous, current, list) {
  const prev = Number(previous) || 0;
  const now = Number(current) || 0;
  return (list || []).filter((m) => prev < m && now >= m);
}

/* Best effort, and deliberately so. Returns the milestones announced, which
 * is [] whenever anything is missing, unset or broken. */
async function check(total) {
  const list = targets();
  if (!list.length || !at.configured()) return [];

  let previous = 0, row = null;
  try {
    row = await at.getStat(KEY);
    previous = Number(row && row.num) || 0;
  } catch (err) {
    // No stored high-water mark means no way to tell a first crossing from a
    // repeat, and announcing a milestone twice is worse than announcing it
    // late. Record where we are and say nothing this time.
    return [];
  }

  // First ever run. Seed at the current total rather than zero, or a site
  // that already has ninety thousand signatures announces every milestone it
  // has ever passed, all at once, on the day this ships.
  if (!row) {
    await at.setStat(KEY, total, at.nowIso()).catch(() => {});
    return [];
  }

  const hits = crossed(previous, total, list);
  if (total > previous) await at.setStat(KEY, total, at.nowIso()).catch(() => {});
  if (!hits.length) return [];

  for (const m of hits) {
    await at.logEvent({
      event_type: "Milestone Crossed",
      source_channel: "Direct",
      payload: { milestone: m, total }
    }).catch((err) => console.error("MILESTONE_LOG_FAIL", err.message));

    const hook = process.env.MILESTONE_WEBHOOK_URL;
    if (hook) {
      await fetch(hook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Signatures just passed " + m.toLocaleString() + " — now " + Number(total).toLocaleString() + "."
        })
      }).catch((err) => console.error("MILESTONE_HOOK_FAIL", err.message));
    }
  }
  return hits;
}

module.exports = { check, crossed, targets, KEY };
