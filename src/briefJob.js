'use strict';

// Runs one Roamer brief in the background and posts the result to the space it was
// asked from. Logs timing and token usage, never Roamer details.

const { errorFields, isOutOfCredits } = require('./errors');
const { writeBrief } = require('./agents/roamerBrief');
const { briefSignature, sameSignature } = require('./agents/briefNote');
const { renderBriefCard, renderContactChoice } = require('./chat/briefCard');

const SORRY = {
  notFound: (n, store) => `I couldn't find ${store} deal ${n} in HubSpot. Check the number and try again.`,
  duplicate: (n, store) => `HubSpot has more than one ${store} deal ${n}, so I can't tell which Roamer to read up on. Blake can sort out the duplicate.`,
  // Every deal should have its Roamer attached; a deal without one is a HubSpot problem to fix,
  // so it is also logged as a warning for an alert.
  noContact: (n) => `Deal ${n} has no Roamer contact attached in HubSpot, so there's nothing to read. That needs fixing in HubSpot; it has been flagged.`,
  notOnDeal: (n) => `That contact is no longer on deal ${n} in HubSpot. Ask for the brief again to pick from the current contacts.`,
  failed: (n) => `I couldn't finish the brief for deal ${n}. Blake can see what happened in the logs.`,
  noCredits: "Basecamp's AI credits have run out, so I can't write briefs right now. Blake will need to add more. Home still shows every deal.",
};

// `endpoint` is Basecamp's own URL, which the contact picker's buttons call.
// `saveBriefNote`, when given, keeps each new brief as the deal's brief note in HubSpot.
function createBriefJob({ loadContext, anthropic, sendMessage, log, avatarUrl, endpoint, saveBriefNote }) {
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

      // A saved brief is reused when nothing in the record changed since it was written:
      // no AI call, no credits.
      const saved = context.briefNote;
      if (saved && saved.brief && sameSignature(saved.signature, briefSignature(context))) {
        log('INFO', 'brief reused from HubSpot note', { dealNumber, items: context.items.length, ms: Date.now() - started });
        return await sendMessage(spaceName, renderBriefCard({ dealNumber, context, brief: saved.brief, avatarUrl }));
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
      // The card is out first; a note that fails to save is logged, and the next brief
      // simply writes a fresh one.
      if (saveBriefNote) {
        try {
          const note = await saveBriefNote({ context, brief: result.brief });
          log('INFO', 'brief note saved', { dealNumber, noteId: note.id, updated: note.updated });
        } catch (err) {
          log('ERROR', 'could not save brief note', { dealNumber, error: errorFields(err) });
        }
      }
    } catch (err) {
      // Out of credits gets its own log line, so it can be found and alerted on by name.
      const noCredits = isOutOfCredits(err);
      log('ERROR', noCredits ? 'brief failed: out of AI credits' : 'brief failed', { dealNumber, error: errorFields(err), ms: Date.now() - started });
      await sendMessage(spaceName, noCredits ? SORRY.noCredits : SORRY.failed(dealNumber)).catch((e) =>
        log('ERROR', 'could not post brief failure', { dealNumber, error: errorFields(e) }),
      );
    }
  };
}

module.exports = { createBriefJob, SORRY };
