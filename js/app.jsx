/* Defend Sacred Ground — shared site app.
 * Static-first: every page is a plain HTML shell mounting this app via
 * <div id="root" data-page="…">. Content comes from /content/site.json.
 * API calls are best-effort: the site renders and functions without the
 * backend, and picks up live behaviour when /api/* endpoints exist.
 */
/* global React, ReactDOM */

const { useState, useEffect, useRef } = React;

const C = {
  red: "#9E1B24", redDark: "#6E1219", navy: "#1F3157", deep: "#152340", deepest: "#0F1B33",
  cream: "#FAF6EF", creamMid: "#EFE7DA", creamCard: "#FDFAF4", ink: "#1B1917", body: "#413B33",
  mut: "#5A5248", faint: "#8A7A5E", tan: "#C9BCA4", tanLine: "#D8CBB4", line: "#E0D6C4",
  gold: "#B08D57", goldPale: "#C9BFAC", goldSoft: "#B9A87F", rose: "#EAC9BC", green: "#4A5C4E",
  steel: "#9CA9C1", statBg: "#F7E8E4"
};
const SERIF = "'Libre Caslon Display',serif";
const MONO = "'IBM Plex Mono',monospace";

const ICONS = {
  x: "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
  instagram: "M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 5.838c-3.405 0-6.162 2.76-6.162 6.162 0 3.405 2.76 6.162 6.162 6.162 3.405 0 6.162-2.76 6.162-6.162 0-3.405-2.76-6.162-6.162-6.162zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405c0 .795-.646 1.44-1.44 1.44-.795 0-1.44-.646-1.44-1.44 0-.794.646-1.439 1.44-1.439.793-.001 1.44.645 1.44 1.439z",
  facebook: "M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047v-2.66c0-3.025 1.792-4.697 4.533-4.697 1.313 0 2.686.236 2.686.236v2.971H15.83c-1.491 0-1.956.93-1.956 1.886v2.264h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z",
  youtube: "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z",
  tiktok: "M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z",
  messenger: "M12 0C5.24 0 0 4.952 0 11.64c0 3.499 1.434 6.522 3.769 8.61a.96.96 0 0 1 .323.683l.065 2.135a.96.96 0 0 0 1.347.85l2.381-1.05a.96.96 0 0 1 .641-.047c1.094.3 2.258.462 3.474.462 6.76 0 12-4.952 12-11.64S18.76 0 12 0zm7.17 8.955l-3.525 5.593a1.8 1.8 0 0 1-2.604.48l-2.804-2.102a.72.72 0 0 0-.867.003L5.584 15.8c-.505.383-1.165-.221-.827-.758l3.524-5.593a1.8 1.8 0 0 1 2.604-.48l2.804 2.102a.72.72 0 0 0 .867-.003l3.787-2.874c.505-.383 1.165.22.827.758z",
  whatsapp: "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413",
  linkedin: "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.225 0z",
  email: "M0 4v16h24V4H0zm12 8.5L2.4 6h19.2L12 12.5zM2 8.2l10 6.8 10-6.8V18H2V8.2z",
  sms: "M12 2C6.48 2 2 5.92 2 10.75c0 2.68 1.39 5.08 3.6 6.68L5 22l4.36-2.31c.85.2 1.73.31 2.64.31 5.52 0 10-3.92 10-8.75S17.52 2 12 2zM7 12a1.25 1.25 0 1 1 0-2.5A1.25 1.25 0 0 1 7 12zm5 0a1.25 1.25 0 1 1 0-2.5A1.25 1.25 0 0 1 12 12zm5 0a1.25 1.25 0 1 1 0-2.5A1.25 1.25 0 0 1 17 12z",
  link: "M3.9 12a5 5 0 0 1 5-5h3v2h-3a3 3 0 1 0 0 6h3v2h-3a5 5 0 0 1-5-5zm6.1-1h4v2h-4v-2zm5.1-4h-3V5h3a5 5 0 1 1 0 10h-3v-2h3a3 3 0 1 0 0-6z"
};

/* ── helpers ─────────────────────────────────────────────────────── */

const fmt = (n) => Number(n).toLocaleString("en-AU");
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.trim());

function apiPost(path, data, keepalive) {
  try {
    return fetch(path, {
      method: "POST", keepalive: !!keepalive,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }).then((r) => (r.ok ? r.json().catch(() => ({})) : Promise.reject()));
  } catch (e) { return Promise.reject(e); }
}

function refFromUrl() {
  try { return new URLSearchParams(location.search).get("ref") || ""; } catch (e) { return ""; }
}

function shareUrl(site) {
  const code = (localStorage.getItem("dsg_ref_code") || site.org.defaultRefCode).toUpperCase();
  return "https://" + site.org.domain + "/?ref=" + code;
}

function copyText(text) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
}

function useToast() {
  const [toast, setToast] = useState("");
  const t = useRef(null);
  const flash = (msg) => {
    setToast(msg);
    clearTimeout(t.current);
    t.current = setTimeout(() => setToast(""), 2400);
  };
  useEffect(() => () => clearTimeout(t.current), []);
  return [toast, flash];
}

/* The displayed count is the Campaign Nucleus entry total for the petition
 * form, nothing else. /api/signature-count reads it live; the fallback only
 * covers the moment before that request lands. */
function useSignatureCount(site) {
  const [count, setCount] = useState(site.org.signatureFallbackCount);
  useEffect(() => {
    fetch("/api/signature-count")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { if (d && typeof d.count === "number") setCount(d.count); })
      .catch(() => {});
  }, []);
  return [count, setCount];
}

/* The goal climbs in fixed steps: 15,000, then 30,000, then 45,000. It rolls
 * over on its own the moment a step is reached, so nothing needs editing. */
function nextGoal(count, site) {
  const step = site.org.signatureGoalStep || 15000;
  return (Math.floor(Math.max(0, count) / step) + 1) * step;
}

/* Hash deep links on JS-rendered pages: retry until the target exists,
 * scroll instantly, re-align until the document height settles (late
 * images move anchors), and cancel permanently on user interaction. */
function useHashScroll() {
  useEffect(() => {
    const hash = location.hash && location.hash.slice(1);
    if (!hash) return;
    let cancelled = false, tries = 0, lastH = 0, stable = 0;
    const cancel = () => { cancelled = true; };
    ["wheel", "touchstart", "keydown", "pointerdown"].forEach((e) => window.addEventListener(e, cancel, { passive: true }));
    const align = () => {
      if (cancelled) return;
      const el = document.getElementById(hash);
      if (!el) { if (++tries < 40) setTimeout(align, 75); return; }
      const top = el.getBoundingClientRect().top + window.pageYOffset - 84;
      window.scrollTo(0, top);
      const h = document.documentElement.scrollHeight;
      if (h === lastH) { if (++stable >= 3) return; } else { stable = 0; lastH = h; }
      requestAnimationFrame(() => setTimeout(align, 60));
    };
    align();
    return () => ["wheel", "touchstart", "keydown", "pointerdown"].forEach((e) => window.removeEventListener(e, cancel));
  }, []);
}

/* ── shared style helpers ────────────────────────────────────────── */

const btnBase = { fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", cursor: "pointer", whiteSpace: "normal", lineHeight: 1.25, maxWidth: "100%", display: "inline-block", textAlign: "center", boxSizing: "border-box", textDecoration: "none" };
const btnRed = (x) => ({ ...btnBase, fontSize: 15, color: C.cream, background: C.red, border: "none", padding: "19px 34px", transition: "background .18s", ...x });
const btnNavyOutline = (x) => ({ ...btnBase, fontSize: 14, color: C.navy, background: "transparent", border: "2px solid " + C.navy, padding: "16px 28px", transition: "all .18s", ...x });
const labelStyle = { display: "block", fontSize: 12, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: C.mut, marginBottom: 8 };
const inputStyle = (mono) => ({ width: "100%", boxSizing: "border-box", fontFamily: mono ? MONO : "inherit", fontSize: 16, color: C.ink, padding: "14px 16px", background: "#FFFFFF", border: "1px solid " + C.tan, outline: "none" });

function MonoKicker({ color, rule, children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <div style={{ width: 44, height: 1, background: rule || color }}></div>
      <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: ".26em", textTransform: "uppercase", color }}>{children}</div>
    </div>
  );
}

function Field({ id, label, value, onChange, onBlur, mono, placeholder }) {
  return (
    <div>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      <input id={id} className="field" value={value} placeholder={placeholder} onChange={onChange} onBlur={onBlur} style={inputStyle(mono)} />
    </div>
  );
}

function Honeypot({ value, onChange }) {
  return (
    <div style={{ position: "absolute", left: -9999, top: "auto", width: 1, height: 1, overflow: "hidden" }} aria-hidden="true">
      <label>Leave this field empty<input tabIndex={-1} autoComplete="off" name="website" value={value} onChange={onChange} /></label>
    </div>
  );
}

function Progress({ pct, track, bar, height }) {
  return (
    <div style={{ height: height || 6, background: track || C.line, position: "relative" }}>
      <div style={{ position: "absolute", inset: "0 auto 0 0", width: pct + "%", background: bar || C.red }}></div>
    </div>
  );
}

/* ── chrome: banner, nav, footer ─────────────────────────────────── */

function Banner({ site }) {
  const [open, setOpen] = useState(() => { try { return sessionStorage.getItem("dsg_banner_dismissed") !== "1"; } catch (e) { return true; } });
  const [count] = useSignatureCount(site);
  if (!open) return null;
  const dismiss = () => { setOpen(false); try { sessionStorage.setItem("dsg_banner_dismissed", "1"); } catch (e) {} };
  return (
    <div className="topbar" style={{ background: C.red, color: C.cream, display: "flex", alignItems: "center", gap: 16, padding: "11px 28px", fontSize: 14 }}>
      <a href="/take-action/defend-sacred-ground" className="topbar-text" style={{ flex: 1, color: C.cream, textAlign: "center", lineHeight: 1.45 }}>
        {count > 0
          ? <span><span style={{ fontWeight: 700 }}>{fmt(count)}</span> {site.banner.text} </span>
          : <span>{site.banner.zeroText} </span>}
        <span style={{ fontWeight: 700, whiteSpace: "nowrap" }}>{site.banner.cta}</span>
      </a>
      <button onClick={dismiss} aria-label="Dismiss announcement" className="hov-fg-cream topbar-close" style={{ background: "none", border: "none", color: C.rose, fontSize: 18, lineHeight: 1, cursor: "pointer", padding: "4px 6px", flex: "none" }}>×</button>
    </div>
  );
}

/* A top-level nav item: a plain link, or a button that drops its children. */
function NavItem({ item, page, open, setOpen }) {
  const style = (active) => ({ padding: "6px 0", fontSize: 14, fontWeight: 500, letterSpacing: ".02em", color: active ? C.red : C.body, borderBottom: "2px solid " + (active ? C.red : "transparent") });
  if (!item.children) {
    return <a href={item.href} className="hov-link" style={style(page === item.page)}>{item.label}</a>;
  }
  const active = item.children.some((c) => c.page === page);
  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen(open ? null : item.label)} className="hov-link" aria-expanded={open ? "true" : "false"} style={{ ...style(active), background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
        {item.label} <span style={{ fontSize: 10 }}>▾</span>
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 10px)", left: -16, minWidth: 230, background: "#FFFFFF", border: "1px solid " + C.line, boxShadow: "0 12px 24px rgba(21,35,64,.1)", zIndex: 60, animation: "dsgRise .16s cubic-bezier(.2,.6,.2,1) both" }}>
          <div style={{ display: "flex", flexDirection: "column", padding: "6px 0" }}>
            {item.children.map((c) => (
              <a key={c.page} href={c.href} className="hov-tile" style={{ padding: "13px 20px", fontSize: 14, fontWeight: 500, color: c.page === page ? C.red : C.navy, textAlign: "left" }}>{c.label}</a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Nav({ site, page }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState(null); // label of the open dropdown
  return (
    <div style={{ position: "sticky", top: 0, zIndex: 50, background: "#FFFFFF", borderBottom: "1px solid " + C.line }}>
      <div className="m-pad" style={{ maxWidth: 1280, margin: "0 auto", padding: "0 28px", height: 72, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 32 }}>
        <a href="/" style={{ display: "flex", alignItems: "center", flex: "none" }}>
          <img className="m-logo" src="/assets/logo-horizontal.png" alt="Australian War Memorial — Defend Sacred Ground" style={{ height: 46, width: "auto", display: "block" }} />
        </a>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <div className="m-hide" style={{ display: "flex", alignItems: "center", gap: 28 }}>
            {site.nav.links.map((item) => (
              <NavItem key={item.label} item={item} page={page} open={openMenu === item.label} setOpen={setOpenMenu} />
            ))}
            <a href="/take-action/defend-sacred-ground" className="hov-navy-fill" style={{ ...btnBase, fontSize: 13, letterSpacing: ".08em", color: C.navy, background: "transparent", border: "2px solid " + C.navy, padding: "12px 22px" }}>Sign the petition</a>
          </div>
          <button className="m-menu" onClick={() => setMenuOpen(!menuOpen)} aria-label="Open menu" style={{ display: "none", flexDirection: "column", justifyContent: "center", gap: 5, width: 44, height: 44, background: "none", border: "1px solid " + C.tan, cursor: "pointer", padding: 10, boxSizing: "border-box", flex: "none" }}>
            <span style={{ display: "block", height: 2, background: C.navy }}></span>
            <span style={{ display: "block", height: 2, background: C.navy }}></span>
            <span style={{ display: "block", height: 2, background: C.navy }}></span>
          </button>
          <a href="/donate" className="hov-red" style={{ ...btnBase, fontSize: 13, letterSpacing: ".08em", color: C.cream, background: C.red, border: "none", padding: "14px 26px" }}>Donate</a>
        </div>
      </div>
      {menuOpen && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "#FFFFFF", borderBottom: "1px solid " + C.line, boxShadow: "0 12px 24px rgba(21,35,64,.08)", animation: "dsgRise .18s cubic-bezier(.2,.6,.2,1) both" }}>
          <div style={{ display: "flex", flexDirection: "column", padding: "8px 20px 16px" }}>
            {site.nav.menu.map((m) => (
              <a key={m.page} href={m.href} className="hov-copy-red" style={{ borderBottom: "1px solid " + C.creamMid, padding: "16px 4px", fontSize: 16, fontWeight: 500, color: C.navy, textAlign: "left" }}>{m.label}</a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Footer({ site }) {
  const col = { fontFamily: MONO, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.faint, marginBottom: 16 };
  const link = { background: "none", border: "none", padding: 0, fontSize: 14, color: C.body, textAlign: "left", display: "block" };
  return (
    <div style={{ background: C.creamMid, borderTop: "1px solid " + C.line }}>
      <div className="m-pad m-col" style={{ maxWidth: 1280, margin: "0 auto", padding: "56px 28px 40px", display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr", gap: 48 }}>
        <div>
          <img src="/assets/logo-square.png" alt="Defend Sacred Ground" style={{ width: 170, height: "auto", display: "block" }} />
          <div style={{ fontSize: 13, color: C.mut, lineHeight: 1.65, marginTop: 16, maxWidth: 280 }}>{site.footer.tagline}</div>
        </div>
        <div>
          <div style={col}>Act</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
            <a href="/take-action/defend-sacred-ground" className="hov-copy-red" style={link}>Sign the petition</a>
            <a href="/donate" className="hov-copy-red" style={link}>Donate</a>
            <a href="/share" className="hov-copy-red" style={link}>Share your link</a>
          </div>
        </div>
        <div>
          <div style={col}>The case</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
            <a href="/the-issue" className="hov-copy-red" style={link}>The Issue</a>
            <a href="/take-action/defend-sacred-ground" className="hov-copy-red" style={link}>The petition</a>
            <a href="/" className="hov-copy-red" style={link}>What has happened</a>
          </div>
        </div>
        <div>
          <div style={col}>The campaign</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 14, color: C.body, lineHeight: 1.6 }}>
            {site.footer.campaignLines.map((l, i) => <span key={i}>{l}</span>)}
          </div>
        </div>
      </div>
      <div style={{ background: C.deep }}>
        <div className="m-pad" style={{ maxWidth: 1280, margin: "0 auto", padding: "20px 28px", display: "flex", justifyContent: "space-between", gap: 24, flexWrap: "wrap", fontFamily: MONO, fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: C.cream }}>
          <span>{site.footer.legalLine}</span>
        </div>
      </div>
    </div>
  );
}

/* ── shared campaign blocks ──────────────────────────────────────── */

function ValueIcon({ name }) {
  const p = { viewBox: "0 0 24 24", width: 34, height: 34, fill: "none", stroke: C.gold, strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", style: { flex: "none" }, "aria-hidden": true };
  if (name === "laurel") return (
    <svg {...p}>
      <path d="M12 20.5c-4.4-1.5-7-5.2-6.8-9.6" />
      <path d="M12 20.5c4.4-1.5 7-5.2 6.8-9.6" />
      <path d="M5.2 10.9L3.1 9.7M5.5 13.9l-2.4-.1M6.6 16.8l-2.3.6M8.7 19.1l-1.7 1.6" />
      <path d="M18.8 10.9l2.1-1.2M18.5 13.9l2.4-.1M17.4 16.8l2.3.6M15.3 19.1l1.7 1.6" />
      <path d="M12 3.5v3" />
    </svg>
  );
  if (name === "institution") return (
    <svg {...p}>
      <path d="M4 9.6L12 4l8 5.6" />
      <path d="M5.2 9.6h13.6" />
      <path d="M6.8 12.2v5.6M10.3 12.2v5.6M13.7 12.2v5.6M17.2 12.2v5.6" />
      <path d="M4.6 20.4h14.8" />
    </svg>
  );
  if (name === "ban") return (
    <svg {...p}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M6.2 6.2l11.6 11.6" />
    </svg>
  );
  if (name === "poppy") return (
    <svg {...p}>
      <circle cx="12" cy="5.8" r="2.5" />
      <circle cx="8.95" cy="8" r="2.5" />
      <circle cx="15.05" cy="8" r="2.5" />
      <circle cx="10.1" cy="11.6" r="2.5" />
      <circle cx="13.9" cy="11.6" r="2.5" />
      <circle cx="12" cy="8.9" r="1.3" fill={C.gold} stroke="none" />
      <path d="M12 14.1V21" />
    </svg>
  );
  return (
    <svg {...p}>
      <path d="M12 3.2l6.8 2.4v5c0 4.8-2.9 8.3-6.8 9.9-3.9-1.6-6.8-5.1-6.8-9.9v-5z" />
      <path d="M12 3.2v17.3" />
    </svg>
  );
}

function SoldiersLine({ site }) {
  return (
    <div style={{ borderLeft: "3px solid " + C.red, padding: "6px 0 6px 22px", marginBottom: 30 }}>
      <div style={{ fontFamily: SERIF, fontSize: "clamp(24px,2.6vw,32px)", lineHeight: 1.25, color: C.navy, maxWidth: 900, textWrap: "pretty" }}>{site.soldiersLine}</div>
    </div>
  );
}

function StatsBand({ site }) {
  return (
    <div className="m-col2 m-statsmini" style={{ background: C.cream, border: "1px solid " + C.tanLine, boxShadow: "0 1px 0 " + C.tanLine, display: "grid", gridTemplateColumns: "repeat(4,1fr)" }}>
      {site.stats.map((s, i) => (
        <div key={i} style={{ padding: "36px 32px", borderLeft: i === 0 ? "none" : "1px solid " + C.line, background: s.accent ? C.statBg : "transparent", boxShadow: s.accent ? "inset 0 3px 0 " + C.red : "none" }}>
          <div style={{ fontFamily: SERIF, fontSize: 48, lineHeight: 1, color: s.accent ? C.red : C.navy }}>{s.n}</div>
          <div style={{ fontSize: 13, letterSpacing: ".04em", color: C.mut, marginTop: 12, lineHeight: 1.5, textTransform: "uppercase" }}>{s.label} {s.em ? <span style={{ color: C.red, fontWeight: 700 }}>{s.em}</span> : null}</div>
        </div>
      ))}
    </div>
  );
}

function ChangesGrid({ site }) {
  return (
    <div className="m-col1" style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 1, background: C.tanLine, border: "1px solid " + C.tanLine }}>
      {site.changes.map((c, i) => (
        <div key={i} style={{ background: C.cream }}>
          <div style={{ height: 220, overflow: "hidden" }}>
            <img src={c.img} alt={c.title} loading="lazy" style={{ display: "block", width: "100%", height: "100%", objectFit: "cover", objectPosition: c.pos }} />
          </div>
          <div className="pad-tile" style={{ padding: "28px 32px 32px" }}>
            <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.faint }}>{c.tag}</div>
            <h3 style={{ fontFamily: SERIF, fontSize: 26, color: C.navy, margin: "14px 0 10px", lineHeight: 1.15, fontWeight: 400 }}>{c.title}</h3>
            <p style={{ fontSize: 15, lineHeight: 1.65, color: C.mut, margin: 0 }}>{c.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function CardGrid({ items }) {
  return (
    <div className="m-col1" style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 1, background: C.tanLine, border: "1px solid " + C.tanLine }}>
      {items.map((c, i) => (
        <div key={i} style={{ background: C.cream }}>
          {c.img && (
            <div style={{ height: 220, overflow: "hidden" }}>
              <img src={c.img} alt="" loading="lazy" style={{ display: "block", width: "100%", height: "100%", objectFit: "cover", objectPosition: c.pos || "center" }} />
            </div>
          )}
          <div style={{ padding: "28px 32px 32px" }}>
            <h3 style={{ fontFamily: SERIF, fontSize: 26, color: C.navy, margin: "0 0 10px", lineHeight: 1.15, fontWeight: 400 }}>{c.title}</h3>
            <p style={{ fontSize: 15, lineHeight: 1.65, color: C.mut, margin: 0 }}>{c.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function CtaBandDark({ title }) {
  return (
    <div style={{ background: C.deep, color: C.cream }}>
      <div className="m-pad p-sec" style={{ maxWidth: 1280, margin: "0 auto", padding: "72px 28px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 32, justifyContent: "space-between" }}>
        <div style={{ fontFamily: SERIF, fontSize: 34, lineHeight: 1.15, maxWidth: 620 }}>{title}</div>
        <a href="/take-action/defend-sacred-ground" className="hov-red" style={btnRed({ padding: "18px 30px" })}>Sign the petition</a>
      </div>
    </div>
  );
}

function DemandList({ site }) {
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
      {site.demands.map((d, i) => (
        <li key={i} className="ask-row" style={{ background: "#FFFFFF", padding: "22px 24px", display: "flex", gap: 18, alignItems: "flex-start" }}>
          {/* Fixed-width badge so every clause starts on the same left edge. */}
          <span aria-hidden="true" style={{ fontFamily: SERIF, fontSize: 20, lineHeight: "34px", color: "#FFFFFF", background: C.red, width: 34, height: 34, flex: "none", textAlign: "center" }}>{i + 1}</span>
          <span style={{ fontSize: 17, lineHeight: 1.6, color: C.ink, fontWeight: 500, textWrap: "pretty" }}>{d}</span>
        </li>
      ))}
    </ol>
  );
}

/* The ask: kicker, heading, and the petition itself in a bordered panel.
   Shared so the home page and the petition page are identical. This is the
   text people are signing, so it is set apart from the page around it rather
   than running on as body copy. */
function AskBlock({ site, ask, showHeading }) {
  return (
    <div>
      <MonoKicker color={C.red}>{ask.kicker}</MonoKicker>
      {showHeading && <h2 style={{ fontFamily: SERIF, fontSize: "clamp(26px,2.7vw,36px)", lineHeight: 1.28, color: C.navy, margin: "20px 0 24px", fontWeight: 400, textWrap: "pretty" }}>{ask.heading}</h2>}
      <div className="ask-panel" style={{ marginTop: showHeading ? 0 : 22, background: C.navy, borderTop: "5px solid " + C.red, padding: "30px 28px 28px" }}>
        {ask.lede && <p style={{ fontFamily: SERIF, fontSize: "clamp(20px,1.75vw,25px)", lineHeight: 1.38, color: "#FFFFFF", fontWeight: 700, margin: "0 0 22px", textWrap: "balance" }}>{ask.lede}</p>}
        <DemandList site={site} />
      </div>
    </div>
  );
}

/* Petition sign form card (home + petition pages). */
function SignCard({ site, count, setCount, idp, formHeading, formBody, privacyNote }) {
  const [f, setF] = useState({ first: "", last: "", email: "", mobile: "", postcode: "" });
  const [hp, setHp] = useState("");
  const [signed, setSigned] = useState(false);
  const [unstored, setUnstored] = useState("");
  const [error, setError] = useState("");
  const [toast, flash] = useToast();
  const goal = nextGoal(count, site);
  const pct = Math.min(100, Math.round((count / goal) * 100));
  const remaining = fmt(Math.max(0, goal - count));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const partialBeacon = () => {
    if (!f.first && !f.last && !f.email) return;
    apiPost("/api/partial", { form: "petition", ...f, campaign: site.org.petitionSlug }, true).catch(() => {});
  };

  const submit = () => {
    if (hp) { setSigned(true); return; } // honeypot: silently accept and discard
    if (!f.first.trim() || !f.last.trim()) return setError("Please enter your first and last name.");
    if (!validEmail(f.email)) return setError("Please enter a valid email address.");
    if (f.mobile.trim() && f.mobile.replace(/\D/g, "").length < 9) return setError("That mobile number looks incomplete. Correct it or clear the field.");
    setError("");
    setSigned(true);
    setCount(count + 1);
    try { localStorage.setItem("ff_last_petition_url", location.pathname); } catch (e) {}
    // Campaign updates are the default for signatories, so there is no tickbox
    // to read: consent is implied by signing and stated in the privacy note.
    // The ask goes out before the redirect, and keepalive keeps it alive
    // across the navigation, so a signature is never lost to leaving the page.
    try { localStorage.setItem("dsg_signed_name", f.first.trim()); } catch (e) {}
    // A fresh signatory is the warmest a supporter ever gets, so the focused
    // donation screen follows. It only follows a signature we actually stored:
    // if the backend could not record it, hold the supporter here and hand
    // them the hosted form rather than thank them for nothing.
    apiPost("/api/petition-signup", { ...f, consent: true, campaign: site.org.petitionSlug, ref: refFromUrl(), source_url: location.href })
      .then((d) => {
        if (d && d.referral_code) try { localStorage.setItem("dsg_ref_code", String(d.referral_code).toUpperCase()); } catch (e) {}
        if (d && d.stored === false) { setUnstored(d.fallback || ""); setCount(count); return; }
        location.href = "/donate?signed=1";
      })
      .catch(() => setUnstored(""));
  };

  const link = shareUrl(site);
  const st = site.shareTexts;
  const issueShare = (platform) => apiPost("/api/share-issued", { platform, code: link.split("ref=")[1] }, true).catch(() => {});
  const chipStyle = { ...btnBase, fontSize: 13, letterSpacing: ".04em", textTransform: "none", color: C.navy, background: "transparent", border: "1px solid " + C.tan, padding: "12px 16px" };
  const stepHead = { fontSize: 15, lineHeight: 1.6, color: C.body, margin: "0 0 10px" };

  return (
    <div id={idp === "h" ? undefined : "sign"} className="pad-card" style={{ background: C.cream, border: "1px solid " + C.tan, padding: 36, position: "relative" }}>
      {!signed ? (
        <div>
          {formHeading && <h3 style={{ fontFamily: SERIF, fontSize: 30, color: C.navy, margin: "0 0 8px", lineHeight: 1.1, fontWeight: 400 }}>{formHeading}</h3>}
          {/* Counter only once there is a count worth showing. */}
          {count > 0 && (
            <div>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6, marginTop: formHeading ? 14 : 0 }}>
                <div style={{ fontFamily: SERIF, fontSize: 34, color: C.navy, lineHeight: 1 }}>{fmt(count)}</div>
                <div style={{ fontFamily: MONO, fontSize: 11, color: C.faint }}>goal {fmt(goal)}</div>
              </div>
              <div style={{ fontSize: 14, color: C.mut }}>have signed. {remaining} to go.</div>
              <div style={{ margin: "16px 0 24px" }}><Progress pct={pct} /></div>
            </div>
          )}
          {count <= 0 && <div style={{ height: formHeading ? 20 : 0 }}></div>}
          {formBody && formBody.map((t, i) => (
            <p key={i} style={{ fontSize: 14, lineHeight: 1.6, color: C.mut, margin: "0 0 12px" }}>{t}</p>
          ))}
          <Honeypot value={hp} onChange={(e) => setHp(e.target.value)} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: formBody ? 10 : 0 }}>
            <Field id={idp + "fn"} label="First name *" value={f.first} onChange={set("first")} onBlur={partialBeacon} />
            <Field id={idp + "ln"} label="Last name *" value={f.last} onChange={set("last")} onBlur={partialBeacon} />
          </div>
          <div style={{ marginTop: 16 }}>
            <Field id={idp + "em"} label="Email *" value={f.email} onChange={set("email")} onBlur={partialBeacon} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 16, marginTop: 16 }}>
            <Field id={idp + "pc"} label="Postcode" value={f.postcode} onChange={set("postcode")} mono />
            <Field id={idp + "mb"} label="Mobile (optional)" value={f.mobile} onChange={set("mobile")} placeholder="04xxxxxxxx" mono />
          </div>
          {error && <div style={{ fontSize: 14, color: C.red, marginTop: 14 }}>{error}</div>}
          <button onClick={submit} className="hov-red" style={btnRed({ width: "100%", marginTop: 22, padding: "19px 24px" })}>Sign the petition</button>
          <div style={{ fontSize: 12, color: C.faint, marginTop: 14, lineHeight: 1.6 }}>{privacyNote}</div>
        </div>
      ) : unstored !== "" ? (
        /* The backend could not record it. Say so plainly and hand over a
           route that works, rather than thanking them for a lost signature. */
        <div style={{ animation: "dsgRise .24s cubic-bezier(.2,.6,.2,1) both" }}>
          <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.red }}>One more step</div>
          <div style={{ fontFamily: SERIF, fontSize: 28, lineHeight: 1.15, color: C.navy, margin: "16px 0 12px" }}>We could not record your signature just then.</div>
          <p style={{ fontSize: 15, lineHeight: 1.65, color: C.body, margin: "0 0 20px" }}>That is our fault, not yours, and we would rather tell you than pretend. Add your name on our petition form and it will be counted straight away.</p>
          {unstored ? (
            <a href={unstored} className="hov-red" style={btnRed({ display: "block", textAlign: "center", padding: "18px 24px" })}>Add your name here</a>
          ) : (
            <button onClick={() => { setSigned(false); setUnstored(""); }} className="hov-red" style={btnRed({ width: "100%", padding: "18px 24px" })}>Try again</button>
          )}
        </div>
      ) : (
        <div style={{ animation: "dsgRise .24s cubic-bezier(.2,.6,.2,1) both" }}>
          <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.green }}>Signed · {fmt(count)} Australians</div>
          <div style={{ fontFamily: SERIF, fontSize: 30, lineHeight: 1.12, color: C.navy, margin: "16px 0 12px" }}>Thank you. Now do the part that actually matters.</div>
          <p style={{ fontSize: 15, lineHeight: 1.65, color: C.body, margin: "0 0 20px" }}>Your name is on it. But a petition with ten thousand names is an opinion, and a list of a hundred thousand Australians is a constituency. The difference is you.</p>
          <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.faint, borderTop: "1px solid " + C.line, paddingTop: 18, marginBottom: 16 }}>Three things, two minutes</div>
          <p style={stepHead}><strong>1. Send this to three people.</strong> Not a hundred. Three. People who had family in a war.</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 20 }}>
            <button onClick={() => { copyText(link); flash("Link copied to your clipboard."); issueShare("copy"); }} className="hov-chip" style={chipStyle}>Copy link</button>
            <a href={"https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(link)} target="_blank" rel="noopener noreferrer" onClick={() => issueShare("facebook")} className="hov-chip" style={chipStyle}>Share to Facebook</a>
            <a href={"mailto:?subject=" + encodeURIComponent(st.emailSubject) + "&body=" + encodeURIComponent(st.long + "\n\n" + link)} onClick={() => issueShare("email")} className="hov-chip" style={chipStyle}>Share by email</a>
            <a href={"sms:?&body=" + encodeURIComponent(st.sms + " " + link)} onClick={() => issueShare("sms")} className="hov-chip" style={chipStyle}>Share by SMS</a>
          </div>
          {toast && <div style={{ fontSize: 13, color: C.green, margin: "-8px 0 16px" }}>{toast}</div>}
          <p style={stepHead}><strong>2. Chip in.</strong> Ten per cent of Australians know this is happening. Advertising is how that changes.</p>
          <a href="/donate" className="hov-navy-fill" style={btnNavyOutline({ padding: "13px 22px", marginBottom: 20, display: "inline-block" })}>Chip in</a>
          <p style={stepHead}><strong>3. Read what he actually said.</strong> It is worse in his own words than in ours.</p>
          <a href="/the-issue" className="hov-navy-fill" style={btnNavyOutline({ padding: "13px 22px", display: "inline-block" })}>Read the issue</a>
        </div>
      )}
    </div>
  );
}

function HomePage({ site }) {
  const [count, setCount] = useSignatureCount(site);
  const h = site.home;
  const scrollToSign = (e) => {
    e.preventDefault();
    const el = document.getElementById("home-sign");
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.pageYOffset - 72, behavior: "smooth" });
  };
  return (
    <div>
      {/* hero: bright editorial */}
      <div style={{ position: "relative", background: "#FFFFFF" }}>
        <div style={{ position: "relative" }}>
          <img className="desk-only" src="/assets/hero-courtyard-wide.jpg" alt="The commemorative courtyard of the Australian War Memorial" style={{ width: "100%" }} />
          <img className="mob-only" src="/assets/hero-courtyard-portrait.jpg" alt="The commemorative courtyard of the Australian War Memorial" style={{ width: "100%" }} />
          <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom,rgba(255,255,255,0) 45%,rgba(255,255,255,.55) 72%,rgba(255,255,255,.92) 90%,#FFFFFF 100%)" }}></div>
          <div style={{ position: "absolute", top: 26, left: 0, right: 0 }}>
            <div className="m-pad" style={{ maxWidth: 1280, margin: "0 auto", padding: "0 28px", display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ width: 44, height: 1, background: C.gold, flex: "none" }}></div>
              <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: ".26em", textTransform: "uppercase", color: C.navy }}>{h.hero.kicker}</div>
            </div>
          </div>
        </div>
        <div className="m-pad hero-pull" style={{ position: "relative", maxWidth: 1280, margin: "clamp(-190px,-13vw,-60px) auto 0", padding: "0 28px", boxSizing: "border-box" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 28 }}>
            <a href="#home-sign" onClick={scrollToSign} className="hov-red" style={btnRed()}>{h.hero.cta}&nbsp;&nbsp;↓</a>
          </div>
          <h1 style={{ fontFamily: SERIF, fontSize: "clamp(42px,6.6vw,96px)", lineHeight: 1.02, margin: 0, maxWidth: 1050, letterSpacing: "-.008em", fontWeight: 400, color: C.navy }}>A century of honour,<br /><span style={{ color: C.red, fontStyle: "italic" }}>undone</span> in minutes.</h1>
          <p style={{ fontSize: "clamp(17px,1.6vw,20px)", lineHeight: 1.6, maxWidth: 680, color: C.mut, margin: "26px 0 0", textWrap: "pretty" }}>{h.hero.lede} <span style={{ color: C.red, fontWeight: 600 }}>{h.hero.ledeEm}</span></p>
          <div className="m-col2 vp-band" style={{ borderTop: "1px solid " + C.line, marginTop: 40, padding: "24px 0 36px", display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "18px 0" }}>
            {h.valueProps.map((v, i) => (
              <div key={i} className="vp-item" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14, borderLeft: i ? "1px solid " + C.line : "none", padding: "4px 16px" }}>
                <ValueIcon name={v.icon} />
                <span style={{ fontSize: 12, letterSpacing: ".08em", textTransform: "uppercase", color: C.navy, fontWeight: 600, lineHeight: 1.45 }}>{v.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* demands + petition form */}
      <div id="home-sign" style={{ background: "#FFFFFF", borderBottom: "1px solid " + C.line }}>
        <div className="m-pad m-col p-sec" style={{ maxWidth: 1280, margin: "0 auto", padding: "80px 28px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 72, alignItems: "start" }}>
          <AskBlock site={site} ask={h.ask} showHeading />
          <SignCard site={site} count={count} setCount={setCount} idp="h" formHeading={h.ask.formHeading} privacyNote={site.petition.privacyNote} />
        </div>
      </div>

      {/* what has happened */}
      <div style={{ background: C.creamMid, borderTop: "1px solid " + C.line, borderBottom: "1px solid " + C.line }}>
        <div className="m-pad m-col p-sec" style={{ maxWidth: 1280, margin: "0 auto", padding: "88px 28px", display: "grid", gridTemplateColumns: ".9fr 1.6fr", gap: 72, alignItems: "start" }}>
          <div style={{ position: "sticky", top: 100 }} className="m-static">
            <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: ".22em", textTransform: "uppercase", color: C.red }}>{h.happened.kicker}</div>
            <h2 style={{ fontFamily: SERIF, fontSize: 44, lineHeight: 1.06, color: C.navy, margin: "18px 0 0", fontWeight: 400 }}>{h.happened.heading}</h2>
          </div>
          <div>
            {h.happened.body.map((t, i) => (
              <p key={i} style={{ fontSize: 17, lineHeight: 1.7, color: C.body, margin: i ? "18px 0 0" : 0, textWrap: "pretty" }}>{t}</p>
            ))}
          </div>
        </div>
      </div>

      {/* the man responsible */}
      <div className="m-pad p-sec" style={{ maxWidth: 820, margin: "0 auto", padding: "88px 28px" }}>
        <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: ".22em", textTransform: "uppercase", color: C.faint }}>{h.responsible.kicker}</div>
        <h2 style={{ fontFamily: SERIF, fontSize: 44, lineHeight: 1.06, color: C.navy, margin: "18px 0 24px", fontWeight: 400 }}>{h.responsible.heading}</h2>
        {h.responsible.body.map((t, i) => (
          <p key={i} style={{ fontSize: 17, lineHeight: 1.7, color: C.body, margin: "0 0 18px", textWrap: "pretty" }}>{t}</p>
        ))}
        <div style={{ borderLeft: "3px solid " + C.red, padding: "10px 0 10px 24px", margin: "28px 0" }}>
          <div style={{ fontFamily: SERIF, fontSize: 30, color: C.navy, lineHeight: 1.2, fontStyle: "italic" }}>{h.responsible.em}</div>
          <div style={{ fontSize: 16, color: C.mut, marginTop: 10, lineHeight: 1.6 }}>{h.responsible.emBody}</div>
        </div>
        <p style={{ fontSize: 17, lineHeight: 1.7, color: C.body, margin: "0 0 28px", textWrap: "pretty" }}>{h.responsible.close}</p>
        <a href="#home-sign" onClick={scrollToSign} className="hov-red" style={btnRed({ fontSize: 14, padding: "17px 30px" })}>{h.responsible.cta}</a>
      </div>

      {/* honour band: the Roll, scrolling */}
      <div style={{ background: C.creamMid, borderTop: "1px solid " + C.line, borderBottom: "1px solid " + C.line, overflow: "hidden", padding: "52px 0" }}>
        {[0, 1].map((row) => (
          <div key={row} style={{ display: "flex", width: "max-content", animation: "dsgMarquee " + (row ? 104 : 80) + "s linear infinite", willChange: "transform", marginTop: row ? 20 : 0 }}>
            <div style={{ fontFamily: SERIF, fontSize: 21, letterSpacing: ".18em", textTransform: "uppercase", color: C.goldSoft, whiteSpace: "nowrap", paddingRight: 64 }}>{site.honourNames[row]}</div>
            <div aria-hidden="true" style={{ fontFamily: SERIF, fontSize: 21, letterSpacing: ".18em", textTransform: "uppercase", color: C.goldSoft, whiteSpace: "nowrap", paddingRight: 64 }}>{site.honourNames[row]}</div>
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16, marginTop: 34 }}>
          <div style={{ width: 36, height: 1, background: C.gold }}></div>
          <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: ".2em", textTransform: "uppercase", color: C.faint }}>The Roll of Honour · 103,000 names</div>
          <div style={{ width: 36, height: 1, background: C.gold }}></div>
        </div>
      </div>

      {/* why it is wrong */}
      <div className="m-pad p-sec" style={{ maxWidth: 1280, margin: "0 auto", padding: "88px 28px" }}>
        <h2 style={{ fontFamily: SERIF, fontSize: 44, lineHeight: 1.06, color: C.navy, margin: "0 0 36px", maxWidth: 760, fontWeight: 400 }}>{h.whyWrong.heading}</h2>
        <CardGrid items={h.whyWrong.items} />
      </div>

      {/* what we are not saying */}
      <div style={{ background: C.creamMid, borderTop: "1px solid " + C.line, borderBottom: "1px solid " + C.line }}>
        <div className="m-pad p-sec" style={{ maxWidth: 820, margin: "0 auto", padding: "72px 28px" }}>
          <h2 style={{ fontFamily: SERIF, fontSize: 34, color: C.navy, margin: "0 0 20px", lineHeight: 1.15, fontWeight: 400 }}>{h.notSaying.heading}</h2>
          {h.notSaying.body.map((t, i) => (
            <p key={i} style={{ fontSize: 17, lineHeight: 1.7, color: C.body, margin: i === h.notSaying.body.length - 1 ? 0 : "0 0 18px", textWrap: "pretty" }}>{t}</p>
          ))}
        </div>
      </div>

      {/* donate band */}
      <div className="m-pad m-col p-sec" style={{ maxWidth: 1280, margin: "0 auto", padding: "88px 28px", display: "grid", gridTemplateColumns: ".9fr 1.1fr", gap: 72, alignItems: "start" }}>
        <div>
          <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: ".22em", textTransform: "uppercase", color: C.faint }}>{h.donateBand.kicker}</div>
          <h2 style={{ fontFamily: SERIF, fontSize: 44, lineHeight: 1.05, color: C.navy, margin: "18px 0 16px", fontWeight: 400 }}>{h.donateBand.heading}</h2>
          <p style={{ fontSize: 17, lineHeight: 1.65, color: C.mut, margin: 0, maxWidth: 480 }}>{h.donateBand.body}</p>
        </div>
        <DonatePanel site={site} />
      </div>

      {/* on the record: quotes at the bottom */}
      <div style={{ background: C.creamMid, borderTop: "1px solid " + C.line }}>
        <div className="m-pad p-sec" style={{ maxWidth: 1280, margin: "0 auto", padding: "88px 28px" }}>
          <MonoKicker color={C.red}>{h.quotes.kicker}</MonoKicker>
          <h2 style={{ fontFamily: SERIF, fontSize: 44, lineHeight: 1.06, color: C.navy, margin: "18px 0 36px", fontWeight: 400 }}>{h.quotes.heading}</h2>
          <div className="m-col1" style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 1, background: C.tanLine, border: "1px solid " + C.tanLine }}>
            {h.quotes.items.map((q, i) => (
              <div key={i} style={{ background: C.cream, padding: "30px 32px", display: "flex", flexDirection: "column", gridColumn: h.quotes.items.length % 2 === 1 && i === h.quotes.items.length - 1 ? "1 / -1" : "auto" }}>
                <div style={{ fontFamily: SERIF, fontSize: 22, color: C.navy, lineHeight: 1.45, textWrap: "pretty" }}>“{q.quote}”</div>
                {q.note && <div style={{ fontSize: 15, color: C.mut, lineHeight: 1.6, marginTop: 12, textWrap: "pretty" }}>{q.note}</div>}
                <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: C.faint, marginTop: "auto", paddingTop: 18, lineHeight: 1.6 }}>{q.attribution}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PetitionPage({ site }) {
  const [count, setCount] = useSignatureCount(site);
  useHashScroll();
  const p = site.petition;
  const scrollToSign = () => {
    const el = document.getElementById("sign");
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.pageYOffset - 84, behavior: "smooth" });
  };
  return (
    <div>
      {/* hero panel */}
      <div style={{ position: "relative", background: C.deepest, overflow: "hidden", minHeight: 320, display: "flex", alignItems: "flex-end" }}>
        <img src="/assets/ww1-troops.jpg" alt="Australian soldiers of the First AIF on the Western Front" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "center 30%", filter: "grayscale(1)" }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to top,rgba(10,18,34,.92) 0%,rgba(10,18,34,.5) 60%,rgba(10,18,34,.25) 100%)" }}></div>
        <div className="m-pad m-col p-hero" style={{ position: "relative", maxWidth: 1280, margin: "0 auto", padding: "110px 28px 44px", width: "100%", boxSizing: "border-box", display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 32, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 500, letterSpacing: ".22em", textTransform: "uppercase", color: "#FFFFFF", textShadow: "0 1px 12px rgba(0,0,0,.7)", background: "rgba(158,27,36,.85)", display: "inline-block", padding: "7px 12px" }}>{p.badge}</div>
            <h1 style={{ fontFamily: SERIF, fontSize: "clamp(32px,4.2vw,54px)", lineHeight: 1.08, color: "#FFFFFF", margin: "20px 0 0", maxWidth: 820, textShadow: "0 2px 32px rgba(0,0,0,.55)", fontWeight: 400 }}>{p.heading}</h1>
          </div>
          {count > 0 && (
            <div style={{ borderRight: "2px solid " + C.red, paddingRight: 24, textAlign: "right", flex: "none" }}>
              <div style={{ fontFamily: SERIF, fontSize: "clamp(40px,7vw,64px)", lineHeight: .95, color: C.cream, letterSpacing: "-.01em", textShadow: "0 2px 24px rgba(0,0,0,.5)" }}>{fmt(count)}</div>
              <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".2em", textTransform: "uppercase", color: "#E6DFD2", marginTop: 10 }}>Australians have signed</div>
            </div>
          )}
        </div>
      </div>

      {/* the ask + form: heading lives in the hero, so the ask leads with the call */}
      <div style={{ background: "#FFFFFF", borderBottom: "1px solid " + C.line }}>
        <div className="m-pad m-col p-sec" style={{ maxWidth: 1280, margin: "0 auto", padding: "64px 28px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 72, alignItems: "start" }}>
          <AskBlock site={site} ask={p} />
          <SignCard site={site} count={count} setCount={setCount} idp="p" formHeading={p.formHeading} privacyNote={p.privacyNote} />
        </div>
      </div>

      {/* why this must stop: the case for signing, kept tight */}
      <div style={{ background: C.creamMid, borderBottom: "1px solid " + C.line }}>
        <div className="m-pad p-sec" style={{ maxWidth: 1280, margin: "0 auto", padding: "64px 28px" }}>
          <MonoKicker color={C.red}>{p.why.kicker}</MonoKicker>
          <h2 style={{ fontFamily: SERIF, fontSize: "clamp(26px,2.7vw,36px)", lineHeight: 1.28, color: C.navy, margin: "20px 0 34px", fontWeight: 400 }}>{p.why.heading}</h2>
          <div className="m-col1" style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 1, background: C.tanLine, border: "1px solid " + C.tanLine }}>
            {p.why.items.map((it, i) => (
              <div key={i} style={{ background: C.cream }}>
                {it.img && (
                  <div style={{ height: 200, overflow: "hidden" }}>
                    <img src={it.img} alt="" loading="lazy" style={{ display: "block", width: "100%", height: "100%", objectFit: "cover", objectPosition: it.pos || "center" }} />
                  </div>
                )}
                <div className="pad-tile" style={{ padding: "26px 30px 30px" }}>
                  <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: ".2em", color: C.red, marginBottom: 12 }}>{"0" + (i + 1)}</div>
                  <h3 style={{ fontFamily: SERIF, fontSize: 24, color: C.navy, margin: "0 0 10px", lineHeight: 1.15, fontWeight: 400 }}>{it.title}</h3>
                  <p style={{ fontSize: 15, lineHeight: 1.65, color: C.mut, margin: 0 }}>{it.body}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="m-col" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 24, marginTop: 36 }}>
            <p style={{ fontFamily: SERIF, fontSize: 30, lineHeight: 1.2, color: C.navy, margin: 0, textWrap: "pretty" }}>{p.why.close}</p>
            <button type="button" onClick={scrollToSign} className="hov-red" style={btnRed({ padding: "18px 30px", flex: "none" })}>{p.why.cta}</button>
          </div>
        </div>
      </div>

    </div>
  );
}

function MinisterPage({ site }) {
  const m = site.minister;
  const [variantIdx] = useState(() => Math.floor(Math.random() * m.variations.length));
  const [f, setF] = useState({ first: "", last: "", email: "", mobile: "" });
  const [hp, setHp] = useState("");
  const [subject, setSubject] = useState(m.variations[variantIdx].subject);
  const [body, setBody] = useState(m.variations[variantIdx].body);
  const [rewrites, setRewrites] = useState(0);
  const [rewriting, setRewriting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [toast, flash] = useToast();
  const sessionId = useRef("s-" + Math.random().toString(36).slice(2, 10));
  useHashScroll();

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const chars = subject.length + body.length;
  const counterColor = chars > 1900 ? C.red : chars > 1650 ? C.gold : C.faint;
  const counterNote = chars > 1900 ? "Too long for some mail apps" : chars > 1650 ? "Approaching the limit" : "Within safe length";

  const capture = (extra, keepalive) =>
    apiPost("/api/capture", { session_id: sessionId.current, ...f, subject, body, campaign: "minister", ...extra }, keepalive).catch(() => {});

  const rewrite = () => {
    if (rewrites >= 3 || rewriting) return;
    setRewriting(true);
    apiPost("/api/rewrite", { session_id: sessionId.current, subject, body, first_name: f.first, campaign: "minister" })
      .then((d) => {
        if (d && d.subject && d.body) { setSubject(d.subject); setBody(d.body); }
        else throw new Error("bad response");
      })
      .catch(() => {
        // Offline fallback: the prototype's local personalisation.
        const name = f.first.trim() || "a supporter";
        setSubject("A request from " + name + ": pause the Memorial works");
        setBody((b) => b.replace(/^Dear Minister,/, "Dear Minister,\n\nI do not usually write letters like this."));
      })
      .then(() => { setRewrites((r) => r + 1); setRewriting(false); });
  };

  const send = () => {
    if (hp) { setSent(true); window.scrollTo(0, 0); return; }
    if (!f.first.trim() || !f.last.trim() || !validEmail(f.email))
      return setError("Add your name and a valid email before sending.");
    if (f.mobile.trim() && f.mobile.replace(/\D/g, "").length < 9)
      return setError("That mobile number looks incomplete. Correct it or clear the field.");
    setError("");
    let finalBody = body;
    const sig = f.first.trim() + " " + f.last.trim();
    if (!finalBody.includes(sig)) finalBody = finalBody + "\n\n" + sig + "\n" + f.email.trim();
    capture({ status: "send_clicked", sent_subject: subject, sent_body: finalBody }, true);
    if (m.toEmail) {
      // mailto rules: single recipient in To, correspondence copy via cc.
      const mailto = "mailto:" + encodeURIComponent(m.toEmail) +
        "?cc=" + encodeURIComponent(m.correspondenceEmail) +
        "&subject=" + encodeURIComponent(subject) +
        "&body=" + encodeURIComponent(finalBody);
      window.location.href = mailto;
    }
    setSent(true);
    window.scrollTo(0, 0);
  };

  const recipient = m.toEmail || m.recipientDisplay;
  const sig = f.first.trim() && f.last.trim() ? "\n\n" + f.first.trim() + " " + f.last.trim() + "\n" + f.email.trim() : "";
  const gmailHref = "https://mail.google.com/mail/?view=cm&fs=1&to=" + encodeURIComponent(m.toEmail) + "&cc=" + encodeURIComponent(m.correspondenceEmail) + "&su=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body + sig);
  const outlookHref = "https://outlook.office.com/mail/deeplink/compose?to=" + encodeURIComponent(m.toEmail) + "&subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body + sig);

  return (
    <div>
      <div style={{ background: C.deep, color: C.cream }}>
        <div className="m-pad m-col p-sec" style={{ maxWidth: 1280, margin: "0 auto", padding: "64px 28px 56px", display: "grid", gridTemplateColumns: "1.05fr .95fr", gap: 64, alignItems: "center" }}>
          <div>
            <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: ".22em", textTransform: "uppercase", color: C.gold }}>{m.kicker}</div>
            <h1 style={{ fontFamily: SERIF, fontSize: 54, lineHeight: 1.03, margin: "20px 0 18px", fontWeight: 400 }}>{m.heading}</h1>
            <p style={{ fontSize: 18, lineHeight: 1.65, color: C.goldPale, margin: "0 0 28px", maxWidth: 520 }}>{m.lede}</p>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 340 }}>
            <img src="/assets/minister-portrait.jpg" alt="The Minister for Veterans' Affairs" style={{ display: "block", width: "100%", maxWidth: 400, height: "auto", WebkitMaskImage: "radial-gradient(ellipse 68% 82% at 50% 45%, black 52%, transparent 92%)", maskImage: "radial-gradient(ellipse 68% 82% at 50% 45%, black 52%, transparent 92%)" }} />
          </div>
        </div>
        <div style={{ borderTop: "1px solid rgba(176,141,87,.3)" }}>
          <div className="m-pad" style={{ maxWidth: 1280, margin: "0 auto", padding: "20px 28px", display: "flex", flexWrap: "wrap", gap: "20px 48px", fontFamily: MONO, fontSize: 12, letterSpacing: ".14em", textTransform: "uppercase", color: C.steel }}>
            <span><span style={{ color: C.gold }}>1</span> Tell them who you are</span>
            <span><span style={{ color: C.gold }}>2</span> Write your message</span>
            <span><span style={{ color: C.gold }}>3</span> Send it</span>
          </div>
        </div>
      </div>

      {!sent ? (
        <div id="ff-email-form" className="m-pad m-col p-sec" style={{ maxWidth: 1280, margin: "0 auto", padding: "64px 28px", display: "grid", gridTemplateColumns: ".85fr 1.15fr", gap: 48, alignItems: "start" }}>
          <div style={{ border: "1px solid " + C.line, padding: 32 }}>
            <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.faint, marginBottom: 24 }}>Your details</div>
            <Honeypot value={hp} onChange={(e) => setHp(e.target.value)} />
            <div style={{ display: "flex", flexDirection: "column", gap: 16, position: "relative" }}>
              <Field id="efn" label="First name *" value={f.first} onChange={set("first")} onBlur={() => capture({}, false)} />
              <Field id="eln" label="Last name *" value={f.last} onChange={set("last")} onBlur={() => capture({}, false)} />
              <Field id="eem" label="Email *" value={f.email} onChange={set("email")} onBlur={() => capture({}, false)} />
              <Field id="emb" label="Mobile (optional)" value={f.mobile} onChange={set("mobile")} placeholder="04xxxxxxxx" mono />
            </div>
            <div style={{ marginTop: 28, borderTop: "1px solid " + C.line, paddingTop: 20 }}>
              <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.faint, marginBottom: 12 }}>Goes to</div>
              <div style={{ fontSize: 15, color: C.ink, fontWeight: 600 }}>{m.recipientName}</div>
              <div style={{ fontSize: 13, color: C.mut, marginTop: 4 }}>{m.recipientDisplay}</div>
              <div style={{ fontSize: 13, color: C.faint, marginTop: 10, lineHeight: 1.55 }}>{m.goesToNote}</div>
            </div>
          </div>

          <div style={{ border: "1px solid " + C.line, padding: 32 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, marginBottom: 24 }}>
              <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.faint }}>Your message · variation {variantIdx + 1} of {m.variations.length}</div>
              <button onClick={rewrite} disabled={rewrites >= 3} className="hov-navy-deep" style={{ ...btnBase, fontSize: 13, letterSpacing: ".04em", textTransform: "none", color: C.cream, background: C.navy, border: "none", padding: "12px 18px", opacity: rewrites >= 3 ? .6 : 1, cursor: rewrites >= 3 ? "default" : "pointer" }}>
                {rewrites >= 3 ? "Rewrite limit reached" : rewriting ? "Rewriting…" : "Say it my way (" + (3 - rewrites) + " left)"}
              </button>
            </div>
            <label htmlFor="subj" style={labelStyle}>Subject</label>
            <input id="subj" className="field" value={subject} onChange={(e) => setSubject(e.target.value)} style={{ ...inputStyle(false), marginBottom: 20 }} />
            <label htmlFor="body" style={labelStyle}>Message</label>
            <textarea id="body" className="field" rows={14} value={body} onChange={(e) => setBody(e.target.value)} style={{ ...inputStyle(false), lineHeight: 1.65, padding: 16, background: C.cream, resize: "vertical" }}></textarea>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 12, fontFamily: MONO, fontSize: 12 }}>
              <span style={{ color: counterColor }}>{fmt(chars)} / 1,900 characters</span>
              <span style={{ color: C.faint }}>{counterNote}</span>
            </div>
            <button onClick={send} className="hov-red" style={btnRed({ width: "100%", marginTop: 24, padding: "19px 24px" })}>Send it from my email</button>
            {error && <div style={{ fontSize: 14, color: C.red, marginTop: 14 }}>{error}</div>}
          </div>
        </div>
      ) : (
        <div className="m-pad p-sec" style={{ maxWidth: 820, margin: "0 auto", padding: "80px 28px", animation: "dsgRise .24s cubic-bezier(.2,.6,.2,1) both" }}>
          <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.green }}>Sent</div>
          <h2 style={{ fontFamily: SERIF, fontSize: 50, lineHeight: 1.05, color: C.navy, margin: "16px 0 18px", fontWeight: 400 }}>{m.sentHeading}</h2>
          <p style={{ fontSize: 18, lineHeight: 1.65, color: C.body, margin: "0 0 36px" }}>{m.sentLede}</p>
          <div style={{ border: "1px solid " + C.line, padding: 28, marginBottom: 32 }}>
            <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.faint, marginBottom: 16 }}>Mail app didn't open?</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              <button onClick={() => { copyText(recipient); flash("Recipient copied to your clipboard."); }} className="hov-chip" style={{ ...btnBase, fontSize: 13, letterSpacing: ".04em", textTransform: "none", color: C.navy, background: "transparent", border: "1px solid " + C.tan, padding: "13px 18px" }}>Copy recipient</button>
              <button onClick={() => { copyText(subject); flash("Subject copied to your clipboard."); }} className="hov-chip" style={{ ...btnBase, fontSize: 13, letterSpacing: ".04em", textTransform: "none", color: C.navy, background: "transparent", border: "1px solid " + C.tan, padding: "13px 18px" }}>Copy subject</button>
              <button onClick={() => { copyText(body + sig); flash("Message copied to your clipboard."); }} className="hov-chip" style={{ ...btnBase, fontSize: 13, letterSpacing: ".04em", textTransform: "none", color: C.navy, background: "transparent", border: "1px solid " + C.tan, padding: "13px 18px" }}>Copy message</button>
              <a href={gmailHref} target="_blank" rel="noopener noreferrer" className="hov-chip" style={{ ...btnBase, fontSize: 13, letterSpacing: ".04em", textTransform: "none", color: C.navy, background: "transparent", border: "1px solid " + C.tan, padding: "13px 18px" }}>Open in Gmail</a>
              <a href={outlookHref} target="_blank" rel="noopener noreferrer" className="hov-chip" style={{ ...btnBase, fontSize: 13, letterSpacing: ".04em", textTransform: "none", color: C.navy, background: "transparent", border: "1px solid " + C.tan, padding: "13px 18px" }}>Open in Outlook</a>
            </div>
            {toast && <div style={{ fontSize: 13, color: C.green, marginTop: 14 }}>{toast}</div>}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            <a href="/share" className="hov-red" style={btnRed({ padding: "18px 30px" })}>Bring five people with you</a>
            <a href="/donate" className="hov-navy-fill" style={btnNavyOutline({ fontSize: 15, padding: "16px 28px" })}>Fund the campaign</a>
          </div>
        </div>
      )}
    </div>
  );
}

function DonatePanel({ site, innerRef }) {
  const d = site.donate;
  const [freq, setFreq] = useState("once");
  const [other, setOther] = useState("");
  const [showOther, setShowOther] = useState(false);
  const [toast, flash] = useToast();
  const links = (d.stripeLinks && d.stripeLinks[freq]) || {};
  const customLink = d.stripeLinks && d.stripeLinks.once && d.stripeLinks.once.custom;

  // Monthly pay-what-you-want is not supported by Stripe Payment Links, so a
  // custom monthly gift goes through the checkout endpoint instead.
  const monthlyOther = () => {
    const amt = Number(String(other).replace(/[^\d.]/g, ""));
    if (!amt) return flash("Enter an amount first.");
    apiPost("/api/checkout", { amount: amt, frequency: "monthly", source_url: location.href })
      .then((resp) => { if (resp && resp.url) window.location.href = resp.url; else throw new Error(); })
      .catch(() => flash("Could not open checkout. Please try again in a moment."));
  };

  const toggle = (which) => ({ flex: 1, padding: 15, fontSize: 14, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", border: "none", cursor: "pointer", background: freq === which ? C.navy : "transparent", color: freq === which ? C.cream : C.mut });
  const chip = { padding: "22px 10px", textAlign: "center", border: "1px solid " + C.tan, background: "#FFFFFF", cursor: "pointer", textDecoration: "none", display: "block", boxSizing: "border-box" };

  return (
    <div className="pad-card" style={{ border: "1px solid " + C.tan, background: C.creamCard, boxShadow: "0 1px 0 " + C.tanLine, padding: 36 }} ref={innerRef}>
      <div style={{ display: "flex", border: "1px solid " + C.tan, marginBottom: 24 }}>
        <button onClick={() => { setFreq("once"); setShowOther(false); setOther(""); }} style={toggle("once")}>One off</button>
        <button onClick={() => { setFreq("monthly"); setShowOther(false); setOther(""); }} style={toggle("monthly")}>Monthly</button>
      </div>
      <div className="m-col2" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
        {d.presets.map((v) => (
          <a key={v} href={links[String(v)] || "#"} className="hov-border-red" style={chip}>
            <div style={{ fontFamily: SERIF, fontSize: 26, color: C.navy, lineHeight: 1 }}>{"$" + fmt(v)}</div>
            {freq === "monthly" && <div style={{ fontSize: 11, color: C.faint, marginTop: 5, letterSpacing: ".04em" }}>a month</div>}
          </a>
        ))}
      </div>
      {freq === "once" ? (
        <a href={customLink || "#"} className="hov-border-navy" style={{ display: "block", width: "100%", marginTop: 12, fontSize: 13, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: C.mut, background: "transparent", border: "1px dashed " + C.tan, padding: 16, cursor: "pointer", textAlign: "center", textDecoration: "none", boxSizing: "border-box" }}>Other amount</a>
      ) : !showOther ? (
        <button onClick={() => setShowOther(true)} className="hov-border-navy" style={{ width: "100%", marginTop: 12, fontSize: 13, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: C.mut, background: "transparent", border: "1px dashed " + C.tan, padding: 16, cursor: "pointer" }}>Other amount</button>
      ) : (
        <div style={{ marginTop: 12, border: "1px solid " + C.navy, padding: 16, background: C.cream, animation: "dsgRise .18s cubic-bezier(.2,.6,.2,1) both" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <label htmlFor="oa" style={{ fontSize: 12, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: C.mut }}>Other monthly amount</label>
            <button onClick={() => { setShowOther(false); setOther(""); }} aria-label="Close other amount" className="hov-copy-red" style={{ background: "none", border: "none", color: C.faint, fontSize: 16, lineHeight: 1, cursor: "pointer", padding: "2px 4px" }}>×</button>
          </div>
          <input id="oa" className="field-thin" value={other} onChange={(e) => setOther(e.target.value)} placeholder="AUD" style={inputStyle(true)} />
          <button onClick={monthlyOther} className="hov-red" style={btnRed({ width: "100%", marginTop: 12, fontSize: 14, padding: "16px 20px" })}>Continue to Stripe</button>
        </div>
      )}
      {toast && <div style={{ fontSize: 13, color: C.red, marginTop: 12 }}>{toast}</div>}
      <div style={{ fontSize: 12, color: C.faint, marginTop: 18, lineHeight: 1.6 }}>{d.panelNote}</div>
      <div style={{ fontSize: 12, color: C.faint, marginTop: 8, lineHeight: 1.6 }}>{d.fineprint}</div>
    </div>
  );
}

/* Straight off the petition form: one screen, no nav, no reading, the amounts
   in the middle of it. Everything that is not the ask is removed, because the
   only question at this moment is whether they give. */
function DonateFocusPage({ site }) {
  const d = site.donate;
  const [name, setName] = useState("");
  useEffect(() => {
    try { setName(localStorage.getItem("dsg_signed_name") || ""); } catch (e) {}
  }, []);
  return (
    <div id="donate" style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: C.deepest }}>
      {/* Faceless ranks behind the ask: the men the Memorial is for, no one
          identifiable, so the image carries the argument and not a person. */}
      <img src="/assets/ww1-troops.jpg" alt="Australian soldiers of the First AIF on the Western Front" style={{ position: "fixed", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "center 30%", filter: "grayscale(1)" }} />
      <div style={{ position: "fixed", inset: 0, background: "linear-gradient(to bottom,rgba(10,18,34,.62) 0%,rgba(10,18,34,.8) 45%,rgba(10,18,34,.93) 100%)" }}></div>

      {/* The logo mark is dark, so it sits on its own light bar rather than
          disappearing into the photograph. */}
      <div style={{ position: "relative", flex: "none", background: "#FFFFFF" }}>
        <div className="m-pad" style={{ maxWidth: 1280, margin: "0 auto", padding: "14px 28px", display: "flex", justifyContent: "center" }}>
          <a href="/" style={{ display: "block" }}>
            <img className="m-logo" src="/assets/logo-horizontal.png" alt="Defend Sacred Ground" style={{ height: 42, width: "auto", display: "block" }} />
          </a>
        </div>
      </div>

      <div className="m-pad p-sec" style={{ position: "relative", flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "32px 28px" }}>
        <div style={{ width: "100%", maxWidth: 540 }}>
          <div style={{ textAlign: "center", marginBottom: 24 }}>
            <MonoKickerCentred color={C.gold}>{name ? "Thank you, " + name : "Thank you"}</MonoKickerCentred>
            <h1 style={{ fontFamily: SERIF, fontSize: "clamp(28px,3.4vw,42px)", lineHeight: 1.15, color: "#FFFFFF", margin: "16px 0 14px", fontWeight: 400, textWrap: "balance", textShadow: "0 2px 24px rgba(0,0,0,.5)" }}>{d.signedHeading}</h1>
            <p style={{ fontSize: 16, lineHeight: 1.6, color: C.goldPale, margin: "0 auto", maxWidth: 460, textWrap: "pretty" }}>{d.signedBody}</p>
          </div>
          <DonatePanel site={site} />
          <div style={{ textAlign: "center", marginTop: 18 }}>
            <a href="/share" className="hov-fg-cream" style={{ fontSize: 14, color: C.steel, borderBottom: "1px solid rgba(255,255,255,.25)", paddingBottom: 2 }}>{d.signedSkip}</a>
          </div>
        </div>
      </div>
    </div>
  );
}

function MonoKickerCentred({ color, children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16 }}>
      <div style={{ width: 32, height: 1, background: color }}></div>
      <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: ".26em", textTransform: "uppercase", color }}>{children}</div>
      <div style={{ width: 32, height: 1, background: color }}></div>
    </div>
  );
}

function DonatePage({ site }) {
  const d = site.donate;
  const chipsRef = useRef(null);
  useEffect(() => {
    try {
      if (new URLSearchParams(location.search).get("focus") === "1" && chipsRef.current)
        window.scrollTo(0, chipsRef.current.getBoundingClientRect().top + window.pageYOffset - 96);
    } catch (e) {}
  }, []);
  return (
    <div id="donate">
      <div style={{ position: "relative", background: C.deep, color: C.cream, overflow: "hidden" }}>
        <img src="/assets/poppy-wall.jpg" alt="Poppies tucked beside names on the Roll of Honour" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "center 40%", opacity: .55 }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to right,rgba(15,23,45,.92) 0%,rgba(15,23,45,.6) 55%,rgba(15,23,45,.25) 100%)" }}></div>
        <div className="m-pad p-sec" style={{ position: "relative", maxWidth: 1280, margin: "0 auto", padding: "88px 28px" }}>
          <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: ".26em", textTransform: "uppercase", color: C.gold }}>{d.kicker}</div>
          <h1 style={{ fontFamily: SERIF, fontSize: "clamp(34px,5vw,66px)", lineHeight: 1.02, margin: "24px 0 0", maxWidth: 940, fontWeight: 400 }}>{d.heading}</h1>
          <p style={{ fontSize: 19, lineHeight: 1.6, color: C.goldPale, margin: "24px 0 0", maxWidth: 620 }}>{d.body[0]}</p>
        </div>
      </div>

      <div className="m-pad m-colrev p-sec" style={{ maxWidth: 1280, margin: "0 auto", padding: "64px 28px", display: "grid", gridTemplateColumns: "1.05fr .95fr", gap: 64, alignItems: "start" }}>
        <div>
          {d.body.slice(1).map((t, i) => (
            <p key={i} style={{ fontSize: 18, lineHeight: 1.7, color: C.body, margin: "0 0 20px", maxWidth: 560, textWrap: "pretty" }}>{t}</p>
          ))}
          <div style={{ borderTop: "2px solid " + C.navy, paddingTop: 26, marginTop: 32 }}>
            <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.faint, marginBottom: 8 }}>What it buys</div>
            {d.presets.map((v) => (
              <div key={v} style={{ display: "flex", gap: 24, alignItems: "baseline", borderBottom: "1px solid " + C.line, padding: "16px 4px" }}>
                <span style={{ fontFamily: SERIF, fontSize: 26, color: C.navy, flex: "none", width: 100 }}>{"$" + fmt(v)}</span>
                <span style={{ fontSize: 15, color: C.mut, flex: 1, lineHeight: 1.5 }}>{d.outcomes[String(v)]}</span>
              </div>
            ))}
          </div>
        </div>
        <DonatePanel site={site} innerRef={chipsRef} />
      </div>
    </div>
  );
}

/* Post-donation thank you and the one ask worth making here: convert the
   one-off into a monthly gift. The amount comes back from Stripe so the ask is
   for the sum they actually just gave, not a generic number. */
function ThankYouPage({ site }) {
  const t = site.thankYou;
  const d = site.donate;
  const [gift, setGift] = useState(null);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("session_id");
    if (!id) return;
    fetch("/api/donation-status?session_id=" + encodeURIComponent(id))
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((g) => { if (g && g.paid) setGift(g); })
      .catch(() => {});
  }, []);

  // Offer the monthly link for the largest preset at or below what they gave,
  // so the ask is never larger than the gift they have already made.
  const monthly = (d.stripeLinks && d.stripeLinks.monthly) || {};
  const presets = (d.presets || []).slice().sort((a, b) => a - b);
  const amount = gift && gift.amount;
  const step = amount ? presets.filter((v) => v <= amount).pop() || presets[0] : null;
  const upsellHref = step && monthly[String(step)];
  const showUpsell = gift && !gift.monthly && upsellHref;

  return (
    <div>
      <div style={{ background: C.deepest, color: C.cream }}>
        <div className="m-pad p-hero" style={{ maxWidth: 900, margin: "0 auto", padding: "96px 28px 64px" }}>
          <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 500, letterSpacing: ".22em", textTransform: "uppercase", background: C.red, color: "#FFFFFF", display: "inline-block", padding: "7px 12px" }}>{t.badge}</div>
          <h1 style={{ fontFamily: SERIF, fontSize: "clamp(32px,4.2vw,54px)", lineHeight: 1.08, margin: "22px 0 0", fontWeight: 400 }}>
            {gift && gift.first_name ? "Thank you, " + gift.first_name + "." : t.heading}
          </h1>
          <p style={{ fontSize: 18, lineHeight: 1.65, color: C.goldPale, margin: "20px 0 0", maxWidth: 640 }}>
            {gift ? "Your " + (gift.monthly ? "monthly " : "") + "gift of $" + fmt(gift.amount) + " is with us and a receipt is on its way to your inbox." : t.lede}
          </p>
        </div>
      </div>

      {showUpsell && (
        <div style={{ background: "#FFFFFF", borderBottom: "1px solid " + C.line }}>
          <div className="m-pad p-sec" style={{ maxWidth: 900, margin: "0 auto", padding: "64px 28px" }}>
            <MonoKicker color={C.red}>{t.upsellKicker}</MonoKicker>
            <h2 style={{ fontFamily: SERIF, fontSize: "clamp(26px,2.7vw,36px)", lineHeight: 1.28, color: C.navy, margin: "20px 0 20px", fontWeight: 400 }}>{t.upsellHeading}</h2>
            <p style={{ fontSize: 17, lineHeight: 1.7, color: C.body, margin: "0 0 28px", maxWidth: 620, textWrap: "pretty" }}>{t.upsellBody}</p>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 20 }}>
              <a href={upsellHref} className="hov-red" style={btnRed({ padding: "19px 32px" })}>{t.upsellCta.replace("{amount}", fmt(step))}</a>
              <a href="/share" className="hov-copy-red" style={{ fontSize: 15, color: C.mut, borderBottom: "1px solid " + C.tanLine, paddingBottom: 2 }}>{t.declineCta}</a>
            </div>
            <div style={{ fontSize: 12, color: C.faint, marginTop: 18 }}>{d.panelNote}</div>
          </div>
        </div>
      )}

      <div style={{ background: C.creamMid }}>
        <div className="m-pad p-sec" style={{ maxWidth: 900, margin: "0 auto", padding: "56px 28px" }}>
          <MonoKicker color={C.red}>{t.shareKicker}</MonoKicker>
          <h2 style={{ fontFamily: SERIF, fontSize: "clamp(24px,2.4vw,32px)", lineHeight: 1.25, color: C.navy, margin: "20px 0 24px", fontWeight: 400, textWrap: "pretty" }}>{t.shareHeading}</h2>
          <a href="/share" className="hov-navy-fill" style={btnNavyOutline({ padding: "16px 28px", display: "inline-block" })}>{t.shareCta}</a>
        </div>
      </div>
    </div>
  );
}

function SharePage({ site }) {
  const s = site.share;
  const st = site.shareTexts;
  const [toast, flash] = useToast();
  // Their first name, kept from the moment they signed. Absent for anyone who
  // arrives here cold, so the heading has an unnamed form too.
  const [name, setName] = useState("");
  useEffect(() => {
    try { setName((localStorage.getItem("dsg_signed_name") || "").trim()); } catch (e) {}
  }, []);
  const heading = name && s.headingNamed ? s.headingNamed.replace("{name}", name) : s.heading;
  const link = shareUrl(site);
  const enc = encodeURIComponent;
  const issue = (platform) => apiPost("/api/share-issued", { platform, code: link.split("ref=")[1] }, true).catch(() => {});
  const platforms = [
    { label: "Share on Facebook", bg: "#1877F2", fg: "#FFFFFF", icon: "facebook", href: "https://www.facebook.com/sharer/sharer.php?u=" + enc(link) },
    { label: "Share on Messenger", bg: "#0084FF", fg: "#FFFFFF", icon: "messenger", href: "https://www.facebook.com/sharer/sharer.php?u=" + enc(link) },
    { label: "Share on WhatsApp", bg: "#25D366", fg: "#FFFFFF", icon: "whatsapp", href: "https://wa.me/?text=" + enc(st.sms + " " + link) },
    { label: "Share on Instagram", bg: "#E4405F", fg: "#FFFFFF", icon: "instagram", copy: true },
    { label: "Share on X", bg: "#000000", fg: "#FFFFFF", icon: "x", href: "https://twitter.com/intent/tweet?url=" + enc(link) + "&text=" + enc(st.x) },
    { label: "Share on LinkedIn", bg: "#0A66C2", fg: "#FFFFFF", icon: "linkedin", href: "https://www.linkedin.com/sharing/share-offsite/?url=" + enc(link) },
    { label: "Share on TikTok", bg: "#010101", fg: "#FFFFFF", icon: "tiktok", copy: true },
    { label: "Share by email", bg: C.navy, fg: "#FFFFFF", icon: "email", href: "mailto:?subject=" + enc(st.emailSubject) + "&body=" + enc(st.long + "\n\n" + link) },
    { label: "Share by SMS", bg: C.green, fg: "#FFFFFF", icon: "sms", href: "sms:?&body=" + enc(st.sms + " " + link) },
    { label: "Copy your link", bg: "transparent", fg: C.navy, border: "2px solid " + C.navy, icon: "link", copy: true }
  ];
  const shareBtnStyle = (p) => ({ display: "flex", alignItems: "center", gap: 16, width: "100%", fontSize: 15, fontWeight: 600, letterSpacing: ".03em", color: p.fg, background: p.bg, border: p.border || "none", padding: "16px 22px", cursor: "pointer", textAlign: "left", transition: "opacity .15s", boxSizing: "border-box", textDecoration: "none" });
  const inner = (p) => (
    <React.Fragment>
      <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true" style={{ flex: "none" }}><path d={ICONS[p.icon]}></path></svg>
      <span style={{ flex: 1 }}>{p.label}</span>
      <span style={{ opacity: .7 }}>→</span>
    </React.Fragment>
  );
  return (
    <div>
      <div style={{ position: "relative", background: C.deepest, color: C.cream, overflow: "hidden" }}>
        <img src="/assets/dawn-service.jpg" alt="Australians holding candles at a dawn service" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "center 40%" }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to top,rgba(10,18,34,.9) 0%,rgba(10,18,34,.3) 60%,rgba(10,18,34,.15) 100%)" }}></div>
        <div className="m-pad p-hero" style={{ position: "relative", maxWidth: 820, margin: "0 auto", padding: "120px 28px 64px" }}>
          <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: ".22em", textTransform: "uppercase", color: C.gold }}>Thank you</div>
          <h1 style={{ fontFamily: SERIF, fontSize: "clamp(30px,3.8vw,48px)", lineHeight: 1.12, color: C.cream, margin: "18px 0 0", fontWeight: 400, textWrap: "balance" }}>{heading}</h1>
        </div>
      </div>
      <div className="m-pad p-sec-b" style={{ maxWidth: 820, margin: "0 auto", padding: "48px 28px 80px" }}>
        <div className="pad-card" style={{ border: "1px solid " + C.line, padding: 32, margin: "8px 0 32px" }}>
          <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.faint, marginBottom: 8 }}>Your link</div>
          {s.linkNote && <div style={{ fontSize: 14, lineHeight: 1.6, color: C.mut, marginBottom: 18 }}>{s.linkNote}</div>}
          <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <div style={{ fontFamily: MONO, fontSize: 16, color: C.navy, background: C.creamMid, padding: "16px 20px", flex: 1, minWidth: 280, overflowWrap: "anywhere" }}>{link.replace("https://", "")}</div>
            <button onClick={() => { copyText(link); flash("Link copied to your clipboard."); issue("copy"); }} className="hov-navy-deep" style={{ ...btnBase, fontSize: 13, color: C.cream, background: C.navy, border: "none", padding: "16px 24px" }}>Copy</button>
          </div>
          {toast && <div style={{ fontSize: 13, color: C.green, marginTop: 14 }}>{toast}</div>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 44, maxWidth: 440 }}>
          {platforms.map((p) => p.copy ? (
            <button key={p.label} onClick={() => { copyText(link); flash(p.icon === "link" ? "Link copied to your clipboard." : "Link copied — paste it into your post."); issue(p.icon); }} className="hov-opacity" style={shareBtnStyle(p)}>{inner(p)}</button>
          ) : (
            <a key={p.label} href={p.href} target={p.href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer" onClick={() => issue(p.icon)} className="hov-opacity" style={shareBtnStyle(p)}>{inner(p)}</a>
          ))}
        </div>
        {/* The per-supporter counts were invented placeholders. Everyone lands
            here now, so they are gone until the referral rollup can serve real
            numbers. */}
      </div>
    </div>
  );
}

function NewsPage({ site }) {
  const n = site.news;
  const [active, setActive] = useState(null);
  const [ytVideos, setYtVideos] = useState(null);
  const [toast, flash] = useToast();
  useEffect(() => {
    if (!n.youtubeChannelId) return;
    fetch("/api/youtube?channelId=" + n.youtubeChannelId)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((items) => {
        if (!Array.isArray(items) || !items.length) return;
        setYtVideos(items.slice(0, 9).map((it) => ({
          date: new Date(it.published).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }).toUpperCase(),
          title: it.title, ytId: it.videoId,
          thumb: "https://i.ytimg.com/vi/" + it.videoId + "/hqdefault.jpg"
        })));
      })
      .catch(() => {});
  }, []);
  const videos = ytVideos || n.videos;
  const openSocial = (s2) => { if (s2.url) window.open(s2.url, "_blank", "noopener"); else flash("The " + s2.platform + " profile goes live with the campaign."); };
  const sectionHead = (title, cta, onCta) => (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: 20, marginBottom: 10 }}>
      <h2 style={{ fontFamily: SERIF, fontSize: 34, color: C.navy, margin: 0, fontWeight: 400 }}>{title}</h2>
      <button onClick={onCta} className="hov-underline-red" style={{ fontFamily: MONO, fontSize: 12, letterSpacing: ".14em", textTransform: "uppercase", color: C.red, background: "none", border: "none", borderBottom: "1px solid " + C.gold, padding: "4px 0", cursor: "pointer" }}>{cta}</button>
    </div>
  );
  return (
    <div>
      <div style={{ background: C.deep, color: C.cream }}>
        <div className="m-pad p-sec" style={{ maxWidth: 1280, margin: "0 auto", padding: "96px 28px 64px" }}>
          <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: ".26em", textTransform: "uppercase", color: C.gold }}>News &amp; media</div>
          <h1 style={{ fontFamily: SERIF, fontSize: "clamp(40px,5.4vw,72px)", lineHeight: 1.0, margin: "22px 0 0", maxWidth: 900, fontWeight: 400 }}>{n.heading}</h1>
          <p style={{ fontSize: 19, lineHeight: 1.6, color: C.goldPale, margin: "22px 0 0", maxWidth: 620, textWrap: "pretty" }}>{n.lede}</p>
        </div>
      </div>

      <div className="m-pad p-sec-t" style={{ maxWidth: 1280, margin: "0 auto", padding: "72px 28px 0" }}>
        {sectionHead("On Instagram", "Follow " + n.instagramHandle + " →", () => openSocial(n.socials.find((x) => x.icon === "instagram") || { platform: "Instagram" }))}
        <p style={{ fontSize: 15, color: C.mut, margin: "0 0 28px" }}>Latest from {n.instagramHandle}. Tap any tile to open the post.</p>
        <div className="m-col2" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
          {n.posts.map((p, i) => (
            <button key={i} onClick={() => openSocial(n.socials.find((x) => x.icon === "instagram") || { platform: "Instagram" })} style={{ position: "relative", aspectRatio: "1", overflow: "hidden", border: "1px solid " + C.line, padding: 0, background: C.deep, cursor: "pointer", textAlign: "left" }}>
              <img src={p.img} alt={p.title} loading="lazy" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: .85 }} />
              <span style={{ position: "absolute", inset: "auto 0 0 0", background: "linear-gradient(to top,rgba(10,18,34,.9),rgba(10,18,34,0))", color: C.cream, fontSize: 13, fontWeight: 600, padding: "36px 14px 12px", display: "block", lineHeight: 1.35 }}>{p.title}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="m-pad p-sec-t" style={{ maxWidth: 1280, margin: "0 auto", padding: "72px 28px 0" }}>
        {sectionHead("Latest videos", "Visit channel →", () => openSocial(n.socials.find((x) => x.icon === "youtube") || { platform: "YouTube" }))}
        <p style={{ fontSize: 15, color: C.mut, margin: "0 0 28px" }}>Pulled from the campaign's YouTube channel. New uploads appear here automatically.</p>
        {active && (
          <div style={{ marginBottom: 32, background: C.deepest, border: "1px solid " + C.deep }}>
            <div style={{ position: "relative", width: "100%", aspectRatio: "16/9" }}>
              <iframe src={"https://www.youtube-nocookie.com/embed/" + active.ytId + "?autoplay=1"} title="Campaign video" allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" }}></iframe>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, padding: "14px 20px" }}>
              <span style={{ fontFamily: SERIF, fontSize: 18, color: C.cream }}>{active.title}</span>
              <button onClick={() => setActive(null)} className="hov-ghost-cream hov-fg-cream" style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: C.steel, background: "none", border: "1px solid rgba(156,169,193,.4)", padding: "8px 14px", cursor: "pointer", flex: "none" }}>Close</button>
            </div>
          </div>
        )}
        <div className="m-col" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 24 }}>
          {videos.map((v, i) => (
            <button key={i} onClick={() => { if (v.ytId) { setActive(v); window.scrollTo({ top: 0, behavior: "smooth" }); } else flash("Videos play inline once the campaign channel is connected."); }} style={{ textAlign: "left", background: "transparent", border: "none", padding: 0, cursor: "pointer", display: "flex", flexDirection: "column", gap: 12 }}>
              <span style={{ position: "relative", display: "block", width: "100%", aspectRatio: "16/9", overflow: "hidden", border: "1px solid " + C.line, background: C.deep }}>
                <img src={v.thumb} alt={v.title} loading="lazy" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
                <span style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 58, height: 42, background: "rgba(158,27,36,.95)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <span style={{ width: 0, height: 0, borderLeft: "16px solid #FFFFFF", borderTop: "10px solid transparent", borderBottom: "10px solid transparent", display: "block", marginLeft: 4 }}></span>
                </span>
              </span>
              <span style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".14em", color: C.faint }}>{v.date}</span>
              <span style={{ fontFamily: SERIF, fontSize: 21, lineHeight: 1.25, color: C.navy }}>{v.title}</span>
            </button>
          ))}
        </div>
        {toast && <div style={{ fontSize: 13, color: C.green, marginTop: 18 }}>{toast}</div>}
      </div>

      <div className="m-pad p-sec" style={{ maxWidth: 1280, margin: "0 auto", padding: "72px 28px 96px" }}>
        <h2 style={{ fontFamily: SERIF, fontSize: 34, color: C.navy, margin: "0 0 10px", fontWeight: 400 }}>On the socials</h2>
        <p style={{ fontSize: 15, color: C.mut, margin: "0 0 28px" }}>Follow along across every platform.</p>
        <div className="m-col2" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 16 }}>
          {n.socials.map((s2, i) => (
            <button key={i} onClick={() => openSocial(s2)} className="hov-border-red" style={{ display: "flex", flexDirection: "column", gap: 10, textAlign: "left", background: C.cream, border: "1px solid " + C.tan, padding: 22, cursor: "pointer" }}>
              <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 40, height: 40, background: s2.color, flex: "none" }}>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="#FFFFFF" aria-hidden="true"><path d={ICONS[s2.icon]}></path></svg>
              </span>
              <span style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.faint }}>{s2.platform}</span>
              <span style={{ fontSize: 14, fontWeight: 600, color: C.navy, minWidth: 0, overflowWrap: "anywhere" }}>{s2.handle}</span>
              <span style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: C.red }}>Open →</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function HeroDark({ img, alt, pos, opacity, kicker, heading, lede }) {
  return (
    <div style={{ position: "relative", background: C.deepest, color: C.cream, overflow: "hidden" }}>
      <img src={img} alt={alt} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: pos || "center 40%", opacity: opacity == null ? 1 : opacity }} />
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to top,rgba(10,18,34,.94) 0%,rgba(10,18,34,.45) 60%,rgba(10,18,34,.2) 100%)" }}></div>
      <div className="m-pad p-hero" style={{ position: "relative", maxWidth: 1280, margin: "0 auto", padding: "150px 28px 72px" }}>
        <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: ".26em", textTransform: "uppercase", color: C.gold }}>{kicker}</div>
        <h1 style={{ fontFamily: SERIF, fontSize: "clamp(40px,5.4vw,72px)", lineHeight: 1.0, margin: "24px 0 0", maxWidth: 940, fontWeight: 400 }}>{heading}</h1>
        <p style={{ fontSize: 19, lineHeight: 1.6, color: C.goldPale, margin: "24px 0 0", maxWidth: 620, textWrap: "pretty" }}>{lede}</p>
      </div>
    </div>
  );
}

function IssuePage({ site }) {
  const iss = site.issue;
  return (
    <div>
      <HeroDark img="/assets/cranes.jpg" alt="Construction cranes over the Australian War Memorial" opacity={.55} kicker={iss.kicker} heading={iss.heading} lede={iss.lede} />
      <div className="m-pad p-sec" style={{ maxWidth: 820, margin: "0 auto", padding: "72px 28px 56px" }}>
        <h2 style={{ fontFamily: SERIF, fontSize: 34, color: C.navy, margin: "0 0 20px", lineHeight: 1.15, fontWeight: 400 }}>{iss.proseHeading}</h2>
        {iss.prose.map((t, i) => (
          <p key={i} style={{ fontSize: 18, lineHeight: 1.7, color: C.body, margin: i === iss.prose.length - 1 ? 0 : "0 0 20px", textWrap: "pretty" }}>{t}</p>
        ))}
      </div>
      <div className="m-pad p-sec-b" style={{ maxWidth: 1280, margin: "0 auto", padding: "0 28px 72px" }}>
        <SoldiersLine site={site} />
        <StatsBand site={site} />
      </div>
      <div style={{ background: C.creamMid, borderTop: "1px solid " + C.line, borderBottom: "1px solid " + C.line }}>
        <div className="m-pad" style={{ maxWidth: 1280, margin: "0 auto", padding: "72px 28px" }}>
          <h2 style={{ fontFamily: SERIF, fontSize: 40, lineHeight: 1.06, color: C.navy, margin: "0 0 36px", maxWidth: 760, fontWeight: 400 }}>{iss.changesHeading}</h2>
          <ChangesGrid site={site} />
          <div style={{ background: C.cream, borderLeft: "3px solid " + C.red, border: "1px solid " + C.tanLine, borderLeftWidth: 3, borderLeftColor: C.red, padding: "32px 36px", marginTop: 32 }}>
            <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.red }}>{iss.notAWar.kicker}</div>
            <h3 style={{ fontFamily: SERIF, fontSize: 30, color: C.navy, margin: "14px 0 14px", lineHeight: 1.12, fontWeight: 400 }}>{iss.notAWar.heading}</h3>
            {iss.notAWar.body.map((t, i) => (
              <p key={i} style={{ fontSize: 16, lineHeight: 1.7, color: C.body, margin: i === iss.notAWar.body.length - 1 ? 0 : "0 0 14px", maxWidth: 820, textWrap: "pretty" }}>{t}</p>
            ))}
          </div>
        </div>
      </div>
      <CtaBandDark title="Do not let them get away with it." />
    </div>
  );
}

function AboutPage({ site }) {
  const a = site.about;
  return (
    <div>
      <HeroDark img="/assets/volunteers-stall.jpg" alt="Campaign volunteers at a weekend market stall" pos="center 35%" opacity={.6} kicker={a.kicker} heading={a.heading} lede={a.lede} />
      <div className="m-pad p-sec" style={{ maxWidth: 820, margin: "0 auto", padding: "72px 28px 56px" }}>
        <h2 style={{ fontFamily: SERIF, fontSize: 34, color: C.navy, margin: "0 0 20px", lineHeight: 1.15, fontWeight: 400 }}>{a.whoHeading}</h2>
        {a.who.map((t, i) => (
          <p key={i} style={{ fontSize: 18, lineHeight: 1.7, color: C.body, margin: i === a.who.length - 1 ? 0 : "0 0 20px", textWrap: "pretty" }}>{t}</p>
        ))}
      </div>
      <div className="m-pad p-sec-b" style={{ maxWidth: 1280, margin: "0 auto", padding: "0 28px 72px" }}>
        <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.faint, marginBottom: 24 }}>{a.directorsKicker}</div>
        <div className="m-col" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 32 }}>
          {a.directors.map((dr, i) => (
            <div key={i} style={{ border: "1px solid " + C.line, borderTop: "2px solid " + C.navy, padding: 32, background: C.cream }}>
              {/* Photo slot: swap the placeholder for an <img> when portraits are supplied. */}
              <div role="img" aria-label={dr.photoPlaceholder} style={{ width: 120, height: 120, marginBottom: 20, borderRadius: "50%", background: "#f2f1ef", border: "1.5px dashed " + C.tan, display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box" }}>
                <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase", color: C.faint, textAlign: "center", padding: 10 }}>{dr.photoPlaceholder}</span>
              </div>
              <h3 style={{ fontFamily: SERIF, fontSize: 28, color: C.navy, margin: "0 0 6px", lineHeight: 1.1, fontWeight: 400 }}>{dr.name}</h3>
              <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: C.red, marginBottom: 14 }}>{dr.role}</div>
              <p style={{ fontSize: 15, lineHeight: 1.65, color: C.mut, margin: 0 }}>{dr.bio}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="m-pad p-sec-b" style={{ maxWidth: 1280, margin: "0 auto", padding: "0 28px 80px" }}>
        <div className="m-col2" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 1, background: C.line, border: "1px solid " + C.line }}>
          {a.principles.map((p, i) => (
            <div key={i} style={{ background: C.cream, padding: 32 }}>
              <div style={{ fontFamily: SERIF, fontSize: 40, color: C.gold, lineHeight: 1 }}>{p.numeral}</div>
              <h3 style={{ fontSize: 16, margin: "14px 0 10px", color: C.navy, fontWeight: 600 }}>{p.title}</h3>
              <p style={{ fontSize: 14, lineHeight: 1.65, color: C.mut, margin: 0 }}>{p.body}</p>
            </div>
          ))}
        </div>
      </div>
      <CtaBandDark title="Stand with us." />
    </div>
  );
}

function VolunteerPage({ site }) {
  const v = site.volunteer;
  const [roles, setRoles] = useState([]);
  const [f, setF] = useState({ first: "", last: "", email: "", mobile: "", postcode: "" });
  const [hp, setHp] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  useHashScroll();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const toggle = (r) => setRoles(roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r]);
  const submit = () => {
    if (hp) { setDone(true); return; }
    if (!f.first.trim() || !f.last.trim()) return setError("Please enter your first and last name.");
    if (!validEmail(f.email)) return setError("Please enter a valid email address.");
    if (!roles.length) return setError("Pick at least one way you can help.");
    setError("");
    setDone(true);
    apiPost("/api/event-log", { type: "volunteer_signup", ...f, roles, source_url: location.href }).catch(() => {});
  };
  return (
    <div>
      <HeroDark img="/assets/letterbox.jpg" alt="A volunteer letterboxing a suburban street" opacity={.6} kicker={v.kicker} heading={v.heading} lede={v.lede} />
      <div id="signup" className="m-pad m-col p-sec" style={{ maxWidth: 1280, margin: "0 auto", padding: "72px 28px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 64, alignItems: "start" }}>
        <div>
          <h2 style={{ fontFamily: SERIF, fontSize: 40, lineHeight: 1.06, color: C.navy, margin: "0 0 18px", fontWeight: 400 }}>{v.helpHeading}</h2>
          <p style={{ fontSize: 17, lineHeight: 1.65, color: C.mut, margin: "0 0 28px", maxWidth: 500 }}>{v.helpLede}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {v.roles.map((r) => {
              const active = roles.includes(r);
              return (
                <button key={r} onClick={() => toggle(r)} className="hov-border-red" style={{ display: "flex", alignItems: "center", gap: 16, width: "100%", textAlign: "left", fontSize: 16, fontWeight: 500, color: active ? C.red : C.body, background: C.cream, border: active ? "2px solid " + C.red : "1px solid " + C.tan, padding: "18px 22px", cursor: "pointer", boxSizing: "border-box" }}>
                  <span style={{ flex: 1 }}>{r}</span>
                  {active && <span style={{ color: C.red, fontWeight: 700 }}>✓</span>}
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ background: C.cream, border: "1px solid " + C.tan, padding: 36 }}>
          {!done ? (
            <div>
              <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.faint, marginBottom: 24 }}>Your details</div>
              <Honeypot value={hp} onChange={(e) => setHp(e.target.value)} />
              <div className="m-col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <Field id="vfn" label="First name *" value={f.first} onChange={set("first")} />
                <Field id="vln" label="Last name *" value={f.last} onChange={set("last")} />
              </div>
              <div style={{ marginTop: 16 }}>
                <Field id="vem" label="Email *" value={f.email} onChange={set("email")} />
              </div>
              <div className="m-col" style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16, marginTop: 16 }}>
                <Field id="vmb" label="Mobile" value={f.mobile} onChange={set("mobile")} placeholder="04xxxxxxxx" mono />
                <Field id="vpc" label="Postcode" value={f.postcode} onChange={set("postcode")} mono />
              </div>
              {error && <div style={{ fontSize: 14, color: C.red, marginTop: 14 }}>{error}</div>}
              <button onClick={submit} className="hov-red" style={btnRed({ width: "100%", marginTop: 24, padding: "19px 24px" })}>Count me in</button>
              <div style={{ fontSize: 12, color: C.faint, marginTop: 14, lineHeight: 1.6 }}>Privacy preserved. Unsubscribe at any time.</div>
            </div>
          ) : (
            <div style={{ animation: "dsgRise .24s cubic-bezier(.2,.6,.2,1) both" }}>
              <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.green }}>You're in · Thank you</div>
              <div style={{ fontFamily: SERIF, fontSize: 32, lineHeight: 1.12, color: C.navy, margin: "16px 0 14px" }}>{f.first.trim() || "Thank you"}, a coordinator will call you this week.</div>
              <p style={{ fontSize: 15, lineHeight: 1.65, color: C.mut, margin: "0 0 24px" }}>In the meantime, the two most useful things take 10 seconds each.</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <a href="/take-action/defend-sacred-ground" className="hov-red" style={btnRed({ width: "100%", fontSize: 14, padding: "17px 24px" })}>Sign the petition</a>
                <a href="/share" className="hov-navy-fill" style={btnNavyOutline({ width: "100%", padding: "15px 24px" })}>Get your share link</a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ContactPage({ site }) {
  const c = site.contact;
  const [topic, setTopic] = useState(c.topics[0]);
  const [f, setF] = useState({ first: "", last: "", email: "" });
  const [msg, setMsg] = useState("");
  const [hp, setHp] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = () => {
    if (hp) { setDone(true); return; }
    if (!f.first.trim() || !f.last.trim()) return setError("Please enter your first and last name.");
    if (!validEmail(f.email)) return setError("Please enter a valid email address.");
    if (!msg.trim()) return setError("Please write a message.");
    setError("");
    setDone(true);
    apiPost("/api/event-log", { type: "contact_message", ...f, topic, message: msg, source_url: location.href }).catch(() => {});
  };
  return (
    <div>
      <div style={{ background: C.deep, color: C.cream }}>
        <div className="m-pad p-sec" style={{ maxWidth: 1280, margin: "0 auto", padding: "96px 28px 64px" }}>
          <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: ".26em", textTransform: "uppercase", color: C.gold }}>{c.kicker}</div>
          <h1 style={{ fontFamily: SERIF, fontSize: "clamp(40px,5.4vw,72px)", lineHeight: 1.0, margin: "22px 0 0", maxWidth: 900, fontWeight: 400 }}>{c.heading}</h1>
          <p style={{ fontSize: 19, lineHeight: 1.6, color: C.goldPale, margin: "22px 0 0", maxWidth: 620, textWrap: "pretty" }}>{c.lede}</p>
        </div>
      </div>
      <div className="m-pad m-col p-sec" style={{ maxWidth: 1280, margin: "0 auto", padding: "72px 28px 96px", display: "grid", gridTemplateColumns: ".85fr 1.15fr", gap: 64, alignItems: "start" }}>
        <div>
          <h2 style={{ fontFamily: SERIF, fontSize: 34, color: C.navy, margin: "0 0 18px", lineHeight: 1.15, fontWeight: 400 }}>{c.beforeHeading}</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {c.before.map((b, i) => (
              <div key={i} style={{ borderLeft: "2px solid " + C.gold, padding: "2px 0 2px 18px" }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: C.navy, marginBottom: 4 }}>{b.title}</div>
                <div style={{ fontSize: 14, lineHeight: 1.6, color: C.mut }}>{b.body}</div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ background: C.creamCard, border: "1px solid " + C.tan, boxShadow: "0 1px 0 " + C.tanLine, padding: 36 }}>
          {!done ? (
            <div>
              <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.faint, marginBottom: 20 }}>Your message</div>
              <Honeypot value={hp} onChange={(e) => setHp(e.target.value)} />
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 22 }}>
                {c.topics.map((tp) => (
                  <button key={tp} onClick={() => setTopic(tp)} className="hov-border-red" style={{ fontSize: 13, fontWeight: 600, letterSpacing: ".04em", color: topic === tp ? C.red : C.body, background: "#FFFFFF", border: topic === tp ? "2px solid " + C.red : "1px solid " + C.tan, padding: "11px 16px", cursor: "pointer" }}>{tp}</button>
                ))}
              </div>
              <div className="m-col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <Field id="cfn" label="First name *" value={f.first} onChange={set("first")} />
                <Field id="cln" label="Last name *" value={f.last} onChange={set("last")} />
              </div>
              <div style={{ marginTop: 16 }}>
                <Field id="cem" label="Email *" value={f.email} onChange={set("email")} />
              </div>
              <div style={{ marginTop: 16 }}>
                <label htmlFor="cmsg" style={labelStyle}>Message *</label>
                <textarea id="cmsg" className="field" rows={6} value={msg} onChange={(e) => setMsg(e.target.value)} style={{ ...inputStyle(false), lineHeight: 1.6, resize: "vertical" }}></textarea>
              </div>
              {error && <div style={{ fontSize: 14, color: C.red, marginTop: 14 }}>{error}</div>}
              <button onClick={submit} className="hov-red" style={btnRed({ width: "100%", marginTop: 24, padding: "19px 24px" })}>Send message</button>
              <div style={{ fontSize: 12, color: C.faint, marginTop: 14, lineHeight: 1.6 }}>Privacy preserved. Unsubscribe at any time.</div>
            </div>
          ) : (
            <div style={{ animation: "dsgRise .24s cubic-bezier(.2,.6,.2,1) both" }}>
              <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.green }}>Sent · Thank you</div>
              <div style={{ fontFamily: SERIF, fontSize: 32, lineHeight: 1.12, color: C.navy, margin: "16px 0 14px" }}>{f.first.trim() || "Thank you"}, we have your message.</div>
              <p style={{ fontSize: 15, lineHeight: 1.65, color: C.mut, margin: "0 0 24px" }}>A volunteer will reply within two days. Media enquiries are answered the same day.</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <a href="/take-action/defend-sacred-ground" className="hov-red" style={btnRed({ width: "100%", fontSize: 14, padding: "17px 24px" })}>Sign the petition</a>
                <a href="/donate" className="hov-navy-fill" style={btnNavyOutline({ width: "100%", padding: "15px 24px" })}>Fund the campaign</a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── app shell ───────────────────────────────────────────────────── */

const PAGES = {
  home: HomePage,
  petition: PetitionPage,
  minister: MinisterPage,
  donate: DonatePage,
  thankyou: ThankYouPage,
  share: SharePage,
  news: NewsPage,
  issue: IssuePage,
  about: AboutPage,
  volunteer: VolunteerPage,
  contact: ContactPage
};

function App({ site, page }) {
  // ?signed=1 on the donate page is the post-signature screen: chrome removed
  // so nothing competes with the ask.
  let focus = false;
  try { focus = page === "donate" && new URLSearchParams(location.search).get("signed") === "1"; } catch (e) {}
  const Page = focus ? DonateFocusPage : (PAGES[page] || HomePage);
  const shell = { fontFamily: "'Public Sans',system-ui,sans-serif", color: C.ink, background: C.cream, minHeight: "100vh" };
  if (focus) return <div style={shell}><Page site={site} /></div>;
  return (
    <div style={shell}>
      <Nav site={site} page={page} />
      <Page site={site} />
      <Footer site={site} />
    </div>
  );
}

fetch("/content/site.json", { cache: "no-cache" })
  .then((r) => r.json())
  .then((site) => {
    const root = document.getElementById("root");
    ReactDOM.createRoot(root).render(<App site={site} page={root.dataset.page} />);
  })
  .catch((e) => { console.error("Failed to load site content", e); });
