# ROA Agent Hub

Basecamp is ROA's Google Chat app. This repo is the hub behind it: the router that receives Chat messages and picks an agent, the tools that read LightSpeed and HubSpot, the rules that limit what agents can do, the schedules, and the logs. Agent instructions live in Anthropic Managed Agents; everything they can see and do runs through this hub. The first agent is the RJB (Roamer Journey Brief) agent.

## Session start and wrap

- **At the start of every session, read `HANDOFF.md` before doing anything else.** It holds the current state, current decisions, and next steps. Treat it as the source of truth over anything recalled from earlier sessions.
- **At session wrap, when asked, update `HANDOFF.md`:**
  - Update "Where things stand" and "Next steps" to match what actually happened this session.
  - Add new decisions to "Current decisions".
  - When a decision is replaced, **delete the old one**. Do not leave it with a pointer to the new one ("see below", "replaced by"). If deleting would lose context someone still needs, move it under "Retired, do not use" instead. Nothing under that heading is ever acted on.
  - Keep it short. It is a snapshot of now, not a history; git holds the history.

## Project facts

- GitHub: `RoaminCode/roa-agent-hub` (private). All ROA code lives under the ROA GitHub account `RoaminCode`, never Blake's personal account. Commits use `RoaminCode <258948938+RoaminCode@users.noreply.github.com>`.
- Google Cloud project: `roa-agent-hub` (router service account `basecamp-router@roa-agent-hub.iam.gserviceaccount.com`).
- The production LightSpeed/HubSpot sync lives in a separate project, `hs-ls-integration`. Never deploy to or change it from this repo. The hub only ever gets read-only access to specific endpoints there.
- gcloud may not be on PATH in an already-open shell. On the laptop it is at `C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`; on other machines find it with `where gcloud`.
- Basecamp runs on Cloud Run as service `basecamp` in `us-central1`. Deploy with `gcloud run deploy basecamp --source . --region us-central1 --project roa-agent-hub` (existing settings and env vars are kept).
- Node.js 24. Run tests with `npm test`.
- Design spec: "RJB Agent Spec" in Claude Docs, https://claude.ai/artifact/BuBh95ZHEVuLrFXrnSXht9

## Rules

- **No real Roamer data in this repo.** Raw LightSpeed exports stay in `G:\My Drive\Service Management\RJB`. Test fixtures must be scrubbed (fake name, VIN, customer and deal numbers).
- **LightSpeed is the source of truth for deal facts.** Agents never edit HubSpot fields or LightSpeed. They write only HubSpot notes.
- **Podium is fully retired.** Never mention it, suggest it, or read from it. HubSpot is the source of truth for Roamer communication. HubSpot is the record of all communication; Aloware is integrated into HubSpot and logs every text there. The hub may call Aloware for exactly one thing, sending a message a Team Member approved (authorized by Blake 2026-10-28; not built yet), always as the company (`user_id: -1`), never as the default contact owner or another user, with a HubSpot note naming who approved it. Anything else in Aloware only when Blake explicitly says so.
- **Say "Service Advisor", never "Service Writer"**, even where older HubSpot properties or skills still say Writer.
- **Say "HubSpot task", never just "task",** when meaning a HubSpot task. The agent's own background work is a "run".
- **No HubSpot tasks** unless Blake decides otherwise. Basecamp keeps its own clock; accountability lives in deal space notifications.
- **Nothing reaches a Roamer or Future Roamer without a Team Member's approval of that exact message.** Agents draft. The approval shows the recipient's name and number and the exact text, covers only that one draft, and is logged. Approved messages go through Aloware's API, which logs them to HubSpot. No send code exists yet; ad hoc test sends are never a substitute for it. Agents never send on their own.
- **Shadow mode until Blake says otherwise:** every routed question, nudge, and draft goes to Blake, labeled with who it would have gone to, and nothing is sent to a Roamer.
- **Prove before trusting the agent.** Deal spaces and deal watches may be built before the agent answers questions; they work without AI. The agent answers questions in deal spaces only after its answers are proven correct against LightSpeed in shadow mode. Do not build the delivery clock or HubSpot structure changes until then. Push back if asked to skip ahead.
- **Basecamp helps Team Members; it does not reprimand them.** Escalation wording is deliberately undefined until designed with Blake. Follow-ups are logged for coaching.
- ROA language applies in all code comments, messages, and docs: Roamers, Future Roamers, Team Members, Sales Coach, Experience Center, Leader. No em or en dashes.
