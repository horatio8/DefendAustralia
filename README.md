# Defend Sacred Ground — Campaign Site

Static-first advocacy campaign site, built from the Claude Design handoff and
the bundled campaign platform specification.

## Architecture

- **Static-first frontend, no build step.** Every page is a plain HTML shell
  that mounts one shared React app via `<div id="root" data-page="…">`. React 18
  UMD + Babel Standalone are vendored in `/vendor`; `js/app.jsx` is compiled in
  the browser. All asset URLs carry a `?v=<date>` cache-buster bumped on deploy.
- **Content-driven.** Nearly all copy, nav, petitions, demands, stats and
  donation tiers live in `content/site.json`, editable through the git-backed
  CMS at `/admin`. No campaign literals live in `js/app.jsx`.
- **Serverless backend.** One function per endpoint under `/api/*`. No server
  state; per-instance in-memory caches only, for rate limiting and throttles.
- **Two sub-apps.** `/survey` and the webinar page ship separately from the
  main bundle, because they are reached from CRM emails by people who may never
  have seen the site.

## Pages

| Path | File | `data-page` |
|---|---|---|
| `/` | `index.html` | `home` |
| `/take-action` | `take-action/index.html` | `takeaction` |
| `/take-action/<slug>` | `take-action/defend-sacred-ground.html` | `petition` |
| `/minister` | `minister.html` | `minister` |
| `/donate` | `donate.html` | `donate` |
| `/donate?signed=1` | same shell | post-signature ask, chromeless |
| `/share` | `share.html` | `share` |
| `/thank-you` | `thank-you.html` | `thankyou` (post-donation, noindex) |
| `/news` | `news.html` | `news` |
| `/the-issue` | `the-issue.html` | `issue` |
| `/about-us` | `about-us.html` | `about` |
| `/media` | `media.html` | `media` |
| `/won` | `won.html` | `won` (off until `won.enabled`) |
| `/volunteer` | `volunteer.html` | `volunteer` |
| `/contact` | `contact.html` | `contact` |
| `/supporters/<slug>` | `webinar.html` | `webinar`, chromeless |
| `/s/<slug>` | `survey/index.html` | standalone survey app |
| `/admin` | `admin/index.html` | Decap CMS |
| any unmatched URL | `404.html` | self-contained real 404 |

Vanity redirects (302, repointable) live in `vercel.json`. `/fund` and
`/fight` rewrite to the tracked-link endpoint; `/leaderboard` rewrites to the
API. `/take-action/:slug` falls through to the petition shell so an unknown
slug renders the in-app "not found" rather than a bare 404.

---

# Environment variables

Every variable, what breaks without it, and where to get it. `/api/env-check`
serves this same list live with each one's status, and `?live=1` makes one real
authenticated call per service — which is the only way to tell a variable that
is set and wrong from one that is right.

### Required. Without these the site is not operational.

| Variable | What it does | Where it comes from |
|---|---|---|
| `CN_API_TOKEN` | Every signature, and the counter on the site. Without it `/api/signature-count` 503s and nothing reaches the CRM. | Campaign Nucleus → account settings → API |
| `AIRTABLE_TOKEN` | Every table. Without it the queue, the drain and all reporting are dead. | airtable.com/create/tokens, scoped to the base with `data.records:read/write` and `schema.bases:read` |
| `AIRTABLE_BASE_ID` | Which base. `appVVWhWpNfImwxH9` for this campaign. | The base URL |
| `STRIPE_SECRET_KEY` | Custom monthly checkout, the thank-you page, share identity by session. **Must be live mode.** A `sk_test_` key authenticates and creates sessions, so every check passes, but it takes no money and cannot see the live session ids the Payment Links hand back. | Stripe → Developers → API keys (live `sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | Donation rows, the upsell close, the Purchase event to Meta. **Without it no donation is ever recorded.** | Stripe → Developers → Webhooks → the endpoint's signing secret |
| `ADMIN_BASIC_AUTH` | `user:password` for env-check, the leaderboard, the A/B report and the token exports. Unset makes all of them answer 404. | Pick one. Treat it as a password, because it is one |

### Strongly recommended.

| Variable | What it does | Notes |
|---|---|---|
| `SITE_URL` | Absolute URLs in Stripe returns. | `https://defendsacredground.com` |
| `SITE_DOMAIN` | CORS allowlist and generated links. | Defaults to `defendsacredground.com` |
| `CN_ACCOUNT_SLUG` | Which Nucleus account. | `teller` |
| `CRM_UID_FIELD` | Which CRM custom slot holds the survey token. | Defaults to `custom2`. **Nothing else in the codebase may write to it** |
| `META_PIXEL_ID` | Browser pixel and the CAPI destination. Without it every ad dollar is unmeasured. | Meta Events Manager |
| `META_CAPI_TOKEN` | Server-side events. Roughly a third of browser events never arrive without this half. | Events Manager → the dataset → Conversions API → generate token |
| `ANTHROPIC_API_KEY` | The "Say it my way" rewrite. | console.anthropic.com |
| `AI_REWRITE_DAILY_CAP` | Hard daily ceiling on rewrites. Unset falls back to **500 a day**, because the safe reading of "unset" on a public endpoint that spends money is not "unlimited". Set `0` to deliberately remove the ceiling. | A number, e.g. `500` |
| `IP_HASH_SALT` | Salts hashed IPs in rate limits and AI usage. Unset means the hash is a lookup table of every Australian IP. | Any long random string |
| `CRON_SECRET` | Bearer for manual cron runs. Vercel's own cron header always works regardless. | Any long random string |
| `WEBINAR_TOKEN_SECRET` | Signs briefing magic links. Unset means no private briefing can be opened at all. | Any long random string. **Changing it invalidates every link already emailed** |

### Optional, per feature.

**Campaign Nucleus.** `CN_API_BASE` (non-standard host), `CN_PETITION_FORM_ID`,
`CN_CONTACT_FORM_ID`, `CN_VOLUNTEER_FORM_ID` (override the built-in ids),
`CN_HOSTED_PETITION_URL` (fallback form offered when a signature cannot be
stored).

**Meta lead ads.** `META_LEAD_VERIFY_TOKEN` (Meta's subscription handshake on
`GET /api/meta-lead-webhook`; must match what is typed into Meta when the
webhook is subscribed), `META_LEAD_SECRET` (shared secret checked against the
`x-lead-token` header, for relays such as Zapier or Make that cannot sign the
way Meta's own webhook does; **without it the lead webhook is open**),
`META_LEAD_FORM_MAP` (JSON, `{"<form id>":"<petition slug>"}`, e.g.
`{"1047890598229609":"defend-sacred-ground"}`; an unmapped form still lands
under `DEFAULT_PETITION_SLUG` rather than being dropped),
`META_LEAD_PAGE_TOKEN` (page access token with `leads_retrieval`, for the
puller below), `META_TEST_EVENT_CODE` (routes events to Meta's test view;
**remove before a real flight**).

Leads are deduped on Meta's `leadgen_id`, so a redelivery cannot become a
second signature, and the endpoint always answers 200 because Meta retries hard
on anything else. Meta's own field prefixes (`l:` `f:` `ag:` `as:` `c:` `p:`
`z:`) are stripped on the way in, since a relay built on Meta's Google Sheets
destination forwards them intact and `z:5127` in a postcode field is a silent
corruption. The test lead Meta plants when a form is first connected is dropped
rather than becoming a signature. Meta's form builder offers "full name" as a
single question and it is the default, so a lead may arrive with no first or
last name at all; the whole name is split on the last space, which keeps
two-word given names intact.

Three routes reach this endpoint and it accepts all of them, so the choice is
operational rather than a code change:

1. **Meta's own webhook.** In the app's Webhooks product, subscribe the `page`
   object to the `leadgen` field with the callback URL below and
   `META_LEAD_VERIFY_TOKEN` as the verify token, then subscribe the Page. No
   third party sits in the path and the lead arrives in about a second. This
   is the route to prefer.
2. **A relay.** Zapier's *Facebook Lead Ads → Webhooks by Zapier (POST)*
   with `x-lead-token` set to `META_LEAD_SECRET`, body as JSON, fields mapped
   flat. Slower (Zapier polls on the plan's interval) and it costs a task per
   lead, but it needs no app review and it is how the sister campaign is
   wired, so it is the fallback when app review is the blocker.
3. **The Google Sheet, polled.** Meta's Sheets destination writes each lead
   into a spreadsheet; `tools/leads-to-nucleus.gs` reads it on a one-minute
   Apps Script trigger and posts new rows here as `{leads: [...]}`. Free, runs
   inside the campaign's own Google account, nothing in the path but Google
   and us. It **polls rather than hooking an event** because `onChange` and
   `onEdit` do not fire for API writes, which is exactly what Meta's export
   is — there is no event to hook, and one minute is the shortest interval
   Apps Script offers.

All three shapes are normalised by the same function and all three dedupe on
`leadgen_id`, so running them side by side during a cutover cannot double a
signature. The script's cursor advances only after a successful post, so a
failure means the next run re-sends the same rows, which is safe for exactly
that reason.

**Pulling, not just receiving.** `GET /api/meta-lead-pull` fetches leads from
the Graph API and runs them through the webhook's own `ingest`, so the two
paths cannot drift. It exists because a webhook only ever delivers what
happened after it was subscribed — Meta will not redeliver a `leadgen` event
that predates the subscription, so every lead collected before the wiring was
done is unreachable by push alone. It is also the safety net for a dropped
delivery, and runs hourly over a two-day window for exactly that.

Dry run unless `?apply=1`, like the Stripe backfill. `?days=` widens the
window (max 400) and `?form=` limits it to one form. Behind admin basic auth
or Vercel's cron header, and deliberately not behind `requireCron`, which
treats an unset `CRON_SECRET` as open — fine for the idempotent sweeps, wrong
for an endpoint that reads names, emails and phone numbers out of Meta. The
dry-run examples report whether a lead has an email, never the address.

Needs `META_LEAD_PAGE_TOKEN`: a page access token carrying `leads_retrieval`,
which is a different grant from the CAPI token. It falls back to
`META_CAPI_TOKEN` because on a small campaign they are often the same system
user, but the fallback usually lacks the permission and the Graph error says
so plainly.

**Campaign Nucleus automations.** `CN_AUTOMATION_PETITION_LAPSE_A` / `_B` and
`CN_AUTOMATION_DONATION_LAPSE_A` / `_B` are the two arms of each lapse test.
Nucleus has no create-automation endpoint, so these ids are copied out of the
Nucleus interface by hand; the API can only drop people into an automation that
already exists. Setting the unsuffixed `CN_AUTOMATION_PETITION_LAPSE` instead
runs the flow with no split. With none of them set the sweep still tags the
profile, so nobody is lost, but there is no A/B.

`CN_AUTOMATION_SIGNATURE_ASK` is the automation a new signatory is enrolled
into by `/api/petition-signup`, which sends the donation ask. It fires only on
a first signature: a duplicate is a second press of the button, and enrolling
again is how one person receives the same appeal twice in a minute. Unset, the
signature is recorded and nothing further is asked of that person.

**SMS.** `CELLCAST_API_KEY`, `CELLCAST_SENDER_ID`, `CELLCAST_API_BASE`,
`CELLCAST_WEBHOOK_SECRET` (without it the inbound endpoint accepts anything).

The client targets `https://api.cellcast.com/api/v1/gateway` with
`Authorization: Bearer`, and sends `message` / `contacts` / `sender`.
`CELLCAST_API_BASE` overrides the host for a legacy key that still answers on
the old one.

**The key and the number must belong to the same Cellcast account.** There
are two: the master (`james@teller.consulting`, dedicated number
`61494440870`, Farmers Fightback) and the DSG sub-client
(`flynn.private@icloud.com`, dedicated number `61494440874`). A sender id is
only "registered" from the account that owns it — the master key sending as
`…874` is rejected `400 "Your sender id is not registered."`, and that exact
mismatch failed every production send on 2 Sep. DSG runs on the sub-client:
`CELLCAST_API_KEY` is the sub-client's key (Dashboard → API, logged in as
`flynn.private@icloud.com`) and `CELLCAST_SENDER_ID` is `61494440874`.

The account also decides where replies land. The inbound poll and the opt-out
reads use the same key, so a STOP sent to a number lands only in the inbox of
the account that owns that number. Splitting key and number across accounts
means STOPs arrive where nothing is listening. Read the digits off
`GET /api/v1/apiClient/virtual-number/dedicated` with the key in use, not off
a dashboard that may be showing a different login.

A custom sender costs **1.3 credits per SMS** rather than 1. Numeric sender IDs
are max 16 digits, alphanumeric max 11 characters, and an alphanumeric one
cannot receive replies — which would leave STOP going nowhere, so the number
is the right choice.

**The opt-out is not automatic.** `replyStopToOptOut` is a per-request flag
that defaults to false, so a message sent without it carries no unsubscribe at
all. It is set explicitly on every send rather than left to an account default,
because an account default can be changed by anyone with a login and the Spam
Act obligation does not move with it.

**The sending switch.** `SMS_SENDING=off` pauses all outbound SMS without a
deploy, which is the switch to reach for in a hurry. Sending is on by default;
`SMS_SENDING=on` is explicit on.

Paused this way rather than by unsetting `CELLCAST_API_KEY`, because the key
is also what the inbound poll and the opt-out reads use — pulling it would
stop the campaign hearing a STOP, which is the one thing that has to keep
working while nothing is going out.

While paused nothing is even queued. Queueing through a pause builds a pile of
"thanks for signing" texts addressed to people who signed days ago, and every
one of them goes out the moment sending resumes. Backing that up, the drain
suppresses any row more than 12 hours past its due time: long enough to ride
out an overnight quiet-hours hold plus a provider outage, short enough that
nothing arrives on a different day from the thing it is about.

**Quiet hours.** Nothing is sent before 8am or after 8pm, Sydney time.
Enforced twice: `sms.queue` sets `not_before` to the next civil hour, and the
drain refuses to send outside the window whatever `not_before` says. The
second check is not redundant — a failed send is written back as `Queued`
with its `not_before` already in the past, so without it a retry would go out
at 3am. The zone is named, not an offset, because Sydney observes daylight
saving and a hardcoded `+10` sends an hour early for half the year.

Sydney rather than the supporter's own state, deliberately: we have a
postcode at best, and Sydney is the latest mainland clock, so holding to it
means a supporter in Perth is texted no earlier than 5am their time. Erring
the other way would let an 8am Sydney send land at 5am in Perth.

A new signature with a mobile number is queued a welcome text
(`petition_welcome`), sent within the minute by the `sms-queue` cron. It is
not A/B split: a welcome has nothing to test. Deduped twice — once on the
signature being new, once in the queue on phone plus template — so signing
from two devices, or signing again under a different email, still produces
one text. Opt-outs are checked when queueing and again immediately before
sending, because people reply STOP in between. Without `CELLCAST_API_KEY`
nothing is queued and the signature is unaffected.

The body is one segment even with a first name in front of it, which is a
cost decision rather than a style one: Cellcast bills per segment, so 161
characters is double the price of 160 on every signature the campaign takes.
The link carries no `https://` because handsets linkify a bare domain and
those eight characters buy a longer name instead. For the same reason it
carries no opt-out line of its own — Cellcast appends one — but it is signed,
because an unidentified number asking for money is a number people report.
STOP replies are honoured regardless, by the inbound poll and the two opt-out
checks in the queue.

The greeting is separate from the body so the body can stand alone. A first
name is used only if it reads as one: two characters or more, letters and
ordinary name punctuation, and short enough to leave the message inside one
segment. Anything else — missing, junk like `bmmarfleet@gmail`, or long
enough to spill — gets the unaddressed version rather than a message that
costs twice as much or opens with a fragment of somebody's email address.

The ask is money and the link is `/give`, which rewrites to the tracked
redirect and 302s on to `/donate`. It has its own slug rather than reusing
`/fund` so clicks from the welcome text stay separable from the lapse chases
and everything else that has ever used `/fund`: "how many people gave because
we texted them the moment they signed" is only a question with an answer if
the link is its own. `GET /api/link-report` counts them, with sends beside
them, because 300 clicks is excellent from 800 sends and dismal from 40,000.
Bots are excluded at the redirect already — iMessage, WhatsApp and Slack all
fetch a link the moment it appears in a message, and counting those roughly
doubles the figure.

It is held a random interval of up to five minutes rather than going out at
once. A text that lands the same second the form submits reads as a receipt,
and nobody believes a person typed it; random rather than fixed, because a
constant delay is a pattern anyone who signs twice will spot. The queue drains
on a minute cron, so in practice it lands one to six minutes out. Quiet hours
apply on top — the queue takes the later of the two — so a signature at 7.58pm
is not carried by the jitter into an 8.01pm send.

**Ticketing.** `RALLY_STRIPE_SECRET_KEY`, `RALLY_STRIPE_WEBHOOK_SECRET`
(without it no ticket is ever recorded), `RALLY_TICKET_PRICE_ID` or
`RALLY_TICKET_CENTS` (defaults to 2500).

**Other.** `ANTHROPIC_MODEL` (defaults to `claude-haiku-4-5-20251001`),
`DRAIN_KEY` (locks the manual drain), `SIGNATURE_GOAL_STEP` (defaults 15000),
`DEFAULT_PETITION_SLUG` (where an unmapped Meta lead lands).

### Webhooks to register

| Where | URL | Events |
|---|---|---|
| Stripe (donations) | `https://defendsacredground.com/api/stripe-webhook` | `checkout.session.completed`, `invoice.paid` |
| Stripe (tickets) | `https://defendsacredground.com/api/rally-webhook` | `checkout.session.completed` |
| Meta lead ads | `https://defendsacredground.com/api/meta-lead-webhook` | leadgen |
| Cellcast inbound | `https://defendsacredground.com/api/cellcast-inbound` | inbound SMS |

---

## API surface

**Public capture:** `petition-signup`, `capture`, `partial`, `event-log`,
`checkout`, `share-issued`, `share-click`, `share-context`, `share-signup`,
`signature-count`, `donation-status`, `youtube`, `track-redirect`,
`report-broken-link`, `rewrite`, `meta-capi`, `survey/{resolve,capture,answer,complete}`,
`webinar-{context,register,question}`, `rally-{checkout,claim}`.

**Webhooks:** `stripe-webhook`, `rally-webhook`, `cellcast-inbound`,
`meta-lead-webhook`.

**Admin (basic auth):** `env-check`, `leaderboard`, `ab-report`,
`stripe-backfill`, `lapse-reconcile`, `survey-uids`, `webinar-tokens`,
`meta-lead-pull`, `link-report`.

**Crons:** see below.

Every endpoint: CORS per the allowlist, `OPTIONS` 204, method guard, JSON
errors as `{error: "<a sentence a supporter can read>"}` — the frontend renders
that string directly, so it is written for a person and not for a log.

## Scheduled jobs

| Cron | Schedule | Work |
|---|---|---|
| `/api/drain` | every minute | Expand the Ingest Queue into the relational tables |
| `/api/lapse-sweep` | every 5 min | Enrol non-completers, close the ones who finished, tail-kick the SMS queue |
| `/api/sms-inbound-poll` | hourly | Pull inbound SMS, handle STOP |
| `/api/nightly-rollup` | daily 04:15 AEST | Referral rollup, A/B daily, full signature recount, milestone hook |
| `/api/survey-uid-topup` | daily 04:40 AEST | Survey tokens for contacts added since the last run |

`/api/sms-queue` has no schedule. It drains off `/api/signature-count`, the
busiest endpoint on the site, throttled to once per five minutes per warm
instance: during a surge it drains continuously off real traffic, and in the
quiet hours nothing runs.

## Data model

Base **Defend Sacred Ground** (`appVVWhWpNfImwxH9`), 21 tables.

Core: `Contacts`, `Events` (append-only, source of truth), `Petition Signatures`,
`Donations`, `Form Submissions`, `Signups`, `Lapse Queue`, `Site Stats`,
`Ingest Queue`.

Growth and measurement: `Referral Rollup`, `AB Daily`, `SMS Sends`,
`SMS Replies`, `AI Usage`, `Broken Links`.

Programmes: `Webinars`, `Registrations`, `Questions`, `Survey Contacts`,
`Survey Responses`, `Rally Tickets`.

## Things that are true about this codebase

Written down because each was learned the hard way and each is easy to undo by
accident.

**Campaign Nucleus is written first, always.** It is the system of record, the
site's counter reads from it, and it is the only place a signature has to be
for the campaign to have it. Airtable follows, as one queued row.

**Airtable allows five requests per second per base.** A signature used to cost
five. The request path now appends one queue row and `api/drain.js` expands it
afterwards, which is what lets 5,000 signatures in two minutes land without
losing anyone. Never add a direct Airtable write to a request path.

**Referral codes are derived from the email, uppercase, matched
case-insensitively.** Three implementations must agree exactly:
`api/_lib/refcode.js`, the twin in `js/app.jsx`, and nothing else. Changing the
algorithm changes every code already in circulation.

**The incoming `?ref=` is stored separately from the visitor's own code.**
Writing one over the other hands each visitor the sharer's identity and every
onward share then credits the wrong person.

**Vercel ignores `api/` files beginning with `_`,** which is why shared code
lives in `api/_lib/` and is still bundled through static imports. **Vercel
traces bundles from static imports only** — a lazy `require()` of a sibling
handler is not packaged and fails at runtime.

**React batches state updates,** so a `useState` guard against double submits
does not work. The submit latches use a `useRef`.

**Nothing but `survey-uids` and `survey-uid-topup` may write `CRM_UID_FIELD`.**
In the reference build a partial capture wrote a timestamp there and destroyed
every survey token in the account.

**Every API error is a sentence, not a code.** The frontend renders
`{error}` straight onto the page.

**A capture endpoint never echoes stored personal data.** Otherwise a write-only
form becomes an email lookup service.

## Local preview

```
python3 -m http.server 8000      # .html paths; no clean URLs, no API
npx serve .                      # clean URLs
```

The API needs `vercel dev` or a deployment. `python3 -m http.server` is
single-threaded and drops concurrent requests, which reads as a broken page:
use a threading server if you are testing anything real.

## Still to configure at launch

In `content/site.json`: `minister.toEmail` (the page tells supporters plainly
that it cannot open their mail app until this is set), `news.youtubeChannelId`,
`news.socials[].url`, `org.metaPixelId`, About us director portraits.

In Stripe's dashboard, none of which can be done over the API: upload the logo,
enable PayPal, register the Apple Pay domain, turn on customer receipts, and
set the public business details.
