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
- gcloud on this machine: `C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd` (may not be on PATH in a fresh shell).
- Node.js 24. Run tests with `npm test`.
- Design spec: "RJB Agent Spec" in Claude Docs, https://claude.ai/artifact/BuBh95ZHEVuLrFXrnSXht9

## Rules

- **No real Roamer data in this repo.** Raw LightSpeed exports stay in `G:\My Drive\Service Management\RJB`. Test fixtures must be scrubbed (fake name, VIN, customer and deal numbers).
- **LightSpeed is the source of truth for deal facts.** Agents never edit HubSpot fields or LightSpeed. They write only HubSpot notes and HubSpot tasks.
- **Podium is fully retired.** Never mention it, suggest it, or read from it. HubSpot is the source of truth for Roamer communication. Aloware is touched only when Blake explicitly says so.
- **Say "Service Advisor", never "Service Writer"**, even where older HubSpot properties or skills still say Writer.
- **Say "HubSpot task", never just "task",** when meaning a HubSpot task. The agent's own background work is a "run".
- **Every HubSpot task an agent opens, the agent closes.** Due within 3 business days at most, one per question, at most 3 open per deal, every one tagged "Created by RJB Agent", all auto-closed when the deal reaches Finalized or Lost Deal.
- **Nothing is ever sent to a Roamer or Future Roamer by an agent.** Agents draft; people send.
- **Shadow mode until Blake says otherwise:** every routed question, direct message, and HubSpot task goes to Blake, labeled with who it would have gone to.
- **Basecamp helps Team Members; it does not reprimand them.** Escalation wording is deliberately undefined until designed with Blake. Follow-ups are logged for coaching.
- ROA language applies in all code comments, messages, and docs: Roamers, Future Roamers, Team Members, Sales Coach, Experience Center, Leader. No em or en dashes.
