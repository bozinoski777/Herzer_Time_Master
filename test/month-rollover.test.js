"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// The module validates its runtime configuration at load time, but these unit
// tests exercise only exported date/simulation helpers and never call Notion.
process.env.D1_DATA_SOURCE_ID = "test-d1";
process.env.D7_DATA_SOURCE_ID = "test-d7";
process.env.D8_DATA_SOURCE_ID = "test-d8";

const {
  berlinDateParts,
  buildRolloverManifest,
  completedSourceMonths,
  historyStandortAdditions,
  manifestSourceEntries,
  monthDays,
  monthForDate,
  resolveRunConfiguration,
  parseRolloverManifest,
  sourceSnapshotMatches,
  staleD4Rows,
  validateRolloverRegistry,
  verifyD4ExactMonth,
} = require("../scripts/month-rollover");
const {
  HOLIDAY_HOURS,
  augsburgHolidayName,
  augsburgPaidHolidayName,
} = require("../scripts/augsburg-holidays");

test("Berlin calendar date crosses a UTC month boundary correctly", () => {
  assert.deepEqual(
    berlinDateParts(new Date("2026-09-30T22:30:00.000Z")),
    { year: 2026, month: 10, day: 1 },
  );
});

test("month generation covers leap-year February with German weekdays", () => {
  const days = monthDays("2028-02");
  assert.equal(days.length, 29);
  assert.deepEqual(days[0], { isoDate: "2028-02-01", weekday: "Dienstag" });
  assert.deepEqual(days.at(-1), { isoDate: "2028-02-29", weekday: "Dienstag" });
});

test("Augsburg statutory holidays include Bavaria, Mariä Himmelfahrt, and Friedensfest", () => {
  assert.equal(augsburgHolidayName("2026-04-03"), "Karfreitag");
  assert.equal(augsburgHolidayName("2026-06-04"), "Fronleichnam");
  assert.equal(augsburgHolidayName("2026-08-08"), "Augsburger Friedensfest");
  assert.equal(augsburgHolidayName("2026-08-15"), "Mariä Himmelfahrt");
  assert.equal(augsburgHolidayName("2026-10-03"), "Tag der Deutschen Einheit");
});

test("only Monday–Friday Augsburg holidays receive the standard eight-hour preset", () => {
  assert.equal(augsburgPaidHolidayName("2026-04-03"), "Karfreitag");
  assert.equal(HOLIDAY_HOURS, 8);
  assert.equal(augsburgPaidHolidayName("2026-08-08"), null);
  assert.equal(augsburgPaidHolidayName("2026-10-03"), null);
});

test("manual simulation is opt-in and limited to workflow_dispatch", () => {
  assert.deepEqual(
    resolveRunConfiguration({
      GITHUB_EVENT_NAME: "workflow_dispatch",
      ROLLOVER_SIMULATION: "true",
      ROLLOVER_SIMULATED_CURRENT_DATE: "2026-10-01",
      ROLLOVER_TARGET_WORKER: "wrk_poc_a",
    }),
    {
      targetMonth: "2026-10",
      targetWorker: "wrk_poc_a",
      simulation: true,
      liveEnabled: false,
    },
  );
  assert.throws(
    () =>
      resolveRunConfiguration({
        GITHUB_EVENT_NAME: "schedule",
        ROLLOVER_SIMULATION: "true",
        ROLLOVER_SIMULATED_CURRENT_DATE: "2026-10-01",
        ROLLOVER_TARGET_WORKER: "wrk_poc_a",
      }),
    /allowed only for workflow_dispatch/,
  );
});

test("source rows must have real ISO calendar dates", () => {
  assert.equal(monthForDate("2026-09-30"), "2026-09");
  assert.throws(() => monthForDate("2026-02-30"), /Invalid or missing calendar date/);
  assert.throws(
    () => monthForDate("2026-09-30T08:00:00.000+02:00"),
    /Invalid or missing calendar date/,
  );
});

test("rollover detects a D3 edit after D4 and D7 verification", () => {
  const row = (hours) => ({
    id: "d3-day-1",
    properties: {
      Wochentag: { title: [{ plain_text: "Montag" }] },
      Datum: { date: { start: "2026-09-01" } },
      Stunden: { number: hours },
      Standort: { select: { name: "Berlin" } },
    },
  });
  const snapshot = [{ row: row(8), sourceDate: "2026-09-01", sourceMonth: "2026-09" }];
  assert.equal(sourceSnapshotMatches(snapshot, [row(8)]), true);
  assert.equal(sourceSnapshotMatches(snapshot, [row(4)]), false);
  assert.equal(sourceSnapshotMatches(snapshot, []), false);
});

test("rollover detects a new row added to the verified source month", () => {
  const row = (id, isoDate) => ({
    id,
    properties: {
      Wochentag: { title: [{ plain_text: "Montag" }] },
      Datum: { date: { start: isoDate } },
      Stunden: { number: 8 },
      Standort: { select: { name: "Berlin" } },
    },
  });
  const original = row("d3-day-1", "2026-09-01");
  const added = row("d3-day-2", "2026-09-02");
  const snapshot = [{ row: original, sourceDate: "2026-09-01", sourceMonth: "2026-09" }];
  assert.equal(sourceSnapshotMatches(snapshot, [original, added]), false);
  assert.equal(
    sourceSnapshotMatches(snapshot, [original, row("october", "2026-10-01")]),
    true,
  );
});

function rolloverDay(id, isoDate, { workerKey, hours = 8 } = {}) {
  return {
    id,
    properties: {
      Wochentag: { title: [{ plain_text: "Montag" }] },
      Datum: { date: { start: isoDate } },
      Stunden: { number: hours },
      Standort: { select: { name: "Berlin" } },
      ...(workerKey
        ? { "Sync Key": { rich_text: [{ plain_text: `${workerKey}|${isoDate}` }] } }
        : {}),
    },
  };
}

function sourceEntry(row) {
  const sourceDate = row.properties.Datum.date.start;
  return { row, sourceDate, sourceMonth: sourceDate.slice(0, 7) };
}

test("D4 retry removes only the prior same-worker/month row after a D3 date edit", () => {
  const worker = { name: "Ada", workerKey: "worker-a" };
  const freshSource = [sourceEntry(rolloverDay("d3-edited", "2026-09-02"))];
  const stale = rolloverDay("d4-old-date", "2026-09-01", { workerKey: "worker-a" });
  const otherMonth = rolloverDay("d4-august", "2026-08-31", { workerKey: "worker-a" });

  assert.deepEqual(
    staleD4Rows(worker, "2026-09", freshSource, [stale, otherMonth]).map((row) => row.id),
    ["d4-old-date"],
  );

  const repaired = rolloverDay("d4-new-date", "2026-09-02", { workerKey: "worker-a" });
  assert.equal(
    verifyD4ExactMonth(worker, "2026-09", freshSource, [repaired, otherMonth]),
    true,
  );
});

test("D4 retry removes a deleted D3 day and exact verification rejects residual extras", () => {
  const worker = { name: "Ada", workerKey: "worker-a" };
  const source = rolloverDay("d3-kept", "2026-09-01");
  const freshSource = [sourceEntry(source)];
  const kept = rolloverDay("d4-kept", "2026-09-01", { workerKey: "worker-a" });
  const deleted = rolloverDay("d4-deleted", "2026-09-02", { workerKey: "worker-a" });

  assert.deepEqual(
    staleD4Rows(worker, "2026-09", freshSource, [kept, deleted]).map((row) => row.id),
    ["d4-deleted"],
  );
  assert.throws(
    () => verifyD4ExactMonth(worker, "2026-09", freshSource, [kept, deleted]),
    /exact-set verification failed/,
  );
  assert.equal(verifyD4ExactMonth(worker, "2026-09", freshSource, [kept]), true);
});

test("an uncheckpointed empty D3 month can reconcile a genuinely empty archive set", () => {
  const worker = { name: "Ada", workerKey: "worker-a" };
  const stale = rolloverDay("d4-deleted", "2026-09-02", { workerKey: "worker-a" });
  const otherMonth = rolloverDay("d4-august", "2026-08-31", { workerKey: "worker-a" });

  assert.deepEqual(
    staleD4Rows(worker, "2026-09", [], [stale, otherMonth]).map((row) => row.id),
    ["d4-deleted"],
  );
  assert.throws(
    () => verifyD4ExactMonth(worker, "2026-09", [], [stale, otherMonth]),
    /exact-set verification failed/,
  );
  assert.equal(verifyD4ExactMonth(worker, "2026-09", [], [otherMonth]), true);
  assert.equal(sourceSnapshotMatches([], [otherMonth], "2026-09"), true);
  assert.equal(sourceSnapshotMatches([], [stale], "2026-09"), false);
  assert.deepEqual(completedSourceMonths([], "2026-09", "2026-10", "Ada"), ["2026-09"]);
});

test("Last Archived Month prevents a completed empty/partial retry from pruning history", () => {
  assert.deepEqual(
    completedSourceMonths([], "2026-09", "2026-10", "Ada", "2026-09"),
    [],
  );
  assert.deepEqual(
    completedSourceMonths(
      [sourceEntry(rolloverDay("d3-oct", "2026-10-01"))],
      "2026-09",
      "2026-10",
      "Ada",
      "2026-09",
    ),
    [],
  );
});

test("a persisted rollover manifest preserves the full pre-archive source set", () => {
  const worker = {
    name: "Ada",
    workerKey: "worker-a",
    d3DatabaseId: "d3-db-a",
    d3DataSourceId: "d3-source-a",
    d4DatabaseId: "d4-db-a",
    d4DataSourceId: "d4-source-a",
  };
  const entries = [
    sourceEntry(rolloverDay("d3-1", "2026-09-01")),
    sourceEntry(rolloverDay("d3-2", "2026-09-02", { hours: 4 })),
  ];
  const manifest = buildRolloverManifest(worker, "2026-09", entries);
  const parsed = parseRolloverManifest(JSON.stringify(manifest), worker);
  const recovered = manifestSourceEntries(parsed);

  assert.deepEqual(recovered.map((entry) => entry.row.id), ["d3-1", "d3-2"]);
  assert.deepEqual(recovered.map((entry) => entry.sourceDate), ["2026-09-01", "2026-09-02"]);
  assert.equal(recovered[1].row.properties.Stunden.number, 4);
  assert.throws(
    () => parseRolloverManifest(JSON.stringify(manifest), { ...worker, name: "Grace", workerKey: "worker-b" }),
    /does not match this worker/,
  );
  assert.throws(
    () => parseRolloverManifest(JSON.stringify(manifest), {
      ...worker,
      d4DataSourceId: "another-d4-source",
    }),
    /D3\/D4 routing/,
  );
});

test("same-month blank or foreign D4 ownership fails closed", () => {
  const worker = { name: "Ada", workerKey: "worker-a" };
  const source = [sourceEntry(rolloverDay("d3-1", "2026-09-01"))];
  const blank = rolloverDay("d4-blank", "2026-09-01");
  const foreign = rolloverDay("d4-foreign", "2026-09-01", { workerKey: "worker-b" });
  assert.throws(
    () => staleD4Rows(worker, "2026-09", source, [blank]),
    /foreign Sync Key\/Datum ownership/,
  );
  assert.throws(
    () => verifyD4ExactMonth(worker, "2026-09", source, [foreign]),
    /foreign Sync Key\/Datum ownership/,
  );
});

test("D4 history creates missing work choices in gray", () => {
  assert.deepEqual(historyStandortAdditions([], ["Berlin", "Urlaub", "Krank"]), [
    { name: "Berlin", color: "blue" },
    { name: "Urlaub", color: "gray" },
    { name: "Krank", color: "gray" },
  ]);
});

test("rollover rejects duplicate routing across workers before mutation", () => {
  const base = {
    name: "Ada",
    workerKey: "worker-a",
    d3DatabaseId: "11111111-1111-1111-1111-111111111111",
    d3DataSourceId: "22222222-2222-2222-2222-222222222222",
    d4DatabaseId: "33333333-3333-3333-3333-333333333333",
    d4DataSourceId: "44444444-4444-4444-4444-444444444444",
  };
  assert.throws(
    () => validateRolloverRegistry([
      base,
      {
        ...base,
        name: "Grace",
        workerKey: "worker-b",
        d3DatabaseId: "55555555-5555-5555-5555-555555555555",
        d3DataSourceId: "66666666-6666-6666-6666-666666666666",
        d4DatabaseId: "77777777-7777-7777-7777-777777777777",
        d4DataSourceId: "44444444444444444444444444444444",
      },
    ]),
    /reuses D4 Data Source ID/,
  );

  assert.throws(
    () => validateRolloverRegistry([
      base,
      {
        ...base,
        name: "Grace",
        workerKey: "worker-b",
        d3DatabaseId: base.d4DatabaseId,
        d3DataSourceId: "66666666-6666-6666-6666-666666666666",
        d4DatabaseId: "77777777-7777-7777-7777-777777777777",
        d4DataSourceId: "88888888-8888-8888-8888-888888888888",
      },
    ]),
    /reuses D3 Database ID/,
  );
});
