"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { reconcileSelectOptions } = require("../scripts/select-options");

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
