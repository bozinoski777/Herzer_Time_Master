# Annual Urlaubsmitnahme

The **Annual Urlaubsmitnahme** GitHub Action closes one vacation year for each active, `Ready` worker who was employed during that year and continues on January 1. Its first supported ending year is **2026**, creating balances dated **2027-01-01**. Former workers and people whose employment starts after the ending year receive no adjustment.

## Management setup

Enter the actual `Eintrittsdatum` (required) and, when applicable, `Austrittsdatum` in D1. Use single calendar dates without a time or date range. Onboarding validation adds these Date properties; the annual action can also add them. Existing workers need their dates entered manually. `Onboarded At` is not used to infer employment.

Keep the **ending year's** `Jahresurlaub` in D1 until its annual calculation completes. A pending calculation stores that allowance in a recovery snapshot; a later January edit cannot change the saved result. No per-year allowance database is introduced.

December must already be fully archived. The action checks `Current Month`, `Last Archived Month`, `Rollover Status = Ready`, an empty `Rollover Manifest`, and the absence of prior-year entries in D3. Enable and complete the existing Month Rollover workflow as usual. D4 must already have the canonical `Urlaubstag` formula and the `Urlaub` Standort option. If an older archive needs the vacation formula migration, complete that migration first.

The action assumes the complete ending-year vacation history is in D4, including any required legacy archive imports. Blank generated days are not used to calculate employment time.

## Calculation and the archive page

Each full employed calendar month earns `Jahresurlaub / 12`. A partial month earns that amount times **employed calendar days / calendar days in that month**. Employment start/end dates count inclusively. Sickness, holidays and vacation during employment do not reduce entitlement.

The ending-year vacation total is the sum of D4 `Urlaubstag`, including the signed balance brought into that year. The outgoing adjustment is:

```text
adjustment = ending-year vacation total - earned entitlement
```

| Entitlement | Vacation total | Adjustment | Stunden |
| --- | --- | --- | --- |
| 20 | 20 | No page | — |
| 20 | 19 | -1 day | -8 |
| 20 | 21 | +1 day | +8 |
| 10 (July 1 start) | 9 | -1 day | -8 |

A July 16 start with an annual allowance of 20 earns `20 / 12 × (16 / 31 + 5)`, approximately 9.193548 days. Fractions are retained; only floating-point noise within `1e-9` days of zero is treated as zero.

A nonzero balance creates exactly one D4 page with `Wochentag = Urlaubsmitnahme`, `Datum = January 1 of the next year`, `Standort = Urlaub`, and `Stunden = adjustment × 8`. The existing formula remains:

```text
if(prop("Standort") == "Urlaub", if(empty(prop("Stunden")), 0, prop("Stunden") / 8), 0)
```

The hidden `Sync Key` is `vacation-carryover|Worker Key|ending year`; `Source Page ID` stays empty. This separate identity preserves the page when January's real D3 entries are archived in February. It never becomes a D3 or D7 work entry. The existing calendar-year vacation chart sums the signed value, so a one-day credit starts the following year's vacation total at -1.

Previous credit/debt keeps carrying without expiry. For example, a prior -1 credit plus 19 days actually taken gives a total of 18; against 20 earned days, the following January gets -2.

## Schedule, preview and recovery

The workflow is scheduled for **00:47 Europe/Berlin every day in January**. January 1 starts the calculation; subsequent runs recover unfinished workers, and completed years perform no worker-record writes. GitHub schedules can be delayed or dropped, so the date on a carryover page is always January 1 even when it is created later. The workflow shares `herzer-notion-mutations` with the other Notion workflows.

For the first run, open **Actions → Annual Urlaubsmitnahme → Run workflow**:

1. Set `target_worker` to an exact Worker Key (preferred) or unambiguous full name.
2. Leave **preview** checked. The preview performs only reads, including no schema/view repairs, and reports entitlement, vacation total and adjustment. Only closed years from 2026 onward are accepted.
3. Verify the calculation, then run that worker again with **preview** unchecked to apply it.

Leave the worker blank to process all eligible workers. Leave `ending_year` blank to use the preceding Berlin calendar year. An explicit closed year supports recovery outside January. No new repository secrets are required; the workflow uses the existing Notion, D1, D7, D8 and frontend configuration.

D1 records `Urlaubsmitnahme Jahr`, `Urlaubsmitnahme Status` (`Running`, `Complete`, `Error`), `Urlaubsmitnahme Fehler`, and the hidden `Urlaubsmitnahme Berechnung` snapshot. The snapshot is bound to the worker and D3/D4 routes and is saved/read back **before** any carryover page is created. A retry recovers a page through its reserved key rather than blindly creating another. A zero balance still records completion without a D4 page.

Worker-specific failures are recorded in D1 while other valid workers can complete; the action as a whole fails visibly. Full-registry route collisions stop processing before schema or worker writes. If a new-year attempt fails before its checkpoint, the prior completed year's status is preserved and the new failure appears in `Urlaubsmitnahme Fehler`, allowing recovery to proceed in order.

Fix missing dates, finish Month Rollover, or resolve the reported ownership/duplicate/formula issue, then rerun. A changed ending-year vacation total after checkpointing stops recovery for review, so a stale balance is never applied automatically. Do not delete or edit a saved calculation or its carryover page to recalculate a completed year: automatic historic backfilling and retroactive recalculation are not supported. Subsequent years require the preceding applicable year to have completed. Recover missed years in chronological order before calculating a newer year.

The action validates the preceding stored balance before calculating a newer one, so deleting an old carryover cannot silently erase outstanding credit or debt. Malformed synthetic pages fail both annual calculation and monthly rollover rather than being overwritten or removed.
