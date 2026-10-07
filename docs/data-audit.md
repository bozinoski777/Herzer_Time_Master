# Independent data audit

The audit reads business databases and never repairs or rewrites D1, worker frontends, D3, D4, D7, or D8. Only `--publish-notion` permits writes, confined to **System Health** and its own **Datenprüfung** report database. The workflow pins the existing System Health page ID with `AUDIT_SYSTEM_HEALTH_PAGE_ID`; the publisher verifies D1 and that the destination is a private page named System Health before writing. Local runs can set the same variable. Without it, the publisher uses the earlier Secure Timekeeping POC parent lookup. The Notion integration needs access to System Health.

The permanent production boundary is **1 October 2026**. Manually migrated records dated through **30 September 2026** are outside audit coverage, including conflicting or selectively copied historical entries. No future run moves this boundary forward. Identity, routing and schema checks still cover all workers; undated records cannot be silently classified as legacy.

## Running and interpreting results

`npm run audit` checks current data and writes `audit-output/audit.json` and `audit-output/audit.md`. `npm run audit -- --scope=full` adds archives, D7 history, vacation values, and location totals **from 1 October 2026 onward**. Add `--publish-notion` to create/recover the report database and publish. The required environment variables are `NOTION_TOKEN`, `D1_DATA_SOURCE_ID`, `D7_DATA_SOURCE_ID`, and `D8_DATA_SOURCE_ID`. There is no repair mode.

The GitHub **Independent data audit** workflow offers the same two scopes and an optional **publish_notion** switch (off for manual runs by default). Reports remain available as run summaries and artifacts for 90 days. This repository is public: GitHub summaries and uploaded JSON contain only issue categories and counts, with no employee names, dates, hours, IDs, source links, or raw API errors. Detailed reports stay in private Notion; temporary detailed files on the runner are never uploaded. Local runs still produce full reports. Notion reports remain until management chooses to remove them.

- **OK / PASS:** Every applicable check in this scope completed and agrees.
- **Hinweise / WARNING:** No confirmed inconsistency, but there are coverage exceptions such as pending onboarding, or edits awaiting the next sync.
- **Fehler / ERROR:** Stable records disagree or have duplicate/missing copies or wrong links. The workflow fails.
- **Unvollständig / INCOMPLETE:** Access, schema, rollover state, unstable reads, upstream failure, or report publication prevented full verification. The workflow fails; this is never treated as a clean audit.

Each report includes scope, coverage, counts, expected/actual values, source links, and totals grouped by worker/month/Standort. The audit leaves database views untouched. System Health has two ordinary Notion status callouts showing the latest result of each scope, time, counts, coverage and report link. These update without replacing user-added content; a current pass never replaces the latest full result. It uses ordinary pages, callouts and table views, with no paid dashboard requirement. Current checks explicitly do not certify history or all-time location totals.

## Matching and exceptions

Worker Key and Source Page ID identify entries; names are display text. A rename does not create a new worker. Multiple entries on the same date are allowed. Null hours differ from zero; numeric comparisons tolerate only floating-point differences up to `1e-6`.

Current D3 entries are checked against D7 in both directions, including wrong-date copies found by source ID. Full audits additionally compare ordinary D4 history with D7 from the production boundary onward. Pre-production records are excluded, not reported as missing-copy warnings. Missing/ambiguous provenance is unverified, never silently matched by name or date.

Urlaubsmitnahme is a synthetic D4 balance and must not have a D7 work entry. Its identity, formula result and saved calculation (where available) are checked independently. The saved balance is checked even when its source year includes manually migrated history; the full-year vacation total is explicitly not certified for 2026 or earlier. Urlaubstag is calculated as Urlaub hours / 8; all other work choices contribute zero. Kurzarbeit and the other non-location choices do not need D8 locations.

Full D8 checks compare production membership and independently summed D7 hours by Standort against hours reached through the paginated D8 relations, including inactive locations. D7 dates are read to classify linked legacy rows. All relation/rollup property pages are read before comparing. A native D8 rollup containing any pre-production records is outside the audit; it must not be compared with an October-onward sum. Rollups containing only production records are compared directly. Unresolvable linked records make coverage incomplete. Two audit reads detect concurrent manual edits; changing data produces an incomplete result. In chained current audits, D3 edits after the preceding Daily run began are reported as awaiting the next sync.

Matching copies cannot prove that hours were actually worked, recover records removed from every source, verify guest permissions, or certify unrecorded historical import coverage. Unusual-hours rules are deliberately excluded.

## Scheduling and rollout

Automatic runs are disabled until repository variable `AUDIT_ENABLED` is set to `true`.

1. Deploy the code and manually run **full**, with **publish_notion=false**. Review errors and explicit coverage gaps; do not repair data through the audit.
2. Manually run **full**, with **publish_notion=true**. Verify the report under System Health.
3. Set `AUDIT_ENABLED=true` in GitHub repository Actions variables.

Then current audits run after Standort attempts chained from Daily worker sync, including failures, using a completion marker so skipped DST helper runs do not audit. A manually triggered Standort sync runs independently and does not start an audit; use the separate **Independent data audit** manual workflow when you want to check the data after consolidation. Full audits run Sundays at 04:35 Europe/Berlin. GitHub scheduling can be delayed. The existing shared concurrency group uses `queue: max` and `cancel-in-progress: false` so audits and business jobs wait for one another instead of dropping pending runs.

The stable GitHub run ID is reused on retries. A partially published report stays Unvollständig until all content is saved; ambiguous creates/appends are recovered by reading the existing report. The workflow publishes local artifacts even when data findings or Notion publication fail. Existing GitHub notification settings handle failed runs; this adds no SMS or email sender.

To stop automatic audits, set `AUDIT_ENABLED=false`. This does not change business data or remove existing reports.

## Encrypted detail downloads for this public repository

Repository variable `AUDIT_REPORT_PUBLIC_KEY` can contain an RSA public key. When configured, the GitHub artifact also includes `audit-details.enc.json`: the full JSON report encrypted with AES-256-GCM and an RSA-OAEP-SHA256 wrapped key. Only the public key is sent to GitHub. The rollout key pair is stored locally in ignored `audit-output/keys/`; preserve `private.pem` securely to retain access to these downloads.

Decrypt a downloaded artifact locally:

```sh
node scripts/audit-crypto.js --decrypt audit-details.enc.json audit-output/keys/private.pem audit-output/decrypted-audit.json
```

Notion groups repeated findings by worker/category and shows up to three linked examples per group, with all counts preserved. This keeps large historical import gaps readable. The local/encrypted JSON retains every finding and all grouped totals.
