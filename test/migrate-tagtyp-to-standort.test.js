"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.D1_DATA_SOURCE_ID = "test-d1";
process.env.D7_DATA_SOURCE_ID = "test-d7";

const { planSource } = require("../scripts/migrate-tagtyp-to-standort");

test("legacy Tagtyp migration moves only blank Standort rows and detects conflicts", () => {
  const plan = planSource(
    { label: "Test D3", kinds: new Set(["d3"]) },
    {
      id: "test-d3",
      properties: {
        Standort: { type: "select", select: { options: [{ id: "berlin", name: "Berlin", color: "blue" }] } },
        Tagtyp: { type: "select", select: { options: [{ id: "urlaub", name: "Urlaub", color: "blue" }] } },
      },
    },
    [
      { id: "move", properties: { Standort: { select: null }, Tagtyp: { select: { name: "Urlaub" } } } },
      { id: "conflict", properties: { Standort: { select: { name: "Berlin" } }, Tagtyp: { select: { name: "Urlaub" } } } },
    ],
  );

  assert.deepEqual(plan.moves, [{ rowId: "move", value: "Urlaub" }]);
  assert.deepEqual(plan.conflicts, [{ rowId: "conflict", standort: "Berlin", legacy: "Urlaub" }]);
  assert.ok(plan.options.some((option) => option.name === "Urlaub"));
  assert.ok(plan.options.some((option) => option.name === "Arbeit"));
});
