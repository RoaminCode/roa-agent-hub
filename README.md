# ROA Agent Hub

The hub behind Basecamp, ROA's Google Chat app for Team Members: the router that receives Chat events, the tools that read HubSpot (and later LightSpeed), the rules that limit what agents can do, the schedules, and the logs. Basecamp runs on Cloud Run as service `basecamp` in Google Cloud project `roa-agent-hub`.

Start with `HANDOFF.md` for what is live, what is decided, and what is next. `CLAUDE.md` holds the project rules. `docs/reference/` holds the stable detail for each area. Design spec: RJB Agent Spec (Claude Docs).

## What Basecamp does

- **App Home:** open Utah deals as tiles (delivery, last contact and who made it, Sales Coach), each with a Brief button and its deal space.
- **Roamer brief:** `brief <deal#>` or the Brief button reads every call, text, email, and note on the deal's Roamer in HubSpot and posts a brief card. Saved as one HubSpot note, reused when nothing changed, updated from only the new items when something did.
- **Deal spaces:** a Chat space per open deal with the brief as its first post; opening one finds or creates the deal's Delivery record in HubSpot.
- **Notes:** `/note`, `note <deal#> ...` in a direct message, and Save to HubSpot on any message.
- **Questions:** `/ask` works out which role owns the answer and, in shadow mode, sends it to Blake with a suggested answer from earlier answers or the brief.
- **Commitment follow-ups:** when an answer to a routed question promises something later, Basecamp checks at the due time whether it was kept (a newer answer, the deal space, HubSpot) and, if not, sends one check-in, to Blake in shadow mode.
- **`/new`, `/wow`, `/remind`:** what is new on a deal, WOW ideas tailored from the brief, and a reminder sent at the time asked.
- **`/text`:** drafts a text to the Roamer. Nothing is sent until a text approver reviews the exact words in a dialog and approves; the send goes through Aloware as the company and is logged.
- **`facts <deal#>` and `ro <number>`:** in a direct message, the deal or one repair order as LightSpeed has it right now (state, trailer, mods, PDI, tech time), read live with no AI.
- **`cost`:** in a direct message, what the AI has cost over the last 7 days.

What Basecamp can write: HubSpot notes (on the Roamer and the Delivery record, never the deal), a deal's Delivery record, an approved text through Aloware, rows and counts in the ROA WOW Ideas sheet, Chat spaces and messages, and its own Firestore records. It never edits HubSpot fields or LightSpeed.

## Layout

- `src/server.js`: HTTP entry point; wires everything from environment and Secret Manager values. The environment variables are listed at the top of the file.
- `src/router.js`: verifies the request came from Google Chat, checks permissions, and routes messages, Home, and button taps.
- `src/*Job.js`, `src/spaceNotes.js`: one file per feature (brief, space, ask, text, wow, new, remind, commit, facts, notes). `src/workHours.js` is business hours in Utah.
- `src/agents/`: the prompts and schemas. `models.js` holds every model id and price; `run.js` is the shared model call that prices and counts each one.
- `src/spend.js`: the AI spend records, the daily limit, and the `cost` report.
- `src/chat/`: Chat plumbing (request verification, event parsing, sending, spaces, cards).
- `src/hubspot/`: the HubSpot client (reads, plus four narrow write methods guarded by tests) and what is read through it.
- `src/aloware.js`: the one Aloware call, an approved send.
- `src/db.js`: Basecamp's own records in Firestore.
- `src/lightspeed/`: `lookup.js` calls the integration project's read-only `rjbDealLookup` (the hub holds no LightSpeed credential); `rjbView.js` trims the answer to the view agents and the facts card read. `src/factsJob.js` is `facts <deal#>`.
- `scripts/brief.js` and `.claude/skills/brief/`: the brief written by hand in Claude Code, with no API credits. Reads real Roamer data; never save its output in the repo.
- `test/`: `npm test`. Everything runs on fakes; fixtures are scrubbed.

## Run and deploy

- Node.js 24. `npm install`, then `npm test`.
- `npm run check` loads the server and runs the tests. `npm run deploy` does that, then deploys: `gcloud run deploy basecamp --source . --region us-central1 --project roa-agent-hub` (keeps existing settings, env vars, and secrets). GitHub runs the tests on every push (`.github/workflows/test.yml`).
