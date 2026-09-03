// GET /api/shop — the merchandise catalogue, in one shape the page can trust.
//
// Shopify publishes every online-store product at /products.json and every
// collection at /collections/<handle>/products.json with no token at all, so
// this needs no credential and nothing in the environment beyond the store's
// address.
//
// The browser could call Shopify directly. Going through our own domain buys
// three things it could not: one stable shape, so a change in Shopify's
// response does not reach the page; a CDN cache, so a Shopify blip or rate
// limit serves the last good catalogue instead of blanking the shop; and one
// place to change the store address.
//
// Money never touches this site. "Buy" links go to Shopify's own cart
// permalink, so checkout, payment, shipping, tax and stock all stay in
// Shopify — which is the only sane place for them, and keeps this endpoint
// firmly out of scope for anything that could take a card.

const site = require("../content/site.json");

// A campaign bot, identified. Some storefronts refuse an empty user agent.
const UA = "Mozilla/5.0 (compatible; DefendSacredGroundBot/1.0)";

// Tags every product carries. Colours are the merch palette; anything else in
// the tags stays in `tags` for the page to do what it likes with.
const COLOURS = ["Navy", "Beige", "Midnight Blue", "Red", "Black", "White", "Green", "Grey", "Sand", "Khaki"];
const FITS = { "Men's": "mens", "Women's": "womens", Unisex: "unisex" };

/* The store address. Environment first so it can be pointed elsewhere without
 * a content edit, then site.json so a campaign director can set it at /admin,
 * and no default: a shop with no store configured must be off, not pointed at
 * somebody else's storefront. */
function storeUrl() {
  const fromEnv = String(process.env.SHOP_STORE_URL || "").trim();
  const fromSite = String((site && site.shop && site.shop.storeUrl) || "").trim();
  return (fromEnv || fromSite).replace(/\/+$/, "");
}

const configured = () => !!storeUrl();

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });

  if (!configured()) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: "no shop configured", products: [], collections: [] });
  }

  try {
    const out = await loadCatalogue();
    // Five minutes fresh at the edge, an hour of stale-while-revalidate. A
    // Shopify outage inside that hour serves the last good catalogue rather
    // than an empty shop, which is the difference between a slow day and a
    // page that looks broken.
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
    return res.status(200).json(out);
  } catch (err) {
    console.error("SHOP_CATALOGUE_FAIL", err.message);
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "Could not read the shop catalogue.", store: storeUrl() });
  }
};

async function loadCatalogue(store) {
  const s = store || storeUrl();
  const [productsJson, collectionsJson] = await Promise.all([
    getJson(s + "/products.json?limit=250"),
    getJson(s + "/collections.json?limit=250").catch(() => ({ collections: [] }))
  ]);

  /* Shopify keeps collection membership on the collection rather than the
   * product, so each collection is read once to build the reverse map.
   * "frontpage" is Shopify's own homepage collection, not a category. */
  const collections = (collectionsJson.collections || [])
    .filter((c) => c.handle !== "frontpage")
    .map((c) => ({ handle: c.handle, title: c.title }));

  const byHandle = new Map();
  await Promise.all(collections.map(async (c) => {
    try {
      const j = await getJson(s + "/collections/" + c.handle + "/products.json?limit=250");
      for (const p of j.products || []) {
        if (!byHandle.has(p.handle)) byHandle.set(p.handle, []);
        byHandle.get(p.handle).push(c.handle);
      }
    } catch (err) { /* a missing feed leaves those products uncategorised */ }
  }));

  const products = (productsJson.products || [])
    .map((p) => normaliseProduct(p, s, byHandle))
    .filter((p) => p.variants.length);

  /* A product in no collection would only ever appear under "All". Rather
   * than hiding it, it gets a category from its Shopify product type. The
   * real fix is in Shopify — put it in a collection — and when somebody does,
   * this quietly stops firing. */
  const synthetic = new Map();
  for (const p of products) {
    if (p.collections.length || !p.type) continue;
    const handle = "type-" + p.type.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    if (!synthetic.has(handle)) synthetic.set(handle, { handle, title: p.type, synthetic: true });
    p.collections.push(handle);
  }

  const all = collections.concat(Array.from(synthetic.values()));
  return {
    store: {
      url: s,
      name: (site.shop && site.shop.storeName) || "Shop",
      currency: (site.shop && site.shop.currency) || "AUD"
    },
    collections: all.map((c) => ({ ...c, count: products.filter((p) => p.collections.indexOf(c.handle) > -1).length })),
    products,
    fetched_at: new Date().toISOString()
  };
}

function normaliseProduct(p, store, byHandle) {
  const variants = (p.variants || []).map((v) => ({
    id: v.id,
    title: v.title,
    price: money(v.price),
    compareAt: v.compare_at_price ? money(v.compare_at_price) : null,
    available: v.available !== false,
    sku: v.sku || null
  }));
  const prices = variants.map((v) => v.price).filter((n) => n !== null);
  const img = (p.images && p.images[0]) || null;
  const tags = Array.isArray(p.tags)
    ? p.tags
    : String(p.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
  const withCompare = variants.find((v) => v.compareAt);
  const fitTag = Object.keys(FITS).find((f) => tags.indexOf(f) > -1);

  return {
    handle: p.handle,
    title: p.title,
    type: p.product_type || null,
    tags,
    description: stripHtml(p.body_html),
    url: store + "/products/" + p.handle,
    price: prices.length ? Math.min.apply(null, prices) : null,
    priceMax: prices.length ? Math.max.apply(null, prices) : null,
    compareAt: withCompare ? withCompare.compareAt : null,
    available: variants.some((v) => v.available),
    colour: COLOURS.find((c) => tags.indexOf(c) > -1) || null,
    fit: fitTag ? FITS[fitTag] : null,
    collections: byHandle.get(p.handle) || [],
    image: img
      ? { src: img.src, alt: img.alt || p.title, width: img.width || null, height: img.height || null }
      : null,
    options: (p.options || []).map((o) => ({ name: o.name, values: o.values || [] })),
    variants
  };
}

/* Shopify's cart permalink: /cart/<variant>:<qty> lands the shopper on
 * checkout with the item already in the basket. Cart attributes ride onto the
 * order, so the referral code and the fact the sale came from the campaign
 * site are visible in Shopify against every order — which is the only way a
 * merch sale can ever be credited to the supporter who shared the link. */
function buyUrl(store, variantId, opts) {
  const o = opts || {};
  const q = new URLSearchParams();
  q.set("attributes[source]", o.source || (process.env.SITE_DOMAIN || "defendsacredground.com"));
  if (o.ref && String(o.ref).trim()) q.set("attributes[ref]", String(o.ref).trim().toUpperCase());
  return store + "/cart/" + variantId + ":1?" + q.toString();
}

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(url + " -> HTTP " + r.status);
  return r.json();
}

function stripHtml(s) {
  return String(s || "")
    .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote)\s*>|<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function money(s) {
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

module.exports.storeUrl = storeUrl;
module.exports.configured = configured;
module.exports.loadCatalogue = loadCatalogue;
module.exports.normaliseProduct = normaliseProduct;
module.exports.buyUrl = buyUrl;
module.exports.stripHtml = stripHtml;
