'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { toRjbView } = require('../src/lightspeed/rjbView');

const fixturePath = path.join(__dirname, 'fixtures', 'deal-lookup-sample.json');
const raw = fs.readFileSync(fixturePath, 'utf8');
const view = toRjbView(JSON.parse(raw));
const titles = (list) => list.map((m) => m.title);

test('maps the store to its Experience Center', () => {
  assert.strictEqual(view.deal.experienceCenter, 'Utah');
});

test('marks the unit on the lot when it has a received date', () => {
  assert.strictEqual(view.unit.onLot, true);
});

test('keeps Dealer Add and Customer Add labor lines as mods', () => {
  assert.strictEqual(view.mods.filter((m) => m.type === 'Dealer Add').length, 4);
  assert.ok(titles(view.mods).includes('DC TO DC ANDERSEN INSTALL 120'));
});

test('counts a "charge sales" Prep line as an included mod', () => {
  const stove = view.mods.find((m) => /induction/i.test(m.title));
  assert.ok(stove && stove.includedAtNoCharge);
});

test('separates the PDI and its findings from mods', () => {
  assert.ok(!titles(view.mods).some((t) => /PDI/i.test(t)));
  assert.strictEqual(view.prep.filter((p) => p.kind === 'PDI').length, 1);
  assert.strictEqual(view.prep.filter((p) => p.kind === 'Finding').length, 3);
});

test('flags a PDI line that is not on a repair order', () => {
  assert.ok(view.flags.some((f) => /template/i.test(f)));
});

test('leaves out contact and finance fields', () => {
  const out = JSON.stringify(view);
  assert.ok(!/HomePhone|EMail|Birthdate|AmtFinanced|femargin/.test(out));
});

test('shrinks the lookup by at least 90%', () => {
  assert.ok(JSON.stringify(view).length < raw.length * 0.1);
});
