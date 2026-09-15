"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  D1_WORKER_IDENTITY_SCHEMA,
  FRONTEND_IDENTITY_SCHEMA,
  assertFrontendIdentity,
  frontendIdentity,
  normalizeNotionId,
  selectRecoverableFrontend,
  workerIdentityFromD1,
} = require("../scripts/worker-identity");

function text(value) {
  return value ? [{ plain_text: value }] : [];
}

function d1Row(overrides = {}) {
  return {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    properties: {
      "Vor- und Nachname": { title: text("Max Müller") },
      "Worker Key": { rich_text: text("wrk_max") },
      "Frontend Page ID": { rich_text: text("frontend-current") },
      "User Page ID": { rich_text: text("frontend-legacy") },
    },
    ...overrides,
  };
}

function frontendRow(id, workerKey, d1RecordId) {
  return {
    id,
    properties: {
      "Worker Key": { rich_text: text(workerKey) },
      "D1 Record ID": { rich_text: text(d1RecordId) },
    },
  };
}

test("worker and frontend identity schemas are canonical shared contracts", () => {
  assert.deepEqual(D1_WORKER_IDENTITY_SCHEMA, {
    "Vor- und Nachname": "title",
    "Worker Key": "rich_text",
    "Frontend Page ID": "rich_text",
    "User Page ID": "rich_text",
  });
  assert.deepEqual(FRONTEND_IDENTITY_SCHEMA, {
    "Worker Key": "rich_text",
    "D1 Record ID": "rich_text",
  });
});

test("worker identity uses the D1 row ID and prefers the current frontend reference", () => {
  const row = d1Row();
  const identity = workerIdentityFromD1(row);
  assert.equal(identity.row, row);
  assert.equal(identity.rowId, row.id);
  assert.equal(identity.d1RecordId, row.id);
  assert.equal(identity.name, "Max Müller");
  assert.equal(identity.workerKey, "wrk_max");
  assert.equal(identity.frontendPageId, "frontend-current");
  assert.equal(identity.userPageId, "frontend-legacy");
});

test("worker identity falls back to the legacy frontend reference and row ID name", () => {
  const row = d1Row({
    id: "d1-blank",
    properties: {
      "Vor- und Nachname": { title: [] },
      "Worker Key": { rich_text: [] },
      "Frontend Page ID": { rich_text: [] },
      "User Page ID": { rich_text: text("legacy-page") },
    },
  });
  const identity = workerIdentityFromD1(row);
  assert.equal(identity.name, "d1-blank");
  assert.equal(identity.frontendPageId, "legacy-page");
  assert.equal(identity.workerKey, "");
});

test("Notion page IDs compare equally with or without UUID hyphens", () => {
  assert.equal(
    normalizeNotionId("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"),
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  const frontend = frontendRow(
    "frontend-1",
    "wrk_max",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.doesNotThrow(() =>
    assertFrontendIdentity(frontend, {
      d1RecordId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      workerKey: "wrk_max",
    }),
  );
});

test("frontend recovery uses D1 Record ID before Worker Key and never a name", () => {
  const first = frontendRow("frontend-1", "wrk_first", "d1-first");
  const second = frontendRow("frontend-2", "wrk_second", "d1-second");
  assert.equal(
    selectRecoverableFrontend([first, second], {
      d1RecordId: "d1-second",
      workerKey: "wrk_second",
    }),
    second,
  );
  assert.equal(
    selectRecoverableFrontend([first, second], {
      d1RecordId: "d1-unknown",
      workerKey: "wrk_unknown",
    }),
    undefined,
  );
});

test("a non-empty exact Worker Key recovers only an unclaimed frontend", () => {
  const interrupted = frontendRow("frontend-1", "wrk_first", "");
  assert.equal(
    selectRecoverableFrontend([interrupted], {
      d1RecordId: "d1-first",
      workerKey: "wrk_first",
    }),
    interrupted,
  );
  assert.equal(
    selectRecoverableFrontend([interrupted], {
      d1RecordId: "d1-first",
      workerKey: "",
    }),
    undefined,
  );
});

test("frontend recovery rejects duplicate and crossed identities", () => {
  const d1Owner = frontendRow("frontend-1", "wrk_first", "d1-first");
  const keyOwner = frontendRow("frontend-2", "wrk_second", "d1-second");
  assert.throws(
    () => selectRecoverableFrontend(
      [d1Owner, frontendRow("frontend-3", "wrk_third", "d1-first")],
      { d1RecordId: "d1-first", workerKey: "wrk_first" },
    ),
    /multiple rows with D1 Record ID/,
  );
  assert.throws(
    () => selectRecoverableFrontend(
      [d1Owner, keyOwner],
      { d1RecordId: "d1-first", workerKey: "wrk_second" },
    ),
    /identify different frontend rows/,
  );
  assert.throws(
    () => selectRecoverableFrontend(
      [keyOwner],
      { d1RecordId: "d1-first", workerKey: "wrk_second" },
    ),
    /belongs to D1 Record ID d1-second, not d1-first/,
  );
});

test("frontend assertion requires D1 identity and keeps Worker Keys exact", () => {
  const frontend = frontendRow("frontend-1", "wrk_Max", "d1-first");
  assert.deepEqual(frontendIdentity(frontend), {
    d1RecordId: "d1-first",
    workerKey: "wrk_Max",
  });
  assert.throws(
    () => assertFrontendIdentity(frontend, { workerKey: "wrk_Max" }),
    /D1 Record ID is required/,
  );
  assert.throws(
    () => assertFrontendIdentity(frontend, {
      d1RecordId: "d1-first",
      workerKey: "wrk_max",
    }),
    /belongs to Worker Key wrk_Max, not wrk_max/,
  );
});
