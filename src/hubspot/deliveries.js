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

  // Returns { id, created }, or null while another run is finding or creating it (the next
  // step that needs it tries again). `contactId` is the Roamer; `dealname` names a new record.
  return async function ensureDelivery({ dealId, dealNumber, dealname = '', contactId = null }) {
    const record = (await db.getDeal(dealId)) || {};
    if (record.deliveryId) return { id: record.deliveryId, created: false };
    const claim = await db.claimDelivery(dealId);
    if (claim.deliveryId) return { id: claim.deliveryId, created: false };
    if (claim.busy) return null;

    let id;
    let created;
    try {
      // HubSpot is asked first, so a record created by a run that timed out is found, not made twice.
      const existing = await linkedTo(dealId);
      id = existing[0];
      // More than one is a mistake made elsewhere; use the oldest and say so, never guess further.
      if (existing.length > 1) log('WARNING', 'deal has more than one Delivery record; using the oldest', { dealNumber, count: existing.length });
      created = !id;
      if (created) id = await hubspot.createDelivery({ dealId, contactId, ...deliveryTitle(dealNumber, dealname) });
      await db.recordDelivery({ dealId, deliveryId: id, created });
    } catch (err) {
      await db.releaseDeliveryClaim(dealId).catch(() => {});
      throw err;
    }

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

// For anything that finds a deal (`find`, returning { deal, spaceName, deliveryId, ... }): a
// deal whose space is open but whose Delivery record was never found or made (HubSpot failed
// as the space opened) gets it now, so its notes still land on the Delivery record. A deal
// with no space is left alone: the record comes with the space. A failure is logged and the
// deal is returned as found.
function withDeliveryRecord(find, { ensureDelivery, log }) {
  const wrapped = async (args) => {
    const found = await find(args);
    if (!found || !found.deal || !found.spaceName || found.deliveryId) return found;
    const props = found.deal.properties || {};
    const dealNumber = props.ls_deal_number || (args && args.dealNumber) || null;
    try {
      const d = await ensureDelivery({ dealId: found.deal.id, dealNumber, dealname: props.dealname || '', contactId: found.contactId || (found.contact && found.contact.id) || null });
      return d ? { ...found, deliveryId: d.id } : found;
    } catch (err) {
      log('ERROR', 'could not find or create Delivery record', { dealNumber, error: { status: err.status } });
      return found;
    }
  };
  return Object.assign(wrapped, find);
}

module.exports = { createDeliveries, deliveryTitle, withDeliveryRecord };
