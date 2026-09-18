# Herzer 2.0 POC — Timekeeping automation

This repository automates only the **Herzer 2.0 → Secure Timekeeping POC**. It never stores a Notion token in the repository and must not be pointed at the live Generat or front-end v1 setup.

## Worker front-end and sharing model

`Employee Front-ends` is a **private management-only Notion database**. Each row is the worker's actual front-end page and its title is exactly the D1 `Vor- und Nachname` value.

```text
Employee Front-ends (management only)
└── Worker name (the page shared with that one worker)
    ├── visible properties: Vor- und Nachname, Email, Jahresurlaub
    ├── one gray admin checklist callout (18 checkboxes in four sections)
    ├── Aktueller Monat — inline, current-month table
    ├── ─── page divider ───
    ├── Genommene Urlaubstage bis Ende letzten Monats — linked D4 number chart
    └── Max Müllers Archiv — inline archive database with Alle and Urlaub views
```

The automation prepares pages and records invite readiness. It intentionally does **not** call a browser, invite guests, or change Notion sharing permissions: those actions are not part of the public Notion API and must remain a deliberate management step.

### Worker-facing presentation and the manual page-property setting

For every future worker, onboarding sets the D3 database and data-source titles to **`Aktueller Monat`** and the D4 titles to **`<worker full name>s Archiv`** (for example, `Max Müllers Archiv`). It configures the automatically created default table views without creating extra views:

- **Aktueller Monat:** only `Wochentag`, `Datum`, `Standort`, and `Stunden`; sorted by `Datum` ascending, with no date filter.
- **Archiv:** onboarding renames the existing default table view to **`Alle`**. It is sorted by `Datum` descending and grouped newest-first directly by the `Datum` month; no `Monat` formula is created. `Sync Key` and `Source Page ID` are hidden. Onboarding also creates or recovers a second table view named **`Urlaub`** on the *same* D4 database. It filters `Standort = Urlaub`, sorts days by `Datum` descending, and groups directly by the `Datum` year with newest years first. Neither view has a hard-coded year; later rollovers appear in the right year automatically. The extra view creates no additional archive rows or database.
- **Genommene Urlaubstage bis Ende letzten Monats:** a small linked D4 number chart on the worker page, placed between D3 and D4. Its filter covers January 1 through December 31 of the current Berlin calendar year. Because D4 contains only completed months, the displayed count is through the end of the prior month. It uses the existing D4 data source, creates no extra time-entry store, and rollover only updates the filter when the calendar year changes.

For a day worked at two locations, keep the normal D3 day page and create a second `Teil-Tag` page with the **same `Datum`**. Put the actual first and second D8 location in each page's `Standort` select, and split `Stunden` between the pages; `Teil-Tag` is the extra page's title/template, **not** the location to choose if those hours should appear in a D8 Standort total. Daily sync and rollover preserve both pages independently, and a month may therefore contain more rows than calendar days. The Urlaub chart still counts `Standort = Urlaub` archive **rows**, not distinct dates or fractional vacation days; record partial-day leave only after agreeing how that KPI should be interpreted.

Notion's public API can show or hide the generated number-chart label, but cannot set that label's text (for example, replacing `Count all`) or hide the linked database view name. Those two display options require a manual Notion UI adjustment if desired.

The API can lock an individual page, but it does not expose a lock field on a database container such as D4 Archiv. It can apply an existing data-source template to a new page, but has no endpoint to create or manage the `Teil-Tag` template itself. Both are therefore explicit manual checklist steps rather than automated changes.

The internal Employee Front-ends properties **`Worker Key`** and **`D1 Record ID`** remain intact for safe recovery and routing; **`Email`** and **`Jahresurlaub`** are visible worker-facing properties. During validation, onboarding adds `Jahresurlaub` as a Number property to D1 and Employee Front-ends when it does not exist. The onboarder must manually enter each worker's non-negative annual allowance in D1 before setting them up; a missing allowance leaves that worker waiting without creating or changing their frontend page. The worker page shows that maximum allowance at the top, with **Genommene Urlaubstage bis Ende letzten Monats** below the current-month table. Onboarding hides the two internal columns in the identifiable default **management table view**, but Notion's public API does not offer an endpoint for the properties shown on an opened row page. If the global Employee Front-ends page layout does not automatically display the new property, add `Jahresurlaub` once in **Customize layout → Properties**. Every future worker page gets one gray ☑️ callout containing 18 unchecked tasks grouped under **Aktueller Monat**, **Urlaub KPI**, **Archiv**, and **Berechtigungen**. They cover the nested Teil-Tag template title/date steps, column widths and icons, hiding the page icons in both databases (including the Archiv Urlaub view), three manual locks, chart-title/presentation adjustments, and the three individual invitations. The chart title, Teil-Tag title, and permission levels are bold. The onboarding admin deletes the completed callout; a retry recovers a partially created callout without duplicating tasks. An older flat checklist or an older combined Teil-Tag task on a partially provisioned page is left intact and flagged for manual review rather than silently discarded.

After onboarding is `Ready` and `Sharing Status` is `Ready for Invite`:

1. Open the worker's D1 **Frontend URL**.
2. Invite the D1 **Email** address manually in Notion.
3. Apply the intended permissions manually: front-end page **Can view** (or the minimum editing permission genuinely needed), D3 **Can edit content**, D4 **Can view**.
4. Change D1 **Sharing Status** to `Invited`.

Never give a worker access to D1, D7, D8, Control & Automation, Management, the `Employee Front-ends` database, another worker's page, or the legacy migration page. Share only their individual front-end page and configure D3/D4 access separately.

## What runs

- **Onboarding** appears in GitHub as two connected stages: **1 · Validate POC setup** validates and prepares the Notion schemas and management layout without provisioning workers; **2 · Worker page, D3, Urlaub KPI & Archiv** then finds `Active = true` D1 records whose `Onboarding Status` is `Pending` or `Provisioning`. It records `Provisioning`, generates a Worker Key if needed, creates or recovers exactly one worker page in `Employee Front-ends`, copies the manually entered D1 `Jahresurlaub` allowance alongside Email, adds the 18-task manual setup callout, prepares D3 (`Aktueller Monat`) then D4 (`Archiv`), inserts one linked D4 vacation number chart after an idempotently recovered page divider, configures the existing default views and the new `Urlaub` archive view, fills missing current-month D3 days, adds active D8 Standort options and the work choices to D3 and D4, writes IDs immediately to D1, sets `Sharing Status = Ready for Invite`, then sets `Onboarding Status = Ready`.
- **Daily sync** reconciles D3 to D7 using the immutable D3 `Source Page ID` first and `Worker Key|Datum|Source Page ID` as the per-entry key. Two D3 pages on one date (for example, a normal row and a `Teil-Tag` row for a second location) produce two independent D7 rows; D8 sums both sets of hours. Each normal worker sync queries only that worker's D1 `Current Month`, the matching month-specific Sync Keys, and the exact current D3 Source Page IDs needed to recover a moved or malformed date; it does not paginate through the worker's older D7 history. Changing a date updates the same management row; clearing a date or deleting a current-month D3 page soft-removes its stale D7 copy without touching prior-month history. Existing date-only D7 keys are upgraded in place on first sync. Thereafter, rows receive only the business/routing properties whose values actually changed, and `Last Synced At` is written only alongside such a change—an unchanged worker produces no D7 PATCH requests. Final offboarding and month-rollover retain their deliberately broader safety verification. A valid pending rollover manifest is skipped so Daily cannot misread already-archived source pages as deletions; malformed or stale checkpoints fail visibly instead of being ignored. Ready inactive workers continue through this sync until their manual access-revocation checklist and verified final sync are complete.
- **Standort sync** starts as its own GitHub workflow after the Daily D3→D7 command finishes (and remains available for a manual run). If one Daily or worker-specific D3 operation fails after other writes succeeded, the independent D7/D8 reconciliation still runs and both failures remain visible. It adds active D8 sites and work choices to each ready worker's D3, and removes a deactivated site only when no current D3 day still uses it. Workers with a pending rollover checkpoint are left untouched. It also makes each D7 row's `Standort (D8)` relation exactly match its `Standort` select, so D8 rolls up the related `Stunden`. The chained run queries only rows whose select/relation combination can be wrong, including all historical rows that need backfilling after a new matching D8 location is created; it then verifies the same candidate set after repair. Once that relation is verified, it checks every D8 Standort row page (active and inactive) for two ordinary linked D7 views: a small `Arbeitsstunden gesamt` number chart summing `Stunden`, followed by a filtered D7 table sorted by `Datum` descending. The table shows only `Name`, `Wochentag`, `Datum`, and `Stunden`, in that order; `Standort` is hidden because the view already filters to that location. `Name` is a read-only D7 formula reflecting `Vor- und Nachname`, so existing D7 sync fields do not change. Existing matching views are reused; a partial create is recovered on the next run. A manual run can enable **Check every historical D7 relation** for an exhaustive audit, including an otherwise invisible orphan extra relation. D4 Archiv and D7 retain every historic option. New work choices are created gray; the Notion API does not allow an existing select option's color to be changed, so existing colors are preserved safely.

The Standort page uses no Business-plan dashboard and no worker-name list. If an earlier run created the managed `Standort-KPIs` dashboard, the next successful sync checks that it contains only the two expected automation widgets, creates/verifies the replacement chart and table, then moves that old linked dashboard to Notion's Trash. A customized dashboard is left untouched and requires manual review. The former `Mitarbeitende (einmalig)` D8 rollup, if already created, is not deleted from the schema. The two new linked views reference the existing D7 store; they do not copy time rows. Notion's linked-view API appends new content after other existing D8 page blocks, so an administrator may need to move the chart/table pair to the very top of an older page. Notion permits charts on paid plans without Business, but a Free workspace can display only one chart in total; a Free workspace with its chart slot already in use cannot provision a chart on every Standort page.
- **Month rollover** runs every day, including weekends. It uses the `Europe/Berlin` calendar month, not “the first of the month,” so a missed run catches up safely. Before any worker changes, it checks the complete D1 registry—including records outside a targeted simulation—and rejects incomplete, duplicate, or crossed D3/D4 routing. It then makes D4, D7, and D7’s D8 relation match the final completed-month D3 snapshot before soft-archiving any source row, and verifies those barriers again afterward. A hidden D1 rollover manifest is bound to the exact worker and D3/D4 routes, making a runner crash resumable without mistaking already-archived D3 pages for worker deletions. New Monday–Friday Augsburg holidays are preset as `Feiertag` with 8 `Stunden`; weekend holidays remain uncredited for the standard Monday–Friday schedule.

If a workflow stops at any point, a later run reuses D1 IDs first. If an ID is absent, it checks the one deterministic front-end row and the worker page's exact D3/D4 titles before creating anything. It also recognizes the prior `Archiv`, `D3 · Current Month`, and `D4 · Archive` titles only for crash recovery, then renames and configures those already-created databases instead of duplicating them. A legacy worker page under the approved Secure Timekeeping POC locations is moved into the index without copying its D3/D4 databases or their rows. Ambiguous matches are treated as errors rather than duplicated.

## Shared automation services

The workflows use a small set of common contracts instead of maintaining similar safety logic independently:

- `worker-identity.js` treats the exact D1 row ID as the primary frontend identity and the exact non-empty Worker Key as the only recovery fallback. Worker names are never identifiers.
- `worker-database-references.js` parses D3/D4 routes, detects duplicate or crossed references, validates a data source against its stored database ID, and can verify that a database remains under the expected worker frontend page.
- `day-schemas.js` owns the D3 day contract and D4 archive extension. `archive-presentation.js` owns D4 schema repair, worker-specific title, direct `Datum` month grouping, sort order, and hidden technical columns.
- `management-sync.js` is the single D7 upsert/reconciliation service used by both Daily sync and Month rollover. Normal Daily reads are worker/month scoped, and existing D7 pages receive minimal property PATCHes; rollover and final offboarding can still request a full-history safety audit.
- `standort-presentation.js` creates or recovers the small linked D7 number chart and filtered table on D8 row pages. It adds the computed D7 `Name` column when missing and safely retires only the prior automation-owned dashboard view. The Standort workflow runs this only after D7→D8 relation verification succeeds.
- `select-options.js` plans and applies color-safe select updates. Existing option IDs never carry a color update, and current-row values can be protected from removal.

Keeping these boundaries shared means onboarding, Daily sync, Standort sync, rollover, and the guarded legacy migration validate the same identities and data shapes before writing.

## Month rollover: safety, stages, and recovery

The rollover is a per-worker, crash-safe transaction. Its invariant is simple:

> A completed D3 month is never hidden until every one of its rows has been copied and verified in both D4 and management D7.

For every D3 month older than the current `Europe/Berlin` month, the workflow:

1. Preflights every Ready worker before touching time rows: Worker Key, D3 database/data-source pair, and D4 database/data-source pair must be complete, unique, and correctly parented.
2. Sets the worker’s D1 `Rollover Status` to `Running`, clears the earlier error, and selects only one completed D3 month. Missing, time-bearing, future, or ranged dates and duplicate page IDs stop safely with `Error`; multiple distinct D3 pages may share one date.
3. Ensures D4 has hidden `Sync Key` and `Source Page ID` properties and adds every `Standort` value used in the source rows **without removing any historic option**.
4. Upserts each D3 page into D4 with `Worker Key|YYYY-MM-DD|D3 Page ID`, preserving `Wochentag`, `Datum`, `Stunden`, `Standort`, and source identity. A retry updates the existing archive row rather than creating another one. An unambiguous older date-only D4 row is upgraded in place; an old row without source identity on a date with multiple D3 entries fails closed for manual review.
5. Re-queries D4 and verifies that each expected archive row exists exactly once and has the source values. If this barrier fails, D3 is not touched.
6. Uses the same Source Page ID-aware reconciler as Daily sync to make D7 exact for that final month, then reads it back and verifies every value.
7. Reconciles and verifies D7’s `Standort (D8)` relation, so D8 hours are correct before D3 is hidden.
8. Re-queries D3, then saves a hidden `Rollover Manifest` containing the exact verified source page/value snapshot plus the worker's D3/D4 database and data-source routes before the first D3 archive call.
9. Soft-archives each old D3 page, reads it back, verifies both its final values and trash state, then verifies D4, D7, and D8 again. If an edit, new row, route change, or final-barrier failure is detected during this window, pages archived by the transaction are restored and the run fails for a clean retry. A runner crash resumes the saved manifest, including pages already archived before the crash.
10. Rebuilds the worker D3 `Standort` select from currently `Active = true` D8 sites plus the six standard work choices. This happens only after the old month is safely hidden; historic D4 and D7 options are never pruned.
11. For active workers only, creates missing daily rows for the current month. Augsburg statutory holidays that fall Monday–Friday are created as `Feiertag` with 8 hours; all other days begin blank. Every retry checks `Datum` first, so it can resume after a partial generation without duplicates. Inactive workers finish with an empty D3 after their final archive.
12. In one D1 update, records both the completed `Last Archived Month` and target `Current Month` while clearing the manifest. It then records `Last Rollover At` and `Rollover Status = Ready`. Any failure remains visible in `Rollover Error`.

D7 remains the all-time management store. For the one D1 `Current Month` being finalized, rollover removes only stale copies that are demonstrably absent from the pre-archive D3 snapshot, then verifies the exact result. Earlier months are outside that cleanup scope.

## Offboarding

Notion's public API cannot revoke or verify ordinary guest shares. D1 therefore contains a management-owned offboarding state plus three checkbox attestations: `Frontend Access Revoked`, `D3 Access Revoked`, and `D4 Access Revoked`. Onboarding validation makes these fields, `Offboarding Status`, `Offboarding Error`, and `Final Sync At` visible in every D1 table view.

1. Set the Ready worker's D1 `Active` property to false. Daily sync continues syncing that worker and sets `Offboarding Status = Revoke Access`; no new D3 month is created after their final rollover.
2. Remove the guest share from the individual frontend page, `Aktueller Monat`, and `Archiv`, then check the matching three D1 boxes. A box is a human attestation; the API cannot confirm the share itself.
3. The next Daily sync first records `Final Sync`, reconciles D3 to D7, reads D7 back, and re-reads both D1 and D3 to ensure neither changed during the final sync. Only then does it record `Offboarding Status = Complete`, `Final Sync At`, and `Sharing Status = Revoked`.

An inactive worker remains in Daily sync until this completes. Failures set `Offboarding Status = Error` and `Offboarding Error`, then retry on the next run. A completed inactive worker is skipped. For reactivation, restore all three shares, clear the three checkboxes, set `Offboarding Status = Active`, and set `Active = true`; contradictory active/offboarding states fail safely rather than silently reopening access.

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
| `TWILIO_ACCOUNT_SID` | The Account SID from the Twilio Console. Required only by the monthly SMS reminder workflow. |
| `TWILIO_API_KEY_SID` | **Recommended for paid production use.** A live Twilio API Key SID beginning with `SK`, created in the same Twilio account as the Messaging Service. |
| `TWILIO_API_KEY_SECRET` | The secret shown once when that API key is created. Treat it as a credential; never commit or print it. |
| `TWILIO_AUTH_TOKEN` | Optional fallback when no API key pair is configured. The live Auth Token for that account; never commit or print it. |
| `TWILIO_MESSAGING_SERVICE_SID` | **Recommended for SMS reminders.** The `MG...` SID of the paid Twilio Messaging Service that owns the approved sender pool. When present, it takes precedence over `TWILIO_FROM_NUMBER`. |
| `TWILIO_FROM_NUMBER` | Optional legacy fallback when no Messaging Service SID is configured. An approved Twilio sender: normally an E.164 Twilio number, or an approved alphanumeric sender ID where Twilio permits it. |

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
| **D1** | `Vor- und Nachname` (Title), `Email` (Email), `Jahresurlaub` (Number), `Active` (Checkbox), `Onboarding Status` (Select), `Onboarding Error` (Text), `Onboarded At` (Date), `Worker Key` (Text), `Frontend Page ID` (Text), `Frontend URL` (URL), `Sharing Status` (Select), `User Page ID` (legacy Text), `D3 Database ID` (Text), `D3 Data Source ID` (Text), `D4 Database ID` (Text), `D4 Data Source ID` (Text), `Urlaub Chart View ID` (Text), `Current Month` (Text), `Last Archived Month` (Text), `Last Rollover At` (Date), `Rollover Status` (Select: `Ready` / `Running` / `Error`), `Rollover Error` (Text), `Rollover Manifest` (hidden Text checkpoint), `Offboarding Status` (Select: `Active` / `Revoke Access` / `Final Sync` / `Complete` / `Error`), `Offboarding Error` (Text), `Final Sync At` (Date), `Frontend Access Revoked` / `D3 Access Revoked` / `D4 Access Revoked` (Checkboxes), plus the SMS fields described below. |
| **Employee Front-ends** | `Vor- und Nachname` (Title), `Email` (Email, visible), `Jahresurlaub` (Number, visible), `Worker Key` (Text, hidden from worker), `D1 Record ID` (Text, hidden from worker) |
| **D3** created by onboarding | `Wochentag` (Title), `Datum` (Date), `Stunden` (Number), `Standort` (Select: active locations plus gray `Teil-Tag`, `Urlaub`, `Sonderurlaub`, `Überstundenausgleich`, `Feiertag`, and `Krank`) |
| **D4** | `Wochentag` (Title), `Datum` (Date), `Stunden` (Number), `Standort` (Select), `Sync Key` (Text), `Source Page ID` (Text). Newly created archives do not have a `Monat` formula. |
| **D7** | `Wochentag` (Title), `Datum` (Date), `Stunden` (Number), `Standort` (Select), `Standort (D8)` (Relation), `Vor- und Nachname` (Text), `Name` (Formula: `prop("Vor- und Nachname")`, added by Standort sync for the D8 view), `Worker Key` (Text), `Sync Key` (Text), `Source Page ID` (Text), `Source Database ID` (Text), `Last Synced At` (Date) |
| **D8** | `Standort` (Title), `Active` (Checkbox), `Arbeitszeiten (D7)` (Relation), `Gearbeitete Stunden` (Rollup: Sum of related D7 `Stunden`). The old optional `Mitarbeitende (einmalig)` rollup may remain but is no longer used or created. |

`Onboarding Status` must include `Pending`, `Provisioning`, `Ready`, and `Error`. `Sharing Status` includes `Not Invited`, `Ready for Invite`, `Invited`, and `Revoked`. D3 and D7 `Standort` use the same combined location/work-choice list. Onboarding validation and Daily sync add the offboarding properties/options idempotently when they are missing.

## Monthly SMS reminders

`SMS reminders for incomplete time entries` runs at **08:17 in Europe/Berlin twice per month**: on the third Friday, and again exactly five calendar days before the final day of the month. It can also be started through **Actions → Run workflow** on or after the third Friday. It checks the current Berlin calendar month in each worker's existing D3 `Aktueller Monat` table; it does not wait for or use Month Rollover/D4.

Each check requires the **entire current month** to be complete: every Monday–Friday date from the first through the final calendar day must have a D3 row with both `Stunden` and `Standort`, including dates later in the month. It ignores days before the existing D1 `Onboarded At` date. A required date is incomplete when it has no D3 row, or when any D3 row for that date lacks either `Stunden` or `Standort`; this also catches an unfinished additional `Teil-Tag` row. It considers only D1 rows with `Active = true` and `Onboarding Status = Ready`, and refuses to use a worker whose D1 `Current Month` does not match the current Berlin month.

The action creates these D1 properties on its first successful schema check; do not create a second copy with a different name:

| D1 property | Type and use |
| --- | --- |
| `SMS Telefonnummer` | **Phone**. Management must enter every recipient in E.164 form, for example `+491701234567`. It stays in private D1 and is never copied to the worker front-end. |
| `SMS Reminder Month` | **Text**. The protected reminder cycle, for example `2026-09:third-friday` or `2026-09:five-days-before-month-end`. |
| `SMS Reminder Status` | **Select**: `Sending`, `Accepted`, `Failed`, or `Uncertain`. `Accepted` means Twilio accepted the Message request; it is not a delivery receipt. |
| `SMS Reminder Sent At` | **Date** when Twilio accepted the request. |
| `SMS Reminder Twilio SID` | **Text** identifier for the accepted Twilio Message. |
| `SMS Reminder Error` | **Text** with a safe-to-review configuration or Twilio failure summary. |

Duplicate protection is deliberately conservative and applies independently to each of the two reminder cycles. Before the Twilio request, the action stores `SMS Reminder Month` and `SMS Reminder Status = Sending` in D1. A manual rerun never sends the same cycle when the status is `Sending`, `Accepted`, `Uncertain`, blank, or unrecognized, including if the runner stopped after a request may have reached Twilio. A confirmed Twilio 4xx failure becomes `Failed`, which may be retried manually after fixing the phone, sender, or Twilio configuration. For `Sending` or `Uncertain`, first check the Twilio Message Log using the D1 sender/recipient context; set the status to `Accepted` if it was sent, or to `Failed` only after confirming no message exists, then run the workflow again. Resolve an `Uncertain` result before the next cycle; the action blocks further reminders for that worker until it is reviewed.

For paid Twilio production use, create a **live Standard API Key** in the same Twilio account as the Messaging Service and save its `SK...` SID and one-time secret as `TWILIO_API_KEY_SID` and `TWILIO_API_KEY_SECRET`. The workflow prefers this pair over an Auth Token. Create a **Messaging Service** in Twilio, add an approved sender to its Sender Pool, and save its `MG...` ID as `TWILIO_MESSAGING_SERVICE_SID`. For German one-way reminders, Twilio supports a dynamic alphanumeric sender ID such as `HERZER`; it must be configured in that Messaging Service and can only be used on a paid account. The workflow then sends `MessagingServiceSid` rather than selecting a sender itself. Workers must have agreed to receive these messages, and the text includes a non-SMS route to opt out through management.

For the first live check, add the Twilio secrets above, fill `SMS Telefonnummer` for one designated test worker, then open **Actions → SMS reminders for incomplete time entries → Run workflow**. In `target_worker`, enter that worker's exact D1 `Worker Key` (preferred) or exact `Vor- und Nachname`; only that active, ready worker can be selected. Leave `target_worker` blank only when you deliberately want to check all eligible workers. A Twilio trial can send only to verified recipient numbers and predefined templates; upgrade before expecting this custom employee reminder to deliver. The workflow does not print phone numbers, SMS text, Auth Tokens, or Twilio API responses.

## Legacy `Tagtyp` removal

There is no GitHub Actions workflow for this retired one-time helper. `scripts/migrate-tagtyp-to-standort.js` remains a guarded local recovery utility for D3, D4, and D7 data sources reached only from the configured D1/D7 POC values; it accepts no free-form workspace or database ID.

Running the script without `TAGTYP_MIGRATION_EXECUTE=true` is a read-only preflight. If it finds a row where both `Standort` and `Tagtyp` have different values, it stops before any write: a single select cannot preserve both values without a management choice. The explicit apply mode adds the old choices to `Standort`, moves a legacy value only when `Standort` is blank, verifies each moved row, removes `Tagtyp`, and reconfigures affected D3/D4 views.

## Failure and recovery behavior

- New Worker Key, frontend-page ID/URL, and D3/D4 IDs are saved to D1 as soon as the relevant object exists.
- The D1 `Urlaub Chart View ID` is saved immediately after creating the linked chart, so a retry reuses the same chart rather than creating another one.
- Current-month day creation checks each `Datum` first; it never recreates an existing date.
- Standort synchronization preserves all existing select options before adding active D8 sites and the standard work choices.
- New D4 databases include hidden `Sync Key` and `Source Page ID` without a derived month property. Existing D4 schemas gain the missing source-ID field on rollover; their `Alle` and `Urlaub` views are refreshed to group directly by `Datum` and to hide an older, unused `Monat` formula if one exists. The formula is not deleted from existing archives, and rollover never has to write a month value.
- Rollover verifies D4, D7, and D8 relation state before soft-archiving D3. It has no hard-delete code path. Its hidden pre-archive manifest resumes after a partial source archive; detected concurrent edits restore the transaction’s source pages before failing.
- `Provisioning` records resume automatically. `Error` records remain visible with their diagnostic in D1 until management deliberately changes them back to `Pending`.
- D7 refuses ambiguous duplicate `Sync Key` or `Source Page ID` values within every result it reconciles. Normal Daily checks the relevant current-month routes and exact current Source Page IDs; rollover and final offboarding deliberately retain full-history duplicate checks. Date edits update the row with the same Source Page ID; missing or undated current-month sources are soft-removed, while historical months are outside that reconciliation scope.
- Static validation never contacts Notion. Scripts only make API calls in GitHub Actions or when explicitly run with a token.

## Schedules and manual runs

GitHub Actions cron defaults to **UTC**. Existing workflows below use the UTC/DST cadence guard; the SMS workflow uses GitHub's timezone-aware schedule directly.

| Workflow | Schedule | Intended cadence |
| --- | --- | --- |
| Onboard workers | — | Manual only, when a prepared worker should be provisioned |
| Copy old archive to one worker | — | Manual, one named worker and one destination D4 per run; never scheduled |
| Daily sync | `15 5,6,13,14 * * 1-5` | Exactly 07:15 and 15:15 Europe/Berlin on weekdays; two UTC entries are safely skipped for DST |
| Standort sync | After the Daily D3→D7 command finishes | Separate GitHub workflow; also manual; targeted by default, with an optional full-history D7 relation audit |
| Month rollover | `15 22,23 * * *` | Exactly 00:15 Europe/Berlin every day, including weekends; one UTC entry is safely skipped for DST |
| SMS reminders for incomplete time entries | `17 8 * * *`, timezone `Europe/Berlin`, with a two-date cadence gate | 08:17 Berlin time on the third Friday and five calendar days before month-end; checks every current-month D3 weekday and is also manual |

The existing daily and rollover schedules deliberately include both possible UTC offsets, then a tiny cadence job uses `Europe/Berlin` to allow only the matching entry: Daily Worker Sync therefore runs at **07:15 and 15:15 Berlin time** throughout the year, and Month Rollover runs at **00:15 Berlin time**. The SMS workflow uses GitHub's IANA `timezone` setting and wakes daily at 08:17 Berlin time; its cadence job permits only the third Friday (the Friday dated 15–21) and the date exactly five calendar days before month-end. The completed Daily command publishes a short-lived marker even when one worker failed after another worker's D7 writes succeeded; that marker starts the independent Standort Sync, while the Daily run remains red. A skipped daylight-saving helper run has no marker and cannot perform a Standort sync. Rollover remains daily, rather than only on the first of the month, so it catches up safely after a missed GitHub run. Use **Run workflow** in GitHub Actions for exceptional local-time or holiday runs.

All Notion-mutating workflows use one shared `herzer-notion-mutations` concurrency group, so they never run concurrently. GitHub retains at most one pending run in a concurrency group; it is not a durable queue. Daily and rollover schedules repeat, and Standort sync is also manually runnable if a pending run is superseded.

## One-worker copy from the old shared archive

The manual **Copy old archive to one worker** action reads only the pinned legacy `Archiv` database `4206edef-dfc8-435c-b9a9-296500003907` (data source `13ee17a3-c636-42fa-90cd-08a6cb719628`). It **never edits, removes, or archives an old record**. Connect the same Notion integration to that old archive with read access before running the action. The destination must be an already-onboarded, empty worker D4 archive in this POC; the action refuses any unrelated existing row. Do not point it at a live v1/Generat database.

1. Open **Actions → Copy old archive to one worker → Run workflow**. Enter the worker's exact D1 `Vor- und Nachname` in **Name** and that worker's new D4 archive **database ID or data-source ID** in **destination_archive**. These are the action's only inputs. If two D1 workers have the same exact name, the action refuses to choose one.
2. The first stage reads and checks the worker, frontend identity, source/destination schemas and ownership, dates, and destination state. It does not write. The second stage repeats those checks, then copies only old rows whose `Vor- und Nachname` matches exactly and whose `Date` is **earlier than `2026-09-01`**. **1 September 2026 itself and every later date are excluded.** A missing, ranged, timed, or invalid source date fails the run instead of silently importing it.
3. The copy maps `Wochentag → Wochentag`, `Date → Datum`, `Stunden → Stunden`, and `Standort → Standort`. It adds only missing Standort select choices to the destination D4, keeping existing choices/colors. It also sets hidden `Sync Key` and `Source Page ID` to identify each copied old page. Two old pages on one date remain two separate archive entries. The existing `Alle`/`Urlaub` D4 views and vacation chart see the copied rows automatically; no extra database or view is created.
4. Check the final verified count in the action log and review the destination D4. If the run stops mid-copy, rerun it with the same two inputs: exact existing copies are skipped and only missing pages are created. A changed, duplicate, or unexpected destination row stops the action for manual review; it never overwrites that row. Requests use the shared Notion pacing/retry policy, but page creates are not automatically retried after an ambiguous network result.

This migration populates **D4 only**. It does not backfill historical D7 management records or D8 totals. Run it only after the worker's D1 `Current Month` is September 2026 or later and no rollover is pending. Importing a historical `Urlaub` row may affect the worker's current-year vacation KPI; the old archive remains unchanged.

## Controlled POC simulation

The workflow is scheduled every day, but live all-worker archival is initially **disabled**. It exits before reading or modifying Notion until the `ROLLOVER_LIVE_ENABLED` repository secret is set to exactly `true`. This makes the required first validation a deliberate manual step rather than an accidental all-worker month-boundary action.

The simulation controls exist only in **Run workflow** and are intentionally guarded:

1. Choose `Archive completed month and prepare current month` → **Run workflow**.
2. Set **simulation** to true.
3. Enter one exact D1 `Worker Key` (preferred) or one exact worker name in **target worker**.
4. Enter a real calendar date in **simulated current date**, for example `2026-10-01` to test September → October.
5. Start with a designated test worker. Confirm the log reports both D4 and D7 barrier verification before any D3 pages are soft-archived.
6. Inspect that worker only: D4 and D7 must each contain one row per final old-month D3 page with the correct values (multiple rows may share a date); D3 must have at least one row for every day of the simulated month; D7 must have no duplicate `Sync Key` or `Source Page ID` values.
7. Run the same simulation again. It should report no duplicate D4 archive pages and no additional D3 days.
8. After management approves the result, add GitHub repository secret `ROLLOVER_LIVE_ENABLED` with the exact value `true`. From then on, the daily workflow uses the real Berlin date and processes all valid POC workers automatically.

Simulation changes only the selected POC worker and still performs the same safe soft-archive after D4 verification. It is not a dry-run. Never choose a production worker without approving that worker’s actual D3 rows being archived into its recoverable D4 history.

## POC Control & Automation documentation

There is no documentation GitHub workflow. The version-controlled runbook is `docs/control-automation-month-rollover.md`. The guarded local `scripts/document-control-automation.js` can add the section only when D1’s direct parent title is exactly `Control & Automation`; it deliberately does not rewrite an existing section and must never be pointed at live v1.

## Local static check

Node 22 or later is sufficient; there are no npm dependencies. This syntax-only check never contacts Notion:

```bash
npm run check
npm test
```
