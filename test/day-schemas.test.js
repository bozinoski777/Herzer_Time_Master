"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DAY_PROPERTY_TYPES,
  D4_PROPERTY_TYPES,
  VACATION_DAY_FORMULA,
  assertVacationDayFormula,
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
    Urlaubstag: "formula",
    "Sync Key": "rich_text",
    "Source Page ID": "rich_text",
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
  assert.deepEqual(archiveMetadataProperties(), {
    "Sync Key": { rich_text: {} },
    "Source Page ID": { rich_text: {} },
  });

  const properties = archiveDatabaseProperties(["Berlin"]);
  assert.deepEqual(properties["Sync Key"], { rich_text: {} });
  assert.deepEqual(properties["Source Page ID"], { rich_text: {} });
  assert.equal(properties.Urlaubstag.formula.expression, VACATION_DAY_FORMULA);
  assert.equal("Monat" in properties, false);
  assert.equal("Tagtyp" in properties, false);
});

test("day and archive validators enforce their respective property contracts", () => {
  const day = dataSource();
  const archive = dataSource({
    "Sync Key": { type: "rich_text" },
    "Source Page ID": { type: "rich_text" },
    Urlaubstag: { type: "formula", formula: { expression: VACATION_DAY_FORMULA } },
  });

  assert.equal(assertDayDataSource(day), day);
  assert.equal(assertArchiveDataSource(archive), archive);
  assert.throws(
    () => assertDayDataSource(dataSource({ Datum: { type: "rich_text" } })),
    /Datum.*rich_text.*expected date/,
  );
  assert.throws(
    () => assertArchiveDataSource(dataSource({ "Sync Key": { type: "rich_text" } })),
    /missing "Source Page ID"/,
  );
  assert.equal(assertArchiveDataSource(dataSource({
    "Sync Key": { type: "rich_text" },
    "Source Page ID": { type: "rich_text" },
    Urlaubstag: { type: "formula", formula: { expression: VACATION_DAY_FORMULA } },
    Monat: { type: "formula" },
  })).properties.Monat.type, "formula");
});

test("the installed formula evaluates fractional leave without rounding or capping", () => {
  // Evaluate the exact emitted expression with the two Notion primitives it uses.
  const expression = archiveDatabaseProperties([]).Urlaubstag.formula.expression.replace(/\bif\(/g, "choose(");
  const evaluate = new Function("prop", "empty", "choose", `return ${expression}`);
  const calculate = (site, hours) => evaluate(
    (name) => name === "Standort" ? site : hours,
    (value) => value === null || value === undefined || value === 0 || value === "",
    (condition, yes, no) => condition ? yes : no,
  );
  for (const [hours, days] of [[8, 1], [4, 0.5], [2, 0.25], [1, 0.125], [1.5, 0.1875], [12, 1.5], [0, 0], [null, 0]]) {
    assert.equal(calculate("Urlaub", hours), days);
  }
  for (const site of ["Sonderurlaub", "Baustelle", "Krank", ""]) assert.equal(calculate(site, 8), 0);
  assert.equal(calculate("Urlaub", 4) + calculate("Urlaub", 4), 1);
});

test("formula validation accepts API property IDs and rejects a different formula", () => {
  const source = dataSource({
    Stunden: { id: "hours", type: "number" }, Standort: { id: "site", type: "select" },
    Urlaubstag: { type: "formula", formula: { expression: VACATION_DAY_FORMULA.replaceAll('prop("Stunden")', 'prop("hours")').replaceAll('prop("Standort")', 'prop("site")') } },
  });
  assert.doesNotThrow(() => assertVacationDayFormula(source));
  source.properties.Urlaubstag.formula.expression = 'prop("Stunden") / 8';
  assert.throws(() => assertVacationDayFormula(source), /incompatible/);
});
