// Request plumbing every endpoint repeats: CORS, method guards, body parsing,
// input hygiene and the two auth schemes.
//
// The rules here are the ones a campaign site gets punished for missing. A
// capture endpoint must never echo back stored personal data, because that
// turns a write-only form into an email lookup service. Anything a visitor
// typed is length-capped and stripped of control characters before it reaches
// a log or a datastore. And admin surfaces answer 404 rather than 401 when the
// credentials are absent entirely, so their existence is not advertised.

const crypto = require("crypto");

// Preview hosts change per deploy, so the wildcard is matched rather than listed.
function allowedOrigin(origin) {
  if (!origin) return "";
  const domain = (process.env.SITE_DOMAIN || "defendsacredground.com").replace(/^www\./, "");
  const ok = [
    "https://" + domain,
    "https://www." + domain,
    "http://localhost:3000",
    "http://localhost:8904"
  ];
  if (ok.indexOf(origin) > -1) return origin;
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return origin;
  return "";
}

function cors(req, res, methods) {
  const origin = allowedOrigin(req.headers && req.headers.origin);
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", (methods || "GET, POST") + ", OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// Returns true when the request has been fully handled (preflight or a wrong
// method), so the caller can `if (guard(...)) return;` and stop.
function guard(req, res, methods) {
  const allow = (methods || "POST").split(",").map((m) => m.trim().toUpperCase());
  cors(req, res, allow.join(", "));
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  if (allow.indexOf(req.method) === -1) {
    res.status(405).json({ error: "method not allowed" });
    return true;
  }
  return false;
}

function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) { return null; } }
  return null;
}

// One place for the length cap and the control-character strip, so no endpoint
// can forget either. Newlines survive; everything else below 0x20 does not.
function clean(v, max) {
  if (v == null) return "";
  return String(v)
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim()
    .slice(0, max || 250);
}

function cleanMultiline(v, max) {
  if (v == null) return "";
  return String(v)
    .replace(/\r\n/g, "\n")
    .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "")
    .trim()
    .slice(0, max || 4000);
}

/* Not a full RFC 5322 parser, and deliberately not: the point is to reject
 * the things the capture paths actually receive. The previous pattern let
 * "peter@.com.au" through, because a dot was allowed anywhere in the domain
 * and so an empty label before it passed. That one address then sat in the
 * lapse queue being retried every five minutes, and every retry cost a
 * Nucleus call that could only ever come back 422.
 *
 * The domain is now a run of labels separated by single dots, each label
 * non-empty and beginning and ending in a letter or digit. That is the shape
 * of every real hostname, and nothing a keyboard produces by accident. */
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const EMAIL_RE = new RegExp("^[^@\\s]+@" + LABEL + "(?:\\." + LABEL + ")+$");
const validEmail = (e) => EMAIL_RE.test(String(e || "").trim());

// Australian mobiles, stored E.164 so the CRM and the SMS provider agree.
function e164(mobile) {
  const digits = String(mobile || "").replace(/[^\d+]/g, "");
  if (!digits) return "";
  // A country code on its own is not a phone number. Meta lead exports carry
  // a "+61" with no subscriber number where somebody abandoned the field, and
  // passed through it becomes a contactable-looking mobile that can never be
  // texted. Seven digits is below any real Australian number.
  if (digits.replace(/\D/g, "").length < 7) return "";
  if (digits.startsWith("+")) return digits.slice(0, 16);
  if (digits.startsWith("614")) return "+" + digits;
  if (digits.startsWith("04")) return "+61" + digits.slice(1);
  if (digits.startsWith("4") && digits.length === 9) return "+61" + digits;
  return digits.slice(0, 16);
}

function clientIp(req) {
  const fwd = (req.headers && req.headers["x-forwarded-for"]) || "";
  return String(fwd).split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "";
}

// The salt is what stops the hash being a rainbow-table lookup of every
// Australian IP, so a missing salt is a hard failure rather than a plain hash.
function hashIp(req) {
  const salt = process.env.IP_HASH_SALT;
  if (!salt) return "unsalted";
  return crypto.createHash("sha256").update(salt + "|" + clientIp(req)).digest("hex").slice(0, 32);
}

function sha256(v) {
  return crypto.createHash("sha256").update(String(v || "")).digest("hex");
}

// Admin surfaces. No credentials configured means the endpoint does not exist,
// rather than existing and being unlocked.
function requireBasicAuth(req, res) {
  const expected = process.env.ADMIN_BASIC_AUTH;
  if (!expected) { res.status(404).json({ error: "not found" }); return false; }
  const header = String((req.headers && req.headers.authorization) || "");
  const given = header.startsWith("Basic ")
    ? Buffer.from(header.slice(6), "base64").toString("utf8") : "";
  if (!given || !timingSafeEqual(given, expected)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Defend Sacred Ground"');
    res.status(401).json({ error: "unauthorised" });
    return false;
  }
  return true;
}

// Crons: Vercel's own header, or the bearer for a manual run.
function requireCron(req, res) {
  if (req.headers && req.headers["x-vercel-cron"]) return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // unset means open, and every cron is idempotent
  const header = String((req.headers && req.headers.authorization) || "");
  const given = header.startsWith("Bearer ") ? header.slice(7) : String((req.query && req.query.key) || "");
  if (given && timingSafeEqual(given, secret)) return true;
  res.status(404).json({ error: "not found" });
  return false;
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// In-memory per-instance rate limiting. A warm lambda remembers, a cold one
// does not, which is the right trade for abuse control: it costs nothing and
// the datastore-backed daily cap is what actually bounds spend.
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return { ok: true, remaining: limit - 1 };
  }
  if (b.count >= limit) return { ok: false, remaining: 0, retryAfter: Math.ceil((b.reset - now) / 1000) };
  b.count++;
  return { ok: true, remaining: limit - b.count };
}

// Link previewers fetch every URL in a message. Counting those as clicks
// roughly doubled tracked-link numbers in the reference build.
const BOT = /bot|crawler|spider|preview|facebookexternalhit|slackbot|whatsapp|telegram|discord|twitterbot|linkedinbot|embedly|quora|pinterest|redditbot|applebot|bingpreview|curl|wget|python-requests|headless/i;
const isBot = (ua) => BOT.test(String(ua || ""));

module.exports = {
  cors, guard, body, clean, cleanMultiline, validEmail, e164,
  clientIp, hashIp, sha256, requireBasicAuth, requireCron, rateLimit, isBot,
  allowedOrigin
};
