"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.D1_DATA_SOURCE_ID = "test-d1";
process.env.D7_DATA_SOURCE_ID = "test-d7";
process.env.D8_DATA_SOURCE_ID = "test-d8";

const {
  planD3StandortOptions,
  planD7StandortRelations,
  runStandortSynchronization,
  standortOptionAdditions,
  shouldSyncWorkerD3Options,
} = require("../scripts/sync-standorte");
const { workerStandortOptions } = require("../scripts/worker-standort-options");
const { buildRolloverManifest } = require("../scripts/rollover-manifest");

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

test("D7 history also adds missing work choices in gray", () => {
  assert.deepEqual(
    standortOptionAdditions(
      [{ id: "berlin", name: "Berlin", color: "blue" }],
      ["Berlin", "Urlaub", "Krank"],
    ),
    [
      { name: "Urlaub", color: "gray" },
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

test("D7 Standort relation follows its selected D8 Standort, including inactive sites", () => {
  const updates = planD7StandortRelations(
    [
      {
        id: "d7-used-site",
        properties: { Standort: { select: { name: "Old office" } }, "Standort (D8)": { relation: [] } },
      },
      {
        id: "d7-work-type",
        properties: {
          Standort: { select: { name: "Urlaub" } },
          "Standort (D8)": { relation: [{ id: "stale-site" }] },
        },
      },
      {
        id: "d7-already-linked",
        properties: {
          Standort: { select: { name: "Berlin" } },
          "Standort (D8)": { relation: [{ id: "d8-berlin" }] },
        },
      },
    ],
    [
      { id: "d8-berlin", properties: { Standort: { title: [{ plain_text: "Berlin" }] } } },
      { id: "d8-old-office", properties: { Standort: { title: [{ plain_text: "Old office" }] } } },
    ],
  );

  assert.deepEqual(updates, [
    { pageId: "d7-used-site", relatedD8Id: "d8-old-office" },
    { pageId: "d7-work-type", relatedD8Id: null },
  ]);
});

test("D7 Standort relation refuses ambiguous duplicate D8 names", () => {
  assert.throws(
    () => planD7StandortRelations(
      [],
      [
        { id: "d8-1", properties: { Standort: { title: [{ plain_text: "Berlin" }] } } },
        { id: "d8-2", properties: { Standort: { title: [{ plain_text: "Berlin" }] } } },
      ],
    ),
    /more than one Standort named "Berlin"/,
  );
});

test("D7 relation fails closed for an unknown physical Standort but allows work choices", () => {
  assert.throws(
    () => planD7StandortRelations(
      [{
        id: "d7-missing-site",
        properties: {
          Standort: { select: { name: "Missing office" } },
          "Standort (D8)": { relation: [{ id: "old-site" }] },
        },
      }],
      [],
    ),
    /D8 has no matching location/,
  );
  assert.deepEqual(
    planD7StandortRelations(
      [{
        id: "d7-vacation",
        properties: {
          Standort: { select: { name: "Urlaub" } },
          "Standort (D8)": { relation: [{ id: "old-site" }] },
        },
      }],
      [],
    ),
    [{ pageId: "d7-vacation", relatedD8Id: null }],
  );
});

test("one worker D3 failure does not block shared D7 option and relation reconciliation", async () => {
  const calls = [];
  await assert.rejects(
    () => runStandortSynchronization(
      [
        { name: "Broken worker", d3DataSourceId: "d3-broken", rolloverManifest: "" },
        { name: "Healthy worker", d3DataSourceId: "d3-healthy", rolloverManifest: "" },
      ],
      ["Berlin"],
      {
        syncD3StandortOptions: async (dataSourceId) => {
          calls.push(`d3:${dataSourceId}`);
          if (dataSourceId === "d3-broken") throw new Error("worker option failure");
          return { added: [], removed: [] };
        },
        addMissingStandortOptions: async () => {
          calls.push("d7-options");
          return 0;
        },
        syncD7StandortRelations: async () => {
          calls.push("d7-relations");
          return 0;
        },
      },
    ),
    /Broken worker: worker option failure/,
  );
  assert.deepEqual(calls, [
    "d3:d3-broken",
    "d3:d3-healthy",
    "d7-options",
    "d7-relations",
  ]);
});

test("Standort sync validates and skips a pending rollover checkpoint", () => {
  const worker = {
    name: "Ada",
    workerKey: "worker-a",
    d3DatabaseId: "d3-db-a",
    d3DataSourceId: "d3-source-a",
    d4DatabaseId: "d4-db-a",
    d4DataSourceId: "d4-source-a",
    rolloverStatus: "Running",
  };
  const manifest = buildRolloverManifest(worker, "2026-08", []);
  assert.equal(
    shouldSyncWorkerD3Options({ ...worker, rolloverManifest: JSON.stringify(manifest) }),
    false,
  );
  assert.throws(
    () => shouldSyncWorkerD3Options({ ...worker, rolloverManifest: "not-json" }),
    /not valid JSON/,
  );
});
