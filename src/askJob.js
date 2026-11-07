'use strict';

// "/ask <question>": Basecamp works out which role owns the answer and, in shadow mode,
// sends the question to the shadow reviewer (Blake) labeled with that role, never to the
// role itself. Basecamp never answers the question. On a deal, the question is also kept
// in HubSpot as a "Basecamp Q&A" note on the deal and its Roamer, filed by topic.
//
// The answer loop: the reviewer replies in the thread under the routed question in their
// direct message with Basecamp; Basecamp posts the answer back in the thread where the
// question was asked, adds it to the Q&A note, and marks the question answered.
//
// Each routing is recorded in the database with its topic, token counts, and estimated
// cost. The question's and answers' text is never logged or stored there; it is in
// HubSpot and Chat only.

const { errorFields, isOutOfCredits } = require('./errors');
const { routeQuestion, UNSURE } = require('./agents/askRouter');

// A question, not a document.
const MAX_CHARS = 2000;

const SAY = {
  empty: 'Add the question after /ask, for example: /ask Has the title come in yet?',
  tooLong: `That question is over ${MAX_CHARS} characters. Ask it in shorter parts.`,
  routed: (role) =>
    role === UNSURE
      ? "Shadow mode: I couldn't tell who owns this one, so I sent it to Blake to route."
      : `Shadow mode: this would go to the ${role}. I sent it to Blake for now.`,
  noReviewer: "I couldn't reach Blake to route this. Nothing was sent; Blake can see what happened in the logs.",
  failed: "I couldn't route that question. Nothing was sent; Blake can see what happened in the logs.",
  noCredits: "I couldn't route that question: Basecamp's AI credits have run out. Nothing was sent.",
  // To the reviewer, after an answer.
  relayed: (dealNumber, saved) =>
    `Posted your answer where it was asked${dealNumber ? ` in the deal ${dealNumber} space` : ''}${saved ? ' and added it to the Q&A note in HubSpot' : ''}.`,
  relayFailed: "I couldn't post that answer where the question was asked. Blake can see what happened in the logs.",
};

// What Blake sees in his direct message with Basecamp.
function reviewMessage({ role, reason, topic, who, dealNumber, spaceUri, question }) {
  return [
    '*Routed question (shadow mode)*',
    `Would go to: ${role}`,
    `Why: ${reason}`,
    `Topic: ${topic}`,
    `Asked by ${who}${dealNumber ? ` in the deal ${dealNumber} space` : ' in a direct message'}${spaceUri ? `: ${spaceUri}` : ''}`,
    '',
    `Question: ${question}`,
    '',
    'Reply in this thread to answer; I will post it where it was asked.',
  ].join('\n');
}

const nameOf = (userDisplayName, userEmail) => userDisplayName || userEmail;

// `qaNotes` keeps questions and answers in HubSpot (hubspot/qaNotes.js); left out, they are
// only relayed, not kept.
function createQuestionRouter({ anthropic, db, sendMessage, findDirectMessage, reviewerEmail, log, qaNotes = null, route = routeQuestion, now = () => new Date() }) {
  // Returns the reply to post where the question was asked. `threadName` is the thread it
  // was asked in, where the answer will be posted.
  async function ask({ spaceName, threadName = null, isDirectMessage, userEmail, userDisplayName, text }) {
    const question = String(text || '').trim();
    if (!question) return SAY.empty;
    if (question.length > MAX_CHARS) return SAY.tooLong;
    const started = Date.now();
    let step = 'deal';
    let dealId = null;
    let dealNumber = null;
    try {
      // In a linked deal space, the question is about that deal.
      let spaceUri = null;
      let contactId = null;
      if (!isDirectMessage) {
        const space = await db.getSpace(spaceName);
        const deal = space && space.status === 'ready' ? await db.getDeal(space.dealId) : null;
        if (deal && deal.spaceName === spaceName) {
          dealId = space.dealId;
          dealNumber = space.dealNumber;
          spaceUri = deal.spaceUri || null;
          contactId = deal.contactId || null;
        }
      }

      step = 'route';
      const routed = await route({ anthropic, question });
      const usage = routed.usage || {};
      const cost = { model: routed.model || null, inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null, costUsd: routed.costUsd ?? null };
      if (!routed.ok) {
        log('WARNING', 'question not routed', { dealNumber, reason: routed.reason, ...cost });
        await db.recordQuestion({ dealId, spaceName, askedBy: userEmail, status: 'failed', ...cost });
        return SAY.failed;
      }

      step = 'reach reviewer';
      const reviewer = await db.getPerson(reviewerEmail);
      if (!reviewer) {
        log('ERROR', 'question not sent: shadow reviewer has no Chat id on record yet', { dealNumber });
        return SAY.noReviewer;
      }

      // On the record before anyone answers. A failed save is logged; routing goes on.
      let noteId = null;
      if (dealId && qaNotes) {
        noteId = await qaNotes
          .addQuestion({ dealId, contactId, topic: routed.topic, question, askedBy: nameOf(userDisplayName, userEmail), at: now() })
          .catch((e) => (log('ERROR', 'could not save question to HubSpot', { dealNumber, error: errorFields(e) }), null));
      }

      step = 'send to reviewer';
      const dm = await findDirectMessage(reviewer.userName);
      const who = userDisplayName ? `${userDisplayName} (${userEmail})` : userEmail;
      const sent = await sendMessage(dm, reviewMessage({ role: routed.role, reason: routed.reason, topic: routed.topic, who, dealNumber, spaceUri, question }));

      // Blake has it by now; failing to record it must not say otherwise.
      await db
        .recordQuestion({
          dealId,
          spaceName,
          originThread: threadName,
          reviewerThread: sent && sent.threadName,
          noteId,
          topic: routed.topic,
          askedBy: userEmail,
          role: routed.role,
          status: 'shadow',
          ...cost,
        })
        .catch((e) => log('ERROR', 'could not record question', { dealNumber, error: errorFields(e) }));
      log('INFO', 'question routed', { dealNumber, role: routed.role, topic: routed.topic, noteId, user: userEmail, chars: question.length, ...cost, ms: Date.now() - started });
      return SAY.routed(routed.role);
    } catch (err) {
      log('ERROR', isOutOfCredits(err) ? 'question failed: out of AI credits' : 'question failed', { dealNumber, step, error: errorFields(err), ms: Date.now() - started });
      return isOutOfCredits(err) ? SAY.noCredits : SAY.failed;
    }
  }

  // A reply in a direct message. When it is in the thread of a routed question, it is that
  // question's answer: posted back where it was asked, added to the Q&A note, and the
  // question marked answered. Returns the reply to the reviewer, or null when the message
  // is not an answer (it is then handled as any other message).
  async function relayAnswer({ threadName, userEmail, userDisplayName, text }) {
    const answer = String(text || '').trim();
    if (!threadName || !answer) return null;
    const q = await db.findQuestionByReviewerThread(threadName);
    if (!q) return null;
    const answeredBy = nameOf(userDisplayName, userEmail);
    const dealNumber = q.dealId ? (await db.getDeal(q.dealId) || {}).dealNumber || null : null;
    try {
      await sendMessage(q.spaceName, `*Answer from ${answeredBy}:* ${answer}`, { threadName: q.originThread });
    } catch (err) {
      log('ERROR', 'answer not relayed', { dealNumber, question: q.id, error: errorFields(err) });
      return SAY.relayFailed;
    }
    let saved = false;
    if (q.noteId && qaNotes) {
      saved = await qaNotes
        .addAnswer({ noteId: q.noteId, answer, answeredBy, at: now() })
        .then(() => true)
        .catch((e) => (log('ERROR', 'could not add answer to HubSpot', { dealNumber, question: q.id, error: errorFields(e) }), false));
    }
    const answers = (q.answers || 0) + 1;
    await db.markAnswered({ id: q.id, answeredBy: userEmail, answers }).catch((e) => log('ERROR', 'could not mark question answered', { question: q.id, error: errorFields(e) }));
    log('INFO', 'answer relayed', { dealNumber, question: q.id, role: q.role, topic: q.topic, answers, savedToHubSpot: saved, chars: answer.length });
    return SAY.relayed(dealNumber, saved);
  }

  return { ask, relayAnswer };
}

module.exports = { createQuestionRouter, reviewMessage, SAY, MAX_CHARS };
