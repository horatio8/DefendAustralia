// Invoke every HTTP handler with a real request shape and record what it
// writes, what it answers, and whether it throws.
//
// This is the closest thing to production available without deploying: the
// handlers are the real ones, only the network clients are stubbed.
const fs = require("fs"), path = require("path"), Module = require("module");
const ROOT = require("path").resolve(__dirname, "..");
const OUT = require("os").tmpdir();

const WROTE = [], READS = [], QUEUED = [];
const realAt = require(ROOT + "/api/_lib/airtable.js");
const T = realAt.T;

const atStub = {
  T, configured: () => true, esc: realAt.esc, uuid: realAt.uuid,
  nowIso: realAt.nowIso, normEmail: realAt.normEmail,
  call: async (m, table, qs) => {
    if (qs && /filterByFormula/.test(qs)) {
      READS.push({ table, formula: decodeURIComponent((qs.match(/filterByFormula=([^&]*)/) || [])[1] || "") });
    }
    return { records: [] };
  },
  findOne: async (table, formula) => { READS.push({ table, formula }); return null; },
  create: async (table, fields) => { WROTE.push({ table, fields: Object.keys(fields) }); return { id: "rec1", fields }; },
  update: async (table, id, fields) => { WROTE.push({ table, fields: Object.keys(fields) }); return {}; },
  upsertContact: async () => ({ id: "recC", contact_id: "c1", created: true, fields: {} }),
  logEvent: async () => ({ id: "recE", event_id: "e1", duplicate: false }),
  markFanout: async () => {},
  getStat: async () => null,
  setStat: async () => { WROTE.push({ table: T.stats, fields: ["key", "num_value", "text_value", "updated_at"] }); }
};

const STUBS = new Map([
  [path.join(ROOT, "api/_lib/airtable.js"), atStub],
  [path.join(ROOT, "api/_lib/nucleus.js"), {
    FORMS: {}, configured: () => true, submitEntry: async () => "cn1",
    entryExists: async () => false, entryCount: async () => 4242, upsertProfile: async () => "p1"
  }],
  [path.join(ROOT, "api/_lib/queue.js"), {
    enqueue: async (type, payload, cn) => { QUEUED.push({ type, payload, cn }); return { queued: true, queue_id: "q1" }; },
    flush: async () => {}, drainBuffer: async () => {}, BATCH: 10
  }],
  [path.join(ROOT, "api/_lib/sms.js"), {
    configured: () => true, queue: async (m) => { WROTE.push({ table: T.smsSends, fields: [
      "send_id", "phone", "dedupe_key", "contact_id", "template", "test", "variant",
      "message", "status", "not_before", "attempts", "created_at"] }); return { queued: true }; },
    send: async () => "m1", inbound: async () => [], isStop: (b) => /^stop/i.test(String(b || "")),
    dedupeKey: () => "k1", optedOut: async () => false
  }],
  [path.join(ROOT, "api/_lib/meta.js"), {
    configured: () => true, send: async () => ({ sent: true }), userData: () => ({}),
    hashed: () => "h", fbcFrom: () => "fb.1.x.y", eventId: () => "eid"
  }],
  [path.join(ROOT, "api/sms-queue.js"), { drain: async () => ({ sent: 0 }) }]
]);

const origResolve = Module._resolveFilename, origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && request.startsWith(".")) {
    let r; try { r = origResolve.call(this, request, parent, isMain); } catch (e) { r = null; }
    if (r && STUBS.has(r)) return STUBS.get(r);
  }
  return origLoad.apply(this, arguments);
};

// Environment the handlers check for.
process.env.WEBINAR_TOKEN_SECRET = "t".repeat(40);
process.env.IP_HASH_SALT = "salt";
process.env.ADMIN_BASIC_AUTH = "u:p";
process.env.CRON_SECRET = "cron";

function mkRes() {
  const res = { statusCode: 0, headers: {}, body: null, ended: false };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; res.ended = true; return res; };
  res.send = (o) => { res.body = o; res.ended = true; return res; };
  res.end = () => { res.ended = true; return res; };
  res.writeHead = (c, h) => { res.statusCode = c; Object.assign(res.headers, h || {}); return res; };
  return res;
}

const AUTH = { authorization: "Basic " + Buffer.from("u:p").toString("base64") };
const CRON = { "x-vercel-cron": "1" };
const UA = { "user-agent": "Mozilla/5.0 (iPhone)" };

const CASES = [
  ["rewrite.js", { method: "POST", body: { session_id: "s", subject: "S", body: "Dear Minister, please halt.", first_name: "Ada", campaign: "minister" }, headers: UA }],
  ["report-broken-link.js", { method: "POST", body: { path: "/nope?x=1", referrer: "https://x" }, headers: UA }],
  ["share-click.js", { method: "POST", body: { code: "redgum", landing: "https://x", referrer: "" }, headers: UA }],
  ["share-signup.js", { method: "POST", body: { email: "a@b.com", first: "Ada" }, headers: UA }],
  ["share-context.js", { method: "GET", query: { code: "REDGUM" }, headers: UA }],
  ["share-issued.js", { method: "POST", body: { platform: "facebook", code: "REDGUM" }, headers: UA }],
  ["petition-signup.js", { method: "POST", body: { first: "Ada", last: "L", email: "a@b.com", mobile: "0412345678", postcode: "2600", campaign: "defend-sacred-ground", ref: "REDGUM", source_url: "https://x?utm_source=fb", fbclid: "abc" }, headers: UA }],
  ["partial.js", { method: "POST", body: { first: "Ada", last: "L", email: "a@b.com" }, headers: UA }],
  ["event-log.js", { method: "POST", body: { type: "contact_message", first: "Ada", last: "L", email: "a@b.com", topic: "Media", message: "hi" }, headers: UA }],
  ["capture.js", { method: "POST", body: { session_id: "s1", first: "Ada", last: "L", email: "a@b.com", subject: "S", body: "B", seq: 2, status: "partial" }, headers: UA }],
  ["signature-count.js", { method: "GET", headers: UA }],
  ["meta-capi.js", { method: "POST", body: { event_name: "Lead", event_id: "x", email: "a@b.com" }, headers: UA }],
  ["meta-lead-webhook.js", { method: "POST", body: { leadgen_id: "L1", form_id: "F1", fields: { first_name: "Ada", last_name: "L", email: "a@b.com", phone: "0412345678" } }, headers: UA }],
  ["meta-lead-webhook.js#verify", { method: "GET", query: { "hub.mode": "subscribe", "hub.verify_token": "x", "hub.challenge": "c" }, headers: UA }],
  ["track-redirect.js", { method: "GET", query: { l: "fund", c: "REDGUM", v: "a", t: "sms_copy" }, headers: UA }],
  ["cellcast-inbound.js", { method: "POST", body: { from: "0412345678", body: "STOP", received_at: "2026-08-13T00:00:00Z" }, headers: UA }],
  ["sms-inbound-poll.js", { method: "GET", headers: CRON }],
  ["sms-queue.js", { method: "GET", headers: CRON }],
  ["lapse-sweep.js", { method: "GET", headers: CRON }],
  ["nightly-rollup.js", { method: "GET", headers: CRON }],
  ["survey-uid-topup.js", { method: "GET", headers: CRON }],
  ["drain.js", { method: "GET", headers: CRON }],
  ["survey/resolve.js", { method: "POST", body: { uid: "redgum", slug: "memorial", src: "email" }, headers: UA }],
  ["survey/capture.js", { method: "POST", body: { first_name: "Ada", email: "a@b.com", mobile: "0412345678" }, headers: UA }],
  ["survey/answer.js", { method: "POST", body: { uid: "REDGUM", slug: "memorial", screen: "motivation", value: "family" }, headers: UA }],
  ["survey/complete.js", { method: "POST", body: { uid: "REDGUM", slug: "memorial", answers: { motivation: "family", help: ["donate"] }, tagTemplates: { motivation: "motiv:{value}" } }, headers: UA }],
  ["webinar-context.js", { method: "GET", query: { slug: "tuesday" }, headers: UA }],
  ["webinar-register.js", { method: "POST", body: { slug: "tuesday", first_name: "Ada", email: "a@b.com", attending: "Yes" }, headers: UA }],
  ["webinar-question.js", { method: "POST", body: { slug: "tuesday", question: "What did they approve?" }, headers: UA }],
  ["webinar-tokens.js", { method: "GET", query: { slug: "tuesday" }, headers: AUTH }],
  ["survey-uids.js", { method: "GET", query: { mode: "csv" }, headers: AUTH }],
  ["leaderboard.js", { method: "GET", headers: AUTH }],
  ["ab-report.js", { method: "GET", query: { json: "1" }, headers: AUTH }],
  ["env-check.js", { method: "GET", headers: AUTH }],
  ["lapse-reconcile.js", { method: "GET", headers: AUTH }],
  ["rally-claim.js", { method: "GET", query: { token: "abc" }, headers: UA }],
  ["youtube.js", { method: "GET", query: { channelId: "UCxxxxxxxxxxxxxxxxxxxxxx" }, headers: UA }],
  // Auth must actually bite.
  ["leaderboard.js#noauth", { method: "GET", headers: UA }],
  ["env-check.js#noauth", { method: "GET", headers: UA }],
  ["nightly-rollup.js#noauth", { method: "GET", headers: UA }],
  // Method guards.
  ["rewrite.js#get", { method: "GET", headers: UA }],
  ["share-click.js#options", { method: "OPTIONS", headers: UA }]
];

(async () => {
  const rows = [];
  for (const [spec, reqShape] of CASES) {
    const file = spec.split("#")[0];
    WROTE.length = 0;
    const handler = require(path.join(ROOT, "api", file));
    const fn = typeof handler === "function" ? handler : handler.default;
    const req = { method: "GET", query: {}, body: null, headers: {}, socket: { remoteAddress: "1.2.3.4" }, on: () => {}, ...reqShape };
    req.headers = { ...(reqShape.headers || {}) };
    const res = mkRes();
    let threw = "";
    try { await fn(req, res); } catch (e) { threw = e.message; }
    rows.push({
      spec, status: res.statusCode, ended: res.ended, threw,
      wrote: [...new Set(WROTE.map((w) => w.table))],
      fields: WROTE.reduce((a, w) => { a[w.table] = [...new Set((a[w.table] || []).concat(w.fields))]; return a; }, {}),
      error: res.body && res.body.error
    });
  }
  fs.writeFileSync(OUT + "/handlers.json", JSON.stringify({ rows, reads: READS, queued: QUEUED }, null, 1));

  let bad = 0;
  for (const r of rows) {
    // A 503 with no API key and a 502 from a blocked outbound host are the
    // designed answers, not faults. What matters is that the handler answered
    // at all and did not throw: an unanswered request hangs the lambda.
    const expected503 = /rewrite/.test(r.spec) && !process.env.ANTHROPIC_API_KEY;
    const expectedFeed = /youtube/.test(r.spec);
    const problem = r.threw || !r.ended || (r.status >= 500 && !expected503 && !expectedFeed);
    if (problem) bad++;
    console.log((problem ? "FAIL  " : "ok    ") + r.spec.padEnd(30) + " " + String(r.status).padEnd(4) +
      (r.threw ? " THREW: " + r.threw.slice(0, 60) : "") +
      (!r.ended ? " NEVER ANSWERED" : "") +
      (r.wrote.length ? "  wrote: " + r.wrote.join(", ") : "") +
      (r.error ? '  "' + String(r.error).slice(0, 46) + '"' : ""));
  }
  console.log("\n" + (bad ? bad + " handlers failed" : "all " + rows.length + " handler calls answered without throwing"));
})();
