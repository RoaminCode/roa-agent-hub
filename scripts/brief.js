'use strict';

// The Roamer brief by hand, for /brief in Claude Code. Claude Code writes the brief itself
// on the person's own subscription: this script never calls the Anthropic API and never
// reads ANTHROPIC_API_KEY. It reuses the hub's HubSpot reading, the brief prompt and
// schema, and the brief check, so a brief written here matches what Basecamp would post.
//
//   node scripts/brief.js prepare <deal number> [store] [--contact <id>]
//     Reads the deal from HubSpot and writes the instructions, the record, and the context
//     to a work folder outside the repo, replacing the last one.
//   node scripts/brief.js render
//     Checks brief.json in that folder against the schema and prints the brief.
//
// The HubSpot token comes from HUBSPOT_ACCESS_TOKEN if set, otherwise from Secret Manager
// through gcloud, held in memory only. The work folder holds real Roamer data: never copy
// it or this script's output into the repo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createHubSpotClient } = require('../src/hubspot/client');
const { createDealContext } = require('../src/hubspot/dealContext');
const { formatRecord, renderBrief, isBrief, SYSTEM, SCHEMA } = require('../src/agents/roamerBrief');

const WORK_DIR = path.join(os.tmpdir(), 'roa-brief');
const GCLOUD_FALLBACK = 'C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd';

function hubspotToken() {
  if (process.env.HUBSPOT_ACCESS_TOKEN) return process.env.HUBSPOT_ACCESS_TOKEN;
  const args = ['secrets', 'versions', 'access', 'latest', '--secret=hubspot-access-token', '--project=roa-agent-hub'];
  for (const gcloud of ['gcloud', `"${GCLOUD_FALLBACK}"`]) {
    const r = spawnSync(gcloud, args, { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    if (/auth|login|credential/i.test(r.stderr || '')) {
      throw new Error('gcloud needs a fresh sign-in. Run: gcloud auth login (as blake@rvsofamerica.com), then try again.');
    }
  }
  throw new Error('Could not read the HubSpot token from Secret Manager. Check that gcloud is installed and signed in.');
}

const instructions = () =>
  `${SYSTEM}

Write the brief as JSON exactly matching this JSON Schema, with nothing before or after it:

${JSON.stringify(SCHEMA, null, 2)}
`;

// Writes the three work files and returns their paths. Starts from an empty folder so
// Roamer data from an earlier brief does not pile up.
function writeWorkFiles(context, dir = WORK_DIR) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    instructions: path.join(dir, 'instructions.md'),
    record: path.join(dir, 'record.txt'),
    context: path.join(dir, 'context.json'),
    brief: path.join(dir, 'brief.json'),
  };
  fs.writeFileSync(files.instructions, instructions());
  fs.writeFileSync(files.record, formatRecord(context));
  fs.writeFileSync(files.context, JSON.stringify(context));
  return files;
}

// What is wrong with a written brief, in words Claude Code can fix from; [] when it passes
// the same check Basecamp runs on the API's answer.
function checkBrief(text) {
  let brief;
  try {
    brief = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch (err) {
    return { brief: null, problems: [`brief.json is not valid JSON: ${err.message}`] };
  }
  // The API enforces the schema's "no extra fields"; written by hand, this check does.
  const problems = [];
  const fields = SCHEMA.required;
  const given = brief !== null && typeof brief === 'object' ? brief : {};
  for (const f of fields) if (!(f in given)) problems.push(`missing "${f}"`);
  for (const f of Object.keys(given)) if (!fields.includes(f)) problems.push(`unexpected field "${f}"`);
  if (!problems.length && isBrief(brief)) return { brief, problems: [] };
  if (!problems.length) problems.push('a field has the wrong type or value; check channel (call, text, email, note), mod status (approved, pending, interested, declined), and that every item has all its fields as strings');
  return { brief: null, problems };
}

async function prepare(argv) {
  const args = [...argv];
  let contactId;
  const contactAt = args.indexOf('--contact');
  if (contactAt >= 0) [, contactId] = args.splice(contactAt, 2);
  const [dealNumber, store = 'UT'] = args;
  if (!/^\d{3,8}$/.test(dealNumber || '')) throw new Error('usage: node scripts/brief.js prepare <deal number> [store] [--contact <id>]');

  const load = createDealContext({ hubspot: createHubSpotClient({ token: hubspotToken() }) });
  const context = await load({ store: store.toUpperCase(), dealNumber, contactId });
  if (context.duplicate) return console.log(`STOP: HubSpot has more than one ${store} deal ${dealNumber}.`);
  if (!context.found) return console.log(`STOP: no ${store} deal ${dealNumber} in HubSpot.`);
  if (context.notOnDeal) return console.log(`STOP: contact ${contactId} is not on deal ${dealNumber}.`);
  if (context.choices) {
    console.log(`CHOOSE: deal ${dealNumber} has ${context.contactCount} contacts. Ask which is the Roamer, then run prepare again with --contact <id>:`);
    for (const c of context.choices) console.log(`  ${c.id}  ${c.name}`);
    return;
  }
  if (!context.contact) return console.log(`STOP: deal ${dealNumber} has no Roamer contact attached in HubSpot. That needs fixing in HubSpot.`);

  context.dealNumber = dealNumber;
  const files = writeWorkFiles(context);
  const lines = fs.readFileSync(files.record, 'utf8').split('\n').length;
  console.log(`READY: deal ${dealNumber}, ${context.items.length} items ${JSON.stringify(context.counts)}, omitted ${context.omitted}, clipped ${context.clipped}, missing ${context.missing}.`);
  console.log(`instructions: ${files.instructions}`);
  console.log(`record:       ${files.record} (${lines} lines)`);
  console.log(`write to:     ${files.brief}`);
}

function render() {
  const briefFile = path.join(WORK_DIR, 'brief.json');
  if (!fs.existsSync(briefFile)) throw new Error(`No brief yet: write it to ${briefFile}`);
  const context = JSON.parse(fs.readFileSync(path.join(WORK_DIR, 'context.json'), 'utf8'));
  const { brief, problems } = checkBrief(fs.readFileSync(briefFile, 'utf8'));
  if (problems.length) {
    console.log('FIX: the brief does not pass the check:');
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(renderBrief({ dealNumber: context.dealNumber, context, brief }));
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === 'prepare') return prepare(rest);
  if (mode === 'render') return render();
  throw new Error('usage: node scripts/brief.js prepare <deal number> [store] [--contact <id>] | render');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { writeWorkFiles, checkBrief, instructions };
