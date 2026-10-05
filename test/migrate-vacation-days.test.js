"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyMigrationPlan, berlinMonth, buildMigrationPlans, verifyVacationRows,
} = require("../scripts/migrate-vacation-days");
const { VACATION_DAY_FORMULA } = require("../scripts/day-schemas");
const { vacationFilter, updateVacationChartForRollover } = require("../scripts/frontend-presentation");
const { ensureArchiveSchema } = require("../scripts/archive-presentation");

function fixture({ active = true } = {}) {
  const text = (value) => ({ type: "rich_text", rich_text: [{ plain_text: value }] });
  const worker = { id: "worker", properties: {
    "Vor- und Nachname": { type: "title", title: [{ plain_text: "Ada" }] },
    "Worker Key": text("ada"), "Frontend Page ID": text("frontend"),
    "D3 Database ID": text("d3db"), "D3 Data Source ID": text("d3"),
    "D4 Database ID": text("d4db"), "D4 Data Source ID": text("d4"),
    "Urlaub Chart View ID": text("chart"), Active: { type: "checkbox", checkbox: active },
    "Onboarding Status": { type: "select", select: { name: "Ready" } },
  } };
  const source = { id: "d4", parent: { type: "database_id", database_id: "d4db" }, properties: {
    Wochentag: { id: "title", type: "title" }, Datum: { id: "date", type: "date" },
    Standort: { id: "site", type: "select", select: { options: [{ name: "Urlaub" }] } },
    Stunden: { id: "hours", type: "number" },
    "Sync Key": { id: "key", type: "rich_text" }, "Source Page ID": { id: "source", type: "rich_text" },
  } };
  const views = new Map(["Alle", "Urlaub"].map((name) => [name, {
    id: name, name, type: "table", data_source_id: "d4",
    filter: name === "Urlaub" ? { property: "Standort", select: { equals: "Urlaub" } } : null,
    sorts: [{ property: "Datum", direction: "descending" }],
    configuration: { type: "table", group_by: { property_id: "date", group_by: name === "Alle" ? "month" : "year" },
      properties: ["title", "date", "site", "hours"].map((id) => ({ property_id: id, visible: true, width: 123 })),
    },
  }]));
  views.set("chart", { id: "chart", name: "Diagramm", type: "chart", data_source_id: "d4",
    filter: { and: vacationFilter("2026-09").and.map((condition) => ({ and: [condition] })) },
    configuration: { type: "chart", chart_type: "number", value: { aggregator: "count" },
      height: "small", hide_title: false, color_theme: "blue" },
  });
  const rows = [
    [8, "Urlaub", 1], [4, "Urlaub", 0.5], [4, "Urlaub", 0.5], [2, "Urlaub", 0.25],
    [1, "Urlaub", 0.125], [null, "Urlaub", 0], [0, "Urlaub", 0],
    [8, "Sonderurlaub", 0], [8, "Baustelle", 0], [12, "Urlaub", 1.5],
  ].map(([hours, site, result], i) => ({ id: `row-${i}`, properties: {
    Stunden: { number: hours }, Standort: { select: { name: site } },
    Datum: { date: { start: "2026-08-10" } }, Urlaubstag: { formula: { type: "number", number: result } },
  } }));
  rows.push({ id: "old", properties: { Stunden: { number: 8 }, Standort: { select: { name: "Urlaub" } },
    Datum: { date: { start: "2025-12-31" } }, Urlaubstag: { formula: { type: "number", number: 1 } } } });
  const calls = { schema: [], views: [] };
  const operations = {
    getDataSource: async (id) => structuredClone(id === "d1" ? { id, properties: worker.properties } : source),
    getPage: async () => structuredClone(worker),
    getDatabase: async () => ({ id: "d4db", parent: { page_id: "frontend" }, data_sources: [{ id: "d4" }] }),
    queryAll: async (id) => structuredClone(id === "d1" ? [worker] : rows),
    listAllViews: async () => [{ id: "Alle" }, { id: "Urlaub" }],
    getView: async (id) => structuredClone(views.get(id)),
    updateDataSource: async (_id, properties) => {
      calls.schema.push(properties);
      for (const [name, property] of Object.entries(properties)) source.properties[name] = {
        id: name === "Urlaubstag" ? "days" : name, name, type: Object.keys(property)[0], ...property,
      };
    },
    updateView: async (id, payload) => {
      calls.views.push({ id, payload });
      const view = views.get(id);
      const configuration = { ...view.configuration, ...payload.configuration };
      Object.assign(view, payload, { configuration });
    },
  };
  return { worker, source, views, rows, calls, operations };
}

test("migration includes inactive workers, preserves presentation and hours, and is repeatable", async () => {
  const f = fixture({ active: false });
  const originalRows = structuredClone(f.rows);
  const originalViews = structuredClone(f.views);
  const plans = await buildMigrationPlans("d1", f.operations);
  assert.equal(plans.length, 1);
  assert.equal(f.calls.schema.length + f.calls.views.length, 0);
  assert.deepEqual(await applyMigrationPlan(plans[0], "2026-09", f.operations), { rows: 11, vacationDays: 3.875 });
  assert.equal(f.source.properties.Urlaubstag.formula.expression, VACATION_DAY_FORMULA);
  for (const [name, expected] of [["Alle", ["title", "date", "site", "hours"]],
    ["Urlaub", ["title", "date", "site", "days"]]]) {
    const current = f.views.get(name);
    assert.deepEqual(current.configuration.properties.filter((p) => p.visible).map((p) => p.property_id), expected);
    assert.equal(current.configuration.properties.find((p) => p.property_id === "hours").width, 123);
    assert.deepEqual(current.filter, originalViews.get(name).filter);
    assert.deepEqual(current.sorts, originalViews.get(name).sorts);
    assert.deepEqual(current.configuration.group_by, originalViews.get(name).configuration.group_by);
  }
  const chart = f.views.get("chart");
  assert.equal(chart.name, "Diagramm");
  assert.deepEqual(chart.filter, originalViews.get("chart").filter);
  assert.deepEqual(chart.configuration.value, { aggregator: "sum", property_id: "days" });
  assert.equal(chart.configuration.color_theme, "blue");
  assert.deepEqual(f.rows, originalRows);
  const callCount = f.calls.views.length;
  await applyMigrationPlan((await buildMigrationPlans("d1", f.operations))[0], "2026-09", f.operations);
  assert.equal(f.calls.schema.length, 1);
  assert.equal(f.calls.views.length, callCount);
  assert.equal(f.views.size, 3);
});

test("migration reports missing references, incompatible columns and wrong ownership before writes", async () => {
  for (const change of [
    (f) => { f.worker.properties["Urlaub Chart View ID"].rich_text = []; },
    (f) => { f.source.properties.Urlaubstag = { type: "number" }; },
    (f) => { f.source.properties.Urlaubstag = { type: "formula", formula: { expression: 'prop("Stunden") / 8' } }; },
    (f) => { f.source.parent.database_id = "other-db"; },
    (f) => { f.operations.getDatabase = async () => ({ id: "d4db", parent: { page_id: "other" }, data_sources: [{ id: "d4" }] }); },
    (f) => { f.views.get("chart").data_source_id = "someone-else"; },
    (f) => { f.views.get("Urlaub").type = "chart"; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(buildMigrationPlans("d1", f.operations), /preflight failed/);
    assert.equal(f.calls.schema.length + f.calls.views.length, 0);
  }
});

test("migration rejects crossed worker routes and a route changed after preflight", async () => {
  const f = fixture();
  f.worker.properties["D3 Data Source ID"].rich_text[0].plain_text = "d4";
  await assert.rejects(buildMigrationPlans("d1", f.operations), /reuses/);
  f.worker.properties["D3 Data Source ID"].rich_text[0].plain_text = "d3";
  const plans = await buildMigrationPlans("d1", f.operations);
  f.worker.properties["D4 Data Source ID"].rich_text[0].plain_text = "other";
  await assert.rejects(applyMigrationPlan(plans[0], "2026-09", f.operations), /routing changed/);
  assert.equal(f.calls.schema.length + f.calls.views.length, 0);
});

test("rollover corrects same-year count charts, preserves renamed titles and refreshes January", async () => {
  const f = fixture();
  const ops = { ...f.operations, ensureArchiveSchema: (id) => ensureArchiveSchema(id, f.operations) };
  assert.equal(await updateVacationChartForRollover("chart", "d4", "2026-10", ops), true);
  assert.equal(f.views.get("chart").name, "Diagramm");
  assert.equal(await updateVacationChartForRollover("chart", "d4", "2026-11", ops), false);
  assert.equal(await updateVacationChartForRollover("chart", "d4", "2027-01", ops), true);
  assert.deepEqual(f.views.get("chart").filter, vacationFilter("2027-01"));
  assert.deepEqual(f.views.get("chart").configuration.value, { aggregator: "sum", property_id: "days" });
  f.views.get("chart").data_source_id = "another-worker";
  await assert.rejects(updateVacationChartForRollover("chart", "d4", "2027-02", ops), /does not match/);
});

test("readback verification detects a failed schema or view update and bad computed values", async () => {
  for (const method of ["updateDataSource", "updateView"]) {
    const f = fixture(); const plans = await buildMigrationPlans("d1", f.operations);
    f.operations[method] = async () => {};
    await assert.rejects(applyMigrationPlan(plans[0], "2026-09", f.operations), /Urlaubstag|verification/);
  }
  const f = fixture(); f.rows[1].properties.Urlaubstag.formula.number = 1;
  assert.throws(() => verifyVacationRows(f.rows, "2026-09"), /row-1/);
});

test("Berlin migration year crosses January at local midnight", () => {
  assert.equal(berlinMonth(new Date("2026-12-31T23:01:00Z")), "2027-01");
});
