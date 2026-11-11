# Deal spaces, routing, and Deal Knowledge

The rules for deal spaces, deal watches, commitments, reminders, handoffs, and who gets a question. Several are decided but not built; each says so. Read before building anything that nudges, routes, or follows up.

- Spaces open on demand, not at deposit: anyone on the deal says "@Basecamp open a space for [deal#]". Many deposits are scheduled months out, and auto-opening would leave quiet spaces open for months. Basecamp checks the deal exists, is not finalized, and has no open space. Store defaults to Utah for the pilot; past Utah the command takes a store ("51xxx UT").
- Spaces opened by Team Members (not Blake) are the adoption signal. Auto-opening when the trailer arrives is a later decision, made from the on-demand numbers.
- A space is deleted 48 hours after Finalized or Lost Deal. HubSpot is the archive.
- Members: Sales Coach and Service Advisor as primary, Parts in the space but engaged by @mention, GM as watcher. Delivery Coach joins when assigned (no later than 7 business days before projected delivery). Business days are Monday to Friday.
- Deal facts from LightSpeed are pinned at the top. Basecamp writes requests and answers to HubSpot as notes (not every message), on the Roamer's contact and the deal's Delivery record, never on the deal (Blake's call, 2026-11-07). Before a deal has a Delivery record (a brief or a DM note on a deal with no space), a note goes on the contact only; when the Delivery record is created, the brief note is linked to it. Brief notes are found by the id in Basecamp's database, else by searching the contact's and (for older notes) the deal's notes.
- Deal watches run on every Utah deal with no space, code only: Service Advisor contact with the Future Roamer within the contact window after deposit, and the Sales Coach's update to the Roamer after the trailer arrives.
- Completion is detected, never reported. Basecamp looks for the work in HubSpot (calls, SMS, and email all log there) or in what people say in the space. No "reply done". When everything is on track Basecamp stays quiet; when something is missing it posts in the deal space, where the team sees it, worded as a teammate's heads-up with a draft, never a callout. Deals with no space get the nudge as a direct message. In the pilot these go to Blake, labeled with who they would have gone to.
- Commitments (Blake, 2026-11-07; not built): when an answer promises something ("I will have that tomorrow"), Basecamp checks in at the due time, not before. A promise with no time is due at 2 PM Mountain on the day named (next business day if it falls on a weekend; "end of week" is Friday at 2 PM). One follow-up only, then nothing more; a missed promise is logged for coaching. Follow-ups go out Monday to Friday, 8 AM to 5 PM Mountain. Before sending, Basecamp checks whether the promise was kept: a newer answer on the topic, the deal space's messages since the promise (needs `chat.app.messages.readonly`), and HubSpot; if kept, nothing is sent and the message is filed as the answer. In shadow mode the follow-up goes to Blake, labeled with who it is for.
- `/remind` (live 2026-11-07, `src/remindJob.js`): "/remind me <what> <when>", for the person asking only. Haiku (`src/agents/remindParse.js`) reads the time in Utah (a day with no time is 9 AM; "within the hour" is 60 minutes) and the reply confirms it. In a deal space it is about that deal; in a DM a deal number ties it to the deal. It arrives as a DM card at the exact time asked, even outside business hours, with "Draft a text" (starts /text with its words) and "Open space" on a deal. Up to 60 days ahead. Firestore `reminders` keeps the words only until sent. The timer: Cloud Scheduler job `basecamp-tick` (us-central1, every 5 minutes) POSTs `/tasks/tick`, signed as `basecamp-router`, which only that signer can call. Reminding someone else waits (a nudge, which in shadow mode goes to Blake). Keeping commitments, or speaking up before they are due, is the ROA communication standard.
- When the Service Advisor cannot keep a commitment to a Future Roamer, Basecamp hands it to the Sales Coach, who owns the relationship. This is a handoff, not escalation. If the Sales Coach cannot either, Basecamp gives the Service Advisor a draft to reschedule.
- Sends (built 2026-11-07 as /text, item 8): Basecamp drafts; on a Team Member's approval of that exact draft it sends through Aloware's API, and Aloware logs the text to the HubSpot contact. Basecamp's own log records who approved each text, and its HubSpot note says "Sent by Basecamp, approved by [name]". The approval shows the recipient's name and number and the exact text, covers only that draft, and is logged.
- The Sales Coach owns the deal and the Roamer relationship until delivery, including date changes in LightSpeed and telling the Roamer.
- People outside the space get a direct message card, one per question (built 2026-11-07 for the shadow reviewer, `reviewCard` in `src/askJob.js`): the question, who asked and why that role; Basecamp's suggested answer when it has a good one, with "Send this answer" (relays it, counts Right) and "Not right" (counts Wrong, keeps the answer box); a box to type an answer and Send; "Not mine" (recorded as `routeVerdict: "not_mine"`); Open space. The card is replaced by what happened. A thread reply still works. The separate Right/Wrong card is no longer posted.
- Role fallback: role at that Experience Center, then Service Advisor, then GM.

| Experience Center | Service Advisor | Parts questions |
| --- | --- | --- |
| Utah | Coby Shell | Kevin Willingham |
| Colorado | Justin Price | Justin Price |
| South Carolina | Vaughn Owens | Christina Ryan |
| Arizona | Mike Nicholson | Mike Nicholson |

## Deal Knowledge
- Answers and explicit notes are saved as attributed, timestamped notes on the Delivery record. Facts are reused; status notes expire after 48 hours. Commitments ("tomorrow") get a check at that time.
- Mods from a call: Basecamp writes the list as a note labeled "From the call, not yet matched to the deal". When mods appear on the deal it compares them; a match updates the label, a mismatch asks the Service Advisor and corrects the note. If nothing appears after a reasonable window, it asks.
- No HubSpot tasks. Team Members do not use them; accountability lives in deal space notifications.

## Shadow mode success metrics
- Answered from data (rising), wrong answers (zero), routed answer time (improving), commitments missed without notice (falling), cost per deal (at or under estimate).
- Adoption: spaces Team Members open themselves, and how often a nudge is followed by the work showing up in HubSpot. Accuracy without use is not success.
