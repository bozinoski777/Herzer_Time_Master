# Herzer 2.0 POC — Timekeeping automation

This repository automates only the **Herzer 2.0 → Secure Timekeeping POC**. It never stores a Notion token in the repository and must not be pointed at the live Generat or front-end v1 setup.

## Worker front-end and sharing model

`Employee Front-ends` is a **private management-only Notion database**. Each row is the worker's actual front-end page and its title is exactly the D1 `Vor- und Nachname` value.

```text
Employee Front-ends (management only)
└── Worker name (the page shared with that one worker)
    ├── Arbeitszeiten
    │   └── D3 · Current Month — inline
    └── Archiv
        └── D4 · Archive — inline
```

The automation prepares pages and records invite readiness. It intentionally does **not** call a browser, invite guests, or change Notion sharing permissions: those actions are not part of the public Notion API and must remain a deliberate management step.

After onboarding is `Ready` and `Sharing Status` is `Ready for Invite`:

1. Open the worker's D1 **Frontend URL**.
2. Invite the D1 **Email** address manually in Notion.
3. Apply the intended permissions manually: front-end page **Can view** (or the minimum editing permission genuinely needed), D3 **Can edit content**, D4 **Can view**.
4. Change D1 **Sharing Status** to `Invited`.

Never give a worker access to D1, D7, D8, Control & Automation, Management, the `Employee Front-ends` database, another worker's page, or the legacy migration page. Share only their individual front-end page and configure D3/D4 access separately.

## What runs

- **Onboarding** finds `Active = true` D1 records whose `Onboarding Status` is `Pending` or `Provisioning`. It records `Provisioning`, generates a Worker Key if needed, creates or recovers exactly one worker page in `Employee Front-ends`, prepares inline D3 then inline D4, fills missing current-month D3 days, adds active D8 Standort options to D3 and D4, writes IDs immediately to D1, sets `Sharing Status = Ready for Invite`, then sets `Onboarding Status = Ready`.
- **Standort sync** preserves the existing D8 → D3/D7 behavior: active D8 `Standort` values are added (never removed) to every active, ready worker D3 and D7.
- **Management sync** preserves the existing D3 → D7 behavior: `Worker Key|Datum` is the D7 `Sync Key`, so each source day is created once or updated idempotently. Blank values are also written, so D7 reflects a worker's corrections instead of retaining stale data.

If a workflow stops at any point, a later run reuses D1 IDs first. If an ID is absent, it checks the one deterministic front-end row and the worker page's exact D3/D4 titles before creating anything. A legacy worker page under the approved Secure Timekeeping POC locations is moved into the index without copying its D3/D4 databases or their rows. Ambiguous matches are treated as errors rather than duplicated.

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
| **D1** | `Vor- und Nachname` (Title), `Email` (Email), `Active` (Checkbox), `Onboarding Status` (Select), `Onboarding Error` (Text), `Onboarded At` (Date), `Worker Key` (Text), `Frontend Page ID` (Text), `Frontend URL` (URL), `Sharing Status` (Select), `User Page ID` (legacy Text), `D3 Database ID` (Text), `D3 Data Source ID` (Text), `D4 Database ID` (Text), `D4 Data Source ID` (Text) |
| **Employee Front-ends** | `Vor- und Nachname` (Title), `Worker Key` (Text), `D1 Record ID` (Text) |
| **D3** created by onboarding | `Wochentag` (Title), `Datum` (Date), `Stunden` (Number), `Tagtyp` (Select), `Standort` (Select) |
| **D7** | `Wochentag` (Title), `Datum` (Date), `Stunden` (Number), `Tagtyp` (Select), `Standort` (Select), `Vor- und Nachname` (Text), `Worker Key` (Text), `Sync Key` (Text), `Source Page ID` (Text), `Source Database ID` (Text), `Last Synced At` (Date) |
| **D8** | `Standort` (Title), `Active` (Checkbox) |

`Onboarding Status` must include `Pending`, `Provisioning`, `Ready`, and `Error`. `Sharing Status` must include `Not Invited`, `Ready for Invite`, and `Invited`. Keep the D7 `Tagtyp` options aligned with D3: `Arbeit`, `Urlaub`, `Krank`, `Feiertag`, `Sonderurlaub`, and `Überstundenausgleich`.

## Failure and recovery behavior

- New Worker Key, frontend-page ID/URL, and D3/D4 IDs are saved to D1 as soon as the relevant object exists.
- Current-month day creation checks each `Datum` first; it never recreates an existing date.
- Standort synchronization preserves all existing select options before adding D8 values.
- `Provisioning` records resume automatically. `Error` records remain visible with their diagnostic in D1 until management deliberately changes them back to `Pending`.
- D7 refuses to create more data when it finds duplicate non-empty `Sync Key` values or duplicate dates in one worker D3.
- Static validation never contacts Notion. Scripts only make API calls in GitHub Actions or when explicitly run with a token.

## Schedules and manual runs

GitHub Actions cron is always **UTC**.

| Workflow | UTC cron | Intended cadence |
| --- | --- | --- |
| Onboard workers | `17 * * * 1-5` | Every UTC weekday at `:17` |
| Daily sync | `17 6,14 * * 1-5` | 06:17 and 14:17 UTC on UTC weekdays |

Germany is UTC+1 during CET and UTC+2 during CEST, so daily runs occur at **07:17 / 15:17 CET** in winter and **08:17 / 16:17 CEST** in summer. Use **Run workflow** in GitHub Actions for exceptional local-time or holiday runs.

## Local static check

Node 22 or later is sufficient; there are no npm dependencies. This syntax-only check never contacts Notion:

```bash
npm run check
```
