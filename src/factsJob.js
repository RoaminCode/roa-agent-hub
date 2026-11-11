'use strict';

// "facts <deal#>" in a direct message: the deal as LightSpeed has it right now, read live
// through the integration's read-only lookup (lightspeed/lookup.js) and trimmed to the RJB
// view (lightspeed/rjbView.js). No AI. It is how deal facts are checked against LightSpeed
// before any agent is trusted with them, and what a deal space will pin later. LightSpeed
// is the source of truth; nothing is written anywhere. Logs counts and timing, never what
// the deal holds.

const { errorFields } = require('./errors');
const { toRjbView } = require('./lightspeed/rjbView');
const { noDashes, shortDate } = require('./agents/roamerBrief');
const { label } = require('./chat/style');

const SAY = {
  working: (n) => `Looking up deal ${n} in LightSpeed. It will be here in a moment.`,
  off: "LightSpeed lookups aren't switched on yet.",
  directOnly: (n) => `Deal facts stay private for now: ask me for "facts ${n}" in a direct message with me.`,
  notFound: (n, store) => `LightSpeed has no ${store} deal ${n}. Check the number and try again.`,
  storeOff: (store) => `LightSpeed lookups are not switched on for ${store} yet, only Utah.`,
  slow: (n) => `LightSpeed took too long to answer for deal ${n}. Try again in a minute.`,
  failed: (n) => `I couldn't read deal ${n} from LightSpeed. Nothing is wrong with the deal itself; Blake can see what happened in the logs.`,
};

const escape = (text) => noDashes(String(text)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n) => (typeof n === 'number' ? `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}` : null);
const row = (top, text) => ({ decoratedText: { topLabel: top, text: escape(text), wrapText: true } });
const rows = (pairs) => pairs.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => row(k, v));

// One labor line: its title, then what kind it is, its repair order, and its labor price.
function laborRow(line, kind) {
  const ro = line.repairOrder ? `RO ${line.repairOrder.number}${line.repairOrder.status ? `, ${line.repairOrder.status}` : ''}` : 'Not on a repair order yet';
  const price = money(line.laborRetailPrice);
  return { decoratedText: { text: escape(line.title || 'Untitled line'), bottomLabel: [kind, ro, price ? `labor ${price}` : null].filter(Boolean).map(escape).join(' · '), wrapText: true } };
}

// The RJB view as a card. Every value on it is LightSpeed's own; nothing is summarized.
function factsCard({ dealNumber, view, others = 0 }) {
  const d = view.deal;
  const u = view.unit;
  const trailer = [u.year, u.make, u.model].filter(Boolean).join(' ');
  const sections = [
    {
      header: label('Deal'),
      widgets: rows([
        ['State', [d.state, d.stage].filter(Boolean).join(', ') || (view.feed === 'closed' ? 'Closed' : null)],
        ['Opened', d.opened ? shortDate(d.opened) : null],
        ['Delivery date', d.deliveryDate ? shortDate(d.deliveryDate) : 'Not set'],
        ['Sales Coach', d.salesCoach],
        ['Deposit', money(d.deposit)],
      ]),
    },
    {
      header: label('Trailer'),
      widgets: rows([
        ['Unit', [trailer, u.newUsed].filter(Boolean).join(', ') || null],
        ['Stock number', u.stockNumber],
        ['VIN', u.vin],
        ['Received', u.dateReceived ? shortDate(u.dateReceived) : 'Not received yet'],
      ]),
    },
  ];
  const mods = view.mods.map((m) => laborRow(m, m.includedAtNoCharge ? 'Included at no charge' : m.type));
  sections.push({ header: label(`Mods (${view.mods.length})`), widgets: mods.length ? mods : [{ textParagraph: { text: '<i>No mods on the deal.</i>' } }], ...(mods.length > 6 ? { collapsible: true, uncollapsibleWidgetsCount: 6 } : {}) });
  if (view.prep.length) sections.push({ header: label('PDI and prep'), widgets: view.prep.map((p) => laborRow(p, p.kind)), ...(view.prep.length > 4 ? { collapsible: true, uncollapsibleWidgetsCount: 4 } : {}) });
  const notes = rows([
    ['Sales notes', d.salesNotes],
    ['Deal notes', d.customerNotes],
  ]);
  if (notes.length) sections.push({ header: label('Notes on the deal'), widgets: notes });
  const flags = [...view.flags, others ? `LightSpeed also has this deal number in its ${others === 1 ? 'other feed' : 'other feeds'}; the open one is shown.` : null].filter(Boolean);
  if (flags.length) sections.push({ header: label('Worth a look'), widgets: [{ textParagraph: { text: flags.map((f) => `• ${escape(f)}`).join('<br>') } }], ...(flags.length > 4 ? { collapsible: true, uncollapsibleWidgetsCount: 1 } : {}) });
  sections.push({ widgets: [{ textParagraph: { text: `<i>Read from LightSpeed just now${view.partsLineCount ? `; ${view.partsLineCount} parts ${view.partsLineCount === 1 ? 'line' : 'lines'} not shown` : ''}. Not written by AI.</i>` } }] });
  return {
    fallbackText: `Deal ${dealNumber} in LightSpeed`,
    cardsV2: [{ cardId: `facts-${dealNumber}`, card: { header: { title: `Deal ${dealNumber} in LightSpeed`, subtitle: [d.experienceCenter, view.feed === 'closed' ? 'closed deal' : 'open deal'].filter(Boolean).join(' · ') }, sections } }],
  };
}

// `lookupDeal` is lightspeed/lookup.js's.
function createFacts({ lookupDeal, log }) {
  // Returns the reply: a card, or text saying why not.
  return async function facts({ dealNumber, store = 'UT', userEmail }) {
    const started = Date.now();
    try {
      const got = await lookupDeal({ store, dealNumber });
      const ms = Date.now() - started;
      if (!got.ok) {
        log('ERROR', 'lightspeed lookup failed', { dealNumber, store, reason: got.reason, user: userEmail, ms });
        if (got.reason === 'store_not_enabled') return SAY.storeOff(store);
        return /timeout/.test(got.reason) ? SAY.slow(dealNumber) : SAY.failed(dealNumber);
      }
      if (!got.found.length) {
        log('INFO', 'lightspeed lookup: not found', { dealNumber, store, user: userEmail, ms });
        return SAY.notFound(dealNumber, store);
      }
      const view = toRjbView(got.found[0]);
      log('INFO', 'lightspeed lookup', { dealNumber, store, feed: view.feed, found: got.found.length, mods: view.mods.length, prep: view.prep.length, flags: view.flags.length, user: userEmail, ms });
      return factsCard({ dealNumber, view, others: got.found.length - 1 });
    } catch (err) {
      log('ERROR', 'lightspeed lookup crashed', { dealNumber, store, error: errorFields(err), ms: Date.now() - started });
      return SAY.failed(dealNumber);
    }
  };
}

module.exports = { createFacts, factsCard, SAY };
