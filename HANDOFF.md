# Handoff

Last updated: 2026-11-11

## Read first: AI credits and permissions

Blake was given $10 of Anthropic API credits for Shane's test of the Roamer brief (2026-11-06); the balance has not been checked since. Blake does not want paid audit runs (2026-11-08).

1. **Never put `ANTHROPIC_API_KEY` on a laptop** (no `.env`, no shell variable): Claude Code would bill that key instead of the subscription. The key lives only in Secret Manager. `npm test` uses fakes and never spends.
2. **Three permissions, three lists, each fails closed (unset means nobody):**
   - `AI_USERS`: who may spend AI credits (briefs, `/ask`, `/wow`, `/new`, `/remind`, a `/text` draft, opening a space). `BRIEF_USERS`, its earlier name, is read when `AI_USERS` is unset.
   - `TEXT_APPROVERS`: who may approve and send a text to a Roamer. Being on `AI_USERS` does not grant it.
   - `ALLOWED_USERS`: who may use Basecamp at all (Home, `/note`, Save to HubSpot, Request access).
3. **`AI_PAUSED=true` stops every AI job** without a deploy (`BRIEFS_PAUSED` is its earlier name). Text approvals, Home, and notes stay on.
4. **`AI_DAILY_LIMIT_USD`** stops AI jobs for the rest of the day (Utah time) once the day's spend reaches it, and tells Blake once. Unset means no limit.
5. **`cost` in a direct message with Basecamp** shows the last 7 days of AI spend by job and by day (AI users only, no AI call).
6. **`/brief` in Claude Code** writes a brief by hand from the same record and prompt, on Blake's subscription, with no API credits.

**To start Shane's test (after his approval of texts):** add shane@rvsofamerica.com to `ALLOWED_USERS` and `AI_USERS` (through a gcloud `--flags-file`), and to `TEXT_APPROVERS` only if he should approve texts. Make the Basecamp Chat app visible to him and make sure `AI_PAUSED` is unset. Send him, once shared from each page's Share menu: the how-to page https://claude.ai/artifact/7jEBvFNbBiz6VFE9Bij5wt and the walkthrough film https://claude.ai/artifact/NrZoze1b6SrR5o9AcMUnNC (the film has no `/remind` step).

## Where things stand

- **Live:** Cloud Run service `basecamp`, `us-central1`, revision `basecamp-00074-jgf` (2026-11-11, a settings change; the code is the image built 2026-11-08 from commit `8d77006`), https://basecamp-732941376364.us-central1.run.app. Service account `basecamp-router`, max 2 instances, CPU always allocated. Shadow mode for everything except approved texts, which are on but in test mode (`TEXT_TEST_TO`, Blake's phone, set in Cloud Run only) until Shane approves.
- **Built 2026-11-11, not deployed** (tests pass, nothing has run against real services):
  - A note in a direct message now works on a deal Basecamp has never briefed (it goes on the deal's one contact; with several contacts it asks for a brief first).
  - The three permission lists above replace the single `BRIEF_USERS` gate.
  - Every AI call is priced and counted (`src/agents/models.js`, `src/agents/run.js`, `src/spend.js`; Firestore `spend/{day}` and `aiCostUsd` on each deal), with the daily limit and the `cost` command.
  - The six small jobs moved from Haiku 4.5 to Haiku 5.5 at low effort, with room under the token limit for its thinking.
  - Less for the brief to read and write (Blake approved, 2026-11-11): a brief update returns only the parts that changed and code merges them into the saved brief; the saved brief is sent to models as compact JSON; a call is read from one summary, not two; call and text headers, contentless entries, and Aloware's automated replies are left out; an edited item is caught by a hash of its words, not HubSpot's modified date. Measured on the 14 open Utah deals: 17% less record to read (calls 35% less, texts 16% less). Each deal's next brief is a full read, because the record it sees changed.
  - The LightSpeed lookup (built in both projects, neither deployed): `rjbDealLookup` in the integration project, and in the hub `src/lightspeed/lookup.js`, the RJB view updated to the function's real answer, and `facts <deal#>` in a direct message, which shows the deal as LightSpeed has it, with no AI. Detail in `docs/reference/lightspeed.md`.
  - **Before deploying:** `TEXT_APPROVERS=blake@rvsofamerica.com` is set (2026-11-11); set `AI_DAILY_LIMIT_USD` (Blake picks the amount). `BRIEF_USERS` and `BRIEFS_PAUSED` keep working as they are.
  - **After deploying:** re-ask the six routing questions and the `/ask` traps (the 8 Right verdicts were earned on Haiku 4.5), try `/remind` and `/text` once each, run one brief, add a text to that deal and run it again (the first update that returns only what changed; compare it with the saved brief), and check `cost`.
- **Env vars on the service:** `CHAT_AUDIENCE`, `PROJECT_NUMBER` (732941376364), `ALLOWED_USERS`, `BRIEF_USERS`, and `TEXT_APPROVERS` (blake@rvsofamerica.com), `SHADOW_REVIEWER` (blake@rvsofamerica.com), `WOW_SHEET_ID`, `TEXTS_LIVE=true`, `TEXT_TEST_TO`. Secrets: `HUBSPOT_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`, `ALOWARE_API_TOKEN`.
- **Deploy:** `gcloud run deploy basecamp --source . --region us-central1 --project roa-agent-hub` (env vars and secrets are kept). Run `node -e "require('./src/server')"` and `npm test` first. gcloud's default project on the laptop is `hs-ls-integration`; always pass `--project roa-agent-hub`.
- **Tests:** 321 pass (`npm test`). Firestore is faked in `test/fakeFirestore.js`.
- **Chat app "Basecamp":** visible only to Blake, App Home on. Commands: `/note` (1), `/ask` (2), `/wow` (3), Save to HubSpot message action (4), `/text` (5), WOW ideas quick command (6), `/new` (7), `/remind` (8). OAuth scopes waiting on the Workspace admin install: `chat.app.spaces.create`, `chat.app.memberships`, `chat.app.messages.readonly`.
- **What works on the live revision** (detail in `docs/reference/features.md`): briefs with reuse and incremental updates; App Home; deal spaces by "use this space for <deal#>"; Delivery records found or created when a space opens; notes; `/ask` routed to Blake with a suggested answer; `/new`; `/wow`; `/text` in test mode; `/remind` and the 5-minute timer; an email to Blake when a deal has no Roamer contact.
- **Data:** HubSpot is the record (Basecamp writes notes and creates Delivery records, nothing else). Firestore holds Basecamp's own ids, timestamps, statuses, the text send log, pending reminders, and AI spend. The ROA WOW Ideas sheet holds the idea library. LightSpeed is not reachable yet. Call transcript text is not reachable (404); briefs read call summaries.
- **Logs** never hold message text or Roamer details. `GET /health`, `GET /avatar.png`.

## Next steps

1. **Turn the LightSpeed lookup on (Blake, in the `LightSpeed Integration` folder):** run `.deploysetupRjbDealLookup.ps1` once, then `.deploydeployRjbDealLookup.ps1`; run the two checks it prints; set the URL it prints as `RJB_LOOKUP_URL` on the `basecamp` service. After the hub is deployed, type `facts <deal#>` for a few Utah deals and compare each card with LightSpeed. The field names came from the integration's own review of real deals, but no real answer has passed through the new code yet, so the first lookups are the test. This is what opens the "prove against LightSpeed" gate.
2. **Deploy the 2026-11-11 changes** with the before and after steps above.
3. **Workspace admin install** (a super admin): admin.google.com > Apps > Google Workspace Marketplace apps > Apps list > Install app > Basecamp (internal) > Admin install, then Grant access under Data Access. Make Basecamp visible to the Utah team. Then test reading a space's messages: ones from before Basecamp joined, and replies in threads. Whether this happened on 2026-11-09 is not recorded; confirm with Blake.
4. **Build commitment follow-ups** on the reminders timer (rules in `docs/reference/deal-spaces-and-routing.md`). The space check needs `chat.app.messages.readonly` from step 3.
5. **Touchpoint clock:** keep designing how each touchpoint's completion is detected (`docs/reference/clock.md`). Its state belongs in Firestore.
6. **Shane:** share the how-to page and the film, then add him.

Smaller, waiting on real use or on Blake:
- Q&A answers in the space: the bar is 10 Right or Wrong verdicts on real Team Member questions, at most 1 Wrong. 8 so far, all Right, all on Blake's own test questions, so none count yet.
- First live text: a real, low-stakes message with the logs watched; then remove `TEXT_TEST_TO`. Choosing the line from the Roamer's SMS history is next.
- Try the contact picker on the first Utah deal with two contacts.
- When Team Members get access, Home switches from every Utah deal to "My deals".
- The Service Advisor contact check with a draft (rest of Slice 1).
- The Deal's `delivery_date_lightspeed` waits on confirming nothing writes to it.
- In the integration project, still open from its 2026-10-30 review: old build images hold the current Utah, South Carolina, and Colorado Gateway passwords (rotate, then delete the images), and its Part 2 on how each function is protected.
- The rest of the 2026-11-11 audit (findings beyond the ones done today): https://claude.ai/artifact/2FNNEg8byXfTCraFzT7pgR

## Reference, read when the work touches it

Stable detail lives in `docs/reference/`, not here:
- `features.md`: how briefs, cards, `/ask`, `/wow`, `/text`, and `/new` work and how each was verified.
- `deal-spaces-and-routing.md`: deal spaces, deal watches, commitments, `/remind`, handoffs, the role table, Deal Knowledge, shadow mode metrics.
- `clock.md`: the touchpoint clock.
- `app-home.md`: what Home shows and where it comes from.
- `lightspeed.md`: the lookup function, who can call it, what comes back, and how to deploy it.
- `hubspot.md`: scopes, the hub's four write methods, Delivery records, fields and dates.
- `aloware.md`: the send API, the rules the send code follows, the Utah lines.
- `google-chat.md`: add-on event format, App Home responses, card limits, console quirks.

## Current decisions

**Build order**
- Deal spaces and deal watches come first, at Utah only. They give value without AI.
- The agent answers questions in deal spaces only after its answers are proven in shadow mode on real questions from the pilot spaces.
- Slice 1 runs on HubSpot alone. LightSpeed (`rjbDealLookup`) is needed for pinned deal facts, the mod check, and PDI.
- The journey reuses six building blocks: read and summarize, nudge with a draft, watch for the action, route a question, answer from what is known, write to HubSpot.
- HubSpot structure changes wait until the agent is proven. The delivery clock does not wait (Blake, 2026-11-07).

**Architecture**
- One Chat app, Basecamp, routing to several agents (RJB first; later Kevin, Training, ROA Knowledge). One Anthropic API key.
- Every AI job is a direct Messages API call with its instructions in `src/agents/`. Model ids and prices are in `src/agents/models.js`; narrow jobs go through `runStructured` in `src/agents/run.js`, which prices and counts each call.
- Move to Managed Agents when other agents and tools are added (Blake, 2026-11-07). The 2026-11-11 audit argues for the SDK tool runner inside the hub instead, unless an agent needs a hosted sandbox or sessions that run for hours; Blake has not decided.
- Code-only work (dates, deadlines, trimming, watches, reminders) uses no AI tokens. The agent is called only for language.
- Agents read LightSpeed facts live by deal number and store through a dedicated read-only function (`rjbDealLookup`), never through `adminTools`. The hub holds no LightSpeed credential. The allowlist of fields is enforced in the integration project; the hub trims the answer to the RJB view (2026-11-11). Basecamp keeps its own clock in Firestore (`src/db.js`).
- The first agent that decides its own steps will be the one that answers questions in a deal space, with tools the hub defines (look up a deal, read the record, read Q&A notes), once deal facts are proven with `facts` (Blake and Claude, 2026-11-11).
- The hub runs in `us-central1`, the same region as the `hs-ls-integration` functions.

**Models and cost**
- Opus 5.5 at low effort for the Roamer brief (Blake, 2026-11-08); Sonnet 5.5 for `/wow`; Haiku 5.5 at low effort for routing, the reuse and brief checks, `/remind`, `/text` drafts, and `/new` (2026-11-11).
- Basecamp's AI runs only on the Anthropic API, never on a Claude subscription seat. AI work by hand runs in a person's own Claude Code session (`/brief`).
- Who may spend credits, who may approve a text, and who may use Basecamp are three separate lists, each failing closed (2026-11-11).
- Budget estimate: about $2.00 a deal, $160 a month at 80 deals. Measured so far: a full brief $0.11 to $0.26, an update about half; briefs are most of the spend. Replace the estimate with what `cost` shows after a week of real use.
- Not worth doing: grouping the record by day, shortening words in the record, prompt caching on single calls. Still open: Sonnet 5.5 for brief updates (needs one side-by-side read, Blake's call).
- When a call has both HubSpot's summary and Aloware's, the brief reads Aloware's only (2026-11-11): on real Utah calls Aloware named the Team Member and the Roamer correctly where HubSpot's summary got names wrong. The rules for what the record leaves out are in `docs/reference/features.md`.
- The brief's last list is Commitments and next steps (Blake, 2026-11-08).

**Briefs, deal spaces, texts, Home, the clock**
- Decisions for each are in the matching `docs/reference/` file. The ones most often needed: briefs post only in a direct message or that deal's own space; with several contacts Basecamp asks which is the Roamer; notes go on the Delivery record and the Roamer, never the deal; every approved text is sent as the company (`user_id: -1`) from `src/aloware.js` only; no orange or amber on any card.

## Open questions

- Whether the HubSpot key keeps `conversations.write` and `conversations.custom_channels.write` (Blake's call; the audit says remove them).
- Managed Agents or the tool runner for the second agent.
- Whether development may draw on the $10 or only Shane's test.
- Escalation wording and recipient (likely the GM), to design before rollout.
- Mods payment standing rule (team decision in the deal space for now).
- Parts quantity field meanings.
- Whether Google Calendar out-of-office is readable for vacation routing.
- The Service Advisor contact window (business days): pending a possible process change (Blake, 2026-11-08).
- Whether deal spaces with real Team Members end shadow mode for Utah, and the exact wording of nudges (helping, never reprimanding).
- False nudges: work done off HubSpot looks missing. A note in the space counts; watch for them early.
- How wrong answers get caught in shadow mode: a set review against LightSpeed, not noticing by chance.
- Noise: Parts and the GM sit in every open space. Keep Parts to @mentions and the GM to watching.

## Later ideas

- A gradient banner image at the top of Home or a brief, served like the avatar.
- A flag on Home for deals where the Roamer texted last and the team owes a reply.
- Clarify card suggestions: one or two tap-to-pick clarifications, keeping the text box (Blake, 2026-11-07).
- A social media checker that finds WOW details for the brief (Blake, 2026-11-07). Not designed: which accounts, how a profile is matched, what the Roamer has agreed to.
- A knowledge agent reading ROA reference material: share one Shared Drive folder with `basecamp-router` as Viewer, enable the Drive API, confirm with the super admin. No Marketplace Drive scope.

## Setting up on another computer

- Clone: `git clone https://RoaminCode@github.com/RoaminCode/roa-agent-hub.git` into `C:\Users\Support\Documents\Claude\Projects\roa-agent-hub`, then `npm install`.
- Set the commit identity for this repo: `git config user.name "RoaminCode"` and `git config user.email "258948938+RoaminCode@users.noreply.github.com"`.
- Git must be signed in to GitHub as RoaminCode, not the personal account. Keep `RoaminCode@` in the remote URL.
- gcloud must be installed and signed in as blake@rvsofamerica.com. Find its path with `where gcloud`.
- In Claude Code's `!` prompt (Git Bash), use forward slashes in Windows paths.
- PowerShell 5.1 breaks commit messages that contain double quotes when passed with `-m`. Write the message to a file and use `git commit -F <file>`.

## Retired, do not use

(Nothing yet.)
