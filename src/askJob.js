'use strict';

// "/ask <question>": Basecamp works out which role owns the answer and, in shadow mode,
// sends the question to the shadow reviewer (Blake) labeled with that role, never to the
// role itself. Basecamp never answers the question. Each routing is recorded in the
// database with its token counts and estimated cost; the question's text is never logged
// or stored there.

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
};

// What Blake sees in his direct message with Basecamp.
function reviewMessage({ role, reason, who, dealNumber, spaceUri, question }) {
  return [
    '*Routed question (shadow mode)*',
    `Would go to: ${role}`,
    `Why: ${reason}`,
    `Asked by ${who}${dealNumber ? ` in the deal ${dealNumber} space` : ' in a direct message'}${spaceUri ? `: ${spaceUri}` : ''}`,
    '',
    `Question: ${question}`,
  ].join('\n');
}

function createQuestionRouter({ anthropic, db, sendMessage, findDirectMessage, reviewerEmail, log, route = routeQuestion }) {
  // Returns the reply to post where the question was asked.
  return async function ask({ spaceName, isDirectMessage, userEmail, userDisplayName, text }) {
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
      if (!isDirectMessage) {
        const space = await db.getSpace(spaceName);
        const deal = space && space.status === 'ready' ? await db.getDeal(space.dealId) : null;
        if (deal && deal.spaceName === spaceName) {
          dealId = space.dealId;
          dealNumber = space.dealNumber;
          spaceUri = deal.spaceUri || null;
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
      const dm = await findDirectMessage(reviewer.userName);
      const who = userDisplayName ? `${userDisplayName} (${userEmail})` : userEmail;
      await sendMessage(dm, reviewMessage({ role: routed.role, reason: routed.reason, who, dealNumber, spaceUri, question }));

      // Blake has it by now; failing to record it must not say otherwise.
      await db
        .recordQuestion({ dealId, spaceName, askedBy: userEmail, role: routed.role, status: 'shadow', ...cost })
        .catch((e) => log('ERROR', 'could not record question', { dealNumber, error: errorFields(e) }));
      log('INFO', 'question routed', { dealNumber, role: routed.role, user: userEmail, chars: question.length, ...cost, ms: Date.now() - started });
      return SAY.routed(routed.role);
    } catch (err) {
      log('ERROR', isOutOfCredits(err) ? 'question failed: out of AI credits' : 'question failed', { dealNumber, step, error: errorFields(err), ms: Date.now() - started });
      return isOutOfCredits(err) ? SAY.noCredits : SAY.failed;
    }
  };
}

module.exports = { createQuestionRouter, reviewMessage, SAY, MAX_CHARS };
