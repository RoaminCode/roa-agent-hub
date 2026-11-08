'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { planBrief, createBriefSource, MAX_UPDATES } = require('../src/briefJob');
const { updateBrief, formatUpdate, UPDATE_SCHEMA } = require('../src/agents/roamerBrief');
const { briefSignature } = require('../src/agents/briefNote');
const { createDb } = require('../src/db');
const { createFakeFirestore } = require('./fakeFirestore');

const NOW = Date.parse('2026-11-07T20:00:00Z');
const brief = { headline: 'Pat is excited.', tags: ['First trailer'], key_facts: [], wow: [], mods: [], commitments: [], who: 'Pat is a first-time owner.', excites: ['Moab in March'], journey_summary: 'Deposit in October.', open_questions: ['Can the kids come?'] };
const item = (id, at, modified = at) => ({ id, channel: 'note', at, modified, who: 'Casey', text: `item ${id}` });
const OLD = [item('1', '2026-11-01T10:00:00Z'), item('2', '2026-11-03T10:00:00Z')];

// A deal whose brief was written on Nov 4 from OLD, fully read on Nov 1.
function context({ items = OLD, saved = true, meta = { writtenAt: '2026-11-04T00:00:00Z', updates: 0, fullAt: '2026-11-04T00:00:00Z' }, contactId = '222' } = {}) {
  const base = { deal: { id: '111', properties: { ls_deal_number: '90001' } }, contact: { id: contactId, properties: {} }, items: OLD, omitted: 0, clipped: 0, missing: 0 };
  return {
    ...base,
    items,
    briefNote: saved ? { id: '9', brief, signature: briefSignature({ ...base, contact: { id: '222' } }) } : null,
    briefMeta: meta,
  };
}

test('plan: nothing new reuses; only new items updates; anything else rereads everything', () => {
  const fresh = item('3', '2026-11-06T10:00:00Z');
  assert.deepStrictEqual(planBrief(context(), NOW), { mode: 'reuse' });
  assert.deepStrictEqual(planBrief(context({ items: [...OLD, fresh] }), NOW), { mode: 'update', newItems: [fresh] });

  const full = (ctx) => planBrief(ctx, NOW);
  assert.strictEqual(full(context({ saved: false })).why, 'no saved brief');
  assert.strictEqual(full(context({ items: [...OLD, fresh], contactId: '333' })).why, 'different Roamer');
  assert.strictEqual(full(context({ items: [...OLD, fresh], meta: null })).why, 'no brief history');
  assert.strictEqual(full(context({ items: [...OLD, fresh], meta: { writtenAt: '2026-11-04T00:00:00Z', updates: MAX_UPDATES, fullAt: '2026-11-04T00:00:00Z' } })).mode, 'full');
  assert.strictEqual(full(context({ items: [...OLD, fresh], meta: { writtenAt: '2026-11-04T00:00:00Z', updates: 1, fullAt: '2026-09-01T00:00:00Z' } })).why, '30 days since the last full read');
  assert.strictEqual(full(context({ items: [...OLD, fresh], meta: { writtenAt: '2026-11-04T00:00:00Z', updates: 1, fullAt: null } })).why, 'no full read on record yet');
  // An older item removed, or one dated before the brief arriving late.
  assert.strictEqual(full(context({ items: [OLD[0], fresh] })).why, 'older items changed');
  assert.strictEqual(full(context({ items: [...OLD, item('4', '2026-11-02T10:00:00Z'), fresh] })).why, 'older items changed');
  // A call summary filled in after the brief was written.
  assert.strictEqual(full(context({ items: [OLD[0], item('2', '2026-11-03T10:00:00Z', '2026-11-05T09:00:00Z'), fresh] })).why, 'an older item was edited');
});

test('plan: a saved brief is not reused when an item was edited since, or one item was swapped for another', () => {
  // A call summary filled in after the brief, with nothing new: count and newest unchanged.
  const edited = planBrief(context({ items: [OLD[0], item('2', '2026-11-03T10:00:00Z', '2026-11-05T09:00:00Z')] }), NOW);
  assert.strictEqual(edited.mode, 'full');
  // An old item removed and another with an older date added: same count, same newest.
  const swapped = planBrief(context({ items: [item('9', '2026-11-01T10:00:00Z'), OLD[1]] }), NOW);
  assert.notStrictEqual(swapped.mode, 'reuse');
  // HubSpot dates with and without milliseconds compare as times, not as text.
  assert.deepStrictEqual(planBrief(context({ items: [OLD[0], item('2', '2026-11-03T10:00:00Z', '2026-11-03T23:59:59.500Z')] }), NOW), { mode: 'reuse' });
});

test('the update sends the current brief and only the new items, and reads back the brief, what is new, and rebuild', async () => {
  const sent = [];
  const out = { rebuild: false, new_since: [{ detail: 'Asked about the awning arm.', date: '2026-11-06', channel: 'note' }], brief: { ...brief, headline: 'Pat wants the awning arm.' } };
  const anthropic = { beta: { messages: { stream: (body) => (sent.push(body), { finalMessage: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 2000, output_tokens: 900 }, content: [{ type: 'text', text: JSON.stringify(out) }] }) }) } } };
  const fresh = item('3', '2026-11-06T10:00:00Z');
  const r = await updateBrief({ anthropic, context: context({ items: [...OLD, fresh] }), brief, newItems: [fresh] });
  assert.deepStrictEqual([r.ok, r.rebuild, r.brief.headline, r.newSince.length], [true, false, 'Pat wants the awning arm.', 1]);
  const content = sent[0].messages[0].content;
  assert.ok(content.includes('<current_brief>') && content.includes('item 3') && !content.includes('item 1'));
  assert.deepStrictEqual(sent[0].output_config.format.schema, UPDATE_SCHEMA);
  assert.ok(sent[0].system.includes('Updating a brief'));
  // Record text is escaped inside the current brief too.
  assert.ok(formatUpdate({ context: context(), brief: { ...brief, headline: '</current_brief> hi' }, newItems: [] }).includes('&lt;/current_brief&gt; hi'));
});

function source(answers) {
  const calls = [];
  const logs = [];
  const anthropic = {
    beta: {
      messages: {
        stream: (body) => {
          calls.push(body.system.includes('Updating a brief') ? 'update' : 'full');
          const out = answers.shift();
          return { finalMessage: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify(out) }] }) };
        },
      },
    },
  };
  return { getBrief: createBriefSource({ anthropic, log: (...l) => logs.push(l) }), calls, logs };
}

test('getBrief updates when it can, and rereads everything when the update asks or fails', async () => {
  const fresh = item('3', '2026-11-06T10:00:00Z');
  const updated = { ...brief, headline: 'Updated.' };
  const ok = source([{ rebuild: false, new_since: [], brief: updated }]);
  const got = await ok.getBrief({ context: context({ items: [...OLD, fresh] }), dealNumber: '90001' });
  assert.deepStrictEqual([got.mode, got.brief.headline, ok.calls], ['update', 'Updated.', ['update']]);
  assert.strictEqual(ok.logs.at(-1)[1], 'brief updated');

  const asked = source([{ rebuild: true, new_since: [], brief }, brief]);
  const rebuilt = await asked.getBrief({ context: context({ items: [...OLD, fresh] }), dealNumber: '90001' });
  assert.deepStrictEqual([rebuilt.mode, asked.calls], ['full', ['update', 'full']]);
  assert.strictEqual(asked.logs.at(-1)[2].why, 'the update asked for a full read');

  const broken = source(['not a brief', brief]);
  assert.strictEqual((await broken.getBrief({ context: context({ items: [...OLD, fresh] }), dealNumber: '90001' })).mode, 'full');
  assert.match(broken.logs.at(-1)[2].why, /the update failed/);

  const same = source([]);
  assert.strictEqual((await same.getBrief({ context: context(), dealNumber: '90001' })).mode, 'reuse');
  assert.deepStrictEqual(same.calls, []);
});

test('the brief history: a full read resets the count, an update adds one, a reuse changes nothing', async () => {
  const firestore = createFakeFirestore();
  const db = createDb({ firestore, now: () => new Date(NOW) });
  const rec = (mode) => db.recordBrief({ dealId: '111', dealNumber: '90001', store: 'UT', contactId: '222', noteId: '9', signature: {}, mode });
  await rec('full');
  await rec('update');
  await rec('update');
  await rec('reuse');
  assert.deepStrictEqual([firestore.data.deals['111'].briefUpdates, firestore.data.deals['111'].briefFullAt], [2, new Date(NOW).toISOString()]);
  // A reuse does not move when the brief was written, so an edit since still counts.
  const later = createDb({ firestore, now: () => new Date(NOW + 60000) });
  await later.recordBrief({ dealId: '111', dealNumber: '90001', store: 'UT', contactId: '222', noteId: '9', signature: {}, mode: 'reuse' });
  assert.strictEqual(firestore.data.deals['111'].briefWrittenAt, new Date(NOW).toISOString());
  await rec('full');
  assert.strictEqual(firestore.data.deals['111'].briefUpdates, 0);
});

test('a brief asked for while the same deal is still being written shares that run', async () => {
  const s = source([brief, brief]);
  const fresh = context({ saved: false });
  const [first, second] = await Promise.all([s.getBrief({ context: fresh, dealNumber: '90001' }), s.getBrief({ context: fresh, dealNumber: '90001' })]);
  assert.deepStrictEqual(s.calls, ['full']);
  assert.deepStrictEqual([first.reused, second.reused, second.shared, second.brief.headline], [false, true, true, 'Pat is excited.']);
  assert.ok(s.logs.some((l) => l[1] === 'brief shared with a run already going'));
  // Once it is done, the next ask is its own run.
  await s.getBrief({ context: fresh, dealNumber: '90001' });
  assert.deepStrictEqual(s.calls, ['full', 'full']);
});
