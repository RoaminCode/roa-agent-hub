'use strict';

// A guard, not a behavior test. Two kinds of change make every saved brief stop matching,
// so each deal's next brief is a full paid read of its whole record (about $0.18 a deal,
// about $2.50 across 14 open Utah deals, measured 2026-11):
//   1. the brief's shape (a part added, removed, renamed, or retyped), and
//   2. what the record leaves out or how an item reads (the rules in hubspot/dealContext.js).
// Blake's call, 2026-11-12: these are frozen during live testing and shipped together as one
// release, tried first on a branch with /brief in Claude Code (no API credits).
//
// Adding a part is the exception: registered in OPTIONAL_PARTS (agents/roamerBrief.js), a
// saved brief without it stays valid and the next update fills it in, so nothing here fails.
//
// If a test here fails, the change forces that sweep. Do not just update the pinned value:
// tell Blake what it will cost, add it to the batch, and update the pin only in the release
// that ships the batch. A change to the instructions' wording alone does not fail here and
// forces nothing.

const test = require('node:test');
const assert = require('node:assert');
const { createHash } = require('crypto');
const { SCHEMA, isBrief, OPTIONAL_PARTS } = require('../src/agents/roamerBrief');
const { briefSignature } = require('../src/agents/briefNote');
const { createDealContext } = require('../src/hubspot/dealContext');

const COST = 'This forces a full paid read of every deal on its next brief (about $0.18 a deal, $2.50 at 14 deals). Batch it with other brief changes and get Blake\'s go-ahead before updating this pin.';
const hash = (value) => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);

// The shape without its descriptions: rewording a description is not a change of shape.
function shapeOf(schema) {
  if (Array.isArray(schema)) return schema.map(shapeOf);
  if (schema === null || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).filter(([k]) => k !== 'description').map(([k, v]) => [k, shapeOf(v)]));
}

// A brief as Basecamp saves it today. It must keep passing the check a saved brief gets.
const SAVED_BRIEF = {
  headline: 'First trailer, picking up for a fall trip.',
  tags: ['First trailer'],
  key_facts: [{ label: 'Tow vehicle', value: 'Half-ton truck' }],
  wow: [{ detail: 'Wants to camp at the lake', date: '2026-10-02', channel: 'call' }],
  mods: [{ name: 'Solar', price: '$1,200', date: '2026-10-02', status: 'approved', channel: 'call' }],
  commitments: [{ detail: 'Send the walkthrough time', date: '2026-10-03', channel: 'text' }],
  who: 'A couple buying their first trailer.',
  excites: ['The first trip to the lake'],
  journey_summary: 'Deposit down; mods agreed.',
  open_questions: ['Which hitch do they need?'],
};

// The shape every saved brief must have: the schema without the optional parts, which a
// saved brief may lack (OPTIONAL_PARTS in agents/roamerBrief.js). Adding a part there does
// not fail this guard; removing, renaming, or retyping any other part does.
function requiredShape(schema, optional) {
  const properties = Object.fromEntries(Object.entries(schema.properties).filter(([k]) => !(k in optional)));
  return shapeOf({ ...schema, properties, required: schema.required.filter((k) => !(k in optional)) });
}

test('guard: the shape of a saved brief has not changed', () => {
  assert.strictEqual(hash(requiredShape(SCHEMA, OPTIONAL_PARTS)), 'cfbf292df6751523', COST);
  assert.strictEqual(isBrief(SAVED_BRIEF, { saved: true }), true, COST);
});

test('guard: every optional part is in the schema, so a full read always writes it', () => {
  for (const part of Object.keys(OPTIONAL_PARTS)) {
    assert.ok(SCHEMA.required.includes(part) && part in SCHEMA.properties, `optional part "${part}" must be in SCHEMA.properties and SCHEMA.required`);
  }
});

// One of each kind of raw HubSpot record the rules treat differently. Scrubbed: no real
// names, numbers, or words from a Roamer.
const RAW = {
  calls: [
    { id: 'c1', properties: { hs_timestamp: '2026-10-02T10:00:00Z', hs_call_direction: 'OUTBOUND', hs_call_title: 'Call with Pat Sample', hs_call_summary: 'Talked about the Lake Test trip.', hs_call_duration: '240000', hubspot_owner_id: '9' } },
    { id: 'c2', properties: { hs_timestamp: '2026-10-05T10:00:00Z', hs_call_direction: 'INBOUND', hs_call_title: 'Call with Pat Sample', hs_call_body: 'Pat Sample called UT - Sales<br>Line: UT - Sales - (555) 010-0001<br>From: +1 555-010-0000<br>Creator Type: Manual<br>Call Summary:<br>Asked when the solar goes on.', hs_call_summary: 'A different summary from HubSpot.', hs_call_duration: '90000', hubspot_owner_id: '9' } },
    { id: 'c3', properties: { hs_timestamp: '2026-10-06T10:00:00Z', hs_call_direction: 'INBOUND', hs_call_title: 'Call with Pat Sample', hs_call_duration: '0' } },
  ],
  communications: [
    { id: 'm1', properties: { hs_timestamp: '2026-10-03T10:00:00Z', hs_communication_channel_type: 'SMS', hs_communication_body: '+1 555-010-0000 has sent an SMS<br>Line: UT - Sales<br>Message:<br>Can not wait!' } },
    { id: 'm2', properties: { hs_timestamp: '2026-10-03T11:00:00Z', hs_communication_channel_type: 'SMS', hs_communication_body: 'Sam Sample (Browser / Apps) has sent an SMS to +1 555-010-0000<br>Line: UT - Sales - (555) 010-0001<br>Creator Type: Manual<br>Message:<br>See you Tuesday!<br>Click here to respond' } },
    { id: 'm3', properties: { hs_timestamp: '2026-10-03T12:00:00Z', hs_communication_channel_type: 'SMS', hs_communication_body: ' has sent an SMS to +1 555-010-0000<br>Line: UT - Sales<br>Message:<br>Your walkthrough is Friday at 10.' } },
    { id: 'm4', properties: { hs_timestamp: '2026-10-03T13:00:00Z', hs_communication_channel_type: 'SMS', hs_communication_body: ' has sent an SMS to +1 555-010-0000<br>Line: UT - Sales<br>Message:<br>null' } },
    { id: 'm5', properties: { hs_timestamp: '2026-10-04T10:00:00Z', hs_communication_channel_type: 'WHATSAPP', hs_communication_body: 'Not a text.' } },
    { id: 'm6', properties: { hs_timestamp: '2026-10-03T10:00:00Z', hs_communication_channel_type: 'SMS', hs_communication_body: '+1 555-010-0000 has sent an SMS<br>Line: UT - Sales<br>Message:<br>Can not wait!' } },
  ],
  emails: [
    { id: 'e1', properties: { hs_timestamp: '2026-10-07T10:00:00Z', hs_email_direction: 'INCOMING_EMAIL', hs_email_subject: 'Hitch', hs_email_text: 'Which hitch do we need?\n\nOn Mon, Oct 5, 2026 Sam wrote:\n> earlier words', hubspot_owner_id: '9' } },
    { id: 'e2', properties: { hs_timestamp: '2026-10-08T10:00:00Z', hs_email_direction: 'EMAIL', hs_email_subject: 'Re: Hitch', hs_email_text: 'A weight distribution hitch.', hubspot_owner_id: '9' } },
  ],
  notes: [
    { id: 'n1', properties: { hs_timestamp: '2026-10-09T10:00:00Z', hs_note_body: '<p>Bringing their own <b>Starlink</b> &amp; chairs</p>', hubspot_owner_id: '9' } },
    { id: 'n2', properties: { hs_timestamp: '2026-10-09T11:00:00Z', hs_note_body: '<p>Basecamp Q&amp;A: hitch</p><p>Q: Which hitch?</p>' } },
    { id: 'n3', properties: { hs_timestamp: '2026-10-09T12:00:00Z', hs_note_body: '<p>Basecamp WOW plan</p><p>Day pack</p>' } },
  ],
};

const fakeHubSpot = {
  get: async (path) => {
    if (path.startsWith('/crm/v3/owners/')) return { firstName: 'Casey', lastName: 'Coach' };
    if (path.includes('/deals/d1/associations/contacts')) return { results: [{ toObjectId: 77 }] };
    const m = /contacts\/\d+\/associations\/(\w+)/.exec(path);
    if (m) return { results: RAW[m[1]].map((r) => ({ toObjectId: r.id })) };
    throw new Error(`unexpected GET ${path}`);
  },
  post: async (path, body) => {
    if (path.endsWith('/deals/search')) return { results: [{ id: 'd1', properties: { ls_deal_number: '90001', dealname: 'Sample', hubspot_owner_id: '9' } }] };
    if (path.endsWith('/contacts/batch/read')) return { results: [{ id: '77', properties: { firstname: 'Pat', lastname: 'Sample' } }] };
    const m = /objects\/(\w+)\/batch\/read$/.exec(path);
    if (m) return { results: RAW[m[1]].filter((r) => body.inputs.some((i) => String(i.id) === r.id)) };
    throw new Error(`unexpected POST ${path}`);
  },
};

test('guard: the record a brief is built from reads the same for the same HubSpot data', async () => {
  const context = await createDealContext({ hubspot: fakeHubSpot })({ store: 'UT', dealNumber: '90001' });
  const sig = briefSignature(context);
  assert.deepStrictEqual({ itemCount: sig.itemCount, newestAt: sig.newestAt, ids: sig.ids, content: sig.content }, { itemCount: 8, newestAt: '2026-10-09T10:00:00Z', ids: '1ef9015201444d61', content: '4a4b0af21a9afbf8' }, COST);
});

// How an optional part behaves, shown with a made-up one ("trade_in", a string). None is
// registered yet; these pass the registry in by hand.
const { applyChanges, formatUpdate, missingParts } = require('../src/agents/roamerBrief');
const TRADE_IN = { trade_in: (v) => typeof v === 'string' };
const CONTEXT = { deal: { id: 'd1', properties: {} }, contact: { properties: {} }, items: [], omitted: 0, clipped: 0, missing: 0 };

test('a saved brief written before an optional part existed stays valid; one a model just wrote must have it', () => {
  assert.strictEqual(isBrief(SAVED_BRIEF, { saved: true, optional: TRADE_IN }), true, 'no full read is forced');
  assert.strictEqual(isBrief(SAVED_BRIEF, { optional: TRADE_IN }), false, 'a full read always writes every part');
  assert.strictEqual(isBrief({ ...SAVED_BRIEF, trade_in: 'A 2019 teardrop' }, { optional: TRADE_IN }), true);
  assert.strictEqual(isBrief({ ...SAVED_BRIEF, trade_in: 7 }, { saved: true, optional: TRADE_IN }), false, 'present, it must be the right type');
  assert.deepStrictEqual(missingParts(SAVED_BRIEF, TRADE_IN), ['trade_in']);
  assert.deepStrictEqual(missingParts({ ...SAVED_BRIEF, trade_in: '' }, TRADE_IN), []);
});

test('the next update is told which parts are missing, and fills them in', () => {
  const asked = formatUpdate({ context: CONTEXT, brief: SAVED_BRIEF, newItems: [], optional: TRADE_IN });
  assert.ok(asked.includes('written before these parts existed: trade_in'));
  assert.ok(!formatUpdate({ context: CONTEXT, brief: { ...SAVED_BRIEF, trade_in: 'x' }, newItems: [], optional: TRADE_IN }).includes('before these parts existed'));
  assert.ok(!formatUpdate({ context: CONTEXT, brief: SAVED_BRIEF, newItems: [] }).includes('before these parts existed'), 'nothing is asked while no optional part is registered');

  // Written and named, written without being named, and written empty are all taken.
  const named = applyChanges(SAVED_BRIEF, { changed: ['trade_in'], brief: { trade_in: 'A 2019 teardrop' } }, TRADE_IN);
  assert.strictEqual(named.trade_in, 'A 2019 teardrop');
  assert.strictEqual(named.headline, SAVED_BRIEF.headline, 'every other part is kept as it was');
  assert.strictEqual(applyChanges(SAVED_BRIEF, { changed: [], brief: { trade_in: 'A 2019 teardrop' } }, TRADE_IN).trade_in, 'A 2019 teardrop');
  assert.strictEqual(applyChanges(SAVED_BRIEF, { changed: ['trade_in'], brief: { trade_in: '' } }, TRADE_IN).trade_in, '');
  // Not written, or the wrong type: the brief stays valid without it and is asked again next time.
  const skipped = applyChanges(SAVED_BRIEF, { changed: ['who'], brief: { who: 'A couple, first trailer.' } }, TRADE_IN);
  assert.deepStrictEqual([skipped.who, 'trade_in' in skipped], ['A couple, first trailer.', false]);
  assert.strictEqual('trade_in' in applyChanges(SAVED_BRIEF, { changed: [], brief: { trade_in: 7 } }, TRADE_IN), false);
  // A part that had something in it still may not come back empty or unwritten.
  assert.strictEqual(applyChanges({ ...SAVED_BRIEF, trade_in: 'A 2019 teardrop' }, { changed: ['trade_in'], brief: { trade_in: '' } }, TRADE_IN), null);
  assert.strictEqual(applyChanges(SAVED_BRIEF, { changed: ['who'], brief: {} }, TRADE_IN), null);
});
