# LightSpeed lookup

How the hub reads LightSpeed deal facts. Read before touching `src/lightspeed/`, `src/factsJob.js`, or anything that will show or reason about deal facts. Built 2026-11-11 in both projects; see `HANDOFF.md` for whether it is deployed.

## The shape

- The hub holds no LightSpeed credential. It calls `rjbDealLookup`, a function in the integration project (`hs-ls-integration`, folder `LightSpeed Integration`, files `src/index-rjbDealLookup.ts` and `src/rjb/`), through `src/lightspeed/lookup.js`. A test fails if any other hub file talks to LightSpeed.
- The hub calls it as `basecamp-router` with a Google-signed identity token whose audience is the function's URL (`RJB_LOOKUP_URL`). The function is not public: `basecamp-router` is its only invoker, and its code checks the caller again.
- The function runs as its own service account, `rjb-deal-lookup`, which can read one secret, the Utah Gateway password. It has no HubSpot token and no lead-creation key, writes nothing, and never fetches a Roamer's LightSpeed record.
- LightSpeed is the source of truth for deal facts and cannot be changed through any of this.

## Request and answer

- `POST` JSON `{ "store": "ROA1", "dealNo": "51436" }`. The hub maps `UT` to `ROA1` (`SC` `ROA2`, `AZ` `ROA3`, `CO` `ROA4`). Utah only for now (Blake, 2026-11-11); another store answers `store_not_enabled`.
- `200 { ok: true, result: { found: [ { store, feed, deal } ] } }`. `found` is empty when the store has no such deal. `feed` is `open` or `closed`; an open deal comes first.
- Any failure is `{ ok: false, reason }` with a short label (`lightspeed_http_403`, `lightspeed_timeout`, `store_not_enabled`, `caller_not_allowed`). A LightSpeed failure is never reported as "not found".
- The function aims to answer within 12 seconds; the hub gives up at 20.

## Repair orders

- The same function answers `{ "store": "ROA1", "roNo": "300686" }` with `{ ok: true, result: { ro: { roNumber, paid, clock } } }` (integration file `src/rjb/roLookup.ts`).
- What LightSpeed lets us read (checked 2026-11-11): paid repair orders in full (`ServiceDet`), and the tech clock for any repair order, open or paid (`ServiceLabor`). The open repair order feed (`OpenServiceDet`) is still refused, so an open repair order has no job list and nothing anywhere says a job is done.
- `paid` is the finished repair order, or null while it is not paid: dates (in, promised, closed, paid), Service Advisor, category, and per unit its jobs (title, description, sale type, approval, hours, technicians, resolution, tech notes, recommendations, parts by number and quantity).
- `clock` is tech time: sessions (technician, start, end, hours, still clocked on or not), total hours, technicians, last activity, and whether someone is clocked on now.
- Never returned: any dollar amount, rate, or cost; the Roamer; invoice and warranty claim numbers; usernames.
- A repair order that is neither paid nor clocked comes back with `paid: null` and no sessions. That means open with no tech time yet, or a wrong number; LightSpeed cannot tell those apart and Basecamp says so.
- Tech time shows work happened, never that a job is finished. Every card says this, and an agent must never turn tech time into "done".
- In the hub: `ro <number>` in a direct message shows one repair order; the facts card shows where each of the deal's repair orders stands (up to 6).
- Tried on two real Utah deals 2026-11-11: the deal read took about a second, each repair order about a third of a second.

## What comes back for a deal (the allowlist lives in the integration project, `src/rjb/dealLookup.ts`)

- Deal: `DealNo`, `dealstate`, `stagename`, `OriginatingDate`, `DeliveryDate`, `lastmodifieddate`, `SalesmanName`, `salesmanager`, `source`, `totaldownpayment`, `deposit`, `customerextraline`, `customernotes`, `Units`.
- Unit: `Year`, `Make`, `Model`, `unittype`, `Newused`, `stocknumber`, `VIN`, `DateReceived`, `DaysInStore`, `deposit`, `Labor`, `Parts`.
- Labor line: `SetupInstall`, `RepairOrderJobTitle`, `Description`, `RetailPrice`, `RepairOrderNumber`, `rostatus`.
- Parts line: `PartNumber`, `Description`, `Qty`, `SetupInstall`. No cost or price. The other quantity fields stay out until their meaning is verified.
- Never returned: the Roamer's or co-buyer's contact details and birth date, lienholder, finance terms, dealer cost, trade details. The Roamer's name comes from HubSpot.
- The two free-text fields a Sales Coach types (`customerextraline`, `customernotes`) are included (Blake, 2026-11-11). They can hold anything typed there.
- A closed deal has no `dealstate` and carries `deposit` on the deal, not the unit.

## In the hub

- `src/lightspeed/rjbView.js` trims an answer to the RJB view (version 2): deal, unit, mods, prep (PDI and findings), parts line count, and flags for things worth a look (a line not on a repair order, a PDI line mislabeled).
- `facts <deal#>` in a direct message (`src/factsJob.js`) shows that view as a card, read live, with no AI. Anyone on `ALLOWED_USERS` may use it; it spends nothing. It is the tool for proving deal facts before an agent is trusted with them.
- Repair orders: no LightSpeed feed exposes per-job completion. Labor lines carry a repair-order-level `rostatus` only. Per-job "done" needs `OpenServiceDet` access from LightSpeed or an ROA-side record (integration review, 2026-10-30).

## Deploying the function (in the integration project, by Blake)

1. `.\deploy\setupRjbDealLookup.ps1` once: creates `rjb-deal-lookup` and grants it the one secret.
2. `.\deploy\deployRjbDealLookup.ps1`: deploys it (twice the first time), allows only `basecamp-router`, prints the URL and two checks.
3. Set that URL as `RJB_LOOKUP_URL` on the `basecamp` service and deploy the hub.
