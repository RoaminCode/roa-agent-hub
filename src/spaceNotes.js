'use strict';

// Notes from a deal space to HubSpot. "@Basecamp note <text>" in a deal space saves the
// text, as written, as a HubSpot note on that deal and its Roamer, signed with who added
// it and when. No AI. The deal comes from Basecamp's record of the space (db.js), so a note
// lands only on the deal the space was linked to, never on a guess. In a direct message with
// Basecamp, the note names its deal instead: "note 51455 <text>". Logs steps, never the
// note's text.

const { errorFields } = require('./errors');
const { writtenAt } = require('./agents/roamerBrief');

// HubSpot holds far more; past this a note is better as a document.
const MAX_CHARS = 5000;

const SAY = {
  empty: 'Add the note after the word "note", for example: note Roamer asked for the delivery to move to Saturday.',
  tooLong: `That note is over ${MAX_CHARS} characters. Split it into shorter notes.`,
  // In a direct message there is no deal space, so the note names its deal.
  directOnly: 'In a direct message, name the deal first, for example: note 51455 Roamer asked for the delivery to move to Saturday.',
  noDeal: (n) => `I couldn't find deal ${n} in HubSpot, so I didn't save the note.`,
  notDealSpace: "This space isn't linked to a deal, so I didn't save the note. Link it first with \"use this space for <deal#>\".",
  saved: (n) => `Saved to HubSpot on deal ${n}.`,
  failed: (n) => `I couldn't save that note to deal ${n}. Nothing was saved; Blake can see what happened in the logs.`,
  failedHere: "I couldn't save that note. Nothing was saved; Blake can see what happened in the logs.",
};

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The note as HubSpot stores it: a title line, the text with its line breaks, and who added
// it. `writtenBy` is set when someone saved another person's message ("Save to HubSpot"):
// the note then says who wrote it and who saved it, unless they are the same person.
// `fromSpace` false is a note sent in a direct message with Basecamp.
function renderSpaceNote({ text, userDisplayName, userEmail, now, writtenBy, fromSpace = true }) {
  const who = userDisplayName ? `${userDisplayName} (${userEmail})` : userEmail;
  const own = writtenBy === undefined || (writtenBy && writtenBy === userDisplayName);
  const by = own ? `Added by ${who}` : `Written by ${writtenBy || 'a Team Member'}, saved by ${who}`;
  return [
    `<p><strong>${fromSpace ? 'Note from the deal space' : 'Note from Basecamp'}</strong></p>`,
    `<p>${escapeHtml(text).split('\n').join('<br>')}</p>`,
    `<p>${escapeHtml(by)} in Google Chat, ${writtenAt(now)} MT.</p>`,
  ].join('');
}

// `findDealSpace({ dealNumber })` finds a deal by number in HubSpot, for notes sent in a
// direct message, which name their deal: "note 51455 <text>".
function createSpaceNotes({ db, createDealNote, findDealSpace, log, now = () => new Date() }) {
  // Saves the note on the deal and its Roamer and records it. Returns the reply.
  async function write({ dealId, contactId, deliveryId, dealNumber, spaceName, note, userEmail, userDisplayName, writtenBy, fromSpace }) {
    const at = now();
    // Also on the Roamer's contact, so the next brief reads it (and is rewritten, not reused).
    const id = await createDealNote({ dealId, contactId: contactId || null, deliveryId: deliveryId || null, body: renderSpaceNote({ text: note, userDisplayName, userEmail, now: at, writtenBy, fromSpace }), timestamp: at.toISOString() });
    // The note is in HubSpot by now; failing to record it here must not say otherwise.
    await db.recordSpaceNote({ noteId: id, dealId, spaceName, user: userEmail, chars: note.length }).catch((e) => log('ERROR', 'could not record space note', { dealNumber, noteId: id, error: errorFields(e) }));
    log('INFO', 'space note saved', { dealNumber, space: spaceName, noteId: id, user: userEmail, chars: note.length });
    return SAY.saved(dealNumber);
  }

  // A note in a direct message: "51455 <text>", saved to that deal whether or not it has a space.
  async function saveDirect({ spaceName, userEmail, userDisplayName, text }) {
    const m = /^#?(\d{3,8})\b[\s:,-]*([\s\S]*)$/.exec(text);
    if (!m) return SAY.directOnly;
    const [, dealNumber, rest] = m;
    const note = rest.trim();
    if (!note) return SAY.empty;
    if (note.length > MAX_CHARS) return SAY.tooLong;
    try {
      const found = await findDealSpace({ dealNumber });
      if (!found) return SAY.noDeal(dealNumber);
      return await write({ dealId: found.deal.id, contactId: found.contactId, dealNumber, spaceName, note, userEmail, userDisplayName, fromSpace: false });
    } catch (err) {
      log('ERROR', 'space note failed', { dealNumber, space: spaceName, error: errorFields(err) });
      return SAY.failed(dealNumber);
    }
  }

  // Returns the reply to post where the note was sent.
  return async function saveSpaceNote({ spaceName, isDirectMessage = false, userEmail, userDisplayName, text, writtenBy }) {
    if (isDirectMessage) return saveDirect({ spaceName, userEmail, userDisplayName, text: String(text || '').trim() });
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
      return await write({ dealId: space.dealId, contactId: deal.contactId, deliveryId: deal.deliveryId, dealNumber, spaceName, note, userEmail, userDisplayName, writtenBy, fromSpace: true });
    } catch (err) {
      log('ERROR', 'space note failed', { dealNumber, space: spaceName, error: errorFields(err) });
      return dealNumber ? SAY.failed(dealNumber) : SAY.failedHere;
    }
  };
}

module.exports = { createSpaceNotes, renderSpaceNote, SAY, MAX_CHARS };
