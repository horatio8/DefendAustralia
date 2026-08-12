// Retry with backoff for the two APIs that will throttle us in a burst.
//
// Airtable allows 5 requests per second per base and answers 429 with a
// Retry-After. Nucleus throttles too. A 5,000 signature surge arrives faster
// than either will accept, so every outbound call goes through here: honour
// Retry-After when given, otherwise exponential backoff with jitter so
// concurrent lambdas do not retry in lockstep and re-collide.
//
// Only throttling and transient server errors are retried. A 4xx that means
// "this request is wrong" is returned immediately, because repeating it just
// burns the rate budget.

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

async function withRetry(fn, opts) {
  const o = opts || {};
  const attempts = o.attempts || 4;
  const baseMs = o.baseMs || 250;
  const label = o.label || "call";
  let lastErr;

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fn();
      // fn may return a Response (fetch) or a plain value.
      if (res && typeof res.status === "number" && RETRYABLE.has(res.status)) {
        if (i === attempts - 1) return res;
        await sleep(delayFor(res, i, baseMs));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      const status = err && err.status;
      const retryable = status ? RETRYABLE.has(status) : isTransient(err);
      if (!retryable || i === attempts - 1) throw err;
      await sleep(delayFor(null, i, baseMs));
    }
  }
  throw lastErr || new Error(label + " failed");
}

function delayFor(res, attempt, baseMs) {
  const header = res && res.headers && typeof res.headers.get === "function"
    ? res.headers.get("retry-after") : null;
  if (header) {
    const secs = Number(header);
    if (!Number.isNaN(secs) && secs >= 0) return Math.min(secs * 1000, 8000);
  }
  const exp = baseMs * Math.pow(2, attempt);
  return Math.min(exp, 4000) + Math.floor(Math.random() * 200); // jitter
}

// Network-level failures are worth one more go; anything else is not.
function isTransient(err) {
  const m = String((err && err.message) || "").toLowerCase();
  return m.includes("fetch failed") || m.includes("econnreset") ||
    m.includes("etimedout") || m.includes("socket hang up") || m.includes("network");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { withRetry, RETRYABLE, sleep };
