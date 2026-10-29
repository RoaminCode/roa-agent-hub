'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { renderBriefCard, VISIBLE_ROWS } = require('../src/chat/briefCard');

const context = {
  deal: { id: '111', properties: { projected_delivery_date: '2026-11-20T00:00:00Z' } },
  salesCoach: 'Casey Coach',
  contact: { id: '222', properties: { firstname: 'Pat', lastname: 'Sample' } },
  omitted: 0,
  counts: { call: 2, text: 3, email: 0, note: 1 },
};
const item = (detail, channel = 'text') => ({ detail, date: '2026-10-03', channel });
const card = (brief) => renderBriefCard({ dealNumber: '90001', context, brief, avatarUrl: 'https://example.com/avatar.png' });
const sections = (msg) => msg.cardsV2[0].card.sections;

test('puts the Roamer, deal, delivery, and Sales Coach in the header', () => {
  const msg = card({ headline: 'h', wow: [], journey: [] });
  assert.deepStrictEqual(msg.cardsV2[0].card.header, {
    title: 'Pat Sample',
    subtitle: 'Deal 90001 · Delivery Nov 20 · Sales Coach Casey Coach',
    imageUrl: 'https://example.com/avatar.png',
    imageType: 'CIRCLE',
    imageAltText: 'Basecamp',
  });
  assert.strictEqual(msg.fallbackText, 'Roamer brief for deal 90001: Pat Sample');
});

test('gives each item its own row with an icon and where it came from', () => {
  const [, wow] = sections(card({ headline: 'h', wow: [item('First trailer.', 'call')], journey: [] }));
  assert.strictEqual(wow.header, '<font color="#2E9BD6"><b>WOW</b></font>');
  assert.deepStrictEqual(wow.widgets[0].decoratedText, {
    startIcon: { materialIcon: { name: 'call' } },
    text: 'First trailer.',
    bottomLabel: 'Oct 3, call',
    wrapText: true,
  });
  assert.strictEqual(wow.collapsible, undefined);
});

test('collapses a long list after the first rows', () => {
  const many = Array.from({ length: VISIBLE_ROWS + 3 }, (_, i) => item(`Item ${i}`));
  const [, , , journey] = sections(card({ headline: 'h', wow: [], journey: many }));
  assert.strictEqual(journey.collapsible, true);
  assert.strictEqual(journey.uncollapsibleWidgetsCount, VISIBLE_ROWS);
});

test('escapes record text so it cannot inject card markup, and drops dashes', () => {
  const [head, wow] = sections(card({ headline: 'Pat <b>said</b> — go', wow: [item('Tom & Jerry <script>')], journey: [] }));
  assert.strictEqual(head.widgets[0].textParagraph.text, '<b>Pat &lt;b&gt;said&lt;/b&gt;, go</b>');
  assert.strictEqual(wow.widgets[0].decoratedText.text, 'Tom &amp; Jerry &lt;script&gt;');
});

test('shows an empty list plainly and links to the deal and Roamer in HubSpot', () => {
  const all = sections(card({ headline: 'h', wow: [], journey: [] }));
  assert.match(all[1].widgets[0].textParagraph.text, /Nothing yet in the record/);
  const buttons = all[4].widgets[1].buttonList.buttons.map((b) => [b.text, b.onClick.openLink.url]);
  assert.deepStrictEqual(buttons, [
    ['Open deal in HubSpot', 'https://app.hubspot.com/contacts/39605104/record/0-3/111'],
    ['Open Roamer in HubSpot', 'https://app.hubspot.com/contacts/39605104/record/0-1/222'],
  ]);
  assert.match(all[4].widgets[0].textParagraph.text, /From 2 calls, 3 texts, 0 emails, and 1 notes/);
});

test('shows tags as chips and key facts in two columns', () => {
  const [summary] = sections(
    card({
      headline: 'h',
      tags: ['First trailer', 'Dad at walkthrough'],
      key_facts: [
        { label: 'Tow vehicle', value: 'Jeep' },
        { label: 'Paperwork', value: 'Nov 3, 9 AM' },
        { label: 'Pickup', value: 'Nov 14' },
      ],
      wow: [],
      journey: [],
    }),
  );
  assert.deepStrictEqual(summary.widgets[1].chipList.chips, [{ label: 'First trailer' }, { label: 'Dad at walkthrough' }]);
  const [left, right] = summary.widgets[2].columns.columnItems;
  assert.deepStrictEqual(left.widgets.map((w) => w.decoratedText.topLabel), ['Tow vehicle', 'Pickup']);
  assert.deepStrictEqual(right.widgets.map((w) => w.decoratedText.topLabel), ['Paperwork']);
});

test('leaves out the tag and fact rows when there are none, and fills the buttons', () => {
  const all = sections(card({ headline: 'h', wow: [], journey: [] }));
  assert.strictEqual(all[0].widgets.length, 1);
  const button = all[4].widgets[1].buttonList.buttons[0];
  assert.strictEqual(button.type, 'FILLED');
  assert.ok(button.color.blue > button.color.red);
});
test('lists mods with a status icon, price, and the not-yet-checked caveat', () => {
  const [, , mods] = sections(
    card({
      headline: 'h',
      wow: [],
      journey: [],
      mods: [
        { name: 'Outside kitchen faucet', status: 'approved', price: '$610', date: '2026-10-22', channel: 'call' },
        { name: 'Corner jacks', status: 'pending', price: '', date: '2026-10-28', channel: 'call' },
      ],
    }),
  );
  assert.strictEqual(mods.header, '<font color="#23858A"><b>MODS</b></font>');
  assert.deepStrictEqual(mods.widgets[0].decoratedText, {
    startIcon: { materialIcon: { name: 'check_circle' } },
    text: 'Outside kitchen faucet · $610',
    bottomLabel: 'Approved · Oct 22, call',
    wrapText: true,
  });
  assert.strictEqual(mods.widgets[1].decoratedText.text, 'Corner jacks');
  assert.strictEqual(mods.widgets[1].decoratedText.startIcon.materialIcon.name, 'schedule');
  assert.match(mods.widgets[2].textParagraph.text, /not yet checked against the deal in LightSpeed/);
});

test('says plainly when no mods were discussed', () => {
  const [, , mods] = sections(card({ headline: 'h', wow: [], journey: [], mods: [] }));
  assert.match(mods.widgets[0].textParagraph.text, /No mods discussed yet/);
});