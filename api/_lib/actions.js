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
    formEnv: "CN_MINISTER_FORM_ID",
    form: ""
  },
  beazley: {
    label: "Chair of the Council of the Australian War Memorial",
    sourceChannel: "Chair email",
    eventType: "Chair Email Sent",
    tags: ["Defend Sacred Ground", "Contacted the Chair"],
    formEnv: "CN_BEAZLEY_FORM_ID",
    form: "03db93c9-59d8-491e-945c-229c97d4b8cf"
  }
};

const known = (key) => Object.prototype.hasOwnProperty.call(CAMPAIGNS, key);
const get = (key) => CAMPAIGNS[key] || CAMPAIGNS[FALLBACK];

// The queue type, which is also the drain's handler name. Normalised here so
// a page cannot post an arbitrary string into a single-select field.
const queueType = (key) => (known(key) ? key : FALLBACK);

/* The lead page id for a campaign, or "" when none is configured.
 *
 * The environment wins, and the committed id is the fallback. That ordering
 * is the same one nucleus.js already uses for the petition, contact and
 * volunteer forms, and it is the ordering that matches what a form id
 * actually is: not a secret — it is in the public receiver URL the campaign
 * hands out — but deployment-specific enough to be worth overriding.
 *
 * The cost of committing one is real and should be named: a preview
 * deployment posts its test sends into the live CRM unless the preview sets
 * the variable to "". That is the existing trade for the petition and it is
 * accepted here for the same reason — a page that captures nobody because a
 * dashboard field was never filled in is the worse failure, and it is silent.
 */
function formId(key) {
  const c = get(key);
  const fromEnv = c.formEnv ? String(process.env[c.formEnv] || "").trim() : "";
  if (fromEnv) return fromEnv;
  // An explicitly empty variable turns the form write off, rather than falling
  // through to the committed id. A preview that wants profile-only needs to be
  // able to say so.
  if (c.formEnv && Object.prototype.hasOwnProperty.call(process.env, c.formEnv)) return "";
  return String(c.form || "").trim();
}

module.exports = { CAMPAIGNS, FALLBACK, known, get, queueType, formId };
