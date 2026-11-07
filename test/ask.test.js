'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { routeQuestion, costOf, ROLES, UNSURE, MODEL } = require('../src/agents/askRouter');
const { createQuestionRouter, reviewMessage, SAY } = require('../src/askJob');
const { createRouter, parseCommand, MESSAGES } = require('../src/router');
const { createDb } = require('../src/db');
const { createFakeFirestore } = require('./fakeFirestore');

const NOW = new Date('2026-11-07T19:00:00Z');

// An Anthropic client that answers with `out` and records what it was sent.
function fakeAnthropic(out, { stop = 'end_turn', usage = { input_tokens: 600, output_tokens: 30 } } = {}) {
  const sent = [];
  return {
    sent,
    messages: {
      create: async (body, opts) => (sent.push([body, opts]), { stop_reason: stop, usage, model: MODEL, content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }] }),
    },
  };
}

test('routing sends only the question, to the small model with a schema, and prices the call', async () => {
  const anthropic = fakeAnthropic({ role: 'Parts Manager', reason: 'Asks when a part arrives.' });
  const r = await routeQuestion({ anthropic, question: 'When does the awning arm get here?' });
  assert.deepStrictEqual({ ok: r.ok, role: r.role, reason: r.reason }, { ok: true, role: 'Parts Manager', reason: 'Asks when a part arrives.' });
  assert.strictEqual(r.costUsd, (600 * 1 + 30 * 5) / 1e6);
  const [body, opts] = anthropic.sent[0];
  assert.strictEqual(body.model, 'claude-haiku-4-5-20251001');
  assert.strictEqual(body.messages[0].content, '<question>\nWhen does the awning arm get here?\n</question>');
  assert.deepStrictEqual(body.output_config.format.schema.properties.role.enum, [...Object.keys(ROLES), UNSURE]);
  assert.ok(opts.timeout > 0);
  assert.ok(body.system.includes('Service Advisor') && !/Service Writer/.test(body.system));
});

test('routing refuses anything but a known role', async () => {
  for (const [out, why] of [
    [{ role: 'Janitor', reason: 'x' }, 'bad_output'],
    ['not json', 'bad_output'],
  ]) {
    assert.strictEqual((await routeQuestion({ anthropic: fakeAnthropic(out), question: 'q' })).reason, why);
  }
  assert.strictEqual((await routeQuestion({ anthropic: fakeAnthropic('', { stop: 'refusal' }), question: 'q' })).reason, 'refusal');
  assert.strictEqual(costOf(null), null);
});

async function harness({ routed = { ok: true, role: 'Service Advisor', reason: 'Asks about a repair order.', usage: { input_tokens: 600, output_tokens: 30 }, costUsd: 0.00075, model: MODEL }, reviewerKnown = true, linked = true } = {}) {
  const firestore = createFakeFirestore();
  const db = createDb({ firestore, now: () => NOW });
  if (linked) {
    await db.linkSpace({ dealId: '111', dealNumber: '90001', store: 'UT', spaceName: 'spaces/DEAL', spaceUri: 'https://chat.google.com/room/DEAL', how: 'adopted', by: 'b' });
  }
  if (reviewerKnown) await db.rememberPerson({ email: 'blake@example.com', userName: 'users/9' });
  const sent = [];
  const logs = [];
  const ask = createQuestionRouter({
    anthropic: {},
    db,
    sendMessage: async (space, text) => sent.push([space, text]),
    findDirectMessage: async (userName) => `dm-of-${userName}`,
    reviewerEmail: 'blake@example.com',
    log: (...a) => logs.push(a),
    route: async () => routed,
  });
  const run = (over = {}) => ask({ spaceName: 'spaces/DEAL', isDirectMessage: false, userEmail: 'casey@example.com', userDisplayName: 'Casey Coach', text: 'Is the RO for the water pump open?', ...over });
  return { run, sent, logs, data: firestore.data };
}

test('a question is sent to Blake labeled with its role, recorded without its text, and the asker told', async () => {
  const { run, sent, logs, data } = await harness();
  assert.strictEqual(await run(), SAY.routed('Service Advisor'));
  assert.deepStrictEqual(sent, [
    [
      'dm-of-users/9',
      reviewMessage({ role: 'Service Advisor', reason: 'Asks about a repair order.', who: 'Casey Coach (casey@example.com)', dealNumber: '90001', spaceUri: 'https://chat.google.com/room/DEAL', question: 'Is the RO for the water pump open?' }),
    ],
  ]);
  const [q] = Object.values(data.questions);
  assert.deepStrictEqual(q, { dealId: '111', spaceName: 'spaces/DEAL', askedBy: 'casey@example.com', role: 'Service Advisor', model: MODEL, inputTokens: 600, outputTokens: 30, costUsd: 0.00075, status: 'shadow', at: NOW.toISOString() });
  assert.ok(!JSON.stringify(logs).includes('water pump'));
  assert.strictEqual(logs.at(-1)[2].costUsd, 0.00075);
});

test('a question outside a deal space still routes, with no deal', async () => {
  const { run, sent, data } = await harness({ linked: false });
  await run({ spaceName: 'spaces/DM', isDirectMessage: true });
  assert.ok(sent[0][1].includes('in a direct message'));
  assert.strictEqual(Object.values(data.questions)[0].dealId, null);
});

test('unsure, failed, and unreachable routings say so and send nothing wrong', async () => {
  const unsure = await harness({ routed: { ok: true, role: UNSURE, reason: 'Too vague.', usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0 } });
  assert.strictEqual(await unsure.run(), SAY.routed(UNSURE));

  const failed = await harness({ routed: { ok: false, reason: 'bad_output', usage: { input_tokens: 5, output_tokens: 5 } } });
  assert.strictEqual(await failed.run(), SAY.failed);
  assert.deepStrictEqual(failed.sent, []);
  assert.strictEqual(Object.values(failed.data.questions)[0].status, 'failed');

  const noReviewer = await harness({ reviewerKnown: false });
  assert.strictEqual(await noReviewer.run(), SAY.noReviewer);
  assert.deepStrictEqual(noReviewer.sent, []);

  const empty = await harness();
  assert.strictEqual(await empty.run({ text: ' ' }), SAY.empty);
});

test('the router: "ask" needs the brief permission, and every allowed sender is remembered', async () => {
  assert.deepStrictEqual(parseCommand('ask who has the title?'), { command: 'ask', text: 'who has the title?' });
  const asked = [];
  const seen = [];
  const r = createRouter({
    verify: async () => true,
    allowedUsers: ['b@example.com', 'c@example.com'],
    briefUsers: ['b@example.com'],
    askQuestion: async (q) => (asked.push(q), 'routed'),
    seenPerson: (p) => seen.push(p),
  });
  const msg = (email) => ({ type: 'MESSAGE', space: { name: 'spaces/DEAL', spaceType: 'SPACE' }, user: { email, name: 'users/5' }, message: { text: '@Basecamp ask who has the title?', argumentText: ' ask who has the title?' } });
  assert.deepStrictEqual((await r({ headers: { authorization: 'x' }, body: msg('b@example.com') })).body, { text: 'routed' });
  assert.deepStrictEqual((await r({ headers: { authorization: 'x' }, body: msg('c@example.com') })).body, { text: MESSAGES.notBriefUser });
  assert.strictEqual(asked.length, 1);
  assert.deepStrictEqual(seen[0], { email: 'b@example.com', userName: 'users/5' });
});
