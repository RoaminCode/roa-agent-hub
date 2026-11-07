'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { suggestWow, formatWowInput, STARTER_IDEAS, MODEL } = require('../src/agents/wowPlan');
const { createWow, wowCard, renderWowNote, SAY, MARKER } = require('../src/wowJob');
const { createRouter, parseCommand, MESSAGES } = require('../src/router');
const { createDb } = require('../src/db');
const { createDbLibrary, createSheetLibrary } = require('../src/wowLibrary');
const { createFakeFirestore } = require('./fakeFirestore');

const NOW = new Date('2026-11-07T23:00:00Z');
const brief = { headline: 'Pat loves dark chocolate.', tags: [], key_facts: [], wow: [{ detail: 'Loves dark chocolate', date: '2026-11-01', channel: 'call' }], mods: [], journey: [] };
const SUGGESTION = { ideaId: '', title: 'Dark chocolate basket', tailored: 'A basket of dark chocolate in the trailer for Pat.', why: 'Loves dark chocolate (2026-11-01, call)', idea: 'A gift basket built around a favorite treat', fitsWhen: 'The record names a favorite treat', category: 'Gift', tier: '$$', owner: 'Delivery Coach' };

const fakeAnthropic = (out) => {
  const sent = [];
  return { sent, messages: { create: async (body) => (sent.push(body), { stop_reason: 'end_turn', usage: { input_tokens: 1500, output_tokens: 400 }, content: [{ type: 'text', text: JSON.stringify(out) }] }) } };
};

test('WOW suggestions: the brief and the library go in; a library id it names must be one it was given', async () => {
  const ideas = [{ id: 'lib1', idea: 'A handwritten card', category: 'Personal touch', tier: '$', uses: 2 }];
  const anthropic = fakeAnthropic({ suggestions: [{ ...SUGGESTION, ideaId: 'lib1' }, { ...SUGGESTION, ideaId: 'made-up', title: 'Second — idea' }] });
  const r = await suggestWow({ anthropic, brief, ideas });
  assert.strictEqual(anthropic.sent[0].model, MODEL);
  assert.ok(anthropic.sent[0].messages[0].content.includes('<idea id="lib1"'));
  assert.deepStrictEqual(r.suggestions.map((s) => s.ideaId), ['lib1', '']);
  assert.strictEqual(r.suggestions[1].title, 'Second, idea');
  assert.ok(formatWowInput({ brief: { ...brief, headline: '<x>' }, ideas: [] }).includes('&lt;x&gt;'));
  assert.strictEqual((await suggestWow({ anthropic: fakeAnthropic({ suggestions: [] }), brief, ideas })).ok, false);
});

async function harness({ briefNoteId = '9', suggestions = [SUGGESTION] } = {}) {
  const firestore = createFakeFirestore();
  const db = createDb({ firestore, now: () => NOW });
  await db.linkSpace({ dealId: '111', dealNumber: '90001', store: 'UT', spaceName: 'spaces/DEAL', spaceUri: 'u', how: 'adopted', by: 'b' });
  if (briefNoteId) await db.recordBrief({ dealId: '111', dealNumber: '90001', store: 'UT', contactId: '77', noteId: briefNoteId, signature: {} });
  await db.recordDelivery({ dealId: '111', deliveryId: '888', created: true });
  const notes = [];
  const seen = [];
  const w = createWow({
    anthropic: {},
    db,
    library: createDbLibrary({ db }),
    readBriefNote: async (id) => (id === '9' ? { id, brief } : null),
    findDealSpace: async ({ dealNumber }) => (dealNumber === '90001' ? { deal: { id: '111' } } : null),
    createNote: async (n) => (notes.push(n), '700'),
    log: () => {},
    endpoint: 'https://example.com/',
    suggest: async (a) => (seen.push(a), { ok: true, suggestions, usage: { input_tokens: 1, output_tokens: 1 } }),
    now: () => NOW,
  });
  return { w, notes, seen, data: firestore.data };
}

test('/wow in a deal space tailors from its brief and the library, and returns a card with Use this one', async () => {
  const h = await harness();
  const card = await h.w.wow({ spaceName: 'spaces/DEAL', isDirectMessage: false, text: '', userEmail: 'c' });
  assert.deepStrictEqual(card, wowCard({ dealId: '111', dealNumber: '90001', suggestions: [SUGGESTION], endpoint: 'https://example.com/' }));
  assert.deepStrictEqual(h.seen[0].brief, brief);
  // The library is seeded from the starter list the first time.
  assert.strictEqual(h.seen[0].ideas.length, STARTER_IDEAS.length);
  const params = card.cardsV2[0].card.sections[0].widgets[2].buttonList.buttons[0].onClick.action.parameters;
  assert.deepStrictEqual(Object.fromEntries(params.map((p) => [p.key, p.value])), { action: 'wowPick', d: '111', n: '90001', i: '', t: SUGGESTION.title, w: SUGGESTION.tailored, g: SUGGESTION.idea, f: SUGGESTION.fitsWhen, c: 'Gift', r: '$$' });
});

test('/wow needs a deal and its brief', async () => {
  const h = await harness();
  assert.strictEqual(await h.w.wow({ spaceName: 'spaces/OTHER', isDirectMessage: false, text: '' }), SAY.notDealSpace);
  assert.strictEqual(await h.w.wow({ spaceName: 'spaces/DM', isDirectMessage: true, text: 'please' }), SAY.dealFirst);
  assert.strictEqual(await h.w.wow({ spaceName: 'spaces/DM', isDirectMessage: true, text: '90002' }), SAY.noDeal('90002'));
  assert.ok((await h.w.wow({ spaceName: 'spaces/DM', isDirectMessage: true, text: '90001' })).cardsV2);
  const noBrief = await harness({ briefNoteId: null });
  assert.strictEqual(await noBrief.w.wow({ spaceName: 'spaces/DEAL', isDirectMessage: false, text: '' }), SAY.noBrief('90001'));
});

test('Use this one saves the plan on the Delivery record and the Roamer, and remembers a new idea in its general form', async () => {
  const h = await harness();
  const params = { action: 'wowPick', d: '111', n: '90001', i: '', t: SUGGESTION.title, w: SUGGESTION.tailored, g: SUGGESTION.idea, c: 'Gift', r: '$$' };
  assert.strictEqual(await h.w.choose({ params, userEmail: 'c@example.com', userDisplayName: 'Casey' }), SAY.chosen(SUGGESTION.title, '90001', 'Casey'));
  assert.deepStrictEqual([h.notes[0].contactId, h.notes[0].deliveryId, h.notes[0].dealId], ['77', '888', undefined]);
  assert.strictEqual(h.notes[0].body, renderWowNote({ title: SUGGESTION.title, tailored: SUGGESTION.tailored, category: 'Gift', tier: '$$', who: 'Casey', now: NOW }));
  assert.ok(h.notes[0].body.startsWith(`<p><strong>${MARKER}: `));
  const added = Object.values(h.data.wowIdeas).find((i) => i.source === 'chosen');
  assert.deepStrictEqual([added.idea, added.uses], [SUGGESTION.idea, 1]);

  // A library idea is counted, not added again. Starter ideas are seeded even after a new idea came first.
  await h.w.listIdeas();
  const lib =Object.entries(h.data.wowIdeas).find(([, i]) => i.source === 'starter');
  await h.w.choose({ params: { ...params, i: lib[0] }, userEmail: 'c' });
  assert.strictEqual(h.data.wowIdeas[lib[0]].uses, 1);
  assert.strictEqual(Object.values(h.data.wowIdeas).filter((i) => i.source === 'chosen').length, 1);
  assert.strictEqual(await h.w.choose({ params: { ...params, d: 'x' }, userEmail: 'c' }), SAY.chooseFailed);
});

test('/wow ideas lists the library, most used first', async () => {
  const h = await harness();
  const first = await h.w.listIdeas();
  assert.ok(first.startsWith('*WOW idea library*'));
  assert.strictEqual(first.split('\n').length, STARTER_IDEAS.length + 1);
});

test('the router: /wow starts in the background, "wow ideas" answers at once, Use this one replaces the card', async () => {
  assert.deepStrictEqual(parseCommand('wow ideas'), { command: 'wow', text: 'ideas' });
  const started = [];
  const picks = [];
  const r = createRouter({
    verify: async () => true,
    allowedUsers: ['b@example.com', 'c@example.com'],
    briefUsers: ['b@example.com'],
    startWow: (j) => started.push(j),
    listWowIdeas: async () => 'the list',
    chooseWow: async (c) => (picks.push(c.params.d), 'chosen'),
  });
  const msg = (email, text) => ({ type: 'MESSAGE', space: { name: 'spaces/DEAL', spaceType: 'SPACE' }, user: { email, name: 'users/5' }, message: { text, argumentText: ` ${text}`, thread: { name: 'spaces/DEAL/threads/T' } } });
  assert.deepStrictEqual((await r({ headers: { authorization: 'x' }, body: msg('b@example.com', 'wow') })).body, { text: MESSAGES.wowWorking });
  assert.deepStrictEqual(started[0], { spaceName: 'spaces/DEAL', threadName: 'spaces/DEAL/threads/T', isDirectMessage: false, userEmail: 'b@example.com', text: '' });
  // The list spends nothing, so it works off BRIEF_USERS; ideas do not.
  assert.deepStrictEqual((await r({ headers: { authorization: 'x' }, body: msg('c@example.com', 'wow ideas') })).body, { text: 'the list' });
  assert.deepStrictEqual((await r({ headers: { authorization: 'x' }, body: msg('c@example.com', 'wow') })).body, { text: MESSAGES.notBriefUser });
  assert.strictEqual(started.length, 1);
  const click = {
    commonEventObject: { hostApp: 'CHAT', invokedFunction: 'x', parameters: { action: 'wowPick', d: '111' } },
    chat: { user: { email: 'c@example.com', name: 'users/6' }, eventTime: 't', buttonClickedPayload: { space: { name: 'spaces/DEAL', spaceType: 'SPACE' }, message: { name: 'm' } } },
  };
  const res = await r({ headers: { authorization: 'x' }, body: click });
  assert.deepStrictEqual(res.body, { hostAppDataAction: { chatDataAction: { updateMessageAction: { message: { text: 'chosen' } } } } });
  assert.deepStrictEqual(picks, ['111']);
});


test('the sheet library reads active ideas and standards, counts a chosen idea, and adds a new one', async () => {
  const requests = [];
  const cells = { F3: 2 };
  const auth = {
    getClient: async () => ({
      request: async (r) => {
        requests.push([r.method, decodeURIComponent(r.url), r.data]);
        const url = decodeURIComponent(r.url);
        if (r.method === 'GET' && url.includes("'Ideas'!A2:G"))
          return { data: { values: [['Practice course', 'First-time owner', 'Experience', '$', 'Yes', '0', 'Blake'], ['Old idea', '', 'Gift', '$', 'No', '9', 'x'], ['Day pack', 'Loves hiking', 'Gear', '$$', 'Yes', '2', 'Basecamp']] } };
        if (r.method === 'GET' && url.includes('Standard at every delivery')) return { data: { values: [['Lunch during the walkthrough'], [''], ['A full tank of LP']] } };
        if (r.method === 'GET' && url.includes("'Ideas'!F3")) return { data: { values: [[String(cells.F3)]] } };
        return { data: {} };
      },
    }),
  };
  const lib = createSheetLibrary({ sheetId: '1aQ3f46vWKeCcRyesMiRfZQUle81jIHM1mpJwmGsVpUI', auth });
  const ideas = await lib.listIdeas();
  assert.deepStrictEqual(ideas.map((i) => [i.id, i.idea, i.fitsWhen, i.uses]), [['row-4', 'Day pack', 'Loves hiking', 2], ['row-2', 'Practice course', 'First-time owner', 0]]);
  assert.deepStrictEqual(await lib.standards(), ['Lunch during the walkthrough', 'A full tank of LP']);
  await lib.useIdea({ ideaId: 'row-3' });
  assert.deepStrictEqual(requests.at(-1), ['PUT', "https://sheets.googleapis.com/v4/spreadsheets/1aQ3f46vWKeCcRyesMiRfZQUle81jIHM1mpJwmGsVpUI/values/'Ideas'!F3?valueInputOption=RAW", { values: [[3]] }]);
  await lib.addIdea({ idea: 'Trekking poles', fitsWhen: 'Loves hiking', category: 'Gear', tier: '$$' });
  assert.deepStrictEqual(requests.at(-1)[2], { values: [['Trekking poles', 'Loves hiking', 'Gear', '$$', 'Yes', 1, 'Basecamp']] });
  assert.ok(requests.at(-1)[1].includes(':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS'));
  await assert.rejects(lib.useIdea({ ideaId: 'row-3; drop' }), /invalid idea id/);
  assert.throws(() => createSheetLibrary({ sheetId: '../x' }), /looks wrong/);
});

test('the standards from the sheet go into the WOW instructions', async () => {
  const sent = [];
  const anthropic = { messages: { create: async (b) => (sent.push(b), { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: JSON.stringify({ suggestions: [SUGGESTION] }) }] }) } };
  await suggestWow({ anthropic, brief, ideas: [], standards: ['Valet parking for the trailer'] });
  assert.ok(sent[0].system.includes('- Valet parking for the trailer'));
  assert.ok(!sent[0].system.includes('Lunch during the walkthrough'));
});
