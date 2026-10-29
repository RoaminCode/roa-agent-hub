'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createRouter, MESSAGES } = require('../src/router');
const { parseEvent } = require('../src/chat/events');

const BLAKE = 'blake@example.com';
const headers = { authorization: 'Bearer test' };
const accept = async () => true;
const reject = async () => false;
const router = createRouter({ verify: accept, allowedUsers: [BLAKE] });

const classicMessage = (email, text) => ({
  type: 'MESSAGE',
  space: { name: 'spaces/AAA', spaceType: 'DIRECT_MESSAGE' },
  user: { email, displayName: 'Test User' },
  message: { name: 'spaces/AAA/messages/1', text, thread: { name: 'spaces/AAA/threads/1' } },
});

const addOnMessage = (email, text) => ({
  chat: {
    user: { email, displayName: 'Test User' },
    messagePayload: {
      space: { name: 'spaces/BBB', spaceType: 'SPACE' },
      message: { name: 'spaces/BBB/messages/1', text: `@Basecamp ${text}`, argumentText: ` ${text}` },
    },
  },
});

test('rejects requests that fail Chat verification', async () => {
  const result = await createRouter({ verify: reject, allowedUsers: [BLAKE] })({ headers, body: classicMessage(BLAKE, 'hi') });
  assert.strictEqual(result.status, 401);
});

test('replies to an allowed user in the classic format', async () => {
  const result = await router({ headers, body: classicMessage(BLAKE, 'hi') });
  assert.deepStrictEqual(result.body, { text: MESSAGES.help });
});

test('replies to an allowed user in the add-on format', async () => {
  const result = await router({ headers, body: addOnMessage(BLAKE, 'hi') });
  assert.strictEqual(
    result.body.hostAppDataAction.chatDataAction.createMessageAction.message.text,
    MESSAGES.help,
  );
});

test('matches allowed users regardless of email case', async () => {
  const result = await router({ headers, body: classicMessage('Blake@Example.com', 'hi') });
  assert.deepStrictEqual(result.body, { text: MESSAGES.help });
});

test('turns away users who are not allowed yet', async () => {
  const result = await router({ headers, body: classicMessage('someone@example.com', 'hi') });
  assert.deepStrictEqual(result.body, { text: MESSAGES.notAllowed });
});

test('greets when added to a space', async () => {
  const body = { type: 'ADDED_TO_SPACE', space: { name: 'spaces/AAA' }, user: { email: BLAKE } };
  const result = await router({ headers, body });
  assert.deepStrictEqual(result.body, { text: MESSAGES.added });
});

test('says nothing when removed from a space', async () => {
  const body = { type: 'REMOVED_FROM_SPACE', space: { name: 'spaces/AAA' }, user: { email: BLAKE } };
  const result = await router({ headers, body });
  assert.deepStrictEqual(result.body, {});
});

test('strips the @Basecamp mention from add-on messages', () => {
  const event = parseEvent(addOnMessage(BLAKE, 'where is Webber at'));
  assert.strictEqual(event.text, 'where is Webber at');
  assert.strictEqual(event.format, 'addon');
});

test('a typed "brief" always starts a brief, even right after another for the same deal', async () => {
  const started = [];
  const r = createRouter({ verify: accept, allowedUsers: [BLAKE], startBrief: (job) => started.push(job.spaceName) });
  await r({ headers, body: classicMessage(BLAKE, 'brief 51431') });
  await r({ headers, body: { ...classicMessage(BLAKE, 'brief 51431'), space: { name: 'spaces/OTHER', spaceType: 'DIRECT_MESSAGE' } } });
  assert.deepStrictEqual(started, ['spaces/AAA', 'spaces/OTHER']);
});

test('ignores a classic-format card click instead of failing', async () => {
  const body = { type: 'CARD_CLICKED', space: { name: 'spaces/AAA' }, user: { email: BLAKE }, action: {} };
  const result = await router({ headers, body });
  assert.strictEqual(result.status, 200);
});

test('keeps briefs out of group spaces and points to a direct message', async () => {
  const started = [];
  const r = createRouter({ verify: accept, allowedUsers: [BLAKE], startBrief: (job) => started.push(job) });
  const inSpace = await r({ headers, body: addOnMessage(BLAKE, 'brief 51431') });
  assert.strictEqual(inSpace.body.hostAppDataAction.chatDataAction.createMessageAction.message.text, MESSAGES.directOnly('51431'));
  const inRoom = await r({ headers, body: { ...classicMessage(BLAKE, 'brief 51431'), space: { name: 'spaces/R', type: 'ROOM' } } });
  assert.deepStrictEqual(inRoom.body, { text: MESSAGES.directOnly('51431') });
  assert.strictEqual(started.length, 0);
});

test('recognizes a direct message however Chat names it', () => {
  for (const space of [{ spaceType: 'DIRECT_MESSAGE' }, { type: 'DM' }, { singleUserBotDm: true }]) {
    assert.strictEqual(parseEvent({ type: 'MESSAGE', space: { name: 'spaces/A', ...space }, user: { email: BLAKE } }).isDirectMessage, true);
  }
  assert.strictEqual(parseEvent({ type: 'MESSAGE', space: { name: 'spaces/A', spaceType: 'SPACE' }, user: { email: BLAKE } }).isDirectMessage, false);
});

const pickerClick = (params, space = { name: 'spaces/DM1', spaceType: 'DIRECT_MESSAGE' }) => ({
  commonEventObject: { invokedFunction: 'https://example.com/', parameters: { action: 'brief', from: 'picker', dealNumber: '90001', store: 'UT', roamer: 'Chris Sample', ...params } },
  chat: { user: { name: 'users/123', email: BLAKE }, eventTime: 't', buttonClickedPayload: { space, message: { name: 'spaces/DM1/messages/9' } } },
});

test('a contact picker tap starts the brief on that contact and replaces the picker', async () => {
  const started = [];
  const r = createRouter({ verify: accept, allowedUsers: [BLAKE], startBrief: (job) => started.push(job) });
  const result = await r({ headers, body: pickerClick({ contactId: '78' }) });
  assert.deepStrictEqual(started, [{ spaceName: 'spaces/DM1', userName: 'users/123', dealNumber: '90001', store: 'UT', contactId: '78', userEmail: BLAKE }]);
  assert.deepStrictEqual(result.body, {
    hostAppDataAction: { chatDataAction: { updateMessageAction: { message: { text: MESSAGES.working('90001', 'Chris Sample') } } } },
  });
});

test('a picker tap right after a Home tap on the same deal still starts the brief', async () => {
  const started = [];
  const r = createRouter({ verify: accept, allowedUsers: [BLAKE], startBrief: (job) => started.push(job.contactId || 'home'), buildHome: async () => ({}) });
  const homeTap = {
    commonEventObject: { invokedFunction: 'https://example.com/', parameters: { action: 'brief', dealNumber: '90001' } },
    chat: { user: { name: 'users/123', email: BLAKE }, eventTime: 't', buttonClickedPayload: {} },
  };
  await r({ headers, body: homeTap });
  await r({ headers, body: pickerClick({ contactId: '78' }) });
  assert.deepStrictEqual(started, ['home', '78']);
});

test('ignores a picker tap with a malformed contact, an unknown store, or outside a direct message', async () => {
  const started = [];
  const r = createRouter({ verify: accept, allowedUsers: [BLAKE], startBrief: (job) => started.push(job) });
  await r({ headers, body: pickerClick({ contactId: '78; drop' }) });
  await r({ headers, body: pickerClick({ contactId: '78', store: 'ZZ' }) });
  await r({ headers, body: pickerClick({ contactId: '78' }, { name: 'spaces/G', spaceType: 'SPACE' }) });
  assert.strictEqual(started.length, 0);
});

test('parses the brief command, with Utah as the default store', () => {
  const { parseCommand } = require('../src/router');
  assert.deepStrictEqual(parseCommand('brief 51431'), { command: 'brief', dealNumber: '51431', store: 'UT' });
  assert.deepStrictEqual(parseCommand('Brief #51431 ut'), { command: 'brief', dealNumber: '51431', store: 'UT' });
  assert.strictEqual(parseCommand('brief Bob'), null);
  assert.strictEqual(parseCommand('tell me about 51431'), null);
});

test('answers a brief request right away and starts the brief', async () => {
  const started = [];
  const r = createRouter({ verify: accept, allowedUsers: [BLAKE], startBrief: (job) => started.push(job) });
  const result = await r({ headers, body: classicMessage(BLAKE, 'brief 51431') });
  assert.deepStrictEqual(result.body, { text: MESSAGES.working('51431') });
  assert.deepStrictEqual(started, [{ spaceName: 'spaces/AAA', dealNumber: '51431', store: 'UT', userEmail: BLAKE }]);
});

test('does not start a brief for a store it does not know', async () => {
  const started = [];
  const r = createRouter({ verify: accept, allowedUsers: [BLAKE], startBrief: (job) => started.push(job) });
  const result = await r({ headers, body: classicMessage(BLAKE, 'brief 51431 AZ') });
  assert.deepStrictEqual(result.body, { text: MESSAGES.unknownStore('AZ') });
  assert.strictEqual(started.length, 0);
});

test('never starts a brief for a user who is not allowed', async () => {
  const started = [];
  const r = createRouter({ verify: accept, allowedUsers: [BLAKE], startBrief: (job) => started.push(job) });
  await r({ headers, body: classicMessage('someone@example.com', 'brief 51431') });
  assert.strictEqual(started.length, 0);
});
