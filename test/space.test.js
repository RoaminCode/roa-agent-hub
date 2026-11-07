'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createSpaceJob, SAY } = require('../src/spaceJob');
const { createSpaces } = require('../src/chat/spaces');
const { createRouter, parseCommand, MESSAGES } = require('../src/router');
const { renderBriefNote, parseBriefNote } = require('../src/agents/briefNote');
const { cleanText } = require('../src/hubspot/dealContext');
const { createBriefNoteSaver } = require('../src/hubspot/briefNotes');

const brief = { headline: 'Pat is excited.', tags: [], key_facts: [], wow: [], mods: [], journey: [] };
const context = (over = {}) => ({
  found: true,
  deal: { id: '111', properties: { dealstage: '85341732', projected_delivery_date: '2026-11-14T00:00:00Z' } },
  contact: { id: '222', properties: { firstname: 'Pat', lastname: 'Sample' } },
  salesCoach: 'Casey Coach',
  items: [],
  briefNote: null,
  ...over,
});

// A space job with every outside call recorded.
function harness({ ctx = context(), found = null, createError = null, brief: got = { brief, reused: true } } = {}) {
  const calls = [];
  const logs = [];
  const job = createSpaceJob({
    loadContext: async (q) => (calls.push(['load', q]), ctx),
    getBrief: async () => (calls.push(['brief']), got),
    keepNote: async (args) => calls.push(['note', args.spaceName]),
    spaces: {
      findSpace: async (name) => (calls.push(['find', name]), found),
      createSpace: async (args) => {
        calls.push(['create', args.displayName, args.description]);
        if (createError) throw createError;
        return { name: 'spaces/NEW', uri: 'https://chat.google.com/room/NEW' };
      },
      addMember: async (space, user) => calls.push(['member', space, user]),
    },
    sendMessage: async (space, message) => calls.push(['send', space, typeof message === 'string' ? message : message.cardsV2[0].cardId]),
    log: (...args) => logs.push(args),
    avatarUrl: 'https://example.com/a.png',
  });
  const run = () => job({ spaceName: 'spaces/DM', userName: 'users/1', dealNumber: '90001', store: 'UT' });
  return { calls, logs, run };
}

test('opens a space: asker as member, brief first, a pin reminder, the space saved on the note, link back', async () => {
  const { calls, logs, run } = harness();
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
});

test('a deal with a space gets its link, not a second space', async () => {
  const { calls, run } = harness({ ctx: context({ briefNote: { id: '9', spaceName: 'spaces/OLD' } }), found: { name: 'spaces/OLD', uri: 'https://chat.google.com/room/OLD' } });
  await run();
  assert.deepStrictEqual(calls.slice(1), [
    ['find', 'spaces/OLD'],
    ['send', 'spaces/DM', SAY.exists('90001', 'https://chat.google.com/room/OLD')],
  ]);
});

test('a recorded space that is gone is opened again', async () => {
  const { calls, run } = harness({ ctx: context({ briefNote: { id: '9', spaceName: 'spaces/OLD' } }), found: null });
  await run();
  assert.ok(calls.some((c) => c[0] === 'create'));
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

test('Google refusing to create a space says it is not approved yet, and logs the step', async () => {
  const { calls, logs, run } = harness({ createError: Object.assign(new Error('forbidden'), { status: 403 }) });
  await run();
  assert.deepStrictEqual(calls.at(-1), ['send', 'spaces/DM', SAY.notApproved]);
  const failed = logs.find((l) => l[1] === 'open space failed');
  assert.strictEqual(failed[2].step, 'create space');
  assert.strictEqual(failed[2].error.status, 403);
});

test('no usable brief means no space', async () => {
  const { calls, run } = harness({ brief: null });
  await run();
  assert.deepStrictEqual(calls.at(-1), ['send', 'spaces/DM', SAY.failed('90001')]);
  assert.ok(!calls.some((c) => c[0] === 'create'));
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
  const hubspot = { updateNote: async (a) => (bodies.push(a.body), a.noteId), createDealNote: async () => 'x' };
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
