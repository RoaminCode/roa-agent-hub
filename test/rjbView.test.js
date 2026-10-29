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

test('keeps the received date without claiming the unit is on the lot', () => {
  assert.ok(view.unit.dateReceived);
  assert.ok(!('onLot' in view.unit));
});

test('keeps Dealer Add and Customer Add labor lines as mods', () => {
  assert.strictEqual(view.mods.filter((m) => m.type === 'Dealer Add').length, 4);
  assert.ok(titles(view.mods).includes('DC TO DC ANDERSEN INSTALL 120'));
});

test("keeps a labor line's retail price under a name that says it is labor only", () => {
  const sensors = view.mods.find((m) => /Mopeka/.test(m.title));
  assert.strictEqual(sensors.laborRetailPrice, 118);
  assert.ok(!('price' in sensors));
});

test('leaves an unknown labor price as null, not zero', () => {
  const lookup = JSON.parse(raw);
  const labor = lookup.result.found[0].deal.Units[0].Labor;
  const mopeka = labor.find((l) => /Mopeka/.test(l.RepairOrderJobTitle || ''));
  delete mopeka.RetailPrice;
  const again = toRjbView(lookup).mods.find((m) => /Mopeka/.test(m.title));
  assert.strictEqual(again.laborRetailPrice, null);
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

test('shrinks the lookup by at least 85%, both compared without whitespace', () => {
  assert.ok(JSON.stringify(view).length < JSON.stringify(JSON.parse(raw)).length * 0.15);
});
