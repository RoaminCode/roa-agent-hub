'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { renderBriefNote, parseBriefNote, isBriefNoteText, briefSignature, sameSignature, MARKER } = require('../src/agents/briefNote');
const { cleanText } = require('../src/hubspot/dealContext');
const { createBriefNoteSaver } = require('../src/hubspot/briefNotes');

const now = new Date('2026-11-07T03:14:00Z');
const context = {
  deal: { id: '111' },
  contact: { id: '222' },
  items: [
    { at: '2026-10-03T10:00:00Z', channel: 'text' },
    { at: '2026-11-03T16:00:00Z', channel: 'call' },
  ],
};
// Every kind of field, with characters that could break the layout: HTML, quotes, pipes,
// parentheses at the end of a detail, an empty price, and no tags.
const brief = {
  headline: 'Pat picks up on the 14th with "Dad"; <b>first</b> time towing & excited.',
  tags: ['First trailer', 'Dad at walkthrough'],
  key_facts: [
    { label: 'Tow vehicle', value: 'Jeep Grand Cherokee 5.7L' },
    { label: 'Paperwork', value: 'Nov 3, 9 AM (confirm month)' },
  ],
  wow: [{ detail: 'Her father joins the walkthrough (pickup day).', date: '2026-10-21', channel: 'call' }],
  mods: [
    { name: 'Corner jacks', status: 'approved', price: '$1,559 before tax', date: '2026-11-02', channel: 'text' },
    { name: 'Solar | 400W', status: 'interested', price: '', date: '2026-10-21', channel: 'call' },
  ],
  journey: [
    { detail: 'Will to send the purchase order.', date: '2026-10-23', channel: 'call' },
    { detail: 'She asked: "you need anything else?"', date: '2026-10-20', channel: 'text' },
  ],
};

// What HubSpot hands back: the HTML body, read the way Basecamp reads every note.
const roundTrip = (b, ctx = context) => parseBriefNote(cleanText(renderBriefNote({ brief: b, context: ctx, now })));

test('a brief note reads back as the same brief, with what it was built from', () => {
  const back = roundTrip(brief);
  assert.deepStrictEqual(back.brief, { ...brief, mods: [brief.mods[0], { ...brief.mods[1], name: 'Solar / 400W' }] });
  assert.deepStrictEqual(back.signature, { contactId: '222', itemCount: 2, newestAt: '2026-11-03T16:00:00Z' });
});

test('an empty brief and an empty record read back too', () => {
  const empty = { headline: 'Nothing yet.', tags: [], key_facts: [], wow: [], mods: [], journey: [] };
  const back = roundTrip(empty, { ...context, items: [] });
  assert.deepStrictEqual(back.brief, empty);
  assert.deepStrictEqual(back.signature, { contactId: '222', itemCount: 0, newestAt: '' });
});

test('the note reads cleanly for people: labeled as AI, dated, and with no raw HTML from the brief', () => {
  const html = renderBriefNote({ brief, context, now });
  assert.ok(html.startsWith(`<p><strong>${MARKER}</strong></p>`));
  assert.match(html, /Written by AI from HubSpot; not checked against LightSpeed\. Written Nov 6, 8:14 PM MT, from the record through Nov 3\./);
  assert.match(html, /&lt;b&gt;first&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>/);
});

test('a note that is not in Basecamp\'s layout is not trusted', () => {
  assert.strictEqual(parseBriefNote('Loves dark chocolate'), null);
  const text = cleanText(renderBriefNote({ brief, context, now }));
  assert.strictEqual(parseBriefNote(text.replace('[approved]', '').replace(' | approved (', ' | maybe (')), null);
  assert.strictEqual(parseBriefNote(`${text}\nA Team Member added this line`), null);
  assert.strictEqual(parseBriefNote(text.replace(/Basecamp key:.*$/m, '')), null);
});

test('only Basecamp\'s own notes are recognized as brief notes', () => {
  assert.ok(isBriefNoteText(`${MARKER}\nHeadline: x`));
  assert.ok(!isBriefNoteText('Called about the BASECAMP ROAMER BRIEF'));
  assert.ok(!isBriefNoteText(''));
});

test('a saved brief matches only the same Roamer, item count, and newest item', () => {
  const sig = briefSignature(context);
  assert.ok(sameSignature(sig, briefSignature({ ...context })));
  assert.ok(!sameSignature(sig, briefSignature({ ...context, contact: { id: '333' } })));
  assert.ok(!sameSignature(sig, briefSignature({ ...context, items: [...context.items, { at: '2026-11-04T10:00:00Z' }] })));
  assert.ok(!sameSignature(sig, briefSignature({ ...context, items: [context.items[0], { at: '2026-11-03T17:00:00Z' }] })));
  assert.ok(!sameSignature(null, sig));
});

test('the saver creates the deal\'s brief note, or updates the one it has', async () => {
  const calls = [];
  const hubspot = {
    createDealNote: async (args) => (calls.push(['create', args.dealId, args.timestamp]), '900'),
    updateNote: async (args) => (calls.push(['update', args.noteId, args.isOurs(`<p><strong>${MARKER}</strong></p>`), args.isOurs('<p>Team note</p>')]), args.noteId),
  };
  const save = createBriefNoteSaver({ hubspot, now: () => now });
  assert.deepStrictEqual(await save({ context: { ...context, briefNote: null }, brief }), { id: '900', updated: false });
  assert.deepStrictEqual(await save({ context: { ...context, briefNote: { id: '901' } }, brief }), { id: '901', updated: true });
  assert.deepStrictEqual(calls, [
    ['create', '111', '2026-11-07T03:14:00.000Z'],
    ['update', '901', true, false],
  ]);
});
