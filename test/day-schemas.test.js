"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ARCHIVE_MONTH_FORMULA,
  ARCHIVE_MONTH_PROPERTY,
  DAY_PROPERTY_TYPES,
  D4_PROPERTY_TYPES,
  archiveDatabaseProperties,
  archiveMetadataProperties,
  assertArchiveDataSource,
  assertDayDataSource,
  currentMonthDatabaseProperties,
} = require("../scripts/day-schemas");
const { WORK_TYPE_OPTIONS } = require("../scripts/worker-standort-options");

function dataSource(properties = {}) {
  return {
    id: "day-source",
    properties: {
      Wochentag: { type: "title" },
      Datum: { type: "date" },
      Stunden: { type: "number" },
      Standort: { type: "select" },
      ...properties,
    },
  };
}

test("day schemas expose one canonical D3 contract and an archive extension", () => {
  assert.deepEqual(DAY_PROPERTY_TYPES, {
    Wochentag: "title",
    Datum: "date",
    Stunden: "number",
    Standort: "select",
  });
  assert.deepEqual(D4_PROPERTY_TYPES, {
    ...DAY_PROPERTY_TYPES,
    "Sync Key": "rich_text",
    Monat: "formula",
  });
  assert.equal(Object.isFrozen(DAY_PROPERTY_TYPES), true);
  assert.equal(Object.isFrozen(D4_PROPERTY_TYPES), true);
});

test("current-month schema creates the worker day fields and color-safe initial options", () => {
  const properties = currentMonthDatabaseProperties(["Berlin", "Berlin", "Urlaub"]);

  assert.deepEqual(Object.keys(properties), ["Wochentag", "Datum", "Stunden", "Standort"]);
  assert.equal("Tagtyp" in properties, false);
  assert.deepEqual(properties.Wochentag, { title: {} });
  assert.deepEqual(properties.Datum, { date: {} });
  assert.deepEqual(properties.Stunden, { number: { format: "number" } });
  assert.deepEqual(
    properties.Standort.select.options.map((option) => option.name),
    ["Berlin", ...WORK_TYPE_OPTIONS.map((option) => option.name)],
  );
  assert.deepEqual(
    properties.Standort.select.options.find((option) => option.name === "Berlin"),
    { name: "Berlin", color: "blue" },
  );
  assert.ok(
    WORK_TYPE_OPTIONS.every((expected) =>
      properties.Standort.select.options.some(
        (actual) => actual.name === expected.name && actual.color === "gray",
      )),
  );
});

test("archive schema extends the day fields with deterministic technical metadata", () => {
  assert.equal(ARCHIVE_MONTH_PROPERTY, "Monat");
  assert.equal(ARCHIVE_MONTH_FORMULA, 'formatDate(prop("Datum"), "YYYY-MM")');
  assert.deepEqual(archiveMetadataProperties(), {
    "Sync Key": { rich_text: {} },
    Monat: { formula: { expression: ARCHIVE_MONTH_FORMULA } },
  });

  const properties = archiveDatabaseProperties(["Berlin"]);
  assert.deepEqual(properties["Sync Key"], { rich_text: {} });
  assert.deepEqual(properties.Monat, {
    formula: { expression: ARCHIVE_MONTH_FORMULA },
  });
  assert.equal("Tagtyp" in properties, false);
});

test("day and archive validators enforce their respective property contracts", () => {
  const day = dataSource();
  const archive = dataSource({
    "Sync Key": { type: "rich_text" },
    Monat: { type: "formula" },
  });

  assert.equal(assertDayDataSource(day), day);
  assert.equal(assertArchiveDataSource(archive), archive);
  assert.throws(
    () => assertDayDataSource(dataSource({ Datum: { type: "rich_text" } })),
    /Datum.*rich_text.*expected date/,
  );
  assert.throws(
    () => assertArchiveDataSource(dataSource({ "Sync Key": { type: "rich_text" } })),
    /missing "Monat"/,
  );
});
