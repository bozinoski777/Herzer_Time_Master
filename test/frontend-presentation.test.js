"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ARCHIVE_MONTH_FORMULA,
  VACATION_CHART_TITLE,
  archiveSchemaProperties,
  archiveViewPayload,
  currentMonthViewPayload,
  managementViewProperties,
  vacationChartPayload,
  vacationFilter,
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

test("vacation number chart counts Urlaub rows through the prior completed month", () => {
  assert.deepEqual(vacationFilter("2027-01"), {
    and: [
      { property: "Standort", select: { equals: "Urlaub" } },
      { property: "Datum", date: { on_or_after: "2027-01-01" } },
      { property: "Datum", date: { before: "2027-01-01" } },
    ],
  });
  assert.deepEqual(vacationFilter("2027-10").and.at(-1), {
    property: "Datum",
    date: { before: "2027-10-01" },
  });

  const payload = vacationChartPayload(dataSource(), "2027-10");
  assert.equal(payload.name, VACATION_CHART_TITLE);
  assert.equal(payload.configuration.chart_type, "number");
  assert.deepEqual(payload.configuration.value, { aggregator: "count" });
  assert.equal(payload.configuration.height, "small");
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
