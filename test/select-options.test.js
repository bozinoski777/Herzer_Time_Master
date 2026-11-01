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

function selectServiceWithRecordedWrites() {
  const notionPath = require.resolve("../scripts/notion");
  const servicePath = require.resolve("../scripts/select-options");
  const originalNotion = require.cache[notionPath];
  const originalService = require.cache[servicePath];
  const writes = [];
  try {
    require.cache[notionPath] = {
      ...originalNotion,
      exports: {
        ...originalNotion.exports,
        getDataSource: async () => { throw new Error("Unexpected data-source read"); },
        updateDataSource: async (id, properties) => { writes.push({ id, properties }); },
      },
    };
    delete require.cache[servicePath];
    return { writes, ...require("../scripts/select-options") };
  } finally {
    require.cache[notionPath] = originalNotion;
    require.cache[servicePath] = originalService;
  }
}

function historicalOptions(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `historical-${index}`,
    name: `Site ${index}`,
    color: index % 2 ? "yellow" : "green",
  }));
}

function sourceWithOptions(options) {
  return { properties: { Standort: { type: "select", select: { options } } } };
}

test("an additive update at the 100-option boundary preserves every historical ID", async () => {
  const { writes, updateDataSourceSelect } = selectServiceWithRecordedWrites();
  const existing = historicalOptions(99);
  const plan = await updateDataSourceSelect({
    dataSourceId: "archive",
    dataSource: sourceWithOptions(existing),
    propertyName: "Standort",
    desiredOptions: [{ name: "New site", color: "blue" }],
    retainExisting: true,
  });

  assert.deepEqual(plan.added, ["New site"]);
  assert.equal(writes.length, 1);
  const written = writes[0].properties.Standort.select.options;
  assert.equal(written.length, 100);
  assert.deepEqual(written.slice(0, 99), existing.map(({ id, name }) => ({ id, name })));
  assert.deepEqual(written[99], { name: "New site", color: "blue" });
});

test("oversized historical additions defer only with explicit page-write opt-in", async () => {
  const { writes, updateDataSourceSelect } = selectServiceWithRecordedWrites();
  const existing = historicalOptions(100);
  const before = structuredClone(existing);
  const additions = ["A", "B", "C", "D"].map((name) => ({ name, color: "blue" }));
  const plan = await updateDataSourceSelect({
    dataSourceId: "archive",
    dataSource: sourceWithOptions(existing),
    propertyName: "Standort",
    desiredOptions: additions,
    retainExisting: true,
    allowPageWritesToAdd: true,
  });

  assert.deepEqual(plan.deferred, ["A", "B", "C", "D"]);
  assert.deepEqual(plan.removed, []);
  assert.equal(plan.nextOptions.length, 104);
  assert.deepEqual(writes, []);
  assert.deepEqual(existing, before);
});

test("an unchanged historical list larger than 100 remains a safe no-op", async () => {
  const { writes, updateDataSourceSelect } = selectServiceWithRecordedWrites();
  const existing = historicalOptions(104);
  const plan = await updateDataSourceSelect({
    dataSourceId: "archive",
    dataSource: sourceWithOptions(existing),
    propertyName: "Standort",
    desiredOptions: [{ name: existing[0].name, color: "blue" }],
    retainExisting: true,
  });

  assert.equal(plan.changed, false);
  assert.deepEqual(writes, []);
});

test("oversized updates without opt-in fail before any schema mutation", async () => {
  const { writes, updateDataSourceSelect } = selectServiceWithRecordedWrites();
  await assert.rejects(
    updateDataSourceSelect({
      dataSourceId: "archive",
      dataSource: sourceWithOptions(historicalOptions(100)),
      propertyName: "Standort",
      desiredOptions: [{ name: "New site" }],
      retainExisting: true,
    }),
    /needs 101 options.*at most 100.*Existing options were preserved/,
  );
  assert.deepEqual(writes, []);
});

test("page-write opt-in never bypasses an oversized replacement or removal", async () => {
  const { writes, updateDataSourceSelect } = selectServiceWithRecordedWrites();
  const existing = historicalOptions(102);
  await assert.rejects(
    updateDataSourceSelect({
      dataSourceId: "current-month",
      dataSource: sourceWithOptions(existing),
      propertyName: "Standort",
      desiredOptions: existing.slice(1),
      allowPageWritesToAdd: true,
    }),
    /needs 101 options.*at most 100/,
  );
  assert.deepEqual(writes, []);
});
