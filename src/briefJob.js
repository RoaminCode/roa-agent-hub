'use strict';

// Runs one Roamer brief in the background and posts the result to the space it was
// asked from. Logs timing and token usage, never Roamer details.

const { writeBrief } = require('./agents/roamerBrief');
const { renderBriefCard } = require('./chat/briefCard');

const SORRY = {
  notFound: (n, store) => `I couldn't find ${store} deal ${n} in HubSpot. Check the number and try again.`,
  duplicate: (n, store) => `HubSpot has more than one ${store} deal ${n}, so I can't tell which Roamer to read up on. Blake can sort out the duplicate.`,
  noContact: (n) => `Deal ${n} has no Roamer contact attached in HubSpot, so there's nothing to read yet.`,
  failed: (n) => `I couldn't finish the brief for deal ${n}. Blake can see what happened in the logs.`,
};

function createBriefJob({ loadContext, anthropic, sendMessage, log, avatarUrl }) {
  // `announce`, when given, is posted before any work so the user knows the brief is coming.
  return async function runBrief({ spaceName, dealNumber, store = 'UT', announce }) {
    const started = Date.now();
    try {
      if (announce) await sendMessage(spaceName, announce);
      const context = await loadContext({ store, dealNumber });
      if (context.duplicate) return await sendMessage(spaceName, SORRY.duplicate(dealNumber, store));
      if (!context.found) return await sendMessage(spaceName, SORRY.notFound(dealNumber, store));
      if (!context.contact) return await sendMessage(spaceName, SORRY.noContact(dealNumber));

      const result = await writeBrief({ anthropic, context });
      log('INFO', 'brief finished', {
        dealNumber,
        ok: result.ok,
        reason: result.reason || null,
        items: context.items.length,
        omitted: context.omitted,
        clipped: context.clipped,
        missing: context.missing,
        inputTokens: result.usage ? result.usage.input_tokens : null,
        outputTokens: result.usage ? result.usage.output_tokens : null,
        ms: Date.now() - started,
      });
      if (!result.ok) return await sendMessage(spaceName, SORRY.failed(dealNumber));
      await sendMessage(spaceName, renderBriefCard({ dealNumber, context, brief: result.brief, avatarUrl }));
    } catch (err) {
      log('ERROR', 'brief failed', { dealNumber, error: err.message, ms: Date.now() - started });
      await sendMessage(spaceName, SORRY.failed(dealNumber)).catch((e) =>
        log('ERROR', 'could not post brief failure', { dealNumber, error: e.message }),
      );
    }
  };
}

module.exports = { createBriefJob, SORRY };
