// Full pass: every handler loads, every contract holds.
const fs = require("fs"), path = require("path");
const ROOT = require("path").resolve(__dirname, "..");
let fails = [];
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) fails.push(m); };

console.log("-- every handler loads --");
for (const d of ["api", "api/survey"]) {
  for (const f of fs.readdirSync(path.join(ROOT, d)).filter((x) => x.endsWith(".js"))) {
    try {
      const m = require(path.join(ROOT, d, f));
      ok(typeof m === "function" || typeof m === "object", (d + "/" + f).padEnd(34) + " loads");
    } catch (e) { ok(false, (d + "/" + f).padEnd(34) + " " + e.message.slice(0, 70)); }
  }
}
for (const f of fs.readdirSync(path.join(ROOT, "api/_lib"))) {
  try { require(path.join(ROOT, "api/_lib", f)); ok(true, ("_lib/" + f).padEnd(34) + " loads"); }
  catch (e) { ok(false, "_lib/" + f + " " + e.message.slice(0, 70)); }
}

console.log("\n-- input hygiene --");
const h = require(ROOT + "/api/_lib/http.js");
const CTRL = String.fromCharCode(0) + String.fromCharCode(7) + String.fromCharCode(27);
ok(h.clean("a" + CTRL + "bc") === "abc", "control characters are stripped from single-line input");
ok(h.cleanMultiline("a\nb" + CTRL + "c") === "a\nbc", "newlines survive the multiline strip");
ok(h.clean("x".repeat(500), 50).length === 50, "input is length capped");
ok(h.e164("0412345678") === "+61412345678", "au mobile normalises to E.164");
ok(h.e164("+61412345678") === "+61412345678", "an already-E.164 number is untouched");
ok(h.e164("0412 345 678") === "+61412345678", "spaces in a mobile are handled");
ok(h.isBot("facebookexternalhit/1.1") && h.isBot("WhatsApp/2.0") && h.isBot("Slackbot-LinkExpanding"),
   "link previewers are filtered as bots");
ok(!h.isBot("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15"), "a real iPhone is not a bot");
ok(h.allowedOrigin("https://defendsacredground.com") === "https://defendsacredground.com", "the apex origin is allowed");
ok(h.allowedOrigin("https://evil.example.com") === "", "an unknown origin is refused");
ok(h.allowedOrigin("https://preview-abc.vercel.app") === "https://preview-abc.vercel.app", "vercel previews are allowed");

console.log("\n-- referral codes --");
const { refCodeFor, normCode } = require(ROOT + "/api/_lib/refcode.js");
const code = refCodeFor(" Ada@Example.COM ");
ok(code === refCodeFor("ada@example.com"), "the code ignores case and whitespace in the email");
ok(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code), "the code avoids 0 1 I L O: " + code);
ok(normCode(" abc123 ") === "ABC123", "codes normalise to uppercase");

const appSrc = fs.readFileSync(ROOT + "/js/app.jsx", "utf8");
const twin = appSrc.match(/function refCodeFor\(email\)[\s\S]*?\n}/)[0];
const clientFn = new Function("return (" + twin.replace("function refCodeFor", "function") + ")")();
let agree = true;
for (const e of ["a@b.com", "james@teller.consulting", "garry.swain@gmail.com", "x+y@z.co.uk", ""]) {
  if (clientFn(e) !== refCodeFor(e)) { agree = false; console.log("   mismatch on", JSON.stringify(e)); }
}
ok(agree, "the client and server referral codes agree exactly");

console.log("\n-- A/B and SMS --");
const ab = require(ROOT + "/api/_lib/ab.js");
ok(ab.assign("t", "p1", ["a", "b"]) === ab.assign("t", "p1", ["a", "b"]), "A/B assignment is stable per person");
const spread = {};
for (let i = 0; i < 6000; i++) { const v = ab.assign("t", "p" + i, ["a", "b", "c"]); spread[v] = (spread[v] || 0) + 1; }
ok(Object.values(spread).every((n) => n > 1700), "three-way assignment splits evenly: " + JSON.stringify(spread));

const sms = require(ROOT + "/api/_lib/sms.js");
ok(["STOP", "stop.", "  Unsubscribe", "OPTOUT", "end", "CANCEL"].every(sms.isStop), "every STOP wording opts out");
ok(!["stopping by", "I stopped reading", "yes"].some(sms.isStop), "STOP does not fire on ordinary words");
ok(sms.dedupeKey("+61412345678", "lapse") !== sms.dedupeKey("+61412345678", "other"),
   "the SMS dedupe key separates templates");
ok(sms.dedupeKey("+61412345678", "lapse") === sms.dedupeKey("+61 412 345 678", "lapse"),
   "the dedupe key ignores formatting, so one person cannot be texted twice");

console.log("\n-- magic link tokens --");
process.env.WEBINAR_TOKEN_SECRET = "s".repeat(40);
const tok = require(ROOT + "/api/_lib/token.js");
const t1 = tok.mint({ contact_id: "c1", email: "a@b.com", slug: "tue" }, 7);
ok(tok.verify(t1).email === "a@b.com", "a minted token verifies to its own contact");
ok(tok.verify(t1 + "x") === null, "an altered token is refused");
ok(tok.verify("") === null && tok.verify(null) === null, "empty tokens are refused");

console.log("\n-- meta --");
const meta = require(ROOT + "/api/_lib/meta.js");
const ud = meta.userData({ email: " Ada@Example.com ", mobile: "04 1234 5678", first_name: "Ada" });
ok(ud.em && ud.em[0].length === 64 && !/@/.test(ud.em[0]), "email is SHA-256 hashed, never sent in the clear");
ok(ud.ph && !/[^a-f0-9]/.test(ud.ph[0]), "phone is normalised then hashed");
ok(meta.eventId("lead", "a@b.com") === meta.eventId("lead", "a@b.com"), "event ids are stable for dedup");
ok(meta.fbcFrom("abc123", 1700000000000) === "fb.1.1700000000000.abc123", "fbc is reconstructed from fbclid");

console.log("\n-- the rewrite keeps the campaign's position --");
const prompts = require(ROOT + "/api/_lib/prompts.js");
const sys = prompts.systemPrompt("minister");
ok(/halt/i.test(sys), "the first demand says halt");
ok(/never demote the first demand|full strength|force intact/i.test(sys), "softening the demands is forbidden");
ok(/548\.7/.test(sys), "the corrected budget figure is in the permitted facts");
ok(/Council/.test(sys) && !/War Memorial board/i.test(sys), "it is the Council, not a board");
ok(prompts.systemPrompt("unknown-campaign") === sys, "an unknown campaign falls back to the guarded default");

console.log("\n-- the Meta probe and its error reporting --");
// The live probe reported "rejected: 400" and nothing else, which is not a
// diagnosis. A revoked token and a malformed event look identical at that
// resolution, and Meta says which it is in the response body.
const probeUser = meta.userData({ external_id: "env-check-probe" });
ok(!!probeUser.external_id, "the probe carries a real matching parameter");
ok(probeUser.external_id[0] !== "env-check-probe", "external_id is hashed, never sent in the clear");
ok(probeUser.external_id[0] === meta.hashed("env-check-probe"), "it hashes by the same rules as every other field");
ok(Object.keys(meta.userData({})).length > 0, "an empty user object still produces a matching parameter");

process.env.META_CAPI_TOKEN = "SECRET-TOKEN-VALUE-THAT-MUST-NOT-LEAK";
const metaSrc = fs.readFileSync(ROOT + "/api/_lib/meta.js", "utf8");
ok(/function metaError/.test(metaSrc), "there is a dedicated error reader");
ok(/split\(token\)\.join/.test(metaSrc), "the token is scrubbed from anything rendered");
delete process.env.META_CAPI_TOKEN;

console.log("\n-- the rewrite spend ceiling --");
// The endpoint is public and spends money on someone else's key, so the
// reading of an unset variable matters. It used to be "no ceiling", which made
// the one configuration mistake nobody notices also the expensive one.
const rewriteSrc = fs.readFileSync(ROOT + "/api/rewrite.js", "utf8");
ok(/DEFAULT_DAILY_CAP\s*=\s*(\d+)/.test(rewriteSrc), "there is a named default cap");
const capDefault = Number(rewriteSrc.match(/DEFAULT_DAILY_CAP\s*=\s*(\d+)/)[1]);
ok(capDefault > 0 && capDefault <= 5000, "the default cap is a real bound: " + capDefault + " a day");
ok(!/Number\(process\.env\.AI_REWRITE_DAILY_CAP \|\| 0\)/.test(rewriteSrc),
   "unset no longer falls through to unlimited");
ok(/raw === "" \? DEFAULT_DAILY_CAP/.test(rewriteSrc), "an unset variable takes the default, not zero");
ok(/cap <= 0/.test(rewriteSrc), "an explicit 0 still removes the ceiling on purpose");

console.log("\n-- a test Stripe key on a live deployment --");
// This was live for a while and nothing caught it. A test key authenticates,
// retrieves the account and creates sessions, so every reachability check
// passed. What it cannot do is take money or see a live session id, which is
// what the thank-you page is handed after every real donation.
const { liveStripeKey } = require(ROOT + "/api/env-check.js");
ok(liveStripeKey("sk_live_51abcDEF") === true, "a live secret key is live");
ok(liveStripeKey("rk_live_51abcDEF") === true, "a live restricted key is live");
ok(liveStripeKey("  sk_live_51abcDEF  ") === true, "surrounding whitespace from a paste is tolerated");
ok(liveStripeKey("sk_test_51abcDEF") === false, "a test secret key is not live");
ok(liveStripeKey("rk_test_51abcDEF") === false, "a test restricted key is not live");
ok(liveStripeKey("pk_live_51abcDEF") === false, "a publishable key pasted by mistake is not live");
ok(liveStripeKey("") === false && liveStripeKey(null) === false, "empty and null are not live");
ok(liveStripeKey("sk_live_") === false, "a truncated paste is not live");

console.log("\n-- config --");
const site = JSON.parse(fs.readFileSync(ROOT + "/content/site.json", "utf8"));
ok(!!site.petitions && Object.keys(site.petitions).length >= 1, "petitions is a slug map");
ok(!!site.petitions[site.org.petitionSlug], "the flagship slug resolves in the map");
ok(site.won && site.won.enabled === false, "the victory page ships switched off");
ok(typeof site.org.metaPixelId === "string", "the pixel id has a config slot");

const vercel = JSON.parse(fs.readFileSync(ROOT + "/vercel.json", "utf8"));
const crons = vercel.crons.map((c) => c.path);
ok(["/api/drain", "/api/lapse-sweep", "/api/sms-inbound-poll", "/api/nightly-rollup", "/api/survey-uid-topup"]
  .every((c) => crons.includes(c)), "every cron is scheduled (" + crons.length + ")");
ok(vercel.rewrites.some((r) => r.source === "/take-action/:slug"), "an unknown petition slug reaches the app");

const dashes = (JSON.stringify(site).match(/[—–]/g) || []).length;
ok(dashes === 0, "no em or en dashes in the copy" + (dashes ? " (found " + dashes + ")" : ""));

console.log("\n" + (fails.length ? fails.length + " FAILED" : "all checks passed"));
process.exit(fails.length ? 1 : 0);
