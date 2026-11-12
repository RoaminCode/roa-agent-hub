'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { readPromise, checkKept, formatEntries } = require('../src/agents/commitment');
const { dueFor, nextOpen, isOpen } = require('../src/workHours');
const { createCommitments, SAY } = require('../src/commitJob');
const { createDb } = require('../src/db');
const { createFakeFirestore } = require('./fakeFirestore');

// Thursday, Nov 12 2026, 10:00 AM in Utah (MST, UTC-7).
const NOW = new Date('2026-11-12T17:00:00Z');
const iso = (d) => d && d.toISOString();

test('a promise with no time is due at 2 PM Mountain on the day named, the next business day on a weekend', () => {
  assert.strictEqual(iso(dueFor({ day: '2026-11-13', time: '' }, NOW)), '2026-11-13T21:00:00.000Z', 'Friday 2 PM');
  assert.strictEqual(iso(dueFor({ day: '2026-11-14', time: '' }, NOW)), '2026-11-16T21:00:00.000Z', 'Saturday moves to Monday 2 PM');
  assert.strictEqual(iso(dueFor({ day: '', time: '' }, NOW)), '2026-11-12T21:00:00.000Z', 'no day named: today');
  assert.strictEqual(iso(dueFor({ day: '2026-11-12', time: '15:30' }, NOW)), '2026-11-12T22:30:00.000Z', 'a stated time is kept');
  // Made after 2 PM for "today": closing time; made after closing: 2 PM the next business day.
  assert.strictEqual(iso(dueFor({ day: '2026-11-12', time: '' }, new Date('2026-11-12T22:00:00Z'))), '2026-11-13T00:00:00.000Z');
  assert.strictEqual(iso(dueFor({ day: '2026-11-13', time: '' }, new Date('2026-11-14T01:00:00Z'))), '2026-11-16T21:00:00.000Z', 'Friday evening moves to Monday');
  assert.strictEqual(dueFor({ day: '2026-11-12', time: '09:00' }, NOW), null, 'a stated time already past is a misread');
});

test('follow-ups go out Monday to Friday, 8 AM to 5 PM Mountain', () => {
  assert.strictEqual(isOpen(NOW), true);
  assert.strictEqual(isOpen(new Date('2026-11-13T00:00:00Z')), false, '5 PM is closed');
  assert.strictEqual(isOpen(new Date('2026-11-14T18:00:00Z')), false, 'Saturday');
  assert.strictEqual(iso(nextOpen(NOW)), iso(NOW));
  assert.strictEqual(iso(nextOpen(new Date('2026-11-12T13:00:00Z'))), '2026-11-12T15:00:00.000Z', 'before opening: 8 AM');
  assert.strictEqual(iso(nextOpen(new Date('2026-11-14T02:00:00Z'))), '2026-11-16T15:00:00.000Z', 'Friday evening: Monday 8 AM');
  // Through daylight saving: a July morning is UTC-6.
  assert.strictEqual(iso(nextOpen(new Date('2026-07-04T18:00:00Z'))), '2026-07-06T14:00:00.000Z');
});

const model = (out) => {
  const sent = [];
  return { sent, messages: { create: async (body) => (sent.push(body), { stop_reason: 'end_turn', usage: { input_tokens: 400, output_tokens: 30 }, content: [{ type: 'text', text: JSON.stringify(out) }] }) } };
};

test('the promise reader sends the Utah time and the answer as data to the small model', async () => {
  const m = model({ promised: true, what: 'have the arrival date from Parts', day: '2026-11-13', time: '' });
  const r = await readPromise({ anthropic: m, answer: 'I will have that <tomorrow>', now: NOW });
  assert.deepStrictEqual([r.ok, r.promised, r.what, r.day, r.time], [true, true, 'have the arrival date from Parts', '2026-11-13', '']);
  assert.strictEqual(m.sent[0].model, 'claude-haiku-5-5');
  assert.ok(m.sent[0].messages[0].content.startsWith('Now in Utah: Thursday 2026-11-12 10:00'));
  assert.ok(m.sent[0].messages[0].content.includes('&lt;tomorrow&gt;'));
  assert.strictEqual((await readPromise({ anthropic: model({ promised: false, what: '', day: '', time: '' }), answer: 'It shipped Monday', now: NOW })).promised, false);
  assert.strictEqual((await readPromise({ anthropic: model({ promised: true, what: '', day: '', time: '' }), answer: 'x', now: NOW })).promised, false, 'a promise with no words is none');
  const odd = await readPromise({ anthropic: model({ promised: true, what: 'call', day: 'Friday', time: '3pm' }), answer: 'x', now: NOW });
  assert.deepStrictEqual([odd.day, odd.time], ['', ''], 'a day or time not in the asked shape is dropped');
});

test('the kept check trusts "kept" only with the entry that shows it', async () => {
  const entries = [
    { source: 'space', channel: 'message', who: 'Casey Coach', at: '2026-11-12T18:00:00Z', text: 'Any word?' },
    { source: 'hubspot', channel: 'note', who: 'Sam Advisor', at: '2026-11-12T19:00:00Z', text: 'Parts says the arm lands <Nov 18>' },
  ];
  const kept = await checkKept({ anthropic: model({ kept: true, entry: 2 }), promise: 'have the arrival date', entries });
  assert.deepStrictEqual([kept.kept, kept.entry.who], [true, 'Sam Advisor']);
  assert.strictEqual((await checkKept({ anthropic: model({ kept: true, entry: 0 }), promise: 'x', entries })).kept, false);
  assert.strictEqual((await checkKept({ anthropic: model({ kept: true, entry: 9 }), promise: 'x', entries })).kept, false);
  assert.strictEqual((await checkKept({ anthropic: model({ kept: false, entry: 0 }), promise: 'x', entries })).kept, false);
  const text = formatEntries({ promise: 'have the <date>', entries });
  assert.ok(text.includes('have the &lt;date&gt;') && text.includes('where="HubSpot note"') && text.includes('where="deal space"') && text.includes('&lt;Nov 18&gt;'));
});

const QUESTION = { id: 'q1', dealId: '111', noteId: '700', topic: 'awning arm', reviewerThread: 'spaces/DM-9/threads/Q', spaceName: 'spaces/DEAL', originThread: 'spaces/DEAL/threads/A' };

async function harness({ promise = { ok: true, promised: true, what: 'have the arrival date from Parts', day: '2026-11-13', time: '', costUsd: 0.0001 }, verdict = { ok: true, kept: false, entry: null }, space = [], items = [], aiOff = false, sendFails = false } = {}) {
  const firestore = createFakeFirestore({ questions: { q1: { ...QUESTION, id: undefined, status: 'answered', answeredAt: '2026-11-12T16:59:00.000Z' } }, people: { 'blake@example.com': { userName: 'users/9' } } });
  let clock = NOW;
  const db = createDb({ firestore, now: () => clock });
  await db.linkSpace({ dealId: '111', dealNumber: '90001', store: 'UT', spaceName: 'spaces/DEAL', spaceUri: 'u', how: 'adopted', by: 'b' });
  const sent = [];
  const logs = [];
  const filed = [];
  const judged = [];
  const off = { now: aiOff };
  const c = createCommitments({
    anthropic: {},
    db,
    qaNotes: { addAnswer: async (a) => filed.push(a) },
    loadContext: async () => ({ found: true, items }),
    listSpaceMessages: async (spaceName, since) => space.filter((m) => Date.parse(m.at) > since.getTime()),
    findDirectMessage: async (userName) => `spaces/DM-${userName.slice(6)}`,
    sendMessage: async (spaceName, message, opts) => {
      if (sendFails) throw new Error('chat down');
      sent.push([spaceName, message, opts]);
      return { name: 'm', threadName: (opts && opts.threadName) || 'spaces/DM-9/threads/NEW' };
    },
    reviewerEmail: 'blake@example.com',
    aiOff: async () => off.now,
    log: (...a) => logs.push(a),
    read: async () => promise,
    judge: async (a) => (judged.push(a), verdict),
    now: () => clock,
  });
  const answer = (over = {}) => c.noteAnswer({ question: QUESTION, answer: 'I will have that tomorrow', userEmail: 'sam@example.com', answeredBy: 'Sam Advisor', dealNumber: '90001', ...over });
  const all = () => Object.values(firestore.data.commitments || {});
  return { c, answer, sent, logs, filed, judged, off, all, data: firestore.data, tick: (at) => ((clock = at), c.due()), at: (t) => (clock = t) };
}

// Friday 2:02 PM in Utah, just past the promise's due time.
const DUE = new Date('2026-11-13T21:02:00Z');

test('an answer that promises something is noted with its due time, and the answerer is told when Basecamp will check in', async () => {
  const h = await harness();
  assert.strictEqual(await h.answer(), SAY.noted('tomorrow at 2:00 PM'));
  const [c] = h.all();
  assert.deepStrictEqual(
    { ...c, promisedAt: undefined },
    { questionId: 'q1', dealId: '111', dealNumber: '90001', noteId: '700', topic: 'awning arm', by: 'sam@example.com', byName: 'Sam Advisor', what: 'have the arrival date from Parts', promisedAt: undefined, dueAt: '2026-11-13T21:00:00.000Z', sendAt: '2026-11-13T21:00:00.000Z', status: 'pending', tries: 0 },
  );
  assert.ok(!JSON.stringify(h.logs).includes('arrival date'), 'logs never hold the promise');
});

test('an answer that promises nothing, a misread time, or AI being off notes nothing', async () => {
  const none = await harness({ promise: { ok: true, promised: false } });
  assert.strictEqual(await none.answer(), null);
  const past = await harness({ promise: { ok: true, promised: true, what: 'call', day: '2026-11-12', time: '09:00' } });
  assert.strictEqual(await past.answer(), null);
  const bad = await harness({ promise: { ok: false, reason: 'bad_output' } });
  assert.strictEqual(await bad.answer(), null);
  const off = await harness({ aiOff: true });
  assert.strictEqual(await off.answer(), null);
  for (const h of [none, past, bad, off]) assert.strictEqual(h.all().length, 0);
});

test('a promise due outside business hours is checked when they next open', async () => {
  const h = await harness({ promise: { ok: true, promised: true, what: 'send the photos', day: '2026-11-12', time: '19:00' } });
  await h.answer();
  assert.deepStrictEqual([h.all()[0].dueAt, h.all()[0].sendAt], ['2026-11-13T02:00:00.000Z', '2026-11-13T15:00:00.000Z']);
  assert.strictEqual(await h.tick(new Date('2026-11-13T02:05:00Z')), 0, 'not in the evening');
  assert.strictEqual(await h.tick(new Date('2026-11-13T15:02:00Z')), 1, 'at 8 AM the next business day');
});

test('nothing goes out before the due time; then one follow-up to Blake, labeled, in the question thread, and never a second', async () => {
  const h = await harness();
  await h.answer();
  assert.strictEqual(await h.tick(new Date('2026-11-13T20:55:00Z')), 0, 'not before it is due');
  assert.strictEqual(await h.tick(DUE), 1);
  assert.strictEqual(h.sent.length, 1);
  const [space, text, opts] = h.sent[0];
  assert.strictEqual(space, 'spaces/DM-9');
  assert.deepStrictEqual(opts, { threadName: 'spaces/DM-9/threads/Q' }, 'a reply in that thread is read as the answer');
  assert.ok(text.includes('Would go to: Sam Advisor') && text.includes('Deal 90001') && text.includes('"have the arrival date from Parts", due today at 2:00 PM'));
  assert.ok(!/[–—]/.test(text));
  assert.strictEqual(h.judged.length, 0, 'nothing was said since, so no AI call');
  assert.deepStrictEqual([h.all()[0].status, h.all()[0].what], ['followed_up', null], 'kept on record without its words');
  assert.ok(h.logs.some((l) => l[1] === 'commitment follow-up sent' && l[2].by === 'sam@example.com'));
  assert.strictEqual(await h.tick(new Date('2026-11-13T21:10:00Z')), 0, 'one follow-up only');
  assert.strictEqual(h.sent.length, 1);
});

test('a promise kept in the deal space or HubSpot gets no follow-up, and what kept it is filed as the answer', async () => {
  const note = { id: '5', channel: 'note', at: '2026-11-13T18:00:00Z', who: 'Sam Advisor', text: 'Parts says the arm lands Nov 18' };
  const old = { id: '4', channel: 'call', at: '2026-11-10T18:00:00Z', who: 'outbound, Sam Advisor', text: 'Earlier call' };
  const h = await harness({ items: [old, note], space: [{ who: 'Casey Coach', at: '2026-11-13T17:00:00Z', text: 'Any word on the arm?' }] });
  h.judged.length = 0;
  await h.answer();
  // The fake verdict names the HubSpot note as what kept it.
  const kept = await harness({ items: [old, note], space: [{ who: 'Casey Coach', at: '2026-11-13T17:00:00Z', text: 'Any word on the arm?' }], verdict: { ok: true, kept: true, entry: { source: 'hubspot', ...note } } });
  await kept.answer();
  assert.strictEqual(await kept.tick(DUE), 0);
  assert.strictEqual(kept.sent.length, 0);
  assert.deepStrictEqual(kept.judged[0].entries.map((e) => e.text), ['Any word on the arm?', 'Parts says the arm lands Nov 18'], 'only what came after the promise, oldest first');
  assert.strictEqual(kept.judged[0].promise, 'have the arrival date from Parts');
  assert.deepStrictEqual(kept.filed, [{ noteId: '700', answer: 'Parts says the arm lands Nov 18', answeredBy: 'Sam Advisor, in HubSpot, found by Basecamp', at: new Date('2026-11-13T18:00:00Z') }]);
  assert.deepStrictEqual([kept.all()[0].status, kept.all()[0].keptBy, kept.all()[0].what], ['kept', 'hubspot', null]);

  // Talk that does not keep it: the follow-up goes out.
  assert.strictEqual(await h.tick(DUE), 1);
});

test('a newer answer keeps the promise: on the same question at once, on the same topic at the due time', async () => {
  const h = await harness();
  await h.answer();
  await h.answer({ answer: 'It lands Nov 18' });
  assert.deepStrictEqual(h.all().map((c) => c.status).sort(), ['kept', 'pending'], 'the first is kept by the newer answer; the fake reader notes the second');

  const topic = await harness();
  await topic.answer();
  topic.data.questions.q2 = { dealId: '111', noteId: '700', status: 'answered', answeredAt: '2026-11-13T16:00:00.000Z' };
  assert.strictEqual(await topic.tick(DUE), 0);
  assert.deepStrictEqual([topic.all()[0].status, topic.all()[0].keptBy, topic.sent.length], ['kept', 'answer', 0]);
});

test('while AI is off a promise with something to read waits; a failing check is tried again, then the follow-up goes out', async () => {
  const said = [{ who: 'Casey Coach', at: '2026-11-13T17:00:00Z', text: 'Any word?' }];
  const h = await harness({ space: said });
  await h.answer();
  h.off.now = true;
  assert.strictEqual(await h.tick(DUE), 0);
  assert.deepStrictEqual([h.all()[0].status, h.all()[0].tries, h.sent.length], ['pending', 0, 0]);
  h.off.now = false;
  assert.strictEqual(await h.tick(new Date('2026-11-13T21:07:00Z')), 1);

  const bad = await harness({ space: said, verdict: { ok: false, reason: 'bad_output' } });
  await bad.answer();
  assert.strictEqual(await bad.tick(DUE), 0);
  assert.strictEqual(await bad.tick(new Date('2026-11-13T21:07:00Z')), 0);
  assert.strictEqual(await bad.tick(new Date('2026-11-13T21:12:00Z')), 1, 'the third time it goes out anyway');
});

test('a follow-up that cannot be sent is tried on later timer runs, then given up on; a new thread is remembered', async () => {
  const h = await harness({ sendFails: true });
  await h.answer();
  for (const t of ['21:02', '21:07', '21:12']) await h.tick(new Date(`2026-11-13T${t}:00Z`));
  assert.deepStrictEqual([h.all()[0].status, h.all()[0].what], ['failed', null]);
  assert.ok(h.logs.some((l) => l[1] === 'commitment check gave up'));

  const gone = await harness();
  gone.data.questions.q1.reviewerThread = 'spaces/OTHER/threads/X';
  await gone.answer();
  await gone.tick(DUE);
  assert.deepStrictEqual(gone.sent[0][2], { threadName: null }, 'a thread in another space is not used');
  assert.strictEqual(gone.data.questions.q1.reviewerThread, 'spaces/DM-9/threads/NEW', 'so a reply to the follow-up is still the answer');
});

test('a relayed answer is handed to the commitment reader, and its line is added to the reply', async () => {
  const { createQuestionRouter, SAY: ASK } = require('../src/askJob');
  const firestore = createFakeFirestore({ questions: { q1: { reviewerThread: 'spaces/DM-9/threads/Q', spaceName: 'spaces/DEAL', originThread: 'spaces/DEAL/threads/A', noteId: null, answers: 0 } } });
  const seen = [];
  const make = (onAnswer) =>
    createQuestionRouter({ anthropic: {}, db: createDb({ firestore, now: () => NOW }), sendMessage: async () => ({}), findDirectMessage: async () => 'spaces/DM-9', reviewerEmail: 'blake@example.com', log: () => {}, onAnswer });
  const relay = (q) => q.relayAnswer({ threadName: 'spaces/DM-9/threads/Q', userEmail: 'blake@example.com', userDisplayName: 'Blake Locke', text: 'I will have that tomorrow' });
  const said = await relay(make(async (a) => (seen.push(a), 'I noted it.')));
  assert.strictEqual(said, `${ASK.relayed(null, false)} I noted it.`);
  assert.deepStrictEqual([seen[0].question.id, seen[0].answer, seen[0].userEmail, seen[0].answeredBy], ['q1', 'I will have that tomorrow', 'blake@example.com', 'Blake Locke']);
  // A reader that fails or finds nothing leaves the reply as it was.
  assert.strictEqual(await relay(make(async () => { throw new Error('x'); })), ASK.relayed(null, false));
  assert.strictEqual(await relay(make(async () => null)), ASK.relayed(null, false));
});
