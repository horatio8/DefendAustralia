// Browser check for the Meta pixel. Needs a local server and Playwright:
//   python3 -m http.server is not enough (single threaded); use a
//   threading server, then: BASE=http://127.0.0.1:PORT node test/pixel.browser.js
//
// What it guards: the pixel id, and the fact that both halves of every
// event carry the same event_id. If those ever diverge Meta counts one
// conversion twice and the campaign optimises against inflated numbers.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://127.0.0.1:8912";
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const fails = [];
  const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) fails.push(m); };

  const p = await b.newPage();
  const pixelHits = [], capiPosts = [];
  // Stub facebook's script so the sandbox's blocked egress does not hide the
  // call: record the request, answer with a no-op body, let fbq keep working.
  await p.route("**/connect.facebook.net/**", (r) => {
    pixelHits.push(r.request().url());
    return r.fulfill({ status: 200, contentType: "application/javascript", body: "window.__fbLoaded=true;" });
  });
  await p.route("**/www.facebook.com/tr**", (r) => { pixelHits.push(r.request().url()); return r.fulfill({ status: 200, body: "" }); });
  p.on("request", (r) => { if (r.method() === "POST" && r.url().includes("meta-capi")) capiPosts.push(r.postData()); });
  p.on("pageerror", (e) => fails.push("page error: " + e.message));

  await p.goto(BASE + "/?fbclid=TESTCLICK123", { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => window.fbq, { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(600);

  ok(pixelHits.some((u) => u.includes("fbevents.js")), "the pixel script is requested");
  const q = await p.evaluate(() => (window.fbq && window.fbq.queue ? window.fbq.queue.map((a) => Array.from(a)) : null));
  ok(!!q, "fbq exists on the page");
  const init = q && q.find((a) => a[0] === "init");
  ok(init && init[1] === "1822710625771817", "fbq initialised with the right id: " + (init && init[1]));
  const pv = q && q.find((a) => a[0] === "track" && a[1] === "PageView");
  ok(!!pv, "PageView fires");
  ok(pv && pv[3] && pv[3].eventID, "PageView carries an eventID for server dedup: " + (pv && pv[3] && pv[3].eventID));

  const capi = capiPosts.map((s) => JSON.parse(s));
  const capiPv = capi.find((c) => c.event_name === "PageView");
  ok(!!capiPv, "the server half of PageView is posted too");
  ok(capiPv && capiPv.event_id === (pv && pv[3] && pv[3].eventID),
     "both halves share one event_id, so Meta collapses them (browser " + (pv && pv[3] && pv[3].eventID) + " / server " + (capiPv && capiPv.event_id) + ")");
  ok(capiPv && capiPv.fbclid === "TESTCLICK123", "fbclid from the ad click is threaded through: " + (capiPv && capiPv.fbclid));

  // First touch must survive to the next page: the ad click id is in the URL
  // for one page load only.
  await p.goto(BASE + "/the-issue", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(500);
  const kept = await p.evaluate(() => localStorage.getItem("dsg_first_touch"));
  ok(kept && kept.includes("TESTCLICK123"), "fbclid is kept after the query string is gone: " + kept);

  // Signing must fire Lead with the supporter's details.
  capiPosts.length = 0;
  await p.goto(BASE + "/take-action/defend-sacred-ground", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(400);
  await p.fill("#pfn", "Ada"); await p.fill("#pln", "Lovelace");
  await p.fill("#pem", "ada@example.com"); await p.fill("#ppc", "2600");
  await p.click('button:has-text("Sign the petition")');
  await p.waitForTimeout(700);
  const lead = capiPosts.map((s) => JSON.parse(s)).find((c) => c.event_name === "Lead");
  ok(!!lead, "signing fires Lead");
  ok(lead && lead.email === "ada@example.com", "Lead carries the email for matching");
  ok(lead && lead.fbclid === "TESTCLICK123", "Lead still carries the original ad click");

  await b.close();
  console.log(fails.length ? "\n" + fails.length + " FAILED" : "\nall passed");
  process.exit(fails.length ? 1 : 0);
})();
