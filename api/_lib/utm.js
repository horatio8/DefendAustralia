/* The five utm_* parameters, read off a landing URL.
 *
 * This used to live inside api/petition-signup.js, which was fine while the
 * petition was the only form that reported attribution. It is not any more:
 * the email-action pages post to Campaign Nucleus too, and a lead page that
 * records no source is a lead page nobody can tell you the value of. Two
 * copies of this would drift the first time a sixth parameter mattered.
 *
 * Anything unparseable yields {} rather than throwing. A missing source URL is
 * normal — a beacon fired from a page opened without any campaign tagging has
 * nothing to report, and that is not an error.
 */
const KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];

function utmsFrom(sourceUrl) {
  const out = {};
  try {
    const q = new URL(sourceUrl).searchParams;
    KEYS.forEach((k) => {
      const v = q.get(k);
      if (v) out[k] = v;
    });
  } catch (e) { /* no or unparseable URL */ }
  return out;
}

module.exports = { KEYS, utmsFrom };
