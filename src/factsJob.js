'use strict';

// "facts <deal#>" and "ro <number>" in a direct message: the deal, or one repair order, as
// LightSpeed has it right now, read live through the integration's read-only lookup
// (lightspeed/lookup.js). No AI. It is how deal facts are checked against LightSpeed before
// any agent is trusted with them, and what a deal space will pin later. LightSpeed is the
// source of truth; nothing is written anywhere. Logs counts and timing, never what a deal
// or repair order holds.
//
// What LightSpeed lets us see of a repair order: its jobs only once it is paid, and tech
// time on it at any point. Tech time shows work happened, never that a job is finished, and
// the cards say so rather than guess.

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
  roSlow: (n) => `LightSpeed took too long to answer for repair order ${n}. Try again in a minute.`,
  roFailed: (n) => `I couldn't read repair order ${n} from LightSpeed. Blake can see what happened in the logs.`,
  roNoTrace: (n) => `LightSpeed shows repair order ${n} as not paid, with no tech time on it. Either it is open and no one has clocked onto it yet, or the number is off. LightSpeed gives a job list only once a repair order is paid.`,
};

// The most repair orders looked up for one facts card.
const MAX_ROS = 6;

const escape = (text) => noDashes(String(text)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n) => (typeof n === 'number' ? `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}` : null);
const row = (top, text) => ({ decoratedText: { topLabel: top, text: escape(text), wrapText: true } });
const rows = (pairs) => pairs.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => row(k, v));
const hours = (n) => `${Number(n) || 0} ${Number(n) === 1 ? 'hour' : 'hours'}`;
const people = (names) => (names && names.length ? names.join(', ') : null);

// "8:05 AM" from LightSpeed's local time ("2026-11-07T08:05:00"); it is already store time.
function clockTime(stamp) {
  const m = /T(\d{2}):(\d{2})/.exec(String(stamp || ''));
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

// One line on where a repair order stands, from what LightSpeed shows: paid, or tech time.
function roStanding(ro) {
  const c = ro.clock;
  const time = c.sessions.length ? `tech time ${hours(c.totalHours)}${people(c.technicians) ? ` by ${people(c.technicians)}` : ''}, last worked ${shortDate(c.lastActivity)}${c.clockedOn ? ', a tech is clocked on now' : ''}` : 'no tech time yet';
  if (ro.paid) return `Paid ${ro.paid.dates.paid ? shortDate(ro.paid.dates.paid) : ''}`.trim() + `; ${time}`;
  return `Not paid yet; ${time}`;
}

// One labor line: its title, then what kind it is, its repair order, and its labor price.
function laborRow(line, kind) {
  const ro = line.repairOrder ? `RO ${line.repairOrder.number}${line.repairOrder.status ? `, ${line.repairOrder.status}` : ''}` : 'Not on a repair order yet';
  const price = money(line.laborRetailPrice);
  return { decoratedText: { text: escape(line.title || 'Untitled line'), bottomLabel: [kind, ro, price ? `labor ${price}` : null].filter(Boolean).map(escape).join(' · '), wrapText: true } };
}

// The RJB view as a card. Every value on it is LightSpeed's own; nothing is summarized.
// `ros` is what the repair order lookups found for the deal's repair orders:
// [{ number, ro }] with `ro` null when that lookup failed.
function factsCard({ dealNumber, view, others = 0, ros = [] }) {
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
  if (ros.length) {
    sections.push({
      header: label('Repair orders'),
      widgets: [
        ...ros.map(({ number, ro }) => ({ decoratedText: { text: `RO ${escape(number)}`, bottomLabel: escape(ro ? roStanding(ro) : 'Tech time could not be read just now'), wrapText: true } })),
        { textParagraph: { text: '<i>Tech time shows work happened, not that a job is finished. Ask me for "ro" and the number for more.</i>' } },
      ],
    });
  }
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

// One repair order as a card: where it stands, its jobs when it is paid, and the tech clock.
function roCard({ ro }) {
  const { paid, clock } = ro;
  const sections = [
    {
      header: label('Where it stands'),
      widgets: rows([
        ['In LightSpeed', paid ? 'Paid (finished and cashiered)' : 'Not paid yet'],
        ['Came in', paid && paid.dates.in ? shortDate(paid.dates.in) : null],
        ['Promised', paid && paid.dates.promised ? shortDate(paid.dates.promised) : null],
        ['Work closed', paid && paid.dates.closed ? shortDate(paid.dates.closed) : null],
        ['Paid', paid && paid.dates.paid ? shortDate(paid.dates.paid) : null],
        ['Service Advisor', paid ? paid.serviceAdvisor : null],
        ['Kind', paid ? paid.category : null],
        ['Tech time', clock.sessions.length ? `${hours(clock.totalHours)}${people(clock.technicians) ? ` by ${people(clock.technicians)}` : ''}` : 'None yet'],
        ['Last worked', clock.lastActivity ? `${shortDate(clock.lastActivity)}${clock.clockedOn ? ' (a tech is clocked on now)' : ''}` : null],
      ]),
    },
  ];
  for (const unit of paid ? paid.units : []) {
    const jobs = unit.jobs.map((j) => ({
      decoratedText: {
        text: escape(j.title || j.description || 'Untitled job'),
        bottomLabel: [j.saleType, j.approval !== 'unknown' ? j.approval : null, j.actualHours ? `${hours(j.actualHours)} worked` : null, people(j.technicians), j.resolution ? `Resolution: ${j.resolution}` : null].filter(Boolean).map(escape).join(' · '),
        wrapText: true,
      },
    }));
    const name = [unit.year, unit.make, unit.model].filter(Boolean).join(' ');
    if (jobs.length) sections.push({ header: label(`Jobs${name ? ` on ${escape(name)}` : ''} (${jobs.length})`), widgets: jobs, ...(jobs.length > 6 ? { collapsible: true, uncollapsibleWidgetsCount: 6 } : {}) });
  }
  if (clock.sessions.length) {
    const sessions = [...clock.sessions].reverse().map((s) => ({
      decoratedText: {
        text: escape(`${shortDate(s.start)}, ${clockTime(s.start)}${s.end ? ` to ${clockTime(s.end)}` : ' (still clocked on)'}`),
        bottomLabel: escape([s.technician, hours(s.hours), s.saleType].filter(Boolean).join(' · ')),
        wrapText: true,
      },
    }));
    sections.push({ header: label(`Tech clock (${sessions.length}, newest first)`), widgets: sessions, ...(sessions.length > 4 ? { collapsible: true, uncollapsibleWidgetsCount: 4 } : {}) });
  }
  const limits = [
    paid ? null : 'LightSpeed gives a job list only once a repair order is paid, so the jobs on this one are not shown here. The deal\'s facts card lists its lines.',
    'Tech time shows work happened, not that a job is finished.',
    clock.truncated ? 'Only the first 500 clock sessions were read.' : null,
  ].filter(Boolean);
  sections.push({ widgets: [{ textParagraph: { text: `<i>${limits.map(escape).join(' ')} Read from LightSpeed just now. Not written by AI.</i>` } }] });
  return {
    fallbackText: `Repair order ${ro.roNumber} in LightSpeed`,
    cardsV2: [{ cardId: `ro-${ro.roNumber}`, card: { header: { title: `Repair order ${ro.roNumber} in LightSpeed`, subtitle: paid ? 'paid' : 'not paid yet' }, sections } }],
  };
}

// `lookupDeal` and `lookupRepairOrder` are lightspeed/lookup.js's. Without the second, the
// facts card leaves repair orders out.
function createFacts({ lookupDeal, lookupRepairOrder = null, log }) {
  // The deal's repair orders, each looked up: [{ number, ro }], `ro` null when that one
  // lookup failed (the card still shows the deal).
  async function repairOrdersOf(view, store) {
    if (!lookupRepairOrder) return [];
    const numbers = [...new Set([...view.mods, ...view.prep].map((l) => (l.repairOrder ? String(l.repairOrder.number).trim() : null)).filter((n) => n && /^\d{1,10}$/.test(n)))].slice(0, MAX_ROS);
    return Promise.all(
      numbers.map(async (number) => {
        const got = await lookupRepairOrder({ store, roNumber: number }).catch(() => null);
        return { number, ro: got && got.ok ? got.ro : null };
      }),
    );
  }

  // Returns the reply: a card, or text saying why not.
  async function facts({ dealNumber, store = 'UT', userEmail }) {
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
      const ros = await repairOrdersOf(view, store);
      log('INFO', 'lightspeed lookup', { dealNumber, store, feed: view.feed, found: got.found.length, mods: view.mods.length, prep: view.prep.length, flags: view.flags.length, repairOrders: ros.length, repairOrdersRead: ros.filter((r) => r.ro).length, user: userEmail, ms: Date.now() - started });
      return factsCard({ dealNumber, view, others: got.found.length - 1, ros });
    } catch (err) {
      log('ERROR', 'lightspeed lookup crashed', { dealNumber, store, error: errorFields(err), ms: Date.now() - started });
      return SAY.failed(dealNumber);
    }
  }

  // The same read without a card, for a question about the deal (askJob.js):
  // { view, ros }, or null when LightSpeed has no such deal or could not be read.
  facts.read = async function read({ dealNumber, store = 'UT' }) {
    const started = Date.now();
    const got = await lookupDeal({ store, dealNumber });
    if (!got.ok || !got.found.length) {
      log(got.ok ? 'INFO' : 'WARNING', 'lightspeed not read for a question', { dealNumber, store, reason: got.ok ? 'not_found' : got.reason, ms: Date.now() - started });
      return null;
    }
    const view = toRjbView(got.found[0]);
    const ros = await repairOrdersOf(view, store);
    log('INFO', 'lightspeed read for a question', { dealNumber, store, feed: view.feed, repairOrders: ros.length, repairOrdersRead: ros.filter((r) => r.ro).length, ms: Date.now() - started });
    return { view, ros };
  };

  // "ro <number>": one repair order. Returns a card, or text saying why not.
  facts.repairOrder = async function repairOrder({ roNumber, store = 'UT', userEmail }) {
    const started = Date.now();
    try {
      if (!lookupRepairOrder) return SAY.off;
      const got = await lookupRepairOrder({ store, roNumber });
      const ms = Date.now() - started;
      if (!got.ok) {
        log('ERROR', 'repair order lookup failed', { roNumber, store, reason: got.reason, user: userEmail, ms });
        if (got.reason === 'store_not_enabled') return SAY.storeOff(store);
        return /timeout/.test(got.reason) ? SAY.roSlow(roNumber) : SAY.roFailed(roNumber);
      }
      const { ro } = got;
      log('INFO', 'repair order lookup', { roNumber, store, paid: Boolean(ro.paid), sessions: ro.clock.sessions.length, user: userEmail, ms });
      if (!ro.paid && !ro.clock.sessions.length) return SAY.roNoTrace(roNumber);
      return roCard({ ro });
    } catch (err) {
      log('ERROR', 'repair order lookup crashed', { roNumber, store, error: errorFields(err), ms: Date.now() - started });
      return SAY.roFailed(roNumber);
    }
  };

  return facts;
}

module.exports = { createFacts, factsCard, roCard, roStanding, SAY, MAX_ROS };
