# Independent data audit

The audit reads business databases and never repairs or rewrites D1, worker frontends, D3, D4, D7, or D8. Only `--publish-notion` permits writes, confined to its own **Datenprüfung** database beneath the verified **Control & Automation** parent of D1. That parent is management-only; the publisher inherits its access and does not create sharing links.

## Running and interpreting results

`npm run audit` checks current data and writes `audit-output/audit.json` and `audit-output/audit.md`. `npm run audit -- --scope=full` adds all archives, D7 history, vacation values, and full D8 totals. Add `--publish-notion` to create/recover the report database and publish. The required environment variables are `NOTION_TOKEN`, `D1_DATA_SOURCE_ID`, `D7_DATA_SOURCE_ID`, and `D8_DATA_SOURCE_ID`. There is no repair mode.

The GitHub **Independent data audit** workflow offers the same two scopes and an optional **publish_notion** switch (off for manual runs by default). Reports remain available as run summaries and artifacts for 90 days. Detailed reports contain worker information and are intended for repository administrators, just like the existing workflows. Notion reports remain until management chooses to remove them.

- **OK / PASS:** Every applicable check in this scope completed and agrees.
- **Hinweise / WARNING:** No confirmed inconsistency, but there are coverage exceptions such as selective September 2026 imports, pending onboarding, or edits awaiting the next sync.
- **Fehler / ERROR:** Stable records disagree or have duplicate/missing copies or wrong links. The workflow fails.
- **Unvollständig / INCOMPLETE:** Access, schema, rollover state, unstable reads, upstream failure, or report publication prevented full verification. The workflow fails; this is never treated as a clean audit.

Each report includes scope, coverage, counts, expected/actual values, source links, and totals grouped by worker/month/Standort. Separate current and full views are sorted newest first. Current checks explicitly do not certify history or all-time location totals.

## Matching and exceptions

Worker Key and Source Page ID identify entries; names are display text. A rename does not create a new worker. Multiple entries on the same date are allowed. Null hours differ from zero; numeric comparisons tolerate only floating-point differences up to `1e-6`.

Current D3 entries are checked against D7 in both directions, including wrong-date copies found by source ID. Full audits additionally compare ordinary D4 history with D7. Missing September 2026 copies are reported as legacy coverage warnings because the historical importer was selective. Existing copies must still agree. Missing/ambiguous provenance is unverified, never silently matched by name or date.

Urlaubsmitnahme is a synthetic D4 balance and must not have a D7 work entry. Its identity, formula result and saved calculation (where available) are checked independently. Urlaubstag is calculated as Urlaub hours / 8; all other work choices contribute zero. Kurzarbeit and the other non-location choices do not need D8 locations.

Full D8 checks compare both membership and the independently summed D7 hours, including inactive locations. All relation/rollup property pages are read before comparing. Two audit reads detect concurrent manual edits; changing data produces an incomplete result. In chained current audits, D3 edits after the preceding Daily run began are reported as awaiting the next sync.

Matching copies cannot prove that hours were actually worked, recover records removed from every source, verify guest permissions, or certify unrecorded historical import coverage. Unusual-hours rules are deliberately excluded.

## Scheduling and rollout

Automatic runs are disabled until repository variable `AUDIT_ENABLED` is set to `true`.

1. Deploy the code and manually run **full**, with **publish_notion=false**. Review errors and explicit coverage gaps; do not repair data through the audit.
2. Manually run **full**, with **publish_notion=true**. Verify the report and its two views under Control & Automation.
3. Set `AUDIT_ENABLED=true` in GitHub repository Actions variables.

Then current audits run after completed Standort attempts, including failures, using a completion marker so skipped DST helper runs do not audit. Full audits run Sundays at 04:35 Europe/Berlin. GitHub scheduling can be delayed. Manual runs remain available. The existing shared concurrency group uses `queue: max` and `cancel-in-progress: false` so audits and business jobs wait for one another instead of dropping pending runs.

The stable GitHub run ID is reused on retries. A partially published report stays Unvollständig until all content is saved; ambiguous creates/appends are recovered by reading the existing report. The workflow publishes local artifacts even when data findings or Notion publication fail. Existing GitHub notification settings handle failed runs; this adds no SMS or email sender.

To stop automatic audits, set `AUDIT_ENABLED=false`. This does not change business data or remove existing reports.
