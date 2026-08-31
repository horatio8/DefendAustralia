// GET/POST /api/sms-queue — send what is due.
//
// Kicked from the tail of the lapse sweep and opportunistically by traffic on
// the signature counter, and since the welcome text was added, also on a
// minute cron. The opportunistic kicks are what keep the queue moving during a
// surge, but they are not a delivery guarantee: they only fire when somebody
// happens to load a page. That was fine when everything in here was a
// follow-up hours after the fact, and is not fine for a text that says
// "thanks for signing" — at three in the morning, with no traffic, it would
// have sat until dawn. A bearer call drains it by hand.
//
// A message is claimed before it is sent and the row is written before the
// provider is called, so a crash mid-send leaves a row that reads Sent with no
// provider id rather than a message that goes twice. Sending twice is the
// worse failure: the supporter cannot unsee it.
const h = require("./_lib/http");
const at = require("./_lib/airtable");
const sms = require("./_lib/sms");

const SLICE = 20;
const TIME_BUDGET_MS = 40000;
// Twelve hours. Long enough to ride out an overnight quiet-hours hold plus a
// provider outage, short enough that nothing arrives on a different day from
// the thing it is about.
const STALE_MS = 12 * 3600000;

module.exports = async function handler(req, res) {
  if (h.guard(req, res, "GET, POST")) return;
  if (!h.requireCron(req, res)) return;
  return res.status(200).json(await drain());
};

async function drain() {
  const out = { sent: 0, failed: 0, suppressed: 0 };
  if (!at.configured()) return { ...out, error: "airtable not configured" };
  if (!sms.configured()) return { ...out, error: "cellcast not configured" };

  // Paused. Nothing is read, claimed or modified, so the queue is exactly as
  // it was when sending resumes.
  if (sms.paused()) return { ...out, paused: true };

  // Quiet hours, checked here as well as at queue time.
  //
  // not_before holds a message that was queued overnight, but it is not the
  // only way a row becomes due at 3am: a send that fails is written back as
  // Queued with its original not_before already in the past, so it would
  // retry on the very next pass whatever the hour. That is the case this
  // catches. Nothing is claimed or modified — the rows stay exactly as they
  // are and go out after eight.
  if (!sms.withinSendingHours()) {
    return { ...out, deferred: true, until: new Date(sms.nextSendableTime()).toISOString() };
  }

  const started = Date.now();
  let rows = [];
  try {
    rows = await due(SLICE);
  } catch (err) {
    console.error("SMS_DRAIN_READ_FAIL", err.message);
    return { ...out, error: String(err.message || err) };
  }

  for (const row of rows) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    const f = row.fields;

    /* Too old to send.
     *
     * A row can sit long past its time for reasons that have nothing to do
     * with the supporter: a pause, a provider outage, a key that lapsed over
     * a weekend. Sending it on the far side of that is worse than not
     * sending it. "Thanks for signing" three days after somebody signed
     * reads as a campaign that has lost track of itself, and it arrives with
     * an ask for money attached.
     *
     * Suppressed rather than deleted, so the row still shows what was meant
     * to go and why it did not. */
    const due = Date.parse(f.not_before || f.created_at || "") || 0;
    if (due && Date.now() - due > STALE_MS) {
      await at.update(at.T.smsSends, row.id, {
        status: "Suppressed",
        error: "too old to send, queued " + Math.round((Date.now() - due) / 3600000) + "h ago"
      }).catch(() => {});
      out.suppressed++;
      continue;
    }

    // Opt-out check two of two. Someone can reply STOP in the hours between
    // a message being queued and being due, and often does.
    if (await sms.optedOut(f.phone)) {
      await at.update(at.T.smsSends, row.id, { status: "Suppressed", error: "opted out before send" }).catch(() => {});
      out.suppressed++;
      continue;
    }

    // Claimed first. If this instance dies mid-send the row reads Sent with no
    // provider id, which a human can investigate. The alternative is a row
    // still marked Queued and a message already delivered, which the next pass
    // would deliver again.
    try {
      await at.update(at.T.smsSends, row.id, {
        status: "Sent", attempts: Number(f.attempts || 0) + 1, sent_at: at.nowIso()
      });
    } catch (err) {
      out.failed++;
      continue;
    }

    try {
      const providerId = await sms.send(f.phone, f.message);
      await at.update(at.T.smsSends, row.id, { provider_id: String(providerId || "") }).catch(() => {});
      out.sent++;
    } catch (err) {
      out.failed++;
      const status = Number(err && err.status) || 0;

      /* Never requeued once the provider has been called.
       *
       * The row was claimed as Sent before the call, and it stays Sent. That
       * looks wrong until you know what Cellcast does: it delivers the
       * message and then answers 500 when its own storage fails. A live trial
       * on 31 Aug got two 500s and two texts on the handset. Requeueing on
       * that error is how one supporter receives the same message every
       * minute until the attempt cap runs out.
       *
       * A 4xx is different in cause and identical in treatment. "Your sender
       * id is not registered" is a configuration fault: the next attempt
       * returns the same answer, so retrying only burns the queue. It is
       * marked Failed so it shows up as needing a human.
       *
       * Either way nothing is sent twice, which is the one outcome that
       * cannot be undone. A message that genuinely did not arrive is a lost
       * donation; a message that arrived four times is a lost supporter and a
       * complaint to the ACMA. */
      const configFault = status >= 400 && status < 500;
      await at.update(at.T.smsSends, row.id, {
        status: configFault ? "Failed" : "Sent",
        error: (configFault ? "" : "possibly delivered: ") +
          String(err.message || err).slice(0, 230)
      }).catch(() => {});
    }
  }

  out.remaining = rows.length >= SLICE ? "more" : "none";
  return out;
}

async function due(limit) {
  const now = at.nowIso();
  const formula = "AND({status}='Queued',OR({not_before}=BLANK(),IS_BEFORE({not_before},'" + now + "')))";
  const res = await at.call("GET", at.T.smsSends,
    "filterByFormula=" + encodeURIComponent(formula) +
    "&maxRecords=" + limit +
    "&sort%5B0%5D%5Bfield%5D=not_before&sort%5B0%5D%5Bdirection%5D=asc");
  return (res && res.records) || [];
}

// Exported so the lapse sweep and the counter can kick it without an HTTP hop.
module.exports.drain = drain;
