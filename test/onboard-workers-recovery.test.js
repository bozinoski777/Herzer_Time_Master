"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.D1_DATA_SOURCE_ID = "test-d1";
process.env.D8_DATA_SOURCE_ID = "test-d8";
process.env.EMPLOYEE_FRONTENDS_DATA_SOURCE_ID = "test-frontends";

const {
  assertFrontendIdentity,
  recoveredStandortOptions,
  selectRecoverableFrontend,
} = require("../scripts/onboard-workers");

function frontendRow(id, name, key, d1RecordId) {
  const text = (value) => value ? [{ plain_text: value }] : [];
  return {
    id,
    properties: {
      "Vor- und Nachname": { title: text(name) },
      "Worker Key": { rich_text: text(key) },
      "D1 Record ID": { rich_text: text(d1RecordId) },
    },
  };
}

test("recovery distinguishes same-name workers by exact D1 Record ID", () => {
  const first = frontendRow("frontend-1", "Max Müller", "wrk_first", "d1-first");
  const second = frontendRow("frontend-2", "Max Müller", "wrk_second", "d1-second");

  assert.equal(
    selectRecoverableFrontend([first, second], "wrk_second", "d1-second"),
    second,
  );
  assert.equal(
    selectRecoverableFrontend([first, second], "wrk_unknown", "d1-unknown"),
    undefined,
    "a matching name alone must never recover a frontend",
  );
});

test("recovery falls back to an exact non-empty Worker Key only when D1 is not yet stored", () => {
  const interruptedCreate = frontendRow("frontend-1", "Max Müller", "wrk_first", "");
  const sameName = frontendRow("frontend-2", "Max Müller", "wrk_second", "d1-second");

  assert.equal(
    selectRecoverableFrontend([interruptedCreate, sameName], "wrk_first", "d1-first"),
    interruptedCreate,
  );
  assert.equal(
    selectRecoverableFrontend([interruptedCreate, sameName], "", "d1-first"),
    undefined,
    "empty Worker Keys must not match empty frontend values",
  );
});

test("recovery rejects duplicate D1 Record IDs and duplicate Worker Keys", () => {
  const duplicateD1Rows = [
    frontendRow("frontend-1", "Max Müller", "wrk_first", "d1-first"),
    frontendRow("frontend-2", "Max Müller", "wrk_second", "d1-first"),
  ];
  assert.throws(
    () => selectRecoverableFrontend(duplicateD1Rows, "wrk_first", "d1-first"),
    /multiple rows with D1 Record ID d1-first/,
  );

  const duplicateKeyRows = [
    frontendRow("frontend-1", "Max Müller", "wrk_first", ""),
    frontendRow("frontend-2", "Max Müller", "wrk_first", ""),
  ];
  assert.throws(
    () => selectRecoverableFrontend(duplicateKeyRows, "wrk_first", "d1-first"),
    /multiple rows with Worker Key wrk_first/,
  );
});

test("recovery rejects conflicting D1 and Worker Key ownership", () => {
  const d1Owner = frontendRow("frontend-1", "Max Müller", "wrk_first", "d1-first");
  const keyOwner = frontendRow("frontend-2", "Max Müller", "wrk_second", "d1-second");

  assert.throws(
    () => selectRecoverableFrontend([d1Owner, keyOwner], "wrk_second", "d1-first"),
    /identify different frontend rows/,
  );
  assert.throws(
    () => selectRecoverableFrontend([keyOwner], "wrk_second", "d1-first"),
    /belongs to D1 Record ID d1-second, not d1-first/,
  );
  assert.throws(
    () => selectRecoverableFrontend([d1Owner], "wrk_changed", "d1-first"),
    /has D1 Record ID d1-first but Worker Key wrk_first, not wrk_changed/,
  );
});

test("recovery requires a D1 Record ID", () => {
  const row = frontendRow("frontend-1", "Max Müller", "wrk_first", "");
  assert.throws(
    () => selectRecoverableFrontend([row], "wrk_first", ""),
    /D1 Record ID is required/,
  );
});

test("a remembered frontend ID is rejected before another worker's identity is overwritten", () => {
  const anotherWorker = frontendRow("frontend-2", "Max Müller", "wrk_second", "d1-second");
  assert.throws(
    () => assertFrontendIdentity(anotherWorker, "wrk_first", "d1-first"),
    /belongs to D1 Record ID d1-second/,
  );
  assert.throws(
    () => assertFrontendIdentity(
      frontendRow("frontend-1", "Max Müller", "wrk_second", ""),
      "wrk_first",
      "d1-first",
    ),
    /belongs to Worker Key wrk_second/,
  );
  assert.doesNotThrow(() => assertFrontendIdentity(
    frontendRow("frontend-1", "Max Müller", "", ""),
    "wrk_first",
    "d1-first",
  ));
});

test("partial onboarding recovery adds work choices in gray without recoloring existing options", () => {
  const plan = recoveredStandortOptions(
    [{ id: "berlin", name: "Berlin", color: "red" }],
    ["Berlin"],
  );
  assert.deepEqual(plan.options[0], { id: "berlin", name: "Berlin" });
  assert.deepEqual(
    plan.additions.map((option) => ({ name: option.name, color: option.color })),
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
