# Month Rollover – What Happens

This section is intended for **Herzer 2.0 → Secure Timekeeping POC → Control & Automation**. It applies only to the POC and never to the live Generat or Front-end v1 setup.

At the start of a new `Europe/Berlin` calendar month, the automation checks every onboarded worker with valid D3 and D4 references. It also checks former workers (`Active = false`) so their final current month can be preserved.

For each completed D3 month, the automation:

1. Copies each D3 day to that worker’s D4 archive using the stable key `Worker Key|YYYY-MM-DD`.
2. Preserves the exact weekday, date, hours, and combined Standort/work choice. D4 keeps historic choices even when a site has become inactive.
3. Verifies the complete D4 month, then upserts and verifies the same final values in management D7. If 30 D3 source rows exist, all 30 matching rows must exist and match in both stores first.
4. Reconciles and verifies D7’s Standort relation to D8, so management location totals are final too.
5. Re-reads D3 and saves the exact verified source page/value set plus its D3/D4 routing in a hidden D1 rollover manifest before moving the first source page.
6. Soft-archives the old D3 rows only after all barriers. Each archived page is read back, and D4, D7, and D8 are verified again before the manifest is cleared. A stopped runner resumes the manifest; a concurrent edit, route change, or failed final barrier restores already-moved source pages and fails for a clean retry. No D3 page is permanently deleted.
7. Rebuilds D3’s selectable choices from currently active D8 sites plus the standard work choices. Historic D4 and D7 options are never removed.
8. Generates one D3 day for every calendar day of the new/current month for active workers only. Monday–Friday Augsburg holidays are preset as `Feiertag` with 8 hours; other days begin blank. Inactive workers retain history but receive no new D3 month.
9. Leaves D7 as the all-time management history, with the final completed-month values already secured by rollover rather than relying on a later Daily sync.

## Errors and retries

The worker’s D1 row shows `Current Month`, `Last Archived Month`, `Last Rollover At`, `Rollover Status`, and `Rollover Error`. The technical `Rollover Manifest` is hidden from normal D1 table views.

If copying or verification fails before the manifest, D3 is left visible. After the manifest, a retry continues the exact committed source snapshot; detected source drift restores pages already moved by that transaction. `Rollover Status` becomes `Error` with a diagnostic. D4 and D7 rows are matched by stable identifiers, and only missing current-month D3 dates are created.

The workflow runs every day (including weekends) and compares D3 with the current Berlin month. It does not depend on a run occurring exactly on the first of the month, so a missed run catches up safely.
