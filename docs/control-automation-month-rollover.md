# Month Rollover – What Happens

This section is intended for **Herzer 2.0 → Secure Timekeeping POC → Control & Automation**. It applies only to the POC and never to the live Generat or Front-end v1 setup.

At the start of a new `Europe/Berlin` calendar month, the automation checks every onboarded worker with valid D3 and D4 references. It also checks former workers (`Active = false`) so their final current month can be preserved.

For each completed D3 month, the automation:

1. Copies each D3 day to that worker’s D4 archive using the stable key `Worker Key|YYYY-MM-DD`.
2. Preserves the exact weekday, date, hours, day type, and site. D4 keeps historic site choices even when the site has become inactive.
3. Verifies the complete D4 month before touching D3. If 30 D3 source rows exist, all 30 matching D4 archive rows must exist and match first.
4. Soft-archives the old D3 rows only after that verification. No D3 page is permanently deleted.
5. Rebuilds D3’s selectable sites from currently active D8 sites only. Historic D4 and D7 site options are never removed.
6. Generates one blank D3 day for every calendar day of the new/current month for active workers only. Inactive workers retain their D4 history but receive no new D3 month.
7. Leaves D7 as the all-time management history. Nothing is deleted from D7; the normal daily sync keeps upserting the worker’s current D3 values.

## Errors and retries

The worker’s D1 row shows `Current Month`, `Last Archived Month`, `Last Rollover At`, `Rollover Status`, and `Rollover Error`.

If copying or verification fails, D3 is left visible and unchanged. `Rollover Status` becomes `Error` with a diagnostic. Running the workflow again is safe: D4 rows are matched by their stable Sync Key, existing archive rows are updated rather than duplicated, and only missing current-month D3 dates are created.

The workflow runs every day (including weekends) and compares D3 with the current Berlin month. It does not depend on a run occurring exactly on the first of the month, so a missed run catches up safely.
