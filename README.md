# ROA Agent Hub

The hub behind Basecamp, ROA's Google Chat app: the router that receives Chat events, the tools that read HubSpot (and later LightSpeed), the rules that limit what agents can do, and the logs. Basecamp runs on Cloud Run as service `basecamp` in Google Cloud project `roa-agent-hub`.

Start with `HANDOFF.md` for what is live, what is decided, and what is next. `CLAUDE.md` holds the project rules. Design spec: RJB Agent Spec (Claude Docs).

## What Basecamp does today

- **Roamer brief.** `brief <deal#>` in Chat, or the Brief button on Home, reads every call, text, email, and note on the deal's Roamer in HubSpot and posts a brief card (WOW, MODS, JOURNEY) written by Claude Opus 5.5.
- **App Home.** The Home tab lists open Utah deals as tiles: delivery, last contact and who made it, the Sales Coach, and a Brief button.
- Read-only against HubSpot. Nothing is sent to a Roamer; sending is not built.

## Layout

- `src/server.js`: HTTP entry point; wires HubSpot, Anthropic, and Chat together from environment and Secret Manager values.
- `src/router.js`: verifies the request came from Google Chat, checks the user is allowed, and routes messages, Home, and button taps.
- `src/chat/`: Chat plumbing. `verify.js` (request signatures), `events.js` (event parsing and response shapes), `send.js` (posting messages as the app), `briefCard.js` and `homeCard.js` (the cards).
- `src/hubspot/`: `client.js` (read-only by construction: GET, plus POST only to search and batch read), `dealContext.js` (one deal's Roamer and communications for a brief), `openDeals.js` (open deals and last contact for Home).
- `src/agents/roamerBrief.js`: the brief's prompt, output schema, and model call.
- `src/briefJob.js`: runs a brief in the background and posts the result.
- `src/lightspeed/rjbView.js`: trims a LightSpeed deal lookup to the compact view the agent will read (not wired in yet; waits on the integration's `rjbDealLookup`).
- `scripts/brief.js`: prints a brief for one deal to the terminal. Reads real Roamer data; never save its output in the repo.
- `scripts/show-rjb-view.js`: prints the RJB view of a saved lookup.
- `test/`: run with `npm test`. Fixtures are scrubbed; real Roamer data never goes in this repo.
- `assets/`: Basecamp's avatar (`avatar-256.png` is the one served).

## Run and deploy

- Node.js 24. `npm install`, then `npm test`.
- Deploy: `gcloud run deploy basecamp --source . --region us-central1 --project roa-agent-hub` (keeps existing settings, env vars, and secrets).
