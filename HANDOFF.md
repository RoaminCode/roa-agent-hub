# Handoff

Last updated: 2026-10-28

## Where things stand

- Spec is complete enough to build from: "RJB Agent Spec" (link in `CLAUDE.md`).
- Google Cloud project `roa-agent-hub` is set up: billing linked, APIs enabled (Chat, Cloud Run, Cloud Build, Artifact Registry, Secret Manager).
- The Anthropic API key is in Secret Manager as `anthropic-api-key` (format checked, value never displayed). Only `basecamp-router` can read it, granted on that one secret.
- The minimal router is live on Cloud Run as service `basecamp` in `us-central1`, running as `basecamp-router`, max 2 instances: https://basecamp-732941376364.us-central1.run.app
  - Verifies every request came from Google Chat, allows only `ALLOWED_USERS` (Blake), replies "Basecamp is listening". No AI yet. Message text is never logged.
  - `GET /health` for health checks, `GET /avatar.png` serves the Basecamp avatar.
  - Env vars: `CHAT_AUDIENCE` (endpoint URL), `ALLOWED_USERS`, `PROJECT_NUMBER` (732941376364).
- The Chat app "Basecamp" is configured (visible only to Blake, compass avatar) and tested end to end: Blake messages it in Google Chat and gets a reply.
- 21 tests pass (`npm test`): LightSpeed trim, router, request verification.

## Next steps

1. Draft the HubSpot Delivery object change list (stages, lean fields, relabel `assigned_service_writer` to Service Advisor, retire old fields) for Blake's approval. Nothing changes in HubSpot until approved.
2. From Blake's desktop: the integration endpoint details for the deal lookup, and whether a repair order lookup with per-job completion exists (the integration project has functions for repair order parts and labor breakdown reporting; Utah only so far). Then grant `basecamp-router` read-only access to only those endpoints.
3. Connect the RJB agent: Managed Agent config, router reads `anthropic-api-key` from Secret Manager, first read-only answers about a deal (Slice 2).

## Setting up on another computer

- Clone: `git clone https://RoaminCode@github.com/RoaminCode/roa-agent-hub.git` into `C:\Dev\roa-agent-hub`, then `npm install`.
- Set the commit identity for this repo (it is not cloned with the code): `git config user.name "RoaminCode"` and `git config user.email "258948938+RoaminCode@users.noreply.github.com"`.
- Git must be signed in to GitHub as RoaminCode, not the personal account. Keep `RoaminCode@` in the remote URL so Git Credential Manager picks the right account.
- gcloud must be installed and signed in as blake@rvsofamerica.com. Find its path with `where gcloud`; it may not be on PATH in an already-open shell.
- In Claude Code's `!` prompt (Git Bash), use forward slashes in Windows paths: `C:/Dev/roa-agent-hub`.
- PowerShell 5.1 breaks commit messages that contain double quotes when passed with `-m`. Write the message to a file and use `git commit -F <file>`.

## Current decisions

**Architecture**
- One Chat app, Basecamp, routing to several agents (RJB first; later Kevin, Training, ROA Knowledge). One Anthropic API key; each agent is a Managed Agent config referenced by ID.
- Managed Agents is the primary approach. If the beta changes, fall back to calling the Messages API directly; only the hub's Anthropic-facing code changes.
- Code-only work (dates, deadlines, trimming, closing HubSpot tasks) uses no AI tokens. The agent is called only for language.
- Agents read LightSpeed facts live from the integration endpoint by deal number and store (not from HubSpot copies). The HubSpot sync drives triggers; HubSpot holds transcripts, notes, HubSpot tasks, and the Delivery record.
- The trim function's deploy location (integration `?view=rjb` or the hub) is Blake's call.
- The hub runs in `us-central1`, the same region as the `hs-ls-integration` functions.

**Google Chat specifics**
- The Basecamp Chat app is configured as a Google Workspace add-on. Events arrive in the add-on format (`{ chat: { messagePayload, ... } }`) and are signed by `service-732941376364@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`. Replies must use the add-on response shape (`hostAppDataAction`). The router also accepts the classic format.
- Cloud Run swallows paths ending in "z" (like `/healthz`); use `/health`.
- The Chat console rejects URLs with a leading space without saying so.

**Models and cost**
- Sonnet 5.5 for the RJB agent's everyday work; Opus 5.5 for the Roamer profile and Delivery Coach brief; Haiku for narrow mechanical jobs. Compare Haiku vs Sonnet on real questions during shadow weeks.
- Estimate about $2.00 per deal, about $160/month at 80 deals; budget double until measured.

**Deal spaces and routing**
- A space opens when a Deal enters Deals (deposit received) and is deleted 48 hours after Finalized or Lost Deal. HubSpot is the archive.
- Members: Sales Coach, Service Advisor (at open), Delivery Coach (assigned no later than 7 business days before projected delivery). Business days are Monday to Friday.
- The Sales Coach owns the deal and the Roamer relationship until delivery, including date changes in LightSpeed and telling the Roamer.
- People outside the space get a direct message card (Answer / Not mine), one thread per question.
- Role fallback: role at that Experience Center, then Service Advisor, then GM.

| Experience Center | Service Advisor | Parts questions |
| --- | --- | --- |
| Utah | Coby Shell | Kevin Willingham |
| Colorado | Justin Price | Justin Price |
| South Carolina | Vaughn Owens | Christina Ryan |
| Arizona | Mike Nicholson | Mike Nicholson |

**Data and dates**
- `projected_delivery_date` drives everything before delivery; `ls_delivery_date` marks the trailer leaving the lot and closes the record at Finalized.
- Mods come from LightSpeed labor lines: Dealer Add, Customer Add, and "(Charge sales)" Prep lines (included at no charge). Prep lines are the PDI and its findings. Install status is per repair order only in the deal feed.
- Parts quantity fields (Requested vs Qty, I vs S) are not understood yet; parts questions go to people.

**Deal Knowledge and HubSpot tasks**
- Answers and explicit notes are saved as attributed, timestamped notes on the Delivery record. Facts are reused; status notes expire after 48 hours. Commitments ("tomorrow") get a check at that time.
- HubSpot tasks only when something is genuinely outstanding; quick Chat answers become notes. See the HubSpot task rule in `CLAUDE.md`.

**Clock (business days before projected delivery)**
- At deposit welcome and profile draft; weekly update in the shop; 7 Delivery Coach assigned; 5 walkthrough video; 4 brief posted; 3 Delivery Coach intro; 1 date and time confirmed plus showroom check; delivery day walkthrough with no extra message.

**Shadow mode success metrics**
- Answered from data (rising), wrong answers (zero), routed answer time (improving), agent HubSpot tasks left open (zero), cost per deal (at or under estimate).

## Open questions

- Escalation wording and recipient (likely the GM), to design before rollout.
- Mods payment standing rule (team decision in the deal space for now).
- Parts quantity field meanings.
- Whether Google Calendar out-of-office is readable for vacation routing.

## Later ideas

- Texting a Roamer on Sales Coach confirmation, via a HubSpot workflow using Aloware's integration. Not in this build.

## Retired, do not use

(Nothing yet.)
