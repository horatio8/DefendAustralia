// Every suite, one command: node test/run.js
//
// Nothing here needs credentials or a network. The handler suite stubs the
// four outbound clients and runs the real handlers, so it exercises the code
// that ships rather than a description of it.
const { execFileSync } = require("child_process");
const suites = ["units.js", "contracts.js", "handlers.js"];
let failed = [];
for (const s of suites) {
  console.log("\n=== " + s + " " + "=".repeat(60 - s.length));
  try {
    console.log(execFileSync(process.execPath, [__dirname + "/" + s], { encoding: "utf8" }));
  } catch (e) {
    console.log(e.stdout || "");
    console.log(e.stderr || "");
    failed.push(s);
  }
}
console.log(failed.length ? "\nFAILED: " + failed.join(", ") : "\nEvery suite passed.");
process.exit(failed.length ? 1 : 0);
