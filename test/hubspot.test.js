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

test('the HubSpot client offers no writes but the note and Delivery record methods', () => {
  const hubspot = createHubSpotClient({ token: 't', fetchImpl: async () => ok({}) });
  assert.deepStrictEqual(Object.keys(hubspot).sort(), ['createDelivery', 'createNote', 'get', 'linkNoteToDelivery', 'post', 'updateNote']);
});

test('createNote creates one note on the Roamer, and never on the deal', async () => {
  const calls = [];
  const hubspot = createHubSpotClient({ token: 't', fetchImpl: async (url, opts) => (calls.push([opts.method, url, JSON.parse(opts.body)]), ok({ id: 555 })) });
  assert.strictEqual(await hubspot.createNote({ contactId: '77', body: '<p>x</p>', timestamp: '2026-11-07T03:14:00.000Z' }), '555');
  assert.deepStrictEqual(calls, [
    [
      'POST',
      'https://api.hubapi.com/crm/v3/objects/notes',
      {
        properties: { hs_timestamp: '2026-11-07T03:14:00.000Z', hs_note_body: '<p>x</p>' },
        associations: [{ to: { id: '77' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }],
      },
    ],
  ]);
  await assert.rejects(hubspot.createNote({ contactId: '77/../deals/5', body: 'x', timestamp: 't' }), /invalid contact id/);
  await assert.rejects(hubspot.createNote({ body: 'x', timestamp: 't' }), /a contact or a Delivery record is required/);
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

test("leaves Basecamp's own brief note out of the record and hands it over separately; one on the deal is never used", async () => {
  const { renderBriefNote } = require('../src/agents/briefNote');
  const brief = { headline: 'Pat is excited.', tags: [], key_facts: [], wow: [], mods: [], journey: [], who: 'Pat is a first-time owner.', excites: ['Moab in March'], journey_summary: 'Deposit in October.', open_questions: ['Can the kids come?'] };
  const body = renderBriefNote({ brief, context: { contact: { id: 77 }, items: [] }, now: new Date('2026-11-07T03:14:00Z') });
  const note = (id, at) => ({ id, properties: { hs_timestamp: at, hs_note_body: body } });
  const hubspot = fakeHubSpot({
    contactNotes: [note('b0', '2026-10-05T10:00:00Z'), note('b2', '2026-11-01T10:00:00Z'), { id: 'n2', properties: { hs_timestamp: '2026-10-06T10:00:00Z', hs_note_body: 'Loves dark chocolate' } }],
    // A brief note left on the deal from before 2026-11-07, newer, is never read or updated.
    dealNotes: [note('b9', '2026-11-07T03:14:00Z')],
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
  const brief = { headline: 'h', tags: [], key_facts: [], wow: [], mods: [], journey: [], who: 'Pat is a first-time owner.', excites: ['Moab in March'], journey_summary: 'Deposit in October.', open_questions: ['Can the kids come?'] };
  const body = renderBriefNote({ brief, context: { contact: { id: 78 }, items: [] } });
  const hubspot = fakeHubSpot({ contacts: [77, 78], contactNotes: [{ id: 'b1', properties: { hs_timestamp: '2026-11-01T10:00:00Z', hs_note_body: body } }] });
  // Basecamp's record names the Roamer the brief was written for.
  const load = createDealContext({ hubspot, db: { getDeal: async () => ({ contactId: '78' }) } });
  const remembered = await load({ store: 'UT', dealNumber: '90001', rememberPick: true });
  assert.strictEqual(remembered.contact.properties.firstname, 'Chris');
  const asked = await load({ store: 'UT', dealNumber: '90001' });
  assert.strictEqual(asked.choices.length, 2);
  const none = await createDealContext({ hubspot: fakeHubSpot({ contacts: [77, 78] }) })({ store: 'UT', dealNumber: '90001', rememberPick: true });
  assert.strictEqual(none.choices.length, 2);
});

test('finding a deal space reads only the deal and its brief note', async () => {
  const { renderBriefNote } = require('../src/agents/briefNote');
  const brief = { headline: 'h', tags: [], key_facts: [], wow: [], mods: [], journey: [], who: 'Pat is a first-time owner.', excites: ['Moab in March'], journey_summary: 'Deposit in October.', open_questions: ['Can the kids come?'] };
  const body = renderBriefNote({ brief, context: { contact: { id: 77 }, items: [] }, spaceName: 'spaces/DEAL' });
  const hubspot = fakeHubSpot({ contactNotes: [{ id: 'b1', properties: { hs_timestamp: '2026-11-01T10:00:00Z', hs_note_body: body } }] });
  // Basecamp's record names the Roamer, and the brief note on the Roamer is found.
  const { findDealSpace } = createDealContext({ hubspot, db: { getDeal: async () => ({ contactId: '77', spaceName: 'spaces/DEAL' }) } });
  const found = await findDealSpace({ store: 'UT', dealNumber: '90001' });
  assert.strictEqual(found.spaceName, 'spaces/DEAL');
  assert.strictEqual(found.contactId, '77');
  // A brief note on the deal, from before 2026-11-07, is not read.
  const onDeal = fakeHubSpot({ dealNotes: [{ id: 'b1', properties: { hs_timestamp: '2026-11-01T10:00:00Z', hs_note_body: body } }] });
  assert.strictEqual((await createDealContext({ hubspot: onDeal }).findDealSpace({ dealNumber: '90001' })).spaceName, null);
  assert.ok(found.deal.id);
  assert.strictEqual((await createDealContext({ hubspot: fakeHubSpot() }).findDealSpace({ dealNumber: '90001' })).spaceName, null);
  assert.strictEqual(await createDealContext({ hubspot: fakeHubSpot({ deals: 2 }) }).findDealSpace({ dealNumber: '90001' }), null);
});

test('createNote puts the note on the Roamer and the Delivery record, never the deal', async () => {
  const calls = [];
  const hubspot = createHubSpotClient({ token: 't', fetchImpl: async (url, opts) => (calls.push(JSON.parse(opts.body)), ok({ id: 556 })) });
  await hubspot.createNote({ contactId: '77', deliveryId: '888', body: '<p>x</p>', timestamp: 't' });
  assert.deepStrictEqual(calls[0].associations, [
    { to: { id: '77' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] },
    { to: { id: '888' }, types: [{ associationCategory: 'USER_DEFINED', associationTypeId: 95 }] },
  ]);
  await hubspot.createNote({ deliveryId: '888', body: 'x', timestamp: 't' });
  assert.strictEqual(calls[1].associations.length, 1);
  await assert.rejects(hubspot.createNote({ contactId: '77', deliveryId: '8/x', body: 'x', timestamp: 't' }), /invalid delivery id/);
});

test("with Basecamp's record, the brief note is read by id and the space and signature come from the record", async () => {
  const { renderBriefNote } = require('../src/agents/briefNote');
  const { createFakeFirestore } = require('./fakeFirestore');
  const brief = { headline: 'h', tags: [], key_facts: [], wow: [], mods: [], journey: [], who: 'Pat is a first-time owner.', excites: ['Moab in March'], journey_summary: 'Deposit in October.', open_questions: ['Can the kids come?'] };
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
  assert.ok(gets.includes('/crm/v3/objects/notes/5?properties=hs_note_body&associations=deals'));
  assert.ok(!gets.some((p) => p.includes('/deals/d1/associations/notes')));
});

test("a recorded brief note that is on a deal is not used, so it is never updated there", async () => {
  const { renderBriefNote } = require('../src/agents/briefNote');
  const brief = { headline: 'h', tags: [], key_facts: [], wow: [], mods: [], journey: [], who: 'w', excites: ['e'], journey_summary: 'j', open_questions: ['q'] };
  const body = renderBriefNote({ brief, context: { contact: { id: 77 }, items: [] } });
  const base = fakeHubSpot();
  const hubspot = {
    ...base,
    get: async (path) => (path.startsWith('/crm/v3/objects/notes/5') ? { id: '5', properties: { hs_note_body: body }, associations: { deals: { results: [{ id: 'd1' }] } } } : base.get(path)),
  };
  const ctx = await createDealContext({ hubspot, db: { getDeal: async () => ({ briefNoteId: '5', contactId: '77' }) } })({ store: 'UT', dealNumber: '90001' });
  assert.strictEqual(ctx.briefNote, null);
});

test("Basecamp's own Q&A, WOW plan, and text-sent notes are not part of the record; a Team Member's space note is", async () => {
  const { renderQaNote } = require('../src/hubspot/qaNotes');
  const { renderWowNote } = require('../src/wowJob');
  const { renderTextNote } = require('../src/textJob');
  const { renderSpaceNote } = require('../src/spaceNotes');
  const at = new Date('2026-11-07T18:00:00Z');
  const bodies = [
    renderQaNote({ topic: 'awning arm', question: 'Is it in?', askedBy: 'Casey', at }),
    renderWowNote({ title: 'Backing course', tailored: 'A backing course for Pat', category: 'skills', tier: 'low', who: 'Blake', now: at }),
    renderTextNote({ message: 'Hi', name: 'Pat', number: '+14355550199', approver: 'Blake', line: { label: 'UT' }, now: at }),
    renderSpaceNote({ text: 'Roamer wants Saturday', userEmail: 'c@example.com', now: at }),
  ];
  const hubspot = fakeHubSpot({ contactNotes: bodies.map((b, i) => ({ id: `q${i}`, properties: { hs_timestamp: '2026-11-07T18:00:00Z', hs_note_body: b } })) });
  const ctx = await createDealContext({ hubspot })({ store: 'UT', dealNumber: '90001' });
  const notes = ctx.items.filter((i) => i.channel === 'note');
  assert.strictEqual(notes.length, 1);
  assert.ok(notes[0].text.includes('Roamer wants Saturday'));
});

test('saving a brief note records its id and what it was built from', async () => {
  const { createBriefNoteSaver } = require('../src/hubspot/briefNotes');
  const { createDb } = require('../src/db');
  const { createFakeFirestore } = require('./fakeFirestore');
  const firestore = createFakeFirestore();
  const save = createBriefNoteSaver({ hubspot: { createNote: async () => '321' }, db: createDb({ firestore }) });
  const brief = { headline: 'h', tags: [], key_facts: [], wow: [], mods: [], journey: [], who: 'Pat is a first-time owner.', excites: ['Moab in March'], journey_summary: 'Deposit in October.', open_questions: ['Can the kids come?'] };
  await save({ context: { store: 'UT', deal: { id: '111', properties: { ls_deal_number: '90001' } }, contact: { id: '77' }, items: [{ at: '2026-11-01T00:00:00Z' }], briefNote: null }, brief });
  const rec = firestore.data.deals['111'];
  assert.strictEqual(rec.briefNoteId, '321');
  assert.strictEqual(rec.contactId, '77');
  assert.deepStrictEqual({ ...rec.briefSignature, ids: undefined }, { contactId: '77', itemCount: 1, newestAt: '2026-11-01T00:00:00Z', ids: undefined });
  assert.match(rec.briefSignature.ids, /^[0-9a-f]{16}$/);
  assert.strictEqual(rec.dealNumber, '90001');
});

test('createDelivery makes one Delivery record at Deposit Received, named, linked to the deal and the Roamer, nothing else filled', async () => {
  const calls = [];
  const hubspot = createHubSpotClient({ token: 't', fetchImpl: async (url, opts) => (calls.push([opts.method, url, opts.body && JSON.parse(opts.body)]), ok({ id: 888 })) });
  assert.strictEqual(await hubspot.createDelivery({ dealId: '111', contactId: '77', name: '90001 - Pat Sample', trailer: '2026 Trailer Model' }), '888');
  assert.deepStrictEqual(calls[0], [
    'POST',
    'https://api.hubapi.com/crm/v3/objects/2-59426991',
    {
      properties: { hs_pipeline: '883780109', hs_pipeline_stage: '1327357231', delivery_name: '90001 - Pat Sample', delivery_trailer: '2026 Trailer Model' },
      associations: [
        { to: { id: '111' }, types: [{ associationCategory: 'USER_DEFINED', associationTypeId: 98 }] },
        { to: { id: '77' }, types: [{ associationCategory: 'USER_DEFINED', associationTypeId: 96 }] },
      ],
    },
  ]);
  await hubspot.linkNoteToDelivery({ noteId: '5', deliveryId: '888' });
  assert.deepStrictEqual(calls[1], ['PUT', 'https://api.hubapi.com/crm/v4/objects/notes/5/associations/2-59426991/888', [{ associationCategory: 'USER_DEFINED', associationTypeId: 95 }]]);
  await hubspot.createNote({ contactId: '77', deliveryId: '888', body: 'x', timestamp: 't' });
  assert.deepStrictEqual(calls[2][2].associations[1], { to: { id: '888' }, types: [{ associationCategory: 'USER_DEFINED', associationTypeId: 95 }] });
  await assert.rejects(hubspot.createDelivery({ dealId: '1/../x', name: 'n' }), /invalid deal id/);
  await assert.rejects(hubspot.createDelivery({ dealId: '111' }), /a name is required/);
  await assert.rejects(hubspot.linkNoteToDelivery({ noteId: '5', deliveryId: '8/x' }), /invalid id/);
  // The guard still refuses any other write, including to other objects' records.
  await assert.rejects(hubspot.post('/crm/v3/objects/deals', {}), /refuses/);
});

test('ensureDelivery uses the deal\'s Delivery record, or creates and links one, once', async () => {
  const { createDeliveries } = require('../src/hubspot/deliveries');
  const { createDb } = require('../src/db');
  const { createFakeFirestore } = require('./fakeFirestore');
  const setup = async (linked) => {
    const firestore = createFakeFirestore();
    const db = createDb({ firestore });
    await db.recordBrief({ dealId: '111', dealNumber: '90001', store: 'UT', contactId: '77', noteId: '5', signature: {} });
    const calls = [];
    const hubspot = {
      get: async (path) => (calls.push(['get', path]), { results: linked.map((id) => ({ toObjectId: id })) }),
      createDelivery: async (a) => (calls.push(['create', a]), '888'),
      linkNoteToDelivery: async (a) => calls.push(['link', a]),
    };
    const logs = [];
    return { ensure: createDeliveries({ hubspot, db, log: (...l) => logs.push(l) }), calls, logs, data: firestore.data };
  };

  const fresh = await setup([]);
  assert.deepStrictEqual(await fresh.ensure({ dealId: '111', dealNumber: '90001', dealname: '90001 - Pat Sample - 2026 Trailer Model', contactId: '77' }), { id: '888', created: true });
  assert.deepStrictEqual(fresh.calls.slice(1), [['create', { dealId: '111', contactId: '77', name: '90001 - Pat Sample', trailer: '2026 Trailer Model' }], ['link', { noteId: '5', deliveryId: '888' }]]);
  assert.strictEqual(fresh.data.deals['111'].deliveryId, '888');
  // Recorded: the second time asks HubSpot nothing.
  assert.deepStrictEqual(await fresh.ensure({ dealId: '111', dealNumber: '90001', contactId: '77' }), { id: '888', created: false });
  assert.strictEqual(fresh.calls.length, 3);

  const existing = await setup([4002, 4001]);
  assert.deepStrictEqual(await existing.ensure({ dealId: '111', dealNumber: '90001', contactId: '77' }), { id: '4001', created: false });
  assert.ok(!existing.calls.some((c) => c[0] === 'create'));
  assert.ok(existing.logs.some((l) => l[1].includes('more than one Delivery record')));
});

test("two runs ensuring a deal's Delivery record at once create one record, not two", async () => {
  const { createDeliveries } = require('../src/hubspot/deliveries');
  const { createDb } = require('../src/db');
  const { createFakeFirestore } = require('./fakeFirestore');
  const db = createDb({ firestore: createFakeFirestore() });
  let creates = 0;
  const hubspot = { get: async () => ({ results: [] }), createDelivery: async () => (creates++, await new Promise((r) => setTimeout(r, 10)), '888'), linkNoteToDelivery: async () => {} };
  const ensure = createDeliveries({ hubspot, db, log: () => {} });
  const args = { dealId: '111', dealNumber: '90001', contactId: '77' };
  const [a, b] = await Promise.all([ensure(args), ensure(args)]);
  assert.strictEqual(creates, 1);
  assert.deepStrictEqual([a, b].filter(Boolean), [{ id: '888', created: true }]);
  // A failed try lets the next one through.
  const failing = createDeliveries({ hubspot: { ...hubspot, createDelivery: async () => { throw new Error('down'); } }, db: createDb({ firestore: createFakeFirestore() }), log: () => {} });
  await assert.rejects(failing(args));
  await assert.rejects(failing(args), /down/);
});

test('a deal with an open space but no Delivery record gets one the next time it is found; one with no space does not', async () => {
  const { withDeliveryRecord } = require('../src/hubspot/deliveries');
  const ensured = [];
  const ensureDelivery = async (a) => (ensured.push(a), { id: '888', created: true });
  const deal = { id: '111', properties: { ls_deal_number: '90001', dealname: '90001 - Pat Sample' } };
  const find = withDeliveryRecord(async ({ space }) => ({ deal, spaceName: space, contactId: '77', deliveryId: null }), { ensureDelivery, log: () => {} });
  assert.strictEqual((await find({ space: 'spaces/A' })).deliveryId, '888');
  assert.deepStrictEqual(ensured, [{ dealId: '111', dealNumber: '90001', dealname: '90001 - Pat Sample', contactId: '77' }]);
  assert.strictEqual((await find({ space: null })).deliveryId, null);
  assert.strictEqual(ensured.length, 1);
  // A HubSpot failure is logged and the deal still comes back.
  const logs = [];
  const broken = withDeliveryRecord(async () => ({ deal, spaceName: 'spaces/A', deliveryId: null }), { ensureDelivery: async () => { throw new Error('down'); }, log: (...l) => logs.push(l) });
  assert.strictEqual((await broken({})).deal, deal);
  assert.strictEqual(logs[0][1], 'could not find or create Delivery record');
});

test('reads the "Name (Rvs of America):" text format; no name, or another name in brackets, stays unknown', () => {
  assert.deepStrictEqual(parseAlowareText('<b>Sam Sample (Rvs of America):</b><br>See you Tuesday!'), { sender: 'Sam Sample', message: 'See you Tuesday!' });
  assert.deepStrictEqual(parseAlowareText('<b>(Rvs of America):</b><br>Welcome to Rvs of America!'), { sender: null, message: 'Welcome to Rvs of America!' });
  assert.deepStrictEqual(parseAlowareText('<b>Pat Sample (Pat Sample):</b><br>Thanks'), { sender: null, message: 'Thanks' });
});

test('two briefs for a deal saved at once make one brief note, not two', async () => {
  const { createBriefNoteSaver } = require('../src/hubspot/briefNotes');
  const { createDb } = require('../src/db');
  const { createFakeFirestore } = require('./fakeFirestore');
  const { renderBriefNote } = require('../src/agents/briefNote');
  const db = createDb({ firestore: createFakeFirestore() });
  const real = db.withLock;
  db.withLock = (name, fn) => real(name, fn, { stepMs: 5 });
  const created = [];
  const updated = [];
  const hubspot = {
    createNote: async (n) => (await new Promise((r) => setTimeout(r, 15)), created.push(n), '321'),
    updateNote: async (u) => {
      const body = renderBriefNote({ brief: { headline: 'h', tags: [], key_facts: [], wow: [], mods: [], journey: [], who: 'w', excites: ['e'], journey_summary: 'j', open_questions: ['q'] }, context: { contact: { id: 77 }, items: [] } });
      if (!u.isOurs(body)) throw new Error('not ours');
      updated.push(u.noteId);
      return u.noteId;
    },
  };
  const save = createBriefNoteSaver({ hubspot, db });
  const brief = { headline: 'h', tags: [], key_facts: [], wow: [], mods: [], journey: [], who: 'w', excites: ['e'], journey_summary: 'j', open_questions: ['q'] };
  const context = { store: 'UT', deal: { id: '111', properties: { ls_deal_number: '90001' } }, contact: { id: '77' }, items: [], briefNote: null };
  await Promise.all([save({ context, brief }), save({ context, brief })]);
  assert.strictEqual(created.length, 1);
  assert.deepStrictEqual(updated, ['321']);
});
