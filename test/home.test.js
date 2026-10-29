'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseEvent, shapeOf } = require('../src/chat/events');
const { createRouter, MESSAGES } = require('../src/router');
const { renderHome, todayIn, daysBetween, whenLabel } = require('../src/chat/homeCard');
const { createOpenDeals, parseDealName } = require('../src/hubspot/openDeals');

const BLAKE = 'blake@example.com';
const headers = { authorization: 'Bearer test' };
const accept = async () => true;

const homeEvent = (email) => ({
  commonEventObject: { hostApp: 'CHAT' },
  chat: { user: { name: 'users/123', email, displayName: 'Test User' }, eventTime: '2026-10-29T15:00:00Z' },
});

const clickEvent = (email, dealNumber, roamer) => ({
  commonEventObject: {
    invokedFunction: 'https://example.com/',
    parameters: { action: 'brief', dealNumber, ...(roamer ? { roamer } : {}) },
  },
  chat: {
    user: { name: 'users/123', email },
    eventTime: '2026-10-29T15:00:00Z',
    buttonClickedPayload: { space: { name: 'spaces/DM1', spaceType: 'DIRECT_MESSAGE' } },
  },
});

test('reads an App Home event, which has no payload', () => {
  const e = parseEvent(homeEvent(BLAKE));
  assert.strictEqual(e.type, 'APP_HOME');
  assert.strictEqual(e.userName, 'users/123');
  assert.strictEqual(parseEvent({ chat: { type: 'APP_HOME', user: { email: BLAKE } } }).type, 'APP_HOME');
});

test('reads a button click with its parameters', () => {
  const e = parseEvent(clickEvent(BLAKE, '51455'));
  assert.strictEqual(e.type, 'CARD_CLICKED');
  assert.deepStrictEqual(e.parameters, { action: 'brief', dealNumber: '51455' });
  assert.strictEqual(e.spaceName, 'spaces/DM1');
});

test('still reads an add-on message as a message', () => {
  const e = parseEvent({ chat: { user: { email: BLAKE }, eventTime: 't', messagePayload: { message: { text: 'hi' } } } });
  assert.strictEqual(e.type, 'MESSAGE');
});

test('describes an event by its keys without its values', () => {
  assert.deepStrictEqual(shapeOf({ chat: { user: { email: 'secret@example.com' }, list: [{ a: 1 }] } }), {
    chat: { user: { email: 'string' }, list: [{ a: 'number' }] },
  });
});

test('Home pushes the deals card for an allowed user', async () => {
  const router = createRouter({ verify: accept, allowedUsers: [BLAKE], buildHome: async () => ({ header: { title: 'Utah deals' } }) });
  const result = await router({ headers, body: homeEvent(BLAKE) });
  assert.deepStrictEqual(result.body, { action: { navigations: [{ pushCard: { header: { title: 'Utah deals' } } }] } });
});

test('Home shows a not-yet card to anyone else and never loads deals', async () => {
  let loaded = false;
  const router = createRouter({ verify: accept, allowedUsers: [BLAKE], buildHome: async () => ((loaded = true), {}) });
  const result = await router({ headers, body: homeEvent('someone@example.com') });
  assert.match(JSON.stringify(result.body), /isn't available to you yet/);
  assert.strictEqual(loaded, false);
});

test('tapping Brief starts the brief and answers with a pop-up, not a redrawn card', async () => {
  const started = [];
  let rebuilt = false;
  const router = createRouter({
    verify: accept,
    allowedUsers: [BLAKE],
    startBrief: (job) => started.push(job),
    buildHome: async () => ((rebuilt = true), {}),
  });
  const result = await router({ headers, body: clickEvent(BLAKE, '51455', 'Pat Sample') });
  assert.deepStrictEqual(started, [
    {
      spaceName: 'spaces/DM1',
      userName: 'users/123',
      dealNumber: '51455',
      store: 'UT',
      userEmail: BLAKE,
      announce: "I'll need just a moment to read up on Pat Sample (deal 51455).",
    },
  ]);
  assert.deepStrictEqual(result.body, { action: { notification: { text: "Pat Sample's brief (51455) is on its way to your messages." } } });
  assert.strictEqual(rebuilt, false);
  assert.strictEqual(MESSAGES.briefOnTheWay('51455'), 'The brief for deal 51455 is on its way to your messages.');
});

test('ignores a Brief tap with a malformed deal number', async () => {
  const started = [];
  const router = createRouter({ verify: accept, allowedUsers: [BLAKE], startBrief: (job) => started.push(job) });
  await router({ headers, body: clickEvent(BLAKE, '51455; drop') });
  assert.strictEqual(started.length, 0);
});

test('reads the Roamer and trailer from a deal name', () => {
  assert.deepStrictEqual(parseDealName('90001 - Pat Sample - 2026 Test Trailer XT-12'), { roamer: 'Pat Sample', trailer: '2026 Test Trailer XT-12' });
  assert.deepStrictEqual(parseDealName('90001 - Pat Sample'), { roamer: 'Pat Sample', trailer: null });
  assert.deepStrictEqual(parseDealName('Pat Sample deal'), { roamer: 'Pat Sample deal', trailer: null });
});

// A fake HubSpot for the deal list: one open deal search, the deal to contact link, the
// contact's Last Contacted, and engagement searches that find whatever `engagements` holds.
function fakeHubSpot({ pages, contactLast = {}, engagements = {}, owners = { 9: 'Casey', 12: 'Coby' } }) {
  const bodies = [];
  return {
    bodies,
    get: async (path) => ({ firstName: owners[path.split('/').pop()] || null }),
    post: async (path, body) => {
      if (path.endsWith('/deals/search')) return bodies.push(body), pages.shift();
      if (path.includes('/associations/deals/contacts/')) {
        return { results: body.inputs.map((d) => ({ from: { id: d.id }, to: [{ toObjectId: Number(`5${d.id}`) }] })) };
      }
      if (path.endsWith('/objects/contacts/batch/read')) {
        return { results: body.inputs.map((c) => ({ id: c.id, properties: { notes_last_contacted: contactLast[c.id] || null } })) };
      }
      const search = /objects\/(\w+)\/search$/.exec(path);
      if (search) return { results: (engagements[search[1]] || []).map((e) => ({ id: e.id, properties: e.properties })) };
      const assoc = /associations\/(\w+)\/contacts\/batch\/read$/.exec(path);
      if (assoc) {
        const all = engagements[assoc[1]] || [];
        return { results: body.inputs.map((x) => ({ from: { id: x.id }, to: [{ toObjectId: Number((all.find((e) => e.id === x.id) || {}).contact) }] })) };
      }
      throw new Error(`unexpected POST ${path}`);
    },
  };
}

test('lists open deals from one search, pages included', async () => {
  const hubspot = fakeHubSpot({
    pages: [
      {
        results: [{ id: '1', properties: { dealname: '90001 - Pat Sample - 2026 Test', ls_deal_number: '90001', projected_delivery_date: '2026-11-03', notes_last_contacted: '2026-10-28T15:00:00Z', hubspot_owner_id: '9' } }],
        paging: { next: { after: '1' } },
      },
      { results: [{ id: '2', properties: { dealname: '90002 - Sam Example - 2027 Test', ls_deal_number: '90002', hubspot_owner_id: '9' } }] },
    ],
  });
  const deals = await createOpenDeals({ hubspot })({ store: 'UT' });
  assert.deepStrictEqual(deals[0], {
    id: '1',
    dealNumber: '90001',
    roamer: 'Pat Sample',
    trailer: '2026 Test',
    projectedDelivery: '2026-11-03',
    lastContacted: '2026-10-28',
    lastContactBy: null,
    lastContactChannel: null,
    salesCoach: 'Casey',
  });
  assert.strictEqual(deals[1].projectedDelivery, null);
  assert.strictEqual(hubspot.bodies[1].after, '1');
  assert.deepStrictEqual(hubspot.bodies[0].filterGroups[0].filters.map((f) => f.propertyName), ['ls_cmf', 'dealstage']);
});

test("uses the Roamer's Last Contacted over the deal's, and names who made it", async () => {
  const hubspot = fakeHubSpot({
    pages: [{ results: [{ id: '1', properties: { dealname: '90001 - Pat Sample - 2026 Test', ls_deal_number: '90001', notes_last_contacted: '2026-07-16T15:33:00Z' } }] }],
    contactLast: { 51: '2026-08-06T16:50:00Z' },
    engagements: {
      calls: [{ id: 'c1', contact: 51, properties: { hs_timestamp: '2026-08-06T16:50:00.400Z', hubspot_owner_id: '12' } }],
    },
  });
  const [d] = await createOpenDeals({ hubspot })({ store: 'UT' });
  assert.strictEqual(d.lastContacted, '2026-08-06');
  assert.deepStrictEqual([d.lastContactBy, d.lastContactChannel], ['Coby', 'call']);
});

test('says the Roamer or Basecamp made the last contact when a text shows it', async () => {
  const hubspot = fakeHubSpot({
    pages: [
      {
        results: [
          { id: '1', properties: { dealname: '90001 - Pat Sample - 2026 Test', ls_deal_number: '90001' } },
          { id: '2', properties: { dealname: '90002 - Sam Example - 2026 Test', ls_deal_number: '90002' } },
        ],
      },
    ],
    contactLast: { 51: '2026-10-27T22:03:00Z', 52: '2026-10-28T10:00:00Z' },
    engagements: {
      communications: [
        { id: 't1', contact: 51, properties: { hs_timestamp: '2026-10-27T22:03:00Z', hs_communication_body: '+1 555-010-0000 has sent an SMS<br>Message:<br>Hi' } },
        { id: 't2', contact: 52, properties: { hs_timestamp: '2026-10-28T10:00:00Z', hs_communication_body: ' has sent an SMS to +1 555-010-0001<br>Message:<br>Hello' } },
      ],
    },
  });
  const deals = await createOpenDeals({ hubspot })({ store: 'UT' });
  assert.deepStrictEqual(deals.map((d) => d.lastContactBy), ['the Roamer', 'Basecamp']);
});

test('does not credit an engagement at the same moment on another Roamer', async () => {
  const hubspot = fakeHubSpot({
    pages: [{ results: [{ id: '1', properties: { dealname: '90001 - Pat Sample - 2026 Test', ls_deal_number: '90001' } }] }],
    contactLast: { 51: '2026-10-27T22:03:00Z' },
    engagements: { calls: [{ id: 'c9', contact: 99, properties: { hs_timestamp: '2026-10-27T22:03:00Z', hubspot_owner_id: '12' } }] },
  });
  const [d] = await createOpenDeals({ hubspot })({ store: 'UT' });
  assert.strictEqual(d.lastContactBy, null);
});

const NOW = new Date('2026-10-29T18:00:00Z');
const deal = (n, delivery, contacted, by = null, channel = null) => ({
  id: n,
  dealNumber: n,
  roamer: `Roamer ${n}`,
  trailer: '2026 Test',
  projectedDelivery: delivery,
  lastContacted: contacted,
  lastContactBy: by,
  lastContactChannel: channel,
  salesCoach: 'Casey',
});
const home = (deals, extra = {}) => renderHome({ deals, endpoint: 'https://example.com/', shadow: true, now: NOW, ...extra });

// Reads one deal tile back into its parts.
function tile(section) {
  const [top, delivery, contact] = section.widgets;
  const [left, right] = top.columns.columnItems;
  return {
    header: section.header ? section.header.replace(/<[^>]+>/g, '') : null,
    roamer: left.widgets[0].decoratedText,
    coach: right.widgets[0].decoratedText,
    delivery: delivery.decoratedText.text,
    contact: contact.decoratedText.text,
    button: contact.decoratedText.button,
  };
}
const tiles = (card) => card.sections.filter((s) => s.widgets[0].columns).map(tile);

test('counts days in Mountain time', () => {
  assert.strictEqual(todayIn('America/Denver', new Date('2026-10-30T03:00:00Z')), '2026-10-29');
  assert.strictEqual(daysBetween('2026-10-29', '2026-11-03'), 5);
  assert.deepStrictEqual([0, 1, 5, -1, -3].map(whenLabel), ['today', 'tomorrow', 'in 5 days', '1 day past', '3 days past']);
});

test('groups deals by how soon they deliver, one tile per deal, skipping empty groups', () => {
  const card = home([deal('90001', '2026-11-03', '2026-10-28'), deal('90002', '2026-11-04', '2026-10-28'), deal('90003', '2026-11-30', '2026-10-28'), deal('90004', null, '2026-10-28')]);
  assert.deepStrictEqual(card.header, { title: 'Utah deals', subtitle: '4 open · Oct 29' });
  assert.deepStrictEqual(tiles(card).map((t) => t.header), ['THIS WEEK 2', null, 'LATER 1', 'NO DELIVERY DATE 1']);
});

test('lays out a tile: Roamer with Sales Coach at top right, delivery row, last contact row with Brief', () => {
  const [t] = tiles(home([deal('90001', '2026-11-03', '2026-10-28', 'Coby', 'call')], { shadow: false }));
  assert.strictEqual(t.roamer.topLabel, '90001 · 2026 Test');
  assert.strictEqual(t.roamer.text, '<b>Roamer 90001</b>');
  assert.deepStrictEqual(t.roamer.startIcon, { materialIcon: { name: 'rv_hookup' } });
  assert.deepStrictEqual([t.coach.topLabel, t.coach.text], ['Sales Coach', 'Casey']);
  assert.strictEqual(t.delivery, 'Delivery Nov 3 (in 5 days)');
  assert.strictEqual(t.contact, 'Last contact Oct 28, Coby (call)');
  assert.deepStrictEqual(t.button.onClick.action, {
    function: 'https://example.com/',
    parameters: [
      { key: 'action', value: 'brief' },
      { key: 'dealNumber', value: '90001' },
      { key: 'roamer', value: 'Roamer 90001' },
    ],
  });
});

test('turns the last contact row amber when a deal inside six weeks has gone quiet', () => {
  const [quiet, never] = tiles(home([deal('90001', '2026-11-03', '2026-10-15', 'Casey', 'email'), deal('90002', '2026-11-04', null)]));
  assert.match(quiet.contact, /#C27C0E/);
  assert.match(quiet.contact, /No contact in 14 days · last Oct 15, Casey \(email\)/);
  assert.match(never.contact, /#C27C0E.*No contact logged yet/);
});

test('flags quiet deals only when delivery is within six weeks or past due', () => {
  const byNumber = Object.fromEntries(
    tiles(home([deal('90001', '2026-12-10', '2026-10-01'), deal('90002', '2027-01-15', '2026-10-01'), deal('90003', '2026-10-20', '2026-10-01'), deal('90004', null, null)])).map((t) => [
      t.roamer.topLabel.slice(0, 5),
      t.contact,
    ]),
  );
  assert.match(byNumber['90001'], /No contact in 28 days/);
  assert.strictEqual(byNumber['90002'], 'Last contact Oct 1');
  assert.match(byNumber['90003'], /No contact in 28 days/);
  assert.strictEqual(byNumber['90004'], 'No contact logged yet');
});

test('puts deals delivering in under three days, or past due, in an orange On deck group', () => {
  const card = home([deal('90001', '2026-10-30', '2026-10-28'), deal('90002', '2026-10-27', '2026-10-28'), deal('90003', '2026-11-01', '2026-10-28')]);
  const [first, second, third] = tiles(card);
  assert.deepStrictEqual([first.header, second.header, third.header], ['ON DECK 2', null, 'THIS WEEK 1']);
  assert.match(card.sections[0].header, /#E2692E/);
  assert.match(first.delivery, /#E2692E.*Delivers tomorrow.*· Oct 30/);
  assert.match(second.delivery, /2 days past delivery date/);
  assert.deepStrictEqual(first.roamer.startIcon, { materialIcon: { name: 'rv_hookup', fill: true } });
  assert.strictEqual(third.delivery, 'Delivery Nov 1 (in 3 days)');
  assert.deepStrictEqual(third.roamer.startIcon, { materialIcon: { name: 'rv_hookup' } });
});

test('words the urgent delivery line plainly', () => {
  const { deliversLabel } = require('../src/chat/homeCard');
  assert.deepStrictEqual([0, 1, 2, -1, -4].map(deliversLabel), [
    'Delivers today',
    'Delivers tomorrow',
    'Delivers in 2 days',
    '1 day past delivery date',
    '4 days past delivery date',
  ]);
});

test('escapes deal text in Home tiles', () => {
  const [t] = tiles(home([{ ...deal('90001', '2026-11-03', '2026-10-28', 'Pat <i>', 'text'), roamer: 'Pat <b>' }]));
  assert.strictEqual(t.roamer.text, '<b>Pat &lt;b&gt;</b>');
  assert.match(t.contact, /Pat &lt;i&gt; \(text\)/);
});

test('a second Brief tap on the same deal within two minutes does not start another brief', async () => {
  let clock = 1000000;
  const started = [];
  const router = createRouter({ verify: accept, allowedUsers: [BLAKE], startBrief: (job) => started.push(job.dealNumber), now: () => clock });
  await router({ headers, body: clickEvent(BLAKE, '51455') });
  clock += 30 * 1000;
  const repeat = (await router({ headers, body: clickEvent(BLAKE, '51455') })).body;
  await router({ headers, body: clickEvent(BLAKE, '51431') });
  clock += 3 * 60 * 1000;
  await router({ headers, body: clickEvent(BLAKE, '51455') });
  assert.deepStrictEqual(started, ['51455', '51431', '51455']);
  assert.match(repeat.action.notification.text, /on its way/);
});