// GET /api/env-check — is this deployment actually wired up?
//
// Behind basic auth, HTML by default. Every variable the site uses, whether it
// is set, and what stops working if it is not.
//
// It reports presence, never values. A page that echoed a secret back would be
// a way to read the whole environment through one leaked password, and the
// question this answers is always "is it set", never "what is it".
//
// ?live=1 makes exactly one cheap authenticated read per service. A variable
// that is present but wrong looks identical to a correct one from the outside,
// and that distinction is the entire reason this endpoint exists: the Nucleus
// profile route was set and wrong for days, failing silently on every write.
const h = require("./_lib/http");

const GROUPS = [
  {
    name: "Core",
    vars: [
      { key: "SITE_URL", need: "should", why: "Absolute URLs in Stripe returns and emails." },
      { key: "SITE_DOMAIN", need: "should", why: "CORS allowlist and generated links. Defaults to defendsacredground.com." }
    ]
  },
  {
    name: "Campaign Nucleus (system of record)",
    vars: [
      { key: "CN_API_TOKEN", need: "must", why: "Every signature, and the counter on the site. Without it the count 503s and nothing reaches the CRM." },
      { key: "CN_ACCOUNT_SLUG", need: "should", why: "Which Nucleus account. Defaults to teller." },
      { key: "CN_API_BASE", need: "optional", why: "Only for a non-standard Nucleus host." },
      { key: "CN_PETITION_FORM_ID", need: "optional", why: "Overrides the built-in petition form id." },
      { key: "CN_CONTACT_FORM_ID", need: "optional", why: "Overrides the built-in contact form id." },
      { key: "CN_VOLUNTEER_FORM_ID", need: "optional", why: "Overrides the built-in volunteer form id." },
      { key: "CN_HOSTED_PETITION_URL", need: "optional", why: "Fallback hosted form offered when a signature cannot be stored." },
      { key: "CRM_UID_FIELD", need: "should", why: "Which CRM custom slot holds the survey token. Defaults to custom2. Nothing else may write to it." }
    ]
  },
  {
    name: "Airtable (operational base)",
    vars: [
      { key: "AIRTABLE_TOKEN", need: "must", why: "Every table. Without it the queue, the drain and all reporting are dead." },
      { key: "AIRTABLE_BASE_ID", need: "must", why: "Which base. appVVWhWpNfImwxH9 for this campaign." }
    ]
  },
  {
    name: "Stripe (donations)",
    vars: [
      { key: "STRIPE_SECRET_KEY", need: "must", why: "Custom monthly checkout, the thank-you page and share identity by session. Must be a live mode key: a test key passes every check and still takes no money." },
      { key: "STRIPE_WEBHOOK_SECRET", need: "must", why: "Donation rows, the upsell close and the Purchase event to Meta. Without it no donation is ever recorded." }
    ]
  },
  {
    name: "Meta (ads attribution)",
    vars: [
      { key: "META_PIXEL_ID", need: "should", why: "Browser pixel and the CAPI destination. Without it every ad dollar is unmeasured." },
      { key: "META_CAPI_TOKEN", need: "should", why: "Server-side events. Roughly a third of browser events never arrive without this half." },
      { key: "META_TEST_EVENT_CODE", need: "optional", why: "Routes events to Meta's test view instead of live. Remove before a real flight." },
      { key: "INSTAGRAM_ACCESS_TOKEN", need: "optional", why: "Reads the Instagram grid on the News page. Falls back to META_LEAD_PAGE_TOKEN. Unset shows the curated tiles from site.json instead." },
      { key: "INSTAGRAM_USER_ID", need: "optional", why: "The Instagram business account id. Optional: the site resolves it from the linked Page." },
      { key: "META_LEAD_VERIFY_TOKEN", need: "optional", why: "Meta's webhook subscription handshake for lead ads." },
      { key: "META_LEAD_SECRET", need: "optional", why: "Shared secret on the lead relay. Without it the lead webhook is open." },
      { key: "META_LEAD_FORM_MAP", need: "optional", why: 'JSON map of Meta form id to petition slug, e.g. {"123":"defend-sacred-ground"}.' },
      { key: "META_LEAD_PAGE_TOKEN", need: "optional", why: "Page token with leads_retrieval, used by the hourly pull. Without it leads only arrive if the webhook fires, and a webhook that was down for an hour loses that hour." },
      { key: "META_LEAD_FORM_IDS", need: "optional", why: "Comma-separated form ids the puller walks. Unset makes it discover the page's forms itself." }
    ]
  },
  {
    name: "Cellcast (SMS)",
    vars: [
      { key: "CELLCAST_API_KEY", need: "optional", why: "Outbound texts and the inbound poll. Without it the queue holds and sends nothing." },
      { key: "CELLCAST_SENDER_ID", need: "optional", why: "The from name on a text." },
      { key: "CELLCAST_API_BASE", need: "optional", why: "Only for a non-standard Cellcast host." },
      { key: "CELLCAST_WEBHOOK_SECRET", need: "optional", why: "Shared token on the inbound webhook. Without it the endpoint accepts anything." },
      { key: "SMS_SENDING", need: "optional", why: "on or off. The master switch: off holds the queue and writes nothing to it, so a pause does not build a pile of stale texts that all send at once when it lifts. Unset uses the default compiled into api/_lib/sms.js." }
    ]
  },
  {
    name: "Anthropic (rewrite and question triage)",
    vars: [
      { key: "ANTHROPIC_API_KEY", need: "should", why: 'The "Say it my way" button. Without it the button reports that the service is off, which is honest but the feature is dead.' },
      { key: "ANTHROPIC_MODEL", need: "optional", why: "Defaults to claude-haiku-4-5-20251001." },
      { key: "AI_REWRITE_DAILY_CAP", need: "optional", why: "Hard daily ceiling on rewrites. Unset falls back to 500 a day, which is the safe default. Set 0 to deliberately remove the ceiling." }
    ]
  },
  {
    name: "Campaign Nucleus automations",
    vars: [
      { key: "CN_AUTOMATION_SIGNATURE_ASK", need: "should", why: "Nucleus automation id for the donation ask sent to a new signatory. Unset means a signature is recorded and nothing is ever asked of that person again." },
      { key: "CN_AUTOMATION_PETITION_LAPSE_A", need: "should", why: "Nucleus automation id for arm A of the unfinished-petition follow-up. Automations cannot be created by API, so this id is copied from the Nucleus interface." },
      { key: "CN_AUTOMATION_PETITION_LAPSE_B", need: "should", why: "Arm B of the same test. Without both arms the split cannot happen and everyone gets arm A." },
      { key: "CN_AUTOMATION_DONATION_LAPSE_A", need: "should", why: "Arm A of the abandoned-donation follow-up." },
      { key: "CN_AUTOMATION_DONATION_LAPSE_B", need: "should", why: "Arm B of the abandoned-donation follow-up." },
      { key: "CN_AUTOMATION_PETITION_LAPSE", need: "optional", why: "Single id used for every arm, for running the flow without a split. Overridden by the _A and _B pair." },
      { key: "CN_AUTOMATION_DONATION_LAPSE", need: "optional", why: "The same, for donations." }
    ]
  },
  {
    name: "Webinars and events",
    vars: [
      { key: "WEBINAR_TOKEN_SECRET", need: "should", why: "Signs briefing magic links. Unset means no private briefing can be opened at all." },
      { key: "RALLY_STRIPE_SECRET_KEY", need: "optional", why: "Second Stripe account for tickets. Falls back to the donation account." },
      { key: "RALLY_STRIPE_WEBHOOK_SECRET", need: "optional", why: "Signs the ticket webhook. Without it no ticket is ever recorded." },
      { key: "RALLY_TICKET_PRICE_ID", need: "optional", why: "A Stripe price for tickets. Falls back to RALLY_TICKET_CENTS." },
      { key: "RALLY_TICKET_CENTS", need: "optional", why: "Ticket price in cents when no price id is set. Defaults to 2500." }
    ]
  },
  {
    name: "Advertising economics",
    vars: [
      { key: "META_AD_ACCOUNT_ID", need: "optional", why: "Which ad account to read spend from. Without it nothing knows what a supporter costs." },
      { key: "META_ADS_TOKEN", need: "optional", why: "A token with ads_read. Falls back to META_CAPI_TOKEN, which works when that token's system user can reach the ad account." },
      { key: "ADVERTISER_TZ", need: "optional", why: "The ad account's own timezone. Defaults to Australia/Sydney. An hour out puts a morning's spend on yesterday's cost per supporter." },
      { key: "CPA_ALERT_THRESHOLD", need: "optional", why: "Cost per signature that counts as too expensive. Defaults to 2.5. The live value is the Site Stats econ_settings row, which needs no redeploy." },
      { key: "ALERT_MIN_SPEND", need: "optional", why: "Spend floor before an ad can be called expensive. Defaults to 15, so a $2 ad cannot raise an alarm." },
      { key: "ALERT_WINDOW_HOURS", need: "optional", why: "How many recent hours of spend the guardrail looks at. Defaults to 3." },
      { key: "ALERT_MOBILE", need: "optional", why: "Where a cost alert is texted. Unset records the alert without texting anyone." },
      { key: "JOURNEY_SIGNUP_WINDOW_HOURS", need: "optional", why: "How long after signing a gift still counts as given at signup. Defaults to 24." }
    ]
  },
  {
    name: "Growth and channels",
    vars: [
      { key: "PETITION_SHARE_PERCENT", need: "optional", why: "Percentage sent to the share page after signing; the rest get the donation ask. Unset means everybody is asked for money." },
      { key: "WHATSAPP_CHANNEL_URL", need: "optional", why: "Where /wa1 and /wa2 lead. Unset makes both answer 404 rather than sending supporters somewhere arbitrary." },
      { key: "SIGNATURE_MILESTONES", need: "optional", why: "Comma-separated totals worth announcing, e.g. 50000,75000,100000. Unset means no milestone ever fires." },
      { key: "MILESTONE_WEBHOOK_URL", need: "optional", why: "Posted to when a milestone is crossed. Unset still records the event." },
      { key: "SHOPIFY_STORE_DOMAIN", need: "optional", why: "Merchandise store host, e.g. shop.example.com. Unset leaves the shop page dormant." },
      { key: "SHOPIFY_STOREFRONT_TOKEN", need: "optional", why: "Storefront API token for the merchandise catalogue." },
      { key: "ZERNIO_API_KEY", need: "optional", why: "Reads the social inbox: comments, direct messages and lead forms. Unset means the campaign never sees what people say to it." },
      { key: "ZERNIO_WEBHOOK_SECRET", need: "optional", why: "Signs the social webhook. Unset makes /api/zernio-webhook answer 404, because an unsigned endpoint that writes to the identity graph is a way to fill it with invented people." },
      { key: "ZERNIO_API_BASE", need: "optional", why: "Only for a non-standard host." },
      { key: "RECEPTION_PASSCODE", need: "optional", why: "Shared password for a private event, for people the campaign wants in the room but holds no email address for. Unset means there is no passcode route at all, rather than a built-in one nobody knows about." },
      { key: "RECEPTION_EVENT_SLUG", need: "optional", why: "Which Webinars row /reception opens by default, so the link needs no query string." },
    ]
  },
  {
    name: "Security and operations",
    vars: [
      { key: "ADMIN_BASIC_AUTH", need: "must", why: 'user:password for this page, the leaderboard, the A/B report and the token exports. Unset makes all of them answer 404.' },
      { key: "CRON_SECRET", need: "should", why: "Bearer for manual cron runs. Vercel's own cron header always works regardless." },
      { key: "IP_HASH_SALT", need: "should", why: "Salts hashed IPs in rate limits and AI usage. Unset means the hash is a lookup table of every Australian IP." },
      { key: "DRAIN_KEY", need: "optional", why: "Locks the manual drain endpoint. Unset leaves it open, though it only ever does work that was already due." },
      { key: "SIGNATURE_GOAL_STEP", need: "optional", why: "Milestone step for the nightly hook. Defaults to 15000." },
      { key: "DEFAULT_PETITION_SLUG", need: "optional", why: "Where an unmapped Meta lead lands." }
    ]
  }
];

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET")) return;
  if (!h.requireBasicAuth(req, res)) return;

  const groups = GROUPS.map((g) => ({
    name: g.name,
    vars: g.vars.map((v) => ({
      key: v.key, need: v.need, why: v.why,
      set: !!process.env[v.key],
      // A length is enough to spot a truncated paste without disclosing
      // anything about the value itself.
      length: process.env[v.key] ? String(process.env[v.key]).length : 0
    }))
  }));

  const missingMust = groups.flatMap((g) => g.vars).filter((v) => v.need === "must" && !v.set);
  const missingShould = groups.flatMap((g) => g.vars).filter((v) => v.need === "should" && !v.set);

  let live = null;
  if ((req.query && req.query.live) === "1") live = await probe();

  res.setHeader("Cache-Control", "private, no-store");
  if ((req.query && req.query.json) === "1") {
    return res.status(200).json({ groups, missing_required: missingMust.map((v) => v.key), missing_recommended: missingShould.map((v) => v.key), live });
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(html(groups, missingMust, missingShould, live));
};

/* One cheap authenticated read per service. A variable that is present but
 * wrong is invisible without this. */
async function probe() {
  const out = {};
  const time = async (name, fn) => {
    const t = Date.now();
    try { out[name] = { ok: true, detail: await fn(), ms: Date.now() - t }; }
    catch (err) { out[name] = { ok: false, detail: String(err.message || err).slice(0, 200), ms: Date.now() - t }; }
  };

  await time("nucleus", async () => {
    const nucleus = require("./_lib/nucleus");
    if (!nucleus.configured()) throw new Error("CN_API_TOKEN not set");
    return "petition form entry count: " + (await nucleus.entryCount("petition"));
  });

  await time("airtable", async () => {
    const at = require("./_lib/airtable");
    if (!at.configured()) throw new Error("AIRTABLE_TOKEN or AIRTABLE_BASE_ID not set");
    const r = await at.call("GET", at.T.stats, "maxRecords=1");
    return "reachable, " + (((r && r.records) || []).length) + " stat row read";
  });

  await time("stripe", async () => {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY not set");
    const Stripe = require("stripe");
    const acct = await new Stripe(process.env.STRIPE_SECRET_KEY).accounts.retrieve();
    // Reachability is not the question for this one. A test key is a working
    // key: it authenticates, it retrieves the account, it creates sessions.
    // Those sessions just take no money, and they cannot see any of the live
    // donations the Payment Links produce, so the thank-you page loses every
    // real donor. It is the most convincing kind of wrong, which is why the
    // mode is checked before anything else is reported.
    if (!liveStripeKey(process.env.STRIPE_SECRET_KEY)) {
      throw new Error("TEST MODE key on a live deployment. Custom monthly checkout would open a test page that takes no real money, and /thank-you cannot look up any live donation.");
    }
    return "live mode, account " + (acct.id || "?") + (acct.charges_enabled ? ", charges enabled" : ", CHARGES DISABLED");
  });

  await time("meta", async () => {
    const meta = require("./_lib/meta");
    if (!meta.configured()) throw new Error("META_PIXEL_ID or META_CAPI_TOKEN not set");
    // A PageView with a fixed id, so repeated checks do not inflate anything.
    //
    // external_id is added because the probe previously carried nothing but a
    // hashed country, which is the weakest matching parameter Meta accepts and
    // one it has been known to reject on its own. That rules out one cause of a
    // 400 without inventing a person: the id is a constant, because there is no
    // person behind this event.
    const r = await meta.send({
      event_name: "PageView",
      event_id: "envcheck.probe",
      action_source: "system_generated",
      user: { external_id: "env-check-probe" }
    });
    if (!r.sent) throw new Error("rejected " + (r.status || "") + ": " + (r.reason || "no detail"));
    return "accepted a test event";
  });

  await time("anthropic", async () => {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: 4,
        messages: [{ role: "user", content: "ok" }]
      })
    });
    if (!r.ok) throw new Error("HTTP " + r.status + ": " + (await r.text()).slice(0, 120));
    return "key accepted";
  });

  await time("cellcast", async () => {
    const sms = require("./_lib/sms");
    if (!sms.configured()) throw new Error("CELLCAST_API_KEY not set");
    // The question this probe has to answer is not "is the key valid" but
    // "can this key send from the configured sender". Those are different
    // accounts' questions: a valid key for one Cellcast account paired with
    // a number owned by another passes every check except the send itself.
    const owned = await sms.ownedNumbers();
    const sender = process.env.CELLCAST_SENDER_ID || "";
    const numbers = owned.length ? owned.map((n) => n.number + " (" + n.status + ")").join(", ") : "none";
    const verdict = !sender ? "no CELLCAST_SENDER_ID; texts go out from Cellcast's shared number"
      : owned.some((n) => n.number === sender && /active/i.test(n.status)) ? "sender " + sender + " is active on this key's account"
      : owned.some((n) => n.number === sender) ? "sender " + sender + " is on this key's account but not active"
      : /^[A-Za-z]/.test(sender) ? "alphanumeric sender " + sender + "; not checkable here"
      : "SENDER MISMATCH: " + sender + " is not a number on this key's account";
    const inboundCount = (await sms.inbound(new Date(Date.now() - 86400000).toISOString())).length;
    const detail = verdict + "; key owns " + numbers + "; " + inboundCount + " inbound message(s) in 24h";
    if (/^SENDER MISMATCH/.test(verdict)) throw new Error(detail);
    return detail;
  });

  return out;
}

function html(groups, missingMust, missingShould, live) {
  const badge = (v) => v.set
    ? '<span class="ok">set</span><span class="len">' + v.length + " chars</span>"
    : '<span class="' + (v.need === "must" ? "bad" : v.need === "should" ? "warn" : "off") + '">' +
      (v.need === "must" ? "MISSING" : v.need === "should" ? "not set" : "unset") + "</span>";

  const body = groups.map((g) =>
    "<h2>" + esc(g.name) + "</h2><table>" +
    g.vars.map((v) =>
      "<tr class=" + (v.set ? "y" : v.need === "must" ? "n" : "") + "><td class=k>" + esc(v.key) +
      "</td><td class=s>" + badge(v) + "</td><td class=w>" + esc(v.why) + "</td></tr>").join("") +
    "</table>").join("");

  const summary = missingMust.length
    ? '<div class="alert bad"><b>' + missingMust.length + " required variable" + (missingMust.length > 1 ? "s are" : " is") +
      " missing:</b> " + missingMust.map((v) => esc(v.key)).join(", ") + ". The site is not fully operational."
    : '<div class="alert good"><b>Every required variable is set.</b>';

  const recommended = missingShould.length
    ? " " + missingShould.length + " recommended one" + (missingShould.length > 1 ? "s are" : " is") + " not: " +
      missingShould.map((v) => esc(v.key)).join(", ") + "."
    : " Recommended variables are all set too.";

  const liveHtml = live ? "<h2>Live probe</h2><table>" + Object.keys(live).map((k) =>
    "<tr class=" + (live[k].ok ? "y" : "n") + "><td class=k>" + esc(k) + "</td><td class=s><span class=" +
    (live[k].ok ? "ok>reached" : "bad>FAILED") + "</span><span class=len>" + live[k].ms + "ms</span></td><td class=w>" +
    esc(live[k].detail) + "</td></tr>").join("") + "</table>"
    : '<p class=hint>Add <code>?live=1</code> to make one real authenticated call per service. A variable that is present but wrong looks identical to a correct one until you do.</p>';

  return "<!doctype html><meta charset=utf-8><title>Environment check</title>" +
    "<meta name=robots content=noindex><meta name=viewport content='width=device-width,initial-scale=1'>" +
    "<style>" +
    "body{font:15px/1.55 system-ui,sans-serif;margin:0;background:#FAF6EF;color:#1B1917}" +
    "header{background:#1F3157;color:#FAF6EF;padding:22px 24px}h1{margin:0;font-size:21px}" +
    "main{padding:8px 24px 60px;max-width:1000px}" +
    "h2{font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:#5A5248;margin:28px 0 8px}" +
    "table{border-collapse:collapse;width:100%;background:#fff}" +
    "td{padding:9px 12px;border-bottom:1px solid #EFE7DA;vertical-align:top}" +
    "td.k{font-family:ui-monospace,monospace;font-weight:600;white-space:nowrap}" +
    "td.s{white-space:nowrap;width:1%}td.w{color:#5A5248;font-size:14px}" +
    "tr.n td.k{color:#9E1B24}" +
    ".ok{background:#4A5C4E;color:#fff;padding:2px 7px;font-size:11px;letter-spacing:.06em;text-transform:uppercase}" +
    ".bad{background:#9E1B24;color:#fff;padding:2px 7px;font-size:11px;letter-spacing:.06em}" +
    ".warn{background:#B08D57;color:#fff;padding:2px 7px;font-size:11px;letter-spacing:.06em;text-transform:uppercase}" +
    ".off{background:#E0D6C4;color:#5A5248;padding:2px 7px;font-size:11px;letter-spacing:.06em;text-transform:uppercase}" +
    ".len{display:block;font-size:11px;color:#8A7A5E;margin-top:3px}" +
    ".alert{padding:14px 16px;margin:20px 0;border-left:3px solid}" +
    ".alert.bad{border-color:#9E1B24;background:#FDF2F1}.alert.good{border-color:#4A5C4E;background:#F1F5F1}" +
    ".hint{color:#8A7A5E;font-size:14px}code{background:#EFE7DA;padding:1px 5px}" +
    "</style>" +
    "<header><h1>Environment check</h1></header><main>" +
    summary + recommended + "</div>" + body + liveHtml +
    "<p class=hint>Presence and length only. This page never shows a value.</p></main>";
}

/* One definition of "is this key live", shared with the lapse sweep, which has
 * to answer the same question before it can trust a "no payment found". */
const liveStripeKey = require("./_lib/stripe").liveKey;
module.exports.liveStripeKey = liveStripeKey;
module.exports.GROUPS = GROUPS;

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
