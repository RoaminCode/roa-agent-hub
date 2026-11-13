# Handoff

Last updated: 2026-11-12

## Read first: AI credits and permissions

Blake was given $10 of Anthropic API credits for Shane's test of the Roamer brief (2026-11-06); the balance has not been checked since. Blake does not want paid audit runs (2026-11-08).

1. **Never put `ANTHROPIC_API_KEY` on a laptop** (no `.env`, no shell variable): Claude Code would bill that key instead of the subscription. The key lives only in Secret Manager. `npm test` uses fakes and never spends.
2. **Three permissions, three lists, each fails closed (unset means nobody):**
   - `AI_USERS`: who may spend AI credits (briefs, `/ask`, `/wow`, `/new`, `/remind`, a `/text` draft, opening a space). `BRIEF_USERS`, its earlier name, is read when `AI_USERS` is unset.
   - `TEXT_APPROVERS`: who may approve and send a text to a Roamer. Being on `AI_USERS` does not grant it.
   - `ALLOWED_USERS`: who may use Basecamp at all (Home, `/note`, Save to HubSpot, Request access).
3. **`AI_PAUSED=true` stops every AI job** without a deploy (`BRIEFS_PAUSED` is its earlier name). Text approvals, Home, and notes stay on.
4. **`AI_DAILY_LIMIT_USD`** stops AI jobs for the rest of the day (Utah time) once the day's spend reaches it, and tells Blake once. It is one shared total for everyone, not per person, so one person can use it up; spend is recorded by job, model, and deal, not by person. Set to $2 (Blake, 2026-11-12).
5. **`cost` in a direct message with Basecamp** shows the last 7 days of AI spend by job and by day (AI users only, no AI call).
6. **`/brief` in Claude Code** writes a brief by hand from the same record and prompt, on Blake's subscription, with no API credits.

**Who is on which list (read from the service 2026-11-12):** `ALLOWED_USERS` and `BRIEF_USERS` hold blake@, coby@, and shane@rvsofamerica.com (Coby and Shane were added 2026-11-09). `TEXT_APPROVERS` holds blake@ only, so Coby and Shane can draft a text but not approve one; add either to `TEXT_APPROVERS` when they should.

**For Shane:** Blake showed him the how-to page in person. The page (https://claude.ai/artifact/7jEBvFNbBiz6VFE9Bij5wt) and the film (https://claude.ai/artifact/NrZoze1b6SrR5o9AcMUnNC) are out of date: neither covers `facts`, `ro`, or commitment check-ins. Update them before sharing again.

## Where things stand

- **Live:** Cloud Run service `basecamp`, `us-central1`, revision `basecamp-00083-xb7` (deployed 2026-11-12 from commit `3ca7df5` on `main`), https://basecamp-732941376364.us-central1.run.app. Service account `basecamp-router`, max 2 instances, CPU always allocated. Shadow mode for everything except approved texts, which are on but in test mode (`TEXT_TEST_TO`, Blake's phone, set in Cloud Run only) until Shane approves. Blake is live testing; no other Team Member is testing yet.
- **Seen working live on 2026-11-12 (Blake):** `facts` correct and fast; a deal space opened with its brief and Delivery record (51297); `/ask` answered correctly from LightSpeed (the mods on a deal) and marked right; the 48 hour rule held back a stale status; routing went to the right role; `brief <deal#>` in the deal's own space reused the saved brief; a promise in an answer ("in about 10 minutes") was noted with the right time; `/remind` set.
- **Deployed 2026-11-12, not yet seen working live:**
  - Commitment check-ins: none has come due yet. The first is due 8 AM Mountain on 2026-11-13 (deal 51297, the balance question). It is also the first real read of a space's messages (`chat.app.messages.readonly`).
  - `/ask` in a space posts the question back itself so the answer lands in a thread, and `brief <deal#>` in a deal's space replies in the thread it was asked in (`docs/reference/google-chat.md`, "Threads in a space"). Watch for an error under the `/ask` command, which now gets an empty reply.
  - Fact or status judged by what the source says, and a too-old answer quoted on the routed card.
  - `/wow` with a 5,000 token limit. It was cut off at 2,000 on deal 51380 every time; run it there again.
  - The audit fixes proven by tests only: the brief's 3 minute limit, HubSpot read retry, the WOW row lookup, reminder retries, the Anthropic SDK at 1.8.0. Status of all 41 findings: https://claude.ai/artifact/2FNNEg8byXfTCraFzT7pgR
- **Branch `brief-next`** (pushed, not deployed; rebase it onto `main` before working on it): optional brief parts, so a part added to the brief later does not force a full read of every deal. No part is registered yet. Brief changes collect on this branch and ship as one batch.
- **Env vars on the service:** `CHAT_AUDIENCE`, `PROJECT_NUMBER` (732941376364), `ALLOWED_USERS`, `BRIEF_USERS`, `TEXT_APPROVERS`, `SHADOW_REVIEWER` (blake@rvsofamerica.com), `WOW_SHEET_ID`, `TEXTS_LIVE=true`, `TEXT_TEST_TO`, `RJB_LOOKUP_URL`, `AI_DAILY_LIMIT_USD=2`. Secrets: `HUBSPOT_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`, `ALOWARE_API_TOKEN`.
- **Deploy:** `npm run deploy` (loads the server, runs the tests, then `gcloud run deploy basecamp --source . --region us-central1 --project roa-agent-hub`; env vars and secrets are kept). gcloud's default project on the laptop is `hs-ls-integration`; always pass `--project roa-agent-hub`. GitHub runs the tests on every push.
- **Tests:** 358 pass on `main` (`npm test`). Firestore is faked in `test/fakeFirestore.js`. `test/briefGuard.test.js` fails when a change would force a full paid read of every deal's brief.
- **Chat app "Basecamp":** App Home on; Blake, Coby, and Shane are allowed. The Workspace admin install is complete (Blake, 2026-11-12). Commands: `/note` (1), `/ask` (2), `/wow` (3), Save to HubSpot message action (4), `/text` (5), WOW ideas quick command (6), `/new` (7), `/remind` (8). `facts` and `ro` work in a direct message only; Coby was told so when he asked in a space, which is the rule, not a permission problem.
- **What works on the live revision** (detail in `docs/reference/features.md`): briefs with reuse and incremental updates; App Home; deal spaces; Delivery records found or created when a space opens; notes; `/ask` routed to Blake with a suggested answer from earlier answers, LightSpeed, or the brief; commitment check-ins; `/new`; `/wow`; `/text` in test mode; `/remind` and the 5-minute timer; `facts` and `ro`; `cost`.
- **Data:** HubSpot is the record (Basecamp writes notes and creates Delivery records, nothing else). Firestore holds Basecamp's own ids, timestamps, statuses, the text send log, pending reminders, commitments, and AI spend. The ROA WOW Ideas sheet holds the idea library. LightSpeed is read live, read-only, through `rjbDealLookup`; nothing from it is stored. Call transcript text is not reachable (404); briefs read call summaries.
- **Logs** never hold message text or Roamer details. `GET /health`, `GET /avatar.png`.

## Next steps

1. **Check the first commitment check-in** (8 AM Mountain, 2026-11-13, deal 51297): it should reach Blake in that question's thread, labeled "Would go to:". Then test the kept path: answer a question with a promise and post in the deal space that it was done before it comes due; no check-in should arrive and the Q&A note should gain that message, "found by Basecamp". The check-in's wording is a first draft (`SAY.followUp` in `src/commitJob.js`).
2. **Check the threading fixes** in a deal space: `/ask`, answer the card, and see the answer under Basecamp's "Question from" message; `@Basecamp Brief <deal#>` and see the card under the request. If the brief still lands in a new thread, post it the way `/ask` does.
3. **Run `/wow` on deal 51380 again,** and ask a new question whose answer the brief records as done, to see it offered as a fact.
4. **A "Brief" agent in Claude Code** (Blake's idea, 2026-11-12): an agent file pinned to Opus at low effort, with `/brief` handing the writing to it, built on `brief-next`. Closer to Basecamp than a plain session, but not the same (no enforced shape, Claude Code's own instructions around it, full reads only), so keep one paid side by side on one deal before a brief release. Not built; Blake has not said whether to build it or do it himself.
5. **Finish the live check list** from the 2026-11-11 release: `facts` on a few more Utah deals against LightSpeed; the `/ask` traps ("is the solar done?", "has the part arrived?"), which must not come back as done; `/text` once; one brief, then add a text to that deal and run it again (the first update that returns only what changed); `cost`. One full brief read per deal is still owed from that release for deals not briefed since.
6. **Understand the permission gates and add people where needed** (Blake, 2026-11-12). The lists are under "Read first"; the live service still sets the AI list under its earlier name, `BRIEF_USERS`.
7. **Update the how-to page and film** for `facts`, `ro`, and commitment check-ins before they go to anyone else.
8. **LightSpeed `OpenServiceDet` for Utah:** the request to LightSpeed is started (Blake, 2026-11-12). Until it opens, an open repair order shows tech time only.
9. **Touchpoint clock:** keep designing how each touchpoint's completion is detected (`docs/reference/clock.md`). Its state belongs in Firestore.

Smaller, waiting on real use or on Blake:
- Q&A answers in the space: the bar is 10 Right or Wrong verdicts on real Team Member questions, at most 1 Wrong. Blake's own test questions do not count.
- First live text: a real, low-stakes message with the logs watched; then remove `TEXT_TEST_TO`. Choosing the line from the Roamer's SMS history is next.
- Try the contact picker on the first Utah deal with two contacts.
- When Team Members get access, Home switches from every Utah deal to "My deals".
- The Service Advisor contact check with a draft (rest of Slice 1).
- The Deal's `delivery_date_lightspeed` waits on confirming nothing writes to it.
- In the integration project: old build images hold the current Utah, South Carolina, and Colorado Gateway passwords. Blake will start the rotation himself and is holding as is for now (2026-11-12).
- Outside this repo: the `roamer-summary` account skill and one connector still point at a retired system, the brand skill is installed twice, and the last line of the organization instructions is cut off.

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
- A question on a deal is answered from three sources, each one fixed read and one small model call: earlier answers, LightSpeed read live, and the brief (2026-11-11). An agent that chooses its own steps with hub tools waits until a question needs it (one that spans deals, or needs a lookup the deal number does not give).
- The hub runs in `us-central1`, the same region as the `hs-ls-integration` functions.

**Models and cost**
- Opus 5.5 at low effort for the Roamer brief (Blake, 2026-11-08); Sonnet 5.5 for `/wow`; Haiku 5.5 at low effort for routing, the reuse and brief checks, `/remind`, `/text` drafts, and `/new` (2026-11-11).
- Basecamp's AI runs only on the Anthropic API, never on a Claude subscription seat. AI work by hand runs in a person's own Claude Code session (`/brief`).
- Who may spend credits, who may approve a text, and who may use Basecamp are three separate lists, each failing closed (2026-11-11).
- Budget estimate: about $2.00 a deal, $160 a month at 80 deals. Measured so far: a full brief $0.11 to $0.26, an update about half; briefs are most of the spend. Replace the estimate with what `cost` shows after a week of real use.
- Not worth doing: grouping the record by day, shortening words in the record, prompt caching on single calls. Still open: Sonnet 5.5 for brief updates (needs one side-by-side read, Blake's call).
- When a call has both HubSpot's summary and Aloware's, the brief reads Aloware's only (2026-11-11): on real Utah calls Aloware named the Team Member and the Roamer correctly where HubSpot's summary got names wrong. The rules for what the record leaves out are in `docs/reference/features.md`.
- The brief's last list is Commitments and next steps (Blake, 2026-11-08).
- The brief's shape and the record rules are frozen between releases (Blake, 2026-11-12): either change forces a full paid read of every deal (about $0.18 a deal). Wording-only prompt changes force nothing. Brief changes collect on `brief-next`, are tried by hand with `/brief`, and ship as one batch. A part added later is registered as optional so saved briefs stay valid. Steps in `docs/reference/features.md`, "Changing the brief".
- Balance due and other finance terms stay out of Basecamp (Blake, 2026-11-12): one Finance Manager manages them and will not ask Basecamp.

**Questions and commitments**
- A promise in an answer to a routed question is tracked and checked at its due time; one check-in, to Blake in shadow mode (built and deployed 2026-11-12; rules in `docs/reference/deal-spaces-and-routing.md`).
- Fact or status is judged by what the source says, not how the question is worded: recorded as done, decided, confirmed, or clarified is a fact, used at any age. An answer too old to use is still quoted on the card (Blake, 2026-11-12).
- `facts` and `ro` stay on request in a direct message; nothing is posted into a space automatically (Blake, 2026-11-12, as Claude read it; confirm if Team Members should be able to ask for `facts` inside a deal's own space).

**Briefs, deal spaces, texts, Home, the clock**
- Decisions for each are in the matching `docs/reference/` file. The ones most often needed: briefs post only in a direct message or that deal's own space; with several contacts Basecamp asks which is the Roamer; notes go on the Delivery record and the Roamer, never the deal; every approved text is sent as the company (`user_id: -1`) from `src/aloware.js` only; no orange or amber on any card.

## Open questions

- Commitments: the check-in's wording; whether a promise with no day is tracked (today it is due that day at 2 PM); whether a promise in a `/note` counts.
- How long the text send log is kept (no TTL is set), and whether a brief written by hand with `/brief` should be saved.
- Leader or Manager in role names (the routing prompt says Manager).
- Whether `/wow` should think less to cost less (a run on a large deal is now about $0.05 to $0.08).
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
