"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BASE_SCHEMA, CARRYOVER_SCHEMA, YEAR_PROPERTY, STATUS_PROPERTY, SNAPSHOT_PROPERTY, ERROR_PROPERTY,
  entitlementForYear, vacationTotal, resolveRunConfiguration, buildSnapshot, parseSnapshot,
  processWorker, runCarryover, workerFromRow,
} = require("../scripts/vacation-carryover");
const {
  carryoverKey, carryoverProperties, carryoverRowsByYear, archiveDayRows,
} = require("../scripts/vacation-carryover-record");
const { DAY_PROPERTY_TYPES, D4_PROPERTY_TYPES, VACATION_DAY_FORMULA } = require("../scripts/day-schemas");
const { vacationFilter } = require("../scripts/frontend-presentation");

const text = (value) => ({ type: "rich_text", rich_text: value ? [{ plain_text: value }] : [] });
const title = (value) => ({ type: "title", title: [{ plain_text: value }] });
const number = (value) => ({ type: "number", number: value });
const date = (value) => ({ type: "date", date: value ? { start: value } : null });
const select = (value) => ({ type: "select", select: value ? { name: value } : null });

function responseProperties(properties) {
  return Object.fromEntries(Object.entries(properties).map(([name, property]) => {
    const type = Object.keys(property)[0];
    const value = structuredClone(property);
    if (["rich_text", "title"].includes(type)) {
      value[type] = value[type].map((item) => ({ ...item, plain_text: item.text.content }));
    }
    return [name, { type, ...value }];
  }));
}

function source(id, database, schema) {
  return { id, parent: { type: "database_id", database_id: database }, properties:
    Object.fromEntries(Object.entries(schema).map(([name, type]) => [name, { id: name, name, type }])) };
}

function day(id, datum, hours = 8, site = "Urlaub") {
  return { id, parent: { type: "data_source_id", data_source_id: "d4" }, properties: {
    Wochentag: title("Montag"), Datum: date(datum), Stunden: number(hours), Standort: select(site),
    "Sync Key": text(`ada|${datum}|source-${id}`), "Source Page ID": text(`source-${id}`),
    Urlaubstag: { type: "formula", formula: { type: "number", number: site === "Urlaub" ? (hours ?? 0) / 8 : 0 } },
  } };
}

function carryoverRow(year, adjustment, workerKey = "ada") {
  return { id: `carry-${year}`, parent: { type: "data_source_id", data_source_id: "d4" }, properties: {
    ...responseProperties(carryoverProperties(workerKey, year, adjustment)),
    Urlaubstag: { type: "formula", formula: { type: "number", number: adjustment } },
  } };
}

function fixture({ year = 2026, taken = 19 } = {}) {
  const worker = { id: "worker", parent: { type: "data_source_id", data_source_id: "d1" }, properties: {
    "Vor- und Nachname": title("Ada"), "Worker Key": text("ada"), "Frontend Page ID": text("frontend"),
    Active: { type: "checkbox", checkbox: true }, "Onboarding Status": select("Ready"),
    "D3 Database ID": text("d3db"), "D3 Data Source ID": text("d3"),
    "D4 Database ID": text("d4db"), "D4 Data Source ID": text("d4"),
    Jahresurlaub: number(20), Eintrittsdatum: date("2026-01-01"), Austrittsdatum: date(null),
    "Current Month": text(`${year + 1}-01`), "Last Archived Month": text(`${year}-12`),
    "Rollover Status": select("Ready"), "Rollover Manifest": text(""), "Urlaub Chart View ID": text("chart"),
    [YEAR_PROPERTY]: number(null), [STATUS_PROPERTY]: select(null), [ERROR_PROPERTY]: text(""), [SNAPSHOT_PROPERTY]: text(""),
  } };
  const workers = new Map([[worker.id, worker]]);
  const d1 = source("d1", "d1db", { ...BASE_SCHEMA, ...CARRYOVER_SCHEMA });
  d1.properties[STATUS_PROPERTY].select = { options: [
    { id: "running", name: "Running", color: "blue" }, { id: "complete", name: "Complete", color: "green" },
    { id: "error", name: "Error", color: "red" },
  ] };
  const d3 = source("d3", "d3db", DAY_PROPERTY_TYPES);
  const d4 = source("d4", "d4db", D4_PROPERTY_TYPES);
  d4.properties.Standort.select = { options: [{ name: "Urlaub" }, { name: "Berlin" }] };
  d4.properties.Urlaubstag.formula = { expression: VACATION_DAY_FORMULA };
  const sources = new Map([["d1", d1], ["d3", d3], ["d4", d4]]);
  const d4Rows = [day("leave", `${year}-06-01`, taken * 8), day("work", `${year}-12-31`, 8, "Berlin")];
  const d3Rows = [{ ...day("jan-1", `${year + 1}-01-01`, null, "Berlin"),
    parent: { type: "data_source_id", data_source_id: "d3" } }];
  const frontend = { id: "frontend", properties: { "D1 Record ID": text("worker"), "Worker Key": text("ada") } };
  const views = new Map([
    ["table", { id: "table", type: "table", data_source_id: "d1", configuration: { type: "table", properties: [
      { property_id: "Vor- und Nachname", visible: true, width: 333 },
      { property_id: SNAPSHOT_PROPERTY, visible: true, width: 234 },
    ] } }],
    ["chart", { id: "chart", name: "Diagramm", type: "chart", data_source_id: "d4", filter: vacationFilter(`${year}-12`),
      configuration: { type: "chart", chart_type: "number", value: { aggregator: "sum", property_id: "Urlaubstag" },
        height: "small", hide_title: false, color_theme: "blue" } }],
  ]);
  const calls = { creates: [], updates: [], schemas: [], views: [], queries: [] };
  const operations = {
    getDataSource: async (id) => structuredClone(sources.get(id)),
    getDatabase: async (id) => ({ id, parent: { page_id: "frontend" },
      data_sources: [{ id: id === "d3db" ? "d3" : "d4" }] }),
    getPage: async (id) => structuredClone(workers.get(id) || (id === "frontend" ? frontend : d4Rows.find((row) => row.id === id))),
    queryAll: async (id) => {
      calls.queries.push(id);
      return structuredClone(id === "d1" ? [...workers.values()] : id === "d3" ? d3Rows : d4Rows);
    },
    listAllViews: async () => [{ id: "table" }],
    getView: async (id) => structuredClone(views.get(id)),
    updateDataSource: async (id, properties) => {
      calls.schemas.push({ id, properties });
      for (const [name, property] of Object.entries(properties)) sources.get(id).properties[name] = {
        id: name, name, type: Object.keys(property)[0], ...structuredClone(property),
      };
    },
    updatePage: async (id, properties) => {
      calls.updates.push({ id, properties });
      Object.assign(workers.get(id).properties, responseProperties(properties));
      return structuredClone(workers.get(id));
    },
    updateView: async (id, payload) => {
      calls.views.push({ id, payload });
      const view = views.get(id);
      Object.assign(view, { ...payload, configuration: { ...view.configuration, ...payload.configuration } });
    },
    createPage: async (parent, properties) => {
      calls.creates.push({ parent, properties });
      assert.equal(parent.data_source_id, "d4", "synthetic balances belong only to D4");
      const row = { id: `created-${calls.creates.length}`, parent, properties: responseProperties(properties) };
      row.properties.Urlaubstag = { type: "formula", formula: { type: "number", number: properties.Stunden.number / 8 } };
      d4Rows.push(row);
      return structuredClone(row);
    },
  };
  const run = { year, currentDate: `${year + 1}-01-01`, targetWorker: "", preview: false, skip: false };
  return { worker, workers, frontend, sources, d1, d3, d4, d3Rows, d4Rows, views, calls, operations, run };
}

function setComplete(f, year, rows) {
  const snapshot = buildSnapshot(workerFromRow(f.worker), year, rows);
  Object.assign(f.worker.properties, {
    [YEAR_PROPERTY]: number(year), [STATUS_PROPERTY]: select("Complete"), [SNAPSHOT_PROPERTY]: text(JSON.stringify(snapshot)),
  });
  return snapshot;
}

test("entitlement counts inclusive employment dates by calendar month without rounding", () => {
  assert.equal(entitlementForYear(20, "2020-01-01", "", 2026), 20);
  assert.equal(entitlementForYear(20, "2026-07-01", "", 2026), 10);
  assert.ok(Math.abs(entitlementForYear(20, "2026-07-16", "", 2026) - 20 / 12 * (16 / 31 + 5)) < 1e-12);
  assert.ok(Math.abs(entitlementForYear(24, "2028-02-15", "2028-02-29", 2028) - 2 * 15 / 29) < 1e-12);
  assert.ok(Math.abs(entitlementForYear(24, "2027-02-15", "2027-02-28", 2027) - 1) < 1e-12);
  assert.equal(entitlementForYear(20, "2027-01-01", "", 2026), 0);
  assert.equal(entitlementForYear(0, "2026-01-01", "", 2026), 0);
  for (const allowance of [null, -1, NaN, Infinity]) assert.throws(() => entitlementForYear(allowance, "2026-01-01", "", 2026), /Jahresurlaub/);
  assert.throws(() => entitlementForYear(20, "2026-02-30", "", 2026), /Invalid employment/);
  assert.throws(() => entitlementForYear(20, "2026-08-01", "2026-07-31", 2026), /Invalid employment/);
});

test("vacation sums fractions, split entries and signed carryover within the ending year", () => {
  const rows = [day("a", "2027-08-01", 4), day("b", "2027-08-01", 4),
    day("c", "2027-08-02", 2), day("d", "2027-08-03", null),
    day("e", "2027-08-03", 8, "Sonderurlaub"), carryoverRow(2026, -1),
    day("old", "2026-12-31", 8), day("next", "2028-01-01", 8)];
  assert.equal(vacationTotal(rows, 2027), 0.25);
  rows[1].properties.Urlaubstag.formula.number = 1;
  assert.throws(() => vacationTotal(rows, 2027), /formula verification/);
});

test("duplicate archive identities cannot silently inflate vacation", () => {
  const a = day("one", "2026-08-01");
  const b = day("two", "2026-08-01");
  b.properties["Source Page ID"] = text("SOURCE-ONE");
  assert.throws(() => vacationTotal([a, b], 2026), /duplicate/);
  assert.throws(() => vacationTotal([a, a], 2026), /duplicate/);
});

test("reserved carryover identity accepts signed hours and rejects malformed/foreign/duplicate rows", () => {
  const worker = { name: "Ada", workerKey: "ada" };
  assert.equal(carryoverKey("ada", 2026), "vacation-carryover|ada|2026");
  assert.equal(carryoverRowsByYear([carryoverRow(2026, -1)], worker).size, 1);
  assert.equal(carryoverRowsByYear([carryoverRow(2026, 1)], worker).size, 1);
  assert.throws(() => carryoverRowsByYear([carryoverRow(2026, 1), carryoverRow(2026, -1)], worker), /duplicate/);
  for (const mutate of [
    (row) => { row.properties["Sync Key"] = text("vacation-carryover|someone|2026"); },
    (row) => { row.properties["Sync Key"] = text("vacation-carryover|ada|bad"); },
    (row) => { row.properties["Sync Key"] = text(""); },
    (row) => { row.properties.Datum = date("2027-01-02"); },
    (row) => { row.properties.Datum.date.end = "2027-01-02"; },
    (row) => { row.properties.Stunden = number(0); },
    (row) => { row.properties.Standort = select("Berlin"); },
    (row) => { row.properties["Source Page ID"] = text("a-real-source"); },
    (row) => { row.properties.Wochentag = title("Montag"); },
  ]) {
    const row = carryoverRow(2026, -1); mutate(row);
    assert.throws(() => archiveDayRows([row], worker), /malformed or foreign/);
  }
  assert.throws(() => carryoverProperties("ada", 2026, 0), /nonzero/);
});

test("January schedule uses Berlin's year and manual previews cannot process open years", () => {
  const now = new Date("2026-12-31T23:01:00Z");
  assert.deepEqual(resolveRunConfiguration({ GITHUB_EVENT_NAME: "schedule" }, now), {
    year: 2026, currentDate: "2027-01-01", targetWorker: "", preview: false, skip: false,
  });
  assert.equal(resolveRunConfiguration({ GITHUB_EVENT_NAME: "schedule" }, new Date("2027-02-01T01:00:00Z")).skip, true);
  assert.equal(resolveRunConfiguration({ GITHUB_EVENT_NAME: "schedule" }, new Date("2026-01-01T01:00:00Z")).skip, true);
  assert.equal(resolveRunConfiguration({ GITHUB_EVENT_NAME: "workflow_dispatch", VACATION_CARRYOVER_PREVIEW: "true" }, now).preview, true);
  for (const ending of ["2027", "2025", "2026.0", "bad"]) {
    assert.throws(() => resolveRunConfiguration({ GITHUB_EVENT_NAME: "workflow_dispatch", VACATION_CARRYOVER_YEAR: ending }, now), /Ending year/);
  }
  assert.throws(() => resolveRunConfiguration({ GITHUB_EVENT_NAME: "schedule", VACATION_CARRYOVER_TARGET_WORKER: "ada" }, now), /workflow_dispatch/);
});

test("equal, unused, excess and fractional balances produce the exact formula-compatible hours", async () => {
  for (const [taken, adjustment] of [[20, 0], [19, -1], [21, 1], [19.5, -0.5]]) {
    const f = fixture({ taken });
    const result = await processWorker(workerFromRow(f.worker), f.run, f.operations);
    assert.equal(result.adjustment, adjustment);
    assert.equal(f.calls.creates.length, adjustment === 0 ? 0 : 1);
    if (adjustment) {
      assert.equal(f.calls.creates[0].properties.Stunden.number, adjustment * 8);
      assert.equal(f.d4Rows.at(-1).properties.Urlaubstag.formula.number, adjustment);
    }
    assert.equal(vacationTotal(f.d4Rows, 2027), adjustment);
    assert.equal(f.worker.properties[STATUS_PROPERTY].select.name, "Complete");
    assert.equal(f.worker.properties[YEAR_PROPERTY].number, 2026);
    assert.equal(f.views.get("chart").name, "Diagramm");
    assert.deepEqual(f.views.get("chart").filter, vacationFilter("2027-01"));
    const writes = f.calls.updates.length + f.calls.views.length;
    assert.equal((await processWorker(workerFromRow(f.worker), f.run, f.operations)).result, "already complete");
    assert.equal(f.calls.updates.length + f.calls.views.length, writes);
    assert.equal(f.calls.creates.length, adjustment === 0 ? 0 : 1);
  }
});

test("July starters earn ten days and a midmonth start retains fractional entitlement", async () => {
  const f = fixture({ taken: 9 }); f.worker.properties.Eintrittsdatum = date("2026-07-01");
  assert.equal((await processWorker(workerFromRow(f.worker), f.run, f.operations)).adjustment, -1);
  const mid = fixture({ taken: 9 }); mid.worker.properties.Eintrittsdatum = date("2026-07-16");
  const result = await processWorker(workerFromRow(mid.worker), mid.run, mid.operations);
  assert.ok(Math.abs(result.adjustment - (9 - 20 / 12 * (16 / 31 + 5))) < 1e-12);
  assert.equal(mid.calls.creates[0].properties.Stunden.number, result.adjustment * 8);
});

test("previous credit and debt continue into the next annual balance", async () => {
  for (const [previousTaken, oldAdjustment, newAdjustment] of [[19, -1, -2], [21, 1, 0]]) {
    const f = fixture({ year: 2027, taken: 19 });
    const old = day("old-leave", "2026-06-01", previousTaken * 8);
    f.d4Rows.push(old, carryoverRow(2026, oldAdjustment));
    setComplete(f, 2026, [old]);
    const result = await processWorker(workerFromRow(f.worker), f.run, f.operations);
    assert.equal(result.adjustment, newAdjustment);
    assert.equal(f.calls.creates.length, newAdjustment === 0 ? 0 : 1);
  }
});

test("a read-only preview produces the signed balance and zero Notion mutations", async () => {
  const f = fixture();
  delete f.d1.properties[YEAR_PROPERTY]; delete f.d1.properties[SNAPSHOT_PROPERTY];
  const original = structuredClone({ worker: f.worker, d4Rows: f.d4Rows, views: f.views });
  const results = await runCarryover("d1", { ...f.run, preview: true, targetWorker: "ada" }, f.operations);
  assert.equal(results[0].adjustment, -1);
  assert.equal(results[0].result, "preview");
  assert.deepEqual({ worker: f.worker, d4Rows: f.d4Rows, views: f.views }, original);
  for (const name of ["creates", "updates", "schemas", "views"]) assert.equal(f.calls[name].length, 0);
});

test("schema adds employment and carryover fields and hides only the calculation snapshot", async () => {
  const f = fixture();
  for (const name of Object.keys(CARRYOVER_SCHEMA)) delete f.d1.properties[name];
  await runCarryover("d1", f.run, f.operations);
  assert.equal(f.calls.schemas.length, 1);
  for (const [name, type] of Object.entries(CARRYOVER_SCHEMA)) assert.equal(f.d1.properties[name].type, type);
  const columns = f.views.get("table").configuration.properties;
  assert.deepEqual(columns.find((column) => column.property_id === SNAPSHOT_PROPERTY), {
    property_id: SNAPSHOT_PROPERTY, visible: false, width: 234,
  });
  assert.deepEqual(columns.find((column) => column.property_id === "Vor- und Nachname"), {
    property_id: "Vor- und Nachname", visible: true, width: 333,
  });
});

test("a create whose response is lost is recovered from the checkpoint and reserved key", async () => {
  const f = fixture();
  const create = f.operations.createPage;
  f.operations.createPage = async (...args) => { await create(...args); throw new Error("lost create response"); };
  await assert.rejects(processWorker(workerFromRow(f.worker), f.run, f.operations), /lost create response/);
  assert.equal(f.worker.properties[STATUS_PROPERTY].select.name, "Running");
  f.worker.properties.Jahresurlaub = number(30); // New-year allowance must not change the saved result.
  f.operations.createPage = create;
  assert.equal((await processWorker(workerFromRow(f.worker), f.run, f.operations)).adjustment, -1);
  assert.equal(f.calls.creates.length, 1);
});

test("a completion whose response is lost remains completed on retry", async () => {
  const f = fixture(); const update = f.operations.updatePage;
  f.operations.updatePage = async (id, properties) => {
    await update(id, properties);
    if (properties[STATUS_PROPERTY]?.select?.name === "Complete") throw new Error("lost completion response");
  };
  await assert.rejects(processWorker(workerFromRow(f.worker), f.run, f.operations), /lost completion response/);
  f.operations.updatePage = update;
  assert.equal((await processWorker(workerFromRow(f.worker), f.run, f.operations)).result, "already complete");
  assert.equal(f.calls.creates.length, 1);
});

test("a late archive edit after a checkpoint prevents applying a stale balance", async () => {
  const f = fixture(); const create = f.operations.createPage;
  f.operations.createPage = async () => { throw new Error("create failed before reaching Notion"); };
  await assert.rejects(processWorker(workerFromRow(f.worker), f.run, f.operations), /create failed/);
  f.d4Rows[0].properties.Stunden.number = 160;
  f.d4Rows[0].properties.Urlaubstag.formula.number = 20;
  f.operations.createPage = create;
  await assert.rejects(processWorker(workerFromRow(f.worker), f.run, f.operations), /changed since the calculation checkpoint/);
  assert.equal(f.calls.creates.length, 0);
});

test("the action records an ambiguous create as Error and resumes without another page", async () => {
  const f = fixture(); const create = f.operations.createPage;
  f.operations.createPage = async (...args) => { await create(...args); throw new Error("lost response"); };
  await assert.rejects(runCarryover("d1", f.run, f.operations), /lost response/);
  assert.equal(f.worker.properties[STATUS_PROPERTY].select.name, "Error");
  f.operations.createPage = create;
  assert.equal((await runCarryover("d1", f.run, f.operations))[0].adjustment, -1);
  assert.equal(f.calls.creates.length, 1);
});

test("a removed preceding carryover cannot silently discard an outstanding balance", async () => {
  const f = fixture({ year: 2027 }); const old = day("old", "2026-06-01", 152);
  setComplete(f, 2026, [old]);
  await assert.rejects(processWorker(workerFromRow(f.worker), f.run, f.operations), /readback/);
  assert.equal(f.calls.creates.length, 0);
});

test("checkpoint verification and changed routing prevent an archive create", async () => {
  for (const changedRoute of [false, true]) {
    const f = fixture(); const update = f.operations.updatePage;
    f.operations.updatePage = async (id, properties) => {
      if (changedRoute) {
        await update(id, properties);
        f.worker.properties["D4 Data Source ID"] = text("another-source");
      }
    };
    await assert.rejects(processWorker(workerFromRow(f.worker), f.run, f.operations), /checkpoint verification|routing/);
    assert.equal(f.calls.creates.length, 0);
  }
});

test("missing dates, unfinished December and missing prior balances do not create carryover", async () => {
  for (const mutate of [
    (f) => { f.worker.properties.Eintrittsdatum = date(null); },
    (f) => { f.worker.properties.Eintrittsdatum = date("2026-02-30"); },
    (f) => { f.worker.properties.Austrittsdatum = date("2025-12-31"); },
    (f) => { f.worker.properties.Jahresurlaub = number(null); },
    (f) => { f.worker.properties["Last Archived Month"] = text("2026-11"); },
    (f) => { f.worker.properties["Current Month"] = text("2026-12"); },
    (f) => { f.worker.properties["Rollover Manifest"] = text("pending"); },
    (f) => { f.worker.properties["Rollover Status"] = select("Error"); },
    (f) => { f.d3Rows[0].properties.Datum = date("2026-12-31"); },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(processWorker(workerFromRow(f.worker), f.run, f.operations));
    assert.equal(f.calls.creates.length + f.calls.updates.length, 0);
  }
  const f = fixture({ year: 2027 });
  await assert.rejects(processWorker(workerFromRow(f.worker), f.run, f.operations), /preceding carryover/);
});

test("new hires, ended employment and inactive workers receive no carryover", async () => {
  for (const change of [
    (f) => { f.worker.properties.Eintrittsdatum = date("2027-01-01"); },
    (f) => { f.worker.properties.Austrittsdatum = date("2026-12-31"); },
  ]) {
    const f = fixture(); change(f);
    assert.equal((await processWorker(workerFromRow(f.worker), f.run, f.operations)).result, "ineligible");
    assert.equal(f.calls.creates.length + f.calls.updates.length, 0);
  }
  const f = fixture(); f.worker.properties.Active.checkbox = false;
  assert.deepEqual(await runCarryover("d1", { ...f.run, preview: true }, f.operations), []);
  await assert.rejects(runCarryover("d1", { ...f.run, targetWorker: "ada" }, f.operations), /active and Ready/);
});

test("archive ownership, formula mismatches and duplicate carryovers fail before row writes", async () => {
  for (const mutate of [
    (f) => { f.frontend.properties["Worker Key"] = text("someone-else"); },
    (f) => { f.d4.parent.database_id = "somebody-elses-db"; },
    (f) => { f.operations.getDatabase = async (id) => ({ id, parent: { page_id: "other-frontend" }, data_sources: [{ id: "d3" }] }); },
    (f) => { f.d4.properties.Urlaubstag.formula.expression = 'prop("Stunden") / 8'; },
    (f) => { f.d4Rows[0].properties.Urlaubstag.formula.number = 20; },
    (f) => { f.d4Rows.push(carryoverRow(2026, -1), { ...carryoverRow(2026, -1), id: "duplicate" }); },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(processWorker(workerFromRow(f.worker), f.run, f.operations));
    assert.equal(f.calls.creates.length + f.calls.updates.length, 0);
  }
});

test("full-registry routing collisions fail before schema or worker writes, even with a target", async () => {
  const f = fixture(); const other = structuredClone(f.worker); other.id = "other";
  f.workers.set(other.id, other);
  await assert.rejects(runCarryover("d1", { ...f.run, targetWorker: "ada" }, f.operations), /reuses/);
  for (const name of ["creates", "updates", "schemas", "views"]) assert.equal(f.calls[name].length, 0);
});

test("worker failures are recorded in D1 while a valid worker still completes", async () => {
  const f = fixture(); const bad = structuredClone(f.worker); bad.id = "bad";
  bad.properties["Vor- und Nachname"] = title("Missing date"); bad.properties["Worker Key"] = text("bad");
  for (const name of ["D3 Database ID", "D3 Data Source ID", "D4 Database ID", "D4 Data Source ID", "Frontend Page ID"]) {
    bad.properties[name] = text(`bad-${name}`);
  }
  bad.properties.Eintrittsdatum = date(null); f.workers.set(bad.id, bad);
  await assert.rejects(runCarryover("d1", f.run, f.operations), /1 carryover failure/);
  assert.equal(f.worker.properties[STATUS_PROPERTY].select.name, "Complete");
  assert.equal(bad.properties[STATUS_PROPERTY].select.name, "Error");
  assert.match(bad.properties[ERROR_PROPERTY].rich_text[0].plain_text, /Eintrittsdatum/);
  assert.equal(f.calls.creates.length, 1);
});

test("a later-year failure preserves the preceding completion marker for ordered recovery", async () => {
  const f = fixture({ year: 2027 }); const old = day("old", "2026-06-01", 160);
  setComplete(f, 2026, [old]); f.worker.properties["Last Archived Month"] = text("2027-11");
  await assert.rejects(runCarryover("d1", f.run, f.operations), /December/);
  assert.equal(f.worker.properties[YEAR_PROPERTY].number, 2026);
  assert.equal(f.worker.properties[STATUS_PROPERTY].select.name, "Complete");
  f.worker.properties["Last Archived Month"] = text("2027-12");
  assert.equal((await runCarryover("d1", f.run, f.operations))[0].adjustment, -1);
});

test("snapshots are bound to worker identity, routing and a verified calculation", () => {
  const f = fixture(); const worker = workerFromRow(f.worker); const snapshot = buildSnapshot(worker, 2026, f.d4Rows);
  assert.deepEqual(parseSnapshot(JSON.stringify(snapshot), worker), snapshot);
  for (const change of [
    (s) => { s.workerKey = "other"; }, (s) => { s.routing.d4DataSourceId = "other"; },
    (s) => { s.entitlement = 10; }, (s) => { s.adjustment = 1; },
  ]) {
    const changed = structuredClone(snapshot); change(changed);
    assert.throws(() => parseSnapshot(JSON.stringify(changed), worker), /snapshot/);
  }
});
