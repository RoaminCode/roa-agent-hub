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

// `hubspot` is the client (get, createNote, updateNote).
function createQaNotes({ hubspot }) {
  // A new topic note on the Roamer and the deal's Delivery record (never the deal). Returns its id.
  async function addQuestion({ contactId, deliveryId = null, topic, question, askedBy, at }) {
    return hubspot.createNote({ contactId: contactId || null, deliveryId: deliveryId || null, body: renderQaNote({ topic, question, askedBy, at }), timestamp: at.toISOString() });
  }

  // Adds a line ("Q" or "A") to the end of a topic note, which must still be Basecamp's Q&A note.
  async function append({ noteId, kind, text, who, at }) {
    if (!/^\d+$/.test(String(noteId))) throw new Error('addAnswer: invalid note id');
    const current = await hubspot.get(`/crm/v3/objects/notes/${noteId}?properties=hs_note_body`);
    const body = `${(current.properties || {}).hs_note_body || ''}${entry(kind, at, who, text)}`;
    return hubspot.updateNote({ noteId, body, timestamp: at.toISOString(), isOurs: (html) => isQaNoteText(cleanText(html)) });
  }

  // Adds an answer to the end of a topic note.
  const addAnswer = ({ noteId, answer, answeredBy, at }) => append({ noteId, kind: 'A', text: answer, who: answeredBy, at });

  // Adds a follow-up question to an earlier topic's note, so related questions stay together.
  const addFollowUp = ({ noteId, question, askedBy, at }) => append({ noteId, kind: 'Q', text: question, who: askedBy, at });

  // The text of a deal's Q&A notes, as [{ noteId, text }], skipping any that are gone or no
  // longer Basecamp's. One batch read for all of them.
  async function readNotes(noteIds) {
    const ids = [...new Set(noteIds.filter((id) => /^\d+$/.test(String(id))))].slice(0, 50);
    if (!ids.length) return [];
    const page = await hubspot.post('/crm/v3/objects/notes/batch/read', { properties: ['hs_note_body'], inputs: ids.map((id) => ({ id: String(id) })) });
    return (page.results || [])
      .map((r) => ({ noteId: String(r.id), text: cleanText((r.properties || {}).hs_note_body) }))
      .filter((n) => isQaNoteText(n.text));
  }

  return { addQuestion, addAnswer, addFollowUp, readNotes };
}

module.exports = { createQaNotes, renderQaNote, isQaNoteText, MARKER };
