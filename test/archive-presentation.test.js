"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ARCHIVE_DATABASE_TITLE,
  ARCHIVE_MONTH_FORMULA,
  ARCHIVE_MONTH_PROPERTY,
  D4_PROPERTY_TYPES,
  archiveSchemaProperties,
  archiveViewPayload,
} = require("../scripts/archive-presentation");

function archiveDataSource(overrides = {}) {
  return {
    id: "archive-source",
    properties: {
      Wochentag: { id: "weekday", name: "Wochentag", type: "title" },
      Datum: { id: "date", name: "Datum", type: "date" },
      Stunden: { id: "hours", name: "Stunden", type: "number" },
      Standort: { id: "location", name: "Standort", type: "select" },
      "Sync Key": { id: "sync-key", name: "Sync Key", type: "rich_text" },
      Monat: { id: "month", name: "Monat", type: "formula" },
      ...overrides,
    },
  };
}

test("archive presentation exports the canonical title and schema metadata", () => {
  assert.equal(ARCHIVE_DATABASE_TITLE, "Archiv");
  assert.equal(ARCHIVE_MONTH_PROPERTY, "Monat");
  assert.equal(ARCHIVE_MONTH_FORMULA, 'formatDate(prop("Datum"), "YYYY-MM")');
  assert.deepEqual(D4_PROPERTY_TYPES, {
    Wochentag: "title",
    Datum: "date",
    Stunden: "number",
    Standort: "select",
    "Sync Key": "rich_text",
    Monat: "formula",
  });
  assert.deepEqual(archiveSchemaProperties(), {
    "Sync Key": { rich_text: {} },
    Monat: { formula: { expression: ARCHIVE_MONTH_FORMULA } },
  });
});

test("archive table payload sorts newest first, groups by month, and hides technical fields", () => {
  const payload = archiveViewPayload(archiveDataSource());

  assert.deepEqual(payload.sorts, [{ property: "Datum", direction: "descending" }]);
  assert.equal("filter" in payload, false);
  assert.deepEqual(payload.configuration.group_by, {
    type: "formula",
    property_id: "month",
    group_by: {
      type: "text",
      group_by: "exact",
      sort: { type: "descending" },
    },
    hide_empty_groups: true,
  });
  assert.deepEqual(payload.configuration.properties, [
    { property_id: "weekday", visible: true },
    { property_id: "date", visible: true },
    { property_id: "location", visible: true },
    { property_id: "hours", visible: true },
    { property_id: "sync-key", visible: false },
    { property_id: "month", visible: false },
  ]);
});

test("archive view payload rejects a non-canonical archive schema", () => {
  assert.throws(
    () => archiveViewPayload(archiveDataSource({ Monat: { id: "month", type: "rich_text" } })),
    /Monat.*rich_text.*expected formula/,
  );
  assert.throws(
    () => archiveViewPayload(archiveDataSource({ "Sync Key": undefined })),
    /missing "Sync Key"/,
  );
});
