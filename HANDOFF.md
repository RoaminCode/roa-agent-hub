# Handoff

Last updated: 2026-10-27

## Where things stand

- Spec is complete enough to build from: "RJB Agent Spec" (link in `CLAUDE.md`).
- Google Cloud project `roa-agent-hub` exists, billing linked, APIs enabled (Chat, Cloud Run, Cloud Build, Artifact Registry, Secret Manager), router service account `basecamp-router` created with no other access.
- This repo holds the LightSpeed trim function (`src/lightspeed/rjbView.js`) with 8 passing tests on a scrubbed fixture. It shrinks a deal lookup from about 20,800 tokens to about 940.
- Chat app not configured yet. Nothing deployed yet.

## Next steps (Slice 0)

1. Blake adds the Anthropic API key to Secret Manager in `roa-agent-hub` as `anthropic-api-key` (Blake does this, so the key never appears in a session). Then grant `basecamp-router` read access to it.
2. Build and deploy a minimal router to Cloud Run that receives Chat messages and replies "Basecamp is listening", with no AI yet.
3. Configure the Google Chat app (name: Basecamp) with the router's address, visible only to Blake.
4. Draft the HubSpot Delivery object change list (stages, lean fields, relabel, retire) for Blake's approval. Nothing changes in HubSpot until approved.
5. From Blake's desktop: the integration endpoint details for the deal lookup, and whether a repair order lookup with per-job completion exists. Then grant `basecamp-router` read-only access to only those endpoints.

## Current decisions

**Architecture**
- One Chat app, Basecamp, routing to several agents (RJB first; later Kevin, Training, ROA Knowledge). One Anthropic API key; each agent is a Managed Agent config referenced by ID.
- Managed Agents is the primary approach. If the beta changes, fall back to calling the Messages API directly; only the hub's Anthropic-facing code changes.
- Code-only work (dates, deadlines, trimming, task closing) uses no AI tokens. The agent is called only for language.
- Agents read LightSpeed facts live from the integration endpoint by deal number and store (not from HubSpot copies). HubSpot sync drives triggers; HubSpot holds transcripts, notes, HubSpot tasks, and the Delivery record.
- Trim lives as a function; deploy location (integration `?view=rjb` or hub) is Blake's call.

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
