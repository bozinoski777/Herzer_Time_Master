# Herzer 2.0 POC — Timekeeping automation

This repository provisions isolated employee timekeeping databases and copies their current-month day records into one management database. It is deliberately limited to the **Herzer 2.0 Secure Timekeeping POC** IDs below. It never stores a Notion token in the repository.

## What runs

- **Onboarding** finds D1 records where `Active = true` and `Onboarding Status = Pending`, creates or recovers the worker's private page, `D3 · Current Month`, and `D4 · Archive`, then creates the current calendar month's D3 rows.
- **Standort sync** reads active D8 rows and adds their `Standort` names to the `Standort` Select options in every `Active + Ready` worker D3 and in D7. It only adds options; old options are never removed.
- **Management sync** uses `Worker Key|Datum` as the D7 `Sync Key`. Each D3 day either creates that one D7 row or updates it. Null hours and cleared `Tagtyp`/`Standort` values are written too, so D7 mirrors subsequent corrections rather than retaining stale values.

## POC configuration

The workflows read these values from **GitHub Actions secrets**. The IDs are not credentials, but keeping all runtime configuration in secrets makes the workflows portable and prevents accidental edits to the POC target.

| GitHub Actions secret | Herzer 2.0 POC value |
| --- | --- |
| `NOTION_TOKEN` | Create this value in Notion; never commit it. |
| `D1_DATA_SOURCE_ID` | `bc10543d-d221-4da5-bd6b-c964b78b86c0` |
| `D7_DATA_SOURCE_ID` | `9c0f539e-239f-4e4c-9c4f-a8b81f74597a` |
| `D8_DATA_SOURCE_ID` | `c414e818-b278-4ade-80a5-2ede57506655` |
| `EMPLOYEE_FRONTEND_PAGE_ID` | `3d980779-bf2a-8129-b4c8-c13efb2423ee` |

### Add the secrets

1. In GitHub, open **Herzer_Time_Master → Settings → Secrets and variables → Actions → New repository secret**.
2. Create all five entries from the table exactly, including the hyphens in the POC IDs.
3. Keep `NOTION_TOKEN` private. Do not put it in a local shell history, issue, pull request, workflow log, or source file.

### Configure the Notion integration

Create an internal Notion integration and use its secret as `NOTION_TOKEN`. Give it **read**, **insert content**, and **update content** capabilities, then share these POC resources with the integration:

- D1 · User Data
- D7 · Management Consolidated
- D8 · Standorte & Project Control
- Employee Front-end (the parent page)

The integration needs access to both the parent page and the data sources: it creates child pages/databases, reads data source schemas and rows, updates D1/D7 pages, and changes `Standort` Select options. The scripts use Notion API version `2026-03-11`, which treats databases as containers and performs row/schema operations through data sources. See Notion’s [database creation](https://developers.notion.com/reference/create-database), [data-source update](https://developers.notion.com/reference/update-a-data-source), and [data-source query](https://developers.notion.com/reference/query-a-data-source) documentation.

## Required Notion schema

The scripts validate these exact property names and types before writing data. Do not rename them without updating the scripts.

| Resource | Required properties |
| --- | --- |
| **D1** | `Vor- und Nachname` (Title), `Active` (Checkbox), `Onboarding Status` (Select), `Onboarding Error` (Text), `Onboarded At` (Date), `Worker Key` (Text), `User Page ID` (Text), `D3 Database ID` (Text), `D3 Data Source ID` (Text), `D4 Database ID` (Text), `D4 Data Source ID` (Text) |
| **D3** created by onboarding | `Wochentag` (Title), `Datum` (Date), `Stunden` (Number), `Tagtyp` (Select), `Standort` (Select) |
| **D7** | `Wochentag` (Title), `Datum` (Date), `Stunden` (Number), `Tagtyp` (Select), `Standort` (Select), `Vor- und Nachname` (Text), `Worker Key` (Text), `Sync Key` (Text), `Source Page ID` (Text), `Source Database ID` (Text), `Last Synced At` (Date) |
| **D8** | `Standort` (Title), `Active` (Checkbox) |

Keep the `Tagtyp` options in D7 aligned with D3: `Arbeit`, `Urlaub`, `Krank`, `Feiertag`, `Sonderurlaub`, and `Überstundenausgleich`.
`Onboarding Status` in D1 must include `Pending`, `Provisioning`, `Ready`, and `Error`.

## Recovery and safety behavior

The scripts intentionally favor detection over creating a duplicate object.

- Onboarding writes the worker page ID and each D3/D4 database/data-source ID to D1 immediately after it is created.
- If a run stops between Notion creation and that write, the next run also looks under Employee Front-end / the worker page for a single exact-name match before creating anything.
- Existing D1 IDs are reused. A `Provisioning` row is picked up on the next run; an `Error` row is not retried until a person changes its status back to `Pending`.
- A provisioning failure is written into D1 as `Onboarding Status = Error` plus `Onboarding Error` text. The Action then fails so it is visible in GitHub.
- D7 refuses to run if it already contains duplicate non-empty `Sync Key` values, and it refuses duplicate dates within one worker D3. This prevents the automation from adding more duplicates; resolve any legacy duplicate in Notion, then rerun the workflow.
- No script is run by local validation in this repository. They only contact Notion when a GitHub Action or an explicit `node scripts/...` command is run with a token.

## Schedules and manual runs

GitHub Actions cron is always **UTC**.

| Workflow | UTC cron | Intended cadence |
| --- | --- | --- |
| Onboard workers | `17 * * * 1-5` | Every UTC weekday at `:17` |
| Daily sync | `17 6,14 * * 1-5` | 06:17 and 14:17 UTC on UTC weekdays |

Germany is UTC+1 during CET and UTC+2 during CEST, so the daily runs occur at **07:17 / 15:17 CET** in winter and **08:17 / 16:17 CEST** in summer. The clock time shifts automatically at daylight-saving transitions; GitHub does not adjust the cron. UTC weekdays also govern the schedule, so use **Run workflow** for an exceptional local-time or holiday run.

Both workflows have a concurrency guard. A later run waits instead of overlapping an active run, avoiding two automations provisioning or syncing the same records concurrently.

To run manually, open **Actions**, select **Onboard workers** or **Sync Standorte and management**, then choose **Run workflow**.

## Local static check

Node 22 or later is sufficient; there are no npm dependencies. This check validates JavaScript syntax only and never calls Notion:

```bash
npm run check
```
