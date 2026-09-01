/**
 * Meta Lead Ads → Google Sheet → Defend Sacred Ground.
 *
 * Paste this into the sheet's Apps Script editor and add a time-driven
 * trigger for syncLeads() at "Every minute". Free: it runs on Google's
 * quota inside your own account, and nothing else sits in the path.
 *
 * WHY POLLING AND NOT A TRIGGER
 * Meta's Sheets destination writes through the API, and onChange/onEdit
 * triggers do not fire for API writes. There is no event to hook, so the
 * only thing that works is asking the sheet, on a timer, what is new. One
 * minute is the shortest interval Apps Script offers, so one minute is as
 * close to real time as this gets without paying somebody.
 *
 * WHY IT POSTS TO THE SITE AND NOT STRAIGHT TO NUCLEUS
 * The site's endpoint writes the Nucleus entry itself, into the same
 * dsg-beazley form, and on the way does four things this script must not
 * try to do again by hand:
 *   - deduplicates on Meta's leadgen_id, so a re-run, a retry or a botched
 *     cursor cannot put the same person on a public counter twice
 *   - drops the test lead Meta plants in every new destination
 *   - strips Meta's l: f: ag: as: c: p: z: export prefixes
 *   - keeps the ad, ad set and campaign that produced each supporter
 * Posting at the Nucleus receiver directly gets the name in and nothing
 * else, and has no dedupe at all. If you ever do want that, the URL is in
 * RECEIVER_URL below and sendDirectToNucleus() uses it.
 */

// ── Configure ───────────────────────────────────────────────────────────────
var ENDPOINT   = 'https://www.defendsacredground.com/api/meta-lead-webhook';
var LEAD_TOKEN = '';   // must equal META_LEAD_SECRET in Vercel. Leave '' only while that is unset.
var SHEET_NAME = '';   // '' means the first sheet
/* Rows per request.
 *
 * Ten, not fifty. Every lead in a batch is processed one after another on the
 * server and each one costs an Airtable dedupe read, a Nucleus write and a
 * queue write — roughly a second. Fifty is a minute of work inside a function
 * that is not allowed to run that long, so the batch times out, the whole
 * request fails, and the script retries the same fifty next minute and times
 * out again. Ten finishes comfortably. */
var BATCH_SIZE = 10;

// Only used by sendDirectToNucleus(), which is the fallback, not the path.
var RECEIVER_URL = 'https://teller.campaignnucleus.com/forms/receiver/0ea069ec-0257-4b7c-81c3-a8e6cc3a0f28';

// ── The job ─────────────────────────────────────────────────────────────────
function syncLeads() {
  // One run at a time. A minute trigger plus a slow batch is how two copies
  // end up reading the same rows and sending them twice.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;

  try {
    var sheet = SHEET_NAME
      ? SpreadsheetApp.getActive().getSheetByName(SHEET_NAME)
      : SpreadsheetApp.getActive().getSheets()[0];
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    var props = PropertiesService.getScriptProperties();
    var cursor = Number(props.getProperty('lastRow') || 1);   // 1 = header only
    if (cursor >= lastRow) return;
    // The sheet was cleared or replaced under us. Start again rather than
    // reading from a row number that no longer means anything.
    if (cursor > lastRow) cursor = 1;

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0].map(function (h) { return String(h).trim().toLowerCase(); });

    var rows = sheet.getRange(cursor + 1, 1, lastRow - cursor, sheet.getLastColumn()).getValues();

    /* Each lead keeps the row it came from.
     *
     * Rows without an email are dropped, so the leads array is shorter than
     * the rows array and its indexes mean nothing back in the sheet. Carrying
     * the row number is what lets the cursor advance to a real position after
     * a run that only got partway. */
    var items = [];
    for (var r = 0; r < rows.length; r++) {
      var lead = toLead(headers, rows[r]);
      if (lead && lead.email) items.push({ row: cursor + 1 + r, lead: lead });
    }

    // Apps Script kills an execution at six minutes. Stopping at five leaves
    // room to finish the batch in hand and log what happened, rather than
    // being cut off mid-request with nothing written down.
    var deadline = Date.now() + 5 * 60 * 1000;
    var sent = 0, short = false, doneThrough = cursor;

    for (var i = 0; i < items.length; i += BATCH_SIZE) {
      if (Date.now() > deadline) { short = true; break; }
      var slice = items.slice(i, i + BATCH_SIZE);
      var res = post(slice.map(function (x) { return x.lead; }));

      // The server ran out of time inside this batch. It reports how many it
      // accepted but not which, so this batch is not credited: the next run
      // re-sends it and the dedupe absorbs the overlap.
      if (res && res.remaining > 0) { short = true; break; }

      sent += slice.length;
      doneThrough = slice[slice.length - 1].row;

      /* Saved every batch, not once at the end.
       *
       * Four thousand rows do not fit in one execution, and an all-or-nothing
       * cursor never advances at all: every run starts from row two, re-walks
       * everything it already did, and gets a little less far each time until
       * it cannot reach new rows inside the limit and stalls for good. Saving
       * here makes progress monotonic, and it survives Apps Script killing the
       * execution mid-loop. */
      props.setProperty('lastRow', String(doneThrough));
    }

    if (short) {
      Logger.log('partial: sent %s leads, now through row %s of %s', sent, doneThrough, lastRow);
      return;
    }

    props.setProperty('lastRow', String(lastRow));
    Logger.log('sent %s leads, rows %s to %s', items.length, cursor + 1, lastRow);
  } finally {
    lock.releaseLock();
  }
}

/* Columns are found by name, not position. Meta has changed the column
 * order of this export before, and a script that counts columns turns a
 * postcode into a phone number without ever failing. */
function toLead(headers, row) {
  function col(name) {
    var i = headers.indexOf(name);
    return i === -1 ? '' : String(row[i] == null ? '' : row[i]).trim();
  }
  var lead = {
    id: col('id'),
    created_time: col('created_time'),
    ad_id: col('ad_id'), ad_name: col('ad_name'),
    adset_id: col('adset_id'), adset_name: col('adset_name'),
    campaign_id: col('campaign_id'), campaign_name: col('campaign_name'),
    form_id: col('form_id'), form_name: col('form_name'),
    platform: col('platform'),
    source: col('is_organic') === 'true' ? 'organic' : '',
    first_name: col('first_name'), last_name: col('last_name'),
    full_name: col('full_name'),
    email: col('email'),
    phone_number: col('phone_number'),
    post_code: col('post_code')
  };
  // The prefixes and the planted test lead are handled server side. Nothing
  // is cleaned here on purpose: two places that both tidy the same data are
  // two places that drift, and the server is the one that also sees the
  // leads arriving by webhook.
  return lead;
}

function post(leads) {
  if (!leads.length) return;
  var headers = { 'Content-Type': 'application/json' };
  if (LEAD_TOKEN) headers['x-lead-token'] = LEAD_TOKEN;

  var res = UrlFetchApp.fetch(ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify({ leads: leads }),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  if (code !== 200) {
    // Thrown, not logged and swallowed. The cursor only advances on a clean
    // run, so failing loudly here is what makes the next run retry.
    throw new Error('lead sync failed: HTTP ' + code + ' ' + res.getContentText().slice(0, 300));
  }
  try { return JSON.parse(res.getContentText()); } catch (e) { return null; }
}

// ── One-off helpers, run by hand from the editor ─────────────────────────────

/* Send every row in the sheet, not just the new ones. Safe to run: the
 * endpoint deduplicates on leadgen_id, so anything already recorded is
 * skipped rather than duplicated. This is how the backlog gets in. */
function backfillAll() {
  PropertiesService.getScriptProperties().deleteProperty('lastRow');
  syncLeads();
}

/* Where the cursor is now, without changing it. */
function showCursor() {
  Logger.log('lastRow = %s', PropertiesService.getScriptProperties().getProperty('lastRow'));
}

/* The opposite of backfillAll: treat everything currently in the sheet as
 * already handled, and sync only what arrives from here on.
 *
 * This is the one to run if the rows already sitting there were collected
 * under consent wording that has not been checked yet. Getting a name into
 * the CRM is not neutral — it is the list that later gets emailed. */
function skipBacklog() {
  var sheet = SHEET_NAME
    ? SpreadsheetApp.getActive().getSheetByName(SHEET_NAME)
    : SpreadsheetApp.getActive().getSheets()[0];
  var lastRow = sheet.getLastRow();
  PropertiesService.getScriptProperties().setProperty('lastRow', String(lastRow));
  Logger.log('cursor set to %s; the %s rows already in the sheet will not be sent', lastRow, lastRow - 1);
}

/* The fallback: post straight at the Nucleus form receiver.
 *
 * No deduplication, no attribution, no test-lead drop — the name goes in and
 * that is all. Here because it was asked for, and because if the site is ever
 * down for a long stretch this still gets signatures into the CRM. Point the
 * trigger at this instead of syncLeads only if you mean to lose the rest.
 */
function sendDirectToNucleus(lead) {
  var payload = {
    'First Name': String(lead.first_name || '').replace(/^[a-z]{1,2}:/, ''),
    'Last Name': String(lead.last_name || '').replace(/^[a-z]{1,2}:/, ''),
    'Email': String(lead.email || ''),
    'Postcode': String(lead.post_code || '').replace(/^z:/, ''),
    'Phone': String(lead.phone_number || '').replace(/^p:/, '')
  };
  var res = UrlFetchApp.fetch(RECEIVER_URL, {
    method: 'post',
    payload: payload,
    muteHttpExceptions: true,
    followRedirects: true
  });
  Logger.log('receiver responded %s', res.getResponseCode());
}
