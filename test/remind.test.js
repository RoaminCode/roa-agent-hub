'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseReminder, fromUtah, utahNow } = require('../src/agents/remindParse');
const { createReminders, reminderCard, whenLabel, SAY } = require('../src/remindJob');
const { createRouter, parseCommand } = require('../src/router');
const { createVerifier } = require('../src/chat/verify');
const { createDb } = require('../src/db');
const { createFakeFirestore } = require('./fakeFirestore');

// Saturday, Nov 7 2026, 1:00 PM in Utah (MST, UTC-7).
const NOW = new Date('2026-11-07T20:00:00Z');
const OPEN = '85341732';

test('reads Utah wall-clock times as instants, through daylight saving', () => {
  assert.strictEqual(fromUtah('2026-11-07T14:00').toISOString(), '2026-11-07T21:00:00.000Z');
  assert.strictEqual(fromUtah('2026-07-01T09:00').toISOString(), '2026-07-01T15:00:00.000Z');
  assert.strictEqual(fromUtah('not a time'), null);
  assert.strictEqual(utahNow(NOW), 'Saturday 2026-11-07 13:00');
});

test('the parser sends the Utah time and the request to the small model, and refuses what it cannot read', async () => {
  const sent = [];
  const fake = (out) => ({ messages: { create: async (body) => (sent.push(body), { stop_reason: 'end_turn', usage: { input_tokens: 300, output_tokens: 30 }, content: [{ type: 'text', text: JSON.stringify(out) }] }) } });
  const r = await parseReminder({ anthropic: fake({ understood: true, for_self: true, what: 'let the Roamer know if we got <it> ordered', due: '2026-11-07T14:00' }), text: 'me let the Roamer know <x> within the hour', now: NOW });
  assert.deepStrictEqual([r.ok, r.forSelf, r.dueAt.toISOString()], [true, true, '2026-11-07T21:00:00.000Z']);
  assert.strictEqual(sent[0].model, 'claude-haiku-4-5-20251001');
  assert.ok(sent[0].messages[0].content.startsWith('Now in Utah: Saturday 2026-11-07 13:00'));
  assert.ok(sent[0].messages[0].content.includes('&lt;x&gt;'));
  assert.strictEqual((await parseReminder({ anthropic: fake({ understood: false, for_self: true, what: '', due: '' }), text: 'x', now: NOW })).ok, false);
  assert.strictEqual((await parseReminder({ anthropic: fake({ understood: true, for_self: true, what: 'x', due: 'soon' }), text: 'x', now: NOW })).ok, false);
});

test('labels the time plainly in Utah', () => {
  assert.strictEqual(whenLabel(new Date('2026-11-07T21:40:00Z'), NOW), 'today at 2:40 PM');
  assert.strictEqual(whenLabel(new Date('2026-11-08T16:00:00Z'), NOW), 'tomorrow at 9:00 AM');
  assert.strictEqual(whenLabel(new Date('2026-11-10T16:00:00Z'), NOW), 'Tue, Nov 10 at 9:00 AM');
});

async function harness({ read, sendFails = false } = {}) {
  const firestore = createFakeFirestore();
  let clock = NOW;
  const db = createDb({ firestore, now: () => clock });
  await db.linkSpace({ dealId: '111', dealNumber: '90001', store: 'UT', spaceName: 'spaces/DEAL', spaceUri: 'https://chat.google.com/room/DEAL', how: 'adopted', by: 'b' });
  const sent = [];
  const logs = [];
  const r = createReminders({
    anthropic: {},
    db,
    findDealSpace: async ({ dealNumber }) => ({ 90001: { deal: { id: '111', properties: { dealstage: OPEN } } }, 90002: { deal: { id: '222', properties: { dealstage: OPEN } } } })[dealNumber] || null,
    findDirectMessage: async (userName) => `spaces/DM-${userName.slice(6)}`,
    sendMessage: async (space, message) => {
      if (sendFails) throw new Error('chat down');
      sent.push([space, message]);
    },
    log: (...a) => logs.push(a),
    endpoint: 'https://example.com/',
    parse: async () => read || { ok: true, forSelf: true, what: 'let the Roamer know if we got the awning arm ordered', dueAt: new Date('2026-11-07T21:00:00Z'), usage: { input_tokens: 300, output_tokens: 30 }, costUsd: 0.0005 },
    now: () => clock,
  });
  const remind = (over = {}) => r.remind({ spaceName: 'spaces/DEAL', isDirectMessage: false, userEmail: 'casey@example.com', userName: 'users/5', text: 'me let the Roamer know if we got that ordered within the hour', ...over });
  return { r, remind, sent, logs, data: firestore.data, tick: (at) => ((clock = at), r.due()) };
}

test('in a deal space, a reminder is set for that deal and confirmed with its time, and logs never hold its words', async () => {
  const h = await harness();
  assert.strictEqual(await h.remind(), SAY.set('today at 2:00 PM', 'let the Roamer know if we got the awning arm ordered', '90001'));
  const [rem] = Object.values(h.data.reminders);
  assert.deepStrictEqual(
    { ...rem, at: undefined },
    { userEmail: 'casey@example.com', userName: 'users/5', what: 'let the Roamer know if we got the awning arm ordered', dueAt: '2026-11-07T21:00:00.000Z', dealId: '111', dealNumber: '90001', spaceUri: 'https://chat.google.com/room/DEAL', status: 'pending', at: undefined },
  );
  assert.ok(!JSON.stringify(h.logs).includes('awning'));
});

test('in a direct message, a deal number ties the reminder to that deal; two deals are refused', async () => {
  const dm = await harness();
  await dm.remind({ spaceName: 'spaces/DM-5', isDirectMessage: true, text: 'me check the hitch on 90001 at 2' });
  assert.strictEqual(Object.values(dm.data.reminders)[0].dealNumber, '90001');

  const plain = await harness();
  await plain.remind({ spaceName: 'spaces/DM-5', isDirectMessage: true, text: 'me call the shop at 2' });
  assert.strictEqual(Object.values(plain.data.reminders)[0].dealNumber, null);

  const two = await harness();
  assert.strictEqual(await two.remind({ spaceName: 'spaces/DM-5', isDirectMessage: true, text: 'me check 90001 and 90002' }), SAY.whichDeal(['90001', '90002']));
  assert.strictEqual(two.data.reminders, undefined);
});

test('a request it cannot read, for someone else, in the past, or too far ahead is not set', async () => {
  assert.strictEqual(await (await harness()).remind({ text: '' }), SAY.empty);
  assert.strictEqual(await (await harness({ read: { ok: false, reason: 'not_understood', usage: {} } })).remind(), SAY.unclear);
  assert.strictEqual(await (await harness({ read: { ok: true, forSelf: false, what: 'x', dueAt: new Date('2026-11-07T21:00:00Z'), usage: {} } })).remind(), SAY.selfOnly);
  assert.strictEqual(await (await harness({ read: { ok: true, forSelf: true, what: 'x', dueAt: new Date('2026-11-07T19:00:00Z'), usage: {} } })).remind(), SAY.past);
  assert.strictEqual(await (await harness({ read: { ok: true, forSelf: true, what: 'x', dueAt: new Date('2027-03-01T19:00:00Z'), usage: {} } })).remind(), SAY.tooFar);
});

test('a due reminder is sent once, to the person, as a card; its words are cleared after', async () => {
  const h = await harness();
  await h.remind();
  assert.strictEqual(await h.tick(new Date('2026-11-07T20:55:00Z')), 0, 'not yet due');
  assert.strictEqual(await h.tick(new Date('2026-11-07T21:03:00Z')), 1);
  assert.strictEqual(await h.tick(new Date('2026-11-07T21:08:00Z')), 0, 'never twice');
  assert.deepStrictEqual(h.sent, [['spaces/DM-5', reminderCard({ id: Object.keys(h.data.reminders)[0], what: 'let the Roamer know if we got the awning arm ordered', dealNumber: '90001', spaceUri: 'https://chat.google.com/room/DEAL', endpoint: 'https://example.com/' })]]);
  const [rem] = Object.values(h.data.reminders);
  assert.deepStrictEqual([rem.status, rem.what], ['sent', null]);
});

test('a reminder that cannot be sent is marked failed and logged, not retried', async () => {
  const h = await harness({ sendFails: true });
  await h.remind();
  assert.strictEqual(await h.tick(new Date('2026-11-07T21:03:00Z')), 0);
  assert.deepStrictEqual([Object.values(h.data.reminders)[0].status, Object.values(h.data.reminders)[0].what], ['failed', null]);
  assert.ok(h.logs.some((l) => l[1] === 'reminder could not be sent'));
});

test('the reminder card offers a text draft and the space on a deal, and neither without one', () => {
  const card = reminderCard({ id: 'r1', what: 'Call <Pat>', dealNumber: '90001', spaceUri: 'https://chat.google.com/room/DEAL', endpoint: 'https://example.com/' }).cardsV2[0].card;
  assert.deepStrictEqual(card.header, { title: 'Reminder', subtitle: 'Deal 90001' });
  assert.strictEqual(card.sections[0].widgets[0].textParagraph.text, 'Call &lt;Pat&gt;');
  const [draft, open] = card.sections[0].widgets[1].buttonList.buttons;
  assert.deepStrictEqual([draft.text, draft.type, open.text, open.type], ['Draft a text', 'FILLED', 'Open space', 'OUTLINED']);
  assert.deepStrictEqual(draft.onClick.action.parameters, [{ key: 'action', value: 'remindText' }, { key: 'n', value: '90001' }, { key: 'm', value: 'Call <Pat>' }]);
  const plain = reminderCard({ id: 'r2', what: 'Call the shop', endpoint: 'x' }).cardsV2[0].card;
  assert.deepStrictEqual([plain.header, plain.sections[0].widgets.length], [{ title: 'Reminder' }, 1]);
});

const BLAKE = 'blake@example.com';
const accept = async () => true;
const slashRemind = (text) => ({
  chat: { user: { name: 'users/123', email: BLAKE }, eventTime: 't', appCommandPayload: { space: { name: 'spaces/DM1', spaceType: 'DIRECT_MESSAGE' }, message: { text: `/remind ${text}`, argumentText: ` ${text}` }, appCommandMetadata: { appCommandId: 8 } } },
});
const draftClick = (n, m) => ({
  commonEventObject: { invokedFunction: 'https://example.com/', parameters: { action: 'remindText', n, m } },
  chat: { user: { name: 'users/123', email: BLAKE }, eventTime: 't', buttonClickedPayload: { space: { name: 'spaces/DM1', spaceType: 'DIRECT_MESSAGE' }, message: { name: 'spaces/DM1/messages/1' } } },
});

test('the router: /remind (command 8 or typed) sets a reminder; Draft a text starts a /text draft with its words', async () => {
  assert.deepStrictEqual(parseCommand('remind me call Pat at 2'), { command: 'remind', text: 'me call Pat at 2' });
  const set = [];
  const texts = [];
  const router = createRouter({ verify: accept, allowedUsers: [BLAKE], briefUsers: [BLAKE], setReminder: async (j) => (set.push(j), 'Got it.'), startText: async (j) => (texts.push(j), 'draft card') });
  const r = await router({ headers: { authorization: 'x' }, body: slashRemind('me call Pat at 2') });
  assert.match(JSON.stringify(r.body), /Got it\./);
  assert.deepStrictEqual(set[0], { spaceName: 'spaces/DM1', isDirectMessage: true, userEmail: BLAKE, userName: 'users/123', text: 'me call Pat at 2' });

  await router({ headers: { authorization: 'x' }, body: draftClick('90001', 'let the Roamer know it is ordered') });
  assert.deepStrictEqual(texts[0], { spaceName: 'spaces/DM1', isDirectMessage: true, userEmail: BLAKE, text: '90001 let the Roamer know it is ordered' });
  await router({ headers: { authorization: 'x' }, body: draftClick('9; drop', 'x') });
  assert.strictEqual(texts.length, 1, 'a malformed deal number starts nothing');

  // Reading the time spends credits, so it needs the brief permission.
  const off = createRouter({ verify: accept, allowedUsers: [BLAKE], briefUsers: [], setReminder: async () => assert.fail('no reminder for someone without credits') });
  await off({ headers: { authorization: 'x' }, body: slashRemind('me call Pat at 2') });
});

test('the timer endpoint accepts only the signer it names', async () => {
  const client = (email) => ({ verifyIdToken: async () => ({ getPayload: () => ({ email, email_verified: true }) }) });
  const tick = (email) => createVerifier({ audience: 'https://basecamp.example/tasks/tick', signers: ['basecamp-router@roa-agent-hub.iam.gserviceaccount.com'], client: client(email) });
  assert.strictEqual(await tick('basecamp-router@roa-agent-hub.iam.gserviceaccount.com')('Bearer t'), true);
  assert.strictEqual(await tick('chat@system.gserviceaccount.com')('Bearer t'), false, 'Chat itself cannot fire the timer');
  assert.strictEqual(await tick('basecamp-router@roa-agent-hub.iam.gserviceaccount.com')(''), false);
});
