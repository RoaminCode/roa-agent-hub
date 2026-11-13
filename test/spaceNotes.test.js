'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createSpaceNotes, createNoteEditor, renderSpaceNote, parseSpaceNote, noteCard, SAY, MAX_CHARS } = require('../src/spaceNotes');
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
    createNote: async (n) => {
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
  // No Delivery record yet in this harness: the reply says the Roamer's record.
  assert.strictEqual(await run(), SAY.saved('90001', false));
  assert.strictEqual(SAY.saved('90001'), 'Saved to the 90001 Delivery record in HubSpot.');
  const { dealId, contactId, body, timestamp } = calls[0][1];
  // Never on the deal: on the Roamer (and the Delivery record once the deal has one).
  assert.strictEqual(dealId, undefined);
  assert.strictEqual(contactId, null);
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
  assert.deepStrictEqual(saved[0], { spaceName: 'spaces/DEAL', spaceDisplayName: '90001 · Pat Sample', isDirectMessage: false, userEmail: 'casey@example.com', userDisplayName: 'Casey Coach', text: 'Pat wants Saturday', card: true });

  const r = createRouter({ verify: accept, allowedUsers: ['casey@example.com'], saveSpaceNote });
  const stranger = await r({ headers, body: inSpace('nobody@example.com', 'note hi') });
  assert.deepStrictEqual(stranger.body, { text: MESSAGES.notAllowed });
  const dm = await r({ headers, body: inSpace('casey@example.com', 'note hi', { name: 'spaces/DM', spaceType: 'DIRECT_MESSAGE' }) });
  // A direct message goes to the note writer too, which reads the deal number from the text.
  assert.deepStrictEqual(dm.body, { text: 'ok' });
  assert.strictEqual(saved.at(-1).isDirectMessage, true);
  assert.strictEqual(saved.length, 3);
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

test('"/note <text>" is the same as "note <text>"; /ask routes; /wow starts WOW ideas', async () => {
  const wows = [];
  const saved = [];
  const asked = [];
  const r = createRouter({ verify: async () => true, allowedUsers: ['casey@example.com'], saveSpaceNote: async (n) => (saved.push(n.text), 'ok'), askQuestion: async (q) => (asked.push(q.text), 'routed'), startWow: (j) => wows.push(j.spaceName) });
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
  assert.strictEqual(said(await r({ headers: { authorization: 'x' }, body: slash(3, '') })), MESSAGES.wowWorking);
  assert.deepStrictEqual(wows, ['spaces/DEAL']);
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

  // "/note" and a line break is sent by Chat as plain text, so the command never ran. Saved
  // this way, the note is the lines after it, with their line breaks.
  action.chat.appCommandPayload.message.text = '/note\nSolar: 2 panels\nAwning: ordered';
  await r({ headers: { authorization: 'x' }, body: action });
  assert.strictEqual(notes[1].text, 'Solar: 2 panels\nAwning: ordered');
});

test('a note in a direct message names its deal and is saved there', async () => {
  const firestore = createFakeFirestore();
  const created = [];
  const save = createSpaceNotes({
    db: createDb({ firestore, now: () => NOW }),
    createNote: async (n) => (created.push(n), '777'),
    findDealSpace: async ({ dealNumber }) => (dealNumber === '90001' ? { deal: { id: '111' }, spaceName: null, contactId: '77', deliveryId: '888' } : null),
    log: () => {},
    now: () => NOW,
  });
  const dm = (text) => save({ spaceName: 'spaces/DM', isDirectMessage: true, userEmail: 'casey@example.com', userDisplayName: 'Casey Coach', text });
  assert.strictEqual(await dm('90001 Pat wants Saturday'), SAY.saved('90001'));
  assert.deepStrictEqual({ dealId: created[0].dealId, contactId: created[0].contactId, deliveryId: created[0].deliveryId }, { dealId: undefined, contactId: '77', deliveryId: '888' });
  assert.ok(created[0].body.startsWith('<p><strong>Note from Basecamp</strong></p><p>Pat wants Saturday</p>'));
  assert.strictEqual(firestore.data.spaceNotes['777'].spaceName, 'spaces/DM');

  assert.strictEqual(await dm('#90001: colon works too'), SAY.saved('90001'));
  assert.strictEqual(await dm('Pat wants Saturday'), SAY.directOnly);
  assert.strictEqual(await dm('90001'), SAY.empty);
  assert.strictEqual(await dm('90002 no such deal'), SAY.noDeal('90002'));
  assert.strictEqual(created.length, 2);
});

test('saving your own message says "Added by", not written and saved by the same person', () => {
  const html = renderSpaceNote({ text: 'x', userDisplayName: 'Casey Coach', userEmail: 'casey@example.com', now: NOW, writtenBy: 'Casey Coach' });
  assert.ok(html.includes('<p>Added by Casey Coach (casey@example.com) in Google Chat'));
});

// A saved note and its editor: HubSpot holds one note ('555'), as Basecamp wrote it.
async function editing({ body = null, failUpdate = null } = {}) {
  const { db } = await linkedDb({ contactId: '77' });
  const store = { body: null, timestamp: NOW.toISOString(), updates: 0 };
  const save = createSpaceNotes({ db, createNote: async (n) => ((store.body = n.body), '555'), log: () => {}, endpoint: 'https://b.example', now: () => NOW });
  const card = await save({ spaceName: 'spaces/DEAL', userEmail: 'casey@example.com', userDisplayName: 'Casey Coach', text: 'Solar: 2 panels & <b>bold</b>\nAwning: ordered', card: true });
  if (body !== null) store.body = body;
  const redrawn = [];
  const hubspot = {
    get: async () => ({ properties: { hs_note_body: store.body, hs_timestamp: store.timestamp } }),
    updateNote: async ({ noteId, body: next, timestamp, isOurs }) => {
      if (failUpdate) throw failUpdate;
      assert.ok(isOurs(store.body));
      store.updates += 1;
      Object.assign(store, { body: next, timestamp, noteId });
    },
  };
  const editor = createNoteEditor({ db, hubspot, updateMessage: async (name, message) => redrawn.push([name, message]), log: () => {}, endpoint: 'https://b.example', now: () => new Date('2026-11-07T18:05:00Z') });
  const button = card.cardsV2[0].card.sections[1].widgets[1].buttonList.buttons[0];
  const params = Object.fromEntries(button.onClick.action.parameters.map((p) => [p.key, p.value]));
  return { card, button, params, store, editor, redrawn, db };
}

test('a saved note comes back as a card with its words, who added it, and Edit note', async () => {
  const { card, button, params } = await editing();
  const [words, foot] = card.cardsV2[0].card.sections;
  assert.strictEqual(card.fallbackText, SAY.saved('90001', false));
  assert.strictEqual(words.widgets.length, 1);
  assert.strictEqual(words.collapsible, undefined);
  assert.strictEqual(words.widgets[0].textParagraph.text, 'Solar: 2 panels &amp; &lt;b&gt;bold&lt;/b&gt;<br>Awning: ordered');
  // The name and time; the email stays in HubSpot's note.
  assert.strictEqual(foot.widgets[0].textParagraph.text, '<i>Added by Casey Coach in Google Chat, Nov 7, 9:50 AM MT.</i>');

  // A long note shows its start; the rest opens with "Show more".
  const lines = noteCard({ noteId: '1', dealNumber: '90001', text: 'a\nb\nc\nd\ne\nf', signature: 's', endpoint: 'e' }).cardsV2[0].card.sections[0];
  assert.deepStrictEqual(lines.widgets.map((w) => w.textParagraph.text), ['a<br>b<br>c<br>d', 'e<br>f']);
  assert.deepStrictEqual([lines.collapsible, lines.uncollapsibleWidgetsCount], [true, 1]);
  const long = noteCard({ noteId: '1', dealNumber: '90001', text: 'word '.repeat(120).trim(), signature: 's', endpoint: 'e' }).cardsV2[0].card.sections[0];
  assert.strictEqual(long.widgets.length, 2);
  assert.strictEqual(long.widgets.map((w) => w.textParagraph.text).join(' '), 'word '.repeat(120).trim());
  assert.strictEqual(button.text, 'Edit note');
  assert.strictEqual(button.onClick.action.interaction, 'OPEN_DIALOG');
  // The words do not ride on the button.
  assert.deepStrictEqual(params, { action: 'noteEdit', id: '555', n: '90001', o: '0' });
});

test('Edit note opens with the words from HubSpot, and Save replaces the note and redraws the card', async () => {
  const { params, store, editor, redrawn, db } = await editing();
  const { dialog } = await editor.review({ params, userEmail: 'casey@example.com', messageName: 'spaces/DEAL/messages/abc' });
  const [input, buttons] = dialog.sections[0].widgets;
  assert.strictEqual(input.textInput.value, 'Solar: 2 panels & <b>bold</b>\nAwning: ordered');
  assert.strictEqual(input.textInput.type, 'MULTIPLE_LINE');
  const saveParams = Object.fromEntries(buttons.buttonList.buttons[0].onClick.action.parameters.map((p) => [p.key, p.value]));
  assert.strictEqual(saveParams.c, 'spaces/DEAL/messages/abc');

  const said = await editor.save({ params: saveParams, formInputs: { note: 'Solar: 3 panels\nAwning: here' }, userEmail: 'casey@example.com', userDisplayName: 'Casey Coach' });
  assert.strictEqual(said, null);
  assert.strictEqual(
    store.body,
    '<p><strong>Note from the deal space</strong></p><p>Solar: 3 panels<br>Awning: here</p><p>Added by Casey Coach (casey@example.com) in Google Chat, Nov 7, 9:50 AM MT. Edited by Casey Coach, Nov 7, 11:05 AM MT.</p>',
  );
  // The note keeps its own time in HubSpot's timeline.
  assert.strictEqual(store.timestamp, NOW.toISOString());
  assert.strictEqual(redrawn[0][0], 'spaces/DEAL/messages/abc');
  assert.strictEqual(redrawn[0][1].cardsV2[0].card.sections[0].widgets[0].textParagraph.text, 'Solar: 3 panels<br>Awning: here');
  assert.ok((await db.getSpaceNote('555')).editedAt);

  // A second edit keeps one "Edited by" line; the same words again change nothing.
  await editor.save({ params: saveParams, formInputs: { note: 'Solar: 4 panels' }, userEmail: 'casey@example.com', userDisplayName: 'Casey Coach' });
  assert.strictEqual(store.body.match(/Edited by/g).length, 1);
  assert.strictEqual(await editor.save({ params: saveParams, formInputs: { note: 'Solar: 4 panels' }, userEmail: 'casey@example.com', userDisplayName: 'Casey Coach' }), null);
  assert.strictEqual(store.updates, 2);
});

test('Edit note is for the person who added the note, and never touches a note changed in HubSpot', async () => {
  const mine = await editing();
  assert.deepStrictEqual(await mine.editor.review({ params: mine.params, userEmail: 'sam@example.com', messageName: 'm' }), { notice: SAY.notYours });
  assert.strictEqual(await mine.editor.save({ params: mine.params, formInputs: { note: 'x' }, userEmail: 'sam@example.com' }), SAY.notYours);
  assert.strictEqual(await mine.editor.save({ params: mine.params, formInputs: { note: '  ' }, userEmail: 'casey@example.com' }), SAY.editEmpty);
  assert.strictEqual(await mine.editor.save({ params: mine.params, formInputs: { note: 'x'.repeat(MAX_CHARS + 1) }, userEmail: 'casey@example.com' }), SAY.editTooLong);
  // A note Basecamp has no record of.
  assert.deepStrictEqual(await mine.editor.review({ params: { ...mine.params, id: '999' }, userEmail: 'casey@example.com', messageName: 'm' }), { notice: SAY.editGone });
  assert.strictEqual(mine.store.updates, 0);

  const changed = await editing({ body: '<p>Someone rewrote this in HubSpot</p>' });
  assert.deepStrictEqual(await changed.editor.review({ params: changed.params, userEmail: 'casey@example.com', messageName: 'm' }), { notice: SAY.editChanged });
  assert.strictEqual(await changed.editor.save({ params: changed.params, formInputs: { note: 'x' }, userEmail: 'casey@example.com' }), SAY.editChanged);

  const failing = await editing({ failUpdate: new Error('boom') });
  assert.strictEqual(await failing.editor.save({ params: failing.params, formInputs: { note: 'x' }, userEmail: 'casey@example.com' }), SAY.editFailed);
  assert.strictEqual(failing.redrawn.length, 0);

  assert.strictEqual(parseSpaceNote('<p><strong>Basecamp Q&amp;A: awning</strong></p><p>x</p><p>y</p>'), null);
  assert.strictEqual(parseSpaceNote('<p><strong>Note from Basecamp</strong></p><p>a<br/>b</p><p>sig</p>').text, 'a\nb');
});

test('the router opens the edit box, saves it, and posts only what needs saying', async () => {
  const notices = [];
  const calls = [];
  const r = createRouter({
    verify: async () => true,
    allowedUsers: ['casey@example.com'],
    postNotice: (n) => notices.push(n),
    reviewNote: async (a) => (calls.push(['review', a]), a.params.id === '1' ? { dialog: { header: { title: 'Edit note' } } } : { notice: SAY.notYours }),
    saveNoteEdit: async (a) => (calls.push(['save', a]), a.formInputs.note === 'bad' ? SAY.editFailed : null),
  });
  const tap = (parameters, formInputs = {}) =>
    r({
      headers: { authorization: 'x' },
      body: {
        commonEventObject: { hostApp: 'CHAT', parameters, formInputs: Object.fromEntries(Object.entries(formInputs).map(([k, v]) => [k, { stringInputs: { value: [v] } }])) },
        chat: { user: { email: 'casey@example.com', name: 'users/1', displayName: 'Casey Coach' }, eventTime: 't', buttonClickedPayload: { space: { name: 'spaces/DEAL', spaceType: 'SPACE' }, message: { name: 'spaces/DEAL/messages/abc', thread: { name: 'spaces/DEAL/threads/t' } } } },
      },
    });
  const close = { action: { navigations: [{ endNavigation: { action: 'CLOSE_DIALOG' } }] } };
  assert.deepStrictEqual((await tap({ action: 'noteEdit', id: '1', n: '90001' })).body, { action: { navigations: [{ pushCard: { header: { title: 'Edit note' } } }] } });
  assert.strictEqual(calls[0][1].messageName, 'spaces/DEAL/messages/abc');
  assert.deepStrictEqual((await tap({ action: 'noteEdit', id: '2', n: '90001' })).body, close);
  assert.deepStrictEqual(notices, [{ spaceName: 'spaces/DEAL', threadName: 'spaces/DEAL/threads/t', text: SAY.notYours }]);
  assert.deepStrictEqual((await tap({ action: 'noteSave', id: '1', n: '90001' }, { note: 'new words' })).body, close);
  assert.strictEqual(notices.length, 1);
  await tap({ action: 'noteSave', id: '1', n: '90001' }, { note: 'bad' });
  assert.strictEqual(notices[1].text, SAY.editFailed);
  assert.deepStrictEqual((await tap({ action: 'noteCancel' })).body, close);
  assert.strictEqual(calls.length, 4);
});
