"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ARCHIVE_ALL_VIEW_TITLE,
  ARCHIVE_VACATION_VIEW_TITLE,
  D4_PROPERTY_TYPES,
  LEGACY_ARCHIVE_DATABASE_TITLE,
  archiveDatabaseTitle,
  archiveSchemaProperties,
  archivePrimaryTableView,
  archiveVacationViewPayload,
  archiveViewPayload,
  configureArchiveView,
  ensureArchiveSchema,
  ensureArchiveVacationView,
} = require("../scripts/archive-presentation");

function archiveDataSource(overrides = {}) {
  return {
    id: "archive-source",
    properties: {
      Wochentag: { id: "weekday", name: "Wochentag", type: "title" },
      Datum: { id: "date", name: "Datum", type: "date" },
      Stunden: { id: "hours", name: "Stunden", type: "number" },
      Standort: {
        id: "location", name: "Standort", type: "select",
        select: { options: [{ name: "Urlaub" }, { name: "Schützenstr. 70" }] },
      },
      "Sync Key": { id: "sync-key", name: "Sync Key", type: "rich_text" },
      "Source Page ID": { id: "source-id", name: "Source Page ID", type: "rich_text" },
      ...overrides,
    },
  };
}

test("archive presentation derives a worker-specific title and keeps only routing metadata", () => {
  assert.equal(LEGACY_ARCHIVE_DATABASE_TITLE, "Archiv");
  assert.equal(archiveDatabaseTitle("Max Müller"), "Max Müllers Archiv");
  assert.equal(archiveDatabaseTitle("  Erika Muster  "), "Erika Musters Archiv");
  assert.throws(() => archiveDatabaseTitle("  "), /requires a worker name/);
  assert.equal(ARCHIVE_ALL_VIEW_TITLE, "Alle");
  assert.deepEqual(D4_PROPERTY_TYPES, {
    Wochentag: "title",
    Datum: "date",
    Stunden: "number",
    Standort: "select",
    "Sync Key": "rich_text",
    "Source Page ID": "rich_text",
  });
  assert.deepEqual(archiveSchemaProperties(), {
    "Sync Key": { rich_text: {} },
    "Source Page ID": { rich_text: {} },
  });
});

test("archive table payload groups Datum by month and hides technical fields", () => {
  const payload = archiveViewPayload(archiveDataSource());

  assert.deepEqual(payload.sorts, [{ property: "Datum", direction: "descending" }]);
  assert.equal("filter" in payload, false);
  assert.deepEqual(payload.configuration.group_by, {
    type: "date",
    property_id: "date",
    group_by: "month",
    sort: { type: "descending" },
    hide_empty_groups: true,
  });
  assert.deepEqual(payload.configuration.properties, [
    { property_id: "weekday", visible: true },
    { property_id: "date", visible: true },
    { property_id: "location", visible: true },
    { property_id: "hours", visible: true },
    { property_id: "sync-key", visible: false },
    { property_id: "source-id", visible: false },
  ]);
});

test("archive view payload rejects a non-canonical archive schema", () => {
  assert.throws(
    () => archiveViewPayload(archiveDataSource({ Datum: { id: "date", type: "rich_text" } })),
    /Datum.*rich_text.*expected date/,
  );
  assert.throws(
    () => archiveViewPayload(archiveDataSource({ "Sync Key": undefined })),
    /missing "Sync Key"/,
  );
});

test("older archives keep their Monat property hidden while grouping by Datum", () => {
  const dataSource = archiveDataSource({ Monat: { id: "month", name: "Monat", type: "formula" } });
  const all = archiveViewPayload(dataSource);
  const vacation = archiveVacationViewPayload(dataSource);
  assert.equal(all.configuration.group_by.property_id, "date");
  assert.equal(all.configuration.properties.at(-1).property_id, "month");
  assert.equal(all.configuration.properties.at(-1).visible, false);
  assert.equal(vacation.configuration.properties.at(-1).visible, false);
});

test("archive schema repair never creates or deletes a Monat formula", async () => {
  const fresh = archiveDataSource();
  const legacy = archiveDataSource({ Monat: { id: "month", type: "formula" } });
  const updates = [];
  const operations = {
    getDataSource: async () => fresh,
    updateDataSource: async (...args) => updates.push(args),
  };
  assert.equal(await ensureArchiveSchema(fresh.id, operations), fresh);
  assert.equal(updates.length, 0);

  operations.getDataSource = async () => legacy;
  assert.equal(await ensureArchiveSchema(legacy.id, operations), legacy);
  assert.equal(updates.length, 0);
  assert.ok(legacy.properties.Monat);

  delete legacy.properties["Source Page ID"];
  operations.updateDataSource = async (_id, properties) => {
    updates.push(properties);
    legacy.properties["Source Page ID"] = { id: "source-id", type: "rich_text" };
  };
  await ensureArchiveSchema(legacy.id, operations);
  assert.deepEqual(updates, [{ "Source Page ID": { rich_text: {} } }]);
  assert.ok(legacy.properties.Monat);
});

test("Urlaub view filters archive rows and groups years newest first", () => {
  const payload = archiveVacationViewPayload(archiveDataSource());
  assert.equal(payload.name, ARCHIVE_VACATION_VIEW_TITLE);
  assert.deepEqual(payload.filter, {
    property: "Standort", select: { equals: "Urlaub" },
  });
  assert.deepEqual(payload.sorts, [{ property: "Datum", direction: "descending" }]);
  assert.deepEqual(payload.configuration.group_by, {
    type: "date",
    property_id: "date",
    group_by: "year",
    sort: { type: "descending" },
    hide_empty_groups: true,
  });
  assert.deepEqual(payload.configuration.properties,
    archiveViewPayload(archiveDataSource()).configuration.properties);
  assert.throws(
    () => archiveVacationViewPayload(archiveDataSource({
      Standort: { id: "location", type: "select", select: { options: [] } },
    })),
    /needs the Standort select option "Urlaub"/,
  );
});

function vacationViewFixture() {
  const dataSource = archiveDataSource();
  const views = new Map([[
    "main", {
      id: "main", name: "Default view", type: "table", data_source_id: dataSource.id,
      ...archiveViewPayload(dataSource),
    },
  ]]);
  const calls = { creates: [], updates: [] };
  const operations = {
    getDataSource: async () => dataSource,
    listAllViews: async () => [...views.keys()].map((id) => ({ id })),
    getView: async (id) => views.get(id),
    createView: async (payload) => {
      calls.creates.push(payload);
      const view = { ...payload, id: "vacation", data_source_id: dataSource.id };
      views.set(view.id, view);
      return view;
    },
    updateView: async (id, payload) => {
      calls.updates.push({ id, payload });
      Object.assign(views.get(id), payload);
    },
  };
  return { dataSource, views, calls, operations };
}

test("Urlaub is created once on the existing D4 database and reused on retry", async () => {
  const fixture = vacationViewFixture();
  const { dataSource, views, calls, operations } = fixture;
  assert.equal(await ensureArchiveVacationView("d4-database", dataSource.id, operations), "vacation");
  assert.equal(calls.creates.length, 1);
  assert.equal(calls.creates[0].database_id, "d4-database");
  assert.equal(calls.creates[0].data_source_id, dataSource.id);
  assert.equal(calls.creates[0].type, "table");
  assert.equal(views.size, 2);
  assert.equal(await ensureArchiveVacationView("d4-database", dataSource.id, operations), "vacation");
  assert.equal(calls.creates.length, 1);
  assert.equal(calls.updates.length, 0);
});

test("a lost Urlaub-view create response is recovered without another view", async () => {
  const { dataSource, views, calls, operations } = vacationViewFixture();
  const create = operations.createView;
  operations.createView = async (payload) => {
    await create(payload);
    throw new Error("lost create response");
  };
  await assert.rejects(
    () => ensureArchiveVacationView("d4-database", dataSource.id, operations),
    /lost create response/,
  );
  assert.equal(await ensureArchiveVacationView("d4-database", dataSource.id, operations), "vacation");
  assert.equal(views.size, 2);
  assert.equal(calls.creates.length, 1);
});

test("an existing Urlaub view is repaired but a same-name incompatible view is not overwritten", async () => {
  const { dataSource, views, calls, operations } = vacationViewFixture();
  views.set("vacation", {
    id: "vacation", name: "Urlaub", type: "table", data_source_id: dataSource.id,
    filter: null, sorts: [], configuration: { type: "table", properties: [] },
  });
  await ensureArchiveVacationView("d4-database", dataSource.id, operations);
  assert.equal(calls.creates.length, 0);
  assert.equal(calls.updates.length, 1);
  assert.deepEqual(views.get("vacation").configuration.group_by,
    archiveVacationViewPayload(dataSource).configuration.group_by);

  views.get("vacation").type = "chart";
  await assert.rejects(
    () => ensureArchiveVacationView("d4-database", dataSource.id, operations),
    /incompatible "Urlaub" view/,
  );
  assert.equal(calls.updates.length, 1);
});

test("the main Archiv view remains identifiable after Urlaub was added", async () => {
  const { dataSource, views, operations } = vacationViewFixture();
  views.get("main").name = "Archiv-Tabelle";
  views.set("vacation", {
    id: "vacation", name: "Urlaub", type: "table", data_source_id: dataSource.id,
  });
  assert.equal((await archivePrimaryTableView("d4-database", dataSource.id, operations)).id, "main");
});

test("onboarding renames only the existing main D4 view to Alle and recovers it on retry", async () => {
  const { dataSource, views, calls, operations } = vacationViewFixture();
  views.set("vacation", {
    id: "vacation", name: "Urlaub", type: "table", data_source_id: dataSource.id,
  });
  operations.ensureArchiveSchema = async () => dataSource;

  await configureArchiveView("d4-database", dataSource.id, operations);
  assert.equal(views.get("main").name, "Alle");
  assert.equal(views.get("vacation").name, "Urlaub");
  assert.equal(calls.updates[0].id, "main");
  assert.equal(calls.updates[0].payload.name, "Alle");
  assert.equal(calls.creates.length, 0);

  await configureArchiveView("d4-database", dataSource.id, operations);
  assert.equal(calls.updates[1].id, "main");
  assert.equal(views.size, 2);
});

test("two plausible main D4 views fail closed instead of renaming the wrong one", async () => {
  const { dataSource, views, operations } = vacationViewFixture();
  views.set("all", {
    id: "all", name: "Alle", type: "table", data_source_id: dataSource.id,
  });
  await assert.rejects(
    () => archivePrimaryTableView("d4-database", dataSource.id, operations),
    /ambiguous main archive table views/,
  );
});
