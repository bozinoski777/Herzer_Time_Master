"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  OFFBOARDING_STATUS,
  accessRevocationComplete,
  assertValidWorkerState,
  hasActiveOffboardingConflict,
  offboardingComplete,
  offboardingState,
  offboardingViewProperties,
} = require("../scripts/offboarding");

function d1Row({ status = "", frontend = false, d3 = false, d4 = false } = {}) {
  return {
    properties: {
      "Offboarding Status": { select: status ? { name: status } : null },
      "Final Sync At": { date: null },
      "Frontend Access Revoked": { checkbox: frontend },
      "D3 Access Revoked": { checkbox: d3 },
      "D4 Access Revoked": { checkbox: d4 },
    },
  };
}

test("the three D1 access attestations form a complete offboarding checklist", () => {
  const partial = offboardingState(d1Row({ frontend: true, d3: true }));
  const complete = offboardingState(d1Row({ frontend: true, d3: true, d4: true }));
  assert.equal(accessRevocationComplete(partial), false);
  assert.equal(accessRevocationComplete(complete), true);
});

test("an active worker cannot silently resume from an offboarding state", () => {
  assert.throws(
    () => assertValidWorkerState({
      name: "Alex Example",
      active: true,
      offboardingStatus: OFFBOARDING_STATUS.COMPLETE,
    }),
    /Restore the three Notion shares/,
  );
  assert.doesNotThrow(() => assertValidWorkerState({
    name: "Alex Example",
    active: true,
    offboardingStatus: OFFBOARDING_STATUS.ACTIVE,
  }));
  assert.throws(
    () => assertValidWorkerState({
      name: "Alex Example",
      active: true,
      offboardingStatus: OFFBOARDING_STATUS.ACTIVE,
      accessRevoked: { "Frontend Access Revoked": true },
    }),
    /one or more access-revocation boxes/,
  );
  assert.throws(
    () => assertValidWorkerState({
      name: "Alex Example",
      active: true,
      offboardingStatus: "",
      finalSyncAt: "2026-09-14T08:00:00.000Z",
      sharingStatus: "Invited",
      accessRevoked: {},
    }),
    /blank with prior final-sync\/revocation evidence/,
  );
  assert.throws(
    () => assertValidWorkerState({
      name: "Alex Example",
      active: true,
      offboardingStatus: "",
      finalSyncAt: "",
      sharingStatus: "Revoked",
      accessRevoked: {},
    }),
    /blank with prior final-sync\/revocation evidence/,
  );
  assert.doesNotThrow(() => assertValidWorkerState({
    name: "Alex Example",
    active: true,
    offboardingStatus: "",
    finalSyncAt: "",
    sharingStatus: "Invited",
    accessRevoked: {},
  }));
});

test("offboarding is terminal only with checklist, final-sync proof, and revoked sharing", () => {
  const complete = {
    name: "Alex Example",
    active: false,
    offboardingStatus: OFFBOARDING_STATUS.COMPLETE,
    accessRevoked: {
      "Frontend Access Revoked": true,
      "D3 Access Revoked": true,
      "D4 Access Revoked": true,
    },
    finalSyncAt: "2026-09-14T08:00:00.000Z",
    sharingStatus: "Revoked",
  };
  assert.equal(offboardingComplete(complete), true);
  assert.equal(offboardingComplete({ ...complete, finalSyncAt: "" }), false);
  assert.equal(offboardingComplete({ ...complete, sharingStatus: "Invited" }), false);
  assert.equal(
    offboardingComplete({
      ...complete,
      accessRevoked: { ...complete.accessRevoked, "D4 Access Revoked": false },
    }),
    false,
  );
});

test("active offboarding contradictions are distinguishable from ordinary sync failures", () => {
  assert.equal(hasActiveOffboardingConflict({
    active: true,
    offboardingStatus: OFFBOARDING_STATUS.COMPLETE,
  }), true);
  assert.equal(hasActiveOffboardingConflict({
    active: true,
    offboardingStatus: OFFBOARDING_STATUS.ACTIVE,
    accessRevoked: { "D3 Access Revoked": true },
  }), true);
  assert.equal(hasActiveOffboardingConflict({
    active: true,
    offboardingStatus: OFFBOARDING_STATUS.ACTIVE,
    accessRevoked: {},
  }), false);
  assert.equal(hasActiveOffboardingConflict({
    active: true,
    offboardingStatus: "",
    finalSyncAt: "2026-09-14T08:00:00.000Z",
    sharingStatus: "Invited",
    accessRevoked: {},
  }), true);
  assert.equal(hasActiveOffboardingConflict({
    active: true,
    offboardingStatus: "",
    finalSyncAt: "",
    sharingStatus: "Revoked",
    accessRevoked: {},
  }), true);
});

test("D1 table configuration makes every offboarding status/checklist field visible", () => {
  const names = [
    "Offboarding Status",
    "Offboarding Error",
    "Final Sync At",
    "Frontend Access Revoked",
    "D3 Access Revoked",
    "D4 Access Revoked",
  ];
  const dataSource = {
    properties: {
      Unrelated: { id: "unrelated" },
      ...Object.fromEntries(names.map((name, index) => [name, { id: `p${index}` }])),
    },
  };
  const properties = offboardingViewProperties(dataSource, {
    properties: [
      { property_id: "unrelated", visible: false },
      { property_id: "p0", visible: false },
    ],
  });
  assert.deepEqual(properties[0], { property_id: "unrelated", visible: false });
  assert.deepEqual(properties[1], { property_id: "p0", visible: true });
  assert.equal(properties.filter((entry) => entry.visible).length, names.length);
});
