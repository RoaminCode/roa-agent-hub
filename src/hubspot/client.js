'use strict';

// Minimal HubSpot API client. Reads: GET, plus POST only to search and batch-read
// endpoints, which read data. Agents never edit HubSpot fields. The only writes are
// Basecamp's own notes, through two narrow methods: create a note on a deal, and update a
// note that a check proves is Basecamp's own. There is no general write.

const { safeError } = require('../errors');

const BASE = 'https://api.hubapi.com';
const READ_POST = /\/(search|batch\/read)$/;
const NOTES = '/crm/v3/objects/notes';
const NOTE_PATH = /^\/crm\/v3\/objects\/notes\/\d+$/;
// HubSpot's association type for a note on a deal.
const NOTE_TO_DEAL = 214;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// No single HubSpot read should take this long; past it, the read fails instead of hanging.
const TIMEOUT_MS = 20 * 1000;

function createHubSpotClient({ token, fetchImpl = fetch, wait = sleep, timeoutMs = TIMEOUT_MS }) {
  if (!token) throw new Error('createHubSpotClient: token is required');

  // `write` is set only by the note methods below; every other caller can only read.
  async function request(method, path, body, { write = false } = {}) {
    const isRead = method === 'GET' || (method === 'POST' && READ_POST.test(path));
    const isNoteWrite = write && ((method === 'POST' && path === NOTES) || (method === 'PATCH' && NOTE_PATH.test(path)));
    if (!isRead && !isNoteWrite) {
      throw safeError(`HubSpot client refuses ${method} to ${path}: only search and batch read are allowed`);
    }
    const send = () =>
      fetchImpl(BASE + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    let res = await send();
    // HubSpot caps searches per second. One wait and retry covers a burst like App Home's.
    if (res.status === 429) {
      const after = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
      await wait(after > 0 ? Math.min(after, 5) * 1000 : 1000);
      res = await send();
    }
    if (!res.ok) {
      // The status and path are enough to debug; response bodies can hold Roamer details.
      throw safeError(`HubSpot ${method} ${path.split('?')[0]} failed: HTTP ${res.status}`);
    }
    return res.json();
  }

  // A new note on one deal. Returns the note's id.
  async function createDealNote({ dealId, body, timestamp }) {
    if (!/^\d+$/.test(String(dealId))) throw safeError('createDealNote: invalid deal id');
    const note = await request(
      'POST',
      NOTES,
      {
        properties: { hs_timestamp: timestamp, hs_note_body: body },
        associations: [{ to: { id: String(dealId) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_DEAL }] }],
      },
      { write: true },
    );
    return String(note.id);
  }

  // Replaces a note's body, but only after reading the note and `isOurs(body)` agreeing
  // it is Basecamp's own. A Team Member's note is never overwritten.
  async function updateNote({ noteId, body, timestamp, isOurs }) {
    if (!/^\d+$/.test(String(noteId))) throw safeError('updateNote: invalid note id');
    if (typeof isOurs !== 'function') throw safeError("updateNote: a check that the note is Basecamp's own is required");
    const current = await request('GET', `${NOTES}/${noteId}?properties=hs_note_body`);
    if (!isOurs((current.properties || {}).hs_note_body)) throw safeError("updateNote: refused, the note is not Basecamp's own");
    await request('PATCH', `${NOTES}/${noteId}`, { properties: { hs_timestamp: timestamp, hs_note_body: body } }, { write: true });
    return String(noteId);
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    createDealNote,
    updateNote,
  };
}

module.exports = { createHubSpotClient };
