# Handoff: from ROA Agent Hub to the LightSpeed Integration

Date: 2026-10-30
From: the ROA Agent Hub (repo `RoaminCode/roa-agent-hub`, Google Cloud project `roa-agent-hub`)
To: the LightSpeed Integration project (Google Cloud project `hs-ls-integration`) and the Claude session that works on it

Save this file in the root of the integration repo as `HANDOFF-from-agent-hub.md`. It replaces the 2026-10-28 handoff (`handoff-from-agent-hub.md`), which is no longer in that folder; if any of that work was already done, say so in Step 0 rather than redoing it. When everything here is finished, fold what is worth keeping into this project's own `HANDOFF.md` and delete this file. Do not commit it as is.

## How to work this

You are a reviewer first. Everything below came from a read-only look at this project from outside it on 2026-10-28. It may be wrong, out of date, or already fixed. For every finding: **verify it against the real repo and Google Cloud, say whether it holds, and correct this handoff where it does not.** Tell Blake directly when something here is wrong instead of working around it.

Ground rules:

- This project runs the production LightSpeed and HubSpot sync. Read anything; change nothing without a plan Blake has approved. That covers every deploy, IAM change, git history rewrite, and deletion in Google Cloud.
- No real Roamer data in any repo, deploy bundle, log, or test fixture. Fixtures are scrubbed (fake name, VIN, customer and deal numbers).
- Do not change HubSpot fields, HubSpot structure, or LightSpeed as part of this work.
- ROA language in code comments, messages, and docs: Roamers, Future Roamers, Team Members, Sales Coach, Service Advisor, Experience Center, Leader. No em or en dashes.

## Background: what the Agent Hub is and why it needs LightSpeed

The Agent Hub runs Basecamp, ROA's Google Chat app for Team Members. Today it reads HubSpot only (open deals, calls, texts, emails, notes). Its next pieces need LightSpeed deal facts, read live by store and deal number:

- deal facts pinned at the top of each deal's Chat space (unit, stock number, VIN, deal state, Sales Coach);
- the mods on the deal (labor lines: Dealer Add, Customer Add, and "Charge sales" lines included at no charge);
- the PDI and its findings (Prep labor lines);
- later, which jobs on a repair order are done.

LightSpeed is the source of truth for deal facts. The hub never edits LightSpeed or HubSpot fields.

## Why safety still matters when LightSpeed is read only

LightSpeed cannot be changed through the Gateway; the only thing its credentials can create is a lead. That removes the worst risk, but not every risk:

1. **The existing lookups sit next to HubSpot writes.** `diagnose-deal` and `deal-report` live inside `adminTools`, which also runs `import-deal-no-email`, `link-deal-to-contact`, `create-deal-for-contact`, and `audit-update-hubspot`. Access to `adminTools` is access to HubSpot writes. The hub must only ever read.
2. **Reading is sensitive.** A deal lookup returns a Roamer's name, address, phone, email, deal money, and VIN. Whoever can call the lookup can pull any Roamer's deal. The caller list has to be exactly one service account.
3. **Leads are the one thing that can be created.** A stray or repeated call could create junk leads. The lookup must contain no lead-creation path at all.
4. **Shared credentials.** All functions here run as the default compute service account, which can read every secret, including the HubSpot token. A lookup running as that account could reach HubSpot even if its code never does.
5. **Load on the Gateway.** The hub should not be able to hammer LightSpeed; the lookup answers one deal per call.

## Step 0: report current state (do first, report only)

The 2026-10-28 handoff may have been partly worked. For each of Parts 1 to 3 below, tell Blake: not started, in progress, or done, with evidence (commit, deploy time, file listing).

## Part 1: Keep real Roamer data out of deploy bundles

**Reported finding.** All 10 functions deploy one shared source bundle, stored at `gs://gcf-v2-sources-874762819039-us-central1/<function>/function-source.zip`. It held files with real Roamer data or with no place in a deploy: `605 Outstanding Repair Order - Open by Age (Blake).csv` at the repo root; `reports/` (delivered-deal HTML, `reports/adds/*.json` repair order jobs, an audit run backup JSON, `.xlsx` reports); `intake/` (`.xlsx`, `.xls`, a parts report handoff); `data/` (parts inventory snapshots); `logs/admin-activity.jsonl`; `.playwright-mcp/` (page captures, `pdf-b64.txt`); `.claude/`, `.fallow/`, `samples/`, root `.png` screenshots, `spec.txt`, `DESIGN.md`, `PRODUCT.md`. The `adminTools` bundle was about 21 MB.

**Verify.** List the current bundle objects and their sizes; download one and list its contents (read only). Check `.gcloudignore` and which of those files are committed in git.

**If it holds, propose (do not do until Blake approves):**

1. An allowlist `.gcloudignore` (ignore everything, then un-ignore only what runs: `src/` or build output, the `config/` files the code actually reads at runtime, `package.json`, `package-lock.json`, `tsconfig*.json`).
2. For committed Roamer data: remove it from the repo and add it to `.gitignore`. Rewriting git history is Blake's call; present it, do not do it.
3. Build the bundle locally the way `gcloud` would and list its contents to prove it is clean before any deploy.
4. After approval, redeploy each function with its existing settings and confirm the new bundles are small and clean.
5. Find old copies: older object versions in the source bucket, Cloud Build artifacts, and Artifact Registry images built from the old bundle. Report and propose a cleanup; delete nothing without approval.
6. Confirm the scheduled jobs (`hs-ls-sync-open`, `hs-ls-sync-open-sat`, `hs-ls-audit-weekly`, `hs-ls-review-snapshot`) still run cleanly afterward.

## Part 2: How each function is protected (report only)

**Reported finding.** Every Cloud Run service here allows `allUsers` to invoke it. Each one checks callers in its own code: a shared secret for Cloud Scheduler, a signed-in rvsofamerica.com dashboard user with the Firestore `operator` role, or a HubSpot webhook signature. One bug in one check exposes that function to the internet. Also: `hubspotToLightspeed` runs on `nodejs20` while the rest run `nodejs24`, and all run as the default compute service account.

**Verify, then report** a table of all 10 functions: who legitimately calls it, how it checks the caller today, which secrets it actually needs, and whether it could be locked at the network level (Scheduler-only functions can use OIDC tokens with a restricted invoker; anything the browser dashboard or a HubSpot webhook calls must stay publicly reachable). Add a recommendation for per-function service accounts that can read only their own secrets. No IAM changes in this pass.

## Part 3: A read-only deal lookup for the Agent Hub (`rjbDealLookup`)

Build only after Blake approves the plan. If you see a better way to meet the same safety requirements, propose it; one alternative is listed at the end.

**Who can call it**

- Only `basecamp-router@roa-agent-hub.iam.gserviceaccount.com`. Grant that account `roles/run.invoker` on this one service. No `allUsers`.
- In code as well: verify the Google-signed ID token (audience is this service's URL) and that its email is exactly that service account. A network misconfiguration alone must not open it.

**What it can reach**

- Its own new service account (not the default compute account), able to read only the LightSpeed Gateway secret. No HubSpot token, no Firestore, nothing else.
- LightSpeed read endpoints only. No lead creation code in the function, and a test that fails if any non-read Gateway call appears in it.
- Writes nothing anywhere.

**Request**

`POST` JSON `{ "store": "ROA1", "dealNo": "51436" }`. `store` is one of `ROA1` (Utah), `ROA2` (South Carolina), `ROA3` (Arizona), `ROA4` (Colorado). `dealNo` is digits only. Reject anything else with 400 and no LightSpeed call.

**Response**

The same shape `adminTools` `diagnose-deal` returns today, `{ ok, result: { found: [ ... ] } }`, because the hub's trim code (`src/lightspeed/rjbView.js` in `roa-agent-hub`) already reads it. Reuse the `diagnose-deal` logic rather than writing a second copy.

Return only the fields the hub reads, so Roamer contact details never leave this project. Today that is:

- each `found[]` entry: `store`, `deal`, `customer`
- `deal`: `DealNo`, `dealstate`, `stagename`, `OriginatingDate`, `DeliveryDate`, `lastmodifieddate`, `SalesmanName`, `salesmanager`, `source`, `totaldownpayment`, `customerextraline`, `customernotes`, `Units`
- each unit: `Year`, `Make`, `Model`, `unittype`, `Newused`, `stocknumber`, `VIN`, `DateReceived`, `DaysInStore`, `deposit`, `Labor`, `Parts`
- each labor line: `SetupInstall`, `RepairOrderJobTitle`, `Description`, `RetailPrice`, `RepairOrderNumber`, `rostatus`
- each parts line: pass through for now (the hub only counts them; parts quantity fields are not understood yet, so tell Blake what each field means if you know)
- `customer`: `CustFullName`, `FirstName`, `City`, `State` only. No phone, email, street address, or anything financial about the person.

Verify these field names against a real response; if any are wrong or named differently, correct this list. Not found returns `{ ok: true, result: { found: [] } }`. LightSpeed errors return `ok: false` with a short, data-free reason. Aim for an answer within 10 seconds; the hub gives up after 20.

**Logging**

Store, deal number, found count, duration, and error type. Never deal contents or Roamer details.

**Tests**

This project's existing test pattern, scrubbed fixtures only: rejects a wrong caller, rejects bad input before calling LightSpeed, returns only the allowed fields, makes no non-read Gateway call.

**Alternative to weigh.** The hub could hold its own LightSpeed Gateway credential and call the read endpoints itself, which keeps the hub out of this project entirely. The cost: the `diagnose-deal` logic gets copied into the hub, the hub holds a credential that can create leads, and two projects then know how the Gateway works. Our current preference is `rjbDealLookup` here, since this project already owns the Gateway. Give your view.

**Repair orders (investigate only, do not build).** The hub wants per-job status on repair orders. Nothing deployed reads repair orders today. The `reports/adds/ro-jobs-*.json` files came from local scripts and hold job title, sales type, labor, and parts, but no per-job completion. Find out which LightSpeed feed those scripts used, whether it is Utah only, and whether any feed exposes per-job completion.

## What the Agent Hub will do on its side (for context)

Nothing to build here; listed so the contract is clear on both ends.

- Get an ID token from the Cloud Run metadata server with the `rjbDealLookup` URL as audience, and call it with a 20 second timeout.
- Map its store codes (`UT` to `ROA1`, and so on) before calling.
- Trim the response with `rjbView.js` before anything reaches an agent, and log only counts.
- Add a contract test built on the scrubbed sample response you send back.

## What to send back to the Agent Hub

A short note for Blake to bring to the Agent Hub session:

- Step 0 status.
- Which findings held, which did not, and what you corrected in this handoff.
- What changed in Part 1, and the Part 2 table.
- The `rjbDealLookup` URL, the exact request format, and the service account it runs as.
- A scrubbed sample response (fake name, VIN, customer and deal numbers), with any corrected field names.
- The repair order findings.
- Your view on the alternative above.
