// GET /api/features — what is this deployment actually doing?
//
// The companion to /api/env-check, and a different question. env-check
// reports whether a credential is PRESENT. This reports what the site is
// currently DOING, and exactly where each behaviour is controlled — which is
// the question somebody actually has at nine on a Sunday night when a
// supporter says they did not get a text.
//
// Every entry names its control. "Off" with nowhere to turn it on is a bug
// report; "off, set CELLCAST_API_KEY in Vercel and redeploy" is an
// instruction. Environment variables are baked at build time, so anything
// sourced from env needs a redeploy to change, and each such row says so.
//
// A dial reports a value rather than on or off, because "SMS quiet hours: on"
// tells you nothing and "08:00–20:00 Sydney" tells you everything.
//
// ?format=text for something pasteable into a message. ?area=sms to filter.

const h = require("./_lib/http");
const at = require("./_lib/airtable");
const sms = require("./_lib/sms");
const econ = require("./_lib/econ");
const ab = require("./_lib/ab");
const milestones = require("./_lib/milestones");
const social = require("./_lib/social");
const reception = require("./_lib/reception");

const set = (n) => process.env[n] !== undefined && process.env[n] !== "";
const num = (n, d) => (set(n) && Number.isFinite(Number(process.env[n])) ? Number(process.env[n]) : d);

/* Live state read from the datastore, best effort. A read that fails is
 * reported as unread rather than as a value: the settings loader falls back
 * to its defaults silently, and letting an unreachable Airtable masquerade as
 * a confirmed setting is how a dashboard lies. */
async function liveState() {
  const out = { econ_settings: null, econ_settings_read: false, sms_paused_row: null };
  try {
    const row = await at.getStat("econ_settings");
    if (row && row.text) {
      out.econ_settings = JSON.parse(row.text);
      out.econ_settings_read = true;
    }
  } catch (err) { /* reported as unread */ }
  return out;
}

function register(live) {
  const rows = [];
  const add = (area, name, what, on, value, control, note) =>
    rows.push({ area, name, what, on, value: value || null, control, note: note || null });

  // ---- Signatures ----
  add("Petition", "Signature capture", "The petition form writes to the CRM and the queue.",
    !!process.env.CN_API_TOKEN,
    null, "CN_API_TOKEN (env, needs redeploy)");
  add("Petition", "Hosted fallback", "Where a supporter is sent when a signature cannot be stored.",
    !!process.env.CN_HOSTED_PETITION_URL, process.env.CN_HOSTED_PETITION_URL || null,
    "CN_HOSTED_PETITION_URL (env, needs redeploy)",
    process.env.CN_HOSTED_PETITION_URL ? null : "Without it a failed signature is simply lost.");
  add("Petition", "After signing", "Share page versus donation ask, per person.",
    null, num("PETITION_SHARE_PERCENT", 0) + "% to share, " + (100 - num("PETITION_SHARE_PERCENT", 0)) + "% to donate",
    "PETITION_SHARE_PERCENT (env, needs redeploy)");
  add("Petition", "Milestones", "Announcing when the count crosses a round number.",
    milestones.targets().length > 0, milestones.targets().join(", ") || null,
    "SIGNATURE_MILESTONES, MILESTONE_WEBHOOK_URL (env, needs redeploy)");

  // ---- SMS ----
  add("SMS", "Sending", "Whether any text leaves this deployment at all.",
    sms.configured() && !sms.paused(), null,
    "SMS_SENDING=on|off (env, needs redeploy); unset uses the code default",
    sms.paused() ? "Paused. Nothing is queued either, deliberately: queueing through a pause builds a pile of stale texts that all go at once when it lifts." : null);
  add("SMS", "Sender", "The number a text appears to come from.",
    !!process.env.CELLCAST_SENDER_ID, process.env.CELLCAST_SENDER_ID || null,
    "CELLCAST_SENDER_ID (env, needs redeploy)",
    "Must belong to the same Cellcast account as CELLCAST_API_KEY. A mismatch is refused on every send with \"sender id is not registered\". /api/env-check?live=1 checks this.");
  add("SMS", "Quiet hours", "The window during which a queued text may go out.",
    null, sms.OPEN_HOUR + ":00–" + sms.CLOSE_HOUR + ":00 Sydney" + (sms.withinSendingHours() ? " (open now)" : " (closed now)"),
    "OPEN_HOUR / CLOSE_HOUR in api/_lib/sms.js (code)");
  add("SMS", "Inbound", "Reading STOP replies so an opt-out is honoured.",
    sms.configured(), null,
    "Hourly cron /api/sms-inbound-poll, plus the /api/cellcast-inbound webhook");

  // ---- Advertising economics ----
  const cpa = (live.econ_settings && live.econ_settings.cpa_threshold) || econ.DEFAULTS.cpa_threshold;
  add("Economics", "Ad spend", "Pulling per-ad spend and joining it to our own signatures.",
    econ.configured(), null,
    "META_AD_ACCOUNT_ID and META_ADS_TOKEN (env, needs redeploy); cron /api/ad-insights");
  add("Economics", "Cost guardrail", "The cost per signature that raises an alarm.",
    null, "$" + cpa + " over $" + ((live.econ_settings && live.econ_settings.min_spend) || econ.DEFAULTS.min_spend) + " of spend",
    "Site Stats row econ_settings (Airtable, no redeploy); defaults from CPA_ALERT_THRESHOLD",
    live.econ_settings_read ? "Read live from Airtable." : "Airtable row not read — these are the built-in defaults.");
  add("Economics", "Cost alerts by text", "Whether an expensive ad also texts somebody.",
    !!((live.econ_settings && live.econ_settings.sms_mobile) || process.env.ALERT_MOBILE), null,
    "sms_mobile in the econ_settings row, or ALERT_MOBILE (env)",
    "The alert is recorded either way. Nothing ever pauses an ad automatically.");
  add("Economics", "Advertiser timezone", "Which day a given hour of spend belongs to.",
    null, econ.TZ(), "ADVERTISER_TZ (env, needs redeploy)");

  // ---- Growth ----
  add("Growth", "Form prefill", "Filling the form in for somebody already on the list.",
    !!process.env.CN_API_TOKEN, null, "Needs CN_API_TOKEN; the link must carry a profile id",
    "Referral codes and email addresses are deliberately not accepted as keys.");
  add("Growth", "Channel links", "Where /wa1 and /wa2 lead.",
    !!process.env.WHATSAPP_CHANNEL_URL, process.env.WHATSAPP_CHANNEL_URL || null,
    "WHATSAPP_CHANNEL_URL (env, needs redeploy)",
    process.env.WHATSAPP_CHANNEL_URL ? null : "Both paths answer 404 while unset, rather than redirecting somewhere arbitrary.");
  add("Growth", "Shop", "The merchandise catalogue on /shop.",
    !!(process.env.SHOPIFY_STORE_DOMAIN && process.env.SHOPIFY_STOREFRONT_TOKEN),
    process.env.SHOPIFY_STORE_DOMAIN || null,
    "SHOPIFY_STORE_DOMAIN and SHOPIFY_STOREFRONT_TOKEN (env, needs redeploy)");
  add("Growth", "Referral integrity", "Repairing missing and colliding referral codes.",
    at.configured(), null, "Cron /api/referral-integrity",
    "Needs the Sync State table to remember its sweep clock.");

  // ---- Listening ----
  add("Listening", "Social inbox", "Capturing comments and direct messages people send the campaign.",
    social.configured() && !!process.env.ZERNIO_WEBHOOK_SECRET, null,
    "ZERNIO_API_KEY and ZERNIO_WEBHOOK_SECRET (env, needs redeploy)",
    process.env.ZERNIO_WEBHOOK_SECRET ? null : "Without the secret the webhook answers 404, because an unsigned endpoint that writes to the identity graph can be filled with invented people.");
  add("Listening", "Message analysis", "Scoring tone, stance and escalation on what arrives.",
    !!process.env.ANTHROPIC_API_KEY, null, "ANTHROPIC_API_KEY (env); cron /api/social-analyse",
    "Capture never waits for the model. A message lands unscored and is scored later, so a slow model cannot cost a message.");
  add("Listening", "Identity resolution", "Linking a commenter to a supporter we already know.",
    at.configured(), null, "Nightly cron /api/identity-resolver",
    "Email and mobile only, never a name. Most identities stay unresolved, which is the correct outcome.");

  add("Events", "Private invitations", "One personal link per invited guest, and the ledger of who opened theirs.",
    at.configured(), process.env.RECEPTION_EVENT_SLUG || null,
    "RECEPTION_EVENT_SLUG (env); invitations issued at /api/reception-invites",
    "The token is never a referral code: those travel in public share links, so honouring one would let anybody who saw a shared post into the room.");
  add("Events", "Shared passcode", "A second way in for guests with no email address.",
    reception.passcodeSet(), null, "RECEPTION_PASSCODE (env, needs redeploy)",
    reception.passcodeSet() ? "Buys less than an invitation: no prefill, every field typed by hand." : "No passcode route exists while this is unset.");

  // ---- Money ----
  add("Donations", "Checkout", "Taking a card at all.",
    !!process.env.STRIPE_SECRET_KEY, null, "STRIPE_SECRET_KEY (env, needs redeploy)");
  add("Donations", "Recording", "Whether a completed donation is ever written down.",
    !!process.env.STRIPE_WEBHOOK_SECRET, null, "STRIPE_WEBHOOK_SECRET (env, needs redeploy)",
    process.env.STRIPE_WEBHOOK_SECRET ? null : "Without it money is taken and no row is written.");
  add("Donations", "Suggested amount", "Which preset is selected when the panel opens.",
    null, suggested(), "donate.defaultPreset in content/site.json, editable at /admin");

  // ---- Advertising measurement ----
  add("Measurement", "Browser pixel", "Meta events fired from the page.",
    !!process.env.META_PIXEL_ID, null, "META_PIXEL_ID (env, needs redeploy)");
  add("Measurement", "Server events", "The half of the events an ad blocker cannot stop.",
    !!process.env.META_CAPI_TOKEN, null, "META_CAPI_TOKEN (env, needs redeploy)");
  add("Measurement", "Test mode", "Whether events go to Meta's test view instead of live.",
    !!process.env.META_TEST_EVENT_CODE, process.env.META_TEST_EVENT_CODE || null,
    "META_TEST_EVENT_CODE (env, needs redeploy)",
    process.env.META_TEST_EVENT_CODE ? "ON. Live conversions are NOT being counted. Remove before a real flight." : null);
  add("Measurement", "Lead ads", "Signatures captured inside Facebook reaching the CRM.",
    !!process.env.META_LEAD_PAGE_TOKEN, null,
    "META_LEAD_PAGE_TOKEN for the hourly pull, META_LEAD_VERIFY_TOKEN and META_LEAD_SECRET for the webhook");

  // ---- Content and AI ----
  add("Content", "Say it my way", "The AI rewrite on the minister page.",
    !!process.env.ANTHROPIC_API_KEY, null, "ANTHROPIC_API_KEY (env, needs redeploy)");
  add("Content", "Rewrite ceiling", "Hard daily cap on AI spend.",
    null, String(num("AI_REWRITE_DAILY_CAP", 500)) + " a day",
    "AI_REWRITE_DAILY_CAP (env, needs redeploy); 0 removes the ceiling deliberately");
  add("Content", "Victory page", "Whether /won is published.",
    wonEnabled(), null, "won.enabled in content/site.json, editable at /admin");

  // ---- Admin ----
  add("Admin", "Admin surfaces", "The reports, exports and this page.",
    !!process.env.ADMIN_BASIC_AUTH, null, "ADMIN_BASIC_AUTH (env, needs redeploy)",
    process.env.ADMIN_BASIC_AUTH ? null : "Unset makes every admin endpoint answer 404, which is why you are not reading this.");
  add("Admin", "IP hashing", "Whether hashed IPs are salted.",
    !!process.env.IP_HASH_SALT, null, "IP_HASH_SALT (env, needs redeploy)",
    process.env.IP_HASH_SALT ? null : "Unsalted, so the hash is a lookup table of every Australian IP.");

  return rows;
}

function suggested() {
  try {
    const site = require("../content/site.json");
    const v = site && site.donate && site.donate.defaultPreset;
    return v ? "$" + v : "none";
  } catch (err) { return "unreadable"; }
}

function wonEnabled() {
  try {
    const site = require("../content/site.json");
    return !!(site && site.won && site.won.enabled);
  } catch (err) { return false; }
}

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET")) return;
  if (!h.requireBasicAuth(req, res)) return;
  res.setHeader("Cache-Control", "no-store");

  const q = req.query || {};
  const live = await liveState();
  let rows = register(live);
  const area = String(q.area || "").toLowerCase();
  if (area) rows = rows.filter((r) => r.area.toLowerCase().indexOf(area) > -1);

  const on = rows.filter((r) => r.on === true).length;
  const off = rows.filter((r) => r.on === false).length;
  const meta = {
    generated_at: at.nowIso(),
    environment: process.env.VERCEL_ENV || "local",
    counts: { on, off, dials: rows.length - on - off, total: rows.length }
  };

  if (String(q.format || "") === "text") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send(text(rows, meta));
  }
  if (String(q.json || "") === "1") return res.status(200).json({ ...meta, features: rows });

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(html(rows, meta));
};

function text(rows, meta) {
  const lines = ["Defend Sacred Ground — what this deployment is doing",
    meta.environment + ", " + meta.generated_at, ""];
  let area = "";
  for (const r of rows) {
    if (r.area !== area) { area = r.area; lines.push("== " + area + " =="); }
    const state = r.on === true ? "ON " : r.on === false ? "OFF" : "   ";
    lines.push(state + "  " + r.name + (r.value ? ": " + r.value : ""));
    lines.push("      " + r.what);
    lines.push("      control: " + r.control);
    if (r.note) lines.push("      note: " + r.note);
  }
  return lines.join("\n");
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function html(rows, meta) {
  const areas = [];
  for (const r of rows) {
    let g = areas[areas.length - 1];
    if (!g || g.name !== r.area) { g = { name: r.area, rows: [] }; areas.push(g); }
    g.rows.push(r);
  }
  return "<!doctype html><meta charset=utf-8><title>What this deployment does</title>" +
    "<meta name=robots content=noindex><meta name=viewport content='width=device-width,initial-scale=1'>" +
    "<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f6f6f4;color:#111}" +
    "header{padding:28px 24px 8px;max-width:900px;margin:0 auto}h1{font-size:20px;margin:0 0 6px}" +
    "h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#666;margin:26px 0 6px}" +
    "p{color:#555;margin:0 0 6px;max-width:68ch;font-size:13px}main{padding:12px 24px 48px;max-width:900px;margin:0 auto}" +
    "table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e3e3df}" +
    "td{padding:10px 12px;border-bottom:1px solid #eee;vertical-align:top}" +
    "tr:last-child td{border-bottom:0}.st{width:64px;font-size:12px;font-weight:600}" +
    ".on{color:#1a6b2a}.off{color:#8a1a1a}.dial{color:#555}" +
    ".w{color:#555;font-size:13px}.c{color:#888;font-size:12px;font-family:ui-monospace,monospace}" +
    ".note{color:#8a4b00;font-size:12px;margin-top:3px}b{display:block}</style>" +
    "<header><h1>What this deployment does</h1>" +
    "<p><b>" + esc(meta.environment) + "</b> · " + meta.counts.on + " on, " + meta.counts.off +
    " off, " + meta.counts.dials + " dials · " + esc(meta.generated_at) + "</p>" +
    "<p>/api/env-check answers whether a credential is present. This answers what the site " +
    "is doing with it. Environment variables are baked at build time, so anything controlled " +
    "by one needs a redeploy to change. Add ?format=text to paste into a message, " +
    "?area=sms to filter, ?json=1 for raw data.</p></header><main>" +
    areas.map((g) => "<h2>" + esc(g.name) + "</h2><table>" + g.rows.map((r) =>
      "<tr><td class='st " + (r.on === true ? "on'>ON" : r.on === false ? "off'>OFF" : "dial'>—") + "</td>" +
      "<td><b>" + esc(r.name) + (r.value ? ": " + esc(r.value) : "") + "</b>" +
      "<div class=w>" + esc(r.what) + "</div>" +
      "<div class=c>" + esc(r.control) + "</div>" +
      (r.note ? "<div class=note>" + esc(r.note) + "</div>" : "") +
      "</td></tr>").join("") + "</table>").join("") +
    "</main>";
}

module.exports.register = register;
module.exports.liveState = liveState;
