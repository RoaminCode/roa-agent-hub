'use strict';

// Notes from a deal space to HubSpot. "@Basecamp note <text>" in a deal space saves the
// text, as written, as a HubSpot note on that deal's Delivery record and its Roamer (never the deal), signed with who added
// it and when. No AI. The deal comes from Basecamp's record of the space (db.js), so a note
// lands only on the deal the space was linked to, never on a guess. In a direct message with
// Basecamp, the note names its deal instead: "note 51455 <text>". Logs steps, never the
// note's text.
//
// With `card: true` (the router's "note" command) the reply is a card showing the note with
// an Edit note button (Blake, 2026-11-13). Editing is for the person who added the note: the
// button opens a box holding the note's words, read back from HubSpot, and saving replaces
// the note there, keeps its place in the timeline, and adds "Edited by" to its signature.

const { errorFields } = require('./errors');
const { writtenAt } = require('./agents/roamerBrief');
const { primary, secondary } = require('./chat/style');

// HubSpot holds far more; past this a note is better as a document.
const MAX_CHARS = 5000;

const SAY = {
  empty: 'Add the note after the word "note", for example: note Roamer asked for the delivery to move to Saturday.',
  tooLong: `That note is over ${MAX_CHARS} characters. Split it into shorter notes.`,
  // In a direct message there is no deal space, so the note names its deal.
  directOnly: 'In a direct message, name the deal first, for example: note 51455 Roamer asked for the delivery to move to Saturday.',
  noDeal: (n) => `I couldn't find deal ${n} in HubSpot, so I didn't save the note.`,
  // A deal Basecamp has never briefed: with one contact the note goes on it; otherwise
  // there is no Roamer to put it on, and Basecamp does not guess.
  severalContacts: (n) => `Deal ${n} has more than one contact in HubSpot, so I can't tell which is the Roamer, and I didn't save the note. Ask me for "brief ${n}" and pick the Roamer, then send the note again.`,
  noRoamer: (n) => `Deal ${n} has no Roamer contact attached in HubSpot, so there is nowhere to save the note. That needs fixing in HubSpot.`,
  notDealSpace: "This space isn't linked to a deal, so I didn't save the note. Link it first with \"use this space for <deal#>\".",
  // Where the note went: the deal's Delivery record (and the Roamer), or only the Roamer's
  // record when the deal has no Delivery record yet. Never the deal itself.
  saved: (n, onDelivery = true) => (onDelivery ? `Saved to the ${n} Delivery record in HubSpot.` : `Saved to the Roamer's record in HubSpot for deal ${n}.`),
  failed: (n) => `I couldn't save that note to deal ${n}. Nothing was saved; Blake can see what happened in the logs.`,
  failedHere: "I couldn't save that note. Nothing was saved; Blake can see what happened in the logs.",
  editOff: "Editing notes isn't switched on yet.",
  notYours: 'Only the person who added a note can edit it here.',
  editGone: "I couldn't find that note in HubSpot, so there is nothing to edit.",
  // The note no longer reads as Basecamp wrote it (someone changed it in HubSpot).
  editChanged: "That note was changed in HubSpot since I saved it, so I can't edit it from here. It can be edited in HubSpot.",
  editEmpty: "A note can't be empty, so I left it as it was.",
  editTooLong: `That is over ${MAX_CHARS} characters, so I left the note as it was.`,
  editFailed: "I couldn't save that change. The note in HubSpot is as it was; Blake can see what happened in the logs.",
};

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeHtml = (html) => html.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

const TITLES = ['Note from the deal space', 'Note from Basecamp'];
const EDITED = / Edited by [^<]*? MT\.$/;

// The parts of a note Basecamp saved, read back from HubSpot: { title, text, signature }, or
// null when it no longer has the shape renderSpaceNote gave it.
function parseSpaceNote(html) {
  const m = /^\s*<p><strong>([^<]*)<\/strong><\/p>\s*<p>([\s\S]*)<\/p>\s*<p>([^<]*)<\/p>\s*$/.exec(String(html || ''));
  if (!m || !TITLES.includes(m[1])) return null;
  const lines = m[2].split(/<br\s*\/?>/i);
  if (lines.some((l) => /<[a-z/]/i.test(l))) return null;
  return { title: m[1], text: lines.map(unescapeHtml).join('\n'), signature: unescapeHtml(m[3]) };
}

// A note with new words: the same title and signature, with one "Edited by" line (the latest).
function renderEditedNote({ title, text, signature, editedBy, now }) {
  const signed = `${signature.replace(EDITED, '')} Edited by ${editedBy}, ${writtenAt(now)} MT.`;
  return { html: `<p><strong>${escapeHtml(title)}</strong></p><p>${escapeHtml(text).split('\n').join('<br>')}</p><p>${escapeHtml(signed)}</p>`, signature: signed };
}

const button = (endpoint, action, params, dialog = false) => ({ action: { function: endpoint, ...(dialog ? { interaction: 'OPEN_DIALOG' } : {}), parameters: [{ key: 'action', value: action }, ...Object.entries(params).map(([key, value]) => ({ key, value: String(value) }))] } });

// How much of a note its card shows before "Show more": this many lines, or characters.
const SHOWN_LINES = 4;
const SHOWN_CHARS = 400;

// A note as one part, or as [what shows, the rest] when it is long.
function shown(text) {
  const lines = text.split('\n');
  if (lines.length > SHOWN_LINES) return [lines.slice(0, SHOWN_LINES).join('\n'), lines.slice(SHOWN_LINES).join('\n')];
  if (text.length <= SHOWN_CHARS) return [text];
  const cut = text.lastIndexOf(' ', SHOWN_CHARS);
  const at = cut > SHOWN_CHARS / 2 ? cut : SHOWN_CHARS;
  return [text.slice(0, at), text.slice(at).trimStart()];
}

// The note as the space shows it once saved: where it went, its words, who added it, and
// Edit note. The words are not carried on the button; Edit reads them back from HubSpot.
function noteCard({ noteId, dealNumber, onDelivery = true, text, signature, endpoint }) {
  return {
    fallbackText: SAY.saved(dealNumber, onDelivery),
    cardsV2: [
      {
        cardId: `note-${noteId}`,
        card: {
          header: { title: 'Note saved', subtitle: onDelivery ? `Deal ${dealNumber} · on the Delivery record in HubSpot` : `Deal ${dealNumber} · on the Roamer's record in HubSpot` },
          sections: [
            // A long note shows its start; the rest opens with "Show more".
            { widgets: shown(text).map((part) => ({ textParagraph: { text: escapeHtml(part).split('\n').join('<br>') } })), ...(shown(text).length > 1 ? { collapsible: true, uncollapsibleWidgetsCount: 1 } : {}) },
            {
              widgets: [
                // The email stays in HubSpot's note; the space needs only the name and time.
                { textParagraph: { text: `<i>${escapeHtml(signature.replace(/ \([^()\s]+@[^()\s]+\)/g, ''))}</i>` } },
                { buttonList: { buttons: [secondary('Edit note', button(endpoint, 'noteEdit', { id: noteId, n: dealNumber, o: onDelivery ? '1' : '0' }, true))] } },
              ],
            },
          ],
        },
      },
    ],
  };
}

// The box Edit note opens. `card` is the note card's message name, so saving can redraw it.
function editDialog({ noteId, dealNumber, onDelivery, text, endpoint, card }) {
  const params = { id: noteId, n: dealNumber, o: onDelivery ? '1' : '0', c: card || '' };
  return {
    header: { title: 'Edit note', subtitle: `Deal ${dealNumber}. Saving replaces the note in HubSpot.` },
    sections: [
      {
        widgets: [
          { textInput: { name: 'note', label: `Note (${MAX_CHARS} characters max)`, type: 'MULTIPLE_LINE', value: text } },
          { buttonList: { buttons: [primary('Save', button(endpoint, 'noteSave', params)), secondary('Cancel', button(endpoint, 'noteCancel', {}))] } },
        ],
      },
    ],
  };
}

// The note as HubSpot stores it: a title line, the text with its line breaks, and who added
// it. `writtenBy` is set when someone saved another person's message ("Save to HubSpot"):
// the note then says who wrote it and who saved it, unless they are the same person.
// `fromSpace` false is a note sent in a direct message with Basecamp.
function signatureOf({ userDisplayName, userEmail, now, writtenBy }) {
  const who = userDisplayName ? `${userDisplayName} (${userEmail})` : userEmail;
  const own = writtenBy === undefined || (writtenBy && writtenBy === userDisplayName);
  const by = own ? `Added by ${who}` : `Written by ${writtenBy || 'a Team Member'}, saved by ${who}`;
  return `${by} in Google Chat, ${writtenAt(now)} MT.`;
}

function renderSpaceNote({ text, userDisplayName, userEmail, now, writtenBy, fromSpace = true }) {
  return [
    `<p><strong>${fromSpace ? TITLES[0] : TITLES[1]}</strong></p>`,
    `<p>${escapeHtml(text).split('\n').join('<br>')}</p>`,
    `<p>${escapeHtml(signatureOf({ userDisplayName, userEmail, now, writtenBy }))}</p>`,
  ].join('');
}

// `findDealSpace({ dealNumber })` finds a deal by number in HubSpot, for notes sent in a
// direct message, which name their deal: "note 51455 <text>".
// `endpoint` is Basecamp's own address, for the card's button.
function createSpaceNotes({ db, createNote, findDealSpace, log, endpoint = '', now = () => new Date() }) {
  // Saves the note on the deal's Delivery record and its Roamer and records it. Returns the
  // reply: a line of text, or with `card` the note's card.
  async function write({ dealId, contactId, deliveryId, dealNumber, spaceName, note, userEmail, userDisplayName, writtenBy, fromSpace, card }) {
    const at = now();
    // Also on the Roamer's contact, so the next brief reads it (and is rewritten, not reused).
    // On the Roamer and the deal's Delivery record, never the deal itself. `dealId` is kept
    // only in Basecamp's records.
    const id = await createNote({ contactId: contactId || null, deliveryId: deliveryId || null, body: renderSpaceNote({ text: note, userDisplayName, userEmail, now: at, writtenBy, fromSpace }), timestamp: at.toISOString() });
    // The note is in HubSpot by now; failing to record it here must not say otherwise.
    await db.recordSpaceNote({ noteId: id, dealId, spaceName, user: userEmail, chars: note.length }).catch((e) => log('ERROR', 'could not record space note', { dealNumber, noteId: id, error: errorFields(e) }));
    log('INFO', 'space note saved', { dealNumber, space: spaceName, noteId: id, user: userEmail, chars: note.length });
    if (card) return noteCard({ noteId: id, dealNumber, onDelivery: Boolean(deliveryId), text: note, signature: signatureOf({ userDisplayName, userEmail, now: at, writtenBy }), endpoint });
    return SAY.saved(dealNumber, Boolean(deliveryId));
  }

  // A note in a direct message: "51455 <text>", saved to that deal whether or not it has a space.
  async function saveDirect({ spaceName, userEmail, userDisplayName, text, card }) {
    const m = /^#?(\d{3,8})\b[\s:,-]*([\s\S]*)$/.exec(text);
    if (!m) return SAY.directOnly;
    const [, dealNumber, rest] = m;
    const note = rest.trim();
    if (!note) return SAY.empty;
    if (note.length > MAX_CHARS) return SAY.tooLong;
    try {
      const found = await findDealSpace({ dealNumber });
      if (!found) return SAY.noDeal(dealNumber);
      if (!found.contactId && !found.deliveryId) {
        log('INFO', 'direct note not saved: no Roamer to put it on', { dealNumber, contacts: found.contactCount ?? null });
        return found.contactCount > 1 ? SAY.severalContacts(dealNumber) : SAY.noRoamer(dealNumber);
      }
      return await write({ dealId: found.deal.id, contactId: found.contactId, deliveryId: found.deliveryId, dealNumber, spaceName, note, userEmail, userDisplayName, fromSpace: false, card });
    } catch (err) {
      log('ERROR', 'space note failed', { dealNumber, space: spaceName, error: errorFields(err) });
      return SAY.failed(dealNumber);
    }
  }

  // Returns the reply to post where the note was sent.
  return async function saveSpaceNote({ spaceName, isDirectMessage = false, userEmail, userDisplayName, text, writtenBy, card = false }) {
    if (isDirectMessage) return saveDirect({ spaceName, userEmail, userDisplayName, text: String(text || '').trim(), card });
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
      return await write({ dealId: space.dealId, contactId: deal.contactId, deliveryId: deal.deliveryId, dealNumber, spaceName, note, userEmail, userDisplayName, writtenBy, fromSpace: true, card });
    } catch (err) {
      log('ERROR', 'space note failed', { dealNumber, space: spaceName, error: errorFields(err) });
      return dealNumber ? SAY.failed(dealNumber) : SAY.failedHere;
    }
  };
}

// Edit note. `hubspot` is the client (get, updateNote); `updateMessage(name, message)`
// redraws the note's card. Both steps check the note is one Basecamp recorded and that the
// person tapping is the one who added it.
function createNoteEditor({ db, hubspot, updateMessage = async () => {}, log, endpoint = '', now = () => new Date() }) {
  // The note as HubSpot has it now: { parts, timestamp }, or a line saying why not.
  async function current(noteId, userEmail) {
    if (!/^\d{1,20}$/.test(noteId)) return SAY.editGone;
    const record = await db.getSpaceNote(noteId);
    if (!record) return SAY.editGone;
    if (record.user !== userEmail) return SAY.notYours;
    let found;
    try {
      found = await hubspot.get(`/crm/v3/objects/notes/${noteId}?properties=hs_note_body,hs_timestamp`);
    } catch (err) {
      if (err && err.status === 404) return SAY.editGone;
      throw err;
    }
    const parts = parseSpaceNote((found.properties || {}).hs_note_body);
    if (!parts) return SAY.editChanged;
    return { parts, timestamp: (found.properties || {}).hs_timestamp || now().toISOString() };
  }

  // Edit note was tapped. Returns { dialog } to open, or { notice } to post instead.
  async function review({ params, userEmail, messageName }) {
    const noteId = String(params.id || '');
    const dealNumber = String(params.n || '');
    try {
      const got = await current(noteId, userEmail);
      if (typeof got === 'string') return { notice: got };
      return { dialog: editDialog({ noteId, dealNumber, onDelivery: params.o !== '0', text: got.parts.text, endpoint, card: messageName }) };
    } catch (err) {
      log('ERROR', 'note edit could not open', { dealNumber, noteId, error: errorFields(err) });
      return { notice: SAY.editFailed };
    }
  }

  // Save in the box. Returns a line to post when the note was not replaced, or null when it
  // was (its card then shows the new words) or the words were left as they were.
  async function save({ params, formInputs, userEmail, userDisplayName }) {
    const noteId = String(params.id || '');
    const dealNumber = String(params.n || '');
    const text = String((formInputs && formInputs.note) || '').trim();
    if (!text) return SAY.editEmpty;
    if (text.length > MAX_CHARS) return SAY.editTooLong;
    try {
      const got = await current(noteId, userEmail);
      if (typeof got === 'string') return got;
      if (got.parts.text === text) return null;
      const at = now();
      const next = renderEditedNote({ title: got.parts.title, text, signature: got.parts.signature, editedBy: userDisplayName || userEmail, now: at });
      // The note keeps its own time, so it stays where it was in HubSpot's timeline.
      await hubspot.updateNote({ noteId, body: next.html, timestamp: got.timestamp, isOurs: (html) => Boolean(parseSpaceNote(html)) });
      await db.markSpaceNoteEdited({ noteId, chars: text.length }).catch((e) => log('ERROR', 'could not record the note edit', { dealNumber, noteId, error: errorFields(e) }));
      log('INFO', 'space note edited', { dealNumber, noteId, user: userEmail, chars: text.length });
      await updateMessage(String(params.c || ''), noteCard({ noteId, dealNumber, onDelivery: params.o !== '0', text, signature: next.signature, endpoint })).catch((e) =>
        log('ERROR', 'could not redraw the note card', { dealNumber, noteId, error: errorFields(e) }),
      );
      return null;
    } catch (err) {
      log('ERROR', 'space note edit failed', { dealNumber, noteId, error: errorFields(err) });
      return SAY.editFailed;
    }
  }

  return { review, save };
}

module.exports = { createSpaceNotes, createNoteEditor, renderSpaceNote, parseSpaceNote, noteCard, SAY, MAX_CHARS };
