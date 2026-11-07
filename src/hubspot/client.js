'use strict';

// Minimal HubSpot API client. Reads: GET, plus POST only to search and batch-read
// endpoints, which read data. Agents never edit HubSpot fields. The only writes are narrow
// methods: create a note on a deal, update a note that a check proves is Basecamp's own,
// create a deal's Delivery record (stage Deposit Received, nothing else filled) linked to
// the deal and the Roamer, and link a note to a Delivery record. There is no general write.

const { safeError } = require('../errors');

const BASE = 'https://api.hubapi.com';
const READ_POST = /\/(search|batch\/read)$/;
const NOTES = '/crm/v3/objects/notes';
const NOTE_PATH = /^\/crm\/v3\/objects\/notes\/\d+$/;
// HubSpot's association types for a note on a deal and on a contact.
const NOTE_TO_DEAL = 214;
const NOTE_TO_CONTACT = 202;

// The Delivery custom object, its pipeline's first stage, and its association types
// (defined in this HubSpot account, so "USER_DEFINED").
const DELIVERY = '2-59426991';
const DELIVERIES = `/crm/v3/objects/${DELIVERY}`;
const DELIVERY_PIPELINE = '883780109';
const DEPOSIT_RECEIVED = '1327357231';
const DELIVERY_TO_DEAL = 98;
const DELIVERY_TO_CONTACT = 96;
const NOTE_TO_DELIVERY = 95;
const NOTE_DELIVERY_LINK = new RegExp(`^/crm/v4/objects/notes/\\d+/associations/${DELIVERY}/\\d+$`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// No single HubSpot read should take this long; past it, the read fails instead of hanging.
const TIMEOUT_MS = 20 * 1000;

function createHubSpotClient({ token, fetchImpl = fetch, wait = sleep, timeoutMs = TIMEOUT_MS }) {
  if (!token) throw new Error('createHubSpotClient: token is required');

  // `write` is set only by the note methods below; every other caller can only read.
  async function request(method, path, body, { write = false } = {}) {
    const isRead = method === 'GET' || (method === 'POST' && READ_POST.test(path));
    const isNoteWrite = write && ((method === 'POST' && path === NOTES) || (method === 'PATCH' && NOTE_PATH.test(path)));
    const isDeliveryWrite = write && ((method === 'POST' && path === DELIVERIES) || (method === 'PUT' && NOTE_DELIVERY_LINK.test(path)));
    if (!isRead && !isNoteWrite && !isDeliveryWrite) {
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
      const err = safeError(`HubSpot ${method} ${path.split('?')[0]} failed: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // A new note on one deal, and also on the deal's Roamer when `contactId` is given (so the
  // Roamer's record, which briefs read, includes it) and on its Delivery record when
  // `deliveryId` is given. Returns the note's id.
  async function createDealNote({ dealId, contactId = null, deliveryId = null, body, timestamp }) {
    if (!/^\d+$/.test(String(dealId))) throw safeError('createDealNote: invalid deal id');
    if (contactId !== null && !/^\d+$/.test(String(contactId))) throw safeError('createDealNote: invalid contact id');
    if (deliveryId !== null && !/^\d+$/.test(String(deliveryId))) throw safeError('createDealNote: invalid delivery id');
    const on = (id, typeId, category = 'HUBSPOT_DEFINED') => ({ to: { id: String(id) }, types: [{ associationCategory: category, associationTypeId: typeId }] });
    const note = await request(
      'POST',
      NOTES,
      {
        properties: { hs_timestamp: timestamp, hs_note_body: body },
        associations: [
          on(dealId, NOTE_TO_DEAL),
          ...(contactId !== null ? [on(contactId, NOTE_TO_CONTACT)] : []),
          ...(deliveryId !== null ? [on(deliveryId, NOTE_TO_DELIVERY, 'USER_DEFINED')] : []),
        ],
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

  // A deal's Delivery record: Delivery Pipeline, stage Deposit Received, no other fields,
  // linked to the deal and its Roamer. Returns its id. Callers check first that the deal has
  // none (hubspot/deliveries.js).
  async function createDelivery({ dealId, contactId = null }) {
    if (!/^\d+$/.test(String(dealId))) throw safeError('createDelivery: invalid deal id');
    if (contactId !== null && !/^\d+$/.test(String(contactId))) throw safeError('createDelivery: invalid contact id');
    const on = (id, typeId) => ({ to: { id: String(id) }, types: [{ associationCategory: 'USER_DEFINED', associationTypeId: typeId }] });
    const delivery = await request(
      'POST',
      DELIVERIES,
      {
        properties: { hs_pipeline: DELIVERY_PIPELINE, hs_pipeline_stage: DEPOSIT_RECEIVED },
        associations: [on(dealId, DELIVERY_TO_DEAL), ...(contactId !== null ? [on(contactId, DELIVERY_TO_CONTACT)] : [])],
      },
      { write: true },
    );
    return String(delivery.id);
  }

  // Links an existing note (such as the deal's brief note) to a Delivery record.
  async function linkNoteToDelivery({ noteId, deliveryId }) {
    if (!/^\d+$/.test(String(noteId)) || !/^\d+$/.test(String(deliveryId))) throw safeError('linkNoteToDelivery: invalid id');
    await request('PUT', `/crm/v4/objects/notes/${noteId}/associations/${DELIVERY}/${deliveryId}`, [{ associationCategory: 'USER_DEFINED', associationTypeId: NOTE_TO_DELIVERY }], { write: true });
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    createDealNote,
    updateNote,
    createDelivery,
    linkNoteToDelivery,
  };
}

module.exports = { createHubSpotClient, DELIVERY, DELIVERY_PIPELINE, DEPOSIT_RECEIVED };
