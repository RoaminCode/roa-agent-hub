'use strict';

// Questions asked with /ask and their answers, kept in HubSpot as one note per topic on the
// deal and its Roamer ("Basecamp Q&A: awning arm"), so the team's answers are on the record,
// briefs read them, and Basecamp can reuse them later. The question and answers are the
// Team Members' words, as written, each dated and attributed. Basecamp's database keeps
// only the note's id and the topic.

const { writtenAt } = require('../agents/roamerBrief');
const { cleanText } = require('./dealContext');

const MARKER = 'Basecamp Q&A:';

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const lines = (text) => escapeHtml(text).split('\n').join('<br>');

function isQaNoteText(text) {
  return String(text || '').trimStart().startsWith(MARKER);
}

// "Q (Nov 7, 11:43 AM MT, Casey Coach): Has the awning arm come in?"
const entry = (kind, at, who, text) => `<p><strong>${kind}</strong> (${escapeHtml(writtenAt(at))} MT, ${escapeHtml(who)}): ${lines(text)}</p>`;

function renderQaNote({ topic, question, askedBy, at }) {
  return `<p><strong>${escapeHtml(`${MARKER} ${topic}`)}</strong></p>${entry('Q', at, askedBy, question)}`;
}

// `hubspot` is the client (get, createDealNote, updateNote).
function createQaNotes({ hubspot }) {
  // A new topic note on the deal, its Roamer, and its Delivery record when it has one. Returns its id.
  async function addQuestion({ dealId, contactId, deliveryId = null, topic, question, askedBy, at }) {
    return hubspot.createDealNote({ dealId, contactId: contactId || null, deliveryId: deliveryId || null, body: renderQaNote({ topic, question, askedBy, at }), timestamp: at.toISOString() });
  }

  // Adds an answer to the end of a topic note, which must still be Basecamp's Q&A note.
  async function addAnswer({ noteId, answer, answeredBy, at }) {
    if (!/^\d+$/.test(String(noteId))) throw new Error('addAnswer: invalid note id');
    const current = await hubspot.get(`/crm/v3/objects/notes/${noteId}?properties=hs_note_body`);
    const body = `${(current.properties || {}).hs_note_body || ''}${entry('A', at, answeredBy, answer)}`;
    return hubspot.updateNote({ noteId, body, timestamp: at.toISOString(), isOurs: (html) => isQaNoteText(cleanText(html)) });
  }

  return { addQuestion, addAnswer };
}

module.exports = { createQaNotes, renderQaNote, isQaNoteText, MARKER };
