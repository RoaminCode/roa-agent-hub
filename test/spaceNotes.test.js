'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createSpaceNotes, renderSpaceNote, SAY, MAX_CHARS } = require('../src/spaceNotes');
const { createRouter, MESSAGES } = require('../src/router');
const { parseEvent } = require('../src/chat/events');
const { createDb } = require('../src/db');
const { createFakeFirestore } = require('./fakeFirestore');

const NOW = new Date('2026-11-07T16:50:00Z');

// A linked deal space, with the Roamer recorded when `contactId` is given.
async function linkedDb({ contactId = null } = {}) {
  const firestore = createFakeFirestore();
  const db = createDb({ firestore, now: () => NOW });
  await db.linkSpace({ dealId: '111', dealNumber: '90001', store: 'UT', spaceName: 'spaces/DEAL', spaceUri: 'u', how: 'adopted', by: 'b' });
  if (contactId) await db.recordBrief({ dealId: '111', dealNumber: '90001', store: 'UT', contactId, noteId: '9', signature: {} });
  return { db, data: firestore.data };
}

async function harness({ contactId = null, failWrite = null, db = null } = {}) {
  const calls = [];
  const logs = [];
  const linked = db ? { db, data: null } : await linkedDb({ contactId });
  const save = createSpaceNotes({
    db: linked.db,
    createDealNote: async (n) => {
      calls.push(['create', n]);
      if (failWrite) throw failWrite;
      return '555';
    },
    log: (...args) => logs.push(args),
    now: () => NOW,
  });
  const run = (over = {}) => save({ spaceName: 'spaces/DEAL', userEmail: 'casey@example.com', userDisplayName: 'Casey Coach', text: 'Pat asked for <b>Saturday</b>\nafter 10', ...over });
  return { calls, logs, run, data: linked.data };
}

test('a note in the deal space is saved to that deal, as written, signed and timed, and recorded', async () => {
  const { calls, logs, run, data } = await harness();
  assert.strictEqual(await run(), SAY.saved('90001'));
  const { dealId, body, timestamp } = calls[0][1];
  assert.strictEqual(dealId, '111');
  assert.strictEqual(timestamp, NOW.toISOString());
  assert.strictEqual(
    body,
    '<p><strong>Note from the deal space</strong></p><p>Pat asked for &lt;b&gt;Saturday&lt;/b&gt;<br>after 10</p><p>Added by Casey Coach (casey@example.com) in Google Chat, Nov 7, 9:50 AM MT.</p>',
  );
  // The log and the database say a note was saved, never what it says.
  assert.ok(!JSON.stringify(logs).includes('Saturday'));
  assert.deepStrictEqual(data.spaceNotes['555'], { dealId: '111', spaceName: 'spaces/DEAL', user: 'casey@example.com', chars: 38, at: NOW.toISOString() });
});

test('a space that is not a linked deal space saves nothing', async () => {
  const { calls, run } = await harness();
  assert.strictEqual(await run({ spaceName: 'spaces/OTHER' }), SAY.notDealSpace);
  // A space the deal has moved away from no longer takes notes.
  const moved = await linkedDb();
  await moved.db.linkSpace({ dealId: '111', dealNumber: '90001', store: 'UT', spaceName: 'spaces/NEWER', spaceUri: 'u', how: 'created', by: 'b' });
  const old = await harness({ db: moved.db });
  assert.strictEqual(await old.run(), SAY.notDealSpace);
  assert.deepStrictEqual([...calls, ...old.calls], []);
});

test('an empty or overlong note is not saved', async () => {
  const { calls, run } = await harness();
  assert.strictEqual(await run({ text: '  ' }), SAY.empty);
  assert.strictEqual(await run({ text: 'x'.repeat(MAX_CHARS + 1) }), SAY.tooLong);
  assert.deepStrictEqual(calls, []);
});

test('a failed save says nothing was saved and logs the error', async () => {
  const { logs, run } = await harness({ failWrite: Object.assign(new Error('boom'), { status: 500 }) });
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
  const { calls, run } = await harness({ contactId: '77' });
  await run();
  assert.strictEqual(calls[0][1].contactId, '77');
  const none = await harness();
  await none.run();
  assert.strictEqual(none.calls[0][1].contactId, null);
});

test('"/note <text>" is the same as "note <text>"; /ask routes; /wow says it is not built yet', async () => {
  const { NOT_BUILT } = require('../src/router');
  const saved = [];
  const asked = [];
  const r = createRouter({ verify: async () => true, allowedUsers: ['casey@example.com'], saveSpaceNote: async (n) => (saved.push(n.text), 'ok'), askQuestion: async (q) => (asked.push(q.text), 'routed') });
  const slash = (id, args) => ({
    commonEventObject: { hostApp: 'CHAT' },
    chat: {
      user: { email: 'casey@example.com', name: 'users/1' },
      eventTime: 't',
      appCommandPayload: {
        appCommandMetadata: { appCommandId: id, appCommandType: 'SLASH_COMMAND' },
        space: { name: 'spaces/DEAL', spaceType: 'SPACE' },
        message: { text: `/x ${args}`, argumentText: ` ${args}` },
      },
    },
  });
  const said = (res) => res.body.hostAppDataAction.chatDataAction.createMessageAction.message.text;
  assert.strictEqual(said(await r({ headers: { authorization: 'x' }, body: slash(1, 'Pat wants Saturday') })), 'ok');
  assert.deepStrictEqual(saved, ['Pat wants Saturday']);
  assert.strictEqual(said(await r({ headers: { authorization: 'x' }, body: slash(2, 'who has the title?') })), 'routed');
  assert.deepStrictEqual(asked, ['who has the title?']);
  assert.strictEqual(said(await r({ headers: { authorization: 'x' }, body: slash(3, '') })), NOT_BUILT.wow);
  assert.strictEqual(said(await r({ headers: { authorization: 'x' }, body: slash(9, '') })), MESSAGES.help);
  // A classic event carries the command id on the message.
  assert.strictEqual(parseEvent({ type: 'MESSAGE', space: { name: 'spaces/X' }, user: {}, message: { text: '/note hi', argumentText: ' hi', slashCommand: { commandId: '1' } } }).commandId, '1');
  assert.strictEqual(parseEvent({ type: 'MESSAGE', space: { name: 'spaces/X' }, user: {}, message: { text: 'hi' } }).commandId, null);
});

test('"Save to HubSpot" on a message saves the whole message, crediting its writer and the saver', async () => {
  const notes = [];
  const r = createRouter({ verify: async () => true, allowedUsers: ['casey@example.com'], saveSpaceNote: async (n) => (notes.push(n), 'ok') });
  const action = {
    commonEventObject: { hostApp: 'CHAT' },
    chat: {
      user: { email: 'casey@example.com', name: 'users/1', displayName: 'Casey Coach' },
      eventTime: 't',
      appCommandPayload: {
        appCommandMetadata: { appCommandId: 4, appCommandType: 'MESSAGE_ACTION' },
        space: { name: 'spaces/DEAL', spaceType: 'SPACE' },
        message: { text: 'Roamer wants delivery moved to Saturday', sender: { displayName: 'Sam Service' } },
      },
    },
  };
  await r({ headers: { authorization: 'x' }, body: action });
  assert.strictEqual(notes[0].text, 'Roamer wants delivery moved to Saturday');
  assert.strictEqual(notes[0].writtenBy, 'Sam Service');
  assert.strictEqual(
    renderSpaceNote({ text: 'x', userDisplayName: 'Casey Coach', userEmail: 'casey@example.com', now: NOW, writtenBy: 'Sam Service' }),
    '<p><strong>Note from the deal space</strong></p><p>x</p><p>Written by Sam Service, saved by Casey Coach (casey@example.com) in Google Chat, Nov 7, 9:50 AM MT.</p>',
  );
  assert.ok(renderSpaceNote({ text: 'x', userEmail: 'a@example.com', now: NOW, writtenBy: null }).includes('Written by a Team Member, saved by a@example.com'));
});
