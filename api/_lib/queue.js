// The Ingest Queue: one Airtable write per submission instead of five.
//
// A signature used to cost about five Airtable requests on the request path
// (find contact, write contact, write event, write typed row, patch fan-out).
// Airtable allows five requests per second per base, so a burst of 5,000
// signatures in two minutes would have needed roughly 200 requests a second
// and would have collapsed into 429s, losing people.
//
// Now the request path appends one queue row carrying the whole submission,
// and a drain worker expands it into the relational tables afterwards at a
// rate Airtable accepts. Rows are batched ten at a time (Airtable's batch
// limit), so a warm instance handling a surge spends one request per ten
// submissions rather than one per submission.
const at = require("./airtable");
const { withRetry, sleep } = require("./retry");

const BATCH = 10;          // Airtable's maximum records per create request
const FLUSH_AFTER_MS = 40; // brief coalescing window; a lone signature still lands fast

let buffer = [];   // { fields }
let timer = null;
let flushing = null;

// Append a submission. Resolves once the row is durably in the queue, so the
// caller can honestly tell the supporter their details were kept.
function enqueue(type, payload, cn) {
  if (!at.configured()) return Promise.resolve({ queued: false, reason: "airtable not configured" });
  const queue_id = at.uuid();
  const fields = {
    queue_id,
    type,
    status: "Waiting",
    payload: JSON.stringify(payload || {}),
    cn_synced: !!(cn && cn.entryId),
    cn_entry_id: (cn && cn.entryId) || "",
    cn_error: (cn && cn.error) || "",
    attempts: 0,
    created_at: at.nowIso()
  };
  return new Promise((resolve, reject) => {
    buffer.push({ fields, resolve, reject, queue_id });
    if (buffer.length >= BATCH) return void flush();
    if (!timer) timer = setTimeout(() => { timer = null; flush(); }, FLUSH_AFTER_MS);
  });
}

// Serialised so two flushes never race the same buffer.
function flush() {
  if (flushing) return flushing.then(() => (buffer.length ? flush() : null));
  if (!buffer.length) return Promise.resolve();
  if (timer) { clearTimeout(timer); timer = null; }

  const batch = buffer.splice(0, BATCH);
  flushing = withRetry(
    () => at.call("POST", at.T.queue, null, {
      records: batch.map((b) => ({ fields: b.fields })), typecast: true
    }),
    { label: "queue flush" }
  )
    .then(() => batch.forEach((b) => b.resolve({ queued: true, queue_id: b.queue_id })))
    .catch((err) => {
      // The queue itself is down. Log the whole payload so nothing is lost,
      // then tell the caller so it can decide what to show the supporter.
      batch.forEach((b) => {
        console.error("QUEUE_WRITE_FAIL", b.fields.type, b.fields.payload);
        b.resolve({ queued: false, reason: String(err.message || err) });
      });
    })
    .then(() => { flushing = null; });

  return flushing;
}

// Called before a handler returns, so a lambda that is about to be frozen
// does not strand a half-full buffer.
function drainBuffer() {
  if (!buffer.length && !flushing) return Promise.resolve();
  return flush().then(() => (buffer.length ? flush() : null));
}

module.exports = { enqueue, flush, drainBuffer, BATCH, sleep };
