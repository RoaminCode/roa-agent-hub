'use strict';

// What was said or logged on a deal since a moment: the deal space's messages (people only)
// and the Roamer's HubSpot record (calls, texts, emails, notes; every text, call, and email
// with the Roamer is logged there). Read only. Used to look for a promise kept
// (commitJob.js) and for a reminder done (remindJob.js). A source that can't be read is
// logged and left out; the caller goes on with the rest. Logs never hold what was said.

const { errorFields } = require('./errors');

// `db` is Basecamp's records (db.js). `loadContext({ store, dealNumber, rememberPick })`
// reads a deal's HubSpot record (hubspot/dealContext.js). `listSpaceMessages(spaceName,
// since)` reads a deal space's messages (chat/spaces.js); left out, the space is not read.
function createSinceReader({ db, loadContext = null, listSpaceMessages = null, log }) {
  // Entries as [{ source: 'space' | 'hubspot', channel, who, at, text }], oldest first.
  // `forWhat` names the check in the logs ("a commitment", "a reminder").
  return async function since({ dealId = null, dealNumber = null, from, forWhat = 'a check' }) {
    const entries = [];
    const deal = dealId ? await db.getDeal(dealId) : null;
    if (deal && deal.spaceName && listSpaceMessages) {
      try {
        for (const m of await listSpaceMessages(deal.spaceName, from)) entries.push({ source: 'space', channel: 'message', who: m.who, at: m.at, text: m.text });
      } catch (err) {
        log('WARNING', `could not read the deal space's messages for ${forWhat}`, { dealNumber, error: errorFields(err) });
      }
    }
    if (dealNumber && loadContext) {
      try {
        const ctx = await loadContext({ store: (deal && deal.store) || 'UT', dealNumber, rememberPick: true });
        for (const i of (ctx && ctx.items) || []) {
          if (i.at && Date.parse(i.at) > from.getTime()) entries.push({ source: 'hubspot', channel: i.channel, who: i.who, at: i.at, text: i.text });
        }
      } catch (err) {
        log('WARNING', `could not read HubSpot for ${forWhat}`, { dealNumber, error: errorFields(err) });
      }
    }
    return entries.filter((e) => e.text).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  };
}

module.exports = { createSinceReader };
