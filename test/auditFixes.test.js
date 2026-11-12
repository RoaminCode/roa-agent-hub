'use strict';

// Tests for the fixes from the 2026-11-11 audit that have no other home.

const test = require('node:test');
const assert = require('node:assert');
const { capBrief, CAPS, CALL_LIMITS, writeBrief } = require('../src/agents/roamerBrief');
const { createSheetLibrary } = require('../src/wowLibrary');
const { createHubSpotClient } = require('../src/hubspot/client');
const { createDealSpaceIndex } = require('../src/spaceJob');
const { createBriefJob, SORRY } = require('../src/briefJob');
const { createRouter, MESSAGES } = require('../src/router');
const { createDb } = require('../src/db');
const { createFakeFirestore } = require('./fakeFirestore');

test('a brief that runs past the lists the instructions cap is trimmed before it is saved', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => `item ${i}`);
  const out = capBrief({ headline: 'h', tags: many(7), key_facts: many(6), wow: many(12), commitments: many(9), mods: many(20), excites: many(6), open_questions: many(8), who: 'w' });
  assert.deepStrictEqual([out.tags.length, out.key_facts.length, out.wow.length, out.commitments.length, out.excites.length, out.open_questions.length], [5, 4, 8, 8, 5, 5]);
  assert.strictEqual(out.mods.length, 20, 'every mod in the record is listed');
  assert.strictEqual(out.wow[0], 'item 0', 'the first, most useful, are the ones kept');
  assert.deepStrictEqual(Object.keys(CAPS).sort(), ['commitments', 'excites', 'key_facts', 'open_questions', 'tags', 'wow']);
});

test('the brief call has a time limit and one retry, not the half hour the SDK allows', async () => {
  assert.ok(CALL_LIMITS.timeout <= 5 * 60 * 1000 && CALL_LIMITS.maxRetries === 1);
  const seen = [];
  const anthropic = { beta: { messages: { stream: (body, opts) => (seen.push(opts), { finalMessage: async () => ({ stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 1 } }) }) } } };
  await writeBrief({ anthropic, context: { deal: { id: '1', properties: {} }, contact: { properties: {} }, items: [], omitted: 0, clipped: 0, missing: 0 } });
  assert.deepStrictEqual(seen, [CALL_LIMITS]);
});

function sheet(rows) {
  const requests = [];
  const auth = {
    getClient: async () => ({
      request: async (r) => {
        const url = decodeURIComponent(r.url);
        requests.push([r.method, url, r.data]);
        if (r.method === 'GET' && url.endsWith("'Ideas'!A2:A")) return { data: { values: rows.map((idea) => [idea]) } };
        if (r.method === 'GET' && /'Ideas'!F\d+$/.test(url)) return { data: { values: [['4']] } };
        return { data: {} };
      },
    }),
  };
  return { requests, lib: createSheetLibrary({ sheetId: '1aQ3f46vWKeCcRyesMiRfZQUle81jIHM1mpJwmGsVpUI', auth }) };
}

test('a chosen WOW idea is counted on the row that holds it now, wherever the team moved it', async () => {
  // Suggested from row 3; still there.
  const same = sheet(['Practice course', 'Day pack', 'Trail map']);
  assert.strictEqual(await same.lib.useIdea({ ideaId: 'row-3', idea: 'Day pack' }), 'row-3');
  assert.ok(same.requests.at(-1)[1].includes("'Ideas'!F3?"));

  // The sheet was sorted since: the idea is on row 4 now, and row 3 holds another.
  const moved = sheet(['Practice course', 'Trail map', ' day PACK ']);
  assert.strictEqual(await moved.lib.useIdea({ ideaId: 'row-3', idea: 'Day pack' }), 'row-4');
  assert.deepStrictEqual([moved.requests.at(-1)[0], moved.requests.at(-1)[2]], ['PUT', { values: [[5]] }]);
  assert.ok(moved.requests.at(-1)[1].includes("'Ideas'!F4?"));

  // Deleted since: added back as new, and no other row is counted.
  const gone = sheet(['Practice course', 'Trail map']);
  assert.strictEqual(await gone.lib.useIdea({ ideaId: 'row-3', idea: 'Day pack', fitsWhen: 'Loves hiking', category: 'Gear', tier: '$$' }), null);
  assert.deepStrictEqual(gone.requests.at(-1)[2], { values: [['Day pack', 'Loves hiking', 'Gear', '$$', 'Yes', 1, 'Basecamp']] });
  assert.ok(!gone.requests.some((r) => r[0] === 'PUT'));
});

test('a HubSpot read that meets a server error or a dropped connection is tried once more; a write never is', async () => {
  const res = (status) => ({ ok: status < 400, status, json: async () => ({ id: 1 }) });
  const client = (answers) => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push(opts.method);
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return res(a);
    };
    return { calls, hubspot: createHubSpotClient({ token: 't', fetchImpl, wait: async () => {} }) };
  };
  const flaky = client([502, 200]);
  assert.deepStrictEqual(await flaky.hubspot.get('/crm/v3/owners/1'), { id: 1 });
  assert.strictEqual(flaky.calls.length, 2);

  const dropped = client([new Error('socket hang up'), 200]);
  await dropped.hubspot.post('/crm/v3/objects/calls/batch/read', {});
  assert.strictEqual(dropped.calls.length, 2);

  const down = client([500, 500, 200]);
  await assert.rejects(down.hubspot.get('/crm/v3/owners/1'), (err) => err.status === 500 && err.safe === true);
  assert.strictEqual(down.calls.length, 2, 'twice, not forever');

  const write = client([502, 200]);
  await assert.rejects(write.hubspot.createNote({ contactId: '7', body: 'x', timestamp: 't' }), (err) => err.status === 502);
  assert.strictEqual(write.calls.length, 1, 'a note is never written twice');
});

test('Home asks Chat who is in each deal space once a minute per person, not on every tap', async () => {
  const db = createDb({ firestore: createFakeFirestore() });
  await db.linkSpace({ dealId: '111', dealNumber: '90001', store: 'UT', spaceName: 'spaces/A', spaceUri: 'u', how: 'created', by: 'b' });
  let asked = 0;
  let clock = 0;
  const spacesFor = createDealSpaceIndex({ db, spaces: { isMember: async () => ((asked += 1), true) }, now: () => clock });
  await spacesFor('users/1');
  await spacesFor('users/1');
  assert.strictEqual(asked, 1);
  await spacesFor('users/2');
  assert.strictEqual(asked, 2, 'each person has their own answer');
  clock = 61 * 1000;
  assert.deepStrictEqual([...(await spacesFor('users/1'))], [['90001', { uri: 'u', member: true }]]);
  assert.strictEqual(asked, 3);
});

const accept = async () => true;
const inSpace = (text, spaceName = 'spaces/DEAL') => ({ type: 'MESSAGE', space: { name: spaceName, spaceType: 'SPACE' }, user: { email: 'blake@example.com', displayName: 'Blake' }, message: { name: `${spaceName}/messages/1`, text, argumentText: text, thread: { name: `${spaceName}/threads/1` } } });

test("a deal's own space may ask for its brief; any other space is pointed to a direct message", async () => {
  const started = [];
  const r = createRouter({ verify: accept, allowedUsers: ['blake@example.com'], startBrief: (job) => started.push(job), dealOfSpace: async (spaceName) => (spaceName === 'spaces/DEAL' ? '90001' : null) });
  const own = await r({ headers: { authorization: 'x' }, body: inSpace('brief 90001') });
  assert.deepStrictEqual(own.body, { text: MESSAGES.working('90001') });
  assert.deepStrictEqual(started, [{ spaceName: 'spaces/DEAL', dealNumber: '90001', store: 'UT', userEmail: 'blake@example.com', inDealSpace: true }]);
  const other = await r({ headers: { authorization: 'x' }, body: inSpace('brief 90002') });
  assert.deepStrictEqual(other.body, { text: MESSAGES.directOnly('90002') });
  const unlinked = await r({ headers: { authorization: 'x' }, body: inSpace('brief 90001', 'spaces/OTHER') });
  assert.deepStrictEqual(unlinked.body, { text: MESSAGES.directOnly('90001') });
  assert.strictEqual(started.length, 1);
});

test("in a deal's space the brief uses the Roamer already picked, and never posts the contact picker there", async () => {
  const sent = [];
  const loads = [];
  const run = createBriefJob({
    loadContext: async (args) => (loads.push(args), { found: true, deal: { id: '1' }, choices: [{ id: '7', name: 'Pat Sample' }], contactCount: 2 }),
    anthropic: {},
    sendMessage: async (space, message) => sent.push([space, message]),
    log: () => {},
    endpoint: 'https://example.com/',
    getBrief: async () => null,
  });
  await run({ spaceName: 'spaces/DEAL', dealNumber: '90001', inDealSpace: true });
  assert.deepStrictEqual(loads, [{ store: 'UT', dealNumber: '90001', contactId: undefined, rememberPick: true }]);
  assert.deepStrictEqual(sent, [['spaces/DEAL', SORRY.pickInDirect('90001')]]);
  assert.ok(!JSON.stringify(sent).includes('Pat Sample'));
});

test('a lock held too long and taken by another run is not released by the first', async () => {
  const firestore = createFakeFirestore();
  let clock = new Date('2026-11-12T17:00:00Z');
  const db = createDb({ firestore, now: () => clock });
  await db.withLock('qa_1', async () => {
    // The first run stalls past the lock's life; a second run takes the lock.
    clock = new Date('2026-11-12T17:01:00Z');
    firestore.data.locks.qa_1 = { token: 'second-run', at: clock.toISOString() };
  });
  assert.strictEqual(firestore.data.locks.qa_1.token, 'second-run', "the second run's lock is still held");
  await db.withLock('qa_2', async () => {});
  assert.strictEqual(firestore.data.locks.qa_2, undefined, 'its own lock is released');
});
