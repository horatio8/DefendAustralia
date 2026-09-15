/* Email-action campaigns: one registry both the capture path and the drain read.
 *
 * There are two of these now and there will be more: a page that asks
 * supporters to write to somebody, with a target, a set of demands and a
 * place for the resulting names to land. What changes between them is who is
 * written to and what the resulting supporter is tagged as. What must not
 * change is the plumbing.
 *
 * The reason this is a shared file rather than a constant in each handler is
 * that /api/capture chooses the queue type and /api/drain reads it. Those two
 * have to agree exactly, and the failure when they do not is silent: rows
 * land in the queue with a type nothing handles, the drain skips them, and
 * the campaign discovers a week later that a page it was advertising captured
 * nobody.
 */

// An unregistered campaign falls back to the Minister rather than being
// dropped: a new page that forgets to register here still captures its people.
const FALLBACK = "minister";

const CAMPAIGNS = {
  minister: {
    label: "Minister for Veterans' Affairs",
    sourceChannel: "Minister email",
    eventType: "Minister Email Sent",
    tags: ["Defend Sacred Ground", "Contacted the Minister"],
    // Which Campaign Nucleus lead page the completed sends are posted to.
    // Empty means profile-only: the supporter still reaches the CRM, just not
    // as a form entry.
    formEnv: "CN_MINISTER_FORM_ID"
  },
  beazley: {
    label: "Chair of the Council of the Australian War Memorial",
    sourceChannel: "Chair email",
    eventType: "Chair Email Sent",
    tags: ["Defend Sacred Ground", "Contacted the Chair"],
    formEnv: "CN_BEAZLEY_FORM_ID"
  }
};

const known = (key) => Object.prototype.hasOwnProperty.call(CAMPAIGNS, key);
const get = (key) => CAMPAIGNS[key] || CAMPAIGNS[FALLBACK];

// The queue type, which is also the drain's handler name. Normalised here so
// a page cannot post an arbitrary string into a single-select field.
const queueType = (key) => (known(key) ? key : FALLBACK);

// The lead page id for a campaign, or "" when none is configured. Read from
// the environment rather than committed: a form id is not a secret, but it
// differs per deployment and a hardcoded one sends a preview's test traffic
// into the live CRM.
function formId(key) {
  const c = get(key);
  return c.formEnv ? String(process.env[c.formEnv] || "").trim() : "";
}

module.exports = { CAMPAIGNS, FALLBACK, known, get, queueType, formId };
