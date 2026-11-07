'use strict';

// Saves a Roamer brief as Basecamp's one brief note on the deal: updates the note in place
// when the deal already has one (Blake's call, 2026-11-06), creates it otherwise. These
// are the only HubSpot writes Basecamp makes.

const { renderBriefNote, isBriefNoteText } = require('../agents/briefNote');
const { cleanText } = require('./dealContext');

function createBriefNoteSaver({ hubspot, now = () => new Date() }) {
  // `spaceName` records the deal's Chat space; left out, the space already on the note is kept.
  return async function saveBriefNote({ context, brief, spaceName }) {
    const at = now();
    const space = spaceName || (context.briefNote && context.briefNote.spaceName) || null;
    const body = renderBriefNote({ brief, context, now: at, spaceName: space });
    const timestamp = at.toISOString();
    if (context.briefNote) {
      const id = await hubspot.updateNote({ noteId: context.briefNote.id, body, timestamp, isOurs: (html) => isBriefNoteText(cleanText(html)) });
      return { id, updated: true };
    }
    return { id: await hubspot.createDealNote({ dealId: context.deal.id, body, timestamp }), updated: false };
  };
}

module.exports = { createBriefNoteSaver };
