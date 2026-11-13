'use strict';

// "/remind me <what> <when>": a reminder for the person asking, sent as a direct message
// from Basecamp at the time they asked for (Blake, 2026-11-07). In a deal space it is about
// that deal; in a direct message, a deal number in it ties it to that deal, as /ask does.
// The time is read by a small AI call and confirmed back. A person's own reminder comes at
// the exact time asked, even outside business hours. Reminders for someone else wait: in
// shadow mode those would be nudges, which go to Blake. Cloud Scheduler calls `due` every
// few minutes (server.js, POST /tasks/tick). Logs never hold what the reminder says.
//
// The card it arrives as can close it (Blake, 2026-11-13): Mark complete, Check if done,
// and Remind me again; see reminderCard. A reminder is the person's own, so their word that
// it is done is taken; Check if done is how Basecamp looks for itself.

const { errorFields, isOutOfCredits } = require('./errors');
const { parseReminder, fromUtah } = require('./agents/remindParse');
const { dealsNamedIn } = require('./hubspot/namedDeals');
const { checkDone } = require('./agents/commitment');
const { utahParts, addDays } = require('./workHours');
const { SAY: NOTE_SAY } = require('./spaceNotes');
const { primary, secondary, label } = require('./chat/style');

// The furthest ahead a reminder may be set.
const MAX_AHEAD_MS = 60 * 24 * 60 * 60 * 1000;
const TIME_ZONE = 'America/Denver';
// How many timer runs try to send a reminder before it is given up on.
const MAX_TRIES = 3;
// The most of a reminder's words, and of what the person found, taken back from its card.
const MAX_WHAT = 500;
const MAX_FOUND = 1000;
// How much of the entry that shows a reminder done is quoted back.
const QUOTE_CHARS = 300;
// What Check if done can and cannot see, said every time it finds nothing.
const LIMIT = 'I can only see the deal space and HubSpot, not work done in the shop.';

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
  checkNoCredits: "I couldn't check that: Basecamp's AI credits have run out.",
  // From the reminder card's buttons.
  gone: "I couldn't find that reminder, so nothing changed.",
  alreadyClosed: 'That reminder was already closed.',
  closeFailed: "I couldn't do that just now. Nothing changed; Blake can see what happened in the logs.",
  completed: (what, dealNumber, noted) => `Marked complete${dealNumber ? ` (deal ${dealNumber})` : ''}: "${what}"${noted ? '\nSaved as a note in HubSpot.' : ''}`,
  again: (when, what, dealNumber) => `I'll remind you again ${when}${dealNumber ? ` about deal ${dealNumber}` : ''}: "${what}"`,
  checking: (n) => `Checking deal ${n}'s space and the Roamer's HubSpot record. It will be here in a moment.`,
  checkOff: "Checking if a reminder is done isn't switched on yet.",
  checkFailed: "I couldn't check that just now. Blake can see what happened in the logs.",
  nothingSince: (n, set) => `Nothing has been said in deal ${n}'s space or logged on the Roamer's HubSpot record since you set this reminder (${set}). ${LIMIT}`,
  notFound: (n, set, count) => `I read ${count} ${count === 1 ? 'entry' : 'entries'} from deal ${n}'s space and the Roamer's HubSpot record since you set this reminder (${set}) and didn't find it done. ${LIMIT}`,
  looksDone: (entry) =>
    `This looks done. ${entry.who || 'Someone'}, ${entry.source === 'space' ? 'in the deal space' : `in HubSpot (${entry.channel || 'entry'})`}, ${dayAndTime(entry.at)}:\n"${String(entry.text).slice(0, QUOTE_CHARS)}${String(entry.text).length > QUOTE_CHARS ? ' [cut]' : ''}"\nIf that is it, tap Mark complete on the reminder.`,
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

// The reminder as it arrives (Blake, 2026-11-13). Its words ride on each button, because
// Basecamp's own record clears them once the reminder is sent.
// - Mark complete: the person's own word that it is done. On a deal it saves a HubSpot note
//   saying so, with what they typed in "What did you find?" when they typed anything.
// - Check if done (a deal only): looks in the deal space and the Roamer's HubSpot record
//   since the reminder was set (one short AI call when there is anything to read).
// - Remind me again: in 1 hour, or tomorrow at 9 AM. No AI.
// - On a deal: its facts from LightSpeed, a /text draft that starts with the reminder's
//   words, and the deal's space.
function reminderCard({ id, what, dealNumber, spaceUri, endpoint }) {
  const tap = (action, extra = []) => ({ action: { function: endpoint, parameters: [{ key: 'action', value: action }, { key: 'id', value: String(id) }, ...extra, { key: 'm', value: what }] } });
  const first = [{ textParagraph: { text: escapeHtml(what) } }];
  if (dealNumber) first.push({ textInput: { name: 'found', label: 'What did you find? (optional, saved to HubSpot)', type: 'MULTIPLE_LINE' } });
  first.push({ buttonList: { buttons: [primary('Mark complete', tap('remindDone')), ...(dealNumber ? [secondary('Check if done', tap('remindCheck'))] : [])] } });
  const sections = [
    { widgets: first },
    { header: label('Remind me again'), widgets: [{ buttonList: { buttons: [secondary('In 1 hour', tap('remindAgain', [{ key: 'w', value: 'hour' }])), secondary('Tomorrow at 9 AM', tap('remindAgain', [{ key: 'w', value: 'tomorrow' }]))] } }] },
  ];
  if (dealNumber) {
    const n = { key: 'n', value: String(dealNumber) };
    const buttons = [
      secondary('Deal facts', { action: { function: endpoint, parameters: [{ key: 'action', value: 'remindFacts' }, n] } }),
      secondary('Draft a text', { action: { function: endpoint, parameters: [{ key: 'action', value: 'remindText' }, n, { key: 'm', value: what }] } }),
    ];
    if (spaceUri) buttons.push(secondary('Open space', { openLink: { url: spaceUri } }));
    sections.push({ header: label('On this deal'), widgets: [{ buttonList: { buttons } }] });
  }
  return {
    fallbackText: `Reminder: ${what}`,
    cardsV2: [{ cardId: `reminder-${id}`, card: { header: { title: 'Reminder', ...(dealNumber ? { subtitle: `Deal ${dealNumber}` } : {}) }, sections } }],
  };
}

// The reminder's words as they come back from a button, and what the person typed.
const wordsOf = (text, max) => String(text || '').trim().slice(0, max);
const dayAndTime = (at) => new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(at));

// `findDealSpace` looks a deal up in HubSpot (hubspot/dealContext.js); `findDirectMessage`
// and `sendMessage` are the Chat sender's; `endpoint` is Basecamp's own URL, for buttons.
// `saveNote` is spaceNotes.js's saver, for Mark complete on a deal; left out, completing a
// reminder is recorded in Basecamp only. `readSince` is sinceThen.js's reader and `judge`
// the AI check, for Check if done; without `readSince` that button says it is off.
function createReminders({ anthropic, db, findDealSpace, findDirectMessage, sendMessage, log, endpoint = '', saveNote = null, readSince = null, judge = checkDone, parse = parseReminder, now = () => new Date() }) {
  // The sent reminder a button belongs to, when it is this person's own; else null.
  async function mine(id, userEmail) {
    const r = await db.getReminder(id);
    return r && r.status === 'sent' && r.userEmail === userEmail ? r : null;
  }

  // Mark complete. Returns { done, text }: `done` means the card may be replaced by `text`;
  // otherwise `text` is posted under it and the card stays, to try again.
  async function complete({ id, what, found, spaceName, userEmail, userDisplayName }) {
    const words = wordsOf(what, MAX_WHAT);
    const detail = wordsOf(found, MAX_FOUND);
    let dealNumber = null;
    try {
      const r = await mine(id, userEmail);
      if (!r || !words) return { done: false, text: SAY.gone };
      dealNumber = r.dealNumber || null;
      if (!(await db.closeReminder(r.id, 'complete'))) return { done: true, text: SAY.alreadyClosed };
      let noted = false;
      if (dealNumber && saveNote) {
        // The same path as a note typed in a direct message: on the deal's Delivery record
        // and its Roamer, signed with who and when. It is the person's word, and says so.
        const said = await saveNote({ spaceName, isDirectMessage: true, userEmail, userDisplayName, text: `${dealNumber} Reminder marked complete: ${words}${detail ? `\nWhat was found: ${detail}` : ''}` });
        noted = said === NOTE_SAY.saved(dealNumber, true) || said === NOTE_SAY.saved(dealNumber, false);
        if (!noted) {
          await db.reopenReminder(r.id);
          log('WARNING', 'reminder not completed: its note was not saved', { dealNumber, user: userEmail });
          return { done: false, text: `${said} The reminder is still open.` };
        }
      }
      log('INFO', 'reminder completed', { dealNumber, user: userEmail, noted, withDetail: Boolean(detail) });
      return { done: true, text: SAY.completed(words, dealNumber, noted) };
    } catch (err) {
      log('ERROR', 'reminder could not be completed', { dealNumber, error: errorFields(err) });
      return { done: false, text: SAY.closeFailed };
    }
  }

  // Remind me again: the same words, the same deal, in 1 hour or tomorrow at 9 AM in Utah.
  // No AI. Returns { done, text } as `complete` does.
  async function again({ id, what, which, userEmail }) {
    const words = wordsOf(what, MAX_WHAT);
    let dealNumber = null;
    try {
      const r = await mine(id, userEmail);
      if (!r || !words) return { done: false, text: SAY.gone };
      dealNumber = r.dealNumber || null;
      const at = now();
      const dueAt = which === 'tomorrow' ? fromUtah(`${addDays(utahParts(at).day, 1)}T09:00`) : new Date(at.getTime() + 60 * 60 * 1000);
      if (!(await db.closeReminder(r.id, 'again'))) return { done: true, text: SAY.alreadyClosed };
      await db.addReminder({ userEmail, userName: r.userName, what: words, dueAt, dealId: r.dealId, dealNumber, spaceUri: r.spaceUri });
      log('INFO', 'reminder set again', { dealNumber, dueAt: dueAt.toISOString(), user: userEmail, which: which === 'tomorrow' ? 'tomorrow' : 'hour' });
      return { done: true, text: SAY.again(whenLabel(dueAt, at), words, dealNumber) };
    } catch (err) {
      log('ERROR', 'reminder could not be set again', { dealNumber, error: errorFields(err) });
      return { done: false, text: SAY.closeFailed };
    }
  }

  // Check if done: what was said in the deal space and logged on the Roamer's HubSpot record
  // since the reminder was set, read for the thing done or answered. Returns the reply. It
  // never marks the reminder complete; the person does, having seen what was found.
  async function check({ id, what, userEmail }) {
    const words = wordsOf(what, MAX_WHAT);
    let dealNumber = null;
    const started = Date.now();
    try {
      const r = await mine(id, userEmail);
      if (!r || !words) return SAY.gone;
      dealNumber = r.dealNumber || null;
      if (!dealNumber || !readSince) return SAY.checkOff;
      const set = dayAndTime(r.at);
      const entries = await readSince({ dealId: r.dealId, dealNumber, from: new Date(r.at), forWhat: 'a reminder' });
      if (!entries.length) {
        log('INFO', 'reminder checked', { dealNumber, user: userEmail, entries: 0, found: false, ms: Date.now() - started });
        return SAY.nothingSince(dealNumber, set);
      }
      const verdict = await judge({ anthropic, what: words, entries, dealId: r.dealId || null });
      if (!verdict.ok) {
        log('WARNING', 'reminder check failed', { dealNumber, user: userEmail, reason: verdict.reason });
        return SAY.checkFailed;
      }
      log('INFO', 'reminder checked', { dealNumber, user: userEmail, entries: entries.length, found: verdict.kept, foundIn: verdict.kept ? verdict.entry.source : null, costUsd: verdict.costUsd ?? null, ms: Date.now() - started });
      return verdict.kept ? SAY.looksDone(verdict.entry) : SAY.notFound(dealNumber, set, entries.length);
    } catch (err) {
      log('ERROR', 'reminder check failed', { dealNumber, error: errorFields(err) });
      return isOutOfCredits(err) ? SAY.checkNoCredits : SAY.checkFailed;
    }
  }

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

  return { remind, due, complete, again, check };
}

module.exports = { createReminders, reminderCard, whenLabel, SAY, MAX_AHEAD_MS, MAX_WHAT, MAX_FOUND };
