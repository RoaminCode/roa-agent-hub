'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { renderBrief, formatRecord, noDashes, writeBrief } = require('../src/agents/roamerBrief');
const { createBriefJob, SORRY } = require('../src/briefJob');

const context = {
  found: true,
  deal: { properties: { ls_deal_number: '90001', dealname: 'Test Deal', projected_delivery_date: '2026-11-20T00:00:00Z' } },
  salesCoach: 'Casey Coach',
  contact: { properties: { firstname: 'Pat', lastname: 'Sample' } },
  items: [{ at: '2026-10-03T10:00:00Z', channel: 'text', who: 'from the Roamer', text: 'Can not wait!' }],
  omitted: 0,
  counts: { call: 0, text: 1, email: 0, note: 0 },
};

const item = (detail) => ({ detail, date: '2026-10-03', channel: 'text' });

test('renders a brief with Wow, Journey, and where it came from', () => {
  const text = renderBrief({ dealNumber: '90001', context, brief: { headline: 'Pat is excited.', wow: [item('First trailer.')], journey: [] } });
  assert.match(text, /^\*Deal 90001: Pat Sample\*\nPat is excited\./);
  assert.match(text, /\*Wow\*\n• First trailer\. \(Oct 3, text\)/);
  assert.match(text, /\*Journey\*\n• Nothing yet in the record\./);
  assert.match(text, /From 0 calls, 1 texts, 0 emails, and 0 notes/);
});

test('trims whole items, never mid-line, to fit Chat', () => {
  const long = Array.from({ length: 12 }, (_, i) => item(`${i} ${'x'.repeat(300)}`));
  const text = renderBrief({ dealNumber: '90001', context, brief: { headline: 'h', wow: long, journey: long } });
  assert.ok(text.length <= 4000);
  assert.match(text, /lower-priority items did not fit in Chat/);
  assert.match(text, /full transcripts are not available yet\._/);
});

test('replaces em and en dashes', () => {
  assert.strictEqual(noDashes('Lake trip — in June – maybe'), 'Lake trip, in June, maybe');
});

test('marks the record as data and notes when old items were left out', () => {
  const record = formatRecord({ ...context, omitted: 3 });
  assert.match(record, /the 3 oldest items were left out/);
  assert.match(record, /<record>\n<item date="2026-10-03" channel="text" who="from the Roamer">\nCan not wait!\n<\/item>\n<\/record>/);
});

const fakeAnthropic = (message) => ({ beta: { messages: { stream: () => ({ finalMessage: async () => message }) } } });

test('reads the structured brief from the model', async () => {
  const brief = { headline: 'h', wow: [], journey: [] };
  const result = await writeBrief({ anthropic: fakeAnthropic({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(brief) }], usage: {} }), context });
  assert.deepStrictEqual(result.brief, brief);
});

test('reports a refusal instead of reading content', async () => {
  const result = await writeBrief({ anthropic: fakeAnthropic({ stop_reason: 'refusal', content: [], usage: {} }), context });
  assert.deepStrictEqual([result.ok, result.reason], [false, 'refusal']);
});

test('the brief job posts a friendly message when the deal is missing', async () => {
  const sent = [];
  const run = createBriefJob({
    loadContext: async () => ({ found: false }),
    anthropic: null,
    sendMessage: async (space, text) => sent.push([space, text]),
    log: () => {},
  });
  await run({ spaceName: 'spaces/AAA', dealNumber: '1', store: 'UT' });
  assert.deepStrictEqual(sent, [['spaces/AAA', SORRY.notFound('1', 'UT')]]);
});

test('the brief job tells the user when something breaks, and logs no Roamer details', async () => {
  const sent = [];
  const logs = [];
  const run = createBriefJob({
    loadContext: async () => {
      throw new Error('HubSpot GET /crm/v3/owners failed: HTTP 500');
    },
    anthropic: null,
    sendMessage: async (space, text) => sent.push(text),
    log: (...args) => logs.push(args),
  });
  await run({ spaceName: 'spaces/AAA', dealNumber: '2', store: 'UT' });
  assert.deepStrictEqual(sent, [SORRY.failed('2')]);
  assert.strictEqual(logs[0][1], 'brief failed');
});

test('the brief job posts the brief as a card', async () => {
  const sent = [];
  const brief = { headline: 'h', wow: [], journey: [] };
  const run = createBriefJob({
    loadContext: async () => ({ ...context, deal: { id: '111', properties: context.deal.properties }, contact: { id: '222', properties: context.contact.properties } }),
    anthropic: fakeAnthropic({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(brief) }], usage: {} }),
    sendMessage: async (space, message) => sent.push(message),
    log: () => {},
    avatarUrl: 'https://example.com/a.png',
  });
  await run({ spaceName: 'spaces/AAA', dealNumber: '90001', store: 'UT' });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].cardsV2[0].cardId, 'brief-90001');
});
