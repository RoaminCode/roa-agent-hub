'use strict';

// Runs one Roamer brief in the background and posts the result to the space it was
// asked from. Logs timing and token usage, never Roamer details.

const { errorFields } = require('./errors');
const { writeBrief } = require('./agents/roamerBrief');
const { renderBriefCard, renderContactChoice } = require('./chat/briefCard');

const SORRY = {
  notFound: (n, store) => `I couldn't find ${store} deal ${n} in HubSpot. Check the number and try again.`,
  duplicate: (n, store) => `HubSpot has more than one ${store} deal ${n}, so I can't tell which Roamer to read up on. Blake can sort out the duplicate.`,
  // Every deal should have its Roamer attached; a deal without one is a HubSpot problem to fix,
  // so it is also logged as a warning for an alert.
  noContact: (n) => `Deal ${n} has no Roamer contact attached in HubSpot, so there's nothing to read. That needs fixing in HubSpot; it has been flagged.`,
  notOnDeal: (n) => `That contact is no longer on deal ${n} in HubSpot. Ask for the brief again to pick from the current contacts.`,
  failed: (n) => `I couldn't finish the brief for deal ${n}. Blake can see what happened in the logs.`,
};

// `endpoint` is Basecamp's own URL, which the contact picker's buttons call.
function createBriefJob({ loadContext, anthropic, sendMessage, log, avatarUrl, endpoint }) {
  // `announce`, when given, is posted before any work so the user knows the brief is coming.
  // `contactId` is the Roamer picked from the contact picker, when the deal has several.
  return async function runBrief({ spaceName, dealNumber, store = 'UT', announce, contactId }) {
    const started = Date.now();
    try {
      if (announce) await sendMessage(spaceName, announce);
      const context = await loadContext({ store, dealNumber, contactId });
      if (context.duplicate) return await sendMessage(spaceName, SORRY.duplicate(dealNumber, store));
      if (!context.found) return await sendMessage(spaceName, SORRY.notFound(dealNumber, store));
      if (context.notOnDeal) return await sendMessage(spaceName, SORRY.notOnDeal(dealNumber));
      if (context.choices) {
        return await sendMessage(spaceName, renderContactChoice({ dealNumber, store, choices: context.choices, contactCount: context.contactCount, endpoint }));
      }
      if (!context.contact) {
        log('WARNING', 'deal has no Roamer contact', { dealNumber, store });
        return await sendMessage(spaceName, SORRY.noContact(dealNumber));
      }

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
      log('ERROR', 'brief failed', { dealNumber, error: errorFields(err), ms: Date.now() - started });
      await sendMessage(spaceName, SORRY.failed(dealNumber)).catch((e) =>
        log('ERROR', 'could not post brief failure', { dealNumber, error: errorFields(e) }),
      );
    }
  };
}

module.exports = { createBriefJob, SORRY };
