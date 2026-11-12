'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { checkEarlier, stillGood, formatEarlier } = require('../src/agents/qaReuse');
const { createQuestionRouter, reuseLine, verdictCard, SAY } = require('../src/askJob');
const { createRouter } = require('../src/router');
const { createDb } = require('../src/db');
const { recordDate } = require('../src/agents/roamerBrief');
const { createFakeFirestore } = require('./fakeFirestore');

// The Suggested answer section of a routed-question card, read back.
function suggestion(message) {
  const sec = message.cardsV2[0].card.sections.find((x) => x.header === '<b>Suggested answer</b>');
  if (!sec) return null;
  const [answer, from, row] = sec.widgets;
  return { header: sec.header, answer: answer.textParagraph.text, from: from.textParagraph.text, buttons: row.buttonList.buttons.map((b) => b.text), m: row.buttonList.buttons[0].onClick.action.parameters.find((p) => p.key === 'm').value };
}
const textOf = (m) => (typeof m === 'string' ? m : m.fallbackText);
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

test('the 48-hour rule never takes a future date as fresh, and counts from the end of the day in Utah', () => {
  // A wrong year guessed near New Year, or any date after today.
  assert.ok(!stillGood({ kind: 'status', answeredOn: '2026-11-10' }, NOW.getTime()));
  assert.ok(!stillGood({ kind: 'status', answeredOn: '2027-01-02' }, Date.parse('2027-01-01T18:00:00Z')));
  // Nov 7 ends at 06:59:59Z on Nov 8 in Utah; 48 hours later is 06:59:59Z on Nov 10.
  assert.ok(stillGood({ kind: 'status', answeredOn: '2026-11-07' }, Date.parse('2026-11-10T06:30:00Z')));
  assert.ok(!stillGood({ kind: 'status', answeredOn: '2026-11-07' }, Date.parse('2026-11-10T07:30:00Z')));
  // Daylight saving: Jul 4 ends at 05:59:59Z on Jul 5.
  assert.ok(stillGood({ kind: 'status', answeredOn: '2026-07-04' }, Date.parse('2026-07-07T05:30:00Z')));
  assert.ok(!stillGood({ kind: 'status', answeredOn: '2026-07-04' }, Date.parse('2026-07-07T06:30:00Z')));
  assert.ok(!stillGood({ kind: 'status', answeredOn: 'Nov 7' }, NOW.getTime()));
});

async function harness(found, { answeredAt = '2026-11-09T10:00:00Z', inBrief = null, inFacts = null, readDealFacts = null } = {}) {
  const firestore = createFakeFirestore();
  const db = createDb({ firestore, now: () => NOW });
  await db.linkSpace({ dealId: '111', dealNumber: '90001', store: 'UT', spaceName: 'spaces/DEAL', spaceUri: 'u', how: 'adopted', by: 'b' });
  await db.recordBrief({ dealId: '111', dealNumber: '90001', store: 'UT', contactId: '77', noteId: '9', signature: {} });
  await db.rememberPerson({ email: 'blake@example.com', userName: 'users/9' });
  const earlierId = await db.recordQuestion({ dealId: '111', spaceName: 'spaces/DEAL', noteId: '555', topic: 'awning arm', askedBy: 'c', role: 'Parts Manager', status: 'shadow' });
  if (answeredAt) await firestore.collection('questions').doc(earlierId).set({ answeredAt }, { merge: true });
  const sent = [];
  const qa = [];
  const logs = [];
  const q = createQuestionRouter({
    anthropic: {},
    db,
    sendMessage: async (space, message, opts = {}) => (sent.push([space, message, opts.threadName || null]), { threadName: `${space}/threads/t${sent.length}` }),
    findDirectMessage: async () => 'spaces/DM-9',
    reviewerEmail: 'blake@example.com',
    log: (...a) => logs.push(a),
    endpoint: 'https://example.com/',
    qaNotes: {
      readNotes: async (ids) => NOTES.filter((n) => ids.includes(n.noteId)),
      addQuestion: async (a) => (qa.push(['new', a.topic]), '600'),
      addFollowUp: async (a) => (qa.push(['follow-up', a.noteId]), a.noteId),
      addAnswer: async (a) => (qa.push(['answer', a.noteId, a.answer]), a.noteId),
    },
    route: async () => ({ ok: true, role: 'Parts Manager', reason: 'parts', topic: 'awning arm tracking', clarify: '', usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0.001 }),
    reuseCheck: async () => found,
    readBriefNote: async (id) => (id === '9' ? { brief: { who: 'Pat tows with a Jeep.' } } : null),
    briefCheck: async () => inBrief || { ok: true, decision: 'not_in_brief', answer: '', part: '', sourceDate: '', kind: 'fact', reason: '' },
    ...(readDealFacts ? { readDealFacts } : {}),
    factsCheck: async (input) => (typeof inFacts === 'function' ? inFacts(input) : inFacts),
    now: () => NOW,
  });
  const ask = () => q.ask({ spaceName: 'spaces/DEAL', threadName: 'spaces/DEAL/threads/Q', isDirectMessage: false, userEmail: 'c@example.com', userDisplayName: 'Casey', text: 'When does the awning arm get here?' });
  return { q, ask, sent, qa, logs, data: firestore.data };
}

const ANSWERED = { ok: true, decision: 'answered', noteId: '555', answer: 'Arrives Tuesday.', answeredBy: 'Blake Locke', answeredOn: '2026-11-07', kind: 'status', reason: '', costUsd: 0.001 };

test('a reusable earlier answer: Blake sees what Basecamp would say and a Right/Wrong card; the question joins that topic note', async () => {
  const h = await harness(ANSWERED);
  assert.strictEqual(await h.ask(), SAY.routed('Parts Manager'));
  assert.strictEqual(h.sent.length, 1, 'one card, no separate Right/Wrong card');
  const [review] = h.sent;
  assert.ok(textOf(review[1]).includes('*Basecamp would answer:* "Arrives Tuesday." (Blake Locke, 2026-11-07, status)'));
  assert.deepStrictEqual(suggestion(review[1]), { header: '<b>Suggested answer</b>', answer: 'Arrives Tuesday.', from: '<i>From Blake Locke, 2026-11-07 (status)</i>', buttons: ['Send this answer', 'Not right'], m: 'Arrives Tuesday.' });
  const q = Object.entries(h.data.questions).find(([, v]) => v.originThread === 'spaces/DEAL/threads/Q');
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
  assert.ok(textOf(h.sent[0][1]).includes('more than 48 hours old'));
  assert.strictEqual(h.sent.length, 1);
  assert.deepStrictEqual(h.qa, [['follow-up', '555']]);
});

test('a newer answer on the same topic does not make an old status answer fresh', async () => {
  // The reused answer is from Nov 5; the topic's only answer through Basecamp is from Nov 9.
  const h = await harness({ ...ANSWERED, answeredOn: '2026-11-05' }, { answeredAt: '2026-11-09T10:00:00Z' });
  await h.ask();
  assert.ok(textOf(h.sent[0][1]).includes('more than 48 hours old'));
});

test('a follow-up is filed in its topic note; a new question gets its own note', async () => {
  const follow = await harness({ ...ANSWERED, decision: 'follow_up' });
  await follow.ask();
  assert.ok(textOf(follow.sent[0][1]).includes(reuseLine({ decision: 'follow_up' })));
  assert.deepStrictEqual(follow.qa, [['follow-up', '555']]);

  const fresh = await harness({ ok: true, decision: 'new', noteId: '' });
  await fresh.ask();
  assert.deepStrictEqual(fresh.qa, [['new', 'awning arm tracking']]);
  assert.ok(!textOf(fresh.sent[0][1]).includes('Basecamp would answer'));

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

// The brief as a second source (Blake, 2026-11-07): a Team Member's earlier answer still wins.
const FROM_BRIEF = { ok: true, decision: 'answered', answer: 'Tows with a Jeep Grand Cherokee.', part: 'Key facts: Tow vehicle', sourceDate: '', kind: 'fact', reason: '', costUsd: 0.0012 };

test('with no earlier answer, Blake sees what the brief would say and a Right/Wrong card; the question gets its own note', async () => {
  const h = await harness({ ok: true, decision: 'new', noteId: '' }, { inBrief: FROM_BRIEF });
  await h.ask();
  const [review] = h.sent;
  assert.ok(textOf(review[1]).includes(`*Basecamp would answer from the brief:* "Tows with a Jeep Grand Cherokee." (the brief's Key facts: Tow vehicle, fact)`), textOf(review[1]));
  assert.deepStrictEqual(suggestion(review[1]).from, "<i>From the brief's Key facts: Tow vehicle (fact)</i>");
  const q = Object.entries(h.data.questions).find(([, v]) => v.originThread === 'spaces/DEAL/threads/Q');
  assert.deepStrictEqual(q[1].reuse, { decision: 'answered', source: 'brief', noteId: null, part: 'Key facts: Tow vehicle', kind: 'fact', stillGood: true, answeredOn: '', costUsd: 0.0012 });
  assert.deepStrictEqual(h.qa, [['new', 'awning arm tracking']]);
  assert.ok(!JSON.stringify(h.data.questions).includes('Jeep'));
});

test("a Team Member's earlier answer wins over the brief, and a follow-up stays filed in its topic", async () => {
  const both = await harness(ANSWERED, { inBrief: FROM_BRIEF });
  await both.ask();
  assert.ok(textOf(both.sent[0][1]).includes('*Basecamp would answer:* "Arrives Tuesday."'));
  assert.ok(!textOf(both.sent[0][1]).includes('from the brief'));

  const follow = await harness({ ...ANSWERED, decision: 'follow_up' }, { inBrief: FROM_BRIEF });
  await follow.ask();
  assert.ok(textOf(follow.sent[0][1]).includes('from the brief'));
  assert.deepStrictEqual(follow.qa, [['follow-up', '555']]);
});

test('a status from the brief counts only within 48 hours of its source, and never without a date', async () => {
  for (const sourceDate of ['2026-11-01', '']) {
    const h = await harness({ ok: true, decision: 'new', noteId: '' }, { inBrief: { ...FROM_BRIEF, kind: 'status', sourceDate } });
    await h.ask();
    assert.ok(textOf(h.sent[0][1]).includes('The brief has an answer'), h.sent[0][1]);
    assert.ok(textOf(h.sent[0][1]).includes('more than 48 hours old'));
    assert.strictEqual(h.sent.length, 1, 'no verdict card');
  }
});

test('the brief check sends the question and the brief to the small model, and refuses an empty answer', async () => {
  const { checkBrief, SCHEMA: BRIEF_SCHEMA } = require('../src/agents/briefAnswer');
  const sent = [];
  const fake = (out) => ({ messages: { create: async (body) => (sent.push(body), { stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 40 }, content: [{ type: 'text', text: JSON.stringify(out) }] }) } });
  const r = await checkBrief({ anthropic: fake(FROM_BRIEF), question: 'What is <Pat> towing with?', brief: { key_facts: [{ label: 'Tow vehicle', value: 'Jeep' }] } });
  assert.deepStrictEqual([r.ok, r.decision, r.part], [true, 'answered', 'Key facts: Tow vehicle']);
  assert.strictEqual(sent[0].model, 'claude-haiku-5-5');
  assert.deepStrictEqual(sent[0].output_config.format.schema, BRIEF_SCHEMA);
  assert.ok(sent[0].messages[0].content.includes('What is &lt;Pat&gt; towing with?'));
  assert.strictEqual((await checkBrief({ anthropic: fake({ ...FROM_BRIEF, answer: ' ' }), question: 'q', brief: {} })).ok, false);
});

// LightSpeed as a third source (2026-11-11): read live when the question is on a deal.
const FACTS = { view: { feed: 'open', deal: { dealNo: '90001' }, unit: {}, mods: [], prep: [] }, ros: [] };
const FROM_LIGHTSPEED = { ok: true, decision: 'answered', answer: 'Delivery is set for Nov 14.', part: 'Deal: delivery date', kind: 'status', reason: '', costUsd: 0.0015 };
const NOT_EARLIER = { ok: true, decision: 'new', noteId: '' };

test('with LightSpeed read, Blake sees what it would say; a status read just now is always fresh', async () => {
  const asked = [];
  const h = await harness(NOT_EARLIER, { readDealFacts: async (job) => (asked.push(job), FACTS), inFacts: FROM_LIGHTSPEED, inBrief: FROM_BRIEF });
  await h.ask();
  assert.deepStrictEqual(asked, [{ dealNumber: '90001', store: 'UT' }]);
  const [review] = h.sent;
  assert.ok(textOf(review[1]).includes(`*Basecamp would answer from LightSpeed:* "Delivery is set for Nov 14." (LightSpeed's Deal: delivery date, read just now, status)`), textOf(review[1]));
  assert.deepStrictEqual(suggestion(review[1]), { header: '<b>Suggested answer</b>', answer: 'Delivery is set for Nov 14.', from: "<i>From LightSpeed's Deal: delivery date, read just now (status)</i>", buttons: ['Send this answer', 'Not right'], m: 'Delivery is set for Nov 14.' });
  const q = Object.entries(h.data.questions).find(([, v]) => v.originThread === 'spaces/DEAL/threads/Q');
  // LightSpeed wins over the brief; the answer's words stay out of the database.
  assert.deepStrictEqual(q[1].reuse, { decision: 'answered', source: 'lightspeed', noteId: null, part: 'Deal: delivery date', kind: 'status', stillGood: true, answeredOn: recordDate(NOW.toISOString()), costUsd: 0.0015 });
  assert.ok(!JSON.stringify(h.data.questions).includes('Nov 14'));
  assert.ok(!JSON.stringify(h.logs).includes('Nov 14'));
});

test("a Team Member's earlier answer still good wins over LightSpeed; when LightSpeed does not answer, the brief does", async () => {
  const person = await harness(ANSWERED, { readDealFacts: async () => FACTS, inFacts: FROM_LIGHTSPEED });
  await person.ask();
  assert.ok(textOf(person.sent[0][1]).includes('*Basecamp would answer:* "Arrives Tuesday."'));

  const silent = await harness(NOT_EARLIER, { readDealFacts: async () => FACTS, inFacts: { ...FROM_LIGHTSPEED, decision: 'not_in_lightspeed', answer: '' }, inBrief: FROM_BRIEF });
  await silent.ask();
  assert.ok(textOf(silent.sent[0][1]).includes('from the brief'));
});

test('LightSpeed down, missing, or failing its check never stops a question', async () => {
  let checked = 0;
  const count = () => ((checked += 1), FROM_LIGHTSPEED);
  for (const readDealFacts of [async () => null, async () => { throw new Error('down'); }]) {
    const h = await harness(NOT_EARLIER, { readDealFacts, inFacts: count });
    assert.strictEqual(await h.ask(), SAY.routed('Parts Manager'));
    assert.ok(!textOf(h.sent[0][1]).includes('LightSpeed'));
  }
  assert.strictEqual(checked, 0, 'nothing to check when LightSpeed gave no facts');
  const broken = await harness(NOT_EARLIER, { readDealFacts: async () => FACTS, inFacts: async () => { throw new Error('model down'); } });
  assert.strictEqual(await broken.ask(), SAY.routed('Parts Manager'));
  // Lookups off: LightSpeed is never asked.
  const off = await harness(NOT_EARLIER, { inFacts: count });
  await off.ask();
  assert.strictEqual(checked, 0);
});

test('the LightSpeed check reads a trimmed deal: no prices, no "in" date, long clock sessions counted, and the rules against "done"', async () => {
  const { checkFacts, factsFor, SCHEMA: FACTS_SCHEMA, SYSTEM } = require('../src/agents/factsAnswer');
  const view = {
    feed: 'open',
    deal: { dealNo: '90001', experienceCenter: 'Utah', state: 'Pending', stage: null, opened: '2026-10-01', deliveryDate: null, salesCoach: 'Casey Coach', deposit: 1000, salesNotes: null, customerNotes: 'Wants <b>solar</b>' },
    unit: { year: '2026', make: 'ROAMER', model: 'R1', newUsed: 'New', stockNumber: 'S1', vin: 'VIN0000000000TEST', dateReceived: null },
    mods: [{ type: 'Customer Add', includedAtNoCharge: false, title: 'Solar kit', description: 'Solar kit', laborRetailPrice: 450, repairOrder: { number: '70001 ', status: 'Open' } }, { type: 'Included', includedAtNoCharge: true, title: 'Hitch', description: 'Charge sales', laborRetailPrice: 0, repairOrder: null }],
    prep: [{ kind: 'PDI', title: 'PDI', description: 'PDI', laborRetailPrice: 0, repairOrder: { number: '70002', status: 'Open' } }],
  };
  const session = (hours) => ({ technician: 'Terry Tech', start: '2026-11-01T08:00:00', end: '2026-11-01T09:00:00', hours, loggedOut: true, saleType: 'internal' });
  const open = { roNumber: '70001', paid: null, clock: { sessions: [session(1), session(16.5)], totalHours: 17.5, technicians: ['Terry Tech'], lastActivity: '2026-11-02T07:50:00', clockedOn: false, truncated: false } };
  const paid = {
    roNumber: '70002',
    paid: { roNumber: '70002', category: null, serviceAdvisor: 'Sam Advisor', dates: { in: '2026-11-09T08:00:00', promised: null, closed: '2026-11-03T12:00:00', paid: '2026-11-05T09:00:00' }, units: [{ jobs: [{ title: 'PDI', description: null, saleType: 'To Sales - MU Prep', approval: 'approved', resolution: 'Completed PDI, no findings.', techNotes: 'Completed PDI, no findings.', recommendations: null, actualHours: 2, technicians: ['Terry Tech'], parts: [] }] }] },
    clock: { sessions: [], totalHours: 0, technicians: [], lastActivity: null, clockedOn: false, truncated: false },
  };
  const facts = { view, ros: [{ number: '70001', ro: open }, { number: '70002', ro: paid }, { number: '70003', ro: null }] };
  const f = factsFor(facts);
  assert.deepStrictEqual(f.deal, { number: '90001', experienceCenter: 'Utah', feed: 'open deal', state: 'Pending', opened: '2026-10-01', deliveryDate: 'not set', salesCoach: 'Casey Coach', deposit: 1000, dealNotes: 'Wants <b>solar</b>' });
  assert.strictEqual(f.trailer.received, 'not received yet');
  assert.deepStrictEqual(f.mods, [{ title: 'Solar kit', repairOrder: '70001', kind: 'Customer Add' }, { title: 'Hitch', description: 'Charge sales', repairOrder: 'not on a repair order', kind: 'included at no charge' }]);
  assert.deepStrictEqual(f.repairOrders[0], { number: '70001', paid: false, techTime: { hours: 17.5, sessions: 2, technicians: ['Terry Tech'], lastWorked: '2026-11-02', clockedOnNow: false, longSessions: 1 } });
  assert.deepStrictEqual(f.repairOrders[1], { number: '70002', paid: true, techTime: 'none recorded', paidOn: '2026-11-05', workClosedOn: '2026-11-03', serviceAdvisor: 'Sam Advisor', jobs: [{ title: 'PDI', billsTo: 'To Sales - MU Prep', approval: 'approved', hoursWorked: 2, technicians: ['Terry Tech'], technicianWroteUp: 'Completed PDI, no findings.' }] });
  assert.deepStrictEqual(f.repairOrders[2], { number: '70003', read: false });
  const all = JSON.stringify(f);
  assert.ok(!all.includes('450') && !all.includes('2026-11-09'), 'no labor price, no "in" date');

  const sent = [];
  const fake = (out) => ({ messages: { create: async (body) => (sent.push(body), { stop_reason: 'end_turn', usage: { input_tokens: 1500, output_tokens: 60 }, content: [{ type: 'text', text: JSON.stringify(out) }] }) } });
  const r = await checkFacts({ anthropic: fake(FROM_LIGHTSPEED), question: 'Is the <solar> done?', facts });
  assert.deepStrictEqual([r.ok, r.decision, r.part], [true, 'answered', 'Deal: delivery date']);
  assert.strictEqual(sent[0].model, 'claude-haiku-5-5');
  assert.deepStrictEqual(sent[0].output_config.format.schema, FACTS_SCHEMA);
  assert.ok(sent[0].messages[0].content.includes('Is the &lt;solar&gt; done?') && sent[0].messages[0].content.includes('Wants &lt;b&gt;solar'));
  assert.ok(/Nothing in these facts says a job, a mod, or a PDI is finished/.test(SYSTEM) && /Tech time shows that someone clocked on/.test(SYSTEM));
  assert.strictEqual((await checkFacts({ anthropic: fake({ ...FROM_LIGHTSPEED, answer: ' ' }), question: 'q', facts })).ok, false);
  assert.strictEqual((await checkFacts({ anthropic: fake({ ...FROM_LIGHTSPEED, decision: 'maybe' }), question: 'q', facts })).ok, false);
});

// The routed-question card's buttons (Blake, 2026-11-07): answered from the card, not a thread.
const CTX = JSON.stringify({ role: 'Parts Manager', reason: 'parts', topic: 'awning arm tracking', who: 'Casey (c@example.com)', dealNumber: '90001', spaceUri: 'u', question: 'When does the awning arm get here?' });
const tap = (h, action, extra = {}) => h.q.fromCard({ action, threadName: 'spaces/DM-9/threads/t1', userEmail: 'blake@example.com', userDisplayName: 'Blake Locke', params: { ctx: CTX, ...extra.params }, formInputs: extra.formInputs || {} });
const theQuestion = (h) => Object.values(h.data.questions).find((v) => v.originThread === 'spaces/DEAL/threads/Q');

test('Send this answer relays the suggested answer where it was asked, counts it Right, and replaces the card', async () => {
  const h = await harness(ANSWERED);
  await h.ask();
  const said = await tap(h, 'qaUse', { params: { m: 'Arrives Tuesday.' } });
  assert.match(said, /^\*Sent the suggested answer\* \(marked right\): Arrives Tuesday\./);
  assert.deepStrictEqual(h.sent.at(-1), ['spaces/DEAL', '*Answer from Blake Locke:* Arrives Tuesday.', 'spaces/DEAL/threads/Q']);
  assert.deepStrictEqual([theQuestion(h).reuseVerdict, theQuestion(h).status], ['right', 'answered']);
  assert.deepStrictEqual(h.qa.at(-1), ['answer', '555', 'Arrives Tuesday.']);
});

test('Send relays the typed answer; with nothing typed the card comes back asking for one', async () => {
  const h = await harness({ ok: true, decision: 'new', noteId: '' });
  await h.ask();
  const empty = await tap(h, 'qaSend', { formInputs: { answer: '  ' } });
  assert.strictEqual(empty.cardsV2[0].card.sections[0].widgets[2].textParagraph.text, 'Type an answer in the box, then tap Send.');
  const said = await tap(h, 'qaSend', { formInputs: { answer: 'Tracking is 1Z999.' } });
  assert.match(said, /^\*Answered:\* Tracking is 1Z999\./);
  assert.deepStrictEqual(h.sent.at(-1), ['spaces/DEAL', '*Answer from Blake Locke:* Tracking is 1Z999.', 'spaces/DEAL/threads/Q']);
  assert.strictEqual(theQuestion(h).reuseVerdict, undefined, 'a typed answer is no verdict');
});

test('Not right counts Wrong and redraws the card without the suggestion; Not mine records the routing as wrong', async () => {
  const h = await harness(ANSWERED);
  await h.ask();
  const wrong = await tap(h, 'qaWrong');
  assert.strictEqual(theQuestion(h).reuseVerdict, 'wrong');
  assert.strictEqual(suggestion(wrong), null);
  assert.match(JSON.stringify(wrong), /Suggested answer marked wrong/);
  assert.ok(JSON.stringify(wrong).includes('"name":"answer"'), 'the answer box stays');

  const notMine = await tap(h, 'qaNotMine');
  assert.strictEqual(theQuestion(h).routeVerdict, 'not_mine');
  assert.match(JSON.stringify(notMine), /Marked as not the Parts Manager's question/);
});

test("a tap on a card whose question can't be found says so", async () => {
  const h = await harness(ANSWERED);
  assert.strictEqual(await tap(h, 'qaSend', { formInputs: { answer: 'x' } }), SAY.cardGone);
});

test('the router hands the card taps to the question router and replaces the card', async () => {
  const calls = [];
  const r = createRouter({ verify: async () => true, allowedUsers: ['b@example.com'], answerCard: async (j) => (calls.push(j), 'done') });
  const click = {
    commonEventObject: { hostApp: 'CHAT', invokedFunction: 'x', parameters: { action: 'qaSend', ctx: '{}' }, formInputs: { answer: { stringInputs: { value: ['Thursday'] } } } },
    chat: { user: { email: 'b@example.com', name: 'users/5' }, eventTime: 't', buttonClickedPayload: { space: { name: 'spaces/DM', spaceType: 'DIRECT_MESSAGE' }, message: { name: 'm', thread: { name: 'spaces/DM/threads/t1' } } } },
  };
  const res = await r({ headers: { authorization: 'x' }, body: click });
  assert.deepStrictEqual([calls[0].action, calls[0].threadName, calls[0].formInputs.answer], ['qaSend', 'spaces/DM/threads/t1', 'Thursday']);
  assert.deepStrictEqual(res.body, { hostAppDataAction: { chatDataAction: { updateMessageAction: { message: { text: 'done' } } } } });
});

test('a double tap on Send this answer relays the answer once', async () => {
  const h = await harness(ANSWERED);
  await h.ask();
  const before = h.sent.length;
  const said = await Promise.all([tap(h, 'qaUse', { params: { m: 'Arrives Tuesday.' } }), tap(h, 'qaUse', { params: { m: 'Arrives Tuesday.' } })]);
  assert.strictEqual(h.sent.length - before, 1);
  assert.ok(said.some((s) => s.endsWith(SAY.alreadyAnswered)));
  assert.strictEqual(h.qa.filter((x) => x[0] === 'answer').length, 1);
});
