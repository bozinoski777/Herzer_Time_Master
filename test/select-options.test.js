"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  planSelectOptionUpdate,
  reconcileSelectOptions,
} = require("../scripts/select-options");

test("select reconciliation never sends color with an existing option ID", () => {
  const options = reconcileSelectOptions(
    [
      { id: "ready-id", name: "Ready", color: "green" },
      { id: "obsolete-id", name: "Obsolete", color: "gray" },
    ],
    [
      { name: "Ready", color: "blue" },
      { name: "Error", color: "red" },
    ],
  );

  assert.deepEqual(options, [
    { id: "ready-id", name: "Ready" },
    { name: "Error", color: "red" },
  ]);
  assert.ok(options.every((option) => !(option.id && option.color)));
});

test("additive reconciliation retains existing IDs and requested colors only for new names", () => {
  const options = reconcileSelectOptions(
    [{ id: "berlin-id", name: "Berlin", color: "yellow" }],
    [
      { id: "foreign-option-id", name: "Urlaub", color: "gray" },
      { name: "Berlin", color: "blue" },
    ],
    { retainExisting: true },
  );

  assert.deepEqual(options, [
    { id: "berlin-id", name: "Berlin" },
    { name: "Urlaub", color: "gray" },
  ]);
});

test("the shared planner reports exact additions/removals and ignores forbidden recoloring", () => {
  const plan = planSelectOptionUpdate(
    [
      { id: "berlin-id", name: "Berlin", color: "yellow" },
      { id: "old-id", name: "Old office", color: "blue" },
    ],
    [
      { name: "Berlin", color: "blue" },
      { name: "Urlaub", color: "gray" },
    ],
  );

  assert.deepEqual(plan.added, ["Urlaub"]);
  assert.deepEqual(plan.removed, ["Old office"]);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.nextOptions, [
    { id: "berlin-id", name: "Berlin" },
    { name: "Urlaub", color: "gray" },
  ]);
});

test("the shared planner refuses to remove an option that a row still uses", () => {
  assert.throws(
    () => planSelectOptionUpdate(
      [{ id: "old-id", name: "Old office", color: "blue" }],
      [{ name: "Berlin", color: "blue" }],
      { protectedNames: ["Old office"] },
    ),
    /still in use: Old office/,
  );
});

test("the shared planner avoids a PATCH when only an existing color differs", () => {
  const plan = planSelectOptionUpdate(
    [{ id: "urlaub-id", name: "Urlaub", color: "blue" }],
    [{ name: "Urlaub", color: "gray" }],
  );
  assert.equal(plan.changed, false);
  assert.deepEqual(plan.nextOptions, [{ id: "urlaub-id", name: "Urlaub" }]);
});
