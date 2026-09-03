// GET /api/referral-integrity — every supporter has a code, and no two share one.
//
// Codes here are derived from the email address rather than generated, which
// is what lets the browser show a working share link the instant somebody
// signs, with no round trip. That design has two holes, and this cron is what
// closes them.
//
//   MISSING     A contact with no email cannot have a code derived. Meta lead
//               ads deliver those, and so does every bulk load and every row
//               typed straight into Airtable. A contact with no code cannot
//               be sent a tokenised survey or invitation link at all — they
//               land on the capture screen having already given their name.
//
//   COLLIDING   The derivation is a 32-bit hash squeezed into six characters
//               of a 32-character alphabet. Two different addresses will
//               eventually produce the same code; at fifty thousand contacts
//               it is more likely than not. When they do, one supporter's
//               share link credits the other, and the leaderboard is quietly
//               wrong in a way nobody can see from the outside.
//
// The earliest holder always keeps the disputed code. Their links are already
// in the wild — in emails, in texts, printed on things — and rotating them
// breaks recruitment that has already happened. The later holder is reissued
// a random code from the same alphabet, which is safe because the browser
// only ever guesses a code optimistically and then takes the authoritative
// one from /api/share-context.
//
//   ?dry=1      report what it would do and write nothing
//   ?scan=1     force the duplicate sweep this run
//   ?limit=N    cap the writes this run
//
// A repaired contact needs its new code pushed to the CRM, and the nightly
// top-up only looks at recently created contacts — so a contact created in
// July and repaired today would never reach it. Their ids are left in a Sync
// State queue that /api/survey-uid-topup drains. This cron does not write the
// CRM token field itself: exactly one job is allowed to own that field, and
// a second writer is how every token in the account got destroyed once.

const crypto = require("crypto");
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const { refCodeFor, normCode, ALPHABET } = require("./_lib/refcode");

const STATE_KEY = "referral_integrity";
const REPUSH_KEY = "referral_repush_queue";
const BUDGET_MS = 265000;
// Roughly daily, with enough slack that cron drift does not skip a day.
const SWEEP_EVERY_MS = 22 * 3600000;

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;
  if (!h.requireCron(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {};
  return res.status(200).json(await run({
    dry: String(q.dry || "") === "1",
    force: String(q.scan || "") === "1",
    limit: Math.max(0, Number(q.limit) || 100000)
  }));
};

async function run(opts) {
  const o = opts || {};
  const started = Date.now();
  if (!at.configured()) return { ok: false, error: "airtable not configured" };

  const state = await readState();

  /* The cheap probe. In the steady state every contact already has a code and
   * the sweep is not due, so this cron costs one request and stops. Loading
   * the whole table every five minutes to confirm nothing is wrong is how a
   * safety net becomes the thing that exhausts the rate limit. */
  const probe = await at.page(at.T.contacts, {
    pageSize: 1, filterByFormula: "{referral_code}=''", fields: ["contact_id"]
  });
  const anyMissing = probe.records.length > 0;
  const lastSweep = Number(state.value.last_sweep_ms || 0);
  const dueSweep = o.force || Date.now() - lastSweep > SWEEP_EVERY_MS;

  if (!anyMissing && !dueSweep) {
    return {
      ok: true, nothing_to_do: true, minted: 0, repaired: 0,
      next_sweep_in_min: Math.max(0, Math.round((SWEEP_EVERY_MS - (Date.now() - lastSweep)) / 60000))
    };
  }

  // The full pass. One read of the table gives both the set of codes in use
  // and the duplicates — a lookup per contact would be tens of thousands of
  // requests to answer a question one pass answers.
  const taken = new Set();
  const earliest = new Map();
  const dupes = [];
  const missing = [];
  let scanned = 0;

  const walked = await at.walk(at.T.contacts, {
    pageSize: 100,
    fields: ["referral_code", "email", "mobile", "first_name", "last_name"],
    deadline: started + BUDGET_MS * 0.55
  }, (r) => {
    scanned++;
    const f = r.fields || {};
    const who = {
      id: r.id, created: r.createdTime,
      email: f.email, mobile: f.mobile,
      first_name: f.first_name, last_name: f.last_name
    };
    const code = normCode(f.referral_code);
    if (!code) { if (missing.length < o.limit) missing.push({ ...who, reason: "missing" }); return; }

    if (!taken.has(code)) {
      taken.add(code);
      earliest.set(code, who);
      return;
    }
    /* Both hold it. Whoever was created first keeps it; if this row turns out
     * to predate the one already recorded, they swap places and the other
     * becomes the one to reissue. */
    const held = earliest.get(code);
    if (held && new Date(who.created) < new Date(held.created)) {
      earliest.set(code, who);
      dupes.push({ ...held, code, reason: "duplicate" });
    } else {
      dupes.push({ ...who, code, reason: "duplicate" });
    }
  });

  const truncated = !walked.done;
  const work = missing.concat(dupes.slice(0, Math.max(0, o.limit - missing.length)));

  if (o.dry) {
    return {
      ok: true, dry: true, scanned, truncated,
      missing: missing.length, duplicates: dupes.length,
      sample_colliding_codes: Array.from(new Set(dupes.map((d) => d.code))).slice(0, 10)
    };
  }

  // Assign first, write second. Assigning against the in-memory set means a
  // code minted earlier in this same run cannot be handed out again below.
  const assigned = [];
  for (const w of work) {
    const code = mintFor(w, taken);
    if (!code) break;
    assigned.push({ ...w, code });
  }

  let written = 0;
  for (let i = 0; i < assigned.length; i += 10) {
    if (Date.now() - started > BUDGET_MS) break;
    const batch = assigned.slice(i, i + 10);
    await at.updateMany(at.T.contacts, batch.map((a) => ({ id: a.id, fields: { referral_code: a.code } })));
    written += batch.length;
  }
  const done = assigned.slice(0, written);

  // Hand the repaired contacts to the job that owns the CRM token field.
  const repush = done.filter((d) => d.email).map((d) => d.id);
  if (repush.length) await queueRepush(repush);

  const minted = done.filter((d) => d.reason === "missing").length;
  const repaired = done.filter((d) => d.reason === "duplicate").length;
  const complete = !truncated && written === assigned.length;

  await writeState(state.rec, {
    ...state.value,
    // Only a complete pass proves the table is clean, so only a complete pass
    // resets the clock. A truncated run must not buy itself a day off.
    last_sweep_ms: complete ? Date.now() : lastSweep,
    last_run: at.nowIso(),
    last_scanned: scanned,
    total_minted: (Number(state.value.total_minted) || 0) + minted,
    total_repaired: (Number(state.value.total_repaired) || 0) + repaired,
    runs: (Number(state.value.runs) || 0) + 1
  });

  return {
    ok: true, scanned, truncated, complete,
    missing_found: missing.length, duplicates_found: dupes.length,
    minted, repaired, queued_for_crm: repush.length,
    elapsed_ms: Date.now() - started
  };
}

/* A code for one contact.
 *
 * The derived code is tried first, so a contact who simply never got one
 * ends up with the same code the browser would have guessed for them. Only
 * when that is already somebody else's — which is the collision case — does
 * it fall back to a random draw. Two lengths: six to match everything already
 * in circulation, then eight if six is genuinely exhausted. */
function mintFor(who, taken) {
  if (who.email) {
    const derived = normCode(refCodeFor(who.email));
    if (derived && !taken.has(derived)) { taken.add(derived); return derived; }
  }
  for (const len of [6, 6, 8]) {
    for (let i = 0; i < 30; i++) {
      const c = random(len);
      if (!taken.has(c)) { taken.add(c); return c; }
    }
  }
  return null;
}

function random(len) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

async function readState() {
  const rec = await at.findOne(at.T.syncState, "{key}='" + STATE_KEY + "'").catch(() => null);
  let value = {};
  try { value = rec && rec.fields.value ? JSON.parse(rec.fields.value) : {}; } catch (e) { value = {}; }
  return { rec, value };
}

async function writeState(rec, value) {
  if (!(await at.hasTable(at.T.syncState))) return;
  const fields = { key: STATE_KEY, value: JSON.stringify(value), updated_at: at.nowIso() };
  if (rec) return at.update(at.T.syncState, rec.id, fields);
  return at.create(at.T.syncState, fields);
}

/* The repush queue is a plain list of record ids in one Sync State row.
 * Capped, because an unbounded list in a text field eventually stops fitting
 * and the failure would be a truncated write nobody notices. Oldest entries
 * are dropped first: they have been waiting longest, which in this case means
 * they have most likely already been picked up by a nightly run. */
const REPUSH_MAX = 2000;

async function queueRepush(ids) {
  if (!(await at.hasTable(at.T.syncState))) return;
  const rec = await at.findOne(at.T.syncState, "{key}='" + REPUSH_KEY + "'").catch(() => null);
  let list = [];
  try { list = rec && rec.fields.value ? JSON.parse(rec.fields.value) : []; } catch (e) { list = []; }
  const merged = Array.from(new Set(list.concat(ids))).slice(-REPUSH_MAX);
  const fields = { key: REPUSH_KEY, value: JSON.stringify(merged), updated_at: at.nowIso() };
  if (rec) return at.update(at.T.syncState, rec.id, fields);
  return at.create(at.T.syncState, fields);
}

module.exports.run = run;
module.exports.mintFor = mintFor;
module.exports.REPUSH_KEY = REPUSH_KEY;
