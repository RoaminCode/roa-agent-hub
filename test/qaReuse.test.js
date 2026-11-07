'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { checkEarlier, stillGood, formatEarlier } = require('../src/agents/qaReuse');
const { createQuestionRouter, reuseLine, verdictCard, SAY } = require('../src/askJob');
const { createRouter } = require('../src/router');
const { createDb } = require('../src/db');
const { createFakeFirestore } = require('./fakeFirestore');

const NOW = new Date('2026-11-09T19:00:00Z');
const NOTES = [{ noteId: '555', text: 'Basecamp Q&A: awning arm\nQ (Nov 7, 11:43 AM MT, Casey Coach): Has the awning arm come in?\nA (Nov 7, 12:05 PM MT, Blake Locke): Arrives Tuesday.' }];

const fakeAnthropic = (out) => ({ messages: { create: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 60 }, content: [{ type: 'text', text: JSON.stringify(out) }] }) } });

test('the reuse check only names notes it was given, and needs an answer to reuse one', async () => {
  const ok = await checkEarlier({ anthropic: fakeAnthropic({ decision: 'answered', noteId: '555', answer: 'Arrives Tuesday.', answeredBy: 'Blake Locke', answeredOn: '2026-11-07', kind: 'status', reason: 'same question' }), question: 'when does the awning arm get here?', notes: NOTES });
  assert.deepStrictEqual([ok.ok, ok.decision, ok.noteId, ok.kind], [true, 'answered', '555', 'status']);
  const made = await checkEarlier({ anthropic: fakeAnthropic({ decision: 'follow_up', noteId: '999', answer: '', answeredBy: '', answeredOn: '', kind: 'fact', reason: '' }), question: 'q', notes: NOTES });
  assert.strictEqual(made.reason, 'unknown_note');
  const empty = await checkEarlier({ anthropic: fakeAnthropic({ decision: 'answered', noteId: '555', answer: ' ', answeredBy: 'B', answeredOn: '2026-11-07', kind: 'fact', reason: '' }), question: 'q', notes: NOTES });
  assert.strictEqual(empty.reason, 'bad_output');
  const fresh = await checkEarlier({ anthropic: fakeAnthropic({ decision: 'new', noteId: '555', answer: '', answeredBy: '', answeredOn: '', kind: 'fact', reason: '' }), question: 'q', notes: NOTES });
  assert.strictEqual(fresh.noteId, '');
  assert.ok(formatEarlier({ question: '<b>q</b>', notes: NOTES }).includes('&lt;b&gt;q&lt;/b&gt;'));
});

test('the 48-hour rule: a fact is reused at any age, a status only within 48 hours', () => {
  assert.ok(stillGood({ kind: 'fact', answeredOn: '2025-01-01' }, NOW.getTime()));
  assert.ok(stillGood({ kind: 'status', answeredOn: '2026-11-08' }, NOW.getTime()));
  assert.ok(!stillGood({ kind: 'status', answeredOn: '2026-11-06' }, NOW.getTime()));
  assert.ok(!stillGood({ kind: 'status', answeredOn: '' }, NOW.getTime()));
});

async function harness(found, { answeredAt = '2026-11-09T10:00:00Z' } = {}) {
  const firestore = createFakeFirestore();
  const db = createDb({ firestore, now: () => NOW });
  await db.linkSpace({ dealId: '111', dealNumber: '90001', store: 'UT', spaceName: 'spaces/DEAL', spaceUri: 'u', how: 'adopted', by: 'b' });
  await db.recordBrief({ dealId: '111', dealNumber: '90001', store: 'UT', contactId: '77', noteId: '9', signature: {} });
  await db.rememberPerson({ email: 'blake@example.com', userName: 'users/9' });
  const earlierId = await db.recordQuestion({ dealId: '111', spaceName: 'spaces/DEAL', noteId: '555', topic: 'awning arm', askedBy: 'c', role: 'Parts Manager', status: 'shadow' });
  if (answeredAt) await firestore.collection('questions').doc(earlierId).set({ answeredAt }, { merge: true });
  const sent = [];
  const qa = [];
  const q = createQuestionRouter({
    anthropic: {},
    db,
    sendMessage: async (space, message, opts = {}) => (sent.push([space, message, opts.threadName || null]), { threadName: `${space}/threads/t${sent.length}` }),
    findDirectMessage: async () => 'spaces/DM-9',
    reviewerEmail: 'blake@example.com',
    log: () => {},
    endpoint: 'https://example.com/',
    qaNotes: {
      readNotes: async (ids) => NOTES.filter((n) => ids.includes(n.noteId)),
      addQuestion: async (a) => (qa.push(['new', a.topic]), '600'),
      addFollowUp: async (a) => (qa.push(['follow-up', a.noteId]), a.noteId),
    },
    route: async () => ({ ok: true, role: 'Parts Manager', reason: 'parts', topic: 'awning arm tracking', clarify: '', usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0.001 }),
    reuseCheck: async () => found,
    now: () => NOW,
  });
  const ask = () => q.ask({ spaceName: 'spaces/DEAL', threadName: 'spaces/DEAL/threads/Q', isDirectMessage: false, userEmail: 'c@example.com', userDisplayName: 'Casey', text: 'When does the awning arm get here?' });
  return { q, ask, sent, qa, data: firestore.data };
}

const ANSWERED = { ok: true, decision: 'answered', noteId: '555', answer: 'Arrives Tuesday.', answeredBy: 'Blake Locke', answeredOn: '2026-11-07', kind: 'status', reason: '', costUsd: 0.001 };

test('a reusable earlier answer: Blake sees what Basecamp would say and a Right/Wrong card; the question joins that topic note', async () => {
  const h = await harness(ANSWERED);
  assert.strictEqual(await h.ask(), SAY.routed('Parts Manager'));
  const [review, card] = h.sent;
  assert.ok(review[1].includes('*Basecamp would answer:* "Arrives Tuesday." (Blake Locke, 2026-11-07, status)'));
  assert.strictEqual(card[2], 'spaces/DM-9/threads/t1');
  const q = Object.entries(h.data.questions).find(([, v]) => v.originThread === 'spaces/DEAL/threads/Q');
  assert.deepStrictEqual(card[1], verdictCard({ questionId: q[0], endpoint: 'https://example.com/' }));
  assert.deepStrictEqual(h.qa, [['follow-up', '555']]);
  assert.deepStrictEqual(q[1].reuse, { decision: 'answered', noteId: '555', kind: 'status', stillGood: true, answeredOn: '2026-11-07', costUsd: 0.001 });
  assert.strictEqual(q[1].noteId, '555');
  // No answer text in the database.
  assert.ok(!JSON.stringify(h.data.questions).includes('Arrives Tuesday'));

  assert.strictEqual(await h.q.reuseVerdict({ id: q[0], verdict: 'right', userEmail: 'blake@example.com' }), SAY.verdict('right'));
  assert.strictEqual(h.data.questions[q[0]].reuseVerdict, 'right');
  assert.strictEqual(await h.q.reuseVerdict({ id: '../x', verdict: 'right' }), SAY.verdictFailed);
});

test('a status answer over 48 hours old is not reused, and needs no verdict', async () => {
  const h = await harness(ANSWERED, { answeredAt: '2026-11-07T15:00:00Z' });
  await h.ask();
  assert.ok(h.sent[0][1].includes('more than 48 hours old'));
  assert.strictEqual(h.sent.length, 1);
  assert.deepStrictEqual(h.qa, [['follow-up', '555']]);
});

test('a follow-up is filed in its topic note; a new question gets its own note', async () => {
  const follow = await harness({ ...ANSWERED, decision: 'follow_up' });
  await follow.ask();
  assert.ok(follow.sent[0][1].includes(reuseLine({ decision: 'follow_up' })));
  assert.deepStrictEqual(follow.qa, [['follow-up', '555']]);

  const fresh = await harness({ ok: true, decision: 'new', noteId: '' });
  await fresh.ask();
  assert.deepStrictEqual(fresh.qa, [['new', 'awning arm tracking']]);
  assert.ok(!fresh.sent[0][1].includes('Basecamp would answer'));

  const broken = await harness(null);
  await broken.ask();
  assert.deepStrictEqual(broken.qa, [['new', 'awning arm tracking']]);
});

test('the router takes Right or Wrong and replaces the card', async () => {
  const calls = [];
  const r = createRouter({ verify: async () => true, allowedUsers: ['b@example.com'], reuseVerdict: async (v) => (calls.push(v), 'Marked right. Thanks.') });
  const click = {
    commonEventObject: { hostApp: 'CHAT', invokedFunction: 'x', parameters: { action: 'reuseVerdict', id: 'q1', verdict: 'right' } },
    chat: { user: { email: 'b@example.com', name: 'users/5' }, eventTime: 't', buttonClickedPayload: { space: { name: 'spaces/DM', spaceType: 'DIRECT_MESSAGE' }, message: { name: 'm' } } },
  };
  const res = await r({ headers: { authorization: 'x' }, body: click });
  assert.deepStrictEqual(calls, [{ id: 'q1', verdict: 'right', userEmail: 'b@example.com' }]);
  assert.deepStrictEqual(res.body, { hostAppDataAction: { chatDataAction: { updateMessageAction: { message: { text: 'Marked right. Thanks.' } } } } });
});
