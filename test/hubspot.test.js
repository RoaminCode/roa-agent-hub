'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createHubSpotClient } = require('../src/hubspot/client');
const { createDealContext, parseAlowareText, stripQuotedReply, fitBudget, cleanText } = require('../src/hubspot/dealContext');

const ok = (body) => ({ ok: true, json: async () => body });

test('the HubSpot client only POSTs to search and batch read', async () => {
  const calls = [];
  const hubspot = createHubSpotClient({ token: 't', fetchImpl: async (url, opts) => (calls.push([opts.method, url]), ok({})) });
  await hubspot.post('/crm/v3/objects/deals/search', {});
  await hubspot.post('/crm/v3/objects/calls/batch/read', {});
  await assert.rejects(hubspot.post('/crm/v3/objects/notes', {}), /refuses POST/);
  await assert.rejects(hubspot.post('/crm/v3/objects/deals/123', {}), /refuses POST/);
  assert.strictEqual(calls.length, 2);
});

test('the HubSpot client offers no write methods', () => {
  const hubspot = createHubSpotClient({ token: 't', fetchImpl: async () => ok({}) });
  assert.deepStrictEqual(Object.keys(hubspot).sort(), ['get', 'post']);
});

test('HubSpot errors carry the status but not the response body', async () => {
  const hubspot = createHubSpotClient({ token: 't', fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ secret: 'x' }) }) });
  await assert.rejects(hubspot.get('/crm/v3/owners/1?x=y'), (err) => err.message === 'HubSpot GET /crm/v3/owners/1 failed: HTTP 403');
});

test('reads who sent an Aloware text and the message', () => {
  const out = parseAlowareText(
    'Sam Sample (Browser / Apps) has sent an SMS to +1 555-010-0000<br>Line: UT - Sales - (555) 010-0001<br>Creator Type: Manual<br>Message:<br>See you Tuesday!',
  );
  assert.deepStrictEqual(out, { sender: 'Sam Sample (Browser / Apps)', message: 'See you Tuesday!' });
  const inbound = parseAlowareText('+1 555-010-0000 has sent an SMS<br>Line: UT - Sales<br>Message:<br>Sounds great');
  assert.strictEqual(inbound.sender, '+1 555-010-0000');
});

test('drops quoted earlier messages from email replies', () => {
  assert.strictEqual(stripQuotedReply('Thanks!\n\nOn Mon, Oct 5, 2026 Sam wrote:\n> old stuff'), 'Thanks!');
  assert.strictEqual(stripQuotedReply('Line one\n> quoted\nLine two'), 'Line one\nLine two');
});

test('cleans HTML into plain text', () => {
  assert.strictEqual(cleanText('<p>Hi&nbsp;there</p><p>Bring the <b>Starlink</b> &amp; chairs</p>'), 'Hi there\nBring the Starlink & chairs');
});

test('keeps the newest items that fit and counts what was left out', () => {
  const items = [
    { at: '2026-01-01', text: 'a'.repeat(50) },
    { at: '2026-03-01', text: 'c'.repeat(50) },
    { at: '2026-02-01', text: 'b'.repeat(50) },
  ];
  const { items: kept, omitted } = fitBudget(items, 120);
  assert.deepStrictEqual(kept.map((i) => i.at), ['2026-02-01', '2026-03-01']);
  assert.strictEqual(omitted, 1);
});

function fakeHubSpot() {
  const posts = [];
  const data = {
    calls: [{ id: 'c1', properties: { hs_timestamp: '2026-10-02T10:00:00Z', hs_call_direction: 'OUTBOUND', hs_call_summary: 'Talked about the Lake Test trip.', hubspot_owner_id: '9' } }],
    communications: [
      { id: 'm1', properties: { hs_timestamp: '2026-10-03T10:00:00Z', hs_communication_channel_type: 'SMS', hs_communication_body: '+1 555-010-0000 has sent an SMS<br>Message:<br>Can not wait!' } },
      { id: 'm2', properties: { hs_timestamp: '2026-10-04T10:00:00Z', hs_communication_channel_type: 'WHATSAPP', hs_communication_body: 'skip me' } },
    ],
    emails: [],
    notes: [],
  };
  return {
    posts,
    get: async (path) => {
      if (path.startsWith('/crm/v3/owners/9')) return { firstName: 'Casey', lastName: 'Coach' };
      if (path.startsWith('/crm/v3/owners/')) return { firstName: null };
      if (path.includes('/deals/d1/associations/contacts')) return { results: [{ toObjectId: 77 }] };
      const m = /contacts\/77\/associations\/(\w+)/.exec(path);
      if (m) return { results: data[m[1]].map((r) => ({ toObjectId: r.id })) };
      throw new Error(`unexpected GET ${path}`);
    },
    post: async (path, body) => {
      posts.push(path);
      if (path.endsWith('/deals/search')) {
        return { results: [{ id: 'd1', properties: { ls_deal_number: '90001', hubspot_owner_id: '9', dealname: 'Test Deal' } }] };
      }
      const type = /objects\/(\w+)\/batch\/read/.exec(path)[1];
      if (type === 'contacts') return { results: [{ id: '77', properties: { firstname: 'Pat', lastname: 'Sample' } }] };
      const wanted = new Set(body.inputs.map((i) => i.id));
      return { results: data[type].filter((r) => wanted.has(r.id)) };
    },
  };
}

test('loads a deal, its Roamer, and their communications in order', async () => {
  const hubspot = fakeHubSpot();
  const ctx = await createDealContext({ hubspot })({ store: 'UT', dealNumber: '90001' });
  assert.strictEqual(ctx.found, true);
  assert.strictEqual(ctx.salesCoach, 'Casey Coach');
  assert.strictEqual(ctx.contact.properties.firstname, 'Pat');
  assert.deepStrictEqual(
    ctx.items.map((i) => [i.channel, i.who, i.text]),
    [
      ['call', 'outbound, Casey Coach', 'Summary: Talked about the Lake Test trip.'],
      ['text', 'from the Roamer', 'Can not wait!'],
    ],
  );
  assert.deepStrictEqual(ctx.counts, { call: 1, text: 1, email: 0, note: 0 });
});

test('says when a deal is not in HubSpot', async () => {
  const hubspot = { post: async () => ({ results: [] }), get: async () => ({}) };
  assert.deepStrictEqual(await createDealContext({ hubspot })({ store: 'UT', dealNumber: '1' }), { found: false });
});

test('refuses a store it has no CMF for', async () => {
  const hubspot = { post: async () => ({ results: [] }), get: async () => ({}) };
  await assert.rejects(createDealContext({ hubspot })({ store: 'ZZ', dealNumber: '1' }), /unknown store/);
});
