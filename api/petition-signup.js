// POST /api/petition-signup — a signature.
//
// Campaign Nucleus is written first and always. It is the system of record,
// the site's counter reads from it, and it is the only place a signature has
// to be for the campaign to have it. Only once Nucleus has answered does the
// submission go to Airtable, and it goes as a single queued row rather than
// five relational writes, because Airtable allows five requests a second per
// base and a launch surge is far faster than that.
//
// The supporter is told they signed when at least one durable store accepted
// them. If neither did, the payload is logged in full for replay and the form
// says so rather than thanking them for nothing.
const h = require("./_lib/http");
const nucleus = require("./_lib/nucleus");
const queue = require("./_lib/queue");
const at = require("./_lib/airtable");
const meta = require("./_lib/meta");
const sms = require("./_lib/sms");
const { refCodeFor, normCode } = require("./_lib/refcode");

/* The welcome text. One segment, always, which is not a style preference:
 * Cellcast bills per segment, so 161 characters is double the cost of 160 on
 * every signature the campaign ever takes.
 *
 * The link carries no https://. Handsets linkify a bare domain, and the eight
 * characters buy a longer first name instead.
 *
 * No opt-out line. Cellcast appends one on the way out, and paying for the
 * same words twice on every message is the sort of thing nobody notices until
 * the invoice. STOP replies are honoured either way, by the inbound poll and
 * the two opt-out checks in the queue.
 *
 * It is signed, which is what an unidentified number asking for money is not.
 *
 * The greeting is separate from the body so the body can stand alone. A
 * supporter whose first name is missing, junk, or long enough to push the
 * message into a second segment gets the unaddressed version rather than a
 * message that costs twice as much or opens "bmmarfleet,". */
const WELCOME_SMS =
  "Peter O'Brien here. They have millions. But we have Australians like you. " +
  "Will you defend the War Memorial? {link}";

/* A first name is only worth using if it reads as one.
 *
 * Lead ad and form fields collect whatever the keyboard gave them, and the
 * queue has held values like "bmmarfleet" in name positions. Addressing
 * somebody by a fragment of their email address is worse than not addressing
 * them at all, so anything that is not letters and ordinary name punctuation
 * falls through to the unaddressed version. */
function salutation(first, budget) {
  const v = String(first || "").trim();
  if (v.length < 2 || v.length > budget) return "";
  if (!/^[A-Za-z][A-Za-z'’\- ]*$/.test(v)) return "";
  // Sent as typed apart from the first letter. "sarah" is a real submission
  // and "sarah, Peter O'Brien here" reads as a mail merge that went wrong.
  return v.charAt(0).toUpperCase() + v.slice(1);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  const b = req.body && typeof req.body === "object" ? req.body : safeParse(req.body);
  if (!b) return res.status(400).json({ error: "bad payload" });

  const first = str(b.first), last = str(b.last), email = at.normEmail(b.email);
  if (!first || !last || !email) return res.status(400).json({ error: "name and email required" });

  const utm = utmsFrom(str(b.source_url));
  const p = {
    first_name: first, last_name: last, email,
    mobile: str(b.mobile), postcode: str(b.postcode),
    campaign: str(b.campaign) || "defend-sacred-ground",
    consent: b.consent !== false,
    ref: normCode(b.ref), source_url: str(b.source_url),
    referral_code: refCodeFor(email),
    // First touch, kept on the contact. This is the thread back to the ad that
    // produced the supporter, and it is in the URL for one page load only.
    fbclid: str(b.fbclid).slice(0, 200), fbp: str(b.fbp).slice(0, 120),
    ...utm
  };

  // 1. Nucleus, first and foremost.
  //
  // Signing twice is common: the button is pressed again while the next page
  // is still loading, or someone comes back and is not sure it worked. A
  // second entry would inflate the count the site reads, so an email that has
  // already signed is treated as signed rather than added again.
  let cnEntryId = null, cnError = "", duplicate = false;
  try {
    duplicate = await nucleus.entryExists("petition", p.email);
  } catch (err) {
    // Unknown rather than false: let the signature through instead of losing it.
    console.error("CN_DUP_CHECK_FAIL", err.message);
  }

  try {
    if (duplicate) throw { skip: true };
    cnEntryId = await nucleus.submitEntry("petition", {
      first_name: p.first_name, last_name: p.last_name, email: p.email,
      phone: p.mobile, postcode: p.postcode,
      utm_source: utm.utm_source, utm_medium: utm.utm_medium,
      utm_campaign: utm.utm_campaign, utm_term: utm.utm_term, utm_content: utm.utm_content
    });
  } catch (err) {
    // A duplicate email is a re-signature, not a failure.
    if (!err || !err.skip) {
      cnError = err.status === 422 ? "" : String(err.message || err);
      if (cnError) console.error("CN_PETITION_FAIL", cnError);
    }
  }
  const cnOk = duplicate || !!cnEntryId || (!cnError && nucleus.configured());

  // 2. Airtable, one queued row, expanded later by the drain worker.
  let queued = { queued: false };
  try { queued = await queue.enqueue("petition", { ...p, duplicate }, { entryId: cnEntryId, error: cnError }); }
  catch (err) { console.error("QUEUE_PETITION_FAIL", err.message); }

  const stored = cnOk || queued.queued;
  if (!stored) console.error("PETITION_UNSTORED", JSON.stringify(p));

  // 3. Meta, server side, paired with the browser's Lead event by a shared id
  // derived from the email and the day. A supporter whose pixel was blocked is
  // still counted; one whose pixel fired is still counted once.
  //
  // Awaited rather than fired and forgotten: a lambda that returns can be
  // frozen before an unawaited promise resolves, and a dropped conversion is
  // an ad budget spent blind. It is wrapped so it can never fail the request.
  if (!duplicate) {
    try {
      await meta.send({
        event_name: "Lead",
        event_id: meta.eventId("lead", p.email + ":" + new Date().toISOString().slice(0, 10)),
        source_url: p.source_url,
        custom: { content_name: p.campaign },
        user: {
          email: p.email, mobile: p.mobile, postcode: p.postcode,
          first_name: p.first_name, last_name: p.last_name,
          fbp: p.fbp, fbc: meta.fbcFrom(p.fbclid),
          ip: (req.headers["x-forwarded-for"] || "").split(",")[0].trim(),
          ua: String(req.headers["user-agent"] || "").slice(0, 400)
        }
      });
    } catch (err) { console.error("META_LEAD_FAIL", err.message); }
  }

  // 4. The donation ask, to somebody who has just signed.
  //
  // Only for a new signature. A duplicate is a second press of the same
  // button or a return visit, and the person was enrolled the first time;
  // enrolling again is how one supporter comes to receive the same appeal
  // twice in a minute.
  //
  // Enrolment is by automation id from the environment, so an unset variable
  // means this does nothing at all rather than failing the signature. The id
  // has to be copied out of the Nucleus interface: automations cannot be
  // created or listed over the API.
  if (!duplicate && nucleus.configured() && process.env.CN_AUTOMATION_SIGNATURE_ASK) {
    try {
      await nucleus.automationAdd(process.env.CN_AUTOMATION_SIGNATURE_ASK, {
        email: p.email, first_name: p.first_name, last_name: p.last_name,
        mobile: p.mobile, postcode: p.postcode,
        tags: ["Defend Sacred Ground", "Signed petition"]
      });
    } catch (err) { console.error("CN_SIGNATURE_ASK_FAIL", err.message); }
  }

  // 5. The welcome text.
  //
  // Same rule as the ask above: new signatures only. It is also deduped a
  // second time inside the queue on phone plus template, which is what stops
  // one person who signs from two devices, or signs again with a different
  // email, from being texted twice. Belt and braces on purpose, because a
  // duplicate text is the one mistake a supporter cannot unsee.
  //
  // No A/B here. The lapse texts are split because there is a real question
  // about which appeal recovers more people; a welcome has nothing to test
  // and splitting it would only make the reporting harder to read.
  //
  // Queued rather than sent. The queue is where the opt-out check, the
  // dedupe and the retry live, and a capture path must never be the thing
  // that talks to a provider: a signature cannot be allowed to fail, or to
  // wait, on an SMS gateway being slow.
  if (!duplicate && p.mobile && sms.configured()) {
    try {
      const link = (process.env.SITE_DOMAIN || "defendsacredground.com") + "/fund";
      const body = WELCOME_SMS.replace("{link}", link);
      const name = salutation(p.first_name, 160 - body.length - 2);
      await sms.queue({
        phone: h.e164(p.mobile),
        template: "petition_welcome",
        message: name ? name + ", " + body : body
      });
    } catch (err) { console.error("SMS_WELCOME_FAIL", err.message); }
  }

  return res.status(200).json({
    ok: true, stored,
    referral_code: p.referral_code,
    cn: !!cnEntryId || duplicate,
    fallback: HOSTED_FORM
  });
};

const HOSTED_FORM = process.env.CN_HOSTED_PETITION_URL || "https://teller.nucleuspages.com/landing/dsg-beazley";

function str(v) { return v == null ? "" : String(v).trim(); }
function safeParse(v) { try { return JSON.parse(v); } catch (e) { return null; } }

function utmsFrom(sourceUrl) {
  const out = {};
  try {
    const q = new URL(sourceUrl).searchParams;
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach((k) => {
      const v = q.get(k);
      if (v) out[k] = v;
    });
  } catch (e) { /* no or unparseable URL */ }
  return out;
}
