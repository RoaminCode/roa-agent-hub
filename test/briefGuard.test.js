'use strict';

// A guard, not a behavior test. Two kinds of change make every saved brief stop matching,
// so each deal's next brief is a full paid read of its whole record (about $0.18 a deal,
// about $2.50 across 14 open Utah deals, measured 2026-11):
//   1. the brief's shape (a part added, removed, renamed, or retyped), and
//   2. what the record leaves out or how an item reads (the rules in hubspot/dealContext.js).
// Blake's call, 2026-11-12: these are frozen during live testing and shipped together as one
// release, tried first on a branch with /brief in Claude Code (no API credits).
//
// If a test here fails, the change forces that sweep. Do not just update the pinned value:
// tell Blake what it will cost, add it to the batch, and update the pin only in the release
// that ships the batch. A change to the instructions' wording alone does not fail here and
// forces nothing.

const test = require('node:test');
const assert = require('node:assert');
const { createHash } = require('crypto');
const { SCHEMA, isBrief } = require('../src/agents/roamerBrief');
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

test('guard: the shape of a saved brief has not changed', () => {
  assert.strictEqual(hash(shapeOf(SCHEMA)), 'cfbf292df6751523', COST);
  assert.strictEqual(isBrief(SAVED_BRIEF), true, COST);
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
