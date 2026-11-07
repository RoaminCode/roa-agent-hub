'use strict';

// A deal's Delivery record, the HubSpot record of its journey to delivery. When a deal
// space opens, Basecamp uses the deal's Delivery record, or creates one (stage Deposit
// Received, its name and trailer, nothing else) linked to the deal and the Roamer, and links the deal's
// brief note to it. Later notes are created on it directly. Basecamp's database keeps the
// record's id, so it is looked up once per deal (Blake's call, 2026-11-07).

const { DELIVERY } = require('./client');
const { parseDealName } = require('./openDeals');

// The record's name and the trailer shown under it, from the deal's name ("51455 - Pat
// Sample - 2026 Trailer"). Both are set once, when Basecamp creates the record.
function deliveryTitle(dealNumber, dealname) {
  const { roamer, trailer } = parseDealName(dealname);
  return { name: [dealNumber, roamer].filter(Boolean).join(' - ') || `Deal ${dealNumber}`, trailer: trailer || null };
}

// `hubspot` is the client; `db` is Basecamp's records (db.js).
function createDeliveries({ hubspot, db, log }) {
  // The Delivery records linked to a deal, oldest first.
  async function linkedTo(dealId) {
    const page = await hubspot.get(`/crm/v4/objects/deals/${dealId}/associations/${DELIVERY}?limit=10`);
    return (page.results || []).map((r) => String(r.toObjectId)).sort((a, b) => Number(a) - Number(b));
  }

  // Returns { id, created }. `contactId` is the Roamer; `dealname` names a new record.
  return async function ensureDelivery({ dealId, dealNumber, dealname = '', contactId = null }) {
    const record = (await db.getDeal(dealId)) || {};
    if (record.deliveryId) return { id: record.deliveryId, created: false };

    const existing = await linkedTo(dealId);
    let id = existing[0];
    // More than one is a mistake made elsewhere; use the oldest and say so, never guess further.
    if (existing.length > 1) log('WARNING', 'deal has more than one Delivery record; using the oldest', { dealNumber, count: existing.length });
    const created = !id;
    if (created) id = await hubspot.createDelivery({ dealId, contactId, ...deliveryTitle(dealNumber, dealname) });
    await db.recordDelivery({ dealId, deliveryId: id, created });

    // The brief note was written before the deal had a Delivery record.
    if (record.briefNoteId) {
      await hubspot
        .linkNoteToDelivery({ noteId: record.briefNoteId, deliveryId: id })
        .catch((err) => log('WARNING', 'could not link brief note to Delivery record', { dealNumber, error: { status: err.status } }));
    }
    log('INFO', created ? 'Delivery record created' : 'Delivery record found', { dealNumber, deliveryId: id });
    return { id, created };
  };
}

module.exports = { createDeliveries, deliveryTitle };
