'use strict';

// Runs one Roamer brief in the background and posts the result to the space it was
// asked from. Logs timing and token usage, never Roamer details.

const { writeBrief, renderBrief } = require('./agents/roamerBrief');

const SORRY = {
  notFound: (n, store) => `I couldn't find ${store} deal ${n} in HubSpot. Check the number and try again.`,
  noContact: (n) => `Deal ${n} has no Roamer contact attached in HubSpot, so there's nothing to read yet.`,
  failed: (n) => `I couldn't finish the brief for deal ${n}. Blake can see what happened in the logs.`,
};

function createBriefJob({ loadContext, anthropic, sendMessage, log }) {
  return async function runBrief({ spaceName, dealNumber, store = 'UT' }) {
    const started = Date.now();
    try {
      const context = await loadContext({ store, dealNumber });
      if (!context.found) return await sendMessage(spaceName, SORRY.notFound(dealNumber, store));
      if (!context.contact) return await sendMessage(spaceName, SORRY.noContact(dealNumber));

      const result = await writeBrief({ anthropic, context });
      log('INFO', 'brief finished', {
        dealNumber,
        ok: result.ok,
        reason: result.reason || null,
        items: context.items.length,
        omitted: context.omitted,
        inputTokens: result.usage ? result.usage.input_tokens : null,
        outputTokens: result.usage ? result.usage.output_tokens : null,
        ms: Date.now() - started,
      });
      if (!result.ok) return await sendMessage(spaceName, SORRY.failed(dealNumber));
      await sendMessage(spaceName, renderBrief({ dealNumber, context, brief: result.brief }));
    } catch (err) {
      log('ERROR', 'brief failed', { dealNumber, error: err.message, ms: Date.now() - started });
      await sendMessage(spaceName, SORRY.failed(dealNumber)).catch((e) =>
        log('ERROR', 'could not post brief failure', { dealNumber, error: e.message }),
      );
    }
  };
}

module.exports = { createBriefJob, SORRY };
