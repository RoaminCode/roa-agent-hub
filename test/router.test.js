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
