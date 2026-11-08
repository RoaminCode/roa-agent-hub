'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createAloware, toE164, MAX_CHARS } = require('../src/aloware');
const { draftText } = require('../src/agents/textDraft');
const { createTexts, draftCard, reviewDialog, renderTextNote, numbersOf, SAY } = require('../src/textJob');
const { createRouter, parseCommand } = require('../src/router');
const { createDb } = require('../src/db');
const { createFakeFirestore } = require('./fakeFirestore');

const NOW = new Date('2026-11-08T17:00:00Z');
const MOBILE = '+1 (435) 555-0199';
const HOME = '435-555-0123';
const LINE = { id: '67519', label: 'UT - Sales, (385) 378-8538' };

test('Aloware: one method only, the approved send, always as the company; a test list limits it when given', async () => {
  const sent = [];
  const fetchImpl = async (url, opts) => (sent.push([url, opts.method, JSON.parse(opts.body), opts.headers.Authorization]), { status: 202, ok: true });
  const aloware = createAloware({ token: 't', fetchImpl });
  assert.deepStrictEqual(Object.keys(aloware), ['sendApproved']);
  assert.deepStrictEqual(await aloware.sendApproved({ lineId: '67519', to: MOBILE, message: 'Hi Pat' }), { to: '+14355550199', lineId: '67519' });
  assert.deepStrictEqual(sent[0], ['https://app.aloware.io/api/v1/webhook/sms-gateway/send', 'POST', { line_id: 67519, to: '+14355550199', message: 'Hi Pat', user_id: -1 }, 'Bearer t']);
  await assert.rejects(aloware.sendApproved({ lineId: '67519', to: MOBILE, message: 'x'.repeat(MAX_CHARS + 1) }), /over 160/);
  await assert.rejects(aloware.sendApproved({ lineId: '67519', to: MOBILE, message: '  ' }), /empty/);
  await assert.rejects(aloware.sendApproved({ lineId: '1;x', to: MOBILE, message: 'Hi' }), /invalid line/);
  await assert.rejects(aloware.sendApproved({ lineId: '67519', to: '12', message: 'Hi' }), /not a phone number/);
  const limited = createAloware({ token: 't', allowedNumbers: ['801-555-0100'], fetchImpl });
  await assert.rejects(limited.sendApproved({ lineId: '67519', to: MOBILE, message: 'Hi' }), /not on the allowed list/);
  assert.strictEqual(sent.length, 1);
  const failing = createAloware({ token: 't', fetchImpl: async () => ({ status: 422, ok: false }) });
  await assert.rejects(failing.sendApproved({ lineId: '67519', to: MOBILE, message: 'Hi' }), /HTTP 422/);
});

test('the draft comes from the small model, without dashes', async () => {
  const sent = [];
  const anthropic = { messages: { create: async (b) => (sent.push(b), { stop_reason: 'end_turn', usage: { input_tokens: 300, output_tokens: 40 }, content: [{ type: 'text', text: JSON.stringify({ text: 'Hi Pat — your awning arm arrives Tuesday. ROA' }) }] }) } };
  const r = await draftText({ anthropic, instruction: 'awning arm arrives <Tuesday>', firstName: 'Pat' });
  assert.strictEqual(r.text, 'Hi Pat, your awning arm arrives Tuesday. ROA');
  assert.ok(sent[0].messages[0].content.includes('&lt;Tuesday&gt;'));
  assert.strictEqual(sent[0].model, 'claude-haiku-4-5-20251001');
});

test("a Roamer's numbers: each with its field, the same number once", () => {
  assert.deepStrictEqual(numbersOf({ mobilephone: MOBILE, phone: '(435) 555-0199' }), [{ field: 'Mobile', number: '+14355550199' }]);
  assert.deepStrictEqual(numbersOf({ mobilephone: MOBILE, phone: HOME }), [{ field: 'Mobile', number: '+14355550199' }, { field: 'Phone', number: '+14355550123' }]);
  assert.deepStrictEqual(numbersOf({ phone: 'none' }), []);
});

async function harness({ props = { mobilephone: MOBILE }, sendFails = false } = {}) {
  const firestore = createFakeFirestore();
  const db = createDb({ firestore, now: () => NOW });
  await db.linkSpace({ dealId: '111', dealNumber: '90001', store: 'UT', spaceName: 'spaces/DEAL', spaceUri: 'u', how: 'adopted', by: 'b' });
  await db.recordBrief({ dealId: '111', dealNumber: '90001', store: 'UT', contactId: '77', noteId: '9', signature: {} });
  await db.recordDelivery({ dealId: '111', deliveryId: '888', created: true });
  const sends = [];
  const notes = [];
  const texts = createTexts({
    anthropic: {},
    db,
    hubspot: { get: async () => ({ properties: { firstname: 'Pat', lastname: 'Sample', ...props } }) },
    createNote: async (n) => (notes.push(n), '700'),
    findDealSpace: async ({ dealNumber }) => (dealNumber === '90001' ? { deal: { id: '111' } } : null),
    aloware: {
      sendApproved: async (s) => {
        if (sendFails) throw new Error('down');
        sends.push(s);
        return { to: s.to };
      },
    },
    line: LINE,
    log: () => {},
    endpoint: 'https://example.com/',
    draft: async () => ({ ok: true, text: 'Hi Pat, your awning arm arrives Tuesday. ROA', usage: {} }),
    now: () => NOW,
  });
  const approve = (formInputs) => texts.send({ params: { d: '111', n: '90001' }, formInputs, userEmail: 'blake@example.com', userDisplayName: 'Blake Locke' });
  return { texts, approve, sends, notes, data: firestore.data };
}

test('/text drafts a card with Review and send; nothing is sent', async () => {
  const h = await harness();
  const card = await h.texts.start({ spaceName: 'spaces/DEAL', isDirectMessage: false, text: 'awning arm Tuesday', userEmail: 'blake@example.com' });
  assert.deepStrictEqual(card, draftCard({ dealId: '111', dealNumber: '90001', name: 'Pat Sample', draft: 'Hi Pat, your awning arm arrives Tuesday. ROA', endpoint: 'https://example.com/' }));
  assert.strictEqual(card.cardsV2[0].card.sections[0].widgets[2].buttonList.buttons[0].onClick.action.interaction, 'OPEN_DIALOG');
  assert.deepStrictEqual(h.sends, []);
  assert.strictEqual(await h.texts.start({ spaceName: 'spaces/DEAL', isDirectMessage: false, text: ' ' }), SAY.empty);
  assert.strictEqual(await h.texts.start({ spaceName: 'spaces/DM', isDirectMessage: true, text: 'hello' }), SAY.dealFirst);
  const noPhone = await harness({ props: {} });
  assert.strictEqual(await noPhone.texts.start({ spaceName: 'spaces/DEAL', isDirectMessage: false, text: 'hi' }), SAY.noNumber('Pat Sample'));
});

test('the dialog says it is live, shows the number and where it came from, the line, the words, and the number check', async () => {
  const h = await harness();
  const dialog = await h.texts.review({ params: { d: '111', n: '90001', m: 'Hi Pat' } });
  assert.deepStrictEqual(dialog, reviewDialog({ dealId: '111', dealNumber: '90001', name: 'Pat Sample', numbers: [{ field: 'Mobile', number: '+14355550199' }], line: LINE, draft: 'Hi Pat', endpoint: 'https://example.com/' }));
  const text = JSON.stringify(dialog);
  assert.ok(text.includes('<b>LIVE:</b> this sends to Pat Sample at (435) 555-0199 as soon as you approve'));
  assert.ok(text.includes('To (Mobile in HubSpot)') && text.includes('UT - Sales') && text.includes('"value":"Hi Pat"'));
  assert.ok(text.includes('I checked this is the right number for Pat Sample') && text.includes('"selected":false'));
  // Two different numbers: the approver picks one; neither is chosen for them.
  const two = await harness({ props: { mobilephone: MOBILE, phone: HOME } });
  const pick = (await two.texts.review({ params: { d: '111', n: '90001', m: 'Hi' } })).sections[0].widgets[1].selectionInput;
  assert.deepStrictEqual([pick.name, pick.type, pick.items.map((i) => [i.text, i.selected])], ['to', 'RADIO_BUTTON', [['Mobile: (435) 555-0199', false], ['Phone: (435) 555-0123', false]]]);
});

test('Approve and send: to the Roamer, only with the number checked, logged, noted on the Delivery record and the Roamer', async () => {
  const h = await harness();
  assert.strictEqual(await h.approve({ message: 'Hi Pat, it arrives Tuesday. ROA' }), SAY.notConfirmed);
  assert.deepStrictEqual(h.sends, []);
  const said = await h.approve({ message: 'Hi Pat, it arrives Tuesday. ROA', confirm: 'yes' });
  assert.strictEqual(said, SAY.sent({ approver: 'Blake Locke', name: 'Pat Sample', number: '(435) 555-0199', line: LINE.label }));
  assert.deepStrictEqual(h.sends, [{ lineId: '67519', to: '+14355550199', message: 'Hi Pat, it arrives Tuesday. ROA' }]);
  const [log] = Object.values(h.data.textSends);
  assert.deepStrictEqual({ ...log, at: undefined }, { dealId: '111', approvedBy: 'blake@example.com', lineId: '67519', to: '+14355550199', wouldGoTo: null, message: 'Hi Pat, it arrives Tuesday. ROA', shadow: false, at: undefined });
  assert.deepStrictEqual([h.notes[0].contactId, h.notes[0].deliveryId], ['77', '888']);
  assert.strictEqual(h.notes[0].body, renderTextNote({ message: 'Hi Pat, it arrives Tuesday. ROA', name: 'Pat Sample', number: '+14355550199', approver: 'Blake Locke', line: LINE, now: NOW }));
  assert.ok(h.notes[0].body.includes('approved by Blake Locke'));
});

test('with two numbers the picked one is sent to, and only a number still on the record', async () => {
  const two = await harness({ props: { mobilephone: MOBILE, phone: HOME } });
  assert.strictEqual(await two.approve({ message: 'Hi', confirm: 'yes' }), SAY.wrongNumber);
  assert.strictEqual(await two.approve({ message: 'Hi', confirm: 'yes', to: '+15555550000' }), SAY.wrongNumber);
  await two.approve({ message: 'Hi', confirm: 'yes', to: '+14355550123' });
  assert.deepStrictEqual(two.sends.map((s) => s.to), ['+14355550123']);
});

test('a send that is too long, malformed, or fails sends and logs nothing', async () => {
  const h = await harness();
  assert.strictEqual(await h.approve({ message: 'x'.repeat(MAX_CHARS + 1), confirm: 'yes' }), SAY.tooLong);
  assert.strictEqual(await h.texts.send({ params: { d: 'x', n: '90001' }, formInputs: { message: 'Hi', confirm: 'yes' }, userEmail: 'b' }), SAY.sendFailed);
  assert.deepStrictEqual(h.sends, []);
  const down = await harness({ sendFails: true });
  assert.strictEqual(await down.approve({ message: 'Hi', confirm: 'yes' }), SAY.sendFailed);
  assert.strictEqual(down.data.textSends, undefined);
  assert.deepStrictEqual(down.notes, []);
});

test('the router: /text drafts for people who may brief; Review opens the dialog; Approve sends and closes it; Cancel closes it', async () => {
  assert.deepStrictEqual(parseCommand('text tell them Tuesday'), { command: 'text', text: 'tell them Tuesday' });
  const calls = [];
  const notices = [];
  const r = createRouter({
    verify: async () => true,
    allowedUsers: ['b@example.com', 'c@example.com'],
    briefUsers: ['b@example.com'],
    startText: async (j) => (calls.push(['start', j.text]), 'draft card'),
    reviewText: async (j) => (calls.push(['review', j.params.d]), { header: { title: 'dialog' } }),
    sendText: async (j) => (calls.push(['send', j.formInputs.message, j.formInputs.confirm]), 'sent'),
    postNotice: (n) => notices.push(n.text),
  });
  const h = { authorization: 'x' };
  const slash = (email) => ({ commonEventObject: { hostApp: 'CHAT' }, chat: { user: { email, name: 'users/5' }, eventTime: 't', appCommandPayload: { appCommandMetadata: { appCommandId: 5, appCommandType: 'SLASH_COMMAND' }, space: { name: 'spaces/DEAL', spaceType: 'SPACE' }, message: { text: '/text tell them Tuesday', argumentText: ' tell them Tuesday' } } } });
  const click = (email, action) => ({
    commonEventObject: { hostApp: 'CHAT', invokedFunction: 'x', parameters: { action, d: '111', n: '90001' }, formInputs: { message: { stringInputs: { value: ['Hi Pat'] } }, confirm: { stringInputs: { value: ['yes'] } } } },
    chat: { user: { email, name: 'users/5' }, eventTime: 't', buttonClickedPayload: { space: { name: 'spaces/DEAL', spaceType: 'SPACE' }, message: { name: 'm', thread: { name: 'spaces/DEAL/threads/T' } } } },
  });
  const text = (res) => res.body.hostAppDataAction.chatDataAction.createMessageAction.message.text;
  assert.strictEqual(text(await r({ headers: h, body: slash('b@example.com') })), 'draft card');
  assert.deepStrictEqual((await r({ headers: h, body: click('b@example.com', 'textReview') })).body, { action: { navigations: [{ pushCard: { header: { title: 'dialog' } } }] } });
  const closed = { action: { navigations: [{ endNavigation: { action: 'CLOSE_DIALOG' } }] } };
  assert.deepStrictEqual((await r({ headers: h, body: click('b@example.com', 'textSend') })).body, closed);
  assert.deepStrictEqual(notices, ['sent']);
  assert.deepStrictEqual((await r({ headers: h, body: click('b@example.com', 'textCancel') })).body, closed);
  // Someone who may not brief can neither draft nor send.
  await r({ headers: h, body: slash('c@example.com') });
  assert.deepStrictEqual((await r({ headers: h, body: click('c@example.com', 'textSend') })).body, closed);
  assert.deepStrictEqual(calls, [['start', 'tell them Tuesday'], ['review', '111'], ['send', 'Hi Pat', 'yes']]);
});

test('Aloware is reached from one file only, the one-method client', () => {
  const fs = require('fs');
  const path = require('path');
  const files = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.js') && files.push(path.join(dir, d.name))));
  walk(path.join(__dirname, '..', 'src'));
  const reaching = files.filter((f) => /aloware\.io/i.test(fs.readFileSync(f, 'utf8'))).map((f) => path.basename(f));
  assert.deepStrictEqual(reaching, ['aloware.js']);
});

test('test mode: the dialog says so, the text goes to the test phone, noted on the Delivery record only', async () => {
  const sends = [];
  const notes = [];
  const firestore = createFakeFirestore();
  const db = createDb({ firestore, now: () => NOW });
  await db.recordBrief({ dealId: '111', dealNumber: '90001', store: 'UT', contactId: '77', noteId: '9', signature: {} });
  await db.recordDelivery({ dealId: '111', deliveryId: '888', created: true });
  const texts = createTexts({
    anthropic: {},
    db,
    hubspot: { get: async () => ({ properties: { firstname: 'Pat', lastname: 'Sample', mobilephone: MOBILE } }) },
    createNote: async (n) => (notes.push(n), '700'),
    findDealSpace: async () => null,
    aloware: { sendApproved: async (s) => (sends.push(s), { to: s.to }) },
    line: LINE,
    log: () => {},
    endpoint: 'e',
    testTo: '801-555-0100',
    now: () => NOW,
  });
  const dialog = JSON.stringify(await texts.review({ params: { d: '111', n: '90001', m: 'Hi' } }));
  assert.ok(dialog.includes('<b>TESTING:</b> this goes to your test phone, (801) 555-0100, not to Pat Sample at (435) 555-0199'));
  assert.ok(!dialog.includes('LIVE:'));
  // The number check still has to be ticked.
  assert.strictEqual(await texts.send({ params: { d: '111', n: '90001' }, formInputs: { message: 'Hi' }, userEmail: 'b' }), SAY.notConfirmed);
  const said = await texts.send({ params: { d: '111', n: '90001' }, formInputs: { message: 'Hi', confirm: 'yes' }, userEmail: 'b', userDisplayName: 'Blake Locke' });
  assert.strictEqual(said, SAY.sentTest({ approver: 'Blake Locke', name: 'Pat Sample', number: '(435) 555-0199', line: LINE.label, testTo: '(801) 555-0100' }));
  assert.deepStrictEqual(sends, [{ lineId: '67519', to: '+18015550100', message: 'Hi' }]);
  assert.deepStrictEqual([notes[0].contactId, notes[0].deliveryId], [null, '888']);
  assert.ok(notes[0].body.startsWith('<p><strong>Basecamp text sent (test)</strong></p>'));
  const [log] = Object.values(firestore.data.textSends);
  assert.deepStrictEqual([log.to, log.wouldGoTo, log.shadow], ['+18015550100', '+14355550199', true]);
});
