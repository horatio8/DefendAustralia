// Contracts between components that no single file can check on its own.
const fs = require("fs");
const ROOT = require("path").resolve(__dirname, "..");
let bad = 0;
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) bad++; };

// ── 1. Every queue type a producer enqueues has a drain handler.
// A type with no handler throws "unknown queue type", retries five times and
// lands in Failed. The submission is not lost, but nobody finds out until
// someone opens the base and looks at a status column.
const files = fs.readdirSync(ROOT + "/api").filter((f) => f.endsWith(".js"))
  .map((f) => "api/" + f)
  .concat(fs.readdirSync(ROOT + "/api/survey").map((f) => "api/survey/" + f));

const produced = new Set();
for (const rel of files) {
  const src = fs.readFileSync(ROOT + "/" + rel, "utf8");
  for (const m of src.matchAll(/enqueue\(\s*"([a-z_]+)"/g)) produced.add(m[1]);
}
const drainSrc = fs.readFileSync(ROOT + "/api/drain.js", "utf8");
const expandBlock = drainSrc.slice(drainSrc.indexOf("const EXPAND = {"));
const handled = new Set([...expandBlock.matchAll(/^  ([a-z_]+):/gm)].map((m) => m[1]));

const orphans = [...produced].filter((t) => !handled.has(t));
ok(orphans.length === 0, "every queued type has a drain handler" +
  (orphans.length ? " (orphans: " + orphans.join(", ") + ")" : " (" + produced.size + " types)"));

const unused = [...handled].filter((t) => !produced.has(t));
console.log("      handlers with no producer in code: " + (unused.length ? unused.join(", ") : "none") +
  (unused.includes("volunteer") ? "   (volunteer is produced by event-log's type map)" : ""));

// ── 2. Every write that can hit a singleSelect goes through typecast.
// Without it, a new option value is rejected and the whole row fails. Every
// new event type, queue type and status this release introduced is a value
// that does not exist in the base yet.
const atSrc = fs.readFileSync(ROOT + "/api/_lib/airtable.js", "utf8");
ok(/create\([\s\S]*?typecast: true/.test(atSrc), "create() sends typecast");
ok(/update\([\s\S]*?typecast: true/.test(atSrc), "update() sends typecast");
const qSrc = fs.readFileSync(ROOT + "/api/_lib/queue.js", "utf8");
ok(/typecast: true/.test(qSrc), "the batched queue write sends typecast");

// ── 3. Every /api path the frontend calls exists as a file.
const clients = ["js/app.jsx", "survey/survey.jsx", "404.html"];
const called = new Set();
for (const rel of clients) {
  const src = fs.readFileSync(ROOT + "/" + rel, "utf8");
  for (const m of src.matchAll(/["'`](\/api\/[a-z0-9\-\/]+)/g)) called.add(m[1]);
}
const missingApi = [...called].filter((p) => {
  const f = ROOT + p.replace(/^\/api/, "/api") + ".js";
  return !fs.existsSync(f);
});
ok(missingApi.length === 0, "every /api path the frontend calls has a handler" +
  (missingApi.length ? " (missing: " + missingApi.join(", ") + ")" : " (" + called.size + " paths)"));
console.log("      " + [...called].sort().join("  "));

// ── 4. Every cron path in vercel.json is a real handler.
const vercel = JSON.parse(fs.readFileSync(ROOT + "/vercel.json", "utf8"));
const badCron = vercel.crons.filter((c) => !fs.existsSync(ROOT + c.path + ".js"));
ok(badCron.length === 0, "every scheduled cron path exists" +
  (badCron.length ? " (missing: " + badCron.map((c) => c.path).join(", ") + ")" : ""));

// ── 5. Every rewrite destination resolves.
const badRw = vercel.rewrites.filter((r) => {
  const d = r.destination.split("?")[0];
  if (d.startsWith("/api/")) return !fs.existsSync(ROOT + d + ".js");
  if (d.includes(":")) return false;
  return !(fs.existsSync(ROOT + d + ".html") ||
           fs.existsSync(ROOT + d + "/index.html") ||
           fs.existsSync(ROOT + d));
});
ok(badRw.length === 0, "every rewrite destination resolves" +
  (badRw.length ? " (broken: " + badRw.map((r) => r.source + " -> " + r.destination).join(", ") + ")" : ""));

// ── 6. Every redirect destination resolves.
const badRd = vercel.redirects.filter((r) => {
  const d = r.destination.split("#")[0].split("?")[0];
  return !(fs.existsSync(ROOT + d + ".html") || fs.existsSync(ROOT + d + "/index.html"));
});
ok(badRd.length === 0, "every redirect destination resolves" +
  (badRd.length ? " (broken: " + badRd.map((r) => r.source + " -> " + r.destination).join(", ") + ")" : ""));

// ── 7. Every data-page in a shell has a component registered.
const appSrc = fs.readFileSync(ROOT + "/js/app.jsx", "utf8");
const pagesBlock = appSrc.slice(appSrc.indexOf("const PAGES = {"), appSrc.indexOf("function App("));
const registered = new Set([...pagesBlock.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]));
const shells = [];
for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith(".html"))) shells.push(f);
for (const f of fs.readdirSync(ROOT + "/take-action")) shells.push("take-action/" + f);
const unregistered = [];
for (const rel of shells) {
  const src = fs.readFileSync(ROOT + "/" + rel, "utf8");
  const m = src.match(/data-page="(\w+)"/);
  if (!m) continue;
  if (!registered.has(m[1])) unregistered.push(rel + " -> " + m[1]);
}
ok(unregistered.length === 0, "every shell's data-page has a component" +
  (unregistered.length ? " (missing: " + unregistered.join(", ") + ")" : " (" + shells.length + " shells)"));

// ── 8. Hash targets the spec pins (§14.1) still exist in the markup.
for (const id of ["sign", "ff-email-form", "signup", "donate"]) {
  ok(new RegExp('id="' + id + '"|id={"' + id + '"}|id=\\{[^}]*"' + id + '"').test(appSrc),
    'hash target #' + id + " is still in the app");
}

// ── 9. No ambiguous character pair may survive in the code alphabet, and its
// length must not change: the digest is consumed by repeated division by that
// length, so a different size rewrites every code already in circulation.
const rc = fs.readFileSync(ROOT + "/api/_lib/refcode.js", "utf8");
const alpha = rc.match(/ALPHABET = "([^"]+)"/)[1];
// Only the pairs that actually collide when a code is typed back in from a
// phone screen or read down a line. 5/S and 8/B are handwriting problems, not
// typed-uppercase ones, and excluding them would cost alphabet size for nothing.
const pairs = [["0", "O"], ["1", "I"], ["1", "L"], ["0", "D"]];
const live = pairs.filter(([a, b]) => alpha.includes(a) && alpha.includes(b));
ok(live.length === 0, "no ambiguous pair survives in the code alphabet" +
  (live.length ? " (" + live.map((p) => p.join("/")).join(", ") + ")" : ""));
ok(alpha.length === 32, "the alphabet is still 32 characters (" + alpha.length + ")");
ok(new Set(alpha).size === alpha.length, "the alphabet has no repeated character");

// ── 10. Nothing but the uid jobs writes the CRM survey slot.
const uidWriters = files.filter((rel) => {
  const src = fs.readFileSync(ROOT + "/" + rel, "utf8");
  return /uidField/.test(src);
});
const allowed = ["api/survey-uids.js", "api/survey-uid-topup.js"];
const rogue = uidWriters.filter((f) => !allowed.includes(f));
ok(rogue.length === 0, "only the uid jobs write the CRM survey slot" +
  (rogue.length ? " (also: " + rogue.join(", ") + ")" : ""));

// ── 11. No dead domain may appear anywhere in the code or config.
// defendsacredground.au has no DNS record. It was once the default return URL
// after a Stripe payment, so a donor was charged, sent to a browser error,
// assumed it had failed and paid again. Any reappearance of it, in a fallback
// or a link, costs money.
const allSrc = files.concat(["js/app.jsx", "survey/survey.jsx", "content/site.json", "vercel.json", "404.html"]);
const deadDomain = allSrc.filter((rel) => {
  try { return /defendsacredground\.au/.test(fs.readFileSync(ROOT + "/" + rel, "utf8")); }
  catch (e) { return false; }
});
ok(deadDomain.length === 0, "the dead .au domain appears nowhere" +
  (deadDomain.length ? " (found in: " + deadDomain.join(", ") + ")" : ""));

// Every URL handed to Stripe as a place to send a donor after payment must be
// absolute https with a real host. A relative or malformed one is a dead end
// reached only after the card has been charged.
const checkoutSrc = fs.readFileSync(ROOT + "/api/checkout.js", "utf8");
ok(/success_url:\s*site \+/.test(checkoutSrc), "the success URL is built from the derived site origin");
ok(/usable\(site\)/.test(checkoutSrc), "checkout refuses to run when that origin is not a usable https URL");
ok(!/process\.env\.SITE_URL \|\| "https:\/\/[a-z]+\.au"/.test(checkoutSrc), "no .au fallback remains in checkout");

// ── 11. Every image path in the content file exists on disk.
// A hero, a tile or a press-kit asset whose path is wrong does not throw. It
// renders an empty band or a broken icon, and it does so only on the page
// nobody happened to open after the edit. The CMS writes these paths, so a
// typo here is a content mistake rather than a code one, and nothing else
// would catch it.
const siteRaw = fs.readFileSync(ROOT + "/content/site.json", "utf8");
const imgPaths = new Set();
(function walk(v) {
  // Subfolders too: the CMS writes uploads to /assets/uploads/, so a hero
  // chosen through /admin lands one level down and would otherwise skip the
  // check entirely, which is the case most likely to be got wrong.
  if (typeof v === "string") { if (/^\/assets\/[\w.\/-]+\.\w+$/.test(v)) imgPaths.add(v); return; }
  if (Array.isArray(v)) return v.forEach(walk);
  if (v && typeof v === "object") return Object.values(v).forEach(walk);
})(JSON.parse(siteRaw));
const missingImgs = [...imgPaths].filter((p) => !fs.existsSync(ROOT + p));
ok(missingImgs.length === 0, "every image path in site.json exists" +
  (missingImgs.length ? " (missing: " + missingImgs.join(", ") + ")" : " (" + imgPaths.size + " paths)"));

// ── 12. The take action hero degrades rather than disappearing.
const appSrcTA = fs.readFileSync(ROOT + "/js/app.jsx", "utf8");
const taFn = appSrcTA.slice(appSrcTA.indexOf("function TakeActionPage"), appSrcTA.indexOf("function MediaPage"));
ok(/const hero = t\.heroImage/.test(taFn), "the take action hero image comes from config, not a literal");

// The minister's portrait is optional. An unset photo must leave the goes-to
// block reading correctly rather than rendering a broken image icon next to
// the name of the person we are asking people to write to.
ok(/\{m\.recipientPhoto && \(/.test(appSrcTA), "the minister portrait renders only when one is configured");
ok(/\{hero && \(/.test(taFn), "an unset hero image leaves the heading standing");
ok(/heroAlt \|\| ""/.test(taFn), "the hero image always carries an alt attribute");

console.log("\n" + (bad ? bad + " FAILED" : "every contract holds"));
process.exit(bad ? 1 : 0);
