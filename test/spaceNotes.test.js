'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createSpaceNotes, renderSpaceNote, SAY, MAX_CHARS } = require('../src/spaceNotes');
const { createRouter, MESSAGES } = require('../src/router');
const { parseEvent } = require('../src/chat/events');

const NOW = new Date('2026-11-07T16:50:00Z');

function harness({ found = { deal: { id: '111' }, spaceName: 'spaces/DEAL' }, failWrite = null } = {}) {
  const calls = [];
  const logs = [];
  const save = createSpaceNotes({
    findDealSpace: async (q) => (calls.push(['find', q]), found),
    createDealNote: async (n) => {
      calls.push(['create', n]);
      if (failWrite) throw failWrite;
      return '555';
    },
    log: (...args) => logs.push(args),
    now: () => NOW,
  });
  const run = (over = {}) =>
    save({ spaceName: 'spaces/DEAL', spaceDisplayName: '90001 · Pat Sample', userEmail: 'casey@example.com', userDisplayName: 'Casey Coach', text: 'Pat asked for <b>Saturday</b>\nafter 10', ...over });
  return { calls, logs, run };
}

test('a note in the deal space is saved to that deal, as written, signed and timed', async () => {
  const { calls, logs, run } = harness();
  assert.strictEqual(await run(), SAY.saved('90001'));
  assert.deepStrictEqual(calls[0], ['find', { store: 'UT', dealNumber: '90001' }]);
  const { dealId, body, timestamp } = calls[1][1];
  assert.strictEqual(dealId, '111');
  assert.strictEqual(timestamp, NOW.toISOString());
  assert.strictEqual(
    body,
    '<p><strong>Note from the deal space</strong></p><p>Pat asked for &lt;b&gt;Saturday&lt;/b&gt;<br>after 10</p><p>Added by Casey Coach (casey@example.com) in Google Chat, Nov 7, 9:50 AM MT.</p>',
  );
  // The log says a note was saved, never what it says.
  assert.ok(!JSON.stringify(logs).includes('Saturday'));
});

test('a space that is not the deal\'s recorded space saves nothing', async () => {
  for (const [found, over] of [
    [{ deal: { id: '111' }, spaceName: 'spaces/OTHER' }, {}],
    [{ deal: { id: '111' }, spaceName: null }, {}],
    [null, {}],
    [undefined, { spaceDisplayName: 'Delivery team' }],
  ]) {
    const { calls, run } = harness({ found });
    assert.strictEqual(await run(over), SAY.notDealSpace);
    assert.ok(!calls.some((c) => c[0] === 'create'));
  }
});

test('an empty or overlong note is not saved', async () => {
  const { calls, run } = harness();
  assert.strictEqual(await run({ text: '  ' }), SAY.empty);
  assert.strictEqual(await run({ text: 'x'.repeat(MAX_CHARS + 1) }), SAY.tooLong);
  assert.deepStrictEqual(calls, []);
});

test('a failed save says nothing was saved and logs the error', async () => {
  const { logs, run } = harness({ failWrite: Object.assign(new Error('boom'), { status: 500 }) });
  assert.strictEqual(await run(), SAY.failed('90001'));
  assert.strictEqual(logs.at(-1)[1], 'space note failed');
});

test('without a display name the note is signed with the email', () => {
  assert.ok(renderSpaceNote({ text: 'hi', userEmail: 'a@example.com', now: NOW }).includes('Added by a@example.com in Google Chat'));
});

const accept = async () => true;
const headers = { authorization: 'Bearer x' };
const inSpace = (email, text, space = { name: 'spaces/DEAL', spaceType: 'SPACE', displayName: '90001 · Pat Sample' }) => ({
  type: 'MESSAGE',
  space,
  user: { email, name: 'users/1', displayName: 'Casey Coach' },
  message: { text: `@Basecamp ${text}`, argumentText: ` ${text}` },
});

test('the router saves notes for anyone allowed, even off BRIEF_USERS or with briefs paused', async () => {
  const saved = [];
  const saveSpaceNote = async (n) => (saved.push(n), 'ok');
  for (const opts of [{ briefUsers: [] }, { briefsPaused: true }]) {
    const r = createRouter({ verify: accept, allowedUsers: ['casey@example.com'], saveSpaceNote, ...opts });
    const res = await r({ headers, body: inSpace('casey@example.com', 'note Pat wants Saturday') });
    assert.deepStrictEqual(res.body, { text: 'ok' });
  }
  assert.deepStrictEqual(saved[0], { spaceName: 'spaces/DEAL', spaceDisplayName: '90001 · Pat Sample', userEmail: 'casey@example.com', userDisplayName: 'Casey Coach', text: 'Pat wants Saturday' });

  const r = createRouter({ verify: accept, allowedUsers: ['casey@example.com'], saveSpaceNote });
  const stranger = await r({ headers, body: inSpace('nobody@example.com', 'note hi') });
  assert.deepStrictEqual(stranger.body, { text: MESSAGES.notAllowed });
  const dm = await r({ headers, body: inSpace('casey@example.com', 'note hi', { name: 'spaces/DM', spaceType: 'DIRECT_MESSAGE' }) });
  assert.deepStrictEqual(dm.body, { text: SAY.directOnly });
  assert.strictEqual(saved.length, 2);
});

test('events carry the space and sender display names', () => {
  const e = parseEvent(inSpace('casey@example.com', 'note hi'));
  assert.strictEqual(e.spaceDisplayName, '90001 · Pat Sample');
  assert.strictEqual(e.userDisplayName, 'Casey Coach');
  const addon = parseEvent({ chat: { user: { email: 'a@example.com', displayName: 'A' }, messagePayload: { space: { name: 'spaces/X', displayName: '90001 · Pat' }, message: { text: 'note hi' } } } });
  assert.strictEqual(addon.spaceDisplayName, '90001 · Pat');
  assert.strictEqual(addon.userDisplayName, 'A');
});

test('the note also goes on the Roamer the brief was written for', async () => {
  const { calls, run } = harness({ found: { deal: { id: '111' }, spaceName: 'spaces/DEAL', contactId: '77' } });
  await run();
  assert.strictEqual(calls[1][1].contactId, '77');
  const none = harness();
  await none.run();
  assert.strictEqual(none.calls[1][1].contactId, null);
});
