"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  INCLUSIVE_START,
  EXCLUSIVE_CUTOFF,
  SOURCE_DATABASE_ID,
  SOURCE_DATA_SOURCE_ID,
  importProperties,
  reconcileDestination,
  runImport,
  selectedEntries,
  selectWorker,
} = require("../scripts/import-old-archive");

const IDS = {
  d1: "11111111-1111-4111-8111-111111111111",
  d1Row: "22222222-2222-4222-8222-222222222222",
  frontend: "33333333-3333-4333-8333-333333333333",
  d4Db: "44444444-4444-4444-8444-444444444444",
  d4Ds: "55555555-5555-4555-8555-555555555555",
  sourceA: "66666666-6666-4666-8666-666666666666",
  sourceB: "77777777-7777-4777-8777-777777777777",
  sourceSept: "88888888-8888-4888-8888-888888888888",
};

function text(value) {
  return value ? [{ plain_text: value }] : [];
}

function d1Row(overrides = {}) {
  return {
    id: IDS.d1Row,
    properties: {
      "Vor- und Nachname": { title: text("Ada Lovelace") },
      "Worker Key": { rich_text: text("wrk_ada") },
      "Frontend Page ID": { rich_text: text(IDS.frontend) },
      "User Page ID": { rich_text: [] },
      "Onboarding Status": { select: { name: "Ready" } },
      "Current Month": { rich_text: text("2026-10") },
      "Rollover Manifest": { rich_text: [] },
      "Rollover Status": { select: { name: "Ready" } },
      "D3 Database ID": { rich_text: [] },
      "D3 Data Source ID": { rich_text: [] },
      "D4 Database ID": { rich_text: text(IDS.d4Db) },
      "D4 Data Source ID": { rich_text: text(IDS.d4Ds) },
      ...overrides,
    },
  };
}

function oldRow(id, dateValue, name = "Ada Lovelace", standort = "Altbau") {
  return {
    id,
    properties: {
      Wochentag: { title: text("Montag") },
      Date: { date: dateValue ? { start: dateValue } : null },
      Stunden: { number: 4 },
      Standort: { select: { name: standort } },
      "Vor- und Nachname": { rich_text: text(name) },
    },
  };
}

function destinationRow(entry, overrides = {}) {
  return {
    id: entry.sourcePageId,
    properties: {
      Wochentag: { title: text(entry.wochentag) },
      Datum: { date: { start: entry.datum } },
      Stunden: { number: entry.stunden },
      Standort: { select: entry.standort ? { name: entry.standort } : null },
      "Sync Key": { rich_text: text(entry.syncKey) },
      "Source Page ID": { rich_text: text(entry.sourcePageId) },
      ...overrides,
    },
  };
}

test("only September 2026 is selected, including both month boundaries", () => {
  assert.equal(INCLUSIVE_START, "2026-09-01");
  assert.equal(EXCLUSIVE_CUTOFF, "2026-10-01");
  const { entries, excluded } = selectedEntries([
    oldRow("before", "2026-08-31"),
    oldRow(IDS.sourceA, "2026-09-01"),
    oldRow(IDS.sourceB, "2026-09-30"),
    oldRow("after", "2026-10-01"),
    oldRow("old-year", "2025-09-15"),
    oldRow("next-year", "2027-09-15"),
  ], "Ada Lovelace", "wrk_ada");
  assert.deepEqual(entries.map((entry) => entry.datum), ["2026-09-01", "2026-09-30"]);
  assert.equal(excluded, 4);
});

test("same-date old pages get distinct stable destination keys", () => {
  const { entries } = selectedEntries([
    oldRow(IDS.sourceA, "2026-09-01"),
    oldRow(IDS.sourceB, "2026-09-01"),
  ], "Ada Lovelace", "wrk_ada");
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].syncKey, entries[1].syncKey);
  assert.deepEqual(entries.map((entry) => entry.sourcePageId).sort(),
    [IDS.sourceA, IDS.sourceB]);
  assert.equal(reconcileDestination(entries, [destinationRow(entries[0])]).length, 1);
});

test("invalid/missing dates and wrong exact worker are rejected", () => {
  for (const badDate of [null, "2026-02-30", "2026-09-01T12:00:00Z"]) {
    assert.throws(
      () => selectedEntries([oldRow(IDS.sourceA, badDate)], "Ada Lovelace", "wrk_ada"),
      /date-only|invalid Date/,
    );
  }
  const range = oldRow(IDS.sourceA, "2026-09-01");
  range.properties.Date.date.end = "2026-09-01";
  assert.throws(() => selectedEntries([range], "Ada Lovelace", "wrk_ada"), /date range/);
  assert.throws(
    () => selectedEntries([oldRow(IDS.sourceA, "2026-09-01", "Ada B. Lovelace")],
      "Ada Lovelace", "wrk_ada"),
    (error) => {
      assert.match(error.message, /outside exact worker "Ada Lovelace"/);
      assert.match(error.message, /read as "Ada B\. Lovelace"/);
      assert.ok(error.message.includes(`https://www.notion.so/${IDS.sourceA.replaceAll("-", "")}`));
      assert.match(error.message, /Import stopped before copying/);
      return true;
    },
  );
});

test("destination identity, duplicate names, pending rollover, and changed rows fail closed", () => {
  assert.throws(() => selectWorker([d1Row()], "Ada Lovelace", IDS.sourceA), /does not match/);
  assert.throws(() => selectWorker([d1Row(), { ...d1Row(), id: IDS.sourceB }],
    "Ada Lovelace", IDS.d4Db), /exact workers/);
  assert.throws(() => selectWorker([d1Row({ "Rollover Manifest": { rich_text: text("pending") } })],
    "Ada Lovelace", IDS.d4Db), /pending month rollover/);
  const { entries } = selectedEntries([oldRow(IDS.sourceA, "2026-09-01")],
    "Ada Lovelace", "wrk_ada");
  assert.throws(() => reconcileDestination(entries, [destinationRow(entries[0], {
    Stunden: { number: 7 },
  })]), /unexpected, duplicate, or changed/);
  assert.throws(() => reconcileDestination(entries, [destinationRow(entries[0]),
    destinationRow(entries[0])]), /unexpected, duplicate, or changed/);
});

for (const { optionCount, interrupt } of [
  { optionCount: 0 }, { optionCount: 100 }, { optionCount: 125 },
  { optionCount: 100, interrupt: true },
]) {
  test(`manual import preserves ${optionCount} choices and retries without duplicates (interrupted: ${!!interrupt})`, async () => {
    const sourceRows = [
      oldRow(IDS.sourceA, "2026-09-01"),
      oldRow(IDS.sourceB, "2026-09-01", "Ada Lovelace", "Old Site"),
      oldRow(IDS.sourceSept, "2026-08-31"),
      oldRow("october", "2026-10-01"),
    ];
    const existingHistory = ["2026-08-31", "2026-10-01"].map((datum, index) =>
      destinationRow({
        sourcePageId: `history-${index}`, syncKey: `history-key-${index}`,
        datum, wochentag: "Montag", stunden: 8, standort: "Altbau",
      }));
    const historySnapshot = structuredClone(existingHistory);
    const sourceSnapshot = structuredClone(sourceRows);
    const destinationRows = [...existingHistory];
    const writes = [];
    const existingOptions = Array.from({ length: optionCount }, (_, index) => ({
      id: `option-${index}`, name: index === 0 ? "Altbau" : `Historic site ${index}`,
      color: index % 2 ? "green" : "blue",
    }));
    const optionsSnapshot = structuredClone(existingOptions);
    let interruptNextCreate = !!interrupt;
    const sourceDataSource = {
      id: SOURCE_DATA_SOURCE_ID,
      parent: { type: "database_id", database_id: SOURCE_DATABASE_ID },
      properties: {
        Wochentag: { type: "title" },
        Date: { type: "date" },
        Stunden: { type: "number" },
        Standort: { type: "select", select: { options: [
          { name: "Altbau", color: "blue" }, { name: "Old Site", color: "red" },
        ] } },
        "Vor- und Nachname": { type: "rich_text" },
      },
    };
    const destinationDataSource = {
      id: IDS.d4Ds,
      parent: { type: "database_id", database_id: IDS.d4Db },
      properties: {
        Wochentag: { type: "title" },
        Datum: { type: "date" },
        Stunden: { type: "number" },
        Standort: { type: "select", select: { options: existingOptions } },
        Urlaubstag: { type: "formula" },
        "Sync Key": { type: "rich_text" },
        "Source Page ID": { type: "rich_text" },
      },
    };
    const d1 = {
      id: IDS.d1,
      properties: Object.fromEntries([
        ["Vor- und Nachname", "title"], ["Worker Key", "rich_text"],
        ["Frontend Page ID", "rich_text"], ["Onboarding Status", "select"],
        ["Current Month", "rich_text"], ["Rollover Manifest", "rich_text"],
        ["D3 Database ID", "rich_text"], ["D3 Data Source ID", "rich_text"],
        ["D4 Database ID", "rich_text"], ["D4 Data Source ID", "rich_text"],
      ].map(([name, type]) => [name, { type }])),
    };
    const operations = {
      getDataSource: async (id) => {
        if (id === IDS.d1) return d1;
        if (id === SOURCE_DATA_SOURCE_ID) return sourceDataSource;
        if (id === IDS.d4Ds) return destinationDataSource;
        throw new Error(`Unexpected getDataSource ${id}`);
      },
      getDatabase: async (id) => {
        if (id === SOURCE_DATABASE_ID) return {
          id, data_sources: [{ id: SOURCE_DATA_SOURCE_ID }],
        };
        if (id === IDS.d4Db) return {
          id, parent: { page_id: IDS.frontend }, data_sources: [{ id: IDS.d4Ds }],
        };
        throw new Error(`Unexpected getDatabase ${id}`);
      },
      getPage: async (id) => {
        assert.equal(id, IDS.frontend);
        return { id, properties: {
          "D1 Record ID": { rich_text: text(IDS.d1Row) },
          "Worker Key": { rich_text: text("wrk_ada") },
        } };
      },
      queryAll: async (id, filter) => {
        if (id === IDS.d1) return [d1Row()];
        if (id === SOURCE_DATA_SOURCE_ID) {
          assert.deepEqual(filter, {
            property: "Vor- und Nachname", rich_text: { equals: "Ada Lovelace" },
          });
          return sourceRows;
        }
        if (id === IDS.d4Ds) return destinationRows;
        throw new Error(`Unexpected queryAll ${id}`);
      },
      updateDataSourceSelect: async () => {
        assert.fail("The importer must never send a bulk dropdown update");
      },
      createPage: async (parent, properties) => {
        assert.equal(parent.data_source_id, IDS.d4Ds);
        assert.equal(Object.hasOwn(properties.Standort, "options"), false);
        const choice = properties.Standort.select;
        if (choice) {
          assert.deepEqual(Object.keys(choice), ["name"]);
          const options = destinationDataSource.properties.Standort.select.options;
          if (!options.some((option) => option.name === choice.name)) {
            options.push({ id: `new-${options.length}`, name: choice.name, color: "default" });
          }
        }
        writes.push({ type: "page", id: parent.data_source_id });
        const entry = {
          datum: properties.Datum.date.start,
          wochentag: properties.Wochentag.title.map((item) => item.text.content).join(""),
          stunden: properties.Stunden.number,
          standort: properties.Standort.select?.name || "",
          syncKey: properties["Sync Key"].rich_text.map((item) => item.text.content).join(""),
          sourcePageId: properties["Source Page ID"].rich_text.map((item) => item.text.content).join(""),
        };
        destinationRows.push(destinationRow(entry));
        if (interruptNextCreate) {
          interruptNextCreate = false;
          throw new Error("Simulated lost response after successful create");
        }
        return destinationRows.at(-1);
      },
    };
    const config = {
      exactName: "Ada Lovelace", destinationId: IDS.d4Db, d1DataSourceId: IDS.d1,
    };
    const preflight = await runImport({ ...config, preflightOnly: true }, operations);
    assert.equal(preflight.entries.length, 2);
    assert.equal(preflight.excluded, 2);
    assert.deepEqual(writes, []);

    if (interruptNextCreate) {
      await assert.rejects(runImport(config, operations), /lost response/);
      assert.equal(writes.length, 1);
      assert.equal(destinationRows.length, 3);
    }
    await runImport(config, operations);
    assert.equal(destinationRows.length, 4);
    assert.deepEqual(destinationRows.slice(0, 2), historySnapshot);
    assert.deepEqual(sourceRows, sourceSnapshot);
    assert.deepEqual(writes.map((write) => write.id), [IDS.d4Ds, IDS.d4Ds]);
    const finalOptions = destinationDataSource.properties.Standort.select.options;
    assert.deepEqual(finalOptions.slice(0, optionCount), optionsSnapshot);
    assert.deepEqual(finalOptions.slice(optionCount).map((option) => [option.name, option.color]),
      optionCount ? [["Old Site", "default"]] : [["Altbau", "default"], ["Old Site", "default"]]);

    await runImport(config, operations);
    assert.equal(destinationRows.length, 4);
    assert.deepEqual(destinationRows.slice(0, 2), historySnapshot);
    assert.deepEqual(sourceRows, sourceSnapshot);
    assert.equal(writes.length, 2);
    assert.equal(importProperties(preflight.entries[0]).Datum.date.start, "2026-09-01");
  });
}

test("September imports require October or later with no active rollover", () => {
  for (const month of ["2026-08", "2026-09", "", "invalid"]) {
    assert.throws(() => selectWorker([
      d1Row({ "Current Month": { rich_text: text(month) } }),
    ], "Ada Lovelace", IDS.d4Db), /October 2026 or later/);
  }
  assert.equal(selectWorker([d1Row()], "Ada Lovelace", IDS.d4Db).workerKey, "wrk_ada");
  assert.throws(() => selectWorker([
    d1Row({ "Rollover Status": { select: { name: "Running" } } }),
  ], "Ada Lovelace", IDS.d4Db), /marked Running/);
});

test("existing September conflicts and copies moved to other months still fail", () => {
  const { entries } = selectedEntries([oldRow(IDS.sourceA, "2026-09-15")],
    "Ada Lovelace", "wrk_ada");
  for (const overrides of [
    { "Sync Key": { rich_text: text("unrelated") } },
    { Datum: { date: { start: "2026-08-31" } } },
    { Datum: { date: { start: "2026-10-01" } }, "Sync Key": { rich_text: text("changed") } },
  ]) {
    assert.throws(() => reconcileDestination(entries, [destinationRow(entries[0], overrides)]),
      /unexpected, duplicate, or changed/);
  }
});

test("a worker with no September entries yields no pages to copy", () => {
  const { entries, excluded } = selectedEntries([
    oldRow(IDS.sourceA, "2026-08-31"), oldRow(IDS.sourceB, "2026-10-01"),
  ], "Ada Lovelace", "wrk_ada");
  assert.deepEqual(entries, []);
  assert.equal(excluded, 2);
  assert.deepEqual(reconcileDestination(entries, [destinationRow({
    sourcePageId: IDS.sourceA, syncKey: "old-history", datum: "2026-08-31",
    wochentag: "Montag", stunden: 4, standort: "Altbau",
  })]), []);
});
