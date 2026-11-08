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
    const isOurs = (html) => isBriefNoteText(cleanText(html));
    const write = async () => {
      if (context.briefNote) return { id: await hubspot.updateNote({ noteId: context.briefNote.id, body, timestamp, isOurs }), updated: true };
      // Another brief for this deal may have written the note since this one loaded.
      const record = db ? await db.getDeal(context.deal.id) : null;
      if (record && record.briefNoteId) return { id: await hubspot.updateNote({ noteId: record.briefNoteId, body, timestamp, isOurs }), updated: true };
      // On the Roamer, and on the deal's Delivery record once it has one (never the deal).
      return { id: await hubspot.createNote({ contactId: context.contact ? context.contact.id : null, deliveryId: context.deliveryId || null, body, timestamp }), updated: false };
    };
    // One brief at a time per deal, so two finishing together make one note, not two.
    const saved = db && db.withLock ? await db.withLock(`brief_${context.deal.id}`, write) : await write();
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
