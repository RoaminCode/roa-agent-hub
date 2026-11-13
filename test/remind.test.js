'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseReminder, fromUtah, utahNow } = require('../src/agents/remindParse');
const { createReminders, reminderCard, whenLabel, SAY } = require('../src/remindJob');
const { createRouter, parseCommand, MESSAGES } = require('../src/router');
const { SAY: NOTE_SAY } = require('../src/spaceNotes');
const { createVerifier } = require('../src/chat/verify');
const { createDb } = require('../src/db');
const { createFakeFirestore } = require('./fakeFirestore');

// Saturday, Nov 7 2026, 1:00 PM in Utah (MST, UTC-7).
const NOW = new Date('2026-11-07T20:00:00Z');
const OPEN = '85341732';

test('reads Utah wall-clock times as instants, through daylight saving', () => {
  assert.strictEqual(fromUtah('2026-11-07T14:00').toISOString(), '2026-11-07T21:00:00.000Z');
  assert.strictEqual(fromUtah('2026-07-01T09:00').toISOString(), '2026-07-01T15:00:00.000Z');
  assert.strictEqual(fromUtah('not a time'), null);
  assert.strictEqual(utahNow(NOW), 'Saturday 2026-11-07 13:00');
});

test('the parser sends the Utah time and the request to the small model, and refuses what it cannot read', async () => {
  const sent = [];
  const fake = (out) => ({ messages: { create: async (body) => (sent.push(body), { stop_reason: 'end_turn', usage: { input_tokens: 300, output_tokens: 30 }, content: [{ type: 'text', text: JSON.stringify(out) }] }) } });
  const r = await parseReminder({ anthropic: fake({ understood: true, for_self: true, what: 'let the Roamer know if we got <it> ordered', due: '2026-11-07T14:00' }), text: 'me let the Roamer know <x> within the hour', now: NOW });
  assert.deepStrictEqual([r.ok, r.forSelf, r.dueAt.toISOString()], [true, true, '2026-11-07T21:00:00.000Z']);
  assert.strictEqual(sent[0].model, 'claude-haiku-5-5');
  assert.ok(sent[0].messages[0].content.startsWith('Now in Utah: Saturday 2026-11-07 13:00'));
  assert.ok(sent[0].messages[0].content.includes('&lt;x&gt;'));
  assert.strictEqual((await parseReminder({ anthropic: fake({ understood: false, for_self: true, what: '', due: '' }), text: 'x', now: NOW })).ok, false);
  assert.strictEqual((await parseReminder({ anthropic: fake({ understood: true, for_self: true, what: 'x', due: 'soon' }), text: 'x', now: NOW })).ok, false);
});

test('labels the time plainly in Utah', () => {
  assert.strictEqual(whenLabel(new Date('2026-11-07T21:40:00Z'), NOW), 'today at 2:40 PM');
  assert.strictEqual(whenLabel(new Date('2026-11-08T16:00:00Z'), NOW), 'tomorrow at 9:00 AM');
  assert.strictEqual(whenLabel(new Date('2026-11-10T16:00:00Z'), NOW), 'Tue, Nov 10 at 9:00 AM');
});

async function harness({ read, sendFails = false, saveNote = null, readSince = null, judge } = {}) {
  const firestore = createFakeFirestore();
  let clock = NOW;
  const db = createDb({ firestore, now: () => clock });
  await db.linkSpace({ dealId: '111', dealNumber: '90001', store: 'UT', spaceName: 'spaces/DEAL', spaceUri: 'https://chat.google.com/room/DEAL', how: 'adopted', by: 'b' });
  const sent = [];
  const logs = [];
  const r = createReminders({
    anthropic: {},
    db,
    findDealSpace: async ({ dealNumber }) => ({ 90001: { deal: { id: '111', properties: { dealstage: OPEN } } }, 90002: { deal: { id: '222', properties: { dealstage: OPEN } } } })[dealNumber] || null,
    findDirectMessage: async (userName) => `spaces/DM-${userName.slice(6)}`,
    sendMessage: async (space, message) => {
      if (sendFails) throw new Error('chat down');
      sent.push([space, message]);
    },
    log: (...a) => logs.push(a),
    endpoint: 'https://example.com/',
    saveNote,
    readSince,
    ...(judge ? { judge } : {}),
    parse: async () => read || { ok: true, forSelf: true, what: 'let the Roamer know if we got the awning arm ordered', dueAt: new Date('2026-11-07T21:00:00Z'), usage: { input_tokens: 300, output_tokens: 30 }, costUsd: 0.0005 },
    now: () => clock,
  });
  const remind = (over = {}) => r.remind({ spaceName: 'spaces/DEAL', isDirectMessage: false, userEmail: 'casey@example.com', userName: 'users/5', text: 'me let the Roamer know if we got that ordered within the hour', ...over });
  return { r, remind, sent, logs, data: firestore.data, tick: (at) => ((clock = at), r.due()) };
}

test('in a deal space, a reminder is set for that deal and confirmed with its time, and logs never hold its words', async () => {
  const h = await harness();
  assert.strictEqual(await h.remind(), SAY.set('today at 2:00 PM', 'let the Roamer know if we got the awning arm ordered', '90001'));
  const [rem] = Object.values(h.data.reminders);
  assert.deepStrictEqual(
    { ...rem, at: undefined },
    { userEmail: 'casey@example.com', userName: 'users/5', what: 'let the Roamer know if we got the awning arm ordered', dueAt: '2026-11-07T21:00:00.000Z', dealId: '111', dealNumber: '90001', spaceUri: 'https://chat.google.com/room/DEAL', status: 'pending', at: undefined },
  );
  assert.ok(!JSON.stringify(h.logs).includes('awning'));
});

test('in a direct message, a deal number ties the reminder to that deal; two deals are refused', async () => {
  const dm = await harness();
  await dm.remind({ spaceName: 'spaces/DM-5', isDirectMessage: true, text: 'me check the hitch on 90001 at 2' });
  assert.strictEqual(Object.values(dm.data.reminders)[0].dealNumber, '90001');

  const plain = await harness();
  await plain.remind({ spaceName: 'spaces/DM-5', isDirectMessage: true, text: 'me call the shop at 2' });
  assert.strictEqual(Object.values(plain.data.reminders)[0].dealNumber, null);

  const two = await harness();
  assert.strictEqual(await two.remind({ spaceName: 'spaces/DM-5', isDirectMessage: true, text: 'me check 90001 and 90002' }), SAY.whichDeal(['90001', '90002']));
  assert.strictEqual(two.data.reminders, undefined);
});

test('a request it cannot read, for someone else, in the past, or too far ahead is not set', async () => {
  assert.strictEqual(await (await harness()).remind({ text: '' }), SAY.empty);
  assert.strictEqual(await (await harness({ read: { ok: false, reason: 'not_understood', usage: {} } })).remind(), SAY.unclear);
  assert.strictEqual(await (await harness({ read: { ok: true, forSelf: false, what: 'x', dueAt: new Date('2026-11-07T21:00:00Z'), usage: {} } })).remind(), SAY.selfOnly);
  assert.strictEqual(await (await harness({ read: { ok: true, forSelf: true, what: 'x', dueAt: new Date('2026-11-07T19:00:00Z'), usage: {} } })).remind(), SAY.past);
  assert.strictEqual(await (await harness({ read: { ok: true, forSelf: true, what: 'x', dueAt: new Date('2027-03-01T19:00:00Z'), usage: {} } })).remind(), SAY.tooFar);
});

test('a due reminder is sent once, to the person, as a card; its words are cleared after', async () => {
  const h = await harness();
  await h.remind();
  assert.strictEqual(await h.tick(new Date('2026-11-07T20:55:00Z')), 0, 'not yet due');
  assert.strictEqual(await h.tick(new Date('2026-11-07T21:03:00Z')), 1);
  assert.strictEqual(await h.tick(new Date('2026-11-07T21:08:00Z')), 0, 'never twice');
  assert.deepStrictEqual(h.sent, [['spaces/DM-5', reminderCard({ id: Object.keys(h.data.reminders)[0], what: 'let the Roamer know if we got the awning arm ordered', dealNumber: '90001', spaceUri: 'https://chat.google.com/room/DEAL', endpoint: 'https://example.com/' })]]);
  const [rem] = Object.values(h.data.reminders);
  assert.deepStrictEqual([rem.status, rem.what], ['sent', null]);
});

test('a reminder that cannot be sent keeps its words and is tried again, three times in all, then given up on', async () => {
  const h = await harness({ sendFails: true });
  await h.remind();
  const rem = () => Object.values(h.data.reminders)[0];
  assert.strictEqual(await h.tick(new Date('2026-11-07T21:03:00Z')), 0);
  assert.deepStrictEqual([rem().status, rem().tries, rem().what], ['pending', 1, 'let the Roamer know if we got the awning arm ordered']);
  await h.tick(new Date('2026-11-07T21:08:00Z'));
  await h.tick(new Date('2026-11-07T21:13:00Z'));
  assert.deepStrictEqual([rem().status, rem().what], ['failed', null]);
  assert.ok(h.logs.some((l) => l[1] === 'reminder could not be sent, gave up'));
  assert.strictEqual(await h.tick(new Date('2026-11-07T21:18:00Z')), 0, 'not tried a fourth time');
});

test('the last try is plain text, in case the card was the problem; a reminder left mid-send is picked up again', async () => {
  const h = await harness();
  await h.remind();
  const [id] = Object.keys(h.data.reminders);
  h.data.reminders[id].tries = 2;
  assert.strictEqual(await h.tick(new Date('2026-11-07T21:03:00Z')), 1);
  assert.deepStrictEqual(h.sent, [['spaces/DM-5', 'Reminder (deal 90001): let the Roamer know if we got the awning arm ordered']]);

  const stuck = await harness();
  await stuck.remind();
  const [sid] = Object.keys(stuck.data.reminders);
  Object.assign(stuck.data.reminders[sid], { status: 'sending', claimedAt: '2026-11-07T21:01:00.000Z' });
  assert.strictEqual(await stuck.tick(new Date('2026-11-07T21:05:00Z')), 0, 'a run may still be sending it');
  assert.strictEqual(await stuck.tick(new Date('2026-11-07T21:15:00Z')), 1, 'left for over ten minutes, it is sent');
});

const buttonsOf = (section) => section.widgets.find((w) => w.buttonList).buttonList.buttons;
const paramsOf = (button) => Object.fromEntries(button.onClick.action.parameters.map((p) => [p.key, p.value]));

test('the reminder card: Mark complete first, then Check if done, Remind me again, and the deal\'s own buttons', () => {
  const card = reminderCard({ id: 'r1', what: 'Call <Pat>', dealNumber: '90001', spaceUri: 'https://chat.google.com/room/DEAL', endpoint: 'https://example.com/' }).cardsV2[0].card;
  assert.deepStrictEqual(card.header, { title: 'Reminder', subtitle: 'Deal 90001' });
  const [main, again, deal] = card.sections;
  assert.strictEqual(main.widgets[0].textParagraph.text, 'Call &lt;Pat&gt;');
  assert.strictEqual(main.widgets[1].textInput.name, 'found');
  const [done, check] = buttonsOf(main);
  assert.deepStrictEqual([done.text, done.type, check.text, check.type], ['Mark complete', 'FILLED', 'Check if done', 'OUTLINED']);
  assert.deepStrictEqual(paramsOf(done), { action: 'remindDone', id: 'r1', m: 'Call <Pat>' });
  assert.deepStrictEqual(paramsOf(check), { action: 'remindCheck', id: 'r1', m: 'Call <Pat>' });
  assert.deepStrictEqual(buttonsOf(again).map((b) => [b.text, paramsOf(b).action, paramsOf(b).w]), [['In 1 hour', 'remindAgain', 'hour'], ['Tomorrow at 9 AM', 'remindAgain', 'tomorrow']]);
  const [facts, draft, open] = buttonsOf(deal);
  assert.deepStrictEqual([facts.text, draft.text, draft.type, open.text], ['Deal facts', 'Draft a text', 'OUTLINED', 'Open space']);
  assert.deepStrictEqual(paramsOf(facts), { action: 'remindFacts', n: '90001' });
  assert.deepStrictEqual(draft.onClick.action.parameters, [{ key: 'action', value: 'remindText' }, { key: 'n', value: '90001' }, { key: 'm', value: 'Call <Pat>' }]);
  // Exactly one filled button, the card's main action.
  assert.strictEqual(card.sections.flatMap(buttonsOf).filter((b) => b.type === 'FILLED').length, 1);

  // With no deal there is nothing to read or save to: Mark complete and Remind me again only.
  const plain = reminderCard({ id: 'r2', what: 'Call the shop', endpoint: 'x' }).cardsV2[0].card;
  assert.deepStrictEqual(plain.header, { title: 'Reminder' });
  assert.strictEqual(plain.sections.length, 2);
  assert.ok(!plain.sections[0].widgets.some((w) => w.textInput));
  assert.deepStrictEqual(buttonsOf(plain.sections[0]).map((b) => b.text), ['Mark complete']);
});

const WHAT = 'let the Roamer know if we got the awning arm ordered';
const CASEY = 'casey@example.com';

// A reminder set in the deal's space and sent; returns its id.
async function sentReminder(h, over) {
  await h.remind(over);
  await h.tick(new Date('2026-11-07T21:03:00Z'));
  return Object.keys(h.data.reminders)[0];
}

test('Mark complete saves the person\'s word as a HubSpot note on the deal, once, and takes what they found', async () => {
  const notes = [];
  const h = await harness({ saveNote: async (job) => (notes.push(job), NOTE_SAY.saved('90001', true)) });
  const id = await sentReminder(h);
  const r = await h.r.complete({ id, what: WHAT, found: ' It shipped <today>. ', spaceName: 'spaces/DM-5', userEmail: CASEY, userDisplayName: 'Casey Coach' });
  assert.deepStrictEqual(r, { done: true, text: SAY.completed(WHAT, '90001', true) });
  assert.deepStrictEqual(notes, [{ spaceName: 'spaces/DM-5', isDirectMessage: true, userEmail: CASEY, userDisplayName: 'Casey Coach', text: `90001 Reminder marked complete: ${WHAT}\nWhat was found: It shipped <today>.` }]);
  assert.strictEqual(h.data.reminders[id].outcome, 'complete');
  // A second tap saves nothing more.
  assert.deepStrictEqual(await h.r.complete({ id, what: WHAT, userEmail: CASEY }), { done: true, text: SAY.alreadyClosed });
  assert.strictEqual(notes.length, 1);
  assert.ok(!JSON.stringify(h.logs).includes('awning') && !JSON.stringify(h.logs).includes('shipped'));

  // With nothing typed, the note is the reminder alone.
  const bare = await harness({ saveNote: async (job) => (notes.push(job), NOTE_SAY.saved('90001', false)) });
  await bare.r.complete({ id: await sentReminder(bare), what: WHAT, found: '', userEmail: CASEY });
  assert.strictEqual(notes[1].text, `90001 Reminder marked complete: ${WHAT}`);
});

test('Mark complete stays open when its note cannot be saved, belongs to its owner, and needs no deal', async () => {
  const h = await harness({ saveNote: async () => NOTE_SAY.failed('90001') });
  const id = await sentReminder(h);
  assert.deepStrictEqual(await h.r.complete({ id, what: WHAT, userEmail: CASEY }), { done: false, text: `${NOTE_SAY.failed('90001')} The reminder is still open.` });
  assert.ok(!h.data.reminders[id].outcome);
  // Someone else's tap, a reminder that does not exist, and one not sent yet change nothing.
  assert.deepStrictEqual(await h.r.complete({ id, what: WHAT, userEmail: 'other@example.com' }), { done: false, text: SAY.gone });
  assert.deepStrictEqual(await h.r.complete({ id: 'nope', what: WHAT, userEmail: CASEY }), { done: false, text: SAY.gone });
  assert.deepStrictEqual(await h.r.complete({ id: '../x', what: WHAT, userEmail: CASEY }), { done: false, text: SAY.gone });
  const pending = await harness({ saveNote: async () => assert.fail('no note for a reminder not sent yet') });
  await pending.remind();
  assert.deepStrictEqual(await pending.r.complete({ id: Object.keys(pending.data.reminders)[0], what: WHAT, userEmail: CASEY }), { done: false, text: SAY.gone });

  // No deal: recorded in Basecamp only.
  const plain = await harness({ saveNote: async () => assert.fail('no note without a deal') });
  const pid = await sentReminder(plain, { spaceName: 'spaces/DM-5', isDirectMessage: true, text: 'me call the shop at 2' });
  assert.deepStrictEqual(await plain.r.complete({ id: pid, what: 'call the shop', userEmail: CASEY }), { done: true, text: SAY.completed('call the shop', null, false) });
  assert.strictEqual(plain.data.reminders[pid].outcome, 'complete');
});

test('Remind me again sets the same reminder for an hour on, or 9 AM tomorrow in Utah, once', async () => {
  const h = await harness();
  const id = await sentReminder(h);
  // The clock is 2:03 PM Saturday in Utah.
  const r = await h.r.again({ id, what: WHAT, which: 'hour', userEmail: CASEY });
  assert.deepStrictEqual(r, { done: true, text: SAY.again('today at 3:03 PM', WHAT, '90001') });
  const [, next] = Object.values(h.data.reminders);
  assert.deepStrictEqual(
    { ...next, at: undefined },
    { userEmail: CASEY, userName: 'users/5', what: WHAT, dueAt: '2026-11-07T22:03:00.000Z', dealId: '111', dealNumber: '90001', spaceUri: 'https://chat.google.com/room/DEAL', status: 'pending', at: undefined },
  );
  assert.strictEqual(h.data.reminders[id].outcome, 'again');
  assert.deepStrictEqual(await h.r.again({ id, what: WHAT, which: 'hour', userEmail: CASEY }), { done: true, text: SAY.alreadyClosed });
  assert.strictEqual(Object.keys(h.data.reminders).length, 2);
  // It arrives like any other reminder.
  assert.strictEqual(await h.tick(new Date('2026-11-07T22:05:00Z')), 1);

  const t = await harness();
  const tid = await sentReminder(t);
  assert.deepStrictEqual(await t.r.again({ id: tid, what: WHAT, which: 'tomorrow', userEmail: CASEY }), { done: true, text: SAY.again('tomorrow at 9:00 AM', WHAT, '90001') });
  assert.strictEqual(Object.values(t.data.reminders)[1].dueAt, '2026-11-08T16:00:00.000Z');
  assert.deepStrictEqual(await t.r.again({ id: tid, what: WHAT, which: 'hour', userEmail: 'other@example.com' }), { done: false, text: SAY.gone });
});

test('Check if done reads the deal since the reminder was set, quotes what shows it, and never closes the reminder', async () => {
  const asked = [];
  const judged = [];
  const ENTRY = { source: 'hubspot', channel: 'text', who: 'Casey Coach', at: '2026-11-07T20:30:00Z', text: 'Hi Pat, the awning arm is ordered and should be here Friday.' };
  const h = await harness({
    readSince: async (job) => (asked.push(job), [ENTRY]),
    judge: async (job) => (judged.push(job), { ok: true, kept: true, entry: ENTRY, costUsd: 0.0006 }),
  });
  const id = await sentReminder(h);
  const said = await h.r.check({ id, what: WHAT, userEmail: CASEY });
  assert.strictEqual(said, SAY.looksDone(ENTRY));
  assert.ok(said.includes('Casey Coach, in HubSpot (text), Nov 7, 1:30 PM') && said.includes('the awning arm is ordered') && said.includes('tap Mark complete'));
  assert.deepStrictEqual(asked, [{ dealId: '111', dealNumber: '90001', from: new Date(h.data.reminders[id].at), forWhat: 'a reminder' }]);
  assert.deepStrictEqual([judged[0].what, judged[0].entries, judged[0].dealId], [WHAT, [ENTRY], '111']);
  assert.ok(!h.data.reminders[id].outcome, 'the person marks it complete, not Basecamp');
  assert.ok(!JSON.stringify(h.logs).includes('awning'));

  // Entries that do not show it done, and a check that fails.
  const no = await harness({ readSince: async () => [ENTRY, ENTRY], judge: async () => ({ ok: true, kept: false, entry: null }) });
  assert.strictEqual(await no.r.check({ id: await sentReminder(no), what: WHAT, userEmail: CASEY }), SAY.notFound('90001', 'Nov 7, 1:00 PM', 2));
  const broken = await harness({ readSince: async () => [ENTRY], judge: async () => ({ ok: false, reason: 'timeout' }) });
  assert.strictEqual(await broken.r.check({ id: await sentReminder(broken), what: WHAT, userEmail: CASEY }), SAY.checkFailed);
});

test('Check if done spends nothing when nothing was said since, and is refused where it cannot look', async () => {
  const quiet = await harness({ readSince: async () => [], judge: async () => assert.fail('nothing to read, so no AI call') });
  const said = await quiet.r.check({ id: await sentReminder(quiet), what: WHAT, userEmail: CASEY });
  assert.strictEqual(said, SAY.nothingSince('90001', 'Nov 7, 1:00 PM'));
  assert.ok(said.includes('not work done in the shop'));

  // Not this person's reminder; a reminder with no deal; a server with no reader wired.
  const h = await harness({ readSince: async () => assert.fail('not read') });
  const id = await sentReminder(h);
  assert.strictEqual(await h.r.check({ id, what: WHAT, userEmail: 'other@example.com' }), SAY.gone);
  const plain = await harness({ readSince: async () => assert.fail('not read') });
  const pid = await sentReminder(plain, { spaceName: 'spaces/DM-5', isDirectMessage: true, text: 'me call the shop at 2' });
  assert.strictEqual(await plain.r.check({ id: pid, what: 'call the shop', userEmail: CASEY }), SAY.checkOff);
  const off = await harness();
  assert.strictEqual(await off.r.check({ id: await sentReminder(off), what: WHAT, userEmail: CASEY }), SAY.checkOff);
});

test('the reminder check is its own AI job, read against the reminder, and trusts only a named entry', async () => {
  const { checkDone, DONE_SYSTEM } = require('../src/agents/commitment');
  const sent = [];
  const fake = (out) => ({ messages: { create: async (body) => (sent.push(body), { stop_reason: 'end_turn', usage: { input_tokens: 400, output_tokens: 20 }, content: [{ type: 'text', text: JSON.stringify(out) }] }) } });
  const entries = [{ source: 'space', channel: 'message', who: 'Terry <Tech>', at: '2026-11-07T20:30:00Z', text: 'Solar is in and tested.' }];
  const r = await checkDone({ anthropic: fake({ kept: true, entry: 1 }), what: 'check the <solar>', entries });
  assert.deepStrictEqual([r.ok, r.kept, r.entry], [true, true, entries[0]]);
  assert.strictEqual(sent[0].system, DONE_SYSTEM);
  const user = sent[0].messages[0].content;
  assert.ok(user.startsWith('<reminder>\ncheck the &lt;solar&gt;\n</reminder>\n\nSince the reminder:') && user.includes('where="deal space"'));
  assert.strictEqual((await checkDone({ anthropic: fake({ kept: true, entry: 0 }), what: 'x', entries })).kept, false);
});

const BLAKE = 'blake@example.com';
const accept = async () => true;
const slashRemind = (text) => ({
  chat: { user: { name: 'users/123', email: BLAKE }, eventTime: 't', appCommandPayload: { space: { name: 'spaces/DM1', spaceType: 'DIRECT_MESSAGE' }, message: { text: `/remind ${text}`, argumentText: ` ${text}` }, appCommandMetadata: { appCommandId: 8 } } },
});
const draftClick = (n, m) => ({
  commonEventObject: { invokedFunction: 'https://example.com/', parameters: { action: 'remindText', n, m } },
  chat: { user: { name: 'users/123', email: BLAKE }, eventTime: 't', buttonClickedPayload: { space: { name: 'spaces/DM1', spaceType: 'DIRECT_MESSAGE' }, message: { name: 'spaces/DM1/messages/1' } } },
});

test('the router: /remind (command 8 or typed) sets a reminder; Draft a text starts a /text draft with its words', async () => {
  assert.deepStrictEqual(parseCommand('remind me call Pat at 2'), { command: 'remind', text: 'me call Pat at 2' });
  const set = [];
  const texts = [];
  const router = createRouter({ verify: accept, allowedUsers: [BLAKE], briefUsers: [BLAKE], setReminder: async (j) => (set.push(j), 'Got it.'), startText: async (j) => (texts.push(j), 'draft card') });
  const r = await router({ headers: { authorization: 'x' }, body: slashRemind('me call Pat at 2') });
  assert.match(JSON.stringify(r.body), /Got it\./);
  assert.deepStrictEqual(set[0], { spaceName: 'spaces/DM1', isDirectMessage: true, userEmail: BLAKE, userName: 'users/123', text: 'me call Pat at 2' });

  await router({ headers: { authorization: 'x' }, body: draftClick('90001', 'let the Roamer know it is ordered') });
  assert.deepStrictEqual(texts[0], { spaceName: 'spaces/DM1', isDirectMessage: true, userEmail: BLAKE, text: '90001 let the Roamer know it is ordered' });
  await router({ headers: { authorization: 'x' }, body: draftClick('9; drop', 'x') });
  assert.strictEqual(texts.length, 1, 'a malformed deal number starts nothing');

  // Reading the time spends credits, so it needs the brief permission.
  const off = createRouter({ verify: accept, allowedUsers: [BLAKE], briefUsers: [], setReminder: async () => assert.fail('no reminder for someone without credits') });
  await off({ headers: { authorization: 'x' }, body: slashRemind('me call Pat at 2') });
});

const cardClick = (parameters, { formInputs, space = { name: 'spaces/DM1', spaceType: 'DIRECT_MESSAGE' } } = {}) => ({
  commonEventObject: { invokedFunction: 'https://example.com/', parameters, ...(formInputs ? { formInputs } : {}) },
  chat: { user: { name: 'users/123', email: BLAKE, displayName: 'Blake L' }, eventTime: 't', buttonClickedPayload: { space, message: { name: 'spaces/DM1/messages/1', thread: { name: 'spaces/DM1/threads/T1' } } } },
});
const updated = (r) => r.body.hostAppDataAction.chatDataAction.updateMessageAction;
const created = (r) => r.body.hostAppDataAction.chatDataAction.createMessageAction;

test('the router: a reminder card\'s buttons; only Check if done needs AI credits', async () => {
  const calls = [];
  const deps = {
    verify: accept,
    allowedUsers: [BLAKE],
    completeReminder: async (j) => (calls.push(['done', j]), { done: true, text: 'Marked complete.' }),
    remindAgain: async (j) => (calls.push(['again', j]), { done: false, text: 'Not found.' }),
    startRemindCheck: (j) => calls.push(['check', j]),
    startFacts: (j) => calls.push(['facts', j]),
  };
  const headers = { authorization: 'x' };
  // No AI credits at all: Mark complete, Remind me again, and Deal facts still work.
  const noAi = createRouter({ ...deps, aiUsers: [], aiPaused: true });
  const done = await noAi({ headers, body: cardClick({ action: 'remindDone', id: 'r1', m: 'call Pat' }, { formInputs: { found: { stringInputs: { value: ['Left a voicemail'] } } } }) });
  assert.deepStrictEqual(updated(done).message, { text: 'Marked complete.' }, 'done: the card is replaced');
  assert.deepStrictEqual(calls[0], ['done', { id: 'r1', what: 'call Pat', found: 'Left a voicemail', spaceName: 'spaces/DM1', userEmail: BLAKE, userDisplayName: 'Blake L' }]);
  const again = await noAi({ headers, body: cardClick({ action: 'remindAgain', id: 'r1', m: 'call Pat', w: 'tomorrow' }) });
  assert.deepStrictEqual(created(again).message, { text: 'Not found.' }, 'not done: a line under the card, which stays');
  assert.deepStrictEqual(calls[1], ['again', { id: 'r1', what: 'call Pat', which: 'tomorrow', userEmail: BLAKE }]);
  await noAi({ headers, body: cardClick({ action: 'remindFacts', n: '90001' }) });
  assert.deepStrictEqual(calls[2], ['facts', { spaceName: 'spaces/DM1', dealNumber: '90001', store: 'UT', userEmail: BLAKE, threadName: 'spaces/DM1/threads/T1' }]);
  await noAi({ headers, body: cardClick({ action: 'remindFacts', n: '9; drop' }) });
  await noAi({ headers, body: cardClick({ action: 'remindFacts', n: '90001' }, { space: { name: 'spaces/ROOM', spaceType: 'SPACE' } }) });
  assert.strictEqual(calls.length, 3, 'a malformed deal number, or a space, starts no facts');
  const refused = await noAi({ headers, body: cardClick({ action: 'remindCheck', id: 'r1', m: 'call Pat' }) });
  assert.deepStrictEqual(created(refused).message, { text: MESSAGES.paused });
  assert.strictEqual(calls.length, 3, 'Check if done is an AI job');

  const ai = createRouter({ ...deps, aiUsers: [BLAKE] });
  const checking = await ai({ headers, body: cardClick({ action: 'remindCheck', id: 'r1', m: 'call Pat' }) });
  assert.deepStrictEqual(created(checking).message, { text: MESSAGES.remindChecking });
  assert.deepStrictEqual(calls[3], ['check', { id: 'r1', what: 'call Pat', spaceName: 'spaces/DM1', threadName: 'spaces/DM1/threads/T1', userEmail: BLAKE }]);
  const off = createRouter({ verify: accept, allowedUsers: [BLAKE], aiUsers: [BLAKE] });
  assert.deepStrictEqual(created(await off({ headers, body: cardClick({ action: 'remindCheck', id: 'r1', m: 'x' }) })).message, { text: MESSAGES.remindCheckOff });
});

test('the timer endpoint accepts only the signer it names', async () => {
  const client = (email) => ({ verifyIdToken: async () => ({ getPayload: () => ({ email, email_verified: true }) }) });
  const tick = (email) => createVerifier({ audience: 'https://basecamp.example/tasks/tick', signers: ['basecamp-router@roa-agent-hub.iam.gserviceaccount.com'], client: client(email) });
  assert.strictEqual(await tick('basecamp-router@roa-agent-hub.iam.gserviceaccount.com')('Bearer t'), true);
  assert.strictEqual(await tick('chat@system.gserviceaccount.com')('Bearer t'), false, 'Chat itself cannot fire the timer');
  assert.strictEqual(await tick('basecamp-router@roa-agent-hub.iam.gserviceaccount.com')(''), false);
});
