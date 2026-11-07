'use strict';

// Notes from a deal space to HubSpot. "@Basecamp note <text>" in a deal space saves the
// text, as written, as a HubSpot note on that deal and its Roamer, signed with who added
// it and when.
// No AI. The deal comes from the space's name, which starts with the deal number, and the
// note is saved only when that deal's brief note records this same space, so a note can
// never land on the wrong deal. Logs steps, never the note's text.

const { errorFields } = require('./errors');
const { writtenAt } = require('./agents/roamerBrief');

// HubSpot holds far more; past this a note is better as a document.
const MAX_CHARS = 5000;

const SAY = {
  empty: 'Add the note after the word "note", for example: note Roamer asked for the delivery to move to Saturday.',
  tooLong: `That note is over ${MAX_CHARS} characters. Split it into shorter notes.`,
  directOnly: 'Notes go to HubSpot from a deal space, so they land on the right deal. Send "note ..." in the deal\'s space.',
  notDealSpace: "This space isn't linked to a deal, so I didn't save the note. Deal spaces are named with the deal number first and recorded on the deal's brief note.",
  saved: (n) => `Saved to HubSpot on deal ${n}.`,
  failed: (n) => `I couldn't save that note to deal ${n}. Nothing was saved; Blake can see what happened in the logs.`,
};

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The note as HubSpot stores it: a title line, the text with its line breaks, and who added it.
function renderSpaceNote({ text, userDisplayName, userEmail, now }) {
  const who = userDisplayName ? `${userDisplayName} (${userEmail})` : userEmail;
  return [
    '<p><strong>Note from the deal space</strong></p>',
    `<p>${escapeHtml(text).split('\n').join('<br>')}</p>`,
    `<p>Added by ${escapeHtml(who)} in Google Chat, ${writtenAt(now)} MT.</p>`,
  ].join('');
}

function createSpaceNotes({ findDealSpace, createDealNote, log, now = () => new Date() }) {
  // Returns the reply to post in the space.
  return async function saveSpaceNote({ spaceName, spaceDisplayName, userEmail, userDisplayName, text, store = 'UT' }) {
    const note = String(text || '').trim();
    if (!note) return SAY.empty;
    if (note.length > MAX_CHARS) return SAY.tooLong;

    const m = /^#?(\d{3,8})\b/.exec(String(spaceDisplayName || '').trim());
    if (!m) {
      log('INFO', 'space note not saved: space name has no deal number', { space: spaceName });
      return SAY.notDealSpace;
    }
    const dealNumber = m[1];
    try {
      const found = await findDealSpace({ store, dealNumber });
      if (!found || found.spaceName !== spaceName) {
        log('INFO', 'space note not saved: space is not the deal\'s recorded space', { dealNumber, space: spaceName });
        return SAY.notDealSpace;
      }
      const at = now();
      // Also on the Roamer's contact, so the next brief reads it (and is rewritten, not reused).
      const id = await createDealNote({ dealId: found.deal.id, contactId: found.contactId || null, body: renderSpaceNote({ text: note, userDisplayName, userEmail, now: at }), timestamp: at.toISOString() });
      log('INFO', 'space note saved', { dealNumber, space: spaceName, noteId: id, user: userEmail, chars: note.length });
      return SAY.saved(dealNumber);
    } catch (err) {
      log('ERROR', 'space note failed', { dealNumber, space: spaceName, error: errorFields(err) });
      return SAY.failed(dealNumber);
    }
  };
}

module.exports = { createSpaceNotes, renderSpaceNote, SAY, MAX_CHARS };
