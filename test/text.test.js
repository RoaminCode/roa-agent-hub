'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createAloware, toE164, MAX_CHARS } = require('../src/aloware');
const { draftText } = require('../src/agents/textDraft');
const { createTexts, draftCard, reviewDialog, renderTextNote, SAY, SHADOW } = require('../src/textJob');
const { createRouter, parseCommand } = require('../src/router');
const { createDb } = require('../src/db');
const { createFakeFirestore } = require('./fakeFirestore');

const NOW = new Date('2026-11-08T17:00:00Z');
const BLAKE_PHONE = '801-555-0100';
const ROAMER_PHONE = '+1 (435) 555-0199';

test('Aloware: one method only, the approved send, always as the company, only to allowed numbers', async () => {
  const sent = [];
  const aloware = createAloware({ token: 't', allowedNumbers: [BLAKE_PHONE], fetchImpl: async (url, opts) => (sent.push([url, opts.method, JSON.parse(opts.body), opts.headers.Authorization]), { status: 202, ok: true }) });
  assert.deepStrictEqual(Object.keys(aloware), ['sendApproved']);
  assert.deepStrictEqual(await aloware.sendApproved({ lineId: '67519', to: '(801) 555-0100', message: 'Hi Pat' }), { to: '+18015550100', lineId: '67519' });
  assert.deepStrictEqual(sent[0], ['https://app.aloware.io/api/v1/webhook/sms-gateway/send', 'POST', { line_id: 67519, to: '+18015550100', message: 'Hi Pat', user_id: -1 }, 'Bearer t']);
  // A Roamer's number is refused while only test numbers are allowed.
  await assert.rejects(aloware.sendApproved({ lineId: '67519', to: ROAMER_PHONE, message: 'Hi' }), /not on the allowed list/);
  await assert.rejects(aloware.sendApproved({ lineId: '67519', to: BLAKE_PHONE, message: 'x'.repeat(MAX_CHARS + 1) }), /over 160/);
  await assert.rejects(aloware.sendApproved({ lineId: '67519', to: BLAKE_PHONE, message: '  ' }), /empty/);
  await assert.rejects(aloware.sendApproved({ lineId: '1;x', to: BLAKE_PHONE, message: 'Hi' }), /invalid line/);
  assert.strictEqual(sent.length, 1);
  const failing = createAloware({ token: 't', allowedNumbers: [BLAKE_PHONE], fetchImpl: async () => ({ status: 422, ok: false }) });
  await assert.rejects(failing.sendApproved({ lineId: '67519', to: BLAKE_PHONE, message: 'Hi' }), /HTTP 422/);
  assert.strictEqual(toE164('12'), null);
});

test('the draft comes from the small model, without dashes', async () => {
  const sent = [];
  const anthropic = { messages: { create: async (b) => (sent.push(b), { stop_reason: 'end_turn', usage: { input_tokens: 300, output_tokens: 40 }, content: [{ type: 'text', text: JSON.stringify({ text: 'Hi Pat — your awning arm arrives Tuesday. ROA' }) }] }) } };
  const r = await draftText({ anthropic, instruction: 'awning arm arrives <Tuesday>', firstName: 'Pat' });
  assert.strictEqual(r.text, 'Hi Pat, your awning arm arrives Tuesday. ROA');
  assert.ok(sent[0].messages[0].content.includes('&lt;Tuesday&gt;'));
  assert.strictEqual(sent[0].model, 'claude-haiku-4-5-20251001');
});

async function harness({ testNumbers = { 'blake@example.com': BLAKE_PHONE }, sendFails = false, phone = ROAMER_PHONE } = {}) {
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
    hubspot: { get: async () => ({ properties: { firstname: 'Pat', lastname: 'Sample', mobilephone: phone } }) },
    createNote: async (n) => (notes.push(n), '700'),
    findDealSpace: async ({ dealNumber }) => (dealNumber === '90001' ? { deal: { id: '111' } } : null),
    aloware: {
      sendApproved: async (s) => {
        if (sendFails) throw new Error('down');
        sends.push(s);
        return { to: toE164(s.to) };
      },
    },
    testNumbers,
    line: { id: '67519', label: 'UT - Sales, (385) 378-8538' },
    sendMessage: async () => {},
    log: () => {},
    endpoint: 'https://example.com/',
    draft: async () => ({ ok: true, text: 'Hi Pat, your awning arm arrives Tuesday. ROA', usage: {} }),
    now: () => NOW,
  });
  return { texts, sends, notes, data: firestore.data };
}

test('/text drafts a card with Review and send; nothing is sent', async () => {
  const h = await harness();
  const card = await h.texts.start({ spaceName: 'spaces/DEAL', isDirectMessage: false, text: 'awning arm Tuesday', userEmail: 'blake@example.com' });
  assert.deepStrictEqual(card, draftCard({ dealId: '111', dealNumber: '90001', name: 'Pat Sample', number: ROAMER_PHONE, draft: 'Hi Pat, your awning arm arrives Tuesday. ROA', endpoint: 'https://example.com/' }));
  const button = card.cardsV2[0].card.sections[0].widgets[2].buttonList.buttons[0];
  assert.strictEqual(button.onClick.action.interaction, 'OPEN_DIALOG');
  assert.deepStrictEqual(h.sends, []);
  assert.strictEqual(await h.texts.start({ spaceName: 'spaces/DEAL', isDirectMessage: false, text: ' ' }), SAY.empty);
  assert.strictEqual(await h.texts.start({ spaceName: 'spaces/DM', isDirectMessage: true, text: 'hello' }), SAY.dealFirst);
  const noPhone = await harness({ phone: null });
  assert.strictEqual(await noPhone.texts.start({ spaceName: 'spaces/DEAL', isDirectMessage: false, text: 'hi' }), SAY.noNumber('Pat Sample'));
});

test('the dialog shows name, number, line, and the exact words; in shadow mode it says it sends to your phone', async () => {
  const h = await harness();
  const dialog = await h.texts.review({ params: { d: '111', n: '90001', m: 'Hi Pat' }, userEmail: 'blake@example.com' });
  assert.deepStrictEqual(dialog, reviewDialog({ dealId: '111', dealNumber: '90001', name: 'Pat Sample', number: ROAMER_PHONE, line: { id: '67519', label: 'UT - Sales, (385) 378-8538' }, draft: 'Hi Pat', shadowTo: '+18015550100', endpoint: 'https://example.com/' }));
  const text = JSON.stringify(dialog);
  assert.ok(text.includes('Pat Sample') && text.includes('(435) 555-0199') && text.includes('UT - Sales') && text.includes('"value":"Hi Pat"'));
  assert.ok(SHADOW && text.includes('sends to your phone, (801) 555-0100'));
  assert.ok(text.includes('Approve and send'));
  // Without a test number there is no Approve button.
  const none = await h.texts.review({ params: { d: '111', n: '90001', m: 'Hi' }, userEmail: 'shane@example.com' });
  assert.ok(!JSON.stringify(none).includes('Approve and send'));
});

test('Approve and send: to the approver\'s own phone in shadow mode, logged, noted on the Delivery record only', async () => {
  const h = await harness();
  const said = await h.texts.send({ params: { d: '111', n: '90001' }, formInputs: { message: 'Hi Pat, it arrives Tuesday. ROA' }, userEmail: 'blake@example.com', userDisplayName: 'Blake Locke' });
  assert.strictEqual(said, SAY.sent({ approver: 'Blake Locke', name: 'Pat Sample', number: '(435) 555-0199', shadowTo: '(801) 555-0100' }));
  assert.deepStrictEqual(h.sends, [{ lineId: '67519', to: '+18015550100', message: 'Hi Pat, it arrives Tuesday. ROA' }]);
  const [log] = Object.values(h.data.textSends);
  assert.deepStrictEqual({ ...log, at: undefined }, { dealId: '111', approvedBy: 'blake@example.com', lineId: '67519', to: '+18015550100', wouldGoTo: '+14355550199', message: 'Hi Pat, it arrives Tuesday. ROA', shadow: true, at: undefined });
  assert.deepStrictEqual([h.notes[0].contactId, h.notes[0].deliveryId], [null, '888']);
  assert.strictEqual(h.notes[0].body, renderTextNote({ message: 'Hi Pat, it arrives Tuesday. ROA', name: 'Pat Sample', number: ROAMER_PHONE, approver: 'Blake Locke', line: { id: '67519', label: 'UT - Sales, (385) 378-8538' }, shadowTo: '+18015550100', now: NOW }));
  assert.ok(h.notes[0].body.includes('Sent by Basecamp, approved by Blake Locke'));
});

test('a send that is too long, has no test number, or fails sends and logs nothing', async () => {
  const h = await harness();
  assert.strictEqual(await h.texts.send({ params: { d: '111', n: '90001' }, formInputs: { message: 'x'.repeat(MAX_CHARS + 1) }, userEmail: 'blake@example.com' }), SAY.tooLong);
  assert.strictEqual(await h.texts.send({ params: { d: '111', n: '90001' }, formInputs: { message: 'Hi' }, userEmail: 'shane@example.com' }), SAY.noTestNumber);
  assert.strictEqual(await h.texts.send({ params: { d: 'x', n: '90001' }, formInputs: { message: 'Hi' }, userEmail: 'blake@example.com' }), SAY.sendFailed);
  assert.deepStrictEqual(h.sends, []);
  const down = await harness({ sendFails: true });
  assert.strictEqual(await down.texts.send({ params: { d: '111', n: '90001' }, formInputs: { message: 'Hi' }, userEmail: 'blake@example.com' }), SAY.sendFailed);
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
    sendText: async (j) => (calls.push(['send', j.formInputs.message]), 'sent'),
    postNotice: (n) => notices.push(n.text),
  });
  const h = { authorization: 'x' };
  const slash = (email) => ({ commonEventObject: { hostApp: 'CHAT' }, chat: { user: { email, name: 'users/5' }, eventTime: 't', appCommandPayload: { appCommandMetadata: { appCommandId: 5, appCommandType: 'SLASH_COMMAND' }, space: { name: 'spaces/DEAL', spaceType: 'SPACE' }, message: { text: '/text tell them Tuesday', argumentText: ' tell them Tuesday' } } } });
  const click = (email, action, extra = {}) => ({
    commonEventObject: { hostApp: 'CHAT', invokedFunction: 'x', parameters: { action, d: '111', n: '90001' }, formInputs: { message: { stringInputs: { value: ['Hi Pat'] } } }, ...extra },
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
  assert.deepStrictEqual(calls, [['start', 'tell them Tuesday'], ['review', '111'], ['send', 'Hi Pat']]);
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
