"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  D1_WORKER_REFERENCE_SCHEMA,
  assertPageBelongsToWorkerRoute,
  assertUniqueWorkerReferences,
  assertWorkerDatabaseReference,
  assertWorkerDataSourceReference,
  missingWorkerReferences,
  workerDataSourceTargets,
  workerReferencesFromD1,
} = require("../scripts/worker-database-references");

const DAY_TYPES = {
  Wochentag: "title",
  Datum: "date",
  Stunden: "number",
  Standort: "select",
};

function text(value) {
  return value ? [{ plain_text: value }] : [];
}

function worker(overrides = {}) {
  return {
    name: "Ada",
    rowId: "d1-ada",
    workerKey: "wrk_ada",
    frontendPageId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    d3DatabaseId: "11111111-1111-1111-1111-111111111111",
    d3DataSourceId: "22222222-2222-2222-2222-222222222222",
    d4DatabaseId: "33333333-3333-3333-3333-333333333333",
    d4DataSourceId: "44444444-4444-4444-4444-444444444444",
    ...overrides,
  };
}

function dataSource(overrides = {}) {
  return {
    id: "22222222222222222222222222222222",
    parent: {
      type: "database_id",
      database_id: "11111111111111111111111111111111",
    },
    properties: Object.fromEntries(
      Object.entries(DAY_TYPES).map(([name, type]) => [name, { type }]),
    ),
    ...overrides,
  };
}

function database(overrides = {}) {
  return {
    id: "11111111111111111111111111111111",
    parent: {
      type: "page_id",
      page_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    data_sources: [{ id: "22222222222222222222222222222222" }],
    ...overrides,
  };
}

test("D1 database-reference fields have one shared schema contract", () => {
  assert.deepEqual(D1_WORKER_REFERENCE_SCHEMA, {
    "D3 Database ID": "rich_text",
    "D3 Data Source ID": "rich_text",
    "D4 Database ID": "rich_text",
    "D4 Data Source ID": "rich_text",
  });
});

test("D1 rows are parsed into one canonical worker-reference shape", () => {
  const row = {
    id: "d1-ada",
    properties: {
      "Vor- und Nachname": { title: text("Ada") },
      "Worker Key": { rich_text: text("wrk_ada") },
      "Frontend Page ID": { rich_text: text("frontend-ada") },
      "User Page ID": { rich_text: [] },
      "D3 Database ID": { rich_text: text("d3-db") },
      "D3 Data Source ID": { rich_text: text("d3-source") },
      "D4 Database ID": { rich_text: text("d4-db") },
      "D4 Data Source ID": { rich_text: text("d4-source") },
    },
  };
  assert.deepEqual(
    {
      ...workerReferencesFromD1(row),
      row: undefined,
    },
    {
      row: undefined,
      rowId: "d1-ada",
      d1RecordId: "d1-ada",
      name: "Ada",
      workerKey: "wrk_ada",
      frontendPageId: "frontend-ada",
      userPageId: "",
      d3DatabaseId: "d3-db",
      d3DataSourceId: "d3-source",
      d4DatabaseId: "d4-db",
      d4DataSourceId: "d4-source",
    },
  );
});

test("missing references are reported by their exact D1 property names", () => {
  assert.deepEqual(
    missingWorkerReferences(worker({
      workerKey: "",
      frontendPageId: "",
      d4DatabaseId: "",
      d4DataSourceId: "",
    }), { requireFrontend: true }),
    ["Worker Key", "Frontend Page ID", "D4 Database ID", "D4 Data Source ID"],
  );
  assert.deepEqual(
    missingWorkerReferences(worker({ d4DataSourceId: "" }), {
      roles: ["d3"],
      requireWorkerKey: false,
    }),
    [],
  );
});

test("the registry rejects normalized and crossed D3/D4 references", () => {
  assert.throws(
    () => assertUniqueWorkerReferences([
      worker(),
      worker({
        name: "Grace",
        workerKey: "wrk_grace",
        d3DatabaseId: "55555555-5555-5555-5555-555555555555",
        d3DataSourceId: "44444444444444444444444444444444",
        d4DatabaseId: "66666666-6666-6666-6666-666666666666",
        d4DataSourceId: "77777777-7777-7777-7777-777777777777",
      }),
    ]),
    /reuses D3 Data Source ID.*already D4 Data Source ID for Ada/,
  );
  assert.throws(
    () => assertUniqueWorkerReferences([
      worker({ d4DatabaseId: "11111111111111111111111111111111" }),
    ]),
    /reuses D4 Database ID.*already D3 Database ID for Ada/,
  );
});

test("Worker Keys remain exact and reserved central routes cannot be worker routes", () => {
  assert.doesNotThrow(() => assertUniqueWorkerReferences([
    worker(),
    worker({
      name: "Grace",
      workerKey: "WRK_ADA",
      d3DatabaseId: "55555555-5555-5555-5555-555555555555",
      d3DataSourceId: "66666666-6666-6666-6666-666666666666",
      d4DatabaseId: "77777777-7777-7777-7777-777777777777",
      d4DataSourceId: "88888888-8888-8888-8888-888888888888",
    }),
  ]));
  assert.throws(
    () => assertUniqueWorkerReferences([worker()], {
      reservedDataSources: [{
        id: "22222222222222222222222222222222",
        label: "D7 Data Source ID",
      }],
    }),
    /already D7 Data Source ID for the POC/,
  );
});

test("data-source validation checks schema, response identity, and stored database pairing", () => {
  assert.equal(
    assertWorkerDataSourceReference(worker(), "d3", dataSource(), { schema: DAY_TYPES }).id,
    "22222222222222222222222222222222",
  );
  assert.throws(
    () => assertWorkerDataSourceReference(worker(), "d3", dataSource({ id: "another-source" }), {
      schema: DAY_TYPES,
    }),
    /retrieved data source another-source does not match stored D3 Data Source ID/,
  );
  assert.throws(
    () => assertWorkerDataSourceReference(
      worker(),
      "d3",
      dataSource({ parent: { type: "database_id", database_id: "another-database" } }),
      { schema: DAY_TYPES },
    ),
    /belongs to database another-database, not the stored D3 Database ID/,
  );
  assert.throws(
    () => assertWorkerDataSourceReference(
      worker(),
      "d3",
      dataSource({ properties: { ...dataSource().properties, Datum: { type: "rich_text" } } }),
      { schema: DAY_TYPES },
    ),
    /"Datum" is rich_text, expected date/,
  );
});

test("data-source validation accepts a schema assertion function", () => {
  let inspected;
  const source = dataSource();
  assertWorkerDataSourceReference(worker(), "d3", source, {
    schema(candidate) {
      inspected = candidate;
    },
  });
  assert.equal(inspected, source);
});

test("database validation checks contained data source and worker-page parent", () => {
  assert.equal(
    assertWorkerDatabaseReference(worker(), "d3", database(), {
      expectedParentPageId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    }).id,
    database().id,
  );
  assert.throws(
    () => assertWorkerDatabaseReference(
      worker(),
      "d3",
      database({ data_sources: [{ id: "foreign-source" }] }),
    ),
    /does not contain stored D3 Data Source ID/,
  );
  assert.throws(
    () => assertWorkerDatabaseReference(worker(), "d3", database({
      parent: { type: "page_id", page_id: "another-page" },
    }), { expectedParentPageId: worker().frontendPageId }),
    /not frontend page/,
  );
});

test("a source page must remain inside either recorded form of its worker route", () => {
  assert.doesNotThrow(() => assertPageBelongsToWorkerRoute(
    {
      id: "day-1",
      parent: { type: "data_source_id", data_source_id: "22222222222222222222222222222222" },
    },
    worker(),
    "d3",
    { description: "checkpoint page" },
  ));
  assert.throws(
    () => assertPageBelongsToWorkerRoute(
      { id: "day-1", parent: { type: "data_source_id", data_source_id: "foreign" } },
      worker(),
      "d3",
      { description: "checkpoint page" },
    ),
    /checkpoint page day-1 no longer belongs to the recorded D3/,
  );
});

test("migration-style targets are unique, role-labelled, and require complete pairs", () => {
  assert.deepEqual(
    workerDataSourceTargets([worker()], { includeWorkerKeys: false }).map((target) => ({
      role: target.role,
      label: target.label,
      databaseId: target.databaseId,
      dataSourceId: target.dataSourceId,
    })),
    [
      {
        role: "d3",
        label: "Ada D3",
        databaseId: worker().d3DatabaseId,
        dataSourceId: worker().d3DataSourceId,
      },
      {
        role: "d4",
        label: "Ada D4",
        databaseId: worker().d4DatabaseId,
        dataSourceId: worker().d4DataSourceId,
      },
    ],
  );
  assert.throws(
    () => workerDataSourceTargets([worker({ d4DatabaseId: "" })]),
    /D4 routing data is incomplete/,
  );
});
