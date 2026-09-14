"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { writableViewUpdate } = require("../scripts/notion");

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
