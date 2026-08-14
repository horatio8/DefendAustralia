// Browser check for Microsoft Clarity. Needs a local threading server and
// Playwright:  BASE=http://127.0.0.1:PORT node test/clarity.browser.js
//
// The masking assertions are the point. Clarity records what a supporter
// does on the page, and two of these forms carry a private letter. Its
// own default masking is a dashboard setting somebody can change; these
// attributes are in the markup, so the page decides rather than the
// account. The last assertion guards the other direction: masking
// everything would make the recordings worthless.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://127.0.0.1:8912";
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const fails = [];
  const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) fails.push(m); };
  const p = await b.newPage();
  const hits = [];
  await p.route("**clarity.ms/**", (r) => {
    hits.push(r.request().url());
    return r.fulfill({ status: 200, contentType: "application/javascript", body: "window.__clarityLoaded=true;" });
  });
  await p.route("**/connect.facebook.net/**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
  p.on("pageerror", (e) => fails.push("page error: " + e.message));

  await p.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => window.clarity, { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(900);

  ok(hits.length > 0, "the clarity tag is requested");
  ok(hits.some((u) => u.includes("y2942npwyo")), "with the right project id: " + (hits[0] || "none"));
  ok(await p.evaluate(() => typeof window.clarity === "function"), "the clarity queue function exists");

  // Masking, on the pages that carry something private.
  const check = async (path, sel, label) => {
    await p.goto(BASE + path, { waitUntil: "domcontentloaded" });
    await p.waitForFunction(() => document.querySelectorAll("input,textarea").length > 0, { timeout: 8000 }).catch(() => {});
    const masked = await p.evaluate((s) => {
      const els = Array.from(document.querySelectorAll(s));
      return els.length ? els.every((e) => e.getAttribute("data-clarity-mask") === "true") : null;
    }, sel);
    ok(masked === true, label + (masked === null ? "  (no elements found for " + sel + ")" : ""));
  };
  await check("/take-action/defend-sacred-ground", "input.field", "every petition field is masked");
  await check("/minister", "#subj, #body", "the letter to the Minister is masked");
  await check("/contact", "#cmsg", "the contact message is masked");
  await check("/volunteer", "input.field", "every volunteer field is masked");

  // Nothing that is not a form field should be masked: masking the whole page
  // would make the recordings useless.
  await p.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => document.querySelectorAll("input,textarea").length > 0, { timeout: 8000 }).catch(() => {});
  const overMasked = await p.evaluate(() =>
    document.querySelectorAll('[data-clarity-mask="true"]').length >
    document.querySelectorAll('input,textarea').length);
  ok(!overMasked, "masking is limited to inputs, so the recordings stay useful");

  await b.close();
  console.log(fails.length ? "\n" + fails.length + " FAILED" : "\nall passed");
  process.exit(fails.length ? 1 : 0);
})();
