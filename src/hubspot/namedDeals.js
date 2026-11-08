'use strict';

// The open deals a direct message names: each 5-digit number in the text that HubSpot knows
// as an open Utah deal (a price or a year is not one); any other number is ignored. Used by
// /ask and /remind, so a direct message about a deal is handled as if said in its space.

const { errorFields } = require('../errors');
const { OPEN_STAGE } = require('./openDeals');

// `findDealSpace({ dealNumber })` is hubspot/dealContext.js's. Returns
// [{ dealNumber, deal, contactId, deliveryId, spaceName }], at most three looked up.
async function dealsNamedIn(text, { findDealSpace, log = () => {} }) {
  if (!findDealSpace) return [];
  const numbers = [...new Set(String(text || '').match(/\b\d{5}\b/g) || [])].slice(0, 3);
  const found = [];
  for (const n of numbers) {
    const hit = await findDealSpace({ dealNumber: n }).catch((e) => (log('WARNING', 'could not look up a deal named in a message', { dealNumber: n, error: errorFields(e) }), null));
    if (hit && hit.deal && (hit.deal.properties || {}).dealstage === OPEN_STAGE) found.push({ dealNumber: n, ...hit });
  }
  return found;
}

module.exports = { dealsNamedIn };
