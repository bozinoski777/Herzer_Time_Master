"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.D1_DATA_SOURCE_ID = "test-d1";
process.env.D7_DATA_SOURCE_ID = "test-d7";
process.env.D8_DATA_SOURCE_ID = "test-d8";

const { planD3StandortOptions } = require("../scripts/sync-standorte");
const { workerStandortOptions } = require("../scripts/worker-standort-options");

test("D3 Standort sync removes unused inactive sites without recoloring existing options", () => {
  const plan = planD3StandortOptions(
    [
      { id: "berlin", name: "Berlin", color: "blue" },
      { id: "inactive", name: "Old office", color: "blue" },
      { id: "urlaub", name: "Urlaub", color: "blue" },
    ],
    workerStandortOptions(["Berlin"]),
    [{ properties: { Standort: { select: { name: "Berlin" } } } }],
  );

  assert.deepEqual(plan.removed, ["Old office"]);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.nextOptions.find((option) => option.name === "Urlaub"), {
    id: "urlaub",
    name: "Urlaub",
  });
  assert.equal(plan.nextOptions.some((option) => option.name === "Old office"), false);
});

test("D3 Standort sync gives newly-created work choices their gray color", () => {
  const plan = planD3StandortOptions([], workerStandortOptions([]), []);

  assert.equal(plan.changed, true);
  assert.deepEqual(
    plan.nextOptions.map((option) => ({ name: option.name, color: option.color })),
    [
      { name: "Teil-Tag", color: "gray" },
      { name: "Urlaub", color: "gray" },
      { name: "Sonderurlaub", color: "gray" },
      { name: "Überstundenausgleich", color: "gray" },
      { name: "Feiertag", color: "gray" },
      { name: "Krank", color: "gray" },
    ],
  );
});

test("D3 Standort sync refuses to remove an option used by a current day", () => {
  assert.throws(
    () => planD3StandortOptions(
      [{ id: "inactive", name: "Old office", color: "blue" }],
      workerStandortOptions([]),
      [{ properties: { Standort: { select: { name: "Old office" } } } }],
    ),
    /still uses inactive Standort option/,
  );
});
