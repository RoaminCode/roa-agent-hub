# App Home

What Home shows and where each piece comes from. Read before touching `src/chat/homeCard.js` or `src/hubspot/openDeals.js`.

- Open deals are Sales Pipeline stage "Deals" (`85341732`); Finalized and Lost Deal are closed. Deal names read "51436 - Roamer Name - Trailer", so Home needs no per-deal lookups for names.
- Last contact comes from the Roamer's contact `notes_last_contacted`, not the deal's (the deal's copy lagged three weeks on one Utah deal). It moves on calls, emails, and Aloware texts, including texts sent through the Aloware API (verified with the hand-sent test texts on Blake's contact).
- Who made the last contact: Basecamp searches calls, texts, and emails logged within a second of that moment (five moments per search, three types in parallel), checks each belongs to that Roamer, and names the Team Member by first name, "the Roamer", or "Basecamp". "Basecamp" only for a company send (a blank sender); a record that does not show who made it leaves the name off rather than guess. Texts sent from HubSpot's conversations inbox have no "Message:" line, and the sender is read from their header. 16 of 16 identified on real Utah deals 2026-10-29.
- Sales Coach is the deal owner and is labeled as such, never shown as the last contact.
- A bold "No contact in N days" with an icon (no orange or amber anywhere; urgency is bold text and an icon) when a deal delivering within 6 weeks (or past due) has had no contact in more than 7 days. Further out, no flag: a quiet week is normal.
- A second Brief tap on the same deal within two minutes starts no second brief; the button reads "In Messages" for those two minutes, including when Home is reopened.
