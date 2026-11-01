"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { compileFunction } = require("node:vm");

// The module validates runtime configuration at load time. Tests exercise its
// helpers and transactions with mocked API boundaries and never call Notion.
process.env.D1_DATA_SOURCE_ID = "test-d1";
process.env.D7_DATA_SOURCE_ID = "test-d7";
process.env.D8_DATA_SOURCE_ID = "test-d8";

const {
  archiveProperties,
  berlinDateParts,
  buildRolloverManifest,
  completedSourceMonths,
  historyStandortAdditions,
  legacyD4MigrationPlan,
  manifestSourceEntries,
  monthDays,
  monthForDate,
  resolveRunConfiguration,
  parseRolloverManifest,
  sourceSnapshotMatches,
  staleD4Rows,
  validateD3Rows,
  validateRolloverRegistry,
  verifyD4ExactMonth,
  waitForD4ExactMonth,
} = require("../scripts/month-rollover");
const {
  HOLIDAY_HOURS,
  augsburgHolidayName,
  augsburgPaidHolidayName,
} = require("../scripts/augsburg-holidays");
const { daySyncKey } = require("../scripts/day-sync-key");
const { carryoverKey } = require("../scripts/vacation-carryover-record");

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

test("rollover accepts two distinct D3 pages on one calendar date", () => {
  const regular = rolloverDay("regular-page", "2026-09-16");
  const partDay = rolloverDay("teil-tag-page", "2026-09-16");
  const worker = { name: "Ada" };
  assert.deepEqual(
    validateD3Rows([regular, partDay], worker, "2026-10")
      .map((entry) => entry.row.id),
    ["regular-page", "teil-tag-page"],
  );
  assert.throws(
    () => validateD3Rows([regular, regular], worker, "2026-10"),
    /duplicate page ID/,
  );
});

function rolloverDay(id, isoDate, { workerKey, sourcePageId, hours = 8 } = {}) {
  return {
    id,
    properties: {
      Wochentag: { title: [{ plain_text: "Montag" }] },
      Datum: { date: { start: isoDate } },
      Stunden: { number: hours },
      Standort: { select: { name: "Berlin" } },
      ...(workerKey
        ? {
            "Sync Key": { rich_text: [{ plain_text: sourcePageId
              ? daySyncKey(workerKey, isoDate, sourcePageId)
              : `${workerKey}|${isoDate}` }] },
            "Source Page ID": { rich_text: sourcePageId ? [{ plain_text: sourcePageId }] : [] },
          }
        : {}),
    },
  };
}

function sourceEntry(row) {
  const sourceDate = row.properties.Datum.date.start;
  return { row, sourceDate, sourceMonth: sourceDate.slice(0, 7) };
}

test("D4 barrier waits for a newly created row to appear without repeating writes", async () => {
  const worker = { name: "Ada", workerKey: "worker-a", d4DataSourceId: "d4-a" };
  const source = [sourceEntry(rolloverDay("d3-oct-31", "2026-10-31"))];
  const archived = rolloverDay("d4-oct-31", "2026-10-31", {
    workerKey: "worker-a", sourcePageId: "d3-oct-31",
  });
  let reads = 0;
  const delays = [];
  const messages = [];
  assert.equal(await waitForD4ExactMonth(worker, "2026-10", source, {
    readArchiveRows: async (dataSourceId) => {
      assert.equal(dataSourceId, "d4-a");
      reads += 1;
      return reads === 1 ? [] : [archived];
    },
    wait: async (delay) => delays.push(delay),
    reportRetry: (message) => messages.push(message),
  }), true);
  assert.equal(reads, 2);
  assert.deepEqual(delays, [1000]);
  assert.match(messages[0], /Missing Sync Key\(s\): worker-a\|2026-10-31\|d3-oct-31/);
});

test("D4 barrier waits for updated values and verifies them against the same snapshot", async () => {
  const worker = { name: "Ada", workerKey: "worker-a" };
  const source = [sourceEntry(rolloverDay("d3-oct-31", "2026-10-31", { hours: 4 }))];
  const archived = (hours) => rolloverDay("d4-oct-31", "2026-10-31", {
    workerKey: "worker-a", sourcePageId: "d3-oct-31", hours,
  });
  let reads = 0;
  const delays = [];
  assert.equal(await waitForD4ExactMonth(worker, "2026-10", source, {
    readArchiveRows: async () => [archived(++reads === 1 ? 8 : 4)],
    wait: async (delay) => delays.push(delay),
    reportRetry: () => {},
  }), true);
  assert.equal(reads, 2);
  assert.deepEqual(delays, [1000]);
});

test("D4 barrier stops after bounded reads when a row stays missing", async () => {
  const worker = { name: "Ada", workerKey: "worker-a" };
  const source = [sourceEntry(rolloverDay("d3-oct-31", "2026-10-31"))];
  let reads = 0;
  const delays = [];
  await assert.rejects(waitForD4ExactMonth(worker, "2026-10", source, {
    readArchiveRows: async () => { reads += 1; return []; },
    wait: async (delay) => delays.push(delay),
    reportRetry: () => {},
  }), /expected 1 row\(s\), found 0.*D3 remains unchanged/);
  assert.equal(reads, 5);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
});

test("D4 barrier never accepts persistent extra or duplicate rows", async () => {
  const worker = { name: "Ada", workerKey: "worker-a" };
  const source = [sourceEntry(rolloverDay("d3-oct-31", "2026-10-31"))];
  const archived = rolloverDay("d4-oct-31", "2026-10-31", {
    workerKey: "worker-a", sourcePageId: "d3-oct-31",
  });
  const extra = rolloverDay("d4-extra", "2026-10-30", {
    workerKey: "worker-a", sourcePageId: "deleted-source",
  });
  for (const rows of [[archived, extra], [archived, { ...archived, id: "d4-duplicate" }]]) {
    let reads = 0;
    await assert.rejects(waitForD4ExactMonth(worker, "2026-10", source, {
      readArchiveRows: async () => { reads += 1; return rows; },
      wait: async () => {},
      reportRetry: () => {},
    }), /expected 1 row\(s\), found 2/);
    assert.equal(reads, 5);
  }
});

test("D4 barrier rejects invalid ownership immediately instead of retrying it", async () => {
  const worker = { name: "Ada", workerKey: "worker-a" };
  const source = [sourceEntry(rolloverDay("d3-oct-31", "2026-10-31"))];
  const foreign = rolloverDay("d4-foreign", "2026-10-31", {
    workerKey: "worker-b", sourcePageId: "d3-oct-31",
  });
  let reads = 0;
  await assert.rejects(waitForD4ExactMonth(worker, "2026-10", source, {
    readArchiveRows: async () => { reads += 1; return [foreign]; },
    wait: async () => { assert.fail("ownership errors must not wait"); },
    reportRetry: () => { assert.fail("ownership errors must not retry"); },
  }), /foreign Sync Key\/Datum ownership/);
  assert.equal(reads, 1);
});

// Run the real transaction and select helper in an isolated CommonJS module.
// Only API boundaries and timers are replaced; no global module-cache or
// environment mutation is needed to exercise the order of live operations.
function archiveTransactionFixture({ permanentlyMissing = false, failFirstRebuild = false } = {}) {
  const worker = {
    name: "Ada", workerKey: "worker-a", rowId: "d1-a", active: false,
    d3DatabaseId: "d3-db-a", d3DataSourceId: "d3-a",
    d4DatabaseId: "d4-db-a", d4DataSourceId: "d4-a",
    currentMonth: "2026-10", lastArchivedMonth: "2026-09", rolloverStatus: "Ready",
  };
  const sourceRows = monthDays("2026-10").map(({ isoDate }, index) => ({
    ...rolloverDay(`d3-${index + 1}`, isoDate),
    parent: { type: "data_source_id", data_source_id: worker.d3DataSourceId },
    in_trash: false,
  }));
  const sourceEntries = sourceRows.map(sourceEntry);
  const archiveRows = [];
  const events = [];
  const state = {};
  let d4ReadsAfterWrites = 0;
  let fullyVisible = false;
  let rebuildAttempts = 0;
  const dataSources = Object.fromEntries([
    [worker.d4DataSourceId, Array.from({ length: 100 }, (_, index) => ({
      id: `old-${index}`, name: `Historical ${index}`, color: "red",
    }))],
    [worker.d3DataSourceId, [{ id: "berlin", name: "Berlin", color: "blue" }]],
  ].map(([id, options]) => [id, {
    id, properties: { Standort: { type: "select", select: { options } } },
  }]));
  const readProperties = (properties) => Object.fromEntries(Object.entries(properties).map(([name, property]) => {
    const type = property.title ? "title" : property.rich_text ? "rich_text" : "";
    return [name, type ? { [type]: property[type].map((item) => ({
      plain_text: item.plain_text || item.text?.content || "",
    })) } : structuredClone(property)];
  }));
  const notion = {
    ...require("../scripts/notion"),
    getDataSource: async (id) => dataSources[id],
    queryAll: async (id) => {
      if (id === worker.d3DataSourceId) return sourceRows.filter((row) => !row.in_trash);
      if (id === "test-d8") return [];
      assert.equal(id, worker.d4DataSourceId);
      if (archiveRows.length === 0) return [];
      assert.equal(archiveRows.length, 31);
      d4ReadsAfterWrites += 1;
      const count = permanentlyMissing || d4ReadsAfterWrites === 1 ? 30 : 31;
      fullyVisible = count === 31;
      events.push(`read-d4:${count}`);
      return archiveRows.slice(0, count);
    },
    createPage: async (parent, properties) => {
      assert.equal(parent.data_source_id, worker.d4DataSourceId);
      assert.equal(properties.Standort.select.name, "Berlin");
      events.push("create-d4");
      const options = dataSources[worker.d4DataSourceId].properties.Standort.select.options;
      if (!options.some((option) => option.name === "Berlin")) {
        options.push({ id: "new-berlin", name: "Berlin", color: "default" });
      }
      const row = { id: `d4-${archiveRows.length + 1}`, properties: readProperties(properties) };
      archiveRows.push(row);
      return row;
    },
    updateDataSource: async (id, properties) => {
      const options = properties.Standort.select.options;
      assert.ok(options.length <= 100, "never send an oversized schema option array");
      assert.equal(id, worker.d3DataSourceId, "D4 must add the new location through archive page writes");
      rebuildAttempts += 1;
      if (failFirstRebuild && rebuildAttempts === 1) throw new Error("simulated D3 schema rejection");
      dataSources[id].properties.Standort.select.options = options;
    },
    updatePage: async (id, properties) => {
      assert.equal(id, worker.rowId, "existing D4 rows must not be rewritten during verification retries");
      Object.assign(state, readProperties(properties));
    },
    getPage: async (id) => {
      const row = sourceRows.find((source) => source.id === id);
      assert.ok(row);
      return row;
    },
    archivePage: async (id) => {
      assert.equal(fullyVisible, true, "D3 must remain visible until all 31 D4 rows are verified");
      events.push(`archive-d3:${id}`);
      sourceRows.find((row) => row.id === id).in_trash = true;
    },
    restorePage: async () => { assert.fail("a verified fixture should never need source rollback"); },
  };
  const mocks = {
    "./notion": notion,
    "./archive-presentation": {
      ensureArchiveSchema: async (id) => dataSources[id],
      configureArchiveView: async () => {},
      ensureArchiveVacationView: async () => {},
    },
    "./management-sync": {
      syncWorkerToManagement: async () => {
        assert.equal(fullyVisible, true, "management sync must wait for the full D4 barrier");
        events.push("verify-d7");
        return { created: 0, updated: 0, archived: 0, unchanged: 31 };
      },
    },
    "./sync-standorte": { syncD7StandortRelations: async () => 0 },
  };
  const load = (filename) => {
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    const mockedRequire = (name) => mocks[name] || (name === "./select-options"
      ? load(localRequire.resolve(name)) : localRequire(name));
    compileFunction(readFileSync(filename, "utf8"), ["require", "module", "exports", "setTimeout", "console"], {
      filename,
    })(mockedRequire, module, module.exports, (callback, delay) => {
      events.push(`wait:${delay}`);
      callback();
    }, { log: () => {}, warn: () => {}, error: () => {} });
    return module.exports;
  };
  return {
    api: load(require.resolve("../scripts/month-rollover")), worker, sourceEntries,
    sourceRows, archiveRows, events, state, dataSources,
    rebuildAttempts: () => rebuildAttempts,
  };
}

test("October archive waits for 31-row visibility and adds a location above 100 historical choices without a schema PATCH", async () => {
  const fixture = archiveTransactionFixture();
  await fixture.api.archiveMonth(fixture.worker, "2026-10", fixture.sourceEntries, "2026-11");
  assert.equal(fixture.events.filter((event) => event === "create-d4").length, 31);
  assert.deepEqual(fixture.events.filter((event) => event.startsWith("read-d4:")).slice(0, 2), ["read-d4:30", "read-d4:31"]);
  assert.ok(fixture.events.indexOf("verify-d7") > fixture.events.indexOf("read-d4:31"));
  assert.ok(fixture.events.indexOf("archive-d3:d3-1") > fixture.events.indexOf("read-d4:31"));
  assert.equal(fixture.sourceRows.filter((row) => row.in_trash).length, 31);
  const options = fixture.dataSources[fixture.worker.d4DataSourceId].properties.Standort.select.options;
  assert.equal(options.length, 101);
  assert.ok(options.slice(0, 100).every((option) => option.color === "red"));
  assert.equal(options.at(-1).name, "Berlin");
});

test("a persistent 30-of-31 archive result leaves every October D3 source visible", async () => {
  const fixture = archiveTransactionFixture({ permanentlyMissing: true });
  await assert.rejects(
    fixture.api.archiveMonth(fixture.worker, "2026-10", fixture.sourceEntries, "2026-11"),
    /expected 31 row\(s\), found 30/,
  );
  assert.equal(fixture.events.filter((event) => event === "create-d4").length, 31);
  assert.equal(fixture.events.filter((event) => event === "read-d4:30").length, 5);
  assert.equal(fixture.events.some((event) => event.startsWith("archive-d3:") || event === "verify-d7"), false);
  assert.equal(fixture.sourceRows.filter((row) => !row.in_trash).length, 31);
  assert.equal(fixture.state["Rollover Manifest"], undefined);
});

test("a D3 rebuild failure after durable archival is retried even when Current Month already advanced", async () => {
  const fixture = archiveTransactionFixture({ failFirstRebuild: true });
  const run = { targetMonth: "2026-11" };
  await assert.rejects(fixture.api.rolloverWorker(fixture.worker, run), /simulated D3 schema rejection/);
  assert.equal(fixture.state["Current Month"].rich_text[0].plain_text, "2026-11");
  assert.equal(fixture.state["Last Archived Month"].rich_text[0].plain_text, "2026-10");
  await fixture.api.rolloverWorker({
    ...fixture.worker, currentMonth: "2026-11", lastArchivedMonth: "2026-10", rolloverStatus: "Error",
  }, run);
  assert.equal(fixture.rebuildAttempts(), 2);
  assert.equal(fixture.events.filter((event) => event === "create-d4").length, 31);
  assert.equal(fixture.state["Rollover Status"].select.name, "Ready");
});

function januaryCarryover() {
  const row = rolloverDay("carryover", "2027-01-01", { hours: -8 });
  row.properties.Wochentag = { title: [{ plain_text: "Urlaubsmitnahme" }] };
  row.properties.Standort = { select: { name: "Urlaub" } };
  row.properties["Sync Key"] = { rich_text: [{ plain_text: carryoverKey("worker-a", 2026) }] };
  row.properties["Source Page ID"] = { rich_text: [] };
  return row;
}

test("February rollover preserves January carryover alongside actual January 1 entries", () => {
  const worker = { name: "Ada", workerKey: "worker-a" };
  const carryover = januaryCarryover();
  const source = [sourceEntry(rolloverDay("d3-jan-1", "2027-01-01"))];
  const archived = rolloverDay("d4-jan-1", "2027-01-01", { workerKey: "worker-a", sourcePageId: "d3-jan-1" });
  const deleted = rolloverDay("d4-deleted", "2027-01-02", { workerKey: "worker-a", sourcePageId: "deleted-source" });
  assert.deepEqual(staleD4Rows(worker, "2027-01", source, [carryover, archived, deleted]), [deleted]);
  assert.equal(verifyD4ExactMonth(worker, "2027-01", source, [carryover, archived]), true);
  assert.deepEqual(staleD4Rows(worker, "2027-01", [], [carryover]), []);
  assert.equal(verifyD4ExactMonth(worker, "2027-01", [], [carryover]), true);
  assert.equal(carryover.properties.Stunden.number, -8);
});

test("January legacy recovery never assigns the carryover row to a same-date D3 page", () => {
  const worker = { name: "Ada", workerKey: "worker-a" };
  const source = [sourceEntry(rolloverDay("d3-jan-1", "2027-01-01"))];
  const legacy = rolloverDay("d4-legacy", "2027-01-01", { workerKey: "worker-a" });
  const migrations = legacyD4MigrationPlan(worker, "2027-01", source, [januaryCarryover(), legacy]);
  assert.equal(migrations.length, 1);
  assert.equal(migrations[0].row.id, "d4-legacy");
  assert.throws(() => verifyD4ExactMonth(worker, "2027-01", source, [januaryCarryover()]), /exact-set verification/);
});

test("malformed and duplicate carryovers fail rollover barriers rather than being cleaned up", () => {
  const worker = { name: "Ada", workerKey: "worker-a" };
  const duplicate = [januaryCarryover(), { ...januaryCarryover(), id: "duplicate" }];
  const malformed = januaryCarryover(); malformed.properties.Stunden.number = 0;
  for (const rows of [duplicate, [malformed]]) {
    assert.throws(() => staleD4Rows(worker, "2027-01", [], rows), /Urlaubsmitnahme/);
    assert.throws(() => legacyD4MigrationPlan(worker, "2027-01", [], rows), /Urlaubsmitnahme/);
    assert.throws(() => verifyD4ExactMonth(worker, "2027-01", [], rows), /Urlaubsmitnahme/);
  }
});

test("D4 retry removes only the prior same-worker/month row after a D3 date edit", () => {
  const worker = { name: "Ada", workerKey: "worker-a" };
  const freshSource = [sourceEntry(rolloverDay("d3-edited", "2026-09-02"))];
  const stale = rolloverDay("d4-old-date", "2026-09-01", { workerKey: "worker-a" });
  const otherMonth = rolloverDay("d4-august", "2026-08-31", { workerKey: "worker-a" });

  assert.deepEqual(
    staleD4Rows(worker, "2026-09", freshSource, [stale, otherMonth]).map((row) => row.id),
    ["d4-old-date"],
  );

  const repaired = rolloverDay("d4-new-date", "2026-09-02", {
    workerKey: "worker-a", sourcePageId: "d3-edited",
  });
  assert.equal(
    verifyD4ExactMonth(worker, "2026-09", freshSource, [repaired, otherMonth]),
    true,
  );
});

test("D4 retry removes a deleted D3 day and exact verification rejects residual extras", () => {
  const worker = { name: "Ada", workerKey: "worker-a" };
  const source = rolloverDay("d3-kept", "2026-09-01");
  const freshSource = [sourceEntry(source)];
  const kept = rolloverDay("d4-kept", "2026-09-01", {
    workerKey: "worker-a", sourcePageId: "d3-kept",
  });
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

test("D4 keeps two same-date Teil-Tag entries independently on rollover retries", () => {
  const worker = { name: "Ada", workerKey: "worker-a" };
  const first = rolloverDay("regular-page", "2026-09-16", { hours: 4 });
  const second = rolloverDay("teil-tag-page", "2026-09-16", { hours: 3 });
  second.properties.Wochentag = { title: [{ plain_text: "Teil-Tag" }] };
  const source = [sourceEntry(first), sourceEntry(second)];
  assert.notEqual(
    archiveProperties(worker, first).syncKey,
    archiveProperties(worker, second).syncKey,
  );
  const archive = [
    rolloverDay("d4-regular", "2026-09-16", {
      workerKey: "worker-a", sourcePageId: "regular-page", hours: 4,
    }),
    rolloverDay("d4-part", "2026-09-16", {
      workerKey: "worker-a", sourcePageId: "teil-tag-page", hours: 3,
    }),
  ];
  archive[1].properties.Wochentag = second.properties.Wochentag;
  assert.deepEqual(staleD4Rows(worker, "2026-09", source, archive), []);
  assert.equal(verifyD4ExactMonth(worker, "2026-09", source, archive), true);

  const orphan = rolloverDay("d4-orphan", "2026-09-17", {
    workerKey: "worker-a", sourcePageId: "deleted-page",
  });
  assert.deepEqual(
    staleD4Rows(worker, "2026-09", source, [...archive, orphan]).map((row) => row.id),
    ["d4-orphan"],
  );
});

test("an ambiguous legacy D4 date-only row is never assigned to either same-date source", () => {
  const worker = { name: "Ada", workerKey: "worker-a" };
  const source = [
    sourceEntry(rolloverDay("regular-page", "2026-09-16")),
    sourceEntry(rolloverDay("teil-tag-page", "2026-09-16")),
  ];
  const legacy = rolloverDay("d4-legacy", "2026-09-16", { workerKey: "worker-a" });
  assert.throws(
    () => staleD4Rows(worker, "2026-09", source, [legacy]),
    /legacy D4 row .* multiple D3 pages use 2026-09-16/,
  );
});

test("an old saved rollover checkpoint upgrades its unambiguous D4 row in place", () => {
  const worker = { name: "Ada", workerKey: "worker-a" };
  const source = [sourceEntry(rolloverDay("regular-page", "2026-09-16"))];
  const oldCopy = rolloverDay("d4-legacy", "2026-09-16", { workerKey: "worker-a" });
  const migrations = legacyD4MigrationPlan(worker, "2026-09", source, [oldCopy]);
  assert.equal(migrations.length, 1);
  assert.equal(migrations[0].row.id, "d4-legacy");
  assert.deepEqual(migrations[0].properties["Sync Key"], {
    rich_text: [{ type: "text", text: { content: "worker-a|2026-09-16|regular-page" } }],
  });
  assert.deepEqual(migrations[0].properties["Source Page ID"], {
    rich_text: [{ type: "text", text: { content: "regular-page" } }],
  });
  assert.deepEqual(legacyD4MigrationPlan(worker, "2026-09", source, [
    rolloverDay("d4-upgraded", "2026-09-16", {
      workerKey: "worker-a", sourcePageId: "regular-page",
    }),
  ]), []);
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

test("the rollover checkpoint accepts same-date pages but rejects duplicate page IDs", () => {
  const worker = {
    name: "Ada", workerKey: "worker-a",
    d3DatabaseId: "d3-db-a", d3DataSourceId: "d3-source-a",
    d4DatabaseId: "d4-db-a", d4DataSourceId: "d4-source-a",
  };
  const entries = [
    sourceEntry(rolloverDay("regular-page", "2026-09-16")),
    sourceEntry(rolloverDay("teil-tag-page", "2026-09-16")),
  ];
  const manifest = buildRolloverManifest(worker, "2026-09", entries);
  assert.equal(parseRolloverManifest(JSON.stringify(manifest), worker).days.length, 2);
  manifest.days[1].id = manifest.days[0].id;
  assert.throws(
    () => parseRolloverManifest(JSON.stringify(manifest), worker),
    /duplicate page IDs/,
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
