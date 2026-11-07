'use strict';

// Notes from a deal space to HubSpot. "@Basecamp note <text>" in a deal space saves the
// text, as written, as a HubSpot note on that deal and its Roamer, signed with who added
// it and when. No AI. The deal comes from Basecamp's record of the space (db.js), so a note
// lands only on the deal the space was linked to, never on a guess. Logs steps, never the
// note's text.

const { errorFields } = require('./errors');
const { writtenAt } = require('./agents/roamerBrief');

// HubSpot holds far more; past this a note is better as a document.
const MAX_CHARS = 5000;

const SAY = {
  empty: 'Add the note after the word "note", for example: note Roamer asked for the delivery to move to Saturday.',
  tooLong: `That note is over ${MAX_CHARS} characters. Split it into shorter notes.`,
  directOnly: 'Notes go to HubSpot from a deal space, so they land on the right deal. Send "note ..." in the deal\'s space.',
  notDealSpace: "This space isn't linked to a deal, so I didn't save the note. Link it first with \"use this space for <deal#>\".",
  saved: (n) => `Saved to HubSpot on deal ${n}.`,
  failed: (n) => `I couldn't save that note to deal ${n}. Nothing was saved; Blake can see what happened in the logs.`,
  failedHere: "I couldn't save that note. Nothing was saved; Blake can see what happened in the logs.",
};

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The note as HubSpot stores it: a title line, the text with its line breaks, and who added
// it. `writtenBy` is set when someone saved another person's message ("Save to HubSpot"):
// the note then says who wrote it and who saved it.
function renderSpaceNote({ text, userDisplayName, userEmail, now, writtenBy }) {
  const who = userDisplayName ? `${userDisplayName} (${userEmail})` : userEmail;
  const by = writtenBy === undefined ? `Added by ${who}` : `Written by ${writtenBy || 'a Team Member'}, saved by ${who}`;
  return [
    '<p><strong>Note from the deal space</strong></p>',
    `<p>${escapeHtml(text).split('\n').join('<br>')}</p>`,
    `<p>${escapeHtml(by)} in Google Chat, ${writtenAt(now)} MT.</p>`,
  ].join('');
}

function createSpaceNotes({ db, createDealNote, log, now = () => new Date() }) {
  // Returns the reply to post in the space.
  return async function saveSpaceNote({ spaceName, userEmail, userDisplayName, text, writtenBy }) {
    const note = String(text || '').trim();
    if (!note) return SAY.empty;
    if (note.length > MAX_CHARS) return SAY.tooLong;

    let dealNumber = null;
    try {
      const space = await db.getSpace(spaceName);
      const deal = space && space.status === 'ready' ? await db.getDeal(space.dealId) : null;
      // The deal record is the authority: a space it no longer names is not the deal's.
      if (!deal || deal.spaceName !== spaceName) {
        log('INFO', 'space note not saved: space is not a deal space', { space: spaceName });
        return SAY.notDealSpace;
      }
      dealNumber = space.dealNumber;
      const at = now();
      // Also on the Roamer's contact, so the next brief reads it (and is rewritten, not reused).
      const id = await createDealNote({ dealId: space.dealId, contactId: deal.contactId || null, body: renderSpaceNote({ text: note, userDisplayName, userEmail, now: at, writtenBy }), timestamp: at.toISOString() });
      // The note is in HubSpot by now; failing to record it here must not say otherwise.
      await db.recordSpaceNote({ noteId: id, dealId: space.dealId, spaceName, user: userEmail, chars: note.length }).catch((e) => log('ERROR', 'could not record space note', { dealNumber, noteId: id, error: errorFields(e) }));
      log('INFO', 'space note saved', { dealNumber, space: spaceName, noteId: id, user: userEmail, chars: note.length });
      return SAY.saved(dealNumber);
    } catch (err) {
      log('ERROR', 'space note failed', { dealNumber, space: spaceName, error: errorFields(err) });
      return dealNumber ? SAY.failed(dealNumber) : SAY.failedHere;
    }
  };
}

module.exports = { createSpaceNotes, renderSpaceNote, SAY, MAX_CHARS };
