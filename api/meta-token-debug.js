// GET /api/meta-token-debug — whose token is this, and what can it reach?
//
// Every Meta failure looks the same from the outside: a 400 with a message
// about permissions. The three things that actually differ — which token is
// in use, which permissions it carries, and which ad accounts it can see —
// are only answerable by asking Meta, and this asks.
//
// It returns Meta's answers and never the token. The whole point of an admin
// page is to avoid pasting a credential into a terminal to debug it, and a
// page that echoed the token back would defeat that in one line.

const h = require("./_lib/http");
const econ = require("./_lib/econ");

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET")) return;
  if (!h.requireBasicAuth(req, res)) return;
  res.setHeader("Cache-Control", "no-store");

  const out = {
    token_source: process.env.META_ADS_TOKEN
      ? "META_ADS_TOKEN"
      : process.env.META_CAPI_TOKEN ? "META_CAPI_TOKEN (fallback)" : "none set",
    target_account: null
  };
  try { out.target_account = econ.adAccountId(); } catch (err) { out.target_account = String(err.message); }
  if (!process.env.META_ADS_TOKEN && !process.env.META_CAPI_TOKEN) {
    return res.status(200).json({ ...out, verdict: "No token is configured, so nothing can be checked." });
  }

  try {
    const me = await econ.graph("me", { fields: "id,name" }).catch((e) => ({ error: String(e.message) }));
    out.identity = me;

    const perms = await econ.graph("me/permissions", {}).catch((e) => ({ error: String(e.message) }));
    out.permissions = (perms.data || []).map((p) => p.permission + ":" + p.status);

    const accounts = await econ.graph("me/adaccounts", { fields: "id,name", limit: 50 })
      .catch((e) => ({ error: String(e.message) }));
    out.ad_accounts_visible = (accounts.data || []).map((a) => a.id + " (" + a.name + ")");
    if (accounts.error) out.ad_accounts_error = accounts.error;

    /* The verdict is the part worth reading, because the raw answers above
     * are easy to misread: a token with ads_read that simply cannot see the
     * account looks identical to a token missing the permission. */
    const reach = out.ad_accounts_visible.indexOf(out.target_account) > -1 ||
      out.ad_accounts_visible.some((a) => a.indexOf(out.target_account) === 0);
    out.verdict = !out.permissions.length
      ? "Meta returned no permissions for this token. It is probably expired or was revoked."
      : out.permissions.indexOf("ads_read:granted") === -1
        ? "This token does not carry ads_read. Spend cannot be pulled with it."
        : reach
          ? "This token can read " + out.target_account + ". Spend should be pulling."
          : "The token has ads_read but cannot see " + out.target_account +
            ". Give its user or system user access to that ad account in Business Settings.";

    return res.status(200).json(out);
  } catch (err) {
    return res.status(200).json({ ...out, error: String(err.message || err) });
  }
};
