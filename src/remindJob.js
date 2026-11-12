'use strict';

// "/remind me <what> <when>": a reminder for the person asking, sent as a direct message
// from Basecamp at the time they asked for (Blake, 2026-11-07). In a deal space it is about
// that deal; in a direct message, a deal number in it ties it to that deal, as /ask does.
// The time is read by a small AI call and confirmed back. A person's own reminder comes at
// the exact time asked, even outside business hours. Reminders for someone else wait: in
// shadow mode those would be nudges, which go to Blake. Cloud Scheduler calls `due` every
// few minutes (server.js, POST /tasks/tick). Logs never hold what the reminder says.

const { errorFields, isOutOfCredits } = require('./errors');
const { parseReminder } = require('./agents/remindParse');
const { dealsNamedIn } = require('./hubspot/namedDeals');
const { primary, secondary } = require('./chat/style');

// The furthest ahead a reminder may be set.
const MAX_AHEAD_MS = 60 * 24 * 60 * 60 * 1000;
const TIME_ZONE = 'America/Denver';
// How many timer runs try to send a reminder before it is given up on.
const MAX_TRIES = 3;

const SAY = {
  empty: 'Say what and when, for example: /remind me let the Roamer know if we got that ordered within the hour',
  unclear: "I couldn't tell what to remind you of, or when. Try: /remind me call Pat about the hitch tomorrow at 10",
  selfOnly: "For now I can only set reminders for you. Say /remind me ..., and I'll send it to you.",
  past: 'That time has already passed. Try a time that is still ahead.',
  tooFar: 'I can set reminders up to 60 days ahead.',
  whichDeal: (numbers) => `That names more than one deal (${numbers.join(' and ')}). Set one reminder per deal.`,
  set: (when, what, dealNumber) => `Got it. I'll remind you ${when}${dealNumber ? ` about deal ${dealNumber}` : ''}: "${what}"`,
  failed: "I couldn't set that reminder. Blake can see what happened in the logs.",
  noCredits: "I couldn't set that reminder: Basecamp's AI credits have run out.",
};

// "today at 3:40 PM", "tomorrow at 9:00 AM", or "Mon, Nov 10 at 9:00 AM", in Utah time.
function whenLabel(dueAt, now) {
  const day = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' }).format(dueAt);
  if (day(dueAt) === day(now)) return `today at ${time}`;
  if (day(dueAt) === day(new Date(now.getTime() + 24 * 60 * 60 * 1000))) return `tomorrow at ${time}`;
  return `${new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric' }).format(dueAt)} at ${time}`;
}

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The reminder as it arrives: what to do, and, on a deal, a button that starts a /text
// draft with those words, and one into the deal's space.
function reminderCard({ id, what, dealNumber, spaceUri, endpoint }) {
  const buttons = [];
  if (dealNumber) {
    buttons.push(primary('Draft a text', { action: { function: endpoint, parameters: [{ key: 'action', value: 'remindText' }, { key: 'n', value: String(dealNumber) }, { key: 'm', value: what }] } }));
  }
  if (spaceUri) buttons.push(secondary('Open space', { openLink: { url: spaceUri } }));
  const widgets = [{ textParagraph: { text: escapeHtml(what) } }];
  if (buttons.length) widgets.push({ buttonList: { buttons } });
  return {
    fallbackText: `Reminder: ${what}`,
    cardsV2: [{ cardId: `reminder-${id}`, card: { header: { title: 'Reminder', ...(dealNumber ? { subtitle: `Deal ${dealNumber}` } : {}) }, sections: [{ widgets }] } }],
  };
}

// `findDealSpace` looks a deal up in HubSpot (hubspot/dealContext.js); `findDirectMessage`
// and `sendMessage` are the Chat sender's; `endpoint` is Basecamp's own URL, for buttons.
function createReminders({ anthropic, db, findDealSpace, findDirectMessage, sendMessage, log, endpoint = '', parse = parseReminder, now = () => new Date() }) {
  // Returns the reply to post where /remind was used.
  async function remind({ spaceName, isDirectMessage, userEmail, userName, text }) {
    const request = String(text || '').trim();
    if (!request) return SAY.empty;
    const started = Date.now();
    let dealId = null;
    let dealNumber = null;
    let spaceUri = null;
    try {
      if (!isDirectMessage) {
        const space = await db.getSpace(spaceName);
        const deal = space && space.status === 'ready' ? await db.getDeal(space.dealId) : null;
        if (deal && deal.spaceName === spaceName) {
          dealId = space.dealId;
          dealNumber = space.dealNumber;
          spaceUri = deal.spaceUri || null;
        }
      } else {
        const named = await dealsNamedIn(request, { findDealSpace, log });
        if (named.length > 1) return SAY.whichDeal(named.map((d) => d.dealNumber));
        if (named.length === 1) {
          dealId = String(named[0].deal.id);
          dealNumber = named[0].dealNumber;
          spaceUri = ((await db.getDeal(dealId)) || {}).spaceUri || null;
        }
      }

      const at = now();
      const read = await parse({ anthropic, text: request, now: at, dealId });
      const usage = read.usage || {};
      const cost = { inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null, costUsd: read.costUsd ?? null };
      if (!read.ok) {
        log('INFO', 'reminder not understood', { dealNumber, reason: read.reason, user: userEmail, ...cost });
        return SAY.unclear;
      }
      if (!read.forSelf) return SAY.selfOnly;
      if (read.dueAt.getTime() <= at.getTime()) return SAY.past;
      if (read.dueAt.getTime() - at.getTime() > MAX_AHEAD_MS) return SAY.tooFar;

      await db.addReminder({ userEmail, userName, what: read.what, dueAt: read.dueAt, dealId, dealNumber, spaceUri });
      log('INFO', 'reminder set', { dealNumber, dueAt: read.dueAt.toISOString(), user: userEmail, ...cost, ms: Date.now() - started });
      return SAY.set(whenLabel(read.dueAt, at), read.what, dealNumber);
    } catch (err) {
      log('ERROR', 'reminder failed', { dealNumber, error: errorFields(err) });
      return isOutOfCredits(err) ? SAY.noCredits : SAY.failed;
    }
  }

  // Sends every reminder now due, each once. Returns how many went out.
  async function due() {
    let sent = 0;
    for (const r of await db.dueReminders()) {
      if (!(await db.claimReminder(r.id))) continue;
      try {
        const dm = await findDirectMessage(r.userName);
        const lastTry = (r.tries || 0) >= MAX_TRIES - 1;
        await sendMessage(dm, lastTry ? `Reminder${r.dealNumber ? ` (deal ${r.dealNumber})` : ''}: ${r.what}` : reminderCard({ id: r.id, what: r.what, dealNumber: r.dealNumber, spaceUri: r.spaceUri, endpoint }));
        await db.finishReminder(r.id, 'sent');
        sent += 1;
        log('INFO', 'reminder sent', { dealNumber: r.dealNumber, user: r.userEmail, lateBySeconds: Math.round((now().getTime() - Date.parse(r.dueAt)) / 1000) });
      } catch (err) {
        // Its words are kept and it is tried again on the next timer runs. The last try is
        // plain text, in case the card was the problem; after that it is given up on.
        const tries = await db.retryReminder(r.id).catch(() => MAX_TRIES);
        if (tries >= MAX_TRIES) await db.finishReminder(r.id, 'failed').catch(() => {});
        log('ERROR', tries >= MAX_TRIES ? 'reminder could not be sent, gave up' : 'reminder could not be sent, will try again', { dealNumber: r.dealNumber, user: r.userEmail, tries, error: errorFields(err) });
      }
    }
    return sent;
  }

  return { remind, due };
}

module.exports = { createReminders, reminderCard, whenLabel, SAY, MAX_AHEAD_MS };
