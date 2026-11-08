'use strict';

// /brief in Claude Code: the script prepares the record and checks the brief Claude Code
// writes. It must never spend API credits (HANDOFF.md, "Read first").

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeWorkFiles, checkBrief, instructions } = require('../scripts/brief');
const { SYSTEM, formatRecord } = require('../src/agents/roamerBrief');

const ROOT = path.join(__dirname, '..');

const brief = {
  headline: 'Pat is buying a first trailer for a family trip to Moab.',
  tags: ['First trailer'],
  key_facts: [{ label: 'Tow vehicle', value: 'Test truck' }],
  wow: [{ detail: 'Two kids, Sam and Lee.', date: '2026-10-01', channel: 'call' }],
  mods: [{ name: 'Awning', status: 'approved', price: '', date: '2026-10-02', channel: 'text' }],
  journey: [],
  who: 'Pat is a first-time owner with two kids.',
  excites: ['A family trip to Moab'],
  journey_summary: 'Deposit Oct 1. The awning is approved.',
  open_questions: [],
};

const context = {
  dealNumber: '90001',
  deal: { properties: { ls_deal_number: '90001', dealname: '90001 - Pat Sample - Test Trailer', projected_delivery_date: '2026-12-01' } },
  contact: { properties: { firstname: 'Pat', lastname: 'Sample' } },
  salesCoach: 'Test Coach',
  items: [{ at: '2026-10-01T15:00:00Z', channel: 'call', who: 'Test Coach', text: 'Pat has two kids, Sam and Lee.' }],
  counts: { call: 1 },
  omitted: 0,
  clipped: 0,
  missing: 0,
};

test('the /brief script and command never touch the Anthropic API', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'brief.js'), 'utf8');
  assert.doesNotMatch(script, /require\(['"]@anthropic-ai\/sdk['"]\)/);
  assert.doesNotMatch(script, /\bwriteBrief\b/);
  assert.doesNotMatch(script, /process\.env\.ANTHROPIC_API_KEY/);
});

test('the instructions are Basecamp\'s own prompt and schema', () => {
  const text = instructions();
  assert.ok(text.startsWith(SYSTEM));
  assert.match(text, /"headline"/);
});

test('prepare writes the same record Basecamp sends, into a fresh folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-test-'));
  fs.writeFileSync(path.join(dir, 'brief.json'), 'an old brief');
  const files = writeWorkFiles(context, dir);
  assert.strictEqual(fs.readFileSync(files.record, 'utf8'), formatRecord(context));
  assert.strictEqual(fs.existsSync(files.brief), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a brief that passes Basecamp\'s check is accepted, even in a code fence', () => {
  assert.deepStrictEqual(checkBrief(JSON.stringify(brief)).problems, []);
  assert.deepStrictEqual(checkBrief('```json\n' + JSON.stringify(brief) + '\n```').problems, []);
});

test('a brief that fails the check says what to fix', () => {
  assert.match(checkBrief('{not json').problems[0], /not valid JSON/);
  const { headline, ...noHeadline } = brief;
  assert.deepStrictEqual(checkBrief(JSON.stringify(noHeadline)).problems, ['missing "headline"']);
  assert.deepStrictEqual(checkBrief(JSON.stringify({ ...brief, extra: 1 })).problems, ['unexpected field "extra"']);
  const badChannel = { ...brief, wow: [{ ...brief.wow[0], channel: 'fax' }] };
  assert.match(checkBrief(JSON.stringify(badChannel)).problems[0], /wrong type or value/);
});
