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

console.log("\n-- nobody who has paid gets dunned --");
// The Farmers Fightback failure: a donor taps an amount, goes back, taps
// another, pays on the second session. The first session never turns paid and
// looks exactly like an abandon, because it is one, by somebody who has
// already given. Airtable alone cannot see that, because it only learns about
// a gift through the webhook and the drain.
const sweepSrc = fs.readFileSync(ROOT + "/api/lapse-sweep.js", "utf8");
const stripeLib = require(ROOT + "/api/_lib/stripe.js");

ok(/state\.unknown/.test(sweepSrc), "the sweep has a third state, not just done or not done");
ok(/out\.held\+\+/.test(sweepSrc) && /continue;/.test(sweepSrc), "an unconfirmable row is held rather than sent");
ok(!/async function finished\(/.test(sweepSrc), "the old two-state check is gone");

// The fall-through bug: a donation abandon was closed if the person had ever
// signed the petition, and nearly every donor signs first.
const doneFn = sweepSrc.slice(sweepSrc.indexOf("async function alreadyDone"));
const donationBranch = doneFn.slice(doneFn.indexOf('f.form === "Donation"'), doneFn.indexOf("const clauses = [\"LOWER({email})", doneFn.indexOf('f.form === "Donation"') + 400));
ok(!/T\.signatures/.test(donationBranch), "a donation row is never settled by a signature");
ok(/at\.T\.donations/.test(doneFn) && /stripe\.hasPaid/.test(doneFn), "a donation row checks donations and Stripe");
ok(/LOOKBACK_MINUTES/.test(sweepSrc), "the check looks back before the row, not from it");
ok(/\{mobile\}=/.test(doneFn), "identity is matched on mobile as well as email");

// Absence of evidence in Stripe is only evidence of absence when the key can
// actually see live payments.
ok(typeof stripeLib.hasPaid === "function", "there is a direct paid check");
const noKey = process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_SECRET_KEY;
ok(stripeLib.liveKey() === false, "an absent key is not live");
process.env.STRIPE_SECRET_KEY = "sk_test_abc123";
ok(stripeLib.liveKey() === false, "a test key is not live");
process.env.STRIPE_SECRET_KEY = "sk_live_abc123";
ok(stripeLib.liveKey() === true, "a live key is live");
if (noKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = noKey;

const stripeSrc = fs.readFileSync(ROOT + "/api/_lib/stripe.js", "utf8");
ok(/unknown: true, why: "stripe key is test mode/.test(stripeSrc),
   "a test key returns unknown, never 'not paid'");
ok(/return \{ unknown: true, why: "session lookup failed/.test(stripeSrc),
   "an unreadable session returns unknown, never 'not paid'");
ok(/customers\.list/.test(stripeSrc) && /paymentIntents\.list/.test(stripeSrc),
   "payment is searched by identity, not only by this one session");

console.log("\n-- the lapse A/B split --");
// This was the gap: assign() existed, was tested, and nothing called it. The
// only place with a test name pinned variant to "a" for everybody, so the
// column was populated and the split never happened.
const lapseSrc = fs.readFileSync(ROOT + "/api/lapse-sweep.js", "utf8");
ok(/ab\.assign\(plan\.test, email, \["A", "B"\]\)/.test(lapseSrc), "the sweep assigns an arm per person");
ok(!/variant: "a"/.test(lapseSrc), "nothing is pinned to a single arm any more");
ok(/test: plan\.test, variant/.test(lapseSrc), "the SMS send carries the same arm as the CRM enrolment");

// Two arms must send different words, or the test measures nothing.
const bodies = lapseSrc.match(/A: "(?:[^"\\]|\\.)*",\s*\n\s*B: "(?:[^"\\]|\\.)*"/g) || [];
ok(bodies.length === 2, "both forms carry two SMS bodies (" + bodies.length + ")");
ok(bodies.every((b) => {
  const [a, bb] = b.split(/\n\s*B: /);
  return a.slice(4) !== bb;
}), "the two arms are not the same sentence");

// A text that guesses about somebody's money is worse than no text. We know a
// checkout was not completed; we do not know what the bank did with the
// attempt, so neither donation arm may say anything about the card.
const smsLines = lapseSrc.match(/^\s+[AB]: "(?:[^"\\]|\\.)*"/gm) || [];
ok(smsLines.length === 4, "four SMS bodies in total (" + smsLines.length + ")");
ok(!/nothing (has been |was )?charged|your card/i.test(lapseSrc),
   "no lapse text makes a claim about what reached the card");
// And it asks rather than tells. "You did not finish" is a true sentence
// that reads as an accusation, which is the wrong register for somebody
// else's money.
// Read the sent strings, not the file: the comment above them quotes the
// phrasing it forbids, and a check that trips on its own explanation is a
// check nobody will keep.
const donationSms = ((lapseSrc.match(/Donation:[\s\S]*?\n  \}/) || [""])[0]
  .match(/^\s+[AB]: "((?:[^"\\]|\\.)*)"/gm) || []).join(" ");
ok(/Did you mean/.test(donationSms), "the donation texts were found to check (" + donationSms.length + " chars)");
ok(!/did not finish|(was|were) not finished/i.test(donationSms),
   "neither donation text tells the recipient what they failed to do");
// One segment is 160 GSM-7 characters. Two segments is two sends for the same
// message, and the link is the longest part of it.
ok(smsLines.every((l) => l.replace("{link}", "https://defendsacredground.com/fight").length - 8 <= 160),
   "every lapse text stays inside one segment");

// The split has to be even, or the winner is an artefact of the sample sizes.
const armCount = { A: 0, B: 0 };
for (let i = 0; i < 4000; i++) armCount[ab.assign("petition_lapse", "person" + i + "@example.com", ["A", "B"])]++;
ok(Math.min(armCount.A, armCount.B) > 1850, "the arms split evenly: " + JSON.stringify(armCount));
ok(ab.assign("petition_lapse", "a@b.com", ["A", "B"]) === ab.assign("petition_lapse", "a@b.com", ["A", "B"]),
   "a re-sweep cannot move somebody between arms");
// Independence, asserted over a sample rather than one lucky email: if the
// two tests agreed on everybody they would be one test wearing two names, and
// a person's donation arm would be predictable from their petition arm.
let agreements = 0;
for (let i = 0; i < 1000; i++) {
  const id = "person" + i + "@example.com";
  if (ab.assign("petition_lapse", id, ["A", "B"]) === ab.assign("donation_lapse", id, ["A", "B"])) agreements++;
}
ok(agreements > 400 && agreements < 600, "the two tests assign independently (" + agreements + "/1000 agree)");

// Automations are driven by id, and an absent id must not lose the person.
ok(/CN_AUTOMATION_DONATION_LAPSE/.test(lapseSrc) && /CN_AUTOMATION_PETITION_LAPSE/.test(lapseSrc),
   "both lapse automations are read from env");
ok(/\[key \+ "_" \+ variant\] \|\| process\.env\[key\] \|\| ""/.test(lapseSrc),
   "an arm id falls back to the single id, then to none");
const nucSrc = fs.readFileSync(ROOT + "/api/_lib/nucleus.js", "utf8");
ok(/automations\/" \+ encodeURIComponent\(id\) \+ "\/profiles/.test(nucSrc), "enrolment posts to the automation route");
ok(/skipped: true, reason: "no automation id/.test(nucSrc), "a missing id is reported, not thrown");
ok(/upsertProfile\(\{/.test(lapseSrc), "an unconfigured deployment still tags the profile");

console.log("\n-- the donation ask to a new signatory --");
// The failure worth guarding is not "the email did not send". It is one
// person being enrolled twice because they pressed Sign twice, and getting
// the same appeal in duplicate a minute apart.
const signSrc = fs.readFileSync(ROOT + "/api/petition-signup.js", "utf8");
ok(/CN_AUTOMATION_SIGNATURE_ASK/.test(signSrc), "the donation ask is enrolled by automation id from env");
ok(/if \(!duplicate && nucleus\.configured\(\) && process\.env\.CN_AUTOMATION_SIGNATURE_ASK\)/.test(signSrc),
   "a repeat signature is not enrolled a second time");
// It must never cost a signature. The enrolment sits after the record is
// written and is wrapped, so a Nucleus outage cannot fail the request.
ok(signSrc.indexOf("CN_AUTOMATION_SIGNATURE_ASK") > signSrc.indexOf("queue.enqueue"),
   "enrolment happens after the signature is stored");
ok(/catch \(err\) \{ console\.error\("CN_SIGNATURE_ASK_FAIL"/.test(signSrc),
   "a failed enrolment is logged, never thrown");

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

console.log("\n-- Meta lead ads, the shapes that actually arrive --");
// Every case below is taken from the live export of the connected form:
// 468 leads, Meta's own field prefixes intact, one planted test lead, a
// country code with no number behind it, and a sixth of the names in lower
// case. The webhook is the near-real-time path for these, so it has to
// survive them without a human reading the rows first.
const leadSrc = fs.readFileSync(ROOT + "/api/meta-lead-webhook.js", "utf8");
ok(/replace\(\/\^\(\?:l\|f\|ag\|as\|c\|p\|z\):\//.test(leadSrc),
   "Meta's field prefixes are stripped on the way in");
ok(/function isTestLead/.test(leadSrc) && /if \(isTestLead\(lead\.fields\)\) return;/.test(leadSrc),
   "Meta's planted test lead never becomes a signature");
ok(leadSrc.indexOf("isTestLead(lead.fields)") < leadSrc.indexOf("at.normEmail(lead.fields.email)"),
   "the test lead is dropped before anything is written");
ok(/first_name: titleName\(/.test(leadSrc), "names are title cased, not taken as typed");

// A country code with no subscriber number reached the queue as a mobile.
ok(h.e164("+61") === "", "a bare country code is not a phone number");
ok(h.e164("p:+61".replace(/^p:/, "")) === "", "the same once the p: prefix is off");
ok(h.e164("+61417860529") === "+61417860529", "a real mobile still passes");
ok(h.e164("0421014682") === "+61421014682", "the one domestic-format number is normalised");
ok(h.e164("+61893002949") === "+61893002949", "landlines pass rather than being dropped");
ok(h.e164("") === "" && h.e164(null) === "", "an empty phone stays empty");

console.log("\n" + (fails.length ? fails.length + " FAILED" : "all checks passed"));
process.exit(fails.length ? 1 : 0);
