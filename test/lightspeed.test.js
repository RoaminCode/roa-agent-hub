'use strict';

// The hub's side of the LightSpeed lookup: the client that calls the integration's
// rjbDealLookup, the view built from its answer, and "facts <deal#>". The sample is the
// shape the function returns (its allowed fields only), with made-up values.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createDealLookup } = require('../src/lightspeed/lookup');
const { toRjbView } = require('../src/lightspeed/rjbView');
const { createFacts, SAY } = require('../src/factsJob');
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
      assert.ok(!/createDealLookup|RJB_LOOKUP_URL/.test(source), `${path.basename(file)} must go through the lookup it is handed`);
    }
  }
});
