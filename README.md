# Herzer 2.0 POC — Timekeeping automation

This repository automates only the **Herzer 2.0 → Secure Timekeeping POC**. It never stores a Notion token in the repository and must not be pointed at the live Generat or front-end v1 setup.

## Worker front-end and sharing model

`Employee Front-ends` is a **private management-only Notion database**. Each row is the worker's actual front-end page and its title is exactly the D1 `Vor- und Nachname` value.

```text
Employee Front-ends (management only)
└── Worker name (the page shared with that one worker)
    ├── visible properties: Vor- und Nachname, Email
    ├── six manual setup checklist items
    ├── Aktueller Monat — inline, current-month table
    ├── ─── page divider ───
    ├── Genommene Urlaubstage bis Ende letzten Monats — linked D4 number chart
    └── Archiv — inline archive table
```

The automation prepares pages and records invite readiness. It intentionally does **not** call a browser, invite guests, or change Notion sharing permissions: those actions are not part of the public Notion API and must remain a deliberate management step.

### Worker-facing presentation and the manual page-property setting

For every future worker, onboarding sets the database and data-source titles exactly to **`Aktueller Monat`** and **`Archiv`**. It configures the automatically created default table views without creating extra views:

- **Aktueller Monat:** only `Wochentag`, `Datum`, `Standort`, and `Stunden`; sorted by `Datum` ascending, with no date filter.
- **Archiv:** sorted by `Datum` descending; grouped newest-first by derived formula `Monat = formatDate(prop("Datum"), "YYYY-MM")`; `Sync Key` and the technical `Monat` property are hidden from its worker-facing table view. The formula calculates for every archive row automatically, including rows created by later rollovers.
- **Genommene Urlaubstage bis Ende letzten Monats:** a small linked D4 number chart on the worker page, placed between D3 and D4. Its filter covers January 1 through December 31 of the current Berlin calendar year. Because D4 contains only completed months, the displayed count is through the end of the prior month. It uses the existing D4 data source, creates no extra time-entry store, and rollover only updates the filter when the calendar year changes.

Notion's public API can show or hide the generated number-chart label, but cannot set that label's text (for example, replacing `Count all`) or hide the linked database view name. Those two display options require a manual Notion UI adjustment if desired.

The API can lock an individual page, but it does not expose a lock field on a database container such as D4 Archiv. It can apply an existing data-source template to a new page, but has no endpoint to create or manage the `Teil-Tag` template itself. Both are therefore explicit manual checklist steps rather than automated changes.

The internal Employee Front-ends properties **`Worker Key`** and **`D1 Record ID`** remain intact for safe recovery and routing; **`Email`** is a visible worker-facing property. Onboarding hides the two internal columns in the identifiable default **management table view**, but Notion's public API does not offer an endpoint for the properties shown on an opened row page. Every future worker page gets six unchecked Notion checklist items: frontend page **Can view**, D3 **Can edit content**, D4 **Can view**, hide the Archiv DB title/name the Urlaub chart, lock Archiv, and create the D3 `Teil-Tag` template with its date set to the current date. The permission words are bold so the required access is easy to scan.

After onboarding is `Ready` and `Sharing Status` is `Ready for Invite`:

1. Open the worker's D1 **Frontend URL**.
2. Invite the D1 **Email** address manually in Notion.
3. Apply the intended permissions manually: front-end page **Can view** (or the minimum editing permission genuinely needed), D3 **Can edit content**, D4 **Can view**.
4. Change D1 **Sharing Status** to `Invited`.

Never give a worker access to D1, D7, D8, Control & Automation, Management, the `Employee Front-ends` database, another worker's page, or the legacy migration page. Share only their individual front-end page and configure D3/D4 access separately.

## What runs

- **Onboarding** appears in GitHub as two connected stages: **1 · Validate POC setup** validates the Notion schemas and management layout without provisioning workers; **2 · Worker page, D3, Urlaub KPI & Archiv** then finds `Active = true` D1 records whose `Onboarding Status` is `Pending` or `Provisioning`. It records `Provisioning`, generates a Worker Key if needed, creates or recovers exactly one worker page in `Employee Front-ends`, adds the six-item manual checklist and visible email property, prepares D3 (`Aktueller Monat`) then D4 (`Archiv`), inserts one linked D4 vacation number chart after an idempotently recovered page divider, configures the existing default views, fills missing current-month D3 days, adds active D8 Standort options and the work choices to D3 and D4, writes IDs immediately to D1, sets `Sharing Status = Ready for Invite`, then sets `Onboarding Status = Ready`.
- **Daily sync** copies D3 to D7 using `Worker Key|Datum` as the D7 `Sync Key`, so each source day is created once or updated idempotently. Blank values are also written, so D7 reflects a worker's corrections instead of retaining stale data.
- **Standort sync** starts as its own GitHub workflow immediately after a successful Daily sync (and remains available for a manual run). It adds active D8 sites and work choices to each ready worker's D3, and removes a deactivated site only when no current D3 day still uses it. It also makes each D7 row's `Standort (D8)` relation exactly match its `Standort` select, so D8 rolls up the related `Stunden`. This includes inactive D8 locations for historic reporting and backfills matching D7 rows after a new D8 location is created manually. D4 Archiv and D7 retain every historic option. New work choices are created gray; the Notion API does not allow an existing select option's color to be changed, so existing colors are preserved safely.
- **Month rollover** runs every day, including weekends. It uses the `Europe/Berlin` calendar month, not “the first of the month,” so a missed run catches up safely. It archives every completed D3 month for workers with valid D3/D4 references (including inactive workers), verifies the worker’s D4 archive before soft-archiving any D3 source rows, and creates the current month only for `Active = true` workers. New Monday–Friday statutory holidays in Augsburg are preset as `Feiertag` with 8 `Stunden`; weekend holidays remain uncredited for the standard Monday–Friday schedule.

If a workflow stops at any point, a later run reuses D1 IDs first. If an ID is absent, it checks the one deterministic front-end row and the worker page's exact D3/D4 titles before creating anything. It also recognizes the prior `D3 · Current Month` and `D4 · Archive` titles only for crash recovery, then renames and configures those already-created databases instead of duplicating them. A legacy worker page under the approved Secure Timekeeping POC locations is moved into the index without copying its D3/D4 databases or their rows. Ambiguous matches are treated as errors rather than duplicated.

## Month rollover: safety, stages, and recovery

The rollover is a per-worker, crash-safe transaction. Its invariant is simple:

> A completed D3 month is never hidden until every one of its rows has been copied and verified in D4.

For every D3 month older than the current `Europe/Berlin` month, the workflow:

1. Sets the worker’s D1 `Rollover Status` to `Running` and clears the earlier rollover error.
2. Selects only that completed month’s D3 pages. D3 rows without a valid date, duplicate D3 dates, future dates, or ambiguous D4 records stop the worker safely with `Error`.
3. Ensures D4 has a `Sync Key` property and adds every `Standort` value used in the source rows **without removing any historic option**.
4. Upserts D4 with `Worker Key|YYYY-MM-DD`, preserving `Wochentag`, `Datum`, `Stunden`, `Standort`, and `Sync Key`. A retry updates the existing archive row rather than creating another one.
5. Re-queries D4 and verifies that each expected archive row exists exactly once and has the source values. If this barrier fails, D3 is not touched.
6. Soft-archives the old D3 source pages with the Notion page-archive API. It never hard-deletes a page. A fresh D3 query verifies that those pages are no longer visible.
7. Rebuilds the worker D3 `Standort` select from currently `Active = true` D8 sites plus the six standard work choices. This happens only after the old month is safely hidden; D4 and D7 options are never pruned.
8. For active workers only, creates missing daily rows for the current month. Augsburg statutory holidays that fall Monday–Friday are created as `Feiertag` with 8 hours; all other days begin blank. Every retry checks `Datum` first, so it can resume after a partial generation without duplicates. Inactive workers finish with an empty D3 after their final archive.
9. Records `Current Month`, `Last Archived Month`, `Last Rollover At`, and `Rollover Status = Ready` in D1. Any failure remains visible in `Rollover Error` and a later run resumes from the safe barrier.

D7 remains the all-time management store. Rollover never deletes D7 rows; normal daily sync continues to upsert current D3 values into D7.

The workflow deliberately refuses to remove a D3 `Standort` option if an already-created current-month row still uses a now-inactive site. This prevents a current value from being silently damaged; correct that current entry, then rerun the workflow.

## POC configuration

Store runtime values as **GitHub Actions secrets**. The IDs are not credentials, but this prevents accidental changes to the POC target. `NOTION_TOKEN` must never be committed or printed.

| GitHub Actions secret | Herzer 2.0 POC value |
| --- | --- |
| `NOTION_TOKEN` | The dedicated Herzer Time Master internal-integration token. |
| `D1_DATA_SOURCE_ID` | `bc10543d-d221-4da5-bd6b-c964b78b86c0` |
| `D7_DATA_SOURCE_ID` | `9c0f539e-239f-4e4c-9c4f-a8b81f74597a` |
| `D8_DATA_SOURCE_ID` | `c414e818-b278-4ade-80a5-2ede57506655` |
| `EMPLOYEE_FRONTENDS_DATA_SOURCE_ID` | `f9c03999-d2e6-4fcb-a13f-3f9fc71a3ceb` |
| `EMPLOYEE_FRONTEND_PAGE_ID` | `3d980779-bf2a-8129-b4c8-c13efb2423ee` — legacy migration fallback; retain while old workflow configuration remains. |
| `ROLLOVER_LIVE_ENABLED` | Leave unset for the first controlled simulation. Set exactly `true` only after that worker is verified and management approves automatic live rollovers. |

Add or update them in **Herzer_Time_Master → Settings → Secrets and variables → Actions**. The onboarding workflow prefers `EMPLOYEE_FRONTENDS_DATA_SOURCE_ID`; if it is temporarily empty, it safely discovers the index from the legacy POC page ID and refuses to look anywhere else.

Configure the Notion integration with **read content**, **update content**, and **insert content**, then connect it only to the Secure Timekeeping POC resources it needs:

- D1 · User Data
- D7 · Management Consolidated
- D8 · Standorte & Project Control
- Employee Front-ends
- the legacy `Employee Front-end – migrated` page only while the fallback secret remains in use

## Required Notion schema

| Resource | Required properties |
| --- | --- |
| **D1** | `Vor- und Nachname` (Title), `Email` (Email), `Active` (Checkbox), `Onboarding Status` (Select), `Onboarding Error` (Text), `Onboarded At` (Date), `Worker Key` (Text), `Frontend Page ID` (Text), `Frontend URL` (URL), `Sharing Status` (Select), `User Page ID` (legacy Text), `D3 Database ID` (Text), `D3 Data Source ID` (Text), `D4 Database ID` (Text), `D4 Data Source ID` (Text), `Urlaub Chart View ID` (Text), `Current Month` (Text), `Last Archived Month` (Text), `Last Rollover At` (Date), `Rollover Status` (Select: `Ready` / `Running` / `Error`), `Rollover Error` (Text) |
| **Employee Front-ends** | `Vor- und Nachname` (Title), `Email` (Email, visible), `Worker Key` (Text, hidden from worker), `D1 Record ID` (Text, hidden from worker) |
| **D3** created by onboarding | `Wochentag` (Title), `Datum` (Date), `Stunden` (Number), `Standort` (Select: active locations plus gray `Teil-Tag`, `Urlaub`, `Sonderurlaub`, `Überstundenausgleich`, `Feiertag`, and `Krank`) |
| **D4** | `Wochentag` (Title), `Datum` (Date), `Stunden` (Number), `Standort` (Select), `Sync Key` (Text), `Monat` (Formula: `formatDate(prop("Datum"), "YYYY-MM")`) |
| **D7** | `Wochentag` (Title), `Datum` (Date), `Stunden` (Number), `Standort` (Select), `Standort (D8)` (Relation), `Vor- und Nachname` (Text), `Worker Key` (Text), `Sync Key` (Text), `Source Page ID` (Text), `Source Database ID` (Text), `Last Synced At` (Date) |
| **D8** | `Standort` (Title), `Active` (Checkbox), `Arbeitszeiten (D7)` (Relation), `Gearbeitete Stunden` (Rollup: Sum of related D7 `Stunden`) |

`Onboarding Status` must include `Pending`, `Provisioning`, `Ready`, and `Error`. `Sharing Status` must include `Not Invited`, `Ready for Invite`, and `Invited`. D3 and D7 `Standort` use the same combined location/work-choice list.

## Legacy `Tagtyp` removal

This deployment does not change existing POC rows on its own. The new manual **Migrate legacy Tagtyp to Standort** workflow is the guarded one-time path for D3, D4, and D7 data sources reached only from the configured D1/D7 POC secrets; it accepts no free-form workspace or database ID.

Run it first with **execute** unchecked. That is a read-only preflight. If it finds a row where both `Standort` and `Tagtyp` have different values, it stops before any write: a single select cannot preserve both values without a management choice. Resolve those rows in Notion, then run it again with **execute** checked. The apply run adds the old day-type choices to `Standort`, moves a legacy value only when `Standort` is blank, verifies each moved row, removes the legacy `Tagtyp` property, and reconfigures the affected D3/D4 worker views. It is resumable after an interrupted run.

## Failure and recovery behavior

- New Worker Key, frontend-page ID/URL, and D3/D4 IDs are saved to D1 as soon as the relevant object exists.
- The D1 `Urlaub Chart View ID` is saved immediately after creating the linked chart, so a retry reuses the same chart rather than creating another one.
- Current-month day creation checks each `Datum` first; it never recreates an existing date.
- Standort synchronization preserves all existing select options before adding active D8 sites and the standard work choices.
- New D4 databases include `Sync Key` and the derived `Monat` formula from the start. The formula is read-only row data derived from `Datum`, so rollover never has to write a month value or alter existing D4 upserts.
- Rollover verifies the complete D4 archive before soft-archiving D3. It has no hard-delete code path. Re-running after a partial archive reuses D4 `Sync Key` records and creates only missing current-month D3 days.
- `Provisioning` records resume automatically. `Error` records remain visible with their diagnostic in D1 until management deliberately changes them back to `Pending`.
- D7 refuses to create more data when it finds duplicate non-empty `Sync Key` values or duplicate dates in one worker D3.
- Static validation never contacts Notion. Scripts only make API calls in GitHub Actions or when explicitly run with a token.

## Schedules and manual runs

GitHub Actions cron is always **UTC**.

| Workflow | UTC cron | Intended cadence |
| --- | --- | --- |
| Onboard workers | `17 * * * 1-5` | Every UTC weekday at `:17` |
| Daily sync | `17 6,14 * * 1-5` | 06:17 and 14:17 UTC on UTC weekdays |
| Standort sync | After successful Daily sync | Separate GitHub workflow; also manual |
| Month rollover | `17 3 * * *` | Every day at 03:17 UTC, including weekends |
| Migrate legacy Tagtyp to Standort | — | Manual only; read-only unless **execute** is checked |

GitHub Actions cron is **always UTC**. Germany is UTC+1 during CET and UTC+2 during CEST, so Daily sync runs occur at **07:17 / 15:17 CET** in winter and **08:17 / 16:17 CEST** in summer; each successful run then starts Standort sync. Rollover runs at **04:17 CET** in winter and **05:17 CEST** in summer. The script itself decides the month using `Europe/Berlin`, so a DST change cannot cause it to roll at the wrong calendar boundary. Use **Run workflow** in GitHub Actions for exceptional local-time or holiday runs.

All Notion-mutating workflows use one shared `herzer-notion-mutations` concurrency group. GitHub queues a later run instead of allowing onboarding, daily sync, rollover, and the guarded migration to mutate the same POC records at the same time.

## Controlled POC simulation

The workflow is scheduled every day, but live all-worker archival is initially **disabled**. It exits before reading or modifying Notion until the `ROLLOVER_LIVE_ENABLED` repository secret is set to exactly `true`. This makes the required first validation a deliberate manual step rather than an accidental all-worker month-boundary action.

The simulation controls exist only in **Run workflow** and are intentionally guarded:

1. Choose `Archive completed month and prepare current month` → **Run workflow**.
2. Set **simulation** to true.
3. Enter one exact D1 `Worker Key` (preferred) or one exact worker name in **target worker**.
4. Enter a real calendar date in **simulated current date**, for example `2026-10-01` to test September → October.
5. Start with a designated test worker. Confirm the log reports D4 archive verification before any D3 pages are soft-archived.
6. Inspect that worker only: D4 must contain exactly the old month’s dates and values once; D3 must show every day of the simulated month once; D7 must retain the old month without duplicate `Sync Key` values.
7. Run the same simulation again. It should report no duplicate D4 archive pages and no additional D3 days.
8. After management approves the result, add GitHub repository secret `ROLLOVER_LIVE_ENABLED` with the exact value `true`. From then on, the daily workflow uses the real Berlin date and processes all valid POC workers automatically.

Simulation changes only the selected POC worker and still performs the same safe soft-archive after D4 verification. It is not a dry-run. Never choose a production worker without approving that worker’s actual D3 rows being archived into its recoverable D4 history.

## POC Control & Automation documentation

Run the manual **Document POC month rollover** GitHub workflow once after deployment. It derives the parent page from D1 and verifies its title is exactly `Control & Automation` before adding the idempotent **Month Rollover – What Happens** section. If D1 is not directly inside that exact page, it fails without writing anything; it never accepts a free-form page ID and cannot target the live v1 setup.

## Local static check

Node 22 or later is sufficient; there are no npm dependencies. This syntax-only check never contacts Notion:

```bash
npm run check
npm test
```
