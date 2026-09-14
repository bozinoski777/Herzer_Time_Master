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

const {
  dayDatabaseProperties,
  frontendProperties,
  manualOnboardingChecklistBlocks,
} = require("../scripts/onboard-workers");

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

test("new worker frontends expose email and include the manual invite checklist", () => {
  const properties = frontendProperties("Tea Smea", "tea@example.com", "wrk_1", "d1_1");
  assert.deepEqual(properties.Email, { email: "tea@example.com" });
  assert.equal(properties["Worker Key"].rich_text[0].text.content, "wrk_1");

  const checklist = manualOnboardingChecklistBlocks();
  assert.equal(checklist.length, 3);
  assert.ok(checklist.every((block) => block.type === "to_do" && block.to_do.checked === false));
  const text = checklist.map((block) => block.to_do.rich_text.map((item) => item.text.content).join("")).join("\n");
  assert.match(text, /Can view/);
  assert.match(text, /Can edit content/);
  assert.doesNotMatch(text, /Manuelle Freigabe-Checkliste/);
  assert.doesNotMatch(text, /Customize layout/);
  assert.ok(checklist.every((block) => block.to_do.rich_text.some(
    (item) => item.annotations?.bold === true && /^Can (view|edit content)$/.test(item.text.content),
  )));
});
