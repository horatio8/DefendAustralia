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
| `/thank-you` | `thank-you.html` | `thankyou` (post-donation, noindex) |
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
- `org.signatureFallbackCount` — shown only for the moment before
  `/api/signature-count` answers. Keep it at the real Nucleus total (0 today),
  never a padded number: the displayed count has to match Nucleus exactly.
- `org.signatureGoalStep` — the goal ladder, 15,000 by default. The target is
  always the next unreached multiple, so it rolls over on its own.
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
- **Signature count:** `api/signature-count.js` reads the form's entry total
  from Nucleus (60 s cache) so the number on the site is the number in the CRM.
  Env: `CN_API_TOKEN`, `CN_PETITION_FORM_ID`
  (`0ea069ec-0257-4b7c-81c3-a8e6cc3a0f28`), optionally `CN_API_BASE` and
  `CN_ACCOUNT_SLUG` (`teller`). Until those are set the endpoint returns 503 and
  the site falls back to `org.signatureFallbackCount`.
- **Hosted fallback page:** https://teller.nucleuspages.com/landing/dsg-beazley
  (branded in campaign colours; redirects to /donate after signing; admin
  notifications to james@teller.consulting)

## Stripe (donations)

Live account: **Defend Australia** (`acct_1U2ufdCy6Gkrn2pI`).

Donations run on **Stripe Payment Links** so a donor reaches Stripe in one
click with the amount already set — the site never collects the amount.
Clicking any chip in the DonatePanel navigates straight to
`donate.stripe.com`. Links live in `content/site.json` under
`donate.stripeLinks` and can be swapped without touching code.

- Products: `prod_V3FawQKMSVc0q5` (one-off), `prod_V3FaRw3sHgMvAB` (monthly)
- 6 one-off + 6 monthly links ($35/$65/$135/$265/$550/$1500 AUD) plus a
  one-off "customer chooses what to pay" link ($5–$10,000)
- Every link carries `metadata.campaign = defend-sacred-ground`, a
  `DSG DONATION` statement-descriptor suffix, and redirects to `/thank-you`
- Payment methods are dynamic (dashboard-controlled), so PayPal / Apple Pay /
  Google Pay appear automatically once enabled in Dashboard settings

**Custom monthly amounts** are the one gap: Stripe Payment Links do not
support pay-what-you-want on recurring prices. In monthly mode the "Other
amount" control collects the amount and posts to `api/checkout.js`, which
creates a subscription Checkout Session. That path needs the env vars below;
every other amount works with no backend at all.

Env (Vercel):

- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SITE_URL`
- `CN_API_TOKEN`, optionally `CN_ACCOUNT_SLUG` (`teller`) and `CN_API_BASE`
- `AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID` (`appVVWhWpNfImwxH9`)
- Webhook endpoint `https://<domain>/api/stripe-webhook`, events
  `checkout.session.completed` and `invoice.paid`

### Dashboard steps that cannot be done over the API

1. **Logo** — Settings → Branding: upload `assets/stripe-logo.png` (900×239)
   and `assets/stripe-icon.png` (512×512). Colours, font (Inter) and square
   border style are already set via the API.
2. **PayPal** — Settings → Payment methods: turn on PayPal (card, Apple Pay
   and Google Pay are on by default). Apple Pay also needs the live domain
   registered once the site is deployed.
3. **Receipts** — Settings → Business → Customer emails: enable
   "Successful payments" (and, for monthly donors, the Billing email
   notifications).
4. **Public details** — Settings → Business: set the public business name,
   support email and statement descriptor so donors recognise the charge.

## Data pipeline

Every public form writes to two places. Campaign Nucleus is the system of
record for people; Airtable is the operational base, modelled on Farmers
Fightback: an append-only `Events` log with typed projections beside it.

Base **Defend Sacred Ground** (`appVVWhWpNfImwxH9`), tables:

| Table | What lands in it |
|---|---|
| `Contacts` | one row per person, matched on email then mobile |
| `Events` | append-only log, `dedup_key` makes webhook re-delivery a no-op |
| `Petition Signatures` | one row per signature, with `cn_synced` / `cn_error` |
| `Donations` | one row per charge, plus the `upsell_*` columns |
| `Form Submissions` | contact-us and volunteer messages |
| `Signups` | minister email-action session captures, upserted on `session_id` |
| `Lapse Queue` | started-but-unfinished forms, for one follow-up |
| `Site Stats` | key-value for numbers the site serves |

Endpoints: `petition-signup`, `event-log` (contact + volunteer), `capture`
(minister), `partial`, `share-issued`, `signature-count`, `donation-status`,
`stripe-webhook`. Shared clients live in `api/_lib/`.

Nucleus failures never cost a submission: the supporter always gets the
success state, and the failure is recorded on the Airtable row as `cn_error`
so a broken sync is visible in the base rather than silent. Filter any typed
table on `cn_synced` unchecked to find them.

### Campaign Nucleus forms (account `teller`, group "Defend Sacred Ground")

| Form | Slug | Id |
|---|---|---|
| Petition to Kim Beazley | `dsg-beazley` | `0ea069ec-0257-4b7c-81c3-a8e6cc3a0f28` |
| Contact | `dsg-contact` | `e3a6dff2-91d1-4a3a-87e6-259116d840d7` |
| Volunteer | `dsg-volunteer` | `b2efb75b-d4b1-48e8-b84d-5149e0aea4df` |

Three site fields have no column on their CN form, because the form builder
rejected them at creation. They are carried instead of dropped:

- contact `topic` is prefixed onto the message body
- volunteer `postcode` and `roles` ride on the CN profile as a note and tags

All three are always written in full to Airtable. If the columns are added to
CN later, drop the workarounds in `api/event-log.js` and pass them straight
through.

## Donations and the monthly upsell

All 13 payment links now redirect to
`/thank-you?session_id={CHECKOUT_SESSION_ID}` instead of `/share`.

1. `/thank-you` reads the session through `api/donation-status.js` and greets
   the donor by name with the amount they actually gave.
2. For a one-off gift it offers the monthly link for the largest preset at or
   below that amount, so the ask is never bigger than the gift already made.
   A monthly donor is never asked again.
3. `stripe-webhook` writes the Donation row with `upsell_outcome = Offered`.
4. When a monthly subscription starts for the same email within seven days,
   the earlier one-off row flips to `Accepted` and records the subscription id.

Conversion is therefore measured from money, not from clicks.

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
