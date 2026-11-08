'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { routeQuestion, costOf, ROLES, UNSURE, MODEL } = require('../src/agents/askRouter');
const { createQuestionRouter, reviewMessage, clarifyCard, withDetail, SAY, MAX_CLARIFY } = require('../src/askJob');
const { parseEvent } = require('../src/chat/events');
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

async function harness({ routed = ROUTED, reviewerKnown = true, linked = true, qaFails = false, relayFails = false, findDealSpace = null } = {}) {
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
    findDealSpace,
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
  assert.deepStrictEqual(qa, [['question', { contactId: '77', deliveryId: null, topic: 'awning arm', question: 'Has the awning arm come in?', askedBy: 'Casey Coach', at: NOW }]]);
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

// HubSpot as the direct-message lookup sees it: 90001 open (with its space and Delivery
// record), 90002 open with no brief or space yet, 90009 finalized. Anything else is not a deal.
const OPEN = '85341732';
const lookup = async ({ dealNumber }) =>
  ({
    90001: { deal: { id: '111', properties: { dealstage: OPEN } }, contactId: '77', deliveryId: '888' },
    90002: { deal: { id: '222', properties: { dealstage: OPEN } }, contactId: '78', deliveryId: null },
    90009: { deal: { id: '999', properties: { dealstage: 'closedwon' } }, contactId: '79', deliveryId: null },
  })[dealNumber] || null;
const askDm = (h, text) => h.ask({ spaceName: 'spaces/DM-5', threadName: 'spaces/DM-5/threads/Q1', isDirectMessage: true, text });

test('in a direct message, a question naming an open deal runs as if asked in its space', async () => {
  const h = await harness({ findDealSpace: lookup });
  assert.strictEqual(await askDm(h, 'Have we scheduled the PDI for 90001?'), SAY.routed('Parts Manager'));
  const message = h.sent[0][1];
  assert.ok(message.includes('in the deal 90001 space: https://chat.google.com/room/DEAL'), message);
  assert.deepStrictEqual(h.qa, [['question', { contactId: '77', deliveryId: '888', topic: 'awning arm', question: 'Have we scheduled the PDI for 90001?', askedBy: 'Casey Coach', at: NOW }]]);
  const [q] = Object.values(h.data.questions);
  assert.deepStrictEqual([q.dealId, q.spaceName, q.originThread, q.noteId], ['111', 'spaces/DM-5', 'spaces/DM-5/threads/Q1', '555']);

  // The answer comes back to the asker's direct message, and onto the deal's Q&A note.
  assert.strictEqual(await h.relay({ threadName: 'spaces/DM-9/threads/t1', userEmail: 'blake@example.com', userDisplayName: 'Blake Locke', text: 'Thursday.' }), SAY.relayed('90001', true));
  assert.deepStrictEqual(h.sent.at(-1), ['spaces/DM-5', '*Answer from Blake Locke:* Thursday.', 'spaces/DM-5/threads/Q1']);
});

test('a deal with no brief or space yet keeps the question on the Roamer alone', async () => {
  const h = await harness({ linked: false, findDealSpace: lookup });
  await askDm(h, 'Is 90002 ready for paperwork?');
  assert.ok(h.sent[0][1].includes('Asked by Casey Coach (casey@example.com) in the deal 90002 space\n'), h.sent[0][1]);
  assert.deepStrictEqual(h.qa[0][1].contactId, '78');
  assert.strictEqual(h.qa[0][1].deliveryId, null);
  assert.strictEqual(Object.values(h.data.questions)[0].dealId, '222');
});

test('numbers that are not open deals are ignored, and two deals in one question are refused', async () => {
  const none = await harness({ findDealSpace: lookup });
  await askDm(none, 'Is the $12000 solar package on 90009 or a 12345 order?');
  assert.ok(none.sent[0][1].includes('in a direct message'));
  assert.deepStrictEqual(none.qa, []);
  assert.strictEqual(Object.values(none.data.questions)[0].dealId, null);

  const two = await harness({ findDealSpace: lookup });
  assert.strictEqual(await askDm(two, 'Do 90001 and 90002 deliver the same day?'), SAY.whichDeal(['90001', '90002']));
  assert.deepStrictEqual(two.sent, []);
});

test('unsure, failed, and unreachable routings say so and send nothing wrong', async () => {
  // Unsure after the clarify cards are used up: it goes to Blake as "Not sure".
  const unsure = await harness({ routed: { ...ROUTED, role: UNSURE } });
  assert.strictEqual(await unsure.ask({ attempt: MAX_CLARIFY }), SAY.routed(UNSURE));

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
    createNote: async (n) => (calls.push(['create', n]), '555'),
    get: async () => ({ properties: { hs_note_body: renderQaNote({ topic: 'awning arm', question: 'q', askedBy: 'C', at: NOW }) } }),
    updateNote: async (u) => (calls.push(['update', u]), u.noteId),
  };
  const notes = createQaNotes({ hubspot });
  await notes.addQuestion({ contactId: '77', deliveryId: '888', topic: 'awning arm', question: 'q', askedBy: 'C', at: NOW });
  assert.deepStrictEqual([calls[0][1].contactId, calls[0][1].deliveryId, calls[0][1].dealId], ['77', '888', undefined]);
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

test('an unsure question gets a clarify card in its thread, not a message to Blake, and no HubSpot note', async () => {
  const routed = { ...ROUTED, role: UNSURE, clarify: 'Is there something specific you want to know, or a date to check for changes since?' };
  const h = await harness({ routed });
  const card = await h.ask({ text: 'anything new?' });
  assert.deepStrictEqual(card, clarifyCard({ clarify: routed.clarify, question: 'anything new?', attempt: 1, endpoint: '' }));
  const widgets = card.cardsV2[0].card.sections[0].widgets;
  assert.strictEqual(widgets[1].textInput.name, 'detail');
  assert.deepStrictEqual(widgets[2].buttonList.buttons[0].onClick.action.parameters, [
    { key: 'action', value: 'clarify' },
    { key: 'q', value: 'anything new?' },
    { key: 'attempt', value: '1' },
  ]);
  assert.deepStrictEqual(h.sent, []);
  assert.deepStrictEqual(h.qa, []);
  assert.strictEqual(Object.values(h.data.questions)[0].status, 'clarify');
});

test('Send on the card routes the question with the detail; unsure twice goes to Blake', async () => {
  const seen = [];
  const firestore = require('./fakeFirestore').createFakeFirestore();
  const db = createDb({ firestore, now: () => NOW });
  await db.rememberPerson({ email: 'blake@example.com', userName: 'users/9' });
  const answers = [{ ...ROUTED, role: UNSURE, clarify: 'Which part?' }, { ...ROUTED, role: UNSURE, clarify: 'Which part?' }, { ...ROUTED, role: UNSURE, clarify: 'Still?' }];
  const sent = [];
  const q = createQuestionRouter({
    anthropic: {},
    db,
    sendMessage: async (space, text) => (sent.push([space, text]), { threadName: `${space}/threads/x` }),
    findDirectMessage: async () => 'spaces/DM-9',
    reviewerEmail: 'blake@example.com',
    log: () => {},
    route: async ({ question }) => (seen.push(question), answers.shift()),
  });
  const base = { spaceName: 'spaces/DM-5', threadName: 'spaces/DM-5/threads/T', isDirectMessage: true, userEmail: 'c@example.com', userDisplayName: 'Casey' };
  const first = await q.ask({ ...base, text: 'anything new?' });
  assert.ok(first.cardsV2);
  const second = await q.clarify({ ...base, question: 'anything new?', detail: 'since Monday', attempt: '1' });
  assert.ok(second.cardsV2);
  assert.strictEqual(second.cardsV2[0].card.sections[0].widgets[2].buttonList.buttons[0].onClick.action.parameters[1].value, withDetail('anything new?', 'since Monday'));
  const third = await q.clarify({ ...base, question: withDetail('anything new?', 'since Monday'), detail: 'the trailer', attempt: '2' });
  assert.strictEqual(third, SAY.routed(UNSURE));
  assert.strictEqual(seen[2], 'anything new?\nDetail added: since Monday\nDetail added: the trailer');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(await q.clarify({ ...base, question: 'q', detail: '  ', attempt: '1' }), SAY.noDetail);
});

test('the router takes Send on a clarify card and replaces the card with the result', async () => {
  const calls = [];
  const r = createRouter({ verify: async () => true, allowedUsers: ['b@example.com'], briefUsers: ['b@example.com'], clarifyQuestion: async (c) => (calls.push(c), 'routed') });
  const click = {
    commonEventObject: { hostApp: 'CHAT', invokedFunction: 'https://example.com/', parameters: { action: 'clarify', q: 'anything new?', attempt: '1' }, formInputs: { detail: { stringInputs: { value: ['since Monday'] } } } },
    chat: { user: { email: 'b@example.com', name: 'users/5' }, eventTime: 't', buttonClickedPayload: { space: { name: 'spaces/DEAL', spaceType: 'SPACE' }, message: { name: 'spaces/DEAL/messages/M', thread: { name: 'spaces/DEAL/threads/T' } } } },
  };
  assert.deepStrictEqual(parseEvent(click).formInputs, { detail: 'since Monday' });
  const res = await r({ headers: { authorization: 'x' }, body: click });
  assert.deepStrictEqual(res.body, { hostAppDataAction: { chatDataAction: { updateMessageAction: { message: { text: 'routed' } } } } });
  assert.deepStrictEqual(calls[0], { spaceName: 'spaces/DEAL', threadName: 'spaces/DEAL/threads/T', isDirectMessage: false, userEmail: 'b@example.com', userDisplayName: null, question: 'anything new?', detail: 'since Monday', attempt: '1' });
});
