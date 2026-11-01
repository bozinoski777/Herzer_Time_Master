# Month Rollover – What Happens

This section is intended for **Herzer 2.0 → Secure Timekeeping POC → Control & Automation**. It applies only to the POC and never to the live Generat or Front-end v1 setup.

At the start of a new `Europe/Berlin` calendar month, the automation checks every onboarded worker with valid D3 and D4 references. It also checks former workers (`Active = false`) so their final current month can be preserved.

For each completed D3 month, the automation:

1. Copies each D3 page to that worker’s D4 archive using the stable key `Worker Key|YYYY-MM-DD|D3 Page ID`. Multiple split-day pages on one date remain separate entries.
2. Preserves the exact weekday, date, hours, and combined Standort/work choice. D4 keeps historic choices even when a site has become inactive. If its resulting choices exceed the 100-option limit for one schema request, archived page writes add missing choices by name instead of replacing the full dropdown list. Existing choices and colors remain; new choices receive Notion's default color on this path. An oversized change that would remove or modify existing choices fails before a schema write.
3. Verifies the complete D4 month, then upserts and verifies the same final values in management D7. If 30 D3 source rows exist, all 30 matching rows must exist and match in both stores first. D4 verification uses a bounded series of fresh reads to allow for delayed query visibility after writes; it does not create extra copies or weaken the final checks. An initial count mismatch alone does not prove why a row was absent.
4. Reconciles and verifies D7’s Standort relation to D8, so management location totals are final too.
5. Re-reads D3 and saves the exact verified source page/value set plus its D3/D4 routing in a hidden D1 rollover manifest before moving the first source page.
6. Soft-archives the old D3 rows only after all barriers. Each archived page is read back, and D4, D7, and D8 are verified again before the manifest is cleared. A stopped runner resumes the manifest; a concurrent edit, route change, or failed final barrier restores already-moved source pages and fails for a clean retry. No D3 page is permanently deleted.
7. Rebuilds D3’s selectable choices from currently active D8 sites plus the standard work choices. An interrupted or failed refresh is retried even if D1 already records the new Current Month. Historic D4 and D7 options are never removed.
8. Generates one D3 day for every calendar day of the new/current month for active workers only. Monday–Friday Augsburg holidays are preset as `Feiertag` with 8 hours; other days begin blank. Inactive workers retain history but receive no new D3 month.
9. Leaves D7 as the all-time management history, with the final completed-month values already secured by rollover rather than relying on a later Daily sync.

## Errors and retries

The worker’s D1 row shows `Current Month`, `Last Archived Month`, `Last Rollover At`, `Rollover Status`, and `Rollover Error`. The technical `Rollover Manifest` is hidden from normal D1 table views.

If copying or verification fails before the manifest, D3 is left visible. After the manifest, a retry continues the exact committed source snapshot; detected source drift restores pages already moved by that transaction. `Rollover Status` becomes `Error` with a diagnostic. D4 and D7 rows are matched by stable identifiers, and only missing current-month D3 dates are created.

The workflow runs every day (including weekends) and compares D3 with the current Berlin month. It does not depend on a run occurring exactly on the first of the month, so a missed run catches up safely.

After a code fix has been pushed to `main`, start a **new** GitHub Actions run: **Archive completed month and prepare current month** → **Run workflow** → branch **main**. Leave **simulation** unchecked and **simulated current date** blank. GitHub's **Re-run jobs** reuses the old commit and therefore does not load a later code fix. See [GitHub's rerun behavior](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs) and [manual workflow instructions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

For the November 1, 2026 recovery, use **target worker** for Kiro Ivanovski first, then Ilija Krsteski, checking each result before a new run with the target blank processes everyone. A Worker Key is preferred; the exact unique name also works. Successful recovery should leave D1 at `Current Month = 2026-11`, `Last Archived Month = 2026-10`, `Rollover Status = Ready`, with the error and manifest empty. Active workers should have all 30 November dates in D3, and D4/D7 should preserve every October source page, including split days.

Workers completed by the earlier run can be included safely: already archived months are skipped, existing archive identities are reused, and only missing current-month dates are generated. Do not clear recovery checkpoints or delete partial D4 copies before retrying. Simulation performs real writes and is unnecessary for a live retry.

The independent code-validation workflow runs syntax checks and automated tests on every push and pull request without service secrets or live Notion/SMS operations. External-service errors can still stop a worker safely and require a fresh retry.
