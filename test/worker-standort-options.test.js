"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  WORK_TYPE_OPTIONS,
  workerStandortNames,
  workerStandortOptions,
} = require("../scripts/worker-standort-options");

process.env.D1_DATA_SOURCE_ID = "test-d1";
process.env.D8_DATA_SOURCE_ID = "test-d8";
process.env.EMPLOYEE_FRONTENDS_DATA_SOURCE_ID = "test-frontends";

const { dayDatabaseProperties } = require("../scripts/onboard-workers");

test("Standort combines active sites and the former day-type choices once", () => {
  assert.deepEqual(workerStandortNames(["Berlin", "Urlaub", "Berlin"]), [
    "Berlin",
    "Urlaub",
    "Arbeit",
    "Krank",
    "Feiertag",
    "Sonderurlaub",
    "Überstundenausgleich",
  ]);

  const options = workerStandortOptions(["Berlin"]);
  assert.deepEqual(options.find((option) => option.name === "Berlin"), { name: "Berlin", color: "blue" });
  assert.deepEqual(options.find((option) => option.name === "Krank"), { name: "Krank", color: "red" });
  assert.equal(options.length, WORK_TYPE_OPTIONS.length + 1);
});

test("new worker D3/D4 schemas use one Standort select and no Tagtyp property", () => {
  const d3 = dayDatabaseProperties(["Berlin"]);
  const d4 = dayDatabaseProperties(["Berlin"], true);

  assert.equal("Tagtyp" in d3, false);
  assert.equal("Tagtyp" in d4, false);
  assert.deepEqual(
    d3.Standort.select.options.map((option) => option.name),
    ["Berlin", ...WORK_TYPE_OPTIONS.map((option) => option.name)],
  );
  assert.ok(d4["Sync Key"]);
  assert.ok(d4.Monat);
});
