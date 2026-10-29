'use strict';

// Prints the Roamer brief for one deal to the terminal, for checking briefs before they
// reach Chat. Reads real Roamer data: never redirect this output into the repo.
//   HUBSPOT_ACCESS_TOKEN=... ANTHROPIC_API_KEY=... node scripts/brief.js 51431 [UT]

const Anthropic = require('@anthropic-ai/sdk');
const { createHubSpotClient } = require('../src/hubspot/client');
const { createDealContext } = require('../src/hubspot/dealContext');
const { writeBrief, renderBrief } = require('../src/agents/roamerBrief');

async function main() {
  const [dealNumber, store = 'UT'] = process.argv.slice(2);
  if (!dealNumber) throw new Error('usage: node scripts/brief.js <deal number> [store]');

  const load = createDealContext({ hubspot: createHubSpotClient({ token: process.env.HUBSPOT_ACCESS_TOKEN }) });
  const started = Date.now();
  const context = await load({ store, dealNumber });
  if (context.duplicate) return console.log(`More than one ${store} deal ${dealNumber} in HubSpot.`);
  if (!context.found) return console.log(`No ${store} deal ${dealNumber} in HubSpot.`);
  if (!context.contact) return console.log(`Deal ${dealNumber} has no Roamer contact attached in HubSpot.`);
  console.log(
    `gathered ${context.items.length} items (${JSON.stringify(context.counts)}, omitted ${context.omitted}, clipped ${context.clipped}, missing ${context.missing}) in ${Date.now() - started} ms`,
  );

  const result = await writeBrief({ anthropic: new Anthropic(), context });
  console.log(`model done in ${Date.now() - started} ms, usage ${JSON.stringify(result.usage)}`);
  if (!result.ok) return console.log(`No brief: ${result.reason}`);
  console.log(`\n${renderBrief({ dealNumber, context, brief: result.brief })}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
