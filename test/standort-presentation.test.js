"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DASHBOARD_TITLE,
  DAYS_TABLE_TITLE,
  HOURS_WIDGET_TITLE,
  WORKERS_WIDGET_TITLE,
  WORKER_NAMES_ROLLUP,
  daysTablePayload,
  ensureAllStandortPagePresentations,
  hoursWidgetPayload,
  workersWidgetPayload,
} = require("../scripts/standort-presentation");

function schemaProperty(name, type) {
  return { id: name.toLowerCase().replaceAll(" ", "_"), name, type };
}

function dataSources() {
  const d7 = {
    id: "d7-source",
    properties: Object.fromEntries([
      ["Wochentag", "title"],
      ["Datum", "date"],
      ["Stunden", "number"],
      ["Standort", "select"],
      ["Standort (D8)", "relation"],
      ["Vor- und Nachname", "rich_text"],
      ["Worker Key", "rich_text"],
      ["Sync Key", "rich_text"],
      ["Source Page ID", "rich_text"],
      ["Source Database ID", "rich_text"],
      ["Last Synced At", "date"],
    ].map(([name, type]) => [name, schemaProperty(name, type)])),
  };
  const d8 = {
    id: "d8-source",
    properties: Object.fromEntries([
      ["Standort", "title"],
      ["Active", "checkbox"],
      ["Arbeitszeiten (D7)", "relation"],
      ["Gearbeitete Stunden", "rollup"],
    ].map(([name, type]) => [name, schemaProperty(name, type)])),
  };
  return { d7, d8 };
}

function site(id, name) {
  return {
    id,
    properties: {
      Standort: { title: [{ plain_text: name }] },
    },
  };
}

function fakeNotion({
  sites = [site("site-1", "Berlin")],
  failCreateAt = 0,
  failAfterCreateAt = 0,
} = {}) {
  const { d7, d8 } = dataSources();
  const views = new Map();
  const blocks = new Map(sites.map((row) => [row.id, []]));
  const databaseViews = new Map();
  const creates = [];
  const updates = [];
  let sequence = 0;
  let failed = false;

  const operations = {
    getDataSource: async (id) => (id === d7.id ? d7 : d8),
    queryAll: async (id) => (id === d8.id ? sites : []),
    updateDataSource: async (id, properties) => {
      assert.equal(id, d8.id);
      assert.deepEqual(properties[WORKER_NAMES_ROLLUP].rollup, {
        relation_property_name: "Arbeitszeiten (D7)",
        rollup_property_name: "Vor- und Nachname",
        function: "show_unique",
      });
      d8.properties[WORKER_NAMES_ROLLUP] = {
        ...schemaProperty(WORKER_NAMES_ROLLUP, "rollup"),
        rollup: {
          relation_property_id: d8.properties["Arbeitszeiten (D7)"].id,
          rollup_property_id: d7.properties["Vor- und Nachname"].id,
          function: "show_unique",
        },
      };
      updates.push(["schema", id]);
    },
    listAllBlockChildren: async (pageId) => blocks.get(pageId) || [],
    listAllViews: async (databaseId) =>
      (databaseViews.get(databaseId) || []).map((id) => ({ id })),
    getView: async (id) => views.get(id),
    createView: async (payload) => {
      creates.push(payload);
      if (failCreateAt === creates.length && !failed) {
        failed = true;
        throw new Error("simulated failure before create");
      }
      const id = `view-${++sequence}`;
      if (payload.create_database) {
        const blockId = `linked-${sequence}`;
        const pageId = payload.create_database.parent.page_id;
        blocks.get(pageId).push({ id: blockId, type: "child_database" });
        databaseViews.set(blockId, [id]);
        const view = {
          ...payload,
          id,
          data_source_id: payload.type === "dashboard" ? null : payload.data_source_id,
          configuration: payload.configuration || { type: "dashboard", rows: [] },
        };
        views.set(id, view);
        if (failAfterCreateAt === creates.length && !failed) {
          failed = true;
          throw new Error("simulated lost create response");
        }
        return view;
      }
      const dashboard = views.get(payload.view_id);
      const rows = dashboard.configuration.rows;
      const rowIndex = payload.placement.row_index;
      if (payload.placement.type === "new_row") {
        rows.splice(rowIndex, 0, { widgets: [{ view_id: id }] });
      } else {
        rows[rowIndex].widgets.push({ view_id: id });
      }
      const view = { ...payload, id, dashboard_view_id: payload.view_id };
      views.set(id, view);
      if (failAfterCreateAt === creates.length && !failed) {
        failed = true;
        throw new Error("simulated lost create response");
      }
      return view;
    },
    updateView: async (id, payload) => {
      Object.assign(views.get(id), payload);
      updates.push(["view", id]);
    },
  };

  return { d7, d8, sites, views, blocks, creates, updates, operations };
}

test("Standort views use the exact D8 relation and newest-first D7 days", () => {
  const { d7, d8 } = dataSources();
  d8.properties[WORKER_NAMES_ROLLUP] = schemaProperty(WORKER_NAMES_ROLLUP, "rollup");

  const hours = hoursWidgetPayload(d7, "site-1");
  const workers = workersWidgetPayload(d8, "Berlin");
  const days = daysTablePayload(d7, "site-1");

  assert.deepEqual(hours.filter, {
    property: "Standort (D8)", relation: { contains: "site-1" },
  });
  assert.deepEqual(hours.configuration.value, {
    aggregator: "sum", property_id: d7.properties.Stunden.id,
  });
  assert.deepEqual(workers.filter, {
    property: "Standort", rich_text: { equals: "Berlin" },
  });
  assert.equal(workers.configuration.type, "list");
  assert.ok(workers.configuration.properties.some((entry) =>
    entry.property_id === d8.properties[WORKER_NAMES_ROLLUP].id && entry.visible,
  ));
  assert.deepEqual(days.filter, hours.filter);
  assert.deepEqual(days.sorts, [{ property: "Datum", direction: "descending" }]);
  assert.ok(days.configuration.properties.some((entry) =>
    entry.property_id === d7.properties["Worker Key"].id && !entry.visible,
  ));
});

test("Standort presentation creates one unique-names rollup and one linked D7 dashboard/table", async () => {
  const fake = fakeNotion();

  assert.equal(
    await ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations),
    1,
  );
  assert.deepEqual(fake.blocks.get("site-1").map((block) => block.type), [
    "child_database", "child_database",
  ]);
  const dashboard = [...fake.views.values()].find((view) => view.name === DASHBOARD_TITLE);
  const table = [...fake.views.values()].find((view) => view.name === DAYS_TABLE_TITLE);
  assert.ok(dashboard && table);
  assert.deepEqual(dashboard.configuration.rows[0].widgets.map((widget) =>
    fake.views.get(widget.view_id).name,
  ), [HOURS_WIDGET_TITLE, WORKERS_WIDGET_TITLE]);
  assert.equal(fake.creates.find((payload) => payload.name === DAYS_TABLE_TITLE)
    .create_database.position.block_id, fake.blocks.get("site-1")[0].id);

  const createCount = fake.creates.length;
  const updateCount = fake.updates.length;
  await ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations);
  assert.equal(fake.creates.length, createCount);
  assert.equal(fake.updates.length, updateCount);
});

test("a retry recovers a partially built dashboard without duplicating it", async () => {
  const fake = fakeNotion({ failCreateAt: 2 });
  await assert.rejects(
    () => ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations),
    /simulated failure/,
  );

  await ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations);
  assert.equal([...fake.views.values()].filter((view) => view.name === DASHBOARD_TITLE).length, 1);
  assert.equal([...fake.views.values()].filter((view) => view.name === HOURS_WIDGET_TITLE).length, 1);
  assert.equal([...fake.views.values()].filter((view) => view.name === WORKERS_WIDGET_TITLE).length, 1);
  assert.equal([...fake.views.values()].filter((view) => view.name === DAYS_TABLE_TITLE).length, 1);
});

test("a lost response after creating the D7 table does not duplicate linked views", async () => {
  const fake = fakeNotion({ failAfterCreateAt: 4 });
  await assert.rejects(
    () => ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations),
    /lost create response/,
  );

  await ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations);
  assert.equal(fake.blocks.get("site-1").length, 2);
  assert.equal(fake.creates.length, 4);
  assert.equal([...fake.views.values()].filter((view) => view.name === DAYS_TABLE_TITLE).length, 1);
});

test("duplicate D8 Standort names stop before changing schema or pages", async () => {
  const fake = fakeNotion({ sites: [site("site-1", "Berlin"), site("site-2", "Berlin")] });
  await assert.rejects(
    () => ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations),
    /duplicate Standort title/,
  );
  assert.equal(fake.creates.length, 0);
  assert.equal(fake.updates.length, 0);
});

test("an existing incompatible names property is never overwritten", async () => {
  const fake = fakeNotion();
  fake.d8.properties[WORKER_NAMES_ROLLUP] = {
    ...schemaProperty(WORKER_NAMES_ROLLUP, "rich_text"),
    rich_text: {},
  };

  await assert.rejects(
    () => ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations),
    /exists but is not a Rollup/,
  );
  assert.equal(fake.creates.length, 0);
  assert.equal(fake.updates.length, 0);
});
