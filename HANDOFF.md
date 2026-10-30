# Handoff

Last updated: 2026-10-30

## Where things stand

- Spec is complete enough to build from: "RJB Agent Spec" (link in `CLAUDE.md`).
- Google Cloud project `roa-agent-hub` is set up: billing linked, APIs enabled (Chat, Cloud Run, Cloud Build, Artifact Registry, Secret Manager).
- The Anthropic API key is in Secret Manager as `anthropic-api-key` (format checked, value never displayed). Only `basecamp-router` can read it, granted on that one secret.
- Basecamp is live on Cloud Run as service `basecamp` in `us-central1`, running as `basecamp-router`, max 2 instances, CPU always allocated so a brief keeps running after the reply: https://basecamp-732941376364.us-central1.run.app
  - Live revision `basecamp-00027-64n` (deployed 2026-10-29, briefs paused). Roll back with `gcloud run services update-traffic basecamp --to-revisions=<revision>=100 --region us-central1 --project roa-agent-hub`; the previous good revision is `basecamp-00026-cf4`.
  - Verifies every request came from Google Chat and allows only `ALLOWED_USERS` (Blake). Message text and Roamer details are never logged; logs carry counts, timing, and event shapes (keys only). Error logs keep type, status, provider error code, request ID, and file-and-line stack frames; a message is logged only when the hub wrote it (`safeError` in `src/errors.js`), never a library's, which can quote its input. A test puts fake private text in errors and fails if it reaches a log.
  - gcloud's default project on the laptop is `hs-ls-integration`; always pass `--project roa-agent-hub`.
  - `GET /health` for health checks, `GET /avatar.png` serves the Basecamp avatar.
  - Env vars: `CHAT_AUDIENCE` (endpoint URL), `ALLOWED_USERS`, `PROJECT_NUMBER` (732941376364), `BRIEFS_PAUSED` (`true` while briefs are paused); secrets `HUBSPOT_ACCESS_TOKEN` and `ANTHROPIC_API_KEY` from Secret Manager.
- The Chat app "Basecamp" is configured (visible only to Blake, App Home on, headset sasquatch avatar).
- 121 tests pass (`npm test`).
- **App Home is live ("Utah deals" in shadow mode).** Opening Basecamp's Home tab lists every open Utah deal (stage "Deals"), one rounded tile each, grouped ON DECK (delivery under 3 days or past due, orange #E2692E), THIS WEEK, NEXT TWO WEEKS, LATER, NO DELIVERY DATE. Each tile: deal number and trailer, Roamer in bold, Sales Coach top right; delivery on its own row; last contact date and who made it on its own row with a Brief button. Tapping Brief redraws Home with that deal's button as a disabled "In Messages" with a check icon (so the tap shows on a phone or full screen, where Messages is a separate tab), posts "I'll need just a moment to read up on [Roamer] (deal N)" in Basecamp messages, then the brief card. About 4 seconds to open; a tap answers at once from a deal list cached for 90 seconds. Code only, no AI until Brief. Verified on phone and full screen 2026-10-29. Last contact is dated in Mountain time (HubSpot stores UTC; an evening contact used to show as the next day). Deals with more than one contact show "2 contacts" on the tile. Checked against live HubSpot 2026-10-29: 16 of 16 Utah deals shown, every date and every "who made it" correct.
- 2026-10-28 read-only review of `hs-ls-integration`: no endpoint the hub can safely call exists. The deal lookups (`diagnose-deal`, `deal-report`) live inside `adminTools`, which needs a dashboard operator sign-in and also performs writes. All 10 services allow `allUsers` and check callers in code. Deploy bundles contain real Roamer data. No repair order lookup is deployed. A handoff (`handoff-from-agent-hub.md`, in a Gmail draft to Blake) asks the integration project to clean the bundles, report on how each function is protected, and build a read-only `rjbDealLookup` callable only by `basecamp-router`.
- HubSpot private app "Basecamp" is live and verified: contacts, deals, owners, custom objects, calls (including their summaries), texts, emails, and notes all read. Token in Secret Manager as `hubspot-access-token`.
- **Roamer briefs are paused (since 2026-10-29).** The Anthropic API account ran out of prepaid credits (Console showed -$0.20 of credit; the $500 figure is the monthly tier limit, not a balance), and Blake does not manage that funding. `BRIEFS_PAUSED=true` on the Cloud Run service: a typed "brief" gets a short paused message, Home has no Brief buttons and says why, nothing calls HubSpot or Anthropic for a brief. Home and everything code-only run as normal. To resume once credits are added (ideally with auto-reload): `gcloud run services update basecamp --remove-env-vars BRIEFS_PAUSED --region us-central1 --project roa-agent-hub`, no code change. The Claude subscription cannot pay for Basecamp's API calls; a bridge where Blake runs briefs from Claude Code on his subscription was discussed and not built.
- **The Roamer brief is live (Slice 1, first piece).** Blake sends "brief <deal#>" to Basecamp in Chat; Basecamp answers at once, reads every call, text, email, and note on the deal's Roamer in HubSpot, and posts a card: header (Roamer, deal, delivery, Sales Coach), headline, tags, key facts, then WOW, MODS, and JOURNEY sections, with buttons into HubSpot. Claude Opus 5.5 at medium effort with default fallbacks. About 11 cents and 35 seconds for a 16-item deal, 26 cents and 43 seconds for a 241-item deal (measured 2026-10-29). Arctic palette: WOW #2E9BD6, MODS #23858A, JOURNEY #4A6F94, buttons #2E7DB8. Avatar is the headset sasquatch (`assets/avatar-256.png`, served as `/avatar.png?v=2`); the Chat app configuration's avatar URL should point at the `?v=2` address.
  - Briefs run only in a direct message with Basecamp; a typed "brief" in a group space gets a pointer to a direct message. Verified live 2026-10-29.
  - A deal with more than one contact gets a contact picker in Messages ("Which one is the Roamer?"), one button per contact; the tap runs the brief on that contact. **Not yet tried live**: no Utah deal had two contacts on 2026-10-29. The tap answers with `updateMessageAction`, which Basecamp had not sent before; if it fails, the add-on error log names it.
  - The card and the model's input say when items were left out, shortened, or could not be read from HubSpot. Two deals with one number are reported, not guessed between. Model output is checked field by field before a card is built.
  - The brief currently calls the Messages API with its prompt in `src/agents/roamerBrief.js`; edit the brief there until it moves to a Managed Agent.
- Call transcript text is not reachable: 2,723 calls are marked as having a transcript and the transcript scope is granted, but every transcript endpoint tried returns 404. Briefs read Aloware's and HubSpot's call summaries and say so on the card.
- **Sending is not built.** No code in this repo sends a text. What exists is proof the Aloware API works: on 2026-10-28, test texts to Blake's own phone were sent by hand (one-off commands run from a Claude Code session, not committed), and each was delivered and logged to HubSpot. Building approved sends is future work (see Aloware sending for the verified API facts and the rules the code must follow).

## Next steps

1. **Build `/brief` for Claude Code** (recommended next build here): runs a Roamer brief in Blake's own session on his subscription, reusing the hub's read-only HubSpot code and the brief prompt, no API credits. Then Basecamp's small database (Firestore) for its clock. API funding (about $50 with auto-reload covers the Utah pilot) is not expected for a while; resume briefs then (see Where things stand).
2. **Integration project, on the other computer:** run the handoff in `docs/handoff-to-hs-ls-integration.md` (2026-10-30; replaces the lost 2026-10-28 one, and asks that project's Claude to verify and correct each finding first). Bring back the `rjbDealLookup` URL, request format, a scrubbed sample response, and the repair order findings.
3. **Try the contact picker live** on the first Utah deal with two contacts, then check that one event in the logs and the add-on error log.
4. **Set up a Cloud Monitoring alert** on the WARNING log entry "deal has no Roamer contact" so Blake is notified. The log entry exists; the alert does not.
5. **Small fixes, not started:** a third HubSpot text format ("Name (Rvs of America): ...") gives a blank sender, so Home leaves the name off; and an Anthropic billing error should reach the log and the requester in plain words (the out-of-credits failure on 2026-10-29 logged only a request ID).
6. **Blake decides:** Utah GM name; the Service Advisor's contact window for a new Future Roamer (business days); what signals the trailer has arrived; whether deal spaces with real Team Members end shadow mode for Utah.
7. **Workspace admin:** the one-time approval that lets Basecamp create Chat spaces, and make Basecamp visible to the Utah team. Confirm the exact steps first.
8. **Next build:** the rest of Slice 1 at Utah, in shadow mode: "@Basecamp open a space for [deal#]" (the brief becomes the space's first post, and Home can get an Open space button) and the Service Advisor contact check with a draft.
9. When Team Members get access: Home switches from every Utah deal to "My deals" (deals the viewer owns, or is Service Advisor on).
10. Prove the agent against the real questions Team Members ask in the pilot spaces, in shadow mode, before it answers in them.
11. Only after that: the HubSpot Delivery object change list (stages, lean fields, relabel `assigned_service_writer` to Service Advisor, retire old fields) for Blake's approval. Nothing changes in HubSpot until approved.

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
- The Chat console accepts URLs with a leading or trailing space without warning, and the app then fails silently. A trailing space in the App home field broke Home on 2026-10-29.
- When Chat fails without calling Basecamp (nothing in the Cloud Run logs), check the add-on error log first: `logName="projects/roa-agent-hub/logs/gsuiteaddons.googleapis.com%2Ferrors"`. It names the exact problem (bad URL, unparseable response).
- App Home: the opening event is `{ chat: { user, eventTime }, commonEventObject }` with no payload; answer with bare RenderActions `{ action: { navigations: [{ pushCard: card }] } }`. A button tap arrives as `chat.buttonClickedPayload` with `commonEventObject.parameters`. Chat rejects a `renderActions` wrapper, redraws Home on any tap (a brief loading bar), and does not show `action.notification` pop-ups on Home. Feedback for a tap goes on the card itself via `{ action: { navigations: [{ updateCard: card }] } }`; a message in the conversation alone is invisible on a phone or full screen.
- Chat cards cannot change fonts, color a section's background, or draw gradients. Available: bold, italic, colored text, section titles, icons (Material Symbols, filled or outlined), chips, columns, dividers, colored filled buttons, collapsible sections. Each section draws as its own rounded tile.
- Card text is escaped before it reaches a card (record text can hold HTML-like characters).

**Briefs**
- Briefs hold a Roamer's personal details, so they post only where the reader should see them: a direct message with Basecamp. When deal spaces exist, a deal's space also gets briefs, for that deal only; asking there for another deal points to a direct message or that deal's own space.
- When a deal has more than one contact, Basecamp asks which is the Roamer rather than guessing. The picked contact must still be on the deal when the brief runs.
- Every deal should have its Roamer attached. A deal with none is a HubSpot problem: the requester is told it needs fixing in HubSpot, and a WARNING "deal has no Roamer contact" is logged for an alert. Basecamp does not reroute around it.
- A typed "brief" always starts a brief. Only Home taps have the two-minute repeat check (a typed repeat check was tried and removed: it promised briefs in spaces that never got them).

**Models and cost**
- Sonnet 5.5 for the RJB agent's everyday work; Opus 5.5 for the Roamer profile and Delivery Coach brief; Haiku for narrow mechanical jobs. Compare Haiku vs Sonnet on real questions during shadow weeks.
- Basecamp's AI runs only on the Anthropic API (prepaid credits), never on a Claude subscription seat. A seat is one person using Claude's own apps; a service calling Claude on its own is API use, and storing a person's login in Basecamp is a terms, security, and usage-cap problem. Managed Agents bills through the API too. While the API is unfunded (Blake will not fund it for a while): build the code-only pieces (deal spaces, watches, Basecamp's clock, template nudges and sends), and run AI work by hand in a person's own Claude Code session (a `/brief` command; proving agent answers against LightSpeed). Templates prove the plumbing and habits, not the agent; the funding case is the live code-only pieces plus hand-run briefs that showed the team something new.
- Estimate about $2.00 per deal, about $160/month at 80 deals; budget double until measured.
- The Roamer brief runs at medium effort (decided 2026-10-29). High and medium were compared on three Utah deals of 16, 47, and 241 items, checked against the HubSpot record: neither invented anything, each run picked somewhat different details, medium cost 16% less and arrived 9 to 16 seconds sooner. Most of a brief's cost is the model's writing (thinking included, billed at five times the reading rate), so shrinking the input saves less than lowering effort. Shortening words in the record (for example "the" to "1") saves nothing, since common words are already one token each, and garbles the Roamer's quotes. Cost levers still open: drop automated and marketing messages and email footers in code before the model sees them; batch pricing (half off) for briefs built ahead of time; incremental briefs once the hub has a database.

**Deal spaces and routing**
- Spaces open on demand, not at deposit: anyone on the deal says "@Basecamp open a space for [deal#]". Many deposits are scheduled months out, and auto-opening would leave quiet spaces open for months. Basecamp checks the deal exists, is not finalized, and has no open space. Store defaults to Utah for the pilot; past Utah the command takes a store ("51xxx UT").
- Spaces opened by Team Members (not Blake) are the adoption signal. Auto-opening when the trailer arrives is a later decision, made from the on-demand numbers.
- A space is deleted 48 hours after Finalized or Lost Deal. HubSpot is the archive.
- Members: Sales Coach and Service Advisor as primary, Parts in the space but engaged by @mention, GM as watcher. Delivery Coach joins when assigned (no later than 7 business days before projected delivery). Business days are Monday to Friday.
- Deal facts from LightSpeed are pinned at the top. Basecamp writes requests and answers to HubSpot as notes (not every message), on the HubSpot Deal until the Delivery object exists.
- Deal watches run on every Utah deal with no space, code only: Service Advisor contact with the Future Roamer within the contact window after deposit, and the Sales Coach's update to the Roamer after the trailer arrives.
- Completion is detected, never reported. Basecamp looks for the work in HubSpot (calls, SMS, and email all log there) or in what people say in the space. No "reply done". When everything is on track Basecamp stays quiet; when something is missing it posts in the deal space, where the team sees it, worded as a teammate's heads-up with a draft, never a callout. Deals with no space get the nudge as a direct message. In the pilot these go to Blake, labeled with who they would have gone to.
- Reminders: one reminder before a commitment a person made ("call Bob at 2"), inside business hours, and no further follow-ups. Keeping commitments, or speaking up before they are due, is the ROA communication standard.
- When the Service Advisor cannot keep a commitment to a Future Roamer, Basecamp hands it to the Sales Coach, who owns the relationship. This is a handoff, not escalation. If the Sales Coach cannot either, Basecamp gives the Service Advisor a draft to reschedule.
- Sends (design, not built): Basecamp drafts; on a Team Member's approval of that exact draft it sends through Aloware's API, and Aloware logs the text to the HubSpot contact. Basecamp's own log records who approved each text, and its HubSpot note says "Sent by Basecamp, approved by [name]". The approval shows the recipient's name and number and the exact text, covers only that draft, and is logged.
- The Sales Coach owns the deal and the Roamer relationship until delivery, including date changes in LightSpeed and telling the Roamer.
- People outside the space get a direct message card (Answer / Not mine), one thread per question.
- Role fallback: role at that Experience Center, then Service Advisor, then GM.

| Experience Center | Service Advisor | Parts questions |
| --- | --- | --- |
| Utah | Coby Shell | Kevin Willingham |
| Colorado | Justin Price | Justin Price |
| South Carolina | Vaughn Owens | Christina Ryan |
| Arizona | Mike Nicholson | Mike Nicholson |

**App Home**
- Open deals are Sales Pipeline stage "Deals" (`85341732`); Finalized and Lost Deal are closed. Deal names read "51436 - Roamer Name - Trailer", so Home needs no per-deal lookups for names.
- Last contact comes from the Roamer's contact `notes_last_contacted`, not the deal's (the deal's copy lagged three weeks on one Utah deal). It moves on calls, emails, and Aloware texts, including texts sent through the Aloware API (verified with the hand-sent test texts on Blake's contact).
- Who made the last contact: Basecamp searches calls, texts, and emails logged within a second of that moment (five moments per search, three types in parallel), checks each belongs to that Roamer, and names the Team Member by first name, "the Roamer", or "Basecamp". "Basecamp" only for a company send (a blank sender); a record that does not show who made it leaves the name off rather than guess. Texts sent from HubSpot's conversations inbox have no "Message:" line, and the sender is read from their header. 16 of 16 identified on real Utah deals 2026-10-29.
- Sales Coach is the deal owner and is labeled as such, never shown as the last contact.
- Amber "No contact in N days" when a deal delivering within 6 weeks (or past due) has had no contact in more than 7 days. Further out, no flag: a quiet week is normal.
- A second Brief tap on the same deal within two minutes starts no second brief; the button reads "In Messages" for those two minutes, including when Home is reopened.

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
- Write, for notes only: notes are engagements, which HubSpot gates behind `crm.objects.contacts.write` (and possibly `crm.objects.deals.write` and `crm.objects.custom.write` to attach a note to a deal or Delivery). HubSpot cannot narrow these to notes, so the no-field-edits rule is enforced in hub code. Today the HubSpot client has no write methods at all (it only GETs and POSTs to search and batch read), and `test/hubspot.test.js` fails if that changes. Note creation is not built; when it is, it gets its own narrow method and is the only write.
- Granted 2026-10-28 and verified: the read scopes above plus `crm.extensions_calling_transcripts.read`, `conversations.read`, `conversations.custom_channels.read`; writes `crm.objects.contacts.write`, `crm.objects.deals.write`, `crm.objects.custom.write`. Token in Secret Manager as `hubspot-access-token`, readable only by `basecamp-router` (rotated once; version 1 destroyed).
- Do not grant conversations write scopes. Posting a message to an Aloware SMS thread through the HubSpot conversations API only stores it; it is never delivered, and it leaves a false "sent" record (tested 2026-10-28). Texts sent from HubSpot are actually sent by Aloware's app, which then writes the copy into HubSpot.

**Aloware sending (API verified by hand 2026-10-28; no send code exists yet)**
- `POST https://app.aloware.io/api/v1/webhook/sms-gateway/send` with `Authorization: Bearer <token>` and JSON `line_id`, `to`, `message` (160 characters max). Returns 202 `{"message":"Message sent."}`. Delivered to the phone within seconds and logged to the HubSpot contact automatically ("Creator Type: API").
- `user_id` sets who the text is sent as: a user ID sends as that user; 0 or omitted sends as the contact's Aloware owner (or the company if none); -1 sends as the company. An unknown ID returns 422. The first test omitted it and was credited to the contact's Aloware owner, a different Team Member.
- Decision: every approved send will use `user_id: -1` (company). Verified by hand 2026-10-28: delivered, and HubSpot logs it with a blank sender, no owner, "Creator Type: API". The Roamer sees the same line and text either way; a blank company sender on an API text means Basecamp.
- Rules the send code must follow when built (none of this exists yet): refuse any `user_id` other than -1; send only with a logged approval of that exact draft; write a HubSpot note per send ("Sent by Basecamp, approved by [name]"); keep its own log (line, recipient, time, approver, draft). The API returns no message ID (`fields` is ignored), so sends are matched by line, recipient, and time.
- Per Team Member text counts are not a requirement, so company sends losing Team Member credit is accepted.
- Aloware contact owners can differ from HubSpot owners (Blake's own contact did); worth checking separately.
- The token opens the whole Aloware account (API, MCP, Form Connect). When send code is built, the hub must expose exactly one Aloware call, the approved send, with a test that fails if any other appears. Today the hub has no Aloware code. Secret `aloware-api-token`, readable only by `basecamp-router` (stored, not yet read by any code).
- Utah send lines: Sales Coach from UT - Sales (line 67519, (385) 378-8538); Service Advisor from UT - Service (line 67523, (385) 454-9144). Other Utah lines: ROA UTAH MAIN LINE (67440), UTAH PARTS (67516), FABIO LINE (67439). ROA Tech Support is 63273. Other Experience Centers are mapped later.
- Which line a send uses: the line the Roamer already hears from that Team Member, found in the contact's HubSpot SMS history (this covers personal lines like FABIO LINE); with no history, the role line above. The approval shows the line.
- Not granted: anything for workflows, marketing, files, settings, or users. After the token exists, run each call once; a 403 names the missing scope.
- SMS is Aloware. All communications (any department, any sending or receiving number) are on the contact, not necessarily on the deal or LS Deal object, so Basecamp reads communications from the contact. The to and from numbers on each message show which inbox sent it.
- Calls carry `hs_call_has_transcript` and `hs_call_transcription_id`, but the transcript text itself returns 404 (see Where things stand). `hs_call_summary` and the Aloware summary in `hs_call_body` are on the call itself, and are what briefs read.

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

- A gradient banner image at the top of Home or a brief (served by Basecamp like the avatar). Decorative; cards cannot draw gradients otherwise.
- Home shows who made the last contact but not whether the team owes a reply. Deals where the Roamer texted last may deserve their own flag.

## Retired, do not use

(Nothing yet.)
