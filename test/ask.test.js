'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { routeQuestion, costOf, ROLES, UNSURE, MODEL } = require('../src/agents/askRouter');
const { createQuestionRouter, reviewMessage, SAY } = require('../src/askJob');
const { createQaNotes, renderQaNote, isQaNoteText } = require('../src/hubspot/qaNotes');
const { createChatSender } = require('../src/chat/send');
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
  const anthropic = fakeAnthropic({ role: 'Parts Manager', reason: 'Asks when a part arrives.', topic: 'Awning Arm!' });
  const r = await routeQuestion({ anthropic, question: 'When does the awning arm get here?' });
  assert.deepStrictEqual({ ok: r.ok, role: r.role, reason: r.reason, topic: r.topic }, { ok: true, role: 'Parts Manager', reason: 'Asks when a part arrives.', topic: 'awning arm' });
  assert.strictEqual(r.costUsd, (600 * 1 + 30 * 5) / 1e6);
  const [body, opts] = anthropic.sent[0];
  assert.strictEqual(body.model, 'claude-haiku-4-5-20251001');
  assert.strictEqual(body.messages[0].content, '<question>\nWhen does the awning arm get here?\n</question>');
  assert.deepStrictEqual(body.output_config.format.schema.properties.role.enum, [...Object.keys(ROLES), UNSURE]);
  assert.ok(opts.timeout > 0);
  assert.ok(body.system.includes('Service Advisor') && !/Service Writer/.test(body.system));
});

test('routing refuses anything but a known role with a topic', async () => {
  for (const out of [{ role: 'Janitor', reason: 'x', topic: 't' }, { role: 'Parts Manager', reason: 'x' }, 'not json']) {
    assert.strictEqual((await routeQuestion({ anthropic: fakeAnthropic(out), question: 'q' })).reason, 'bad_output');
  }
  assert.strictEqual((await routeQuestion({ anthropic: fakeAnthropic('', { stop: 'refusal' }), question: 'q' })).reason, 'refusal');
  assert.strictEqual(costOf(null), null);
});

const ROUTED = { ok: true, role: 'Parts Manager', reason: 'Asks when a part arrives.', topic: 'awning arm', usage: { input_tokens: 600, output_tokens: 30 }, costUsd: 0.00075, model: MODEL };

async function harness({ routed = ROUTED, reviewerKnown = true, linked = true, qaFails = false, relayFails = false } = {}) {
  const firestore = createFakeFirestore();
  const db = createDb({ firestore, now: () => NOW });
  if (linked) {
    await db.linkSpace({ dealId: '111', dealNumber: '90001', store: 'UT', spaceName: 'spaces/DEAL', spaceUri: 'https://chat.google.com/room/DEAL', how: 'adopted', by: 'b' });
    await db.recordBrief({ dealId: '111', dealNumber: '90001', store: 'UT', contactId: '77', noteId: '9', signature: {} });
  }
  if (reviewerKnown) await db.rememberPerson({ email: 'blake@example.com', userName: 'users/9' });
  const sent = [];
  const logs = [];
  const qa = [];
  const questions = createQuestionRouter({
    anthropic: {},
    db,
    sendMessage: async (space, text, opts = {}) => {
      if (relayFails && opts.threadName) throw new Error('chat down');
      sent.push([space, text, opts.threadName || null]);
      return { name: `${space}/messages/m${sent.length}`, threadName: `${space}/threads/t${sent.length}` };
    },
    findDirectMessage: async (userName) => `spaces/DM-${userName.slice(6)}`,
    reviewerEmail: 'blake@example.com',
    log: (...a) => logs.push(a),
    qaNotes: {
      addQuestion: async (q) => {
        if (qaFails) throw new Error('hubspot down');
        qa.push(['question', q]);
        return '555';
      },
      addAnswer: async (a) => (qa.push(['answer', a]), '555'),
    },
    route: async () => routed,
    now: () => NOW,
  });
  const ask = (over = {}) => questions.ask({ spaceName: 'spaces/DEAL', threadName: 'spaces/DEAL/threads/Q1', isDirectMessage: false, userEmail: 'casey@example.com', userDisplayName: 'Casey Coach', text: 'Has the awning arm come in?', ...over });
  return { ask, relay: questions.relayAnswer, sent, logs, qa, data: firestore.data };
}

test('a question goes to Blake labeled with its role and topic, is kept in HubSpot, and is recorded without its text', async () => {
  const { ask, sent, logs, qa, data } = await harness();
  assert.strictEqual(await ask(), SAY.routed('Parts Manager'));
  assert.deepStrictEqual(sent, [
    [
      'spaces/DM-9',
      reviewMessage({ role: 'Parts Manager', reason: 'Asks when a part arrives.', topic: 'awning arm', who: 'Casey Coach (casey@example.com)', dealNumber: '90001', spaceUri: 'https://chat.google.com/room/DEAL', question: 'Has the awning arm come in?' }),
      null,
    ],
  ]);
  assert.deepStrictEqual(qa, [['question', { dealId: '111', contactId: '77', deliveryId: null, topic: 'awning arm', question: 'Has the awning arm come in?', askedBy: 'Casey Coach', at: NOW }]]);
  const [q] = Object.values(data.questions);
  assert.deepStrictEqual(q, {
    dealId: '111',
    spaceName: 'spaces/DEAL',
    originThread: 'spaces/DEAL/threads/Q1',
    reviewerThread: 'spaces/DM-9/threads/t1',
    noteId: '555',
    topic: 'awning arm',
    askedBy: 'casey@example.com',
    role: 'Parts Manager',
    model: MODEL,
    inputTokens: 600,
    outputTokens: 30,
    costUsd: 0.00075,
    status: 'shadow',
    answers: 0,
    at: NOW.toISOString(),
  });
  assert.ok(!JSON.stringify(logs).includes('Has the awning'));
});

test("a reply in the routed question's thread goes back where it was asked, onto the Q&A note, and marks it answered", async () => {
  const { ask, relay, sent, qa, logs, data } = await harness();
  await ask();
  const said = await relay({ threadName: 'spaces/DM-9/threads/t1', userEmail: 'blake@example.com', userDisplayName: 'Blake Locke', text: 'Arrives Tuesday.' });
  assert.strictEqual(said, SAY.relayed('90001', true));
  assert.deepStrictEqual(sent.at(-1), ['spaces/DEAL', '*Answer from Blake Locke:* Arrives Tuesday.', 'spaces/DEAL/threads/Q1']);
  assert.deepStrictEqual(qa.at(-1), ['answer', { noteId: '555', answer: 'Arrives Tuesday.', answeredBy: 'Blake Locke', at: NOW }]);
  const [q] = Object.values(data.questions);
  assert.deepStrictEqual([q.status, q.answers, q.answeredBy], ['answered', 1, 'blake@example.com']);
  assert.ok(!JSON.stringify(logs).includes('Tuesday'));

  // A second reply in the same thread is a second answer.
  await relay({ threadName: 'spaces/DM-9/threads/t1', userEmail: 'blake@example.com', userDisplayName: 'Blake Locke', text: 'Tracking is 1Z999.' });
  assert.strictEqual(Object.values(data.questions)[0].answers, 2);
});

test('other direct messages are not answers', async () => {
  const { ask, relay } = await harness();
  await ask();
  assert.strictEqual(await relay({ threadName: 'spaces/DM-9/threads/other', userEmail: 'b', text: 'brief 90001' }), null);
  assert.strictEqual(await relay({ threadName: null, userEmail: 'b', text: 'hi' }), null);
  assert.strictEqual(await relay({ threadName: 'spaces/DM-9/threads/t1', userEmail: 'b', text: '  ' }), null);
});

test('a relay that cannot post says so and leaves the question unanswered', async () => {
  const { ask, relay, data } = await harness({ relayFails: true });
  await ask();
  assert.strictEqual(await relay({ threadName: 'spaces/DM-9/threads/t1', userEmail: 'b', text: 'Tuesday' }), SAY.relayFailed);
  assert.strictEqual(Object.values(data.questions)[0].status, 'shadow');
});

test('a question outside a deal space routes without a HubSpot note; HubSpot failing does not stop routing', async () => {
  const dm = await harness({ linked: false });
  await dm.ask({ spaceName: 'spaces/DM-5', isDirectMessage: true });
  assert.ok(dm.sent[0][1].includes('in a direct message'));
  assert.deepStrictEqual(dm.qa, []);
  assert.strictEqual(Object.values(dm.data.questions)[0].dealId, null);

  const down = await harness({ qaFails: true });
  assert.strictEqual(await down.ask(), SAY.routed('Parts Manager'));
  assert.strictEqual(Object.values(down.data.questions)[0].noteId, null);
});

test('unsure, failed, and unreachable routings say so and send nothing wrong', async () => {
  const unsure = await harness({ routed: { ...ROUTED, role: UNSURE } });
  assert.strictEqual(await unsure.ask(), SAY.routed(UNSURE));

  const failed = await harness({ routed: { ok: false, reason: 'bad_output', usage: { input_tokens: 5, output_tokens: 5 } } });
  assert.strictEqual(await failed.ask(), SAY.failed);
  assert.deepStrictEqual(failed.sent, []);
  assert.strictEqual(Object.values(failed.data.questions)[0].status, 'failed');

  const noReviewer = await harness({ reviewerKnown: false });
  assert.strictEqual(await noReviewer.ask(), SAY.noReviewer);
  assert.deepStrictEqual(noReviewer.sent, []);
  assert.deepStrictEqual(noReviewer.qa, []);

  const empty = await harness();
  assert.strictEqual(await empty.ask({ text: ' ' }), SAY.empty);
});

test('Q&A notes: a topic note with the question, answers added only to a note that is still ours', async () => {
  assert.strictEqual(
    renderQaNote({ topic: 'awning arm', question: 'Has it <come> in?', askedBy: 'Casey Coach', at: NOW }),
    '<p><strong>Basecamp Q&amp;A: awning arm</strong></p><p><strong>Q</strong> (Nov 7, 12:00 PM MT, Casey Coach): Has it &lt;come&gt; in?</p>',
  );
  const calls = [];
  const hubspot = {
    createDealNote: async (n) => (calls.push(['create', n]), '555'),
    get: async () => ({ properties: { hs_note_body: renderQaNote({ topic: 'awning arm', question: 'q', askedBy: 'C', at: NOW }) } }),
    updateNote: async (u) => (calls.push(['update', u]), u.noteId),
  };
  const notes = createQaNotes({ hubspot });
  await notes.addQuestion({ dealId: '111', contactId: '77', topic: 'awning arm', question: 'q', askedBy: 'C', at: NOW });
  assert.strictEqual(calls[0][1].contactId, '77');
  await notes.addAnswer({ noteId: '555', answer: 'Tuesday', answeredBy: 'Blake Locke', at: NOW });
  const update = calls[1][1];
  assert.ok(update.body.endsWith('<p><strong>A</strong> (Nov 7, 12:00 PM MT, Blake Locke): Tuesday</p>'));
  assert.ok(update.isOurs('<p>Basecamp Q&amp;A: x</p>') && !update.isOurs('<p>Someone else</p>'));
  assert.ok(isQaNoteText('Basecamp Q&A: awning arm'));
  await assert.rejects(notes.addAnswer({ noteId: '5/../x', answer: 'a', answeredBy: 'b', at: NOW }));
});

test('sendMessage can reply in a thread and returns the thread', async () => {
  const requests = [];
  const send = createChatSender({ auth: { getClient: async () => ({ request: async (r) => (requests.push(r), { data: { name: 'spaces/A/messages/1', thread: { name: 'spaces/A/threads/T' } } }) }) } });
  assert.deepStrictEqual(await send('spaces/A', 'hi', { threadName: 'spaces/A/threads/T' }), { name: 'spaces/A/messages/1', threadName: 'spaces/A/threads/T' });
  assert.ok(requests[0].url.endsWith('?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD'));
  assert.deepStrictEqual(requests[0].data, { text: 'hi', thread: { name: 'spaces/A/threads/T' } });
  await assert.rejects(send('spaces/A', 'hi', { threadName: 'spaces/B/threads/T' }), /invalid thread/);
});

test('the router: "ask" needs the brief permission and passes its thread; DM thread replies go to the relay first', async () => {
  assert.deepStrictEqual(parseCommand('ask who has the title?'), { command: 'ask', text: 'who has the title?' });
  const asked = [];
  const seen = [];
  const relays = [];
  const r = createRouter({
    verify: async () => true,
    allowedUsers: ['b@example.com', 'c@example.com'],
    briefUsers: ['b@example.com'],
    askQuestion: async (q) => (asked.push(q), 'routed'),
    relayAnswer: async (a) => (relays.push(a), a.threadName === 'spaces/DM/threads/Q' ? 'relayed' : null),
    seenPerson: (p) => seen.push(p),
  });
  const msg = (email, space, text, thread) => ({ type: 'MESSAGE', space, user: { email, name: 'users/5' }, message: { text, argumentText: ` ${text}`, thread: { name: thread } } });
  const deal = { name: 'spaces/DEAL', spaceType: 'SPACE' };
  const dm = { name: 'spaces/DM', spaceType: 'DIRECT_MESSAGE' };
  assert.deepStrictEqual((await r({ headers: { authorization: 'x' }, body: msg('b@example.com', deal, 'ask who has the title?', 'spaces/DEAL/threads/X') })).body, { text: 'routed' });
  assert.strictEqual(asked[0].threadName, 'spaces/DEAL/threads/X');
  assert.deepStrictEqual((await r({ headers: { authorization: 'x' }, body: msg('c@example.com', deal, 'ask who has the title?', 'spaces/DEAL/threads/Y') })).body, { text: MESSAGES.notBriefUser });
  assert.strictEqual(asked.length, 1);
  assert.deepStrictEqual(seen[0], { email: 'b@example.com', userName: 'users/5' });

  // An answer in the DM thread is relayed; any other DM message is handled as usual.
  assert.deepStrictEqual((await r({ headers: { authorization: 'x' }, body: msg('b@example.com', dm, 'Arrives Tuesday', 'spaces/DM/threads/Q') })).body, { text: 'relayed' });
  assert.deepStrictEqual((await r({ headers: { authorization: 'x' }, body: msg('b@example.com', dm, 'hello', 'spaces/DM/threads/Z') })).body, { text: MESSAGES.help });
  // Messages in a deal space never go to the relay.
  assert.ok(relays.every((a) => a.threadName.startsWith('spaces/DM/')));
});
