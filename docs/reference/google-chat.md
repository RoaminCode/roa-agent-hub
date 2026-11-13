# Google Chat specifics

How the Basecamp Chat app is configured and the quirks found building it. Read before touching `src/chat/` or the Chat app configuration.

- The Basecamp Chat app is configured as a Google Workspace add-on. Events arrive in the add-on format (`{ chat: { messagePayload, ... } }`) and are signed by `service-732941376364@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`. Replies must use the add-on response shape (`hostAppDataAction`). The router also accepts the classic format.
- Cloud Run swallows paths ending in "z" (like `/healthz`); use `/health`.
- The Chat console accepts URLs with a leading or trailing space without warning, and the app then fails silently. A trailing space in the App home field broke Home on 2026-10-29.
- When Chat fails without calling Basecamp (nothing in the Cloud Run logs), check the add-on error log first: `logName="projects/roa-agent-hub/logs/gsuiteaddons.googleapis.com%2Ferrors"`. It names the exact problem (bad URL, unparseable response).
- App Home: the opening event is `{ chat: { user, eventTime }, commonEventObject }` with no payload; answer with bare RenderActions `{ action: { navigations: [{ pushCard: card }] } }`. A button tap arrives as `chat.buttonClickedPayload` with `commonEventObject.parameters`. Chat rejects a `renderActions` wrapper, redraws Home on any tap (a brief loading bar), and does not show `action.notification` pop-ups on Home. Feedback for a tap goes on the card itself via `{ action: { navigations: [{ updateCard: card }] } }`; a message in the conversation alone is invisible on a phone or full screen.
- Chat cards cannot change fonts, color a section's background, or draw gradients. Available: bold, italic, colored text, section titles, icons (Material Symbols, filled or outlined), chips, columns, dividers, colored filled buttons, collapsible sections. Each section draws as its own rounded tile.
- Card text is escaped before it reaches a card (record text can hold HTML-like characters).

## Threads in a space (seen live 2026-11-12)
- A message Basecamp posts with a thread name and `REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD` lands in that thread when Basecamp started the thread. Posted to the thread of a person's slash command message, it lands in a new thread instead (deal 51297's space, both `/ask` answers). The reason is not known.
- So `/ask` in a space posts the question back itself ("Question from ...") and the answer goes under that message; the request gets an empty reply. A question that went through a clarify card keeps the card's thread, which is Basecamp's own.
- A reply built into the response to a request (`replyFor`) also starts a new thread in a space.
- `brief <deal#>` typed in a deal's own space replies to the thread of the typed message. Not yet seen live; if it also lands in a new thread, post it the same way as `/ask`.
- Listing a space's messages as the app does not return slash command messages.
