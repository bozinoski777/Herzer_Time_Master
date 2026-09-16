"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DAYS_TABLE_TITLE,
  HOURS_CHART_TITLE,
  LEGACY_DASHBOARD_TITLE,
  NAME_COLUMN,
  daysTablePayload,
  ensureAllStandortPagePresentations,
  ensureNameFormula,
  hoursChartPayload,
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
  return { id, properties: { Standort: { title: [{ plain_text: name }] } } };
}

function fakeNotion({
  sites = [site("site-1", "Berlin")],
  legacyDashboard = false,
  legacyUnknownWidget = false,
  ignoreViewUpdates = false,
  failCreateAt = 0,
  failAfterCreateAt = 0,
} = {}) {
  const { d7, d8 } = dataSources();
  const views = new Map();
  const blocks = new Map(sites.map((row) => [row.id, []]));
  const databaseViews = new Map();
  const creates = [];
  const updates = [];
  const trashed = [];
  let sequence = 0;
  let failed = false;

  function addDirectView(pageId, view) {
    const blockId = `linked-${++sequence}`;
    blocks.get(pageId).push({ id: blockId, type: "child_database" });
    databaseViews.set(blockId, [view.id]);
    views.set(view.id, view);
    return blockId;
  }

  if (legacyDashboard) {
    const dashboardId = "legacy-dashboard";
    const hoursId = "legacy-hours";
    const workersId = "legacy-workers";
    const widgetIds = legacyUnknownWidget ? [hoursId, workersId, "unknown-widget"] :
      [hoursId, workersId];
    views.set(hoursId, {
      id: hoursId, name: HOURS_CHART_TITLE, type: "chart", data_source_id: d7.id,
      dashboard_view_id: dashboardId,
    });
    views.set(workersId, {
      id: workersId, name: "Eingesetzte Mitarbeitende", type: "list",
      data_source_id: d8.id, dashboard_view_id: dashboardId,
    });
    if (legacyUnknownWidget) views.set("unknown-widget", {
      id: "unknown-widget", name: "Custom", type: "table", data_source_id: d7.id,
      dashboard_view_id: dashboardId,
    });
    addDirectView("site-1", {
      id: dashboardId, name: LEGACY_DASHBOARD_TITLE, type: "dashboard",
      data_source_id: null,
      configuration: { type: "dashboard", rows: [{ widgets: widgetIds.map((id) => ({ view_id: id })) }] },
    });
    addDirectView("site-1", {
      id: "legacy-table", name: DAYS_TABLE_TITLE, type: "table",
      data_source_id: d7.id, configuration: { type: "table", properties: [] },
    });
  }

  const operations = {
    getDataSource: async (id) => (id === d7.id ? d7 : d8),
    queryAll: async (id) => (id === d8.id ? sites : []),
    updateDataSource: async (id, properties) => {
      assert.equal(id, d7.id);
      assert.deepEqual(properties[NAME_COLUMN], {
        formula: { expression: 'prop("Vor- und Nachname")' },
      });
      d7.properties[NAME_COLUMN] = {
        ...schemaProperty(NAME_COLUMN, "formula"),
        formula: properties[NAME_COLUMN].formula,
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
      const blockId = `linked-${sequence}`;
      const pageId = payload.create_database.parent.page_id;
      const pageBlocks = blocks.get(pageId);
      const afterId = payload.create_database.position?.block_id;
      const index = afterId ? pageBlocks.findIndex((block) => block.id === afterId) + 1 :
        pageBlocks.length;
      assert.ok(index > 0 || !afterId, "position must refer to an existing child block");
      pageBlocks.splice(index, 0, { id: blockId, type: "child_database" });
      databaseViews.set(blockId, [id]);
      const view = { ...payload, id, data_source_id: payload.data_source_id };
      views.set(id, view);
      if (failAfterCreateAt === creates.length && !failed) {
        failed = true;
        throw new Error("simulated lost create response");
      }
      return view;
    },
    updateView: async (id, payload) => {
      if (!ignoreViewUpdates) Object.assign(views.get(id), payload);
      updates.push(["view", id]);
    },
    updateDatabase: async (id, attributes) => {
      assert.deepEqual(attributes, { in_trash: true });
      const pageBlocks = blocks.get("site-1");
      const index = pageBlocks.findIndex((block) => block.id === id);
      assert.ok(index >= 0);
      pageBlocks.splice(index, 1);
      trashed.push(id);
    },
  };

  return { d7, d8, sites, views, blocks, databaseViews, creates, updates, trashed, operations };
}

test("Standort chart sums D7 hours and the table shows only the four requested columns", () => {
  const { d7 } = dataSources();
  d7.properties[NAME_COLUMN] = {
    ...schemaProperty(NAME_COLUMN, "formula"),
    formula: { expression: 'prop("Vor- und Nachname")' },
  };
  const chart = hoursChartPayload(d7, "site-1");
  const table = daysTablePayload(d7, "site-1");
  assert.deepEqual(chart.filter, {
    property: "Standort (D8)", relation: { contains: "site-1" },
  });
  assert.deepEqual(chart.configuration, {
    type: "chart", chart_type: "number",
    value: { aggregator: "sum", property_id: d7.properties.Stunden.id },
    height: "small", hide_title: false,
  });
  assert.deepEqual(table.filter, chart.filter);
  assert.deepEqual(table.sorts, [{ property: "Datum", direction: "descending" }]);
  assert.deepEqual(table.configuration.properties.filter((entry) => entry.visible)
    .map((entry) => entry.property_id), [
    d7.properties.Name.id,
    d7.properties.Wochentag.id,
    d7.properties.Datum.id,
    d7.properties.Stunden.id,
  ]);
  assert.equal(table.configuration.properties.find((entry) =>
    entry.property_id === d7.properties.Standort.id).visible, false);
});

test("Standort sync creates a small chart above the table without a dashboard or names list", async () => {
  const fake = fakeNotion();
  assert.equal(await ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations), 1);
  assert.deepEqual(fake.blocks.get("site-1").map((block) => block.type), [
    "child_database", "child_database",
  ]);
  assert.deepEqual(fake.creates.map((payload) => [payload.name, payload.type]), [
    [HOURS_CHART_TITLE, "chart"], [DAYS_TABLE_TITLE, "table"],
  ]);
  assert.equal(fake.creates[1].create_database.position.block_id,
    fake.blocks.get("site-1")[0].id);
  assert.deepEqual(fake.updates, [["schema", fake.d7.id]]);
  assert.deepEqual(fake.trashed, []);

  await ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations);
  assert.equal(fake.creates.length, 2);
  assert.equal(fake.updates.length, 1);
});

test("a retry recovers a chart created before a table failure", async () => {
  const fake = fakeNotion({ failCreateAt: 2 });
  await assert.rejects(
    () => ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations),
    /simulated failure/,
  );
  await ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations);
  assert.equal([...fake.views.values()].filter((view) => view.name === HOURS_CHART_TITLE).length, 1);
  assert.equal([...fake.views.values()].filter((view) => view.name === DAYS_TABLE_TITLE).length, 1);
  assert.equal(fake.blocks.get("site-1").length, 2);
});

test("a lost table-create response does not duplicate linked views", async () => {
  const fake = fakeNotion({ failAfterCreateAt: 2 });
  await assert.rejects(
    () => ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations),
    /lost create response/,
  );
  await ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations);
  assert.equal(fake.creates.length, 2);
  assert.equal(fake.blocks.get("site-1").length, 2);
});

test("a lost chart-create response is recovered before adding the table", async () => {
  const fake = fakeNotion({ failAfterCreateAt: 1 });
  await assert.rejects(
    () => ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations),
    /lost create response/,
  );
  await ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations);
  assert.equal(fake.creates.length, 2);
  assert.equal(fake.blocks.get("site-1").length, 2);
});

test("a prior Business dashboard is replaced only after both linked views exist", async () => {
  const fake = fakeNotion({ legacyDashboard: true });
  await ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations);
  const names = fake.blocks.get("site-1").map((block) =>
    fake.views.get(fake.databaseViews.get(block.id)[0]).name);
  assert.equal(fake.blocks.get("site-1").length, 2);
  assert.deepEqual(fake.trashed, ["linked-1"]);
  assert.equal(fake.creates.length, 1);
  assert.equal(fake.creates[0].name, HOURS_CHART_TITLE);
  assert.equal(fake.creates[0].create_database.position.block_id, "linked-1");
  assert.ok(fake.updates.some(([kind, id]) => kind === "view" && id === "legacy-table"));
  assert.deepEqual(names, [HOURS_CHART_TITLE, DAYS_TABLE_TITLE]);
  await ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations);
  assert.equal(fake.creates.length, 1);
  assert.equal(fake.trashed.length, 1);
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

test("an existing unrelated D7 Name property is not overwritten", async () => {
  const fake = fakeNotion();
  fake.d7.properties.Name = { ...schemaProperty("Name", "rich_text"), rich_text: {} };
  await assert.rejects(
    () => ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations),
    /exists but is not a Formula/,
  );
  assert.equal(fake.creates.length, 0);
  assert.equal(fake.updates.length, 0);
});

test("a Notion-normalized direct Name formula is reused without a schema write", async () => {
  const { d7 } = dataSources();
  d7.properties.Name = {
    ...schemaProperty("Name", "formula"),
    formula: {
      expression: "{{notion:block_property:vor-_und_nachname:database-id:formula-id}}",
    },
  };
  assert.equal(await ensureNameFormula(d7, {
    updateDataSource: async () => { throw new Error("should not update"); },
  }), d7);
});

test("a customized legacy dashboard is left untouched for manual review", async () => {
  const fake = fakeNotion({ legacyDashboard: true, legacyUnknownWidget: true });
  await assert.rejects(
    () => ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations),
    /unknown or changed widget/,
  );
  assert.equal(fake.creates.length, 0);
  assert.deepEqual(fake.trashed, []);
});

test("a legacy dashboard with another view tab is never trashed", async () => {
  const fake = fakeNotion({ legacyDashboard: true });
  fake.databaseViews.get("linked-1").push("custom-tab");
  fake.views.set("custom-tab", {
    id: "custom-tab", name: "Custom table", type: "table", data_source_id: fake.d7.id,
  });
  await assert.rejects(
    () => ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations),
    /shares a linked database with other views/,
  );
  assert.equal(fake.creates.length, 0);
  assert.deepEqual(fake.trashed, []);
});

test("a legacy dashboard stays recoverable if the replacement table cannot be verified", async () => {
  const fake = fakeNotion({ legacyDashboard: true, ignoreViewUpdates: true });
  await assert.rejects(
    () => ensureAllStandortPagePresentations(fake.d7.id, fake.d8.id, fake.operations),
    /did not verify its new "Arbeitszeiten am Standort" view/,
  );
  assert.deepEqual(fake.trashed, []);
  assert.equal(fake.blocks.get("site-1").length, 3);
});
