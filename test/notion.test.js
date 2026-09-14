"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { writableViewProperties, writableViewUpdate } = require("../scripts/notion");

test("view updates omit Notion's non-writable negative frozen-column sentinel", () => {
  assert.deepEqual(
    writableViewUpdate({
      name: "Management",
      configuration: {
        type: "table",
        frozen_column_index: -1,
        rows: [{ id: "read-only-row" }],
        wrap_cells: false,
      },
    }),
    {
      name: "Management",
      configuration: {
        type: "table",
        wrap_cells: false,
      },
    },
  );
});

test("view updates preserve valid frozen-column settings", () => {
  assert.deepEqual(
    writableViewUpdate({
      configuration: { type: "table", frozen_column_index: 1 },
    }),
    {
      configuration: { type: "table", frozen_column_index: 1 },
    },
  );
});

test("view property updates discard stale IDs and normalize encoded current IDs", () => {
  const dataSource = {
    properties: {
      Name: { id: "title" },
      Status: { id: "%5FhSA" },
    },
  };
  assert.deepEqual(
    writableViewProperties(dataSource, [
      { property_id: "title", visible: true },
      { property_id: "_hSA", visible: false },
      { property_id: "deleted-property", visible: true },
      { property_id: "Status", visible: true },
    ]),
    [
      { property_id: "title", visible: true },
      { property_id: "%5FhSA", visible: false },
    ],
  );
});
