"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyManagementPlan,
  planManagementSync,
  relevantManagementFilter,
  validateWorkerD3DataSource,
  verifyManagementRows,
} = require("../scripts/management-sync");

function textProperty(type, value) {
  return { [type]: value ? [{ plain_text: value }] : [] };
}

function sourceRow(id, datum, { weekday = "Montag", hours = 8, standort = "Berlin" } = {}) {
  return {
    id,
    properties: {
      Wochentag: textProperty("title", weekday),
      Datum: { date: datum ? { start: datum } : null },
      Stunden: { number: hours },
      Standort: { select: standort ? { name: standort } : null },
    },
  };
}

function managementRow(
  id,
  sourcePageId,
  datum,
  {
    weekday = "Montag",
    hours = 8,
    standort = "Berlin",
    name = "Alex Example",
    workerKey = "wrk_alex",
    sourceDatabaseId = "d3-db-alex",
  } = {},
) {
  return {
    id,
    properties: {
      Wochentag: textProperty("title", weekday),
      Datum: { date: datum ? { start: datum } : null },
      Stunden: { number: hours },
      Standort: { select: standort ? { name: standort } : null },
      "Vor- und Nachname": textProperty("rich_text", name),
      "Worker Key": textProperty("rich_text", workerKey),
      "Sync Key": textProperty("rich_text", `${workerKey}|${datum}`),
      "Source Page ID": textProperty("rich_text", sourcePageId),
      "Source Database ID": textProperty("rich_text", sourceDatabaseId),
      "Last Synced At": { date: { start: "2026-09-14T06:00:00.000Z" } },
    },
  };
}

function worker(overrides = {}) {
  return {
    name: "Alex Example",
    workerKey: "wrk_alex",
    d3DatabaseId: "d3-db-alex",
    d3DataSourceId: "d3-source-alex",
    currentMonth: "2026-09",
    ...overrides,
  };
}

function monthBoundedRoute(start, end, route) {
  return {
    and: [
      { property: "Datum", date: { on_or_after: start } },
      { property: "Datum", date: { before: end } },
      route,
    ],
  };
}

test("D7 query filter limits worker routing matches to the current month", () => {
  const filter = relevantManagementFilter(worker(), [
    sourceRow("source-1", "2026-09-01"),
    sourceRow("source-2", "2026-09-02"),
    sourceRow("source-1", "2026-09-01"),
  ]);

  assert.deepEqual(filter, {
    or: [
      { property: "Source Page ID", rich_text: { equals: "source-1" } },
      { property: "Source Page ID", rich_text: { equals: "source-2" } },
      monthBoundedRoute("2026-09-01", "2026-10-01", {
        property: "Worker Key",
        rich_text: { equals: "wrk_alex" },
      }),
      monthBoundedRoute("2026-09-01", "2026-10-01", {
        property: "Source Database ID",
        rich_text: { equals: "d3-db-alex" },
      }),
      {
        property: "Sync Key",
        rich_text: { starts_with: "wrk_alex|2026-09-" },
      },
    ],
  });
});

test("D7 query filter rolls a December month bound into January", () => {
  const filter = relevantManagementFilter(worker({ currentMonth: "2026-12" }), []);

  assert.deepEqual(filter, {
    or: [
      monthBoundedRoute("2026-12-01", "2027-01-01", {
        property: "Worker Key",
        rich_text: { equals: "wrk_alex" },
      }),
      monthBoundedRoute("2026-12-01", "2027-01-01", {
        property: "Source Database ID",
        rich_text: { equals: "d3-db-alex" },
      }),
      {
        property: "Sync Key",
        rich_text: { starts_with: "wrk_alex|2026-12-" },
      },
    ],
  });
});

test("D7 query finds a current-month Sync Key even when Datum is out of month", () => {
  const filter = relevantManagementFilter(worker(), []);
  const syncKeyBranch = filter.or.find((condition) => condition.property === "Sync Key");

  assert.deepEqual(syncKeyBranch, {
    property: "Sync Key",
    rich_text: { starts_with: "wrk_alex|2026-09-" },
  });
  assert.equal("and" in syncKeyBranch, false);
});

test("date edits update the existing D7 row identified by Source Page ID", () => {
  const source = sourceRow("source-1", "2026-09-02", { weekday: "Dienstag" });
  const oldCopy = managementRow("d7-1", "source-1", "2026-09-01");
  const plan = planManagementSync(worker(), [source], [oldCopy], {
    syncedAt: "2026-09-14T07:00:00.000Z",
  });

  assert.equal(plan.archives.length, 0);
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].row.id, "d7-1");
  assert.deepEqual(plan.updates[0].properties, {
    Wochentag: {
      title: [{ type: "text", text: { content: "Dienstag" } }],
    },
    Datum: { date: { start: "2026-09-02" } },
    "Sync Key": {
      rich_text: [{ type: "text", text: { content: "wrk_alex|2026-09-02" } }],
    },
    "Last Synced At": { date: { start: "2026-09-14T07:00:00.000Z" } },
  });
});

test("changed rows patch only changed business fields plus Last Synced At", () => {
  const source = sourceRow("source-1", "2026-09-05", { hours: 8 });
  const copy = managementRow("d7-1", "source-1", "2026-09-05", { hours: 4 });
  const plan = planManagementSync(worker(), [source], [copy], {
    syncedAt: "2026-09-14T08:00:00.000Z",
  });

  assert.equal(plan.updates.length, 1);
  assert.deepEqual(plan.updates[0].properties, {
    Stunden: { number: 8 },
    "Last Synced At": { date: { start: "2026-09-14T08:00:00.000Z" } },
  });
});

test("a moved date can reuse the Sync Key of a deleted current-month source", () => {
  const moved = sourceRow("source-1", "2026-09-02", { weekday: "Dienstag" });
  const priorCopy = managementRow("d7-1", "source-1", "2026-09-01");
  const deletedCopy = managementRow("d7-2", "source-2", "2026-09-02", {
    weekday: "Dienstag",
  });
  const plan = planManagementSync(worker(), [moved], [priorCopy, deletedCopy]);

  assert.deepEqual(plan.archives.map((row) => row.id), ["d7-2"]);
  assert.deepEqual(plan.updates.map((update) => update.row.id), ["d7-1"]);
});

test("two existing D3 pages can swap dates without losing their Source Page identities", () => {
  const first = sourceRow("source-1", "2026-09-02", { weekday: "Dienstag" });
  const second = sourceRow("source-2", "2026-09-01", { weekday: "Montag" });
  const firstCopy = managementRow("d7-1", "source-1", "2026-09-01");
  const secondCopy = managementRow("d7-2", "source-2", "2026-09-02", {
    weekday: "Dienstag",
  });

  const plan = planManagementSync(worker(), [first, second], [firstCopy, secondCopy]);
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.archives.length, 0);
  assert.deepEqual(plan.updates.map((update) => update.row.id).sort(), ["d7-1", "d7-2"]);
});

test("a retry heals a date swap interrupted after only its first D7 update", () => {
  const first = sourceRow("source-1", "2026-09-02", { weekday: "Dienstag" });
  const second = sourceRow("source-2", "2026-09-01", { weekday: "Montag" });
  const firstAlreadyMoved = managementRow("d7-1", "source-1", "2026-09-02", {
    weekday: "Dienstag",
  });
  const secondNotYetMoved = managementRow("d7-2", "source-2", "2026-09-02", {
    weekday: "Dienstag",
  });

  const plan = planManagementSync(
    worker(),
    [first, second],
    [firstAlreadyMoved, secondNotYetMoved],
  );
  assert.deepEqual(plan.unchanged.map((entry) => entry.row.id), ["d7-1"]);
  assert.deepEqual(plan.updates.map((entry) => entry.row.id), ["d7-2"]);
});

test("deleted current-month D3 rows remove only their stale D7 copy", () => {
  const current = managementRow("d7-current", "deleted-source", "2026-09-03");
  const history = managementRow("d7-history", "old-source", "2026-08-03");
  const plan = planManagementSync(worker(), [], [current, history]);

  assert.deepEqual(plan.archives.map((row) => row.id), ["d7-current"]);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.creates.length, 0);
});

test("clearing a D3 date removes the former D7 row by Source Page ID", () => {
  const source = sourceRow("source-1", "");
  const copy = managementRow("d7-1", "source-1", "2026-09-04");
  const plan = planManagementSync(worker(), [source], [copy]);

  assert.deepEqual(plan.archives.map((row) => row.id), ["d7-1"]);
  assert.equal(plan.warnings.length, 1);
});

test("unchanged source rows do not receive a Last Synced At-only update", () => {
  const source = sourceRow("source-1", "2026-09-05");
  const copy = managementRow("d7-1", "source-1", "2026-09-05");
  const plan = planManagementSync(worker(), [source], [copy]);

  assert.equal(plan.unchanged.length, 1);
  assert.equal(plan.updates.length, 0);
  verifyManagementRows(worker(), [source], [copy]);
});

test("applying an unchanged plan issues no D7 writes", async () => {
  const source = sourceRow("source-1", "2026-09-05");
  const copy = managementRow("d7-1", "source-1", "2026-09-05");
  const plan = planManagementSync(worker(), [source], [copy]);
  const writes = [];

  const result = await applyManagementPlan(plan, "d7-source", {
    archivePage: async (...args) => writes.push(["archive", ...args]),
    updatePage: async (...args) => writes.push(["update", ...args]),
    createPage: async (...args) => writes.push(["create", ...args]),
  });

  assert.deepEqual(writes, []);
  assert.deepEqual(result, {
    archived: 0,
    created: 0,
    updated: 0,
    unchanged: 1,
  });
});

test("rollover mode upserts its source snapshot without pruning other D7 rows", () => {
  const source = sourceRow("source-old", "2026-08-31", { weekday: "Montag" });
  const current = managementRow("d7-current", "source-current", "2026-09-01");
  const plan = planManagementSync(worker({ currentMonth: "2026-08" }), [source], [current], {
    reconcileMissing: false,
  });

  assert.equal(plan.archives.length, 0);
  assert.equal(plan.creates.length, 1);
});

test("D7 verification rejects a stale value before D3 can be archived", () => {
  const source = sourceRow("source-1", "2026-09-06", { hours: 8 });
  const stale = managementRow("d7-1", "source-1", "2026-09-06", { hours: 4 });
  assert.throws(
    () => verifyManagementRows(worker(), [source], [stale]),
    /D7 verification failed/,
  );
});

test("final verification rejects a stale current-month row absent from D3", () => {
  const source = sourceRow("source-1", "2026-09-06");
  const exact = managementRow("d7-1", "source-1", "2026-09-06");
  const stale = managementRow("d7-2", "deleted-source", "2026-09-07");
  assert.throws(
    () => verifyManagementRows(worker(), [source], [exact, stale], { reconcileMissing: true }),
    /stale 2026-09 row/,
  );
});

test("current-month D7 rows with ambiguous ownership fail closed", () => {
  const source = sourceRow("source-1", "2026-09-06");
  const missingSourceId = managementRow("d7-1", "", "2026-09-06");
  const crossedDatabase = managementRow("d7-2", "source-1", "2026-09-06", {
    sourceDatabaseId: "another-d3-database",
  });

  assert.throws(
    () => planManagementSync(worker(), [source], [missingSourceId]),
    /ambiguous current-month ownership/,
  );
  assert.throws(
    () => planManagementSync(worker(), [source], [crossedDatabase]),
    /ambiguous current-month ownership/,
  );
});

test("D3 Datum must be a date without a time", () => {
  assert.throws(
    () => planManagementSync(worker(), [sourceRow("source-1", "2026-09-06T08:00:00.000+02:00")], []),
    /use one real date without a time/,
  );
});

test("D3 Datum rejects ranges and time zones even when start is date-only", () => {
  const ranged = sourceRow("source-range", "2026-09-06");
  ranged.properties.Datum.date.end = "2026-09-07";
  const zoned = sourceRow("source-zone", "2026-09-06");
  zoned.properties.Datum.date.time_zone = "Europe/Berlin";

  assert.throws(() => planManagementSync(worker(), [ranged], []), /ranged/);
  assert.throws(() => planManagementSync(worker(), [zoned], []), /time-bearing/);
});

test("Daily refuses malformed Current Month and D3 dates outside that month", () => {
  assert.throws(
    () => planManagementSync(worker({ currentMonth: "September 2026" }), [], []),
    /Current Month is invalid/,
  );
  assert.throws(
    () => planManagementSync(worker(), [sourceRow("source-old", "2026-08-31")], []),
    /outside D1 Current Month 2026-09/,
  );
});

test("a D7 range is healed instead of passing value verification", () => {
  const source = sourceRow("source-1", "2026-09-06");
  const ranged = managementRow("d7-1", "source-1", "2026-09-06");
  ranged.properties.Datum.date.end = "2026-09-07";

  const plan = planManagementSync(worker(), [source], [ranged]);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.unchanged.length, 0);
  assert.throws(() => verifyManagementRows(worker(), [source], [ranged]), /verification failed/);
});

test("historical duplicate Sync Keys fail before they can double-count D7", () => {
  const first = managementRow("d7-history-1", "old-source-1", "2026-08-01");
  const second = managementRow("d7-history-2", "old-source-2", "2026-08-01");
  assert.throws(
    () => planManagementSync(worker(), [], [first, second]),
    /duplicate Sync Key value wrk_alex\|2026-08-01/,
  );
});

test("full D7 snapshots expose corrupted routing for live and deleted source identities", () => {
  const source = sourceRow("source-1", "2026-09-06");
  const liveCorrupt = managementRow("d7-live", "source-1", "2026-09-06", {
    workerKey: "wrk_wrong",
    sourceDatabaseId: "wrong-database",
  });
  const deletedCorrupt = managementRow("d7-deleted", "deleted-source", "2026-09-07", {
    workerKey: "",
    sourceDatabaseId: "",
  });
  deletedCorrupt.properties["Sync Key"] = { rich_text: [{ plain_text: "wrk_alex|2026-09-07" }] };

  assert.throws(
    () => planManagementSync(worker(), [source], [liveCorrupt]),
    /ambiguous current-month ownership/,
  );
  assert.throws(
    () => planManagementSync(worker(), [source], [deletedCorrupt]),
    /ambiguous current-month ownership/,
  );
});

test("D3 data source must belong to its stored database", () => {
  const dataSource = {
    id: "d3-source-alex",
    parent: { type: "database_id", database_id: "d3-db-alex" },
    properties: {
      Wochentag: { type: "title" },
      Datum: { type: "date" },
      Stunden: { type: "number" },
      Standort: { type: "select" },
    },
  };
  assert.doesNotThrow(() => validateWorkerD3DataSource(worker(), dataSource));
  assert.throws(
    () => validateWorkerD3DataSource(worker(), {
      ...dataSource,
      parent: { type: "database_id", database_id: "another-database" },
    }),
    /belongs to database another-database/,
  );
});
