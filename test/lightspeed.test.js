'use strict';

// The hub's side of the LightSpeed lookup: the client that calls the integration's
// rjbDealLookup, the view built from its answer, and "facts <deal#>". The sample is the
// shape the function returns (its allowed fields only), with made-up values.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createDealLookup, createLightSpeed } = require('../src/lightspeed/lookup');
const { toRjbView } = require('../src/lightspeed/rjbView');
const { createFacts, roStanding, SAY } = require('../src/factsJob');
const { createRouter, parseCommand, MESSAGES } = require('../src/router');

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'rjb-lookup-sample.json'), 'utf8'));
const URL = 'https://rjbdeallookup-example-uc.a.run.app';

// A GoogleAuth stand-in: records the audience asked for and each request made with the token.
function fakeAuth(answer) {
  const seen = { audiences: [], requests: [] };
  return {
    seen,
    getIdTokenClient: async (audience) => {
      seen.audiences.push(audience);
      return { request: async (opts) => (seen.requests.push(opts), typeof answer === 'function' ? answer(opts) : answer) };
    },
  };
}

test('the lookup calls the function as the hub itself, for one store and one deal number', async () => {
  const auth = fakeAuth({ status: 200, data: SAMPLE });
  const lookup = createDealLookup({ url: URL, auth });
  const got = await lookup({ store: 'UT', dealNumber: '90001' });
  assert.strictEqual(got.ok, true);
  assert.strictEqual(got.found[0].deal.DealNo, '90001');
  assert.deepStrictEqual(auth.seen.audiences, [URL], 'the identity token is made for the function, and nothing else');
  const [req] = auth.seen.requests;
  assert.deepStrictEqual([req.url, req.method, req.data], [URL, 'POST', { store: 'ROA1', dealNo: '90001' }]);
  assert.ok(req.timeout > 0 && req.timeout <= 20000);
  // The token client is made once and reused.
  await lookup({ dealNumber: '90002' });
  assert.strictEqual(auth.seen.audiences.length, 1);
});

test('a failure is a failure with a short label, never "not found"', async () => {
  const reason = async (answer) => (await createDealLookup({ url: URL, auth: fakeAuth(answer) })({ dealNumber: '90001' })).reason;
  assert.strictEqual(await reason({ status: 502, data: { ok: false, reason: 'lightspeed_http_403' } }), 'lightspeed_http_403');
  assert.strictEqual(await reason({ status: 400, data: { ok: false, reason: 'store_not_enabled' } }), 'store_not_enabled');
  assert.strictEqual(await reason({ status: 403, data: '<html>Forbidden</html>' }), 'http_403');
  assert.strictEqual(await reason({ status: 502, data: { ok: false, reason: 'A long sentence with a Roamer name in it' } }), 'http_502', 'only a short label is passed on');
  assert.strictEqual(await reason({ status: 200, data: { ok: true } }), 'http_200', 'an answer in the wrong shape is not trusted');
  assert.strictEqual(await reason(() => { throw Object.assign(new Error('timeout of 20000ms exceeded'), { code: 'ETIMEDOUT' }); }), 'lookup_timeout');
  assert.strictEqual(await reason(() => { throw new Error('getaddrinfo ENOTFOUND'); }), 'lookup_unreachable');
  const none = await createDealLookup({ url: URL, auth: fakeAuth({ status: 200, data: { ok: true, result: { found: [] } } }) })({ dealNumber: '90001' });
  assert.deepStrictEqual(none, { ok: true, found: [] });
});

test('the lookup refuses a bad address, store, or deal number before calling anything', async () => {
  assert.throws(() => createDealLookup({ url: 'http://not-https.example' }), /URL looks wrong/);
  assert.throws(() => createDealLookup({ url: '' }), /URL looks wrong/);
  const auth = fakeAuth({ status: 200, data: SAMPLE });
  const lookup = createDealLookup({ url: URL, auth });
  await assert.rejects(lookup({ store: 'XX', dealNumber: '90001' }), /unknown store/);
  await assert.rejects(lookup({ dealNumber: "90001' or 1 eq 1" }), /invalid deal number/);
  assert.deepStrictEqual(auth.seen.requests, []);
});

test('the view reads the function’s answer: feed, mods, PDI, and the Roamer from HubSpot', () => {
  const view = toRjbView(SAMPLE, { roamer: { name: 'Pat Sample', firstName: 'Pat' } });
  assert.deepStrictEqual([view.version, view.feed, view.deal.experienceCenter, view.deal.state, view.deal.deposit], [2, 'open', 'Utah', 'Deal', 1000]);
  assert.deepStrictEqual(view.roamer, { name: 'Pat Sample', firstName: 'Pat', city: null, state: null });
  assert.deepStrictEqual(view.mods.map((m) => [m.type, m.title]), [['Customer Add', 'Solar panel install'], ['Dealer Add', 'Leveling jacks']]);
  assert.deepStrictEqual(view.prep.map((p) => [p.kind, p.repairOrder.number]), [['PDI', 'R1002']]);
  assert.ok(view.flags.some((f) => /not on a repair order yet.*Leveling jacks/i.test(f)));
  assert.strictEqual(view.deal.salesNotes, 'Promised a full propane tank.');
  assert.strictEqual(view.partsLineCount, 1);
  // With no name handed in, the Roamer is left blank, never guessed.
  assert.strictEqual(toRjbView(SAMPLE.result.found[0]).roamer.name, null);
  // A closed deal has no state and carries its deposit on the deal.
  const closed = toRjbView({ store: 'ROA1', feed: 'closed', deal: { DealNo: '90002', stagename: 'Finalized', deposit: 2500, Units: [{ VIN: '1SAMPLE0000000002' }] } });
  assert.deepStrictEqual([closed.feed, closed.deal.state, closed.deal.deposit], ['closed', null, 2500]);
});

test('facts shows the deal as LightSpeed has it, and says plainly when it cannot', async () => {
  const logs = [];
  const facts = (answer) => createFacts({ lookupDeal: async () => answer, log: (...l) => logs.push(l) })({ dealNumber: '90001', store: 'UT', userEmail: 'b@example.com' });
  const card = await facts({ ok: true, found: SAMPLE.result.found });
  const text = JSON.stringify(card);
  assert.strictEqual(card.cardsV2[0].card.header.title, 'Deal 90001 in LightSpeed');
  for (const shown of ['Casey Coach', '1SAMPLE0000000001', 'S1001', 'Solar panel install', 'RO R1001, In Process', 'Not on a repair order yet', 'Promised a full propane tank.', 'Nov 20', '$1,000', 'Not written by AI']) {
    assert.ok(text.includes(shown), `${shown} is on the card`);
  }
  assert.strictEqual(await facts({ ok: true, found: [] }), SAY.notFound('90001', 'UT'));
  assert.strictEqual(await facts({ ok: false, reason: 'lightspeed_http_403' }), SAY.failed('90001'));
  assert.strictEqual(await facts({ ok: false, reason: 'lookup_timeout' }), SAY.slow('90001'));
  assert.strictEqual(await facts({ ok: false, reason: 'store_not_enabled' }), SAY.storeOff('UT'));
  // Logs hold counts and labels, never what the deal says.
  const logged = JSON.stringify(logs);
  assert.ok(logged.includes('lightspeed lookup') && !logged.includes('Casey') && !logged.includes('1SAMPLE') && !logged.includes('propane'));
  const crashed = await createFacts({ lookupDeal: async () => { throw new Error('boom'); }, log: () => {} })({ dealNumber: '90001' });
  assert.strictEqual(crashed, SAY.failed('90001'));
});

test('the router: "facts <deal#>" works in a direct message for anyone allowed, with no AI credits', async () => {
  assert.deepStrictEqual(parseCommand('facts 90001'), { command: 'facts', dealNumber: '90001', store: 'UT' });
  assert.deepStrictEqual(parseCommand('LightSpeed for deal #90001 ut'), { command: 'facts', dealNumber: '90001', store: 'UT' });
  const started = [];
  const headers = { authorization: 'x' };
  const msg = (spaceType, text) => ({ type: 'MESSAGE', space: { name: 'spaces/S', spaceType }, user: { email: 'c@example.com', name: 'users/5' }, message: { name: 'spaces/S/messages/1', text } });
  // Not on the AI list, AI paused, and over the limit: facts still work.
  const r = createRouter({ verify: async () => true, allowedUsers: ['c@example.com'], aiUsers: [], aiPaused: true, overDailyLimit: async () => true, startFacts: (j) => started.push(j) });
  assert.deepStrictEqual((await r({ headers, body: msg('DIRECT_MESSAGE', 'facts 90001') })).body, { text: MESSAGES.factsWorking('90001') });
  assert.deepStrictEqual(started, [{ spaceName: 'spaces/S', dealNumber: '90001', store: 'UT', userEmail: 'c@example.com' }]);
  assert.deepStrictEqual((await r({ headers, body: msg('SPACE', 'facts 90001') })).body, { text: MESSAGES.factsDirectOnly('90001') });
  assert.deepStrictEqual((await r({ headers, body: msg('DIRECT_MESSAGE', 'facts 90001 SC') })).body, { text: MESSAGES.unknownStore('SC') });
  assert.strictEqual(started.length, 1);
  const off = createRouter({ verify: async () => true, allowedUsers: ['c@example.com'] });
  assert.deepStrictEqual((await off({ headers, body: msg('DIRECT_MESSAGE', 'facts 90001') })).body, { text: MESSAGES.factsOff });
});

test('the router: deal facts post in that deal\'s own space only, and a repair order in any deal\'s space', async () => {
  const facts = [];
  const ros = [];
  const headers = { authorization: 'x' };
  const msg = (space, text) => ({ type: 'MESSAGE', space: { name: space, spaceType: 'SPACE' }, user: { email: 'c@example.com', name: 'users/5' }, message: { name: `${space}/messages/1`, text, thread: { name: `${space}/threads/T1` } } });
  const r = createRouter({
    verify: async () => true,
    allowedUsers: ['c@example.com'],
    aiUsers: [],
    startFacts: (j) => facts.push(j),
    startRo: (j) => ros.push(j),
    dealOfSpace: async (spaceName) => {
      if (spaceName === 'spaces/BROKEN') throw new Error('database down');
      return spaceName === 'spaces/DEAL' ? '90001' : null;
    },
  });
  // The deal's own space: the card goes to the thread it was asked in.
  assert.deepStrictEqual((await r({ headers, body: msg('spaces/DEAL', 'facts 90001') })).body, { text: MESSAGES.factsWorking('90001') });
  assert.deepStrictEqual(facts, [{ spaceName: 'spaces/DEAL', dealNumber: '90001', store: 'UT', userEmail: 'c@example.com', threadName: 'spaces/DEAL/threads/T1' }]);
  // Another deal there, a space with no deal, and a space that could not be checked: refused.
  assert.deepStrictEqual((await r({ headers, body: msg('spaces/DEAL', 'facts 90002') })).body, { text: MESSAGES.factsDirectOnly('90002') });
  assert.deepStrictEqual((await r({ headers, body: msg('spaces/OTHER', 'facts 90001') })).body, { text: MESSAGES.factsDirectOnly('90001') });
  assert.deepStrictEqual((await r({ headers, body: msg('spaces/BROKEN', 'facts 90001') })).body, { text: MESSAGES.factsDirectOnly('90001') });
  assert.strictEqual(facts.length, 1);
  // A repair order: any deal's space, never a space with no deal.
  assert.deepStrictEqual((await r({ headers, body: msg('spaces/DEAL', 'ro 10001') })).body, { text: MESSAGES.roWorking('10001') });
  assert.deepStrictEqual(ros, [{ spaceName: 'spaces/DEAL', roNumber: '10001', store: 'UT', userEmail: 'c@example.com', threadName: 'spaces/DEAL/threads/T1' }]);
  assert.deepStrictEqual((await r({ headers, body: msg('spaces/OTHER', 'ro 10001') })).body, { text: MESSAGES.roDirectOnly('10001') });
  assert.deepStrictEqual((await r({ headers, body: msg('spaces/BROKEN', 'ro 10001') })).body, { text: MESSAGES.roDirectOnly('10001') });
  assert.strictEqual(ros.length, 1);
});

// A repair order as the function returns it: made-up values, the function's real shape.
const SESSION = (start, end, hrs, loggedOut = true) => ({ technician: 'Terry Tech', start, end, hours: hrs, loggedOut, saleType: 'internal' });
const OPEN_RO = { roNumber: '10001', paid: null, clock: { sessions: [SESSION('2026-11-07T08:00:00', '2026-11-07T10:30:00', 2.5), SESSION('2026-11-10T13:05:00', null, 0.5, false)], totalHours: 3, technicians: ['Terry Tech'], lastActivity: '2026-11-10T13:05:00', clockedOn: true, truncated: false } };
const PAID_RO = {
  roNumber: '10002',
  paid: {
    roNumber: '10002',
    category: '1-New Unit',
    serviceAdvisor: 'Sam Advisor',
    dates: { in: '2026-11-01T09:00:00', promised: null, closed: '2026-11-08T16:00:00', paid: '2026-11-09T10:00:00' },
    units: [{ vin: '1SAMPLE0000000001', stockNumber: 'S1001', year: '2026', make: 'Sample', model: 'XT16', jobs: [{ title: 'Solar panel install', description: 'Install 200W solar', saleType: 'To Sales - Customer Add', approval: 'approved', warranty: false, internal: true, partsOnly: false, resolution: 'Installed and tested.', techNotes: null, recommendations: null, billedHours: 2, actualHours: 2.5, technicians: ['Terry Tech'], laborClosedAt: '2026-11-08T15:30:00', parts: [] }] }],
  },
  clock: { sessions: [SESSION('2026-11-07T08:00:00', '2026-11-07T10:30:00', 2.5)], totalHours: 2.5, technicians: ['Terry Tech'], lastActivity: '2026-11-07T10:30:00', clockedOn: false, truncated: false },
};
const NO_TRACE = { roNumber: '10003', paid: null, clock: { sessions: [], totalHours: 0, technicians: [], lastActivity: null, clockedOn: false, truncated: false } };

test('a repair order is asked for by its number, and only a well-formed answer is trusted', async () => {
  const auth = fakeAuth({ status: 200, data: { ok: true, result: { ro: OPEN_RO } } });
  const { lookupRepairOrder } = createLightSpeed({ url: URL, auth });
  const got = await lookupRepairOrder({ store: 'UT', roNumber: '10001' });
  assert.deepStrictEqual([got.ok, got.ro.roNumber], [true, '10001']);
  assert.deepStrictEqual(auth.seen.requests[0].data, { store: 'ROA1', roNo: '10001' });
  await assert.rejects(lookupRepairOrder({ roNumber: "1' or 1 eq 1" }), /invalid repair order number/);
  const wrong = await createLightSpeed({ url: URL, auth: fakeAuth({ status: 200, data: { ok: true, result: { found: [] } } }) }).lookupRepairOrder({ roNumber: '10001' });
  assert.deepStrictEqual(wrong, { ok: false, reason: 'http_200' });
  const down = await createLightSpeed({ url: URL, auth: fakeAuth({ status: 502, data: { ok: false, reason: 'lightspeed_http_403' } }) }).lookupRepairOrder({ roNumber: '10001' });
  assert.deepStrictEqual(down, { ok: false, reason: 'lightspeed_http_403' });
});

test('where a repair order stands is said from what LightSpeed shows, never more', () => {
  assert.strictEqual(roStanding(OPEN_RO), 'Not paid yet; tech time 3 hours by Terry Tech, last worked Nov 10, a tech is clocked on now');
  assert.strictEqual(roStanding(PAID_RO), 'Paid Nov 9; tech time 2.5 hours by Terry Tech, last worked Nov 7');
  assert.strictEqual(roStanding(NO_TRACE), 'Not paid yet; no tech time yet');
  for (const ro of [OPEN_RO, NO_TRACE]) assert.ok(!/done|finished|complete|installed/i.test(roStanding(ro)), 'an open repair order is never called done');
});

test('the facts card shows tech time for each of the deal’s repair orders, and survives one that fails', async () => {
  const asked = [];
  const lookupRepairOrder = async ({ roNumber, store }) => {
    asked.push([roNumber, store]);
    if (roNumber === 'R1002') throw new Error('never asked: not digits');
    return roNumber === '1001' ? { ok: true, ro: { ...OPEN_RO, roNumber: '1001' } } : { ok: false, reason: 'lightspeed_http_500' };
  };
  // The sample's repair order numbers, as digits like LightSpeed's real ones.
  const found = JSON.parse(JSON.stringify(SAMPLE.result.found).replace(/R1001/g, '1001').replace(/R1002/g, '1002'));
  const logs = [];
  const card = await createFacts({ lookupDeal: async () => ({ ok: true, found }), lookupRepairOrder, log: (...l) => logs.push(l) })({ dealNumber: '90001', store: 'UT', userEmail: 'b@example.com' });
  const text = JSON.stringify(card);
  assert.deepStrictEqual(asked.sort(), [['1001', 'UT'], ['1002', 'UT']], 'each repair order on the deal is asked for once');
  assert.ok(text.includes('Repair orders') && text.includes('Not paid yet; tech time 3 hours by Terry Tech, last worked Nov 10'));
  assert.ok(text.includes('Tech time could not be read just now'), 'one failed repair order does not hide the deal');
  assert.ok(text.includes('not that a job is finished'));
  assert.deepStrictEqual([logs.at(-1)[2].repairOrders, logs.at(-1)[2].repairOrdersRead], [2, 1]);
  // Without the repair order lookup the card is the deal alone.
  const plain = await createFacts({ lookupDeal: async () => ({ ok: true, found }), log: () => {} })({ dealNumber: '90001' });
  assert.ok(!JSON.stringify(plain).includes('Repair orders'));
});

test('ro shows one repair order: its jobs when paid, tech time either way, and what cannot be known', async () => {
  const logs = [];
  const ro = (answer) => createFacts({ lookupDeal: async () => ({ ok: true, found: [] }), lookupRepairOrder: async () => answer, log: (...l) => logs.push(l) }).repairOrder({ roNumber: answer.ro ? answer.ro.roNumber : '10001', store: 'UT', userEmail: 'b@example.com' });
  const open = JSON.stringify(await ro({ ok: true, ro: OPEN_RO }));
  for (const shown of ['Repair order 10001 in LightSpeed', 'not paid yet', '3 hours by Terry Tech', 'a tech is clocked on now', 'Nov 10, 1:05 PM (still clocked on)', 'Nov 7, 8:00 AM to 10:30 AM', 'gives a job list only once a repair order is paid', 'not that a job is finished']) {
    assert.ok(open.includes(shown), `${shown} is on the open card`);
  }
  const paid = JSON.stringify(await ro({ ok: true, ro: PAID_RO }));
  for (const shown of ['Paid (finished and cashiered)', 'Sam Advisor', 'Solar panel install', 'approved', 'Resolution: Installed and tested.', 'Jobs on 2026 Sample XT16 (1)']) {
    assert.ok(paid.includes(shown), `${shown} is on the paid card`);
  }
  assert.strictEqual(await ro({ ok: true, ro: NO_TRACE }), SAY.roNoTrace('10003'));
  assert.strictEqual(await ro({ ok: false, reason: 'lightspeed_http_403' }), SAY.roFailed('10001'));
  assert.strictEqual(await ro({ ok: false, reason: 'lookup_timeout' }), SAY.roSlow('10001'));
  const logged = JSON.stringify(logs);
  assert.ok(logged.includes('repair order lookup') && !logged.includes('Terry') && !logged.includes('Solar'));
});

test('the router: "ro <number>" works in a direct message, like facts', async () => {
  assert.deepStrictEqual(parseCommand('ro 300686'), { command: 'ro', roNumber: '300686', store: 'UT' });
  assert.deepStrictEqual(parseCommand('Repair order #300686'), { command: 'ro', roNumber: '300686', store: 'UT' });
  const started = [];
  const headers = { authorization: 'x' };
  const msg = (spaceType, text) => ({ type: 'MESSAGE', space: { name: 'spaces/S', spaceType }, user: { email: 'c@example.com', name: 'users/5' }, message: { name: 'spaces/S/messages/1', text } });
  const r = createRouter({ verify: async () => true, allowedUsers: ['c@example.com'], aiUsers: [], startRo: (j) => started.push(j) });
  assert.deepStrictEqual((await r({ headers, body: msg('DIRECT_MESSAGE', 'ro 300686') })).body, { text: MESSAGES.roWorking('300686') });
  assert.deepStrictEqual(started, [{ spaceName: 'spaces/S', roNumber: '300686', store: 'UT', userEmail: 'c@example.com' }]);
  assert.deepStrictEqual((await r({ headers, body: msg('SPACE', 'ro 300686') })).body, { text: MESSAGES.roDirectOnly('300686') });
  const off = createRouter({ verify: async () => true, allowedUsers: ['c@example.com'] });
  assert.deepStrictEqual((await off({ headers, body: msg('DIRECT_MESSAGE', 'ro 300686') })).body, { text: MESSAGES.factsOff });
});

test('the hub reaches LightSpeed through the lookup function only, and holds no LightSpeed credential', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (entry.name.endsWith('.js')) files.push(path.join(dir, entry.name));
    }
  };
  walk(path.join(__dirname, '..', 'src'));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(!/lightspeeddataservices|pch\.v-sept|LIGHTSPEED_(API_KEY|GATEWAY)/i.test(source), `${path.basename(file)} must not talk to LightSpeed directly`);
    if (!file.endsWith(path.join('lightspeed', 'lookup.js')) && !file.endsWith('server.js')) {
      assert.ok(!/createDealLookup|createLightSpeed|RJB_LOOKUP_URL/.test(source), `${path.basename(file)} must go through the lookup it is handed`);
    }
  }
});
