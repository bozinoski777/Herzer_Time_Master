"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { D1_SCHEMA, D8_SCHEMA, configuration, activeStandorte, runImport, report } = require("../scripts/import-d4-to-d7");
const { D4_PROPERTY_TYPES } = require("../scripts/day-schemas");
const { D7_SCHEMA } = require("../scripts/management-sync");
const { carryoverProperties } = require("../scripts/vacation-carryover-record");
const { planManagementSync } = require("../scripts/management-sync");

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const txt = (value) => ({ rich_text: value ? [{ plain_text: value }] : [] });
const heading = (value) => ({ title: [{ plain_text: value }] });
const schema = (shape) => Object.fromEntries(Object.entries(shape).map(([name, type]) => [name, { id: name, type }]));
const readText = (prop) => (prop?.rich_text || prop?.title || []).map((part) => part.plain_text ?? part.text?.content ?? "").join("");
function responseProperties(properties) {
  const copy = structuredClone(properties);
  for (const property of Object.values(copy)) {
    for (const part of property.rich_text || property.title || []) part.plain_text = part.text?.content || part.plain_text || "";
  }
  return copy;
}

function fixture() {
  const config = { d1: id(1), d7: id(7), d8: id(8), previewOnly: true };
  const sources = new Map();
  for (const [key, shape] of [["d1", D1_SCHEMA], ["d7", D7_SCHEMA], ["d8", D8_SCHEMA]]) {
    sources.set(config[key], { id: config[key], parent: { type: "database_id", database_id: id(Number(key.slice(1)) + 10) }, properties: schema(shape) });
  }
  const d7Props = sources.get(config.d7).properties;
  const d8Props = sources.get(config.d8).properties;
  d7Props["Standort (D8)"].relation = { data_source_id: config.d8, type: "dual_property", dual_property: { synced_property_id: "Arbeitszeiten (D7)" } };
  d8Props["Arbeitszeiten (D7)"].relation = { data_source_id: config.d7, type: "dual_property", dual_property: { synced_property_id: "Standort (D8)" } };
  d8Props["Gearbeitete Stunden"].rollup = {
    function: "sum", relation_property_name: "Arbeitszeiten (D7)", rollup_property_name: "Stunden",
  };
  d7Props.Standort.select = { options: Array.from({ length: 125 }, (_, i) => ({ id: id(9000 + i), name: `Historic ${i}`, color: "blue" })) };
  const sites = [
    { id: id(100), properties: { Standort: heading(" Site A "), Active: { checkbox: true } } },
    { id: id(101), properties: { Standort: heading("Site B"), Active: { checkbox: true } } },
    { id: id(102), properties: { Standort: heading("Closed"), Active: { checkbox: false } } },
  ];
  const workers = [];
  const frontends = new Map();
  const databases = new Map();
  const archives = new Map();
  for (const n of [1, 2]) {
    const base = n * 1000;
    const key = `worker${n}`;
    const worker = { id: id(base), properties: {
      "Vor- und Nachname": heading(`Worker ${n}`), "Worker Key": txt(key),
      "Frontend Page ID": txt(id(base + 1)), Active: { checkbox: n === 1 },
      "Onboarding Status": { select: { name: "Ready" } },
      "Current Month": txt("2026-10"), "Rollover Manifest": txt(""), "Rollover Status": { select: { name: "Ready" } },
      "D3 Database ID": txt(id(base + 2)), "D3 Data Source ID": txt(id(base + 3)),
      "D4 Database ID": txt(id(base + 4)), "D4 Data Source ID": txt(id(base + 5)),
    } };
    workers.push(worker);
    frontends.set(id(base + 1), { id: id(base + 1), properties: { "D1 Record ID": txt(worker.id), "Worker Key": txt(key) } });
    databases.set(id(base + 4), { id: id(base + 4), parent: { page_id: id(base + 1) }, data_sources: [{ id: id(base + 5) }] });
    sources.set(id(base + 5), { id: id(base + 5), parent: { type: "database_id", database_id: id(base + 4) }, properties: schema(D4_PROPERTY_TYPES) });
    const rows = [
      ["2025-01-03", "Site A", null], ["2026-09-01", "Site B", 0],
      ["2026-09-01", " Site A ", 4], ["2026-09-02", "Closed", 8],
    ].map(([datum, site, hours], i) => ({
      id: id(base + 10 + i), parent: { data_source_id: id(base + 5) }, properties: {
        Wochentag: heading(i === 2 ? "Teil-Tag" : "Montag"), Datum: { date: { start: datum } },
        Stunden: { number: hours }, Standort: { select: { name: site } },
        "Source Page ID": txt(id(base + 100 + i)), "Sync Key": txt(`${key}|${datum}|${id(base + 100 + i)}`),
      },
    }));
    rows.push({ id: id(base + 20), parent: { data_source_id: id(base + 5) }, properties: responseProperties(carryoverProperties(key, 2026, -2)) });
    archives.set(id(base + 5), rows);
  }
  const destination = [];
  const calls = { creates: [], waits: [], logs: [] };
  const operations = {
    getDataSource: async (sourceId) => structuredClone(sources.get(sourceId)),
    getDatabase: async (databaseId) => structuredClone(databases.get(databaseId)),
    getPage: async (pageId) => structuredClone(frontends.get(pageId)),
    queryAll: async (sourceId) => structuredClone(
      sourceId === config.d1 ? workers : sourceId === config.d8 ? sites : sourceId === config.d7 ? destination : archives.get(sourceId)),
    createPage: async (parent, properties) => {
      assert.deepEqual(parent, { type: "data_source_id", data_source_id: config.d7 });
      assert.deepEqual(Object.keys(properties.Standort.select), ["name"]);
      const row = { id: id(20000 + destination.length), properties: responseProperties(properties) };
      destination.push(row);
      calls.creates.push(structuredClone(row));
      const options = d7Props.Standort.select.options;
      if (!options.some((option) => option.name === properties.Standort.select.name)) {
        options.push({ id: id(30000 + options.length), name: properties.Standort.select.name, color: "default" });
      }
      return structuredClone(row);
    },
    sleep: async (ms) => calls.waits.push(ms),
    log: (message) => calls.logs.push(message),
    updatePage: async () => assert.fail("Existing pages must never be updated"),
    archivePage: async () => assert.fail("Pages must never be archived"),
    updateDataSource: async () => assert.fail("Schemas must never be updated"),
  };
  return { config, sources, sites, workers, archives, frontends, databases, destination, calls, operations,
    first: archives.get(id(1005))[0], apply: () => runImport({ ...config, previewOnly: false }, operations) };
}

function existingCopy(f, source = f.first, n = 1) {
  const base = n * 1000;
  return { id: id(40000 + f.destination.length), properties: {
    Wochentag: structuredClone(source.properties.Wochentag), Datum: structuredClone(source.properties.Datum),
    Stunden: structuredClone(source.properties.Stunden), Standort: { select: { name: source.properties.Standort.select.name.trim() } },
    "Standort (D8)": { relation: [{ id: id(source.properties.Standort.select.name.trim() === "Site A" ? 100 : 101) }] },
    "Vor- und Nachname": txt(`Worker ${n}`), "Worker Key": txt(`worker${n}`),
    "Sync Key": structuredClone(source.properties["Sync Key"]), "Source Page ID": structuredClone(source.properties["Source Page ID"]),
    "Source Database ID": txt(id(base + 2)), "Last Synced At": { date: { start: "2026-09-01T00:00:00Z" } },
  } };
}

test("configuration defaults to preview and refuses malformed explicit apply values", () => {
  const env = { D1_DATA_SOURCE_ID: id(1), D7_DATA_SOURCE_ID: id(7), D8_DATA_SOURCE_ID: id(8) };
  assert.equal(configuration(env).previewOnly, true);
  assert.equal(configuration({ ...env, D4_D7_PREVIEW_ONLY: "false" }).previewOnly, false);
  assert.throws(() => configuration({ ...env, D4_D7_PREVIEW_ONLY: "FALSE" }), /true or false/);
  assert.throws(() => configuration({ ...env, D7_DATA_SOURCE_ID: "url" }), /UUID/);
});

test("preview covers all years, inactive workers and split days without writes", async () => {
  const f = fixture();
  const snapshot = structuredClone({ workers: f.workers, archives: f.archives, sites: f.sites });
  const plan = await runImport(f.config, f.operations);
  assert.equal(plan.entries.length, 6);
  assert.deepEqual(plan.entries.slice(0, 3).map((entry) => [entry.datum, entry.hours]), [["2025-01-03", null], ["2026-09-01", 0], ["2026-09-01", 4]]);
  assert.equal(report(plan).workers[1].toCopy, 3);
  assert.equal(report(plan).workers[1].excluded, 2);
  assert.deepEqual(f.calls.creates, []);
  assert.deepEqual({ workers: f.workers, archives: f.archives, sites: f.sites }, snapshot);
});

test("copy links D8, preserves originals and 125 old choices, and reruns make no changes", async () => {
  const f = fixture();
  const oldOptions = structuredClone(f.sources.get(f.config.d7).properties.Standort.select.options);
  const oldArchives = structuredClone(f.archives);
  await f.apply();
  assert.equal(f.destination.length, 6);
  const copied = f.destination[0].properties;
  assert.equal(readText(copied["Source Page ID"]), id(1100));
  assert.equal(readText(copied["Source Database ID"]), id(1004));
  assert.equal(readText(copied["Sync Key"]), `worker1|2025-01-03|${id(1100)}`);
  assert.equal(copied.Stunden.number, null);
  assert.deepEqual(copied["Standort (D8)"].relation, [{ id: id(100) }]);
  assert.equal(f.destination[1].properties.Stunden.number, 0);
  assert.deepEqual(f.archives, oldArchives);
  assert.deepEqual(f.sources.get(f.config.d7).properties.Standort.select.options.slice(0, 125), oldOptions);
  const snapshot = structuredClone(f.destination);
  await f.apply();
  assert.equal(f.calls.creates.length, 6);
  assert.deepEqual(f.destination, snapshot);
});

test("existing D3-synced copies are skipped, preserving their routing and timestamp", async () => {
  const f = fixture();
  const row = existingCopy(f);
  // UUID spelling differences do not create a second identity.
  row.properties["Source Page ID"] = txt(id(1100).replaceAll("-", ""));
  row.properties["Sync Key"] = txt(`worker1|2025-01-03|${id(1100).replaceAll("-", "")}`);
  f.destination.push(row);
  const before = structuredClone(row);
  await f.apply();
  assert.equal(f.calls.creates.length, 5);
  assert.deepEqual(f.destination[0], before);
});

for (const [label, alter] of [
  ["hours", (row) => { row.properties.Stunden.number = 12; }],
  ["date", (row) => { row.properties.Datum.date.start = "2025-01-04"; }],
  ["worker", (row) => { row.properties["Worker Key"] = txt("foreign"); }],
  ["route", (row) => { row.properties["Source Database ID"] = txt(id(999)); }],
  ["relation", (row) => { row.properties["Standort (D8)"].relation = []; }],
  ["legacy identity", (row) => { row.properties["Source Page ID"] = txt(""); row.properties["Sync Key"] = txt("worker1|2025-01-03"); }],
  ["archive ID used as source", (row) => { row.properties["Source Page ID"] = txt(id(1010)); }],
]) {
  test(`conflicting ${label} blocks the whole run before any writes`, async () => {
    const f = fixture();
    const row = existingCopy(f);
    alter(row);
    f.destination.push(row);
    await assert.rejects(f.apply(), /conflict.*https:\/\/www.notion.so/s);
    assert.equal(f.calls.creates.length, 0);
    assert.ok(f.calls.logs[0].includes('"conflicting": 1'));
  });
}

for (const [label, alter] of [
  ["invalid date", (f) => { f.first.properties.Datum.date.start = "2026-02-30"; }],
  ["current month", (f) => { f.first.properties.Datum.date.start = "2026-10-01"; }],
  ["missing original source", (f) => { f.first.properties["Source Page ID"] = txt(""); }],
  ["foreign archive key", (f) => { f.first.properties["Sync Key"] = txt(`foreign|2025-01-03|${id(1100)}`); }],
  ["pending rollover", (f) => { f.workers[1].properties["Rollover Manifest"] = txt("pending"); }],
  ["route collision", (f) => { f.workers[1].properties["D4 Database ID"] = txt(id(1004)); }],
  ["incomplete route", (f) => { f.workers[1].properties["D4 Data Source ID"] = txt(""); }],
  ["foreign frontend", (f) => { f.frontends.get(id(1001)).properties["Worker Key"] = txt("foreign"); }],
  ["foreign D4 parent", (f) => { f.databases.get(id(1004)).parent.page_id = id(2001); }],
  ["foreign row parent", (f) => { f.first.parent.data_source_id = id(2005); }],
  ["wrong D8 relation target", (f) => { f.sources.get(f.config.d7).properties["Standort (D8)"].relation.data_source_id = id(999); }],
  ["wrong reciprocal relation", (f) => { f.sources.get(f.config.d7).properties["Standort (D8)"].relation.dual_property.synced_property_id = "Other D8 relation"; }],
  ["wrong D8 rollup", (f) => { f.sources.get(f.config.d8).properties["Gearbeitete Stunden"].rollup.function = "count"; }],
]) {
  test(`${label} is rejected before any copies`, async () => {
    const f = fixture();
    alter(f);
    await assert.rejects(f.apply());
    assert.equal(f.calls.creates.length, 0);
  });
}

test("all D4 sources are checked for duplicate original identities before writes", async () => {
  const f = fixture();
  const other = f.archives.get(id(2005))[0];
  other.properties["Source Page ID"] = txt(id(1100));
  other.properties["Sync Key"] = txt(`worker2|2025-01-03|${id(1100)}`);
  await assert.rejects(f.apply(), /duplicate original source/);
  assert.equal(f.calls.creates.length, 0);
});

test("D7 duplicate identities block rather than double-count", async () => {
  const f = fixture();
  f.destination.push(existingCopy(f), { ...existingCopy(f), id: id(44444) });
  await assert.rejects(f.apply(), /Duplicate D7/);
  assert.equal(f.calls.creates.length, 0);
});

test("duplicate site names including inactive names are ambiguous; matching is case-sensitive", async () => {
  const f = fixture();
  f.sites.push({ id: id(103), properties: { Standort: heading("Site A"), Active: { checkbox: false } } });
  assert.throws(() => activeStandorte(f.sites), /Duplicate D8/);
  f.sites.pop();
  f.first.properties.Standort.select.name = "site a";
  const plan = await runImport(f.config, f.operations);
  assert.equal(plan.entries.length, 5);
});

test("empty active list is a no-op; missing archives are reported", async () => {
  const f = fixture();
  for (const site of f.sites) site.properties.Active.checkbox = false;
  await f.apply();
  assert.equal(f.calls.creates.length, 0);
  f.sites[0].properties.Active.checkbox = true;
  f.workers[1].properties["D4 Database ID"] = txt("");
  f.workers[1].properties["D4 Data Source ID"] = txt("");
  const plan = await runImport(f.config, f.operations);
  assert.match(plan.skipped[0], /Worker 2: no D4/);
});

for (const change of ["D8", "source", "route"]) {
  test(`${change} drift after preview blocks before copying`, async () => {
    const f = fixture();
    const original = f.operations.queryAll;
    let registryReads = 0;
    f.operations.queryAll = async (sourceId) => {
      if (sourceId === f.config.d1 && ++registryReads === 2) {
        if (change === "D8") f.sites[0].properties.Active.checkbox = false;
        if (change === "source") f.first.properties.Stunden.number = 7;
        if (change === "route") f.workers[0].properties["Current Month"] = txt("2026-11");
      }
      return original(sourceId);
    };
    await assert.rejects(f.apply(), /changed/);
    assert.equal(f.calls.creates.length, 0);
  });
}

test("an ambiguous create stops immediately; retry recovers the copy by original source ID", async () => {
  const f = fixture();
  const create = f.operations.createPage;
  let fail = true;
  f.operations.createPage = async (...args) => {
    const row = await create(...args);
    if (fail) { fail = false; throw new Error("lost response"); }
    return row;
  };
  await assert.rejects(f.apply(), /last create may have succeeded/);
  assert.equal(f.destination.length, 1);
  assert.equal(f.calls.creates.length, 1);
  await f.apply();
  assert.equal(f.destination.length, 6);
  assert.equal(f.calls.creates.length, 6);
});

test("verification retries reads for delayed visibility without retrying creates", async () => {
  const f = fixture();
  const query = f.operations.queryAll;
  let delayed = 0;
  f.operations.queryAll = async (sourceId) => {
    const rows = await query(sourceId);
    if (sourceId === f.config.d7 && f.destination.length === 6 && delayed++ < 2) return rows.slice(0, 5);
    return rows;
  };
  await f.apply();
  assert.deepEqual(f.calls.waits, [1000, 2000]);
  assert.equal(f.calls.creates.length, 6);
});

test("verification stops after bounded reads if copied rows remain invisible", async () => {
  const f = fixture();
  const query = f.operations.queryAll;
  f.operations.queryAll = async (sourceId) => {
    const rows = await query(sourceId);
    return sourceId === f.config.d7 && f.destination.length === 6 ? rows.slice(0, 5) : rows;
  };
  await assert.rejects(f.apply(), /after five reads/);
  assert.deepEqual(f.calls.waits, [1000, 2000, 4000, 8000]);
  assert.equal(f.calls.creates.length, 6);
});

test("new D4-backed historical copies survive normal D3 current-month cleanup", async () => {
  const f = fixture();
  await f.apply();
  const worker = {
    name: "Worker 1", workerKey: "worker1", d3DatabaseId: id(1002), d3DataSourceId: id(1003), currentMonth: "2026-10",
  };
  const plan = planManagementSync(worker, [], f.destination);
  assert.deepEqual(plan.archives, []);
  assert.deepEqual(plan.updates, []);
});

test("negative and fractional recorded hours are copied exactly", async () => {
  const f = fixture();
  f.first.properties.Stunden.number = -1.25;
  f.archives.get(id(2005))[0].properties.Stunden.number = 2.5;
  await f.apply();
  assert.equal(f.destination[0].properties.Stunden.number, -1.25);
  assert.equal(f.destination[3].properties.Stunden.number, 2.5);
});

test("encoded relation and rollup property IDs validate correctly", async () => {
  const f = fixture();
  const p7 = f.sources.get(f.config.d7).properties;
  const p8 = f.sources.get(f.config.d8).properties;
  p7["Standort (D8)"].id = "a%3Ab";
  p8["Arbeitszeiten (D7)"].relation.dual_property.synced_property_id = "a:b";
  p8["Arbeitszeiten (D7)"].id = "c%3Ad";
  p7["Standort (D8)"].relation.dual_property.synced_property_id = "c:d";
  p8["Gearbeitete Stunden"].rollup.relation_property_id = "c:d";
  await runImport(f.config, f.operations);
  assert.equal(f.calls.creates.length, 0);
});

test("a D7 conflict introduced after initial validation prevents copying", async () => {
  const f = fixture();
  const query = f.operations.queryAll;
  let reads = 0;
  f.operations.queryAll = async (sourceId) => {
    if (sourceId === f.config.d7 && ++reads === 2) {
      const row = existingCopy(f);
      row.properties.Stunden.number = 17;
      f.destination.push(row);
    }
    return query(sourceId);
  };
  await assert.rejects(f.apply(), /conflict/);
  assert.equal(f.calls.creates.length, 0);
});

test("final verification rejects incorrect saved relations without retries or repairs", async () => {
  const f = fixture();
  const create = f.operations.createPage;
  f.operations.createPage = async (...args) => {
    const result = await create(...args);
    if (f.destination.length === 6) f.destination[5].properties["Standort (D8)"].relation = [];
    return result;
  };
  await assert.rejects(f.apply(), /conflict/);
  assert.equal(f.calls.creates.length, 6);
  assert.deepEqual(f.calls.waits, []);
});
