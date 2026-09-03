/* Campaign economics: what a supporter costs, what they give back.
 *
 * Two numbers decide whether a campaign lives: what it pays to acquire a
 * supporter, and what that supporter is worth. Everything here exists to
 * produce those two honestly, which mostly means being strict about what
 * counts as evidence.
 *
 * The classification rules below are the part worth reading. They are not
 * guesses dressed up as data: each one names the marker it trusts and refuses
 * to infer past it. A signature with no marker is Direct, not "probably an
 * ad", because a campaign that flatters its own attribution buys the wrong
 * ads for a month before anyone notices.
 */

const GRAPH = "https://graph.facebook.com/v21.0";

// The advertiser's own timezone. Meta reports hourly spend in it, and a day
// boundary an hour out puts a morning's spend on yesterday's CPA.
const TZ = () => process.env.ADVERTISER_TZ || "Australia/Sydney";

function adAccountId() {
  const id = process.env.META_AD_ACCOUNT_ID;
  if (!id) throw new Error("META_AD_ACCOUNT_ID not set");
  return id.startsWith("act_") ? id : "act_" + id;
}

/* An ads_read token. Falls back to the CAPI token, which works whenever that
 * token's system user also has access to the ad account — commonly true, and
 * worth trying before telling a campaign director to mint another token. */
function adsToken() {
  const t = process.env.META_ADS_TOKEN || process.env.META_CAPI_TOKEN;
  if (!t) throw new Error("META_ADS_TOKEN (or META_CAPI_TOKEN) not set");
  return t;
}

const configured = () =>
  !!(process.env.META_AD_ACCOUNT_ID && (process.env.META_ADS_TOKEN || process.env.META_CAPI_TOKEN));

async function graph(path, params) {
  const search = new URLSearchParams({ access_token: adsToken(), ...params });
  const r = await fetch(GRAPH + "/" + path + "?" + search);
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error("meta " + path + ": " + JSON.stringify((json && json.error) || json).slice(0, 300));
  }
  return json;
}

// A calendar date in the advertiser's timezone, offset by whole days.
function localDate(offsetDays, at) {
  const base = at === undefined ? Date.now() : at;
  return new Date(base + (offsetDays || 0) * 86400000)
    .toLocaleDateString("en-CA", { timeZone: TZ() });
}

function localHour(at) {
  const s = new Date(at === undefined ? Date.now() : at)
    .toLocaleTimeString("en-GB", { timeZone: TZ(), hour12: false });
  return parseInt(s.slice(0, 2), 10);
}

/* Guardrail thresholds.
 *
 * The defaults are here; the live values sit in a Site Stats row so a
 * director can change what counts as "too expensive" at nine on a Sunday
 * without a deploy. That row is the same escape hatch the rest of the site
 * gives to copy, applied to a number that changes with the ad market.
 */
const DEFAULTS = {
  cpa_threshold: Number(process.env.CPA_ALERT_THRESHOLD || 2.5),
  min_spend: Number(process.env.ALERT_MIN_SPEND || 15),
  window_hours: Number(process.env.ALERT_WINDOW_HOURS || 3),
  sms_mobile: process.env.ALERT_MOBILE || ""
};

async function settings(at) {
  const out = { ...DEFAULTS };
  try {
    const row = await at.getStat("econ_settings");
    if (row && row.text) Object.assign(out, JSON.parse(row.text));
  } catch (e) { /* the defaults are a working configuration on their own */ }
  return out;
}

/* An ad id is fifteen digits or more. Nothing else is accepted as one, and
 * that strictness is the whole point of this function.
 *
 * The reference build once matched a CAMPAIGN id against ad ids and counted
 * only the lead-ad signups, reporting $8.14 a supporter on a day the ad
 * account showed $1.22. utm_campaign carries the campaign id, utm_medium the
 * adset, utm_content the ad. Only utm_content is read here. */
const AD_ID = /^\d{15,}$/;

function adIdOf(f) {
  if (f.meta_ad_id) return String(f.meta_ad_id);
  if (AD_ID.test(String(f.utm_content || ""))) return String(f.utm_content);
  return null;
}

/* First-touch acquisition channel, strongest evidence first.
 *
 * "Meta ad" means a paid marker was present. A Facebook click without one is
 * organic reach — a share, a page post, somebody's comment — and separating
 * those two is the difference between knowing the ads work and assuming it. */
const META_ORGANIC = new Set(["ig", "fb", "facebook", "instagram", "meta", "social"]);

function channelOf(f) {
  const src = String(f.utm_source || "").toLowerCase();
  const paid = !!f.meta_ad_id ||
    AD_ID.test(String(f.utm_content || "")) ||
    AD_ID.test(String(f.utm_campaign || "")) ||
    src === "fb_ads";
  if (paid) return "Meta ad";
  if (f.fbclid || META_ORGANIC.has(src)) return "Meta organic";
  if (f.ref_used) return "Referral";
  if (f.utm_source) return "Other";
  return "Direct";
}

/* The same question for somebody who only ever donated. They have no
 * signature to classify from, so the markers come off the Stripe checkout
 * payload, which has carried the landing UTMs in metadata since the donation
 * path was built. Without this, every donor who never signed lands in one
 * "Unclassified" bucket and the channel report understates paid acquisition. */
function channelFromDonation(payload) {
  let p = {};
  try { p = JSON.parse(payload || "{}"); } catch (e) { return "Direct"; }
  const md = (p.raw && p.raw.metadata) || {};
  const src = String(md.utm_source || "").toLowerCase();
  if (AD_ID.test(String(md.utm_content || "")) || AD_ID.test(String(md.utm_campaign || "")) || src === "fb_ads") {
    return "Meta ad";
  }
  if (p.fbclid || md.fbclid) return "Meta organic";
  if (md.ref || p.ref) return "Referral";
  if (md.utm_source) return "Other";
  return "Direct";
}

/* Donor journey: not how the person was recruited, but how their first gift
 * was raised. The two answers differ often enough to matter — a supporter
 * recruited by an ad in March who gives to a text in September is an SMS
 * result, and crediting it to the ad flatters a campaign that has stopped.
 *
 * "Email appeal" is the residual, deliberately. The CRM's email links carry
 * no tags, so an existing supporter giving with no markers at all is almost
 * always reading an email. Naming that assumption is better than hiding it in
 * an "Unclassified" pile nobody looks at.
 */
const SIGNUP_WINDOW_MS = Number(process.env.JOURNEY_SIGNUP_WINDOW_HOURS || 24) * 3600000;

function journeyOf(o) {
  const gift = Date.parse(o.firstGiftTs || "") || 0;
  const sig = Date.parse(o.earliestSigTs || "") || null;
  // Signed then gave, inside the window. The fifteen minutes of slack is for
  // the signature and the gift landing out of order, which they do: the
  // donation webhook can beat the queue drain that writes the signature.
  if (sig && sig <= gift + 15 * 60000 && gift - sig <= SIGNUP_WINDOW_MS) return "Donated at signup";

  const seen = Date.parse(o.firstSeenTs || "") || null;
  const existedBefore = (sig && sig < gift) || (seen && gift - seen > 3600000);
  if (!existedBefore) return "Unsolicited";

  let p = {}, md = {};
  try { p = JSON.parse(o.firstGiftPayload || "{}"); md = (p.raw && p.raw.metadata) || {}; } catch (e) { /* unmarked */ }
  const src = String(md.utm_source || "").toLowerCase();
  if (src === "sms" || md.sms_variant || p.sms_variant) return "SMS appeal";
  if (AD_ID.test(String(md.utm_content || "")) || AD_ID.test(String(md.utm_campaign || "")) || src === "fb_ads") {
    return "Ad appeal";
  }
  if (p.fbclid || md.fbclid || META_ORGANIC.has(src)) return "Social click";
  return "Email appeal";
}

const CHANNELS = ["Meta ad", "Meta organic", "Referral", "Other", "Direct", "Unclassified"];
const JOURNEYS = [
  "Donated at signup", "Unsolicited", "SMS appeal", "Ad appeal",
  "Social click", "Email appeal", "Unclassified"
];

module.exports = {
  GRAPH, TZ, adAccountId, adsToken, configured, graph,
  localDate, localHour, settings, DEFAULTS,
  adIdOf, channelOf, channelFromDonation, journeyOf,
  CHANNELS, JOURNEYS, AD_ID
};
