'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createWhatsNew, parseSince, newCard, SAY } = require('../src/newJob');
const { summarizeNew } = require('../src/agents/whatsNew');
const { createRouter, parseCommand, MESSAGES } = require('../src/router');
const { createDb } = require('../src/db');
const { createFakeFirestore } = require('./fakeFirestore');

// Sunday Nov 8, 2026, 10 AM in Utah.
const NOW = new Date('2026-11-08T17:00:00Z');
const item = (id, at) => ({ id, channel: 'text', at, who: 'from the Roamer', text: `message ${id}` });
const ITEMS = [item('1', '2026-10-20T15:00:00Z'), item('2', '2026-11-03T15:00:00Z'), item('3', '2026-11-07T03:00:00Z')];

test('reading "since": weekdays, dates, and short phrases, in Utah time', () => {
  assert.strictEqual(parseSince('', NOW), null);
  assert.deepStrictEqual(parseSince('since Monday', NOW), { from: '2026-11-02' });
  assert.deepStrictEqual(parseSince('sunday', NOW), { from: '2026-11-08' });
  assert.deepStrictEqual(parseSince('yesterday', NOW), { from: '2026-11-07' });
  assert.deepStrictEqual(parseSince('this week', NOW), { from: '2026-11-02' });
  assert.deepStrictEqual(parseSince('5 days', NOW), { from: '2026-11-03' });
  assert.deepStrictEqual(parseSince('since 11/3', NOW), { from: '2026-11-03' });
  assert.deepStrictEqual(parseSince('12/25', NOW), { from: '2025-12-25' });
  assert.deepStrictEqual(parseSince('whenever', NOW), { error: true });
});

async function harness({ items = ITEMS, newestAt = '2026-11-03T15:00:00Z', listed = [{ detail: 'Asked about the awning arm.', date: '2026-11-06', channel: 'text' }] } = {}) {
  const db = createDb({ firestore: createFakeFirestore(), now: () => NOW });
  await db.linkSpace({ dealId: '111', dealNumber: '90001', store: 'UT', spaceName: 'spaces/DEAL', spaceUri: 'u', how: 'adopted', by: 'b' });
  const seen = [];
  const run = createWhatsNew({
    anthropic: {},
    db,
    loadContext: async () => ({ found: true, items, briefNote: newestAt ? { signature: { newestAt } } : null }),
    findDealSpace: async ({ dealNumber }) => (dealNumber === '90001' ? { deal: { id: '111' } } : null),
    log: () => {},
    summarize: async ({ items: given }) => (seen.push(given.map((i) => i.id)), { ok: true, items: listed, usage: {} }),
    now: () => NOW,
  });
  return { run, seen };
}

test('/new: only the items after the last brief, or after the day asked for, are summarized', async () => {
  const h = await harness();
  const card = await h.run({ spaceName: 'spaces/DEAL', isDirectMessage: false, text: '' });
  assert.deepStrictEqual(h.seen[0], ['3']);
  assert.deepStrictEqual(card, newCard({ dealNumber: '90001', sinceLabel: 'the last brief', items: [{ detail: 'Asked about the awning arm.', date: '2026-11-06', channel: 'text' }] }));
  await h.run({ spaceName: 'spaces/DEAL', isDirectMessage: false, text: 'since 11/3' });
  assert.deepStrictEqual(h.seen[1], ['2', '3']);
  assert.strictEqual(card.cardsV2[0].card.header.subtitle, 'Since the last brief');
  // No brief yet: the last 7 days.
  const noBrief = await harness({ newestAt: null });
  await noBrief.run({ spaceName: 'spaces/DEAL', isDirectMessage: false, text: '' });
  assert.deepStrictEqual(noBrief.seen[0], ['2', '3']);
});

test('/new says so when nothing is new, without an AI call', async () => {
  const h = await harness({ newestAt: '2026-11-07T03:00:00Z' });
  assert.strictEqual(await h.run({ spaceName: 'spaces/DEAL', isDirectMessage: false, text: '' }), SAY.nothing('90001', 'the last brief'));
  assert.deepStrictEqual(h.seen, []);
  const quiet = await harness({ listed: [] });
  assert.strictEqual(await quiet.run({ spaceName: 'spaces/DEAL', isDirectMessage: false, text: '' }), SAY.nothingWorth('90001', 'the last brief'));
});

test('/new needs a deal and a readable date', async () => {
  const h = await harness();
  assert.strictEqual(await h.run({ spaceName: 'spaces/OTHER', isDirectMessage: false, text: '' }), SAY.notDealSpace);
  assert.strictEqual(await h.run({ spaceName: 'spaces/DM', isDirectMessage: true, text: 'since monday' }), SAY.dealFirst);
  assert.strictEqual(await h.run({ spaceName: 'spaces/DM', isDirectMessage: true, text: '90002' }), SAY.noDeal('90002'));
  assert.strictEqual(await h.run({ spaceName: 'spaces/DEAL', isDirectMessage: false, text: 'since whenever' }), SAY.badSince);
  assert.ok((await h.run({ spaceName: 'spaces/DM', isDirectMessage: true, text: '90001 since monday' })).cardsV2);
});

test('the summary sees only the items it is given, escaped, and drops dashes', async () => {
  const sent = [];
  const anthropic = { messages: { create: async (b) => (sent.push(b), { stop_reason: 'end_turn', usage: { input_tokens: 400, output_tokens: 60 }, content: [{ type: 'text', text: JSON.stringify({ items: [{ detail: 'Asked — twice', date: '2026-11-06', channel: 'text' }] }) }] }) } };
  const r = await summarizeNew({ anthropic, items: [{ ...item('9', '2026-11-06T15:00:00Z'), text: '<b>hi</b>' }] });
  assert.strictEqual(r.items[0].detail, 'Asked, twice');
  assert.ok(sent[0].messages[0].content.includes('&lt;b&gt;hi&lt;/b&gt;'));
  assert.strictEqual(sent[0].model, 'claude-haiku-4-5-20251001');
});

test('the router: /new, "anything new?", and command 7 start in the background for people who may brief', async () => {
  assert.deepStrictEqual(parseCommand('anything new since Monday?'), { command: 'new', text: 'since Monday?' });
  assert.strictEqual(parseCommand('newer trailer'), null);
  const started = [];
  const r = createRouter({ verify: async () => true, allowedUsers: ['b@example.com', 'c@example.com'], briefUsers: ['b@example.com'], startNew: (j) => started.push(j.text) });
  const msg = (email, text) => ({ type: 'MESSAGE', space: { name: 'spaces/DEAL', spaceType: 'SPACE' }, user: { email, name: 'users/5' }, message: { text, argumentText: ` ${text}`, thread: { name: 'spaces/DEAL/threads/T' } } });
  assert.deepStrictEqual((await r({ headers: { authorization: 'x' }, body: msg('b@example.com', 'anything new?') })).body, { text: MESSAGES.newWorking });
  assert.deepStrictEqual((await r({ headers: { authorization: 'x' }, body: msg('c@example.com', 'new') })).body, { text: MESSAGES.notBriefUser });
  const slash = { commonEventObject: { hostApp: 'CHAT' }, chat: { user: { email: 'b@example.com', name: 'users/5' }, eventTime: 't', appCommandPayload: { appCommandMetadata: { appCommandId: 7, appCommandType: 'SLASH_COMMAND' }, space: { name: 'spaces/DEAL', spaceType: 'SPACE' }, message: { text: '/new since monday', argumentText: ' since monday' } } } };
  await r({ headers: { authorization: 'x' }, body: slash });
  assert.deepStrictEqual(started, ['', 'since monday']);
});
