'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createFakeFirestore } = require('./fakeFirestore');
const { createDb } = require('../src/db');
const { createMeter, withMeter, dayOf } = require('../src/spend');
const { MODELS, PRICES, costOf } = require('../src/agents/models');
const { runStructured } = require('../src/agents/run');
const { createRouter, parseCommand, MESSAGES } = require('../src/router');
const { createSpaceNotes, SAY: NOTE_SAY } = require('../src/spaceNotes');

const NOW = new Date('2026-11-11T18:00:00Z');
const SCHEMA = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } };

// An Anthropic client that answers with `content` and records what it was sent.
function fakeAnthropic(content, { stop = 'end_turn', usage = { input_tokens: 1000, output_tokens: 100 }, model } = {}) {
  const sent = [];
  return { sent, messages: { create: async (body, opts) => (sent.push([body, opts]), { stop_reason: stop, usage, model: model || body.model, content }) } };
}
const run = (anthropic, extra = {}) => runStructured({ anthropic, job: 'route', model: MODELS.small, effort: 'low', maxTokens: 1024, timeout: 1000, system: 's', schema: SCHEMA, user: 'u', ...extra });

test('every model Basecamp calls has a price, and a call is priced by the model that answered', () => {
  for (const id of Object.values(MODELS)) assert.ok(PRICES[id], `${id} has a price`);
  assert.strictEqual(costOf({ input_tokens: 1e6, output_tokens: 1e6 }, 'claude-opus-5-5'), 24);
  assert.strictEqual(costOf({ input_tokens: 1e6, output_tokens: 0 }, 'claude-haiku-5-5'), 0.5, 'a long prompt is on the higher Haiku rate');
  assert.strictEqual(costOf({ input_tokens: 1000, output_tokens: 0 }, 'claude-haiku-5-5'), 0.0001);
  assert.strictEqual(costOf(null, 'claude-opus-5-5'), null);
  assert.strictEqual(costOf({ input_tokens: 1, output_tokens: 1 }, 'some-other-model'), null, 'an unknown model is not guessed at');
});

test('a structured call reads the text after any thinking, and names a cut-off answer', async () => {
  const thinking = { type: 'thinking', thinking: '', signature: 'x' };
  const ok = await run(fakeAnthropic([thinking, { type: 'text', text: '{"a":"b"}' }]));
  assert.deepStrictEqual({ ok: ok.ok, out: ok.out, model: ok.model }, { ok: true, out: { a: 'b' }, model: MODELS.small });
  assert.strictEqual(ok.costUsd, (1000 * 0.1 + 100 * 0.5) / 1e6);

  const anthropic = fakeAnthropic([thinking], { stop: 'max_tokens' });
  const cut = await run(anthropic);
  assert.deepStrictEqual({ ok: cut.ok, reason: cut.reason }, { ok: false, reason: 'too_long' });
  assert.ok(cut.costUsd > 0, 'a cut-off answer was still paid for');
  assert.deepStrictEqual(anthropic.sent[0][0].output_config, { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } });

  assert.strictEqual((await run(fakeAnthropic([{ type: 'text', text: 'not json' }]))).reason, 'bad_output');
  assert.strictEqual((await run(fakeAnthropic([], { stop: 'refusal' }))).reason, 'refusal');
});

function meterOn({ limitUsd = null, at = NOW } = {}) {
  const firestore = createFakeFirestore();
  const told = [];
  const logs = [];
  let now = at;
  const db = createDb({ firestore, now: () => now });
  const meter = createMeter({ db, log: (s, m, f) => logs.push([s, m, f]), limitUsd, notify: async (t) => told.push(t), now: () => now });
  return { firestore, db, meter, told, logs, at: (d) => (now = d) };
}

test('every call is counted on its day, by job and model, and on its deal', async () => {
  const h = meterOn();
  const anthropic = withMeter(fakeAnthropic([{ type: 'text', text: '{"a":"b"}' }]), h.meter);
  await run(anthropic, { dealId: '111' });
  await run(anthropic, { job: 'remind' });
  await run(anthropic, { dealId: '111', job: 'route' });
  const day = h.firestore.data.spend['2026-11-11'];
  const each = (1000 * 0.1 + 100 * 0.5) / 1e6;
  assert.strictEqual(day.calls, 3);
  assert.ok(Math.abs(day.totalUsd - 3 * each) < 1e-12);
  assert.strictEqual(day.jobs.route.calls, 2);
  assert.strictEqual(day.jobs.remind.calls, 1);
  assert.strictEqual(day.models[MODELS.small].calls, 3);
  assert.strictEqual(h.firestore.data.deals['111'].aiCalls, 2);
  assert.ok(Math.abs(h.firestore.data.deals['111'].aiCostUsd - 2 * each) < 1e-12);
  assert.ok(!JSON.stringify(h.firestore.data.spend).includes('"u"'), 'nothing anyone wrote is kept');
});

test('the day is counted in Utah time', () => {
  assert.strictEqual(dayOf(new Date('2026-11-12T05:30:00Z')), '2026-11-11');
  assert.strictEqual(dayOf(new Date('2026-11-12T08:00:00Z')), '2026-11-12');
});

test('at the daily limit, AI is over for the day, Blake is told once, and the next day starts clean', async () => {
  const h = meterOn({ limitUsd: 0.5 });
  assert.strictEqual(await h.meter.overLimit(), false);
  await h.meter.record({ job: 'brief', model: MODELS.brief, costUsd: 0.3 });
  assert.strictEqual(await h.meter.overLimit(), false);
  await h.meter.record({ job: 'brief', model: MODELS.brief, costUsd: 0.3 });
  assert.strictEqual(await h.meter.overLimit(), true);
  await h.meter.record({ job: 'brief', model: MODELS.brief, costUsd: 0.3 });
  assert.strictEqual(h.told.length, 1);
  assert.match(h.told[0], /\$0\.50/);
  assert.ok(h.logs.some(([s, m]) => s === 'WARNING' && m === 'AI daily limit reached'));
  h.at(new Date('2026-11-12T18:00:00Z'));
  assert.strictEqual(await h.meter.overLimit(), false);
});

test('with no limit nothing is ever over, and a count that fails does not stop the job', async () => {
  const h = meterOn();
  await h.meter.record({ job: 'brief', model: MODELS.brief, costUsd: 999 });
  assert.strictEqual(await h.meter.overLimit(), false);
  const logs = [];
  const broken = createMeter({ db: { addSpend: async () => { throw new Error('down'); }, getSpend: async () => { throw new Error('down'); } }, log: (s, m) => logs.push([s, m]), limitUsd: 1 });
  await broken.record({ job: 'brief', model: MODELS.brief, costUsd: 0.1 });
  assert.strictEqual(await broken.overLimit(), false, 'a database problem is not a spending problem');
  assert.deepStrictEqual(logs.map(([, m]) => m), ['could not record AI spend', 'could not read AI spend']);
  await broken.record({ job: 'x', model: 'unpriced', costUsd: null });
  assert.strictEqual(logs.at(-1)[1], 'AI call not priced');
});

test('the spend report totals the last days by job and day', async () => {
  const h = meterOn({ limitUsd: 2 });
  h.at(new Date('2026-11-10T18:00:00Z'));
  await h.meter.record({ job: 'brief', model: MODELS.brief, costUsd: 0.18 });
  h.at(NOW);
  await h.meter.record({ job: 'brief', model: MODELS.brief, costUsd: 0.2 });
  await h.meter.record({ job: 'route', model: MODELS.small, costUsd: 0.0002 });
  const said = await h.meter.report(7);
  assert.match(said, /\*AI spend, last 7 days:\* \$0\.38 across 3 calls/);
  assert.match(said, /Today: \$0\.20 of the \$2\.00 daily limit/);
  assert.match(said, /• brief: \$0\.38 \(2\)/);
  assert.match(said, /• route: \$0\.0002 \(1\)/);
  assert.match(said, /• Nov 11: \$0\.20 \(2\)\n• Nov 10: \$0\.18 \(1\)/);
  assert.match(await meterOn().meter.report(7), /No AI spend recorded/);
});

const headers = { authorization: 'x' };
const dm = (email, text) => ({ type: 'MESSAGE', space: { name: 'spaces/DM', spaceType: 'DIRECT_MESSAGE' }, user: { email, name: 'users/5' }, message: { name: 'spaces/DM/messages/1', text } });

test('the router: over the daily limit, AI jobs get a short answer and notes still save', async () => {
  const started = [];
  const r = createRouter({ verify: async () => true, allowedUsers: ['b@example.com'], aiUsers: ['b@example.com'], overDailyLimit: async () => true, startBrief: (j) => started.push(j), saveSpaceNote: async () => 'saved' });
  assert.deepStrictEqual((await r({ headers, body: dm('b@example.com', 'brief 90001') })).body, { text: MESSAGES.overLimit });
  assert.deepStrictEqual((await r({ headers, body: dm('b@example.com', 'note 90001 hello') })).body, { text: 'saved' });
  assert.deepStrictEqual(started, []);
  // A limit check that fails does not turn AI off.
  const down = createRouter({ verify: async () => true, allowedUsers: ['b@example.com'], aiUsers: ['b@example.com'], overDailyLimit: async () => { throw new Error('down'); }, startBrief: (j) => started.push(j) });
  await down({ headers, body: dm('b@example.com', 'brief 90001') });
  assert.strictEqual(started.length, 1);
});

test('the router: "cost" shows the spend report to AI users in a direct message only', async () => {
  assert.deepStrictEqual(parseCommand('cost'), { command: 'cost' });
  assert.deepStrictEqual(parseCommand('Spend?'), { command: 'cost' });
  const r = createRouter({ verify: async () => true, allowedUsers: ['b@example.com', 'c@example.com'], aiUsers: ['b@example.com'], showCost: async () => 'the report' });
  assert.deepStrictEqual((await r({ headers, body: dm('b@example.com', 'cost') })).body, { text: 'the report' });
  assert.deepStrictEqual((await r({ headers, body: dm('c@example.com', 'cost') })).body, { text: MESSAGES.help });
});

test('the router: approving a text is its own permission, apart from AI credits and the pause', async () => {
  const calls = [];
  const notices = [];
  const make = (opts) =>
    createRouter({
      verify: async () => true,
      allowedUsers: ['ai@example.com', 'approver@example.com'],
      aiUsers: ['ai@example.com'],
      textApprovers: ['approver@example.com'],
      startText: async () => (calls.push('draft'), 'draft card'),
      reviewText: async () => (calls.push('review'), { header: { title: 'dialog' } }),
      sendText: async () => (calls.push('send'), 'sent'),
      postNotice: (n) => notices.push(n.text),
      ...opts,
    });
  const click = (email, action) => ({
    commonEventObject: { hostApp: 'CHAT', invokedFunction: 'x', parameters: { action, d: '111', n: '90001' }, formInputs: { message: { stringInputs: { value: ['Hi Pat'] } }, confirm: { stringInputs: { value: ['yes'] } } } },
    chat: { user: { email, name: 'users/5' }, eventTime: 't', buttonClickedPayload: { space: { name: 'spaces/DEAL', spaceType: 'SPACE' }, message: { name: 'm', thread: { name: 'spaces/DEAL/threads/T' } } } },
  });
  const closed = { action: { navigations: [{ endNavigation: { action: 'CLOSE_DIALOG' } }] } };
  const r = make();
  // On the AI list but not an approver: may not open the dialog or send.
  assert.deepStrictEqual((await r({ headers, body: click('ai@example.com', 'textReview') })).body, closed);
  assert.deepStrictEqual((await r({ headers, body: click('ai@example.com', 'textSend') })).body, closed);
  assert.deepStrictEqual(notices, [MESSAGES.notApprover, MESSAGES.notApprover]);
  assert.deepStrictEqual(calls, []);
  // An approver who has no AI credits may approve and send.
  assert.deepStrictEqual((await r({ headers, body: click('approver@example.com', 'textReview') })).body, { action: { navigations: [{ pushCard: { header: { title: 'dialog' } } }] } });
  assert.deepStrictEqual((await r({ headers, body: click('approver@example.com', 'textSend') })).body, closed);
  assert.deepStrictEqual(calls, ['review', 'send']);
  // A pause or the daily limit stops AI, not an approval.
  const paused = make({ aiPaused: true, overDailyLimit: async () => true });
  await paused({ headers, body: click('approver@example.com', 'textSend') });
  assert.deepStrictEqual(calls, ['review', 'send', 'send']);
  // An empty approver list means nobody.
  const nobody = make({ textApprovers: [] });
  await nobody({ headers, body: click('approver@example.com', 'textSend') });
  assert.strictEqual(calls.length, 3);
});

test('a direct message note on a deal Basecamp has never briefed goes on its one contact, and never on a guess', async () => {
  const firestore = createFakeFirestore();
  const created = [];
  const found = {
    90001: { deal: { id: '111' }, spaceName: null, contactId: '77', contactCount: 1, deliveryId: null },
    90002: { deal: { id: '222' }, spaceName: null, contactId: null, contactCount: 2, deliveryId: null },
    90003: { deal: { id: '333' }, spaceName: null, contactId: null, contactCount: 0, deliveryId: null },
  };
  const save = createSpaceNotes({ db: createDb({ firestore, now: () => NOW }), createNote: async (n) => (created.push(n), '777'), findDealSpace: async ({ dealNumber }) => found[dealNumber] || null, log: () => {}, now: () => NOW });
  const note = (text) => save({ spaceName: 'spaces/DM', isDirectMessage: true, userEmail: 'casey@example.com', userDisplayName: 'Casey Coach', text });
  assert.strictEqual(await note('90001 Pat wants Saturday'), NOTE_SAY.saved('90001', false));
  assert.deepStrictEqual([created[0].contactId, created[0].deliveryId], ['77', null]);
  assert.strictEqual(await note('90002 Pat wants Saturday'), NOTE_SAY.severalContacts('90002'));
  assert.strictEqual(await note('90003 Pat wants Saturday'), NOTE_SAY.noRoamer('90003'));
  assert.strictEqual(created.length, 1);
});
