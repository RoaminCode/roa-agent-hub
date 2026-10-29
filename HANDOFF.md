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
- 2026-10-28 read-only review of `hs-ls-integration`: no endpoint the hub can safely call exists. The deal lookups (`diagnose-deal`, `deal-report`) live inside `adminTools`, which needs a dashboard operator sign-in and also performs writes. All 10 services allow `allUsers` and check callers in code. Deploy bundles contain real Roamer data. No repair order lookup is deployed. A handoff (`handoff-from-agent-hub.md`, in a Gmail draft to Blake) asks the integration project to clean the bundles, report on how each function is protected, and build a read-only `rjbDealLookup` callable only by `basecamp-router`.
- HubSpot private app "Basecamp" is live and verified: every read works, including call transcripts (2,723 calls have them). Token in Secret Manager as `hubspot-access-token`.
- Aloware send is proven end to end: approved text, Aloware API, phone, and automatic HubSpot log. Sends go out as the company (`user_id: -1`), verified (see Aloware sending).

## Next steps

1. **Map Aloware lines per Experience Center** (which line Basecamp sends from for each role) before building sends.
2. **Integration project, on the other computer:** run the handoff. Bring back the `rjbDealLookup` URL, request format, a scrubbed sample response, and the repair order findings.
3. **Blake decides:** Utah GM name; the Service Advisor's contact window for a new Future Roamer (business days); what signals the trailer has arrived; whether deal spaces with real Team Members end shadow mode for Utah.
4. **Workspace admin:** the one-time approval that lets Basecamp create Chat spaces, and make Basecamp visible to the Utah team. Confirm the exact steps first.
5. Build Slice 1 at Utah, in shadow mode: "@Basecamp open a space for [deal#]", the Wow and Utility summary from HubSpot communications, and the Service Advisor contact check with a draft. The first test is whether the summaries are WOW or generic. HubSpot access is ready, so this can start now.
6. Prove the agent against the real questions Team Members ask in the pilot spaces, in shadow mode, before it answers in them.
7. Only after that: the HubSpot Delivery object change list (stages, lean fields, relabel `assigned_service_writer` to Service Advisor, retire old fields) for Blake's approval. Nothing changes in HubSpot until approved.

## Setting up on another computer

- Clone: `git clone https://RoaminCode@github.com/RoaminCode/roa-agent-hub.git` into `C:\Users\Support\Documents\Claude\Projects\roa-agent-hub`, then `npm install`.
- Set the commit identity for this repo (it is not cloned with the code): `git config user.name "RoaminCode"` and `git config user.email "258948938+RoaminCode@users.noreply.github.com"`.
- Git must be signed in to GitHub as RoaminCode, not the personal account. Keep `RoaminCode@` in the remote URL so Git Credential Manager picks the right account.
- gcloud must be installed and signed in as blake@rvsofamerica.com. Find its path with `where gcloud`; it may not be on PATH in an already-open shell.
- In Claude Code's `!` prompt (Git Bash), use forward slashes in Windows paths: `C:/Users/Support/Documents/Claude/Projects/roa-agent-hub`.
- PowerShell 5.1 breaks commit messages that contain double quotes when passed with `-m`. Write the message to a file and use `git commit -F <file>`.

## Current decisions

**Build order**
- Deal spaces and deal watches come first, at Utah only. They give value without AI. A LightSpeed lookup bot alone is not worth a Team Member's time, since they already work in LightSpeed; the value is the communication and follow-through LightSpeed does not hold.
- The agent answers questions in deal spaces only after its answers are proven in shadow mode, using the real questions from the pilot spaces as the test set.
- Slice 1 runs on HubSpot alone. Most of the journey reads HubSpot communications, not LightSpeed. LightSpeed (`rjbDealLookup`) is needed for pinned deal facts, the mod check, and PDI.
- The rest of the journey reuses six building blocks: read and summarize, nudge with a draft, watch for the action, route a question, answer from what is known, write to HubSpot.
- The delivery clock and HubSpot structure changes wait until the agent is proven. HubSpot structure changes come after confirming what data the agent can reach, so fields are designed once.

**Architecture**
- One Chat app, Basecamp, routing to several agents (RJB first; later Kevin, Training, ROA Knowledge). One Anthropic API key; each agent is a Managed Agent config referenced by ID.
- Managed Agents is the primary approach. If the beta changes, fall back to calling the Messages API directly; only the hub's Anthropic-facing code changes.
- Code-only work (dates, deadlines, trimming, watches, reminders) uses no AI tokens. The agent is called only for language.
- Agents read LightSpeed facts live by deal number and store (not from HubSpot copies), through a dedicated read-only integration function (`rjbDealLookup`), never through `adminTools`. The HubSpot sync drives triggers; HubSpot holds communications, transcripts, notes, and the Delivery record. Basecamp keeps its own clock (commitments, reminders, watch state) in a small database in the hub.
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
- Spaces open on demand, not at deposit: anyone on the deal says "@Basecamp open a space for [deal#]". Many deposits are scheduled months out, and auto-opening would leave quiet spaces open for months. Basecamp checks the deal exists, is not finalized, and has no open space. Store defaults to Utah for the pilot; past Utah the command takes a store ("51xxx UT").
- Spaces opened by Team Members (not Blake) are the adoption signal. Auto-opening when the trailer arrives is a later decision, made from the on-demand numbers.
- A space is deleted 48 hours after Finalized or Lost Deal. HubSpot is the archive.
- Members: Sales Coach and Service Advisor as primary, Parts in the space but engaged by @mention, GM as watcher. Delivery Coach joins when assigned (no later than 7 business days before projected delivery). Business days are Monday to Friday.
- Deal facts from LightSpeed are pinned at the top. Basecamp writes requests and answers to HubSpot as notes (not every message), on the HubSpot Deal until the Delivery object exists.- Deal watches run on every Utah deal with no space, code only: Service Advisor contact with the Future Roamer within the contact window after deposit, and the Sales Coach's update to the Roamer after the trailer arrives.
- Completion is detected, never reported. Basecamp looks for the work in HubSpot (calls, transcripts, SMS, and email all log there) or in what people say in the space. No "reply done". When everything is on track Basecamp stays quiet; when something is missing it posts in the deal space, where the team sees it, worded as a teammate's heads-up with a draft, never a callout. Deals with no space get the nudge as a direct message. In the pilot these go to Blake, labeled with who they would have gone to.
- Reminders: one reminder before a commitment a person made ("call Bob at 2"), inside business hours, and no further follow-ups. Keeping commitments, or speaking up before they are due, is the ROA communication standard.
- When the Service Advisor cannot keep a commitment to a Future Roamer, Basecamp hands it to the Sales Coach, who owns the relationship. This is a handoff, not escalation. If the Sales Coach cannot either, Basecamp gives the Service Advisor a draft to reschedule.
- Sends: Basecamp drafts; on a Team Member's approval of that exact draft it sends through Aloware's API, and Aloware logs the text to the HubSpot contact. Basecamp's own log records who approved each text, and its HubSpot note says "Sent by Basecamp, approved by [name]". The approval shows the recipient's name and number and the exact text, covers only that draft, and is logged.
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

**Deal Knowledge**
- Answers and explicit notes are saved as attributed, timestamped notes on the Delivery record. Facts are reused; status notes expire after 48 hours. Commitments ("tomorrow") get a check at that time.
- Mods from a call: Basecamp writes the list as a note labeled "From the call, not yet matched to the deal". When mods appear on the deal it compares them; a match updates the label, a mismatch asks the Service Advisor and corrects the note. If nothing appears after a reasonable window, it asks.
- No HubSpot tasks. Team Members do not use them; accountability lives in deal space notifications.

**HubSpot access (private app for the hub)**
- Read: `crm.objects.contacts.read`, `crm.objects.deals.read`, `crm.objects.owners.read`, `crm.objects.custom.read` (Delivery, LS Deals, Repair Orders, Units), `crm.schemas.deals.read`, `crm.schemas.custom.read`, `sales-email-read` (one-to-one email bodies), and the call transcript read scope if listed separately.
- Write, for notes only: notes are engagements, which HubSpot gates behind `crm.objects.contacts.write` (and possibly `crm.objects.deals.write` and `crm.objects.custom.write` to attach a note to a deal or Delivery). HubSpot cannot narrow these to notes, so the no-field-edits rule is enforced in hub code: the only write call is note creation, and a test fails if any other write appears.
- Granted 2026-10-28 and verified: the read scopes above plus `crm.extensions_calling_transcripts.read`, `conversations.read`, `conversations.custom_channels.read`; writes `crm.objects.contacts.write`, `crm.objects.deals.write`, `crm.objects.custom.write`. Token in Secret Manager as `hubspot-access-token`, readable only by `basecamp-router` (rotated once; version 1 destroyed).
- Do not grant conversations write scopes. Posting a message to an Aloware SMS thread through the HubSpot conversations API only stores it; it is never delivered, and it leaves a false "sent" record (tested 2026-10-28). Texts sent from HubSpot are actually sent by Aloware's app, which then writes the copy into HubSpot.

**Aloware sending (verified 2026-10-28)**
- `POST https://app.aloware.io/api/v1/webhook/sms-gateway/send` with `Authorization: Bearer <token>` and JSON `line_id`, `to`, `message` (160 characters max). Returns 202 `{"message":"Message sent."}`. Delivered to the phone within seconds and logged to the HubSpot contact automatically ("Creator Type: API").
- `user_id` sets who the text is sent as: a user ID sends as that user; 0 or omitted sends as the contact's Aloware owner (or the company if none); -1 sends as the company. An unknown ID returns 422. The first test omitted it and was credited to the contact's Aloware owner, a different Team Member.
- Every approved send uses `user_id: -1` (company). Verified 2026-10-28: delivered, and HubSpot logs it with a blank sender, no owner, "Creator Type: API". The code refuses any other `user_id`. The Roamer sees the same line and text either way; a blank company sender on an API text means Basecamp.
- Basecamp writes a HubSpot note for each send ("Sent by Basecamp, approved by [name]") and keeps its own log (line, recipient, time, approver, draft). The API returns no message ID (`fields` is ignored), so sends are matched by line, recipient, and time.
- Per Team Member text counts are not a requirement, so company sends losing Team Member credit is accepted.
- Aloware contact owners can differ from HubSpot owners (Blake's own contact did); worth checking separately.
- The token opens the whole Aloware account (API, MCP, Form Connect). The hub exposes exactly one Aloware call, the approved send, and a test fails if any other appears. Secret `aloware-api-token`, readable only by `basecamp-router`.
- Known lines: ROA Tech Support (63273), UT Main Line (67440). Map the line each Experience Center sends from before building sends.
- Not granted: anything for workflows, marketing, files, settings, or users. After the token exists, run each call once; a 403 names the missing scope.
- SMS is Aloware. All communications (any department, any sending or receiving number) are on the contact, not necessarily on the deal or LS Deal object, so Basecamp reads communications from the contact. The to and from numbers on each message show which inbox sent it.
- Calls carry `hs_call_has_transcript` and `hs_call_transcription_id`; transcript text comes from a separate API. `hs_call_summary` and `hs_ai_summary` are on the call itself.

**Clock (business days before projected delivery)**
- At deposit welcome and profile draft; weekly update in the shop; 7 Delivery Coach assigned; 5 walkthrough video; 4 brief posted; 3 Delivery Coach intro; 1 date and time confirmed plus showroom check; delivery day walkthrough with no extra message.

**Shadow mode success metrics**
- Answered from data (rising), wrong answers (zero), routed answer time (improving), commitments missed without notice (falling), cost per deal (at or under estimate).
- Adoption: spaces Team Members open themselves, and how often a nudge is followed by the work showing up in HubSpot. Accuracy without use is not success.

## Open questions

- Escalation wording and recipient (likely the GM), to design before rollout.
- Mods payment standing rule (team decision in the deal space for now).
- Parts quantity field meanings.
- Whether Google Calendar out-of-office is readable for vacation routing.
- Utah GM name; the Service Advisor contact window (business days); the trailer arrival signal (LightSpeed field, HubSpot stage, or a person).
- Whether deal spaces with real Team Members end shadow mode for Utah, and the exact wording of nudges (helping, never reprimanding).
- False nudges: work done off HubSpot (personal cell, in person on the lot) looks missing. A note in the space counts; early false nudges cost trust, so watch for them.
- How wrong answers get caught in shadow mode: a set review of agent answers against LightSpeed, not noticing by chance.
- Noise: Parts and the GM sit in every open space. Keep Parts to @mentions and the GM to watching; watch for muting.

## Later ideas

- Texting a Roamer on Sales Coach confirmation, via a HubSpot workflow using Aloware's integration. Not in this build.

## Retired, do not use

(Nothing yet.)
