"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.D1_DATA_SOURCE_ID = "test-d1";
process.env.D7_DATA_SOURCE_ID = "test-d7";

const {
  assertFinalOffboardingCheckpoint,
  shouldSyncWorker,
  validateWorkerRegistry,
} = require("../scripts/sync-management");
const { OFFBOARDING_STATUS } = require("../scripts/offboarding");
const { buildRolloverManifest } = require("../scripts/rollover-manifest");

function completeWorker(overrides = {}) {
  return {
    name: "Alex Example",
    active: false,
    offboardingStatus: OFFBOARDING_STATUS.COMPLETE,
    finalSyncAt: "2026-09-14T08:00:00.000Z",
    sharingStatus: "Revoked",
    accessRevoked: {
      "Frontend Access Revoked": true,
      "D3 Access Revoked": true,
      "D4 Access Revoked": true,
    },
    workerKey: "wrk_alex",
    d3DatabaseId: "11111111-1111-1111-1111-111111111111",
    d3DataSourceId: "22222222-2222-2222-2222-222222222222",
    d4DatabaseId: "33333333-3333-3333-3333-333333333333",
    d4DataSourceId: "44444444-4444-4444-4444-444444444444",
    currentMonth: "2026-09",
    rowId: "d1-alex",
    row: {
      properties: {
        "Current Month": { rich_text: [{ plain_text: "2026-09" }] },
      },
    },
    onboardingStatus: "Ready",
    rolloverManifest: "",
    rolloverStatus: "Ready",
    ...overrides,
  };
}

function sourceRow(id, date, { hours = 8 } = {}) {
  return {
    id,
    properties: {
      Wochentag: { title: [{ plain_text: "Montag" }] },
      Datum: { date: { start: date } },
      Stunden: { number: hours },
      Standort: { select: { name: "Berlin" } },
    },
  };
}

test("final offboarding checkpoint requires unchanged D1 state and D3 values", () => {
  const worker = completeWorker({
    offboardingStatus: OFFBOARDING_STATUS.REVOKE_ACCESS,
    finalSyncAt: "",
    sharingStatus: "Invited",
  });
  const refreshed = {
    ...worker,
    offboardingStatus: OFFBOARDING_STATUS.FINAL_SYNC,
  };
  const sourceRows = [sourceRow("source-1", "2026-09-01")];

  assert.doesNotThrow(() =>
    assertFinalOffboardingCheckpoint(worker, refreshed, sourceRows, sourceRows),
  );
  assert.throws(
    () => assertFinalOffboardingCheckpoint(
      worker,
      { ...refreshed, active: true },
      sourceRows,
      sourceRows,
    ),
    /D1 changed during final offboarding sync/,
  );
  assert.throws(
    () => assertFinalOffboardingCheckpoint(
      worker,
      {
        ...refreshed,
        accessRevoked: {
          ...refreshed.accessRevoked,
          "D4 Access Revoked": false,
        },
      },
      sourceRows,
      sourceRows,
    ),
    /D1 changed during final offboarding sync/,
  );
  assert.throws(
    () => assertFinalOffboardingCheckpoint(
      worker,
      {
        ...refreshed,
        row: { properties: { "Current Month": { rich_text: [] } } },
      },
      sourceRows,
      sourceRows,
    ),
    /D1 changed during final offboarding sync/,
  );
  assert.throws(
    () => assertFinalOffboardingCheckpoint(
      worker,
      refreshed,
      sourceRows,
      [sourceRow("source-1", "2026-09-01", { hours: 4 })],
    ),
    /D3 changed during final offboarding sync/,
  );
  assert.throws(
    () => assertFinalOffboardingCheckpoint(
      worker,
      refreshed,
      sourceRows,
      [...sourceRows, sourceRow("source-2", "2026-09-02")],
    ),
    /D3 changed during final offboarding sync/,
  );
});

test("Daily skips only a fully proven terminal offboarding state", () => {
  const complete = completeWorker();
  const manifest = buildRolloverManifest(complete, "2026-08", []);
  assert.equal(shouldSyncWorker(complete), false);
  assert.equal(shouldSyncWorker({ ...complete, finalSyncAt: "" }), true);
  assert.equal(shouldSyncWorker({ ...complete, sharingStatus: "Invited" }), true);
  assert.equal(shouldSyncWorker({ ...complete, active: true }), true);
  assert.equal(
    shouldSyncWorker({
      ...complete,
      active: true,
      rolloverManifest: JSON.stringify(manifest),
      rolloverStatus: "Error",
    }),
    false,
  );
  assert.throws(
    () => shouldSyncWorker({ ...complete, rolloverManifest: "{checkpoint}" }),
    /not valid JSON/,
  );
  assert.throws(
    () => shouldSyncWorker({
      ...complete,
      rolloverManifest: JSON.stringify(manifest),
      rolloverStatus: "Ready",
    }),
    /Manifest exists while Rollover Status is Ready/,
  );
});

test("incomplete routing is isolated per worker while duplicate routing fails globally", () => {
  const valid = completeWorker();
  assert.doesNotThrow(() => validateWorkerRegistry([
    valid,
    completeWorker({ name: "Not provisioned", workerKey: "", d3DatabaseId: "", d3DataSourceId: "" }),
  ]));
  assert.throws(
    () => validateWorkerRegistry([
      valid,
      completeWorker({
        name: "Crossed worker",
        workerKey: "wrk_other",
        d3DatabaseId: "11111111111111111111111111111111",
        d3DataSourceId: "33333333-3333-3333-3333-333333333333",
      }),
    ]),
    /assigns D3 database/,
  );
});
