# Defend Sacred Ground — Campaign Site

Static-first advocacy campaign site, implemented from the Claude Design handoff
(`Defend Sacred Ground - Campaign Site.dc.html`) and structured per the bundled
campaign platform specification.

## Architecture

- **Static-first frontend, no build step.** Every page is a plain HTML shell that
  mounts one shared React app via `<div id="root" data-page="…">`. React 18 UMD +
  Babel Standalone are loaded from CDN; `js/app.jsx` is compiled in the browser.
- **Content-driven.** Nearly all copy, nav, demands, stats, timeline, donation
  tiers, and page content live in `content/site.json`. Edit copy without touching
  components — no campaign literals live in `js/app.jsx`.
- **Backend-optional.** All `/api/*` calls (signature count, petition signup,
  partial-capture beacons, email capture, AI rewrite, checkout, share events,
  broken-link reports, YouTube feed) are best-effort: the site is fully usable
  as a static deploy and picks up live behaviour as endpoints ship.

## Pages

| Path | File | `data-page` |
|---|---|---|
| `/` | `index.html` | `home` |
| `/take-action/defend-sacred-ground` | `take-action/defend-sacred-ground.html` | `petition` |
| `/minister` | `minister.html` | `minister` (email-pressure page) |
| `/donate` | `donate.html` | `donate` |
| `/share` | `share.html` | `share` |
| `/news` | `news.html` | `news` |
| `/the-issue` | `the-issue.html` | `issue` |
| `/about-us` | `about-us.html` | `about` |
| `/volunteer` | `volunteer.html` | `volunteer` |
| `/contact` | `contact.html` | `contact` |
| any unmatched URL | `404.html` | self-contained real 404 |

Vanity redirects (302, repointable) live in `vercel.json`: `/petition`,
`/take-action`, `/demand`, `/about`, `/issue`, and friends.

## Contracts kept (spec §14)

- Hash-target element ids: `#sign` (petition form), `#ff-email-form` (minister),
  `#signup` (volunteer), `#donate`, `#home-sign`, and `#root[data-page]`.
- Hash deep links on JS-rendered pages retry until mounted, scroll instantly,
  re-align until document height is stable, and cancel on user interaction.
- mailto rules: single recipient in To, correspondence copy via `cc`,
  URL-encoded subject/body, ~1900-char counter (ok/warn/over), supporter
  name+email appended after the sign-off, Gmail/Outlook webmail fallbacks and
  copy buttons on the success state.
- 404 is a real 404: broken-link report bar (path rendered as a text node),
  15 s `location.replace` auto-forward with cancel-on-any-interaction, `noindex`.
- Buttons with campaign-length labels wrap (`white-space:normal`).
- Honeypot fields on all public forms; bot fills are silently accepted.

## Config to set at launch

In `content/site.json`:

- `minister.toEmail` — the Minister's real correspondence address (mailto stays
  disabled until set; copy/webmail fallbacks still work).
- `news.youtubeChannelId` — enables the live video feed via `/api/youtube`.
- `news.socials[].url` — real profile URLs.
- `org.signatureFallbackCount` — baseline shown until `/api/signature-count` is live.
- Director portraits on About us: swap each placeholder slot for an `<img>`.

In each HTML shell: inject the Meta Pixel snippet where marked.

## CRM receiver (Campaign Nucleus)

Petition signups sync to Campaign Nucleus (account `teller`):

- **Form:** "Defend Sacred Ground: Petition to Kim Beazley" — slug `dsg-beazley`,
  id `0ea069ec-0257-4b7c-81c3-a8e6cc3a0f28`, group "Defend Sacred Ground"
- **Fields:** first_name*, last_name*, email* (unique), postcode, phone (all
  matching the site's petition form)
- **Receiver endpoint** (for `CN_RECEIVER_URLS` in the backend env, spec §9):
  `POST https://api.campaignnucleus.com/v1/forms/0ea069ec-0257-4b7c-81c3-a8e6cc3a0f28/entries`
  mapped as `{"defend-sacred-ground": "<that URL>"}`
- **Hosted fallback page:** https://teller.nucleuspages.com/landing/dsg-beazley
  (branded in campaign colours; redirects to /donate after signing; admin
  notifications to james@teller.consulting)

## Not yet implemented (backend, spec §5–§12)

Serverless `/api/*` endpoints, Airtable datastore, Campaign Nucleus sync,
Stripe checkout + webhooks, Cellcast SMS, Meta CAPI, AI rewrite service,
survey sub-app, webinar system, and cron jobs. The frontend already calls the
agreed endpoint paths with the agreed payloads, so these can land without
frontend changes.

## Local preview

```
npx serve .        # or: python3 -m http.server
```

Then open http://localhost:3000 (clean URLs need `serve`/Vercel; with the
Python server use the `.html` paths).
