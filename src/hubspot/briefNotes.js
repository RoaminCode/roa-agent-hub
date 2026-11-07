'use strict';

// Saves a Roamer brief as Basecamp's one brief note on the deal: updates the note in place
// when the deal already has one (Blake's call, 2026-11-06), creates it otherwise. These
// are the only HubSpot writes Basecamp makes. With `db`, the note's id and what the brief
// was built from are recorded in Basecamp's own records, which find the note next time.

const { renderBriefNote, isBriefNoteText, briefSignature } = require('../agents/briefNote');
const { cleanText } = require('./dealContext');

function createBriefNoteSaver({ hubspot, db = null, now = () => new Date() }) {
  // `spaceName` records the deal's Chat space; left out, the deal's current space is kept.
  // `mode` is how the brief was made: "full" (whole record), "update" (new items only), or
  // "reuse" (unchanged, saved again only to record its space).
  return async function saveBriefNote({ context, brief, spaceName, mode = 'full' }) {
    const at = now();
    const space = spaceName || context.spaceName || (context.briefNote && context.briefNote.spaceName) || null;
    const body = renderBriefNote({ brief, context, now: at, spaceName: space });
    const timestamp = at.toISOString();
    let saved;
    if (context.briefNote) {
      const id = await hubspot.updateNote({ noteId: context.briefNote.id, body, timestamp, isOurs: (html) => isBriefNoteText(cleanText(html)) });
      saved = { id, updated: true };
    } else {
      // On the Roamer, and on the deal's Delivery record once it has one (never the deal).
      saved = { id: await hubspot.createNote({ contactId: context.contact ? context.contact.id : null, deliveryId: context.deliveryId || null, body, timestamp }), updated: false };
    }
    if (db) {
      await db.recordBrief({
        dealId: context.deal.id,
        dealNumber: context.deal.properties.ls_deal_number,
        store: context.store || 'UT',
        contactId: context.contact ? context.contact.id : null,
        noteId: saved.id,
        signature: briefSignature(context),
        mode,
      });
    }
    return saved;
  };
}

module.exports = { createBriefNoteSaver };
