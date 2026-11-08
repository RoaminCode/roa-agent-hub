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
const base = { headline: 'h', tags: [], key_facts: [], wow: [], mods: [], commitments: [], who: 'Pat is a first-time owner.', excites: [], journey_summary: '', open_questions: [] };
const card = (brief) => renderBriefCard({ dealNumber: '90001', context, brief: { ...base, ...brief }, avatarUrl: 'https://example.com/avatar.png' });
const sections = (msg) => msg.cardsV2[0].card.sections;
const mod = (name, status, price = '') => ({ name, status, price, date: '2026-10-22', channel: 'call' });

test('puts the Roamer, deal, delivery, and Sales Coach in the header', () => {
  const msg = card({});
  assert.deepStrictEqual(msg.cardsV2[0].card.header, {
    title: 'Pat Sample',
    subtitle: 'Deal 90001 · Delivery Nov 20 · Sales Coach Casey Coach',
    imageUrl: 'https://example.com/avatar.png',
    imageType: 'CIRCLE',
    imageAltText: 'Basecamp',
  });
  assert.strictEqual(msg.fallbackText, 'Roamer brief for deal 90001: Pat Sample');
});

test('has the five approved sections in order, then the buttons, with plain bold labels', () => {
  const all = sections(card({}));
  assert.deepStrictEqual(
    all.map((s) => s.header),
    ['<b>Who they are</b>', '<b>What excites them</b>', '<b>Journey so far</b>', '<b>Open questions</b>', '<b>Mods</b>', undefined],
  );
  assert.doesNotMatch(JSON.stringify(all), /font color/, 'no colored text anywhere on the card');
});

test('shows who they are with the tags as chips, and the lists as bullets', () => {
  const [who, excites, journey, open] = sections(
    card({ tags: ['First trailer', 'Dad at walkthrough'], excites: ['Moab in March', 'Coffee under the awning'], journey_summary: 'Deposit Oct 2.', open_questions: ['Can the kids come?'] }),
  );
  assert.strictEqual(who.widgets[0].textParagraph.text, 'Pat is a first-time owner.');
  assert.deepStrictEqual(who.widgets[1].chipList.chips, [{ label: 'First trailer' }, { label: 'Dad at walkthrough' }]);
  assert.strictEqual(excites.widgets[0].textParagraph.text, '• Moab in March<br>• Coffee under the awning');
  assert.strictEqual(journey.widgets[0].textParagraph.text, 'Deposit Oct 2.');
  assert.strictEqual(open.widgets[0].textParagraph.text, '• Can the kids come?');
});

test('carries no dates or channels on the card', () => {
  const text = JSON.stringify(card({ wow: [{ detail: 'First trailer.', date: '2026-10-03', channel: 'call' }], mods: [mod('Awning', 'approved')] }));
  assert.doesNotMatch(text, /Oct 3|Oct 22|2026-10|, call/);
  assert.doesNotMatch(text, /First trailer\./, 'the sourced lists stay in the note, not on the card');
});

test('says plainly when a section is empty', () => {
  const [who, excites, journey, open, mods] = sections(card({ who: '' }));
  assert.match(who.widgets[0].textParagraph.text, /Not enough in the record yet/);
  assert.strictEqual(who.widgets.length, 1, 'no chip row without tags');
  assert.match(excites.widgets[0].textParagraph.text, /Nothing yet in the record/);
  assert.match(journey.widgets[0].textParagraph.text, /Nothing yet in the record/);
  assert.match(open.widgets[0].textParagraph.text, /None open in the record/);
  assert.match(mods.widgets[0].textParagraph.text, /No mods discussed yet/);
});

test('escapes record text so it cannot inject card markup, and drops dashes', () => {
  const [who, excites] = sections(card({ who: 'Pat <b>said</b> — go', excites: ['Tom & Jerry <script>'] }));
  assert.strictEqual(who.widgets[0].textParagraph.text, 'Pat &lt;b&gt;said&lt;/b&gt;, go');
  assert.strictEqual(excites.widgets[0].textParagraph.text, '• Tom &amp; Jerry &lt;script&gt;');
});

test('lists mods with a status icon, price, and the not-yet-checked caveat', () => {
  const [, , , , mods] = sections(card({ mods: [mod('Outside kitchen faucet', 'approved', '$610'), mod('Corner jacks', 'pending')] }));
  assert.deepStrictEqual(mods.widgets[0].decoratedText, {
    startIcon: { materialIcon: { name: 'check_circle' } },
    text: 'Outside kitchen faucet · $610',
    bottomLabel: 'Approved',
    wrapText: true,
  });
  assert.strictEqual(mods.widgets[1].decoratedText.text, 'Corner jacks');
  assert.strictEqual(mods.widgets[1].decoratedText.startIcon.materialIcon.name, 'schedule');
  assert.match(mods.widgets[2].textParagraph.text, /not yet checked against the deal in LightSpeed/);
});

test('collapses a long mods list after the first rows', () => {
  const many = Array.from({ length: VISIBLE_ROWS + 3 }, (_, i) => mod(`Mod ${i}`, 'interested'));
  const [, , , , mods] = sections(card({ mods: many }));
  assert.strictEqual(mods.collapsible, true);
  assert.strictEqual(mods.uncollapsibleWidgetsCount, VISIBLE_ROWS);
});

test('the brief card opens the deal, the Roamer, and the Delivery record once the deal has one, as outlined buttons', () => {
  const ctx = { deal: { id: '111', properties: { ls_deal_number: '90001' } }, contact: { id: '222', properties: { firstname: 'Pat', lastname: 'Sample' } }, items: [] };
  const buttons = (c) => sections(renderBriefCard({ dealNumber: '90001', context: c, brief: base })).at(-1).widgets[0].buttonList.buttons;
  assert.deepStrictEqual(
    buttons(ctx).map((b) => [b.text, b.type, b.onClick.openLink.url]),
    [
      ['Open deal', 'OUTLINED', 'https://app.hubspot.com/contacts/39605104/record/0-3/111'],
      ['Open Roamer', 'OUTLINED', 'https://app.hubspot.com/contacts/39605104/record/0-1/222'],
    ],
  );
  const withDelivery = buttons({ ...ctx, deliveryId: '888' });
  assert.deepStrictEqual(withDelivery.at(-1).text, 'Open Delivery');
  assert.strictEqual(withDelivery.at(-1).onClick.openLink.url, 'https://app.hubspot.com/contacts/39605104/record/2-59426991/888');
  assert.strictEqual(sections(renderBriefCard({ dealNumber: '90001', context: ctx, brief: base })).at(-1).widgets.length, 1, 'the last section holds only the buttons, no source line');
});
