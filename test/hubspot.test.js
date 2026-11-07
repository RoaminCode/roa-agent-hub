'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createHubSpotClient } = require('../src/hubspot/client');
const { createDealContext, parseAlowareText, stripQuotedReply, fitBudget, cleanText, COMPANY_SENDER } = require('../src/hubspot/dealContext');

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

test('the HubSpot client offers no writes but the two note methods', () => {
  const hubspot = createHubSpotClient({ token: 't', fetchImpl: async () => ok({}) });
  assert.deepStrictEqual(Object.keys(hubspot).sort(), ['createDealNote', 'get', 'post', 'updateNote']);
});

test('createDealNote creates one note on one deal, and nothing else', async () => {
  const calls = [];
  const hubspot = createHubSpotClient({ token: 't', fetchImpl: async (url, opts) => (calls.push([opts.method, url, JSON.parse(opts.body)]), ok({ id: 555 })) });
  assert.strictEqual(await hubspot.createDealNote({ dealId: '111', body: '<p>x</p>', timestamp: '2026-11-07T03:14:00.000Z' }), '555');
  assert.deepStrictEqual(calls, [
    [
      'POST',
      'https://api.hubapi.com/crm/v3/objects/notes',
      {
        properties: { hs_timestamp: '2026-11-07T03:14:00.000Z', hs_note_body: '<p>x</p>' },
        associations: [{ to: { id: '111' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }] }],
      },
    ],
  ]);
  await assert.rejects(hubspot.createDealNote({ dealId: '111/../contacts/5', body: 'x', timestamp: 't' }), /invalid deal id/);
});

test("updateNote reads the note first and refuses one that is not Basecamp's own", async () => {
  const calls = [];
  const fetchImpl = (body) => async (url, opts) => (calls.push([opts.method, url]), ok({ properties: { hs_note_body: body } }));
  const theirs = createHubSpotClient({ token: 't', fetchImpl: fetchImpl('<p>Team Member note</p>') });
  await assert.rejects(theirs.updateNote({ noteId: '9', body: 'x', timestamp: 't', isOurs: (b) => b.includes('BASECAMP') }), /not Basecamp's own/);
  assert.deepStrictEqual(calls.map((c) => c[0]), ['GET']);
  await assert.rejects(theirs.updateNote({ noteId: '9', body: 'x', timestamp: 't' }), /check that the note is Basecamp's own is required/);
  await assert.rejects(theirs.updateNote({ noteId: '9?x', body: 'x', timestamp: 't', isOurs: () => true }), /invalid note id/);

  calls.length = 0;
  const ours = createHubSpotClient({ token: 't', fetchImpl: fetchImpl('<p>BASECAMP ROAMER BRIEF</p>') });
  assert.strictEqual(await ours.updateNote({ noteId: '9', body: 'new', timestamp: 't', isOurs: (b) => b.includes('BASECAMP') }), '9');
  assert.deepStrictEqual(calls, [
    ['GET', 'https://api.hubapi.com/crm/v3/objects/notes/9?properties=hs_note_body'],
    ['PATCH', 'https://api.hubapi.com/crm/v3/objects/notes/9'],
  ]);
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
  assert.strictEqual(parseAlowareText(' has sent an SMS to +1 555-010-0000<br>Message:<br>Hi').sender, COMPANY_SENDER);
});

test('reads the sender of a text sent from the HubSpot conversations inbox, which has no Message line', () => {
  const out = parseAlowareText(
    'Sam Sample (Browser / Apps) has sent an SMS to +1 555-010-0000<br>Line: UT - Sales - IVR - (555) 010-0001<br>From: Sam Sample (Browser / Apps)<br>Source: HubSpot Conversation',
  );
  assert.strictEqual(out.sender, 'Sam Sample (Browser / Apps)');
});

test('does not guess who sent a text in an unfamiliar format', () => {
  assert.strictEqual(parseAlowareText('Something new<br>Message:<br>Hi').sender, null);
  assert.strictEqual(parseAlowareText('No marker at all').sender, null);
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

const PEOPLE = { 77: ['Pat', 'Sample'], 78: ['Chris', 'Sample'] };

function fakeHubSpot({ deals = 1, lose = [], longNote = false, contacts = [77], contactNotes = [], dealNotes = [] } = {}) {
  const posts = [];
  const data = {
    calls: [{ id: 'c1', properties: { hs_timestamp: '2026-10-02T10:00:00Z', hs_call_direction: 'OUTBOUND', hs_call_summary: 'Talked about the Lake Test trip.', hubspot_owner_id: '9' } }],
    communications: [
      { id: 'm1', properties: { hs_timestamp: '2026-10-03T10:00:00Z', hs_communication_channel_type: 'SMS', hs_communication_body: '+1 555-010-0000 has sent an SMS<br>Message:<br>Can not wait!' } },
      { id: 'm2', properties: { hs_timestamp: '2026-10-04T10:00:00Z', hs_communication_channel_type: 'WHATSAPP', hs_communication_body: 'skip me' } },
    ],
    emails: [],
    notes: [...(longNote ? [{ id: 'n1', properties: { hs_timestamp: '2026-10-01T10:00:00Z', hs_note_body: 'n'.repeat(4000) } }] : []), ...contactNotes],
  };
  const allNotes = () => [...data.notes, ...dealNotes];
  return {
    posts,
    get: async (path) => {
      if (path.startsWith('/crm/v3/owners/9')) return { firstName: 'Casey', lastName: 'Coach' };
      if (path.startsWith('/crm/v3/owners/')) return { firstName: null };
      if (path.includes('/deals/d1/associations/contacts')) return { results: contacts.map((id) => ({ toObjectId: id })) };
      if (path.includes('/deals/d1/associations/notes')) return { results: dealNotes.map((r) => ({ toObjectId: r.id })) };
      const m = /contacts\/\d+\/associations\/(\w+)/.exec(path);
      if (m) return { results: data[m[1]].map((r) => ({ toObjectId: r.id })) };
      throw new Error(`unexpected GET ${path}`);
    },
    post: async (path, body) => {
      posts.push(path);
      if (path.endsWith('/deals/search')) {
        const deal = (id) => ({ id, properties: { ls_deal_number: '90001', hubspot_owner_id: '9', dealname: 'Test Deal' } });
        return { results: deals === 2 ? [deal('d1'), deal('d2')] : [deal('d1')] };
      }
      const type = /objects\/(\w+)\/batch\/read/.exec(path)[1];
      if (type === 'contacts') {
        return { results: body.inputs.map(({ id }) => ({ id: String(id), properties: { firstname: PEOPLE[id][0], lastname: PEOPLE[id][1] } })) };
      }
      const wanted = new Set(body.inputs.map((i) => i.id));
      // Ids in `lose` come back as errors, as in a partial (HTTP 207) batch response.
      return { results: (type === 'notes' ? allNotes() : data[type]).filter((r) => wanted.has(r.id) && !lose.includes(r.id)) };
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
  assert.deepStrictEqual([ctx.clipped, ctx.missing], [0, 0]);
});

test('counts records HubSpot did not return and items that were shortened', async () => {
  const ctx = await createDealContext({ hubspot: fakeHubSpot({ lose: ['c1'], longNote: true }) })({ store: 'UT', dealNumber: '90001' });
  assert.deepStrictEqual([ctx.missing, ctx.clipped], [1, 1]);
  assert.ok(ctx.items.find((i) => i.channel === 'note').text.endsWith('[cut]'));
});

test('asks which contact is the Roamer when a deal has more than one', async () => {
  const load = createDealContext({ hubspot: fakeHubSpot({ contacts: [77, 78] }) });
  const ask = await load({ store: 'UT', dealNumber: '90001' });
  assert.deepStrictEqual(ask.choices, [
    { id: '77', name: 'Pat Sample' },
    { id: '78', name: 'Chris Sample' },
  ]);
  assert.strictEqual(ask.contactCount, 2);
  assert.strictEqual(ask.items, undefined);
  const picked = await load({ store: 'UT', dealNumber: '90001', contactId: '78' });
  assert.strictEqual(picked.contact.properties.firstname, 'Chris');
});

test('refuses a picked contact that is not on the deal', async () => {
  const ctx = await createDealContext({ hubspot: fakeHubSpot({ contacts: [77] }) })({ store: 'UT', dealNumber: '90001', contactId: '78' });
  assert.deepStrictEqual([ctx.found, ctx.notOnDeal, ctx.contact], [true, true, undefined]);
});

test('HubSpot client errors are marked safe to log', async () => {
  const hubspot = createHubSpotClient({ token: 't', fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  await assert.rejects(hubspot.get('/crm/v3/owners/1'), (err) => err.safe === true);
});

test('refuses to pick between two deals with the same number', async () => {
  const ctx = await createDealContext({ hubspot: fakeHubSpot({ deals: 2 }) })({ store: 'UT', dealNumber: '90001' });
  assert.deepStrictEqual(ctx, { found: false, duplicate: true });
});

test('a HubSpot read that hangs fails at the time limit, for GET and POST', async () => {
  // A fetch that never answers on its own, only gives up when its signal aborts.
  const hang = async (url, opts) =>
    new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)));
  const hubspot = createHubSpotClient({ token: 't', fetchImpl: hang, timeoutMs: 20 });
  await assert.rejects(hubspot.get('/crm/v3/owners/1'), { name: 'TimeoutError' });
  await assert.rejects(hubspot.post('/crm/v3/objects/calls/batch/read', {}), { name: 'TimeoutError' });
});

test('says when a deal is not in HubSpot', async () => {
  const hubspot = { post: async () => ({ results: [] }), get: async () => ({}) };
  assert.deepStrictEqual(await createDealContext({ hubspot })({ store: 'UT', dealNumber: '1' }), { found: false });
});

test('refuses a store it has no CMF for', async () => {
  const hubspot = { post: async () => ({ results: [] }), get: async () => ({}) };
  await assert.rejects(createDealContext({ hubspot })({ store: 'ZZ', dealNumber: '1' }), /unknown store/);
});

test("leaves Basecamp's own brief note out of the record and hands it over separately", async () => {
  const { renderBriefNote } = require('../src/agents/briefNote');
  const brief = { headline: 'Pat is excited.', tags: [], key_facts: [], wow: [], mods: [], journey: [] };
  const body = renderBriefNote({ brief, context: { contact: { id: 77 }, items: [] }, now: new Date('2026-11-07T03:14:00Z') });
  const note = (id, at) => ({ id, properties: { hs_timestamp: at, hs_note_body: body } });
  const hubspot = fakeHubSpot({
    contactNotes: [note('b0', '2026-10-05T10:00:00Z'), { id: 'n2', properties: { hs_timestamp: '2026-10-06T10:00:00Z', hs_note_body: 'Loves dark chocolate' } }],
    dealNotes: [note('b1', '2026-11-01T10:00:00Z'), note('b2', '2026-11-07T03:14:00Z')],
  });
  const ctx = await createDealContext({ hubspot })({ store: 'UT', dealNumber: '90001' });
  assert.deepStrictEqual(ctx.items.filter((i) => i.channel === 'note').map((i) => i.text), ['Loves dark chocolate']);
  assert.strictEqual(ctx.counts.note, 1);
  assert.strictEqual(ctx.briefNote.id, 'b2');
  assert.deepStrictEqual(ctx.briefNote.brief, brief);
});

test('a deal with no brief note has none', async () => {
  const ctx = await createDealContext({ hubspot: fakeHubSpot() })({ store: 'UT', dealNumber: '90001' });
  assert.strictEqual(ctx.briefNote, null);
});

test('opening a space remembers the Roamer picked for the brief; a brief still asks', async () => {
  const { renderBriefNote } = require('../src/agents/briefNote');
  const brief = { headline: 'h', tags: [], key_facts: [], wow: [], mods: [], journey: [] };
  const body = renderBriefNote({ brief, context: { contact: { id: 78 }, items: [] } });
  const hubspot = fakeHubSpot({ contacts: [77, 78], dealNotes: [{ id: 'b1', properties: { hs_timestamp: '2026-11-01T10:00:00Z', hs_note_body: body } }] });
  const load = createDealContext({ hubspot });
  const remembered = await load({ store: 'UT', dealNumber: '90001', rememberPick: true });
  assert.strictEqual(remembered.contact.properties.firstname, 'Chris');
  const asked = await load({ store: 'UT', dealNumber: '90001' });
  assert.strictEqual(asked.choices.length, 2);
  const none = await createDealContext({ hubspot: fakeHubSpot({ contacts: [77, 78] }) })({ store: 'UT', dealNumber: '90001', rememberPick: true });
  assert.strictEqual(none.choices.length, 2);
});

test('finding a deal space reads only the deal and its brief note', async () => {
  const { renderBriefNote } = require('../src/agents/briefNote');
  const brief = { headline: 'h', tags: [], key_facts: [], wow: [], mods: [], journey: [] };
  const body = renderBriefNote({ brief, context: { contact: { id: 77 }, items: [] }, spaceName: 'spaces/DEAL' });
  const hubspot = fakeHubSpot({ dealNotes: [{ id: 'b1', properties: { hs_timestamp: '2026-11-01T10:00:00Z', hs_note_body: body } }] });
  const { findDealSpace } = createDealContext({ hubspot });
  const found = await findDealSpace({ store: 'UT', dealNumber: '90001' });
  assert.strictEqual(found.spaceName, 'spaces/DEAL');
  assert.ok(found.deal.id);
  assert.strictEqual((await createDealContext({ hubspot: fakeHubSpot() }).findDealSpace({ dealNumber: '90001' })).spaceName, null);
  assert.strictEqual(await createDealContext({ hubspot: fakeHubSpot({ deals: 2 }) }).findDealSpace({ dealNumber: '90001' }), null);
});

test('createDealNote also puts the note on the Roamer when given a contact', async () => {
  const calls = [];
  const hubspot = createHubSpotClient({ token: 't', fetchImpl: async (url, opts) => (calls.push(JSON.parse(opts.body)), ok({ id: 556 })) });
  await hubspot.createDealNote({ dealId: '111', contactId: '77', body: '<p>x</p>', timestamp: 't' });
  assert.deepStrictEqual(calls[0].associations, [
    { to: { id: '111' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }] },
    { to: { id: '77' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] },
  ]);
  await assert.rejects(hubspot.createDealNote({ dealId: '111', contactId: '77/x', body: 'x', timestamp: 't' }), /invalid contact id/);
});

test("with Basecamp's record, the brief note is read by id and the space and signature come from the record", async () => {
  const { renderBriefNote } = require('../src/agents/briefNote');
  const { createFakeFirestore } = require('./fakeFirestore');
  const brief = { headline: 'h', tags: [], key_facts: [], wow: [], mods: [], journey: [] };
  // The note says one space; the record, which only Basecamp writes, says another and wins.
  const body = renderBriefNote({ brief, context: { contact: { id: 77 }, items: [] }, spaceName: 'spaces/EDITED' });
  const base = fakeHubSpot();
  const gets = [];
  const hubspot = {
    ...base,
    get: async (path) => {
      gets.push(path);
      if (path.startsWith('/crm/v3/objects/notes/')) return { id: '5', properties: { hs_note_body: body } };
      return base.get(path);
    },
  };
  // The fake's deal id is not numeric, so the record is put straight into the fake store.
  const firestore = createFakeFirestore({ deals: { d1: { spaceName: 'spaces/REAL', briefNoteId: '5', briefSignature: { contactId: '77', itemCount: 99, newestAt: 'x' }, contactId: '77' } } });
  const ctx = await createDealContext({ hubspot, db: { getDeal: async (id) => (await firestore.collection('deals').doc(id).get()).data() || null } })({ store: 'UT', dealNumber: '90001' });
  assert.strictEqual(ctx.spaceName, 'spaces/REAL');
  assert.strictEqual(ctx.briefNote.id, '5');
  assert.strictEqual(ctx.briefNote.signature.itemCount, 99);
  assert.ok(gets.includes('/crm/v3/objects/notes/5?properties=hs_note_body'));
  assert.ok(!gets.some((p) => p.includes('/deals/d1/associations/notes')));
});

test('saving a brief note records its id and what it was built from', async () => {
  const { createBriefNoteSaver } = require('../src/hubspot/briefNotes');
  const { createDb } = require('../src/db');
  const { createFakeFirestore } = require('./fakeFirestore');
  const firestore = createFakeFirestore();
  const save = createBriefNoteSaver({ hubspot: { createDealNote: async () => '321' }, db: createDb({ firestore }) });
  const brief = { headline: 'h', tags: [], key_facts: [], wow: [], mods: [], journey: [] };
  await save({ context: { store: 'UT', deal: { id: '111', properties: { ls_deal_number: '90001' } }, contact: { id: '77' }, items: [{ at: '2026-11-01T00:00:00Z' }], briefNote: null }, brief });
  const rec = firestore.data.deals['111'];
  assert.strictEqual(rec.briefNoteId, '321');
  assert.strictEqual(rec.contactId, '77');
  assert.deepStrictEqual(rec.briefSignature, { contactId: '77', itemCount: 1, newestAt: '2026-11-01T00:00:00Z' });
  assert.strictEqual(rec.dealNumber, '90001');
});
