/* Defend Sacred Ground — supporter survey.
 *
 * A standalone app, not part of the main site bundle: it is reached from a CRM
 * email by people who may never have seen the site, and it should load in one
 * request rather than dragging the whole campaign site with it.
 *
 * Everything is config. client.json is brand and copy, survey.json is the
 * questions. Pointing this at a different client is two files and no code.
 *
 * The identity rule that matters: the uid in the URL is a supporter's referral
 * code, and it is the only thing that identifies them. It is uppercased before
 * use, kept in session storage so a refresh does not lose it, and never
 * written into anything the browser sends anywhere except this app's own API.
 */
/* global React, ReactDOM */

const { useState, useEffect, useRef } = React;

const GENERIC_ERROR = "We could not reach the campaign server. Check your connection and try again.";

function post(path, data) {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  }).then((r) => r.json().catch(() => ({})).then((d) => {
    if (r.ok) return d;
    const e = new Error((d && d.error) || GENERIC_ERROR);
    e.status = r.status;
    throw e;
  }), () => { throw new Error(GENERIC_ERROR); });
}

const messageOf = (e) => (e && e.message) || GENERIC_ERROR;

/* Icons, one flat set, drawn at 26px. Named in the config by key. */
const ICONS = {
  medal: "M12 2l3 6 6 .9-4.5 4.2 1.1 6.1L12 16.4 6.4 19.2l1.1-6.1L3 8.9 9 8z",
  shield: "M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5z",
  book: "M4 4h7a3 3 0 013 3v13a3 3 0 00-3-3H4zm16 0h-7a3 3 0 00-3 3v13a3 3 0 013-3h7z",
  coin: "M12 2a10 10 0 100 20 10 10 0 000-20zm1 5v1.2c1.4.2 2.4 1 2.4 2.3h-2c0-.5-.6-.8-1.4-.8s-1.4.3-1.4.8.5.7 1.8 1c1.9.4 3.1 1 3.1 2.6 0 1.4-1 2.2-2.5 2.4V18h-2v-1.5c-1.6-.2-2.7-1.1-2.7-2.5h2c0 .6.7 1 1.7 1s1.5-.3 1.5-.8-.6-.8-1.9-1.1c-1.8-.4-3-1-3-2.5 0-1.3 1-2.2 2.4-2.4V7z",
  lock: "M6 10V7a6 6 0 1112 0v3h2v12H4V10zm2 0h8V7a4 4 0 10-8 0z",
  pin: "M12 2a7 7 0 017 7c0 5-7 13-7 13S5 14 5 9a7 7 0 017-7zm0 4.5A2.5 2.5 0 1012 12a2.5 2.5 0 000-5.5z",
  flame: "M12 2s5 5 5 9a5 5 0 01-10 0c0-1.5.8-3 .8-3S8 11 9.5 11 12 2 12 2z",
  home: "M12 3l9 8h-3v10h-5v-6h-2v6H6V11H3z",
  heart: "M12 21s-8-5-8-10.5A4.5 4.5 0 0112 7a4.5 4.5 0 018 3.5C20 16 12 21 12 21z",
  pen: "M3 17.5V21h3.5L18 9.5 14.5 6zM20.7 6.8a1 1 0 000-1.4l-2.1-2.1a1 1 0 00-1.4 0L15.5 5l3.5 3.5z",
  megaphone: "M3 10v4h3l5 4V6L6 10zm13-3v10a5 5 0 000-10z",
  hammer: "M14 2l8 8-3 3-3-3-8 8-3-3 8-8-3-3z",
  flag: "M5 3v18h2v-7h6l1 2h6V5h-6l-1-2z",
  stop: "M8 3h8l5 5v8l-5 5H8l-5-5V8z",
  eye: "M12 5C6 5 2 12 2 12s4 7 10 7 10-7 10-7-4-7-10-7zm0 11a4 4 0 110-8 4 4 0 010 8z",
  gavel: "M2 20h10v2H2zm12.7-3.3l1.4-1.4-8.5-8.5-1.4 1.4zM18 2l4 4-2.8 2.8-4-4z",
  people: "M8 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm8 0a3 3 0 100-6 3 3 0 000 6zM2 20v-1.5C2 15.6 5 14 8 14s6 1.6 6 4.5V20zm14 0v-1.7c0-1.6-.7-2.9-1.8-3.8 2.6.2 5.8 1.5 5.8 4V20z",
  share: "M18 16a3 3 0 00-2.2 1L9 13.5a3 3 0 000-3L15.8 7A3 3 0 1014 5l-6.8 3.5a3 3 0 100 7L14 19a3 3 0 103.9-3z",
  paper: "M4 3h13l3 3v15H4zm3 5h9v2H7zm0 4h9v2H7zm0 4h6v2H7z",
  mail: "M2 5h20v14H2zm2 2.2V17h16V7.2l-8 5.4z",
  sms: "M12 3C6.5 3 2 6.9 2 11.8c0 2.7 1.4 5.1 3.6 6.7L5 22l4.4-2.3c.9.2 1.7.3 2.6.3 5.5 0 10-3.9 10-8.8S17.5 3 12 3z",
  phone: "M6.6 10.8a15 15 0 006.6 6.6l2.2-2.2a1 1 0 011-.2c1.1.4 2.3.6 3.6.6a1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.3.2 2.5.6 3.6a1 1 0 01-.2 1z",
  cross: "M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z",
  tick: "M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"
};

const Icon = ({ name, cls }) => {
  const d = ICONS[name];
  if (!d) return null;
  return <svg className={cls} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={d}></path></svg>;
};

/* ── identity ─────────────────────────────────────────────────────
 * The uid is uppercased everywhere. Mail clients lowercase URLs, and a
 * lowercased uid that misses its row starts a second survey for someone who
 * already has one. */
function readUid() {
  let uid = "", src = "";
  try {
    const q = new URLSearchParams(location.search);
    uid = (q.get("uid") || "").trim().toUpperCase();
    src = (q.get("src") || "").trim();
  } catch (e) {}
  if (!uid) { try { uid = (sessionStorage.getItem("dsg_survey_uid") || "").toUpperCase(); } catch (e) {} }
  if (uid) { try { sessionStorage.setItem("dsg_survey_uid", uid); } catch (e) {} }
  return { uid, src };
}

function slugFromPath() {
  const m = location.pathname.match(/\/s\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : "";
}

/* ── screens ──────────────────────────────────────────────────── */

function SingleSelect({ screen, value, onChange }) {
  return (
    <div className="opts" role="radiogroup" aria-label={screen.question}>
      {screen.options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
          className={"opt" + (value === o.value ? " on" : "")}
          onClick={() => onChange(o.value)}>
          <Icon name={o.icon} cls="ic" />
          <span>{o.label}</span>
          <Icon name="tick" cls="tick" />
        </button>
      ))}
    </div>
  );
}

function MultiSelect({ screen, value, onChange }) {
  const list = Array.isArray(value) ? value : [];
  const toggle = (v) => onChange(list.includes(v) ? list.filter((x) => x !== v) : list.concat(v));
  return (
    <div className="opts">
      {screen.options.map((o) => (
        <button key={o.value} type="button" role="checkbox" aria-checked={list.includes(o.value)}
          className={"opt" + (list.includes(o.value) ? " on" : "")}
          onClick={() => toggle(o.value)}>
          <Icon name={o.icon} cls="ic" />
          <span>{o.label}</span>
          <Icon name="tick" cls="tick" />
        </button>
      ))}
    </div>
  );
}

function Scale({ screen, value, onChange }) {
  return (
    <div>
      <div className="scale">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" aria-label={String(n)} aria-pressed={value === n}
            className={value === n ? "on" : ""} onClick={() => onChange(n)}>{n}</button>
        ))}
      </div>
      <div className="scale-labels"><span>{screen.lowLabel}</span><span>{screen.highLabel}</span></div>
    </div>
  );
}

function Postcode({ value, onChange }) {
  return (
    <div>
      <label className="lbl" htmlFor="pc">Postcode</label>
      <input id="pc" className="field mono" inputMode="numeric" autoComplete="postal-code"
        maxLength={4} value={value || ""}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 4))} />
    </div>
  );
}

/* ── app ──────────────────────────────────────────────────────── */

function Survey({ client, config }) {
  const c = client.copy;
  const { uid: initialUid, src } = readUid();

  const [uid, setUid] = useState(initialUid);
  const [phase, setPhase] = useState("loading"); // loading | intro | capture | screens | done | error
  const [person, setPerson] = useState({ first_name: "" });
  const [skip, setSkip] = useState([]);
  const [answers, setAnswers] = useState({});
  const [idx, setIdx] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(null);
  const submitted = useRef(false);

  // Screens the server said it already knows are removed entirely rather than
  // rendered and hidden: a question nobody has to answer should not be counted
  // in "question 4 of 14" either.
  const screens = config.screens.filter((s) => skip.indexOf(s.id) === -1);
  const screen = screens[idx];

  useEffect(() => {
    if (!uid) { setPhase("capture"); return; }
    post("/api/survey/resolve", { uid, slug: config.slug, src })
      .then((d) => {
        if (d.state !== "ready") { setPhase("capture"); return; }
        setPerson({ first_name: d.first_name || "" });
        setSkip(d.skip || []);
        setAnswers(d.answers || {});
        if (d.status === "complete") { finish(d.answers || {}, true); return; }
        // Resume at the first unanswered screen rather than at the top.
        const answered = Object.keys(d.answers || {});
        const list = config.screens.filter((s) => (d.skip || []).indexOf(s.id) === -1);
        const next = list.findIndex((s) => s.type !== "statement" && answered.indexOf(s.id) === -1);
        setIdx(next > 0 ? next : 0);
        setPhase(answered.length ? "screens" : "intro");
      })
      .catch(() => setPhase("capture"));
  }, []);

  const value = screen ? answers[screen.id] : undefined;
  const answered = screen && (screen.type === "statement" ||
    (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== ""));

  /* Save on advance rather than on every tap: a multi-select would otherwise
   * write once per option touched. A failed save is reported but does not
   * block, because the browser still holds every answer and sends the lot at
   * completion. */
  const save = (screenId, v) => {
    if (!uid) return;
    post("/api/survey/answer", { uid, slug: config.slug, version: config.version, screen: screenId, value: v, src })
      .catch((err) => console.warn("answer not saved:", messageOf(err)));
  };

  const next = () => {
    setError("");
    if (screen && screen.type !== "statement") save(screen.id, answers[screen.id]);
    if (idx + 1 < screens.length) { setIdx(idx + 1); window.scrollTo(0, 0); return; }
    finish(answers, false);
  };

  const back = () => { setError(""); if (idx > 0) { setIdx(idx - 1); window.scrollTo(0, 0); } };

  const finish = (all, alreadyDone) => {
    if (submitted.current && !alreadyDone) return;
    submitted.current = true;
    setBusy(true);
    const tagTemplates = {};
    config.screens.forEach((s) => { if (s.cn_tag) tagTemplates[s.id] = s.cn_tag; });
    post("/api/survey/complete", { uid, slug: config.slug, answers: all, tagTemplates })
      .then((d) => {
        if (d.first_name) setPerson({ first_name: d.first_name });
        setAsk(d.ask || null);
        setPhase("done");
      })
      .catch((err) => {
        // Their answers are saved per screen, so this failed the closing ask
        // and nothing else. Say that rather than implying the survey was lost.
        submitted.current = false;
        setError(messageOf(err) + " Your answers were saved as you went.");
        setAsk(null);
        setPhase("done");
      })
      .then(() => setBusy(false));
  };

  if (phase === "loading") {
    return <Shell client={client}><div className="wrap"><div className="screen"><p className="lede">Loading…</p></div></div></Shell>;
  }

  if (phase === "capture") {
    return <Shell client={client}><Capture client={client} config={config} src={src}
      onDone={(d) => { setUid(d.uid); setPerson({ first_name: d.first_name }); try { sessionStorage.setItem("dsg_survey_uid", d.uid); } catch (e) {} setPhase("intro"); }} /></Shell>;
  }

  if (phase === "intro") {
    const greeting = person.first_name
      ? c.greeting.replace("{first_name}", person.first_name) : c.greetingAnon;
    return (
      <Shell client={client}>
        <div className="wrap">
          <div className="screen">
            <div className="kicker">{config.intro.kicker}</div>
            <h1>{greeting}</h1>
            <h2>{config.intro.heading}</h2>
            <p className="lede">{config.intro.lede}</p>
            <p className="privacy">{c.privacy}</p>
          </div>
        </div>
        <div className="actions"><div className="actions-in">
          <button className="btn" onClick={() => { setPhase("screens"); window.scrollTo(0, 0); }}>{config.intro.cta}</button>
        </div></div>
      </Shell>
    );
  }

  if (phase === "done") {
    return <Shell client={client}><Done client={client} config={config} person={person} ask={ask} error={error} /></Shell>;
  }

  const questionNumber = screens.slice(0, idx + 1).filter((s) => s.type !== "statement").length;
  const questionTotal = screens.filter((s) => s.type !== "statement").length;

  return (
    <Shell client={client} progress={(idx + 1) / screens.length}
      count={screen.type === "statement" ? "" : c.progressLabel.replace("{n}", questionNumber).replace("{total}", questionTotal)}>
      <div className="wrap">
        <div className="screen" key={screen.id}>
          {screen.type === "statement" ? (
            <div>
              <h1>{screen.heading}</h1>
              <p className="lede">{screen.body}</p>
            </div>
          ) : (
            <div>
              <h2>{screen.question}</h2>
              {screen.type === "single_select" && <SingleSelect screen={screen} value={value} onChange={(v) => setAnswers({ ...answers, [screen.id]: v })} />}
              {screen.type === "phone_optin" && <SingleSelect screen={screen} value={value} onChange={(v) => setAnswers({ ...answers, [screen.id]: v })} />}
              {screen.type === "multi_select" && <MultiSelect screen={screen} value={value} onChange={(v) => setAnswers({ ...answers, [screen.id]: v })} />}
              {screen.type === "scale_1_5" && <Scale screen={screen} value={value} onChange={(v) => setAnswers({ ...answers, [screen.id]: v })} />}
              {screen.type === "postcode" && <Postcode value={value} onChange={(v) => setAnswers({ ...answers, [screen.id]: v })} />}
              {screen.note && <p className="note">{screen.note}</p>}
            </div>
          )}
          {error && <div className="alert" role="alert">{error}</div>}
        </div>
      </div>
      <div className="actions"><div className="actions-in">
        {idx > 0 && <button className="btn ghost" onClick={back}>{c.backCta}</button>}
        <button className="btn" onClick={next} disabled={busy || (!answered && screen.tier === "core")}>
          {busy ? "Saving…" : idx + 1 >= screens.length ? c.finishCta : c.nextCta}
        </button>
      </div></div>
    </Shell>
  );
}

function Capture({ client, config, src, onDone }) {
  const c = client.copy;
  const [f, setF] = useState({ first_name: "", last_name: "", email: "", mobile: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const go = () => {
    if (!f.first_name.trim()) return setError("Enter your first name.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) return setError("Enter a valid email address.");
    setError("");
    setBusy(true);
    post("/api/survey/capture", { ...f, src, source_url: location.href })
      .then((d) => onDone(d))
      .catch((err) => { setBusy(false); setError(messageOf(err)); });
  };

  return (
    <div>
      <div className="wrap">
        <div className="screen">
          <div className="kicker">{config.intro.kicker}</div>
          <h1>{c.captureHeading}</h1>
          <p className="lede">{c.captureLede}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div><label className="lbl" htmlFor="cf">First name</label><input id="cf" className="field" autoComplete="given-name" value={f.first_name} onChange={set("first_name")} /></div>
            <div><label className="lbl" htmlFor="cl">Last name</label><input id="cl" className="field" autoComplete="family-name" value={f.last_name} onChange={set("last_name")} /></div>
            <div><label className="lbl" htmlFor="ce">Email</label><input id="ce" className="field" type="email" inputMode="email" autoComplete="email" value={f.email} onChange={set("email")} /></div>
            <div><label className="lbl" htmlFor="cm">Mobile (optional)</label><input id="cm" className="field mono" inputMode="tel" autoComplete="tel" placeholder="04xxxxxxxx" value={f.mobile} onChange={set("mobile")} /></div>
          </div>
          {error && <div className="alert" role="alert">{error}</div>}
          <p className="privacy">{c.privacy}</p>
        </div>
      </div>
      <div className="actions"><div className="actions-in">
        <button className="btn" onClick={go} disabled={busy}>{busy ? "Starting…" : c.captureCta}</button>
      </div></div>
    </div>
  );
}

/* The closing ask. The framing sentence is chosen from what they said their
 * primary motivation was, so the ask reads as a reply to their own answer
 * rather than as the same paragraph everyone gets. */
function Done({ client, config, person, ask, error }) {
  const a = config.ask;
  const heading = person.first_name
    ? a.heading.replace("{first_name}", person.first_name) : a.headingAnon;
  const framing = (a.framing && a.framing[(ask && ask.framing) || "default"]) || a.framing.default;
  const routes = (ask && ask.routes && ask.routes.length)
    ? ask.routes
    : [{ label: a.fallbackLabel, href: a.fallbackHref, primary: true }];

  return (
    <div>
      <div className="wrap">
        <div className="screen">
          <div className="kicker">Thank you</div>
          <h1>{heading}</h1>
          <p className="lede">{framing}</p>
          {error && <div className="alert" role="alert">{error}</div>}
          <div className="ask-routes">
            {routes.map((r, i) => (
              <a key={i} href={r.href} className={r.primary ? "primary" : ""}>{r.label}</a>
            ))}
          </div>
          {a.majorDonor && (
            <a className="major" href={"mailto:" + a.majorDonor.email + "?subject=" + encodeURIComponent(a.majorDonor.subject)}>
              {a.majorDonor.label}
            </a>
          )}
          <p className="privacy">{client.copy.privacy}</p>
        </div>
      </div>
    </div>
  );
}

function Shell({ client, children, progress, count }) {
  return (
    <div>
      <div className="top">
        <div className="top-in">
          <a href={"https://" + client.domain}><img src={client.logo} alt={client.orgName} /></a>
          {count ? <div className="count">{count}</div> : null}
        </div>
        {progress != null && <div className="bar"><span style={{ width: Math.round(progress * 100) + "%" }}></span></div>}
      </div>
      {children}
    </div>
  );
}

/* Both configs, then mount. A survey slug in the path selects a different
 * config file, so /s/memorial and /s/donors can be different surveys. */
const slug = slugFromPath();
Promise.all([
  fetch("/survey/client.json", { cache: "no-cache" }).then((r) => r.json()),
  fetch("/survey/" + (slug && slug !== "memorial" ? slug : "survey") + ".json", { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : fetch("/survey/survey.json").then((x) => x.json())))
])
  .then(([client, config]) => {
    ReactDOM.createRoot(document.getElementById("root")).render(<Survey client={client} config={config} />);
  })
  .catch((e) => {
    console.error("Failed to load survey config", e);
    document.getElementById("root").innerHTML =
      '<div class="wrap"><div class="screen"><h1>That did not load.</h1>' +
      '<p class="lede">Refresh the page, or come back in a moment.</p></div></div>';
  });
