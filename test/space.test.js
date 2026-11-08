'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createSpaceJob, createAccessRequests, createDealSpaceIndex, SAY, ACCESS } = require('../src/spaceJob');
const { createSpaces } = require('../src/chat/spaces');
const { createRouter, parseCommand, MESSAGES } = require('../src/router');
const { renderBriefNote, parseBriefNote } = require('../src/agents/briefNote');
const { cleanText } = require('../src/hubspot/dealContext');
const { createBriefNoteSaver } = require('../src/hubspot/briefNotes');
const { createDb } = require('../src/db');
const { createFakeFirestore } = require('./fakeFirestore');

const NOW = new Date('2026-11-07T17:00:00Z');
const brief = { headline: 'Pat is excited.', tags: [], key_facts: [], wow: [], mods: [], commitments: [], who: 'Pat is a first-time owner.', excites: ['Moab in March'], journey_summary: 'Deposit in October.', open_questions: ['Can the kids come?'] };
const context = (over = {}) => ({
  found: true,
  store: 'UT',
  deal: { id: '111', properties: { dealstage: '85341732', projected_delivery_date: '2026-11-14T00:00:00Z' } },
  contact: { id: '222', properties: { firstname: 'Pat', lastname: 'Sample' } },
  salesCoach: 'Casey Coach',
  items: [],
  briefNote: null,
  spaceName: null,
  ...over,
});

// A space job with every outside call recorded, and Basecamp's database in memory.
function harness({ ctx = context(), found = null, createError = null, memberError = null, brief: got = { brief, reused: true }, data = {} } = {}) {
  const calls = [];
  const logs = [];
  const firestore = createFakeFirestore(data);
  const db = createDb({ firestore, now: () => NOW });
  const { openSpace: job, useSpace } = createSpaceJob({
    loadContext: async (q) => (calls.push(['load', q]), ctx),
    getBrief: async () => (calls.push(['brief']), got),
    keepNote: async (args) => calls.push(['note', args.spaceName]),
    spaces: {
      findSpace: async (name) => (calls.push(['find', name]), name === 'spaces/MINE' ? { name, uri: 'https://chat.google.com/room/MINE' } : found),
      createSpace: async (args) => {
        calls.push(['create', args.displayName, args.description]);
        if (createError) throw createError;
        return { name: 'spaces/NEW', uri: 'https://chat.google.com/room/NEW' };
      },
      addMember: async (space, user) => {
        calls.push(['member', space, user]);
        if (memberError) throw memberError;
      },
    },
    db,
    sendMessage: async (space, message) => calls.push(['send', space, typeof message === 'string' ? message : message.cardsV2[0].cardId]),
    log: (...args) => logs.push(args),
    avatarUrl: 'https://example.com/a.png',
  });
  const run = () => job({ spaceName: 'spaces/DM', userName: 'users/1', userEmail: 'blake@example.com', dealNumber: '90001', store: 'UT' });
  const use = () => useSpace({ spaceName: 'spaces/MINE', userEmail: 'blake@example.com', dealNumber: '90001', store: 'UT' });
  return { calls, logs, run, use, data: firestore.data, db };
}

test('"use this space": records the space, posts the brief and pin reminder there, keeps the note', async () => {
  const { calls, logs, use, data } = harness();
  await use();
  assert.deepStrictEqual(calls, [
    ['load', { store: 'UT', dealNumber: '90001', rememberPick: true }],
    ['find', 'spaces/MINE'],
    ['brief'],
    ['send', 'spaces/MINE', 'brief-90001'],
    ['send', 'spaces/MINE', SAY.pinIt],
    ['note', 'spaces/MINE'],
  ]);
  assert.strictEqual(logs.at(-1)[1], 'deal space adopted');
  const { updatedAt, ...deal } = data.deals['111'];
  assert.ok(updatedAt);
  assert.deepStrictEqual(deal, {
    dealNumber: '90001',
    store: 'UT',
    spaceName: 'spaces/MINE',
    spaceUri: 'https://chat.google.com/room/MINE',
    spaceHow: 'adopted',
    spaceLinkedAt: NOW.toISOString(),
    spaceLinkedBy: 'blake@example.com',
    spaceBriefPosted: true,
    spaceClaim: null,
  });
  assert.strictEqual(data.spaces.MINE.status, 'ready');
  assert.strictEqual(data.spaces.MINE.dealId, '111');
});

test('"use this space" keeps one space per deal; asked again in the same space it re-posts', async () => {
  const other = harness({ ctx: context({ spaceName: 'spaces/OLD' }), found: { name: 'spaces/OLD', uri: 'https://chat.google.com/room/OLD' } });
  await other.use();
  assert.deepStrictEqual(other.calls.at(-1), ['send', 'spaces/MINE', SAY.exists('90001', 'https://chat.google.com/room/OLD')]);

  const same = harness({ ctx: context({ spaceName: 'spaces/MINE' }) });
  await same.use();
  assert.deepStrictEqual(same.calls.at(-1), ['note', 'spaces/MINE']);
});

function accessHarness({ found = { deal: { id: '1' }, spaceName: 'spaces/DEAL' }, exists = true, member = false } = {}) {
  const calls = [];
  const firestore = createFakeFirestore();
  const request = createAccessRequests({
    findDealSpace: async () => found,
    spaces: {
      findSpace: async (name) => (exists ? { name, uri: 'https://chat.google.com/room/DEAL' } : null),
      isMember: async () => member,
    },
    db: createDb({ firestore, now: () => NOW }),
    sendMessage: async (space, text) => calls.push([space, text]),
    findDirectMessage: async () => 'spaces/DM',
    log: () => {},
  });
  const run = () => request({ dealNumber: '90001', userName: 'users/2', userEmail: 'casey@example.com', userDisplayName: 'Casey Coach' });
  return { calls, run, data: firestore.data };
}

test('request access asks in the deal space, tells the person, and records the request', async () => {
  const { calls, run, data } = accessHarness();
  await run();
  assert.deepStrictEqual(calls, [
    ['spaces/DEAL', ACCESS.asked('Casey Coach (casey@example.com)')],
    ['spaces/DM', ACCESS.sent('90001')],
  ]);
  assert.deepStrictEqual(Object.values(data.accessRequests), [{ dealId: '1', spaceName: 'spaces/DEAL', user: 'casey@example.com', at: NOW.toISOString() }]);
  const inIt = accessHarness({ member: true });
  await inIt.run();
  assert.deepStrictEqual(inIt.calls, [['spaces/DM', ACCESS.already('90001', 'https://chat.google.com/room/DEAL')]]);
  const gone = accessHarness({ exists: false });
  await gone.run();
  assert.deepStrictEqual(gone.calls, [['spaces/DM', ACCESS.noSpace('90001')]]);
});

test('Home reads deal spaces from the database and checks membership per viewer', async () => {
  const db = createDb({ firestore: createFakeFirestore(), now: () => NOW });
  await db.linkSpace({ dealId: '1', dealNumber: '90001', store: 'UT', spaceName: 'spaces/A', spaceUri: 'u/A', how: 'adopted', by: 'b' });
  await db.linkSpace({ dealId: '2', dealNumber: '90002', store: 'UT', spaceName: 'spaces/B', spaceUri: 'u/B', how: 'adopted', by: 'b' });
  // Deal 2 moved to a new space: the old one is marked gone and not shown.
  await db.linkSpace({ dealId: '2', dealNumber: '90002', store: 'UT', spaceName: 'spaces/C', spaceUri: 'u/C', how: 'created', by: 'b' });
  const spacesFor = createDealSpaceIndex({ db, spaces: { isMember: async (space, user) => space === 'spaces/A' && user === 'users/1' } });
  assert.deepStrictEqual([...(await spacesFor('users/1'))].sort(), [
    ['90001', { uri: 'u/A', member: true }],
    ['90002', { uri: 'u/C', member: false }],
  ]);
});

test('opens a space: claim, brief, create and record at once, member, brief and pin, note, link back', async () => {
  const { calls, logs, run, data } = harness();
  await run();
  assert.deepStrictEqual(calls, [
    ['load', { store: 'UT', dealNumber: '90001', rememberPick: true }],
    ['brief'],
    ['create', '90001 · Pat Sample', 'Deal 90001 · Delivery Nov 14 · Sales Coach Casey Coach'],
    ['member', 'spaces/NEW', 'users/1'],
    ['send', 'spaces/NEW', 'brief-90001'],
    ['send', 'spaces/NEW', SAY.pinIt],
    ['note', 'spaces/NEW'],
    ['send', 'spaces/DM', SAY.opened('90001', 'Pat Sample', 'https://chat.google.com/room/NEW')],
  ]);
  assert.strictEqual(logs.at(-1)[1], 'deal space opened');
  assert.strictEqual(data.deals['111'].spaceName, 'spaces/NEW');
  assert.strictEqual(data.deals['111'].spaceHow, 'created');
  assert.strictEqual(data.deals['111'].spaceClaim, null);
});

test('a space created but not joined is still recorded, so a retry links it instead of making another', async () => {
  const { run, data } = harness({ memberError: Object.assign(new Error('x'), { status: 500 }) });
  await run();
  assert.strictEqual(data.deals['111'].spaceName, 'spaces/NEW');
});

test('a second request while one is creating the space waits; an old abandoned claim does not block', async () => {
  const busy = harness({ data: { deals: { 111: { spaceClaim: { by: 'x', at: new Date(NOW - 60 * 1000).toISOString() } } } } });
  await busy.run();
  assert.deepStrictEqual(busy.calls.at(-1), ['send', 'spaces/DM', SAY.busy('90001')]);
  assert.ok(!busy.calls.some((c) => c[0] === 'create'));

  const stale = harness({ data: { deals: { 111: { spaceClaim: { by: 'x', at: new Date(NOW - 10 * 60 * 1000).toISOString() } } } } });
  await stale.run();
  assert.ok(stale.calls.some((c) => c[0] === 'create'));
});

test('a deal with a space gets its link, not a second space', async () => {
  const { calls, run } = harness({ ctx: context({ spaceName: 'spaces/OLD' }), found: { name: 'spaces/OLD', uri: 'https://chat.google.com/room/OLD' } });
  await run();
  assert.deepStrictEqual(calls.slice(1), [
    ['find', 'spaces/OLD'],
    ['send', 'spaces/DM', SAY.exists('90001', 'https://chat.google.com/room/OLD')],
  ]);
});

test('a recorded space that is gone is marked gone and opened again', async () => {
  const { calls, run, data } = harness({ ctx: context({ spaceName: 'spaces/OLD' }), found: null });
  await run();
  assert.ok(calls.some((c) => c[0] === 'create'));
  assert.strictEqual(data.spaces.OLD.status, 'gone');
  assert.strictEqual(data.deals['111'].spaceName, 'spaces/NEW');
});

test('closed deals, several contacts, and missing deals get a plain answer and no space', async () => {
  for (const [ctx, said] of [
    [context({ deal: { id: '111', properties: { dealstage: 'closedwon' } } }), SAY.closed('90001')],
    [{ found: true, choices: [{ id: '1' }, { id: '2' }] }, SAY.severalContacts('90001')],
    [{ found: false }, SAY.notFound('90001', 'UT')],
  ]) {
    const { calls, run } = harness({ ctx });
    await run();
    assert.deepStrictEqual(calls.slice(1), [['send', 'spaces/DM', said]]);
  }
});

test('Google refusing to create a space says it is not approved yet, logs the step, and frees the claim', async () => {
  const { calls, logs, run, data } = harness({ createError: Object.assign(new Error('forbidden'), { status: 403 }) });
  await run();
  assert.deepStrictEqual(calls.at(-1), ['send', 'spaces/DM', SAY.notApproved]);
  const failed = logs.find((l) => l[1] === 'open space failed');
  assert.strictEqual(failed[2].step, 'create space');
  assert.strictEqual(failed[2].error.status, 403);
  assert.strictEqual(data.deals['111'].spaceClaim, null);
});

test('no usable brief means no space, and the claim is freed', async () => {
  const { calls, run, data } = harness({ brief: null });
  await run();
  assert.deepStrictEqual(calls.at(-1), ['send', 'spaces/DM', SAY.failed('90001')]);
  assert.ok(!calls.some((c) => c[0] === 'create'));
  assert.strictEqual(data.deals['111'].spaceClaim, null);
});

test('reads "open a space for <deal>" and its short forms', () => {
  for (const text of ['open a space for 90001', 'Open space 90001', 'open deal space for deal #90001', 'open a space for 90001 ut']) {
    assert.deepStrictEqual(parseCommand(text), { command: 'space', dealNumber: '90001', store: 'UT' });
  }
  assert.strictEqual(parseCommand('open a space'), null);
  assert.deepStrictEqual(parseCommand('brief 90001'), { command: 'brief', dealNumber: '90001', store: 'UT' });
});

const BLAKE = 'blake@example.com';
const accept = async () => true;
const dm = (email, text) => ({ type: 'MESSAGE', space: { name: 'spaces/DM', spaceType: 'DIRECT_MESSAGE' }, user: { email, name: 'users/1' }, message: { text } });

test('the router opens a space only from a direct message, for someone who may brief', async () => {
  const started = [];
  const r = createRouter({ verify: accept, allowedUsers: [BLAKE, 'other@example.com'], briefUsers: [BLAKE], startSpace: (job) => started.push(job) });
  const headers = { authorization: 'Bearer x' };

  const ok = await r({ headers, body: dm(BLAKE, 'open a space for 90001') });
  assert.deepStrictEqual(ok.body, { text: MESSAGES.opening('90001') });
  assert.deepStrictEqual(started, [{ spaceName: 'spaces/DM', userName: 'users/1', dealNumber: '90001', store: 'UT', userEmail: BLAKE }]);

  const inRoom = await r({ headers, body: { ...dm(BLAKE, 'open a space for 90001'), space: { name: 'spaces/R', type: 'ROOM' } } });
  assert.deepStrictEqual(inRoom.body, { text: MESSAGES.spaceDirectOnly('90001') });
  const notBrief = await r({ headers, body: dm('other@example.com', 'open a space for 90001') });
  assert.deepStrictEqual(notBrief.body, { text: MESSAGES.notBriefUser });
  const stranger = await r({ headers, body: dm('nobody@example.com', 'open a space for 90001') });
  assert.deepStrictEqual(stranger.body, { text: MESSAGES.notAllowed });
  assert.strictEqual(started.length, 1);
});

test('the brief note remembers the deal space, and a rerun keeps it', async () => {
  const ctx = { contact: { id: '222' }, items: [] };
  const back = parseBriefNote(cleanText(renderBriefNote({ brief, context: ctx, spaceName: 'spaces/AbC-12' })));
  assert.strictEqual(back.spaceName, 'spaces/AbC-12');
  assert.strictEqual(parseBriefNote(cleanText(renderBriefNote({ brief, context: ctx }))).spaceName, null);

  const bodies = [];
  const hubspot = { updateNote: async (a) => (bodies.push(a.body), a.noteId), createNote: async () => 'x' };
  const save = createBriefNoteSaver({ hubspot });
  await save({ context: { ...ctx, deal: { id: '111' }, briefNote: { id: '9', spaceName: 'spaces/AbC-12' } }, brief });
  assert.strictEqual(parseBriefNote(cleanText(bodies[0])).spaceName, 'spaces/AbC-12');
});

test('the Chat spaces client creates a named space, adds a person, and treats a gone space as none', async () => {
  const requests = [];
  const client = (respond) => ({ getClient: async () => ({ request: async (r) => (requests.push([r.method, r.url, r.data]), respond(r)) }) });
  const spaces = createSpaces({
    auth: client(() => ({ data: { name: 'spaces/NEW', spaceUri: 'https://chat.google.com/room/NEW' } })),
    readAuth: client(() => {
      throw Object.assign(new Error('gone'), { response: { status: 404 } });
    }),
  });
  assert.deepStrictEqual(await spaces.createSpace({ displayName: 'x'.repeat(200), description: 'Deal 90001' }), { name: 'spaces/NEW', uri: 'https://chat.google.com/room/NEW' });
  assert.strictEqual(requests[0][2].displayName.length, 128);
  assert.deepStrictEqual(requests[0].slice(0, 2), ['POST', 'https://chat.googleapis.com/v1/spaces']);
  assert.strictEqual(requests[0][2].spaceType, 'SPACE');
  assert.strictEqual(requests[0][2].customer, 'customers/my_customer');
  await spaces.addMember('spaces/NEW', 'users/1');
  assert.deepStrictEqual(requests[1], ['POST', 'https://chat.googleapis.com/v1/spaces/NEW/members', { member: { name: 'users/1', type: 'HUMAN' } }]);
  await assert.rejects(spaces.addMember('spaces/NEW', 'users/1/../2'), /invalid user name/);
  assert.strictEqual(await spaces.findSpace('spaces/OLD'), null);
});

test('the Chat spaces client lists named spaces across pages and checks membership', async () => {
  const urls = [];
  const pages = [
    { spaces: [{ name: 'spaces/A', displayName: '90001 · Pat', spaceUri: 'u/A' }], nextPageToken: 'p2' },
    { spaces: [{ name: 'spaces/B' }] },
  ];
  const readAuth = {
    getClient: async () => ({
      request: async (r) => {
        urls.push(r.url);
        if (r.url.includes('/members/')) {
          if (r.url.endsWith('/members/2')) throw Object.assign(new Error('no'), { response: { status: 404 } });
          return { data: {} };
        }
        return { data: pages.shift() };
      },
    }),
  };
  const spaces = createSpaces({ auth: readAuth, readAuth });
  assert.deepStrictEqual(await spaces.listSpaces(), [
    { name: 'spaces/A', displayName: '90001 · Pat', uri: 'u/A' },
    { name: 'spaces/B', displayName: '', uri: null },
  ]);
  assert.ok(urls[0].includes('filter=spaceType%20%3D%20%22SPACE%22') && urls[1].includes('pageToken=p2'));
  assert.strictEqual(await spaces.isMember('spaces/A', 'users/1'), true);
  assert.strictEqual(await spaces.isMember('spaces/A', 'users/2'), false);
  assert.ok(urls.includes('https://chat.googleapis.com/v1/spaces/A/members/1'));
  assert.strictEqual(await spaces.isMember('spaces/A', 'users/1/../x'), false);
});

test('a new brief is saved before the space is created, so a refused space does not lose it', async () => {
  const { calls, run } = harness({ brief: { brief, reused: false }, createError: Object.assign(new Error('forbidden'), { status: 403 }) });
  await run();
  const kinds = calls.map((c) => c[0]);
  assert.ok(kinds.indexOf('note') > -1 && kinds.indexOf('note') < kinds.indexOf('create'));
  assert.deepStrictEqual(calls.at(-1), ['send', 'spaces/DM', SAY.notApproved]);

  // A reused brief is already saved: no early save, only the one after posting.
  const reused = harness();
  await reused.run();
  assert.strictEqual(reused.calls.filter((c) => c[0] === 'note').length, 1);
});

test('opening or using a space finds or creates the Delivery record after the brief; a failure there keeps the space', async () => {
  const ensured = [];
  const run = async (fail) => {
    const { createSpaceJob: make } = require('../src/spaceJob');
    const logs = [];
    const job = make({
      loadContext: async () => context(),
      getBrief: async () => ({ brief, reused: true }),
      keepNote: async () => null,
      spaces: { findSpace: async (n) => ({ name: n, uri: 'u' }), createSpace: async () => ({ name: 'spaces/NEW', uri: 'u' }), addMember: async () => {} },
      db: createDb({ firestore: createFakeFirestore(), now: () => NOW }),
      sendMessage: async () => {},
      log: (...l) => logs.push(l),
      avatarUrl: 'a',
      ensureDelivery: async (a) => {
        ensured.push(a);
        if (fail) throw new Error('hubspot down');
        return { id: '888', created: true };
      },
    });
    await job.useSpace({ spaceName: 'spaces/MINE', userEmail: 'b', dealNumber: '90001' });
    return logs;
  };
  const ok = await run(false);
  assert.deepStrictEqual(ensured[0], { dealId: '111', dealNumber: '90001', dealname: '', contactId: '222' });
  assert.strictEqual(ok.at(-1)[1], 'deal space adopted');
  const failed = await run(true);
  assert.ok(failed.some((l) => l[1] === 'could not find or create Delivery record'));
  assert.strictEqual(failed.at(-1)[1], 'deal space adopted');
});

test('the Delivery record is found before the brief is posted, so the card can link to it', async () => {
  const order = [];
  const { createSpaceJob: make } = require('../src/spaceJob');
  const job = make({
    loadContext: async () => context(),
    getBrief: async () => ({ brief, reused: true }),
    keepNote: async (a) => order.push(['note', a.context.deliveryId]),
    spaces: { findSpace: async (n) => ({ name: n, uri: 'u' }) },
    db: createDb({ firestore: createFakeFirestore(), now: () => NOW }),
    sendMessage: async (space, m) => order.push(['send', typeof m === 'string' ? 'text' : JSON.stringify(m).includes('2-59426991/888') ? 'card with Delivery' : 'card']),
    log: () => {},
    avatarUrl: 'a',
    ensureDelivery: async () => (order.push(['delivery']), { id: '888', created: true }),
  });
  await job.useSpace({ spaceName: 'spaces/MINE', userEmail: 'b', dealNumber: '90001' });
  assert.deepStrictEqual(order, [['delivery'], ['send', 'card with Delivery'], ['send', 'text'], ['note', '888']]);
});

test('a space whose opening stopped after it was created is finished when the same person asks again', async () => {
  const firestore = createFakeFirestore();
  const db = createDb({ firestore, now: () => NOW });
  const members = new Set();
  const sent = [];
  let memberFails = true;
  const job = createSpaceJob({
    // As in Basecamp: the deal's space comes from its record.
    loadContext: async () => context({ spaceName: ((await db.getDeal('111')) || {}).spaceName || null }),
    getBrief: async () => ({ brief, reused: true }),
    keepNote: async () => null,
    spaces: {
      findSpace: async (n) => ({ name: n, uri: 'https://chat.google.com/room/NEW' }),
      createSpace: async () => ({ name: 'spaces/NEW', uri: 'https://chat.google.com/room/NEW' }),
      addMember: async (space, user) => {
        if (memberFails) throw Object.assign(new Error('denied'), { status: 403 });
        members.add(user);
      },
      isMember: async (space, user) => members.has(user),
    },
    db,
    sendMessage: async (space, m) => sent.push([space, typeof m === 'string' ? m : m.cardsV2[0].cardId]),
    log: () => {},
    avatarUrl: 'a',
  });
  const open = (userName, userEmail) => job.openSpace({ spaceName: 'spaces/DM', userName, userEmail, dealNumber: '90001' });
  await open('users/1', 'blake@example.com');
  assert.strictEqual(firestore.data.deals['111'].spaceBriefPosted, false);
  assert.deepStrictEqual(sent.at(-1), ['spaces/DM', SAY.notApproved]);

  // Someone else gets the link, and Request access; Basecamp does not add them.
  memberFails = false;
  await open('users/2', 'casey@example.com');
  assert.deepStrictEqual(sent.at(-1), ['spaces/DM', SAY.exists('90001', 'https://chat.google.com/room/NEW')]);
  assert.ok(!members.has('users/2'));

  // The person who asked is added and the brief is posted, in the space already made.
  await open('users/1', 'blake@example.com');
  assert.ok(members.has('users/1'));
  assert.ok(sent.some(([space, what]) => space === 'spaces/NEW' && what === 'brief-90001'));
  assert.deepStrictEqual(sent.at(-1), ['spaces/DM', SAY.opened('90001', 'Pat Sample', 'https://chat.google.com/room/NEW')]);
  assert.strictEqual(firestore.data.deals['111'].spaceBriefPosted, true);

  // Asked once more, it just has a space.
  await open('users/1', 'blake@example.com');
  assert.deepStrictEqual(sent.at(-1), ['spaces/DM', SAY.exists('90001', 'https://chat.google.com/room/NEW')]);
});
