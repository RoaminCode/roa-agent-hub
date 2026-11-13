'use strict';

// Commitment follow-ups (Blake, 2026-11-07; rules in docs/reference/deal-spaces-and-routing.md).
// When an answer to a routed question promises something ("I will have that tomorrow"),
// Basecamp notes the promise and checks in at its due time, not before. A promise with no
// time is due at 2 PM Mountain on the day it names. Before following up, Basecamp looks for
// the promise kept: a newer answer on the topic, the deal space's messages since, and
// HubSpot. Kept: nothing is sent, and what kept it is filed as the answer. Not found: one
// follow-up, Monday to Friday, 8 AM to 5 PM Mountain, then nothing more. In shadow mode the
// follow-up goes to the shadow reviewer (Blake), labeled with who it is for.
//
// Basecamp helps Team Members; it does not reprimand them. The follow-up is a teammate's
// check-in with a way to answer, never a callout. A promise not seen by its time is kept
// on record (who, deal, topic, when; never the words) for coaching.
//
// Two small AI calls read the language (agents/commitment.js): one when an answer comes in,
// one at the due time, and that one only when something was said or logged since. The
// times, business hours, and everything else are code. Logs never hold the promise's words.

const { errorFields } = require('./errors');
const { readPromise, checkKept } = require('./agents/commitment');
const { dueFor, nextOpen, isOpen } = require('./workHours');
const { whenLabel } = require('./remindJob');
const { createSinceReader } = require('./sinceThen');

// The furthest ahead a promise is tracked, as with reminders.
const MAX_AHEAD_MS = 60 * 24 * 60 * 60 * 1000;
// A check that keeps failing is tried this many times, then the follow-up goes out anyway:
// a check-in someone did not need costs less than a promise nobody followed.
const MAX_TRIES = 3;
// How much of what kept a promise is filed as the answer.
const ANSWER_CHARS = 1000;

const SAY = {
  noted: (when) => `I noted the promise in that answer and will check in ${when} if I don't see it done.`,
  followUp: ({ byName, dealNumber, topic, what, due }) =>
    [
      '*Commitment check-in (shadow mode)*',
      `Would go to: ${byName}`,
      [dealNumber ? `Deal ${dealNumber}` : null, topic ? `Topic: ${topic}` : null].filter(Boolean).join(' · '),
      '',
      `The promise: "${what}", due ${due}.`,
      "I looked for it in the deal space and HubSpot and didn't find it yet.",
      '',
      'If it is done, reply in this thread with the answer and I will post it where it was asked. If it needs more time, reply with the new time, so the person who asked knows.',
    ]
      .filter((line) => line !== null)
      .join('\n'),
};

const where = { space: 'in the deal space', hubspot: 'in HubSpot' };

// `db` is Basecamp's records (db.js). `qaNotes` keeps Q&A notes in HubSpot (hubspot/qaNotes.js).
// `loadContext({ store, dealNumber, rememberPick })` reads a deal's HubSpot record
// (hubspot/dealContext.js). `listSpaceMessages(spaceName, since)` reads a deal space's
// messages (chat/spaces.js); left out, the space is not checked. `aiOff()` says whether AI
// jobs are off right now (paused, or over the daily limit). `read` and `judge` are the two
// AI calls.
function createCommitments({ anthropic, db, qaNotes = null, loadContext = null, listSpaceMessages = null, findDirectMessage, sendMessage, reviewerEmail, aiOff = async () => false, log, read = readPromise, judge = checkKept, now = () => new Date() }) {
  // Called with each answer relayed to a routed question (askJob.js). A newer answer keeps
  // the promises still open on that question; then this answer is read for a promise of
  // its own. Returns a line telling the answerer when Basecamp will check in, or null.
  // Never throws: an answer already relayed must not look failed.
  async function noteAnswer({ question, answer, userEmail, answeredBy, dealNumber = null }) {
    try {
      const kept = await db.keepCommitmentsFor(question.id);
      if (kept) log('INFO', 'commitment kept', { dealNumber, question: question.id, keptBy: 'answer', count: kept });
      if (await aiOff()) {
        log('INFO', 'answer not read for a promise: AI jobs are off', { dealNumber, question: question.id });
        return null;
      }
      const at = now();
      const found = await read({ anthropic, answer, now: at, dealId: question.dealId || null });
      const cost = { costUsd: found.costUsd ?? null };
      if (!found.ok) {
        log('WARNING', 'answer not read for a promise', { dealNumber, question: question.id, reason: found.reason, ...cost });
        return null;
      }
      if (!found.promised) return null;
      const dueAt = dueFor({ day: found.day, time: found.time }, at);
      if (!dueAt || dueAt.getTime() - at.getTime() > MAX_AHEAD_MS) {
        log('INFO', 'promise not tracked: its time is past or too far ahead', { dealNumber, question: question.id, ...cost });
        return null;
      }
      const sendAt = nextOpen(dueAt);
      await db.addCommitment({ questionId: question.id, dealId: question.dealId || null, dealNumber, noteId: question.noteId || null, topic: question.topic || null, by: userEmail, byName: answeredBy, what: found.what, dueAt, sendAt });
      log('INFO', 'commitment noted', { dealNumber, question: question.id, by: userEmail, dueAt: dueAt.toISOString(), sendAt: sendAt.toISOString(), hadDay: Boolean(found.day), hadTime: Boolean(found.time), ...cost });
      return SAY.noted(whenLabel(sendAt, at));
    } catch (err) {
      log('ERROR', 'could not note a commitment', { dealNumber, question: question.id, error: errorFields(err) });
      return null;
    }
  }

  // Whether a newer answer came in on the promise's topic: any question filed in the same
  // Q&A note and answered after the promise was made.
  async function answeredSince(c) {
    if (!c.dealId || !c.noteId) return false;
    const questions = await db.listDealQuestions(c.dealId);
    return questions.some((q) => q.noteId === c.noteId && q.answeredAt && Date.parse(q.answeredAt) > Date.parse(c.promisedAt));
  }

  // What was said in the deal's space and logged in HubSpot since the promise, oldest
  // first. A source that can't be read is logged and left out; the check goes on with the rest.
  const readSince = createSinceReader({ db, loadContext, listSpaceMessages, log });
  const since = (c) => readSince({ dealId: c.dealId, dealNumber: c.dealNumber, from: new Date(c.promisedAt), forWhat: 'a commitment' });

  // What kept the promise, filed as the answer in the topic's Q&A note.
  async function fileAnswer(c, entry) {
    if (!c.noteId || !qaNotes) return false;
    const text = String(entry.text).length > ANSWER_CHARS ? `${String(entry.text).slice(0, ANSWER_CHARS)} [cut]` : String(entry.text);
    return qaNotes
      .addAnswer({ noteId: c.noteId, answer: text, answeredBy: `${entry.who || c.byName || 'a Team Member'}, ${where[entry.source]}, found by Basecamp`, at: new Date(entry.at) })
      .then(() => true)
      .catch((e) => (log('ERROR', 'could not file what kept a commitment', { dealNumber: c.dealNumber, error: errorFields(e) }), false));
  }

  // The one follow-up. Shadow mode: to the reviewer, in the thread of the routed question
  // when it still exists, so a reply there is read as the answer and posted where it was asked.
  async function followUp(c) {
    const reviewer = await db.getPerson(reviewerEmail);
    if (!reviewer) throw new Error('the shadow reviewer has no Chat id on record yet');
    const dm = await findDirectMessage(reviewer.userName);
    const q = await db.getQuestion(c.questionId);
    const thread = q && q.reviewerThread && q.reviewerThread.startsWith(`${dm}/threads/`) ? q.reviewerThread : null;
    const text = SAY.followUp({ byName: c.byName || c.by, dealNumber: c.dealNumber, topic: c.topic, what: c.what, due: whenLabel(new Date(c.dueAt), now()) });
    const sent = await sendMessage(dm, text, { threadName: thread });
    // Chat starts a new thread when the old one is gone; a reply there must still be the answer.
    if (q && sent && sent.threadName && sent.threadName !== q.reviewerThread) {
      await db.setReviewerThread({ id: q.id, reviewerThread: sent.threadName }).catch((e) => log('WARNING', 'could not record the follow-up thread', { question: q.id, error: errorFields(e) }));
    }
  }

  // Checks every promise whose time has come, each once. Returns how many follow-ups went
  // out. Called by the timer (server.js, POST /tasks/tick).
  async function due() {
    // Follow-ups go out in business hours only; outside them everything waits.
    if (!isOpen(now())) return 0;
    let sent = 0;
    for (const c of await db.dueCommitments()) {
      if (!(await db.claimCommitment(c.id))) continue;
      const fields = { dealNumber: c.dealNumber, question: c.questionId, by: c.by, topic: c.topic };
      try {
        if (await answeredSince(c)) {
          await db.finishCommitment(c.id, 'kept', { keptBy: 'answer' });
          log('INFO', 'commitment kept', { ...fields, keptBy: 'answer' });
          continue;
        }
        const entries = await since(c);
        if (entries.length) {
          // Reading them takes AI. While it is off the promise waits; it is not followed up blind.
          if (await aiOff()) {
            await db.releaseCommitment(c.id, { counts: false });
            log('INFO', 'commitment check waiting: AI jobs are off', fields);
            continue;
          }
          const verdict = await judge({ anthropic, promise: c.what, entries, dealId: c.dealId || null });
          if (!verdict.ok && (c.tries || 0) + 1 < MAX_TRIES) {
            await db.releaseCommitment(c.id);
            log('WARNING', 'commitment check failed, will try again', { ...fields, reason: verdict.reason });
            continue;
          }
          if (verdict.ok && verdict.kept) {
            const filed = await fileAnswer(c, verdict.entry);
            await db.finishCommitment(c.id, 'kept', { keptBy: verdict.entry.source });
            log('INFO', 'commitment kept', { ...fields, keptBy: verdict.entry.source, filed, entries: entries.length, costUsd: verdict.costUsd ?? null });
            continue;
          }
        }
        await followUp(c);
        await db.finishCommitment(c.id, 'followed_up');
        sent += 1;
        // The record for coaching: a promise not seen kept by its time. Never its words.
        log('INFO', 'commitment follow-up sent', { ...fields, dueAt: c.dueAt, entries: entries.length, lateBySeconds: Math.round((now().getTime() - Date.parse(c.sendAt)) / 1000) });
      } catch (err) {
        const tries = await db.releaseCommitment(c.id).catch(() => MAX_TRIES);
        if (tries >= MAX_TRIES) await db.finishCommitment(c.id, 'failed').catch(() => {});
        log('ERROR', tries >= MAX_TRIES ? 'commitment check gave up' : 'commitment check failed, will try again', { ...fields, tries, error: errorFields(err) });
      }
    }
    return sent;
  }

  return { noteAnswer, due };
}

module.exports = { createCommitments, SAY, MAX_AHEAD_MS, MAX_TRIES };
