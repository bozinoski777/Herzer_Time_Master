"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ARCHIVE_MONTH_FORMULA,
  archiveSchemaProperties,
  archiveViewPayload,
  currentMonthViewPayload,
  managementViewProperties,
} = require("../scripts/frontend-presentation");

function dataSource() {
  return {
    id: "test-data-source",
    properties: {
      Wochentag: { id: "title", name: "Wochentag", type: "title" },
      Datum: { id: "date", name: "Datum", type: "date" },
      Standort: { id: "site", name: "Standort", type: "select" },
      Stunden: { id: "hours", name: "Stunden", type: "number" },
      "Sync Key": { id: "sync", name: "Sync Key", type: "rich_text" },
      Monat: { id: "month", name: "Monat", type: "formula" },
      "Worker Key": { id: "worker-key", name: "Worker Key", type: "rich_text" },
      "D1 Record ID": { id: "d1-id", name: "D1 Record ID", type: "rich_text" },
      "Vor- und Nachname": { id: "employee", name: "Vor- und Nachname", type: "title" },
    },
  };
}

test("D3 view has no date filter and shows worker columns in ascending date order", () => {
  const payload = currentMonthViewPayload(dataSource());
  assert.deepEqual(payload.sorts, [{ property: "Datum", direction: "ascending" }]);
  assert.equal("filter" in payload, false);
  assert.deepEqual(
    payload.configuration.properties.map((property) => property.property_id),
    ["title", "date", "site", "hours"],
  );
  assert.ok(payload.configuration.properties.every((property) => property.visible));
});

test("D4 groups by formula month, sorts newest first, and hides technical fields", () => {
  assert.deepEqual(archiveSchemaProperties(), {
    "Sync Key": { rich_text: {} },
    Monat: { formula: { expression: ARCHIVE_MONTH_FORMULA } },
  });

  const payload = archiveViewPayload(dataSource());
  assert.deepEqual(payload.sorts, [{ property: "Datum", direction: "descending" }]);
  assert.equal(payload.configuration.group_by.property_id, "month");
  assert.deepEqual(payload.configuration.group_by.group_by, {
    type: "text",
    group_by: "exact",
    sort: { type: "descending" },
  });
  assert.equal(
    payload.configuration.properties.find((property) => property.property_id === "sync").visible,
    false,
  );
  assert.equal(
    payload.configuration.properties.find((property) => property.property_id === "month").visible,
    false,
  );
});

test("management view retains existing settings while hiding frontend internals", () => {
  const properties = managementViewProperties(dataSource(), {
    properties: [
      { property_id: "employee", visible: true, width: 350 },
      { property_id: "worker-key", visible: true, width: 200 },
    ],
  });
  assert.deepEqual(properties.find((property) => property.property_id === "employee"), {
    property_id: "employee",
    visible: true,
    width: 350,
  });
  assert.equal(
    properties.find((property) => property.property_id === "worker-key").visible,
    false,
  );
  assert.equal(
    properties.find((property) => property.property_id === "d1-id").visible,
    false,
  );
});
