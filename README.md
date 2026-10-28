# ROA Agent Hub

The router, tools and rules behind Basecamp, ROA's agents in Google Chat. Agents' instructions live in Anthropic Managed Agents; everything they can see and do runs through this hub.

Google Cloud project: `roa-agent-hub`. Design spec: RJB Agent Spec (Claude Docs).

## Layout

- `src/lightspeed/rjbView.js`: trims a LightSpeed deal lookup to the compact RJB view the agent reads.
- `test/`: tests, run with `npm test`. Fixtures are scrubbed; real Roamer data never goes in this repo.
- `scripts/show-rjb-view.js`: prints the RJB view of a saved lookup.
