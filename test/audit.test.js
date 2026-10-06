"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { compareSnapshot, compareReads, equalNumber } = require("../scripts/audit-model");
const { readOnlyApi, collect } = require("../scripts/audit-reader");
const { configuration, run } = require("../scripts/audit");
const { scheduledScope, markerContext } = require("../scripts/audit-trigger");
const { publish, MARKER, SCHEMA } = require("../scripts/audit-report");
const { VACATION_DAY_FORMULA, D4_PROPERTY_TYPES, DAY_PROPERTY_TYPES } = require("../scripts/day-schemas");
const { D7_SCHEMA } = require("../scripts/management-sync");
const { D1_WORKER_REFERENCE_SCHEMA } = require("../scripts/worker-database-references");
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const rt = (s) => ({ type: "rich_text", rich_text: s ? [{ plain_text: s }] : [] });
const title = (s) => ({ type: "title", title: [{ plain_text: s }] });
const opts = { scope: "full", runId: "run-1", startedAt: "2026-10-05T14:00:00Z", currentMonth: "2026-10", d1: id(1), d7: id(7), d8: id(8) };
const day = (n, date, hours = 8, site = "Berlin") => ({ id: id(n), properties: { Wochentag: title("Montag"), Datum: { type: "date", date: { start: date, end: null, time_zone: null } }, Stunden: { type: "number", number: hours }, Standort: { type: "select", select: site ? { name: site } : null } } });
function fixture() {
  const worker = { workerKey: "wrk_1", name: "New Name", rowId: id(11), frontendPageId: id(12), d3DatabaseId: id(13), d3DataSourceId: id(14), d4DatabaseId: id(15), d4DataSourceId: id(16), currentMonth: "2026-10", row: { id: id(11), properties: {} } };
  const source = day(21, "2026-10-01"); source.parent = { data_source_id: worker.d3DataSourceId };
  const copy = structuredClone(source); copy.id = id(31); copy.parent = { data_source_id: opts.d7 };
  Object.assign(copy.properties, { "Worker Key": rt(worker.workerKey), "Vor- und Nachname": rt(worker.name), "Sync Key": rt(`${worker.workerKey}|2026-10-01|${source.id}`), "Source Page ID": rt(source.id), "Source Database ID": rt(worker.d3DatabaseId), "Standort (D8)": { id: "rel7", type: "relation", relation: [{ id: id(41) }] } });
  const site = { id: id(41), properties: { Standort: title("Berlin"), Active: { checkbox: false }, "Gearbeitete Stunden": { id: "total", type: "rollup", rollup: { type: "number", number: 8 } }, "Arbeitszeiten (D7)": { id: "rel8", type: "relation", relation: [{ id: copy.id }] } } };
  return { workers: [{ worker, d3: [source], d4: [], verified: true }], d7: [copy], sites: [site], registry: [], findings: [] };
}
const codes = (report) => report.findings.map((f) => f.code);
function archive(s, date = "2026-08-01") {
  const data = s.workers[0];
  const row = structuredClone(s.d7[0]); row.id = id(51); row.parent = { data_source_id: data.worker.d4DataSourceId };
  row.properties.Datum.date.start = date;
  row.properties["Source Page ID"] = rt(id(25)); row.properties["Sync Key"] = rt(`wrk_1|${date}|${id(25)}`);
  row.properties.Urlaubstag = { formula: { type: "number", number: 0 } };
  data.d4.push(row); return row;
}
test("independent audit passes matching IDs, values, inactive-site links and totals", () => {
  const report = compareSnapshot(fixture(), opts); assert.equal(report.status, "PASS"); assert.equal(report.coverage.d3Rows, 1);
});
test("missing copies and duplicate Source Page IDs fail even with otherwise correct totals", () => {
  const s = fixture(); s.d7 = []; assert.ok(codes(compareSnapshot(s, opts)).includes("current-copy-count"));
  const duplicate = fixture(); duplicate.d7.push({ ...structuredClone(duplicate.d7[0]), id: id(32) });
  assert.ok(codes(compareSnapshot(duplicate, opts)).includes("duplicate"));
});
test("offsetting hours errors cannot hide behind a matching aggregate", () => {
  const s = fixture(); const source = { ...structuredClone(s.workers[0].d3[0]), id: id(22) }; s.workers[0].d3.push(source);
  const copy = structuredClone(s.d7[0]); copy.id = id(32); copy.properties["Source Page ID"] = rt(source.id); copy.properties["Sync Key"] = rt(`wrk_1|2026-10-01|${source.id}`); s.d7.push(copy);
  s.d7[0].properties.Stunden.number = 6; s.d7[1].properties.Stunden.number = 10;
  assert.equal(compareSnapshot(s, opts).findings.filter((f) => f.code === "current-values").length, 2);
});
test("split days are separate records; renamed display names are informational", () => {
  const s = fixture(); const source = { ...structuredClone(s.workers[0].d3[0]), id: id(22) }; s.workers[0].d3.push(source);
  const copy = structuredClone(s.d7[0]); copy.id = id(32); copy.properties["Source Page ID"] = rt(source.id); copy.properties["Sync Key"] = rt(`wrk_1|2026-10-01|${source.id}`); s.d7.push(copy);
  s.d7[0].properties["Vor- und Nachname"] = rt("Old Name");
  const r = compareSnapshot(s, { ...opts, scope: "current" }); assert.equal(r.status, "PASS"); assert.ok(codes(r).includes("display-name"));
});
test("null hours are not zero and floating point comparisons use 1e-6", () => {
  assert.equal(equalNumber(null, 0), false); assert.equal(equalNumber(8, 8.00000001), true); assert.equal(equalNumber(8, 8.00001), false);
  const s = fixture(); s.workers[0].d3[0].properties.Stunden.number = null; s.d7[0].properties.Stunden.number = 0;
  assert.ok(codes(compareSnapshot(s, opts)).includes("current-values"));
});
test("archive omissions distinguish September coverage from later missing copies", () => {
  const s = fixture(); archive(s, "2026-09-01"); const r = compareSnapshot(s, opts);
  assert.equal(r.status, "WARNING"); assert.ok(codes(r).includes("legacy-coverage"));
  s.workers[0].d4 = []; archive(s); assert.ok(codes(compareSnapshot(s, opts)).includes("archive-missing"));
});
test("September copies must still agree; unknown provenance is incomplete", () => {
  const s = fixture(); const row = archive(s, "2026-09-01"); const copy = structuredClone(row); copy.id = id(35); copy.properties.Stunden.number = 9; s.d7.push(copy);
  assert.ok(codes(compareSnapshot(s, opts)).includes("archive-values"));
  row.properties["Source Page ID"] = rt(""); assert.equal(compareSnapshot(s, opts).status, "INCOMPLETE");
});
test("extra D7 copies, wrong worker ownership and location links are detected", () => {
  const s = fixture(); const copy = structuredClone(s.d7[0]); copy.id = id(33); copy.properties["Source Page ID"] = rt(id(99)); s.d7.push(copy);
  s.d7[0].properties["Worker Key"] = rt("foreign"); s.d7[0].properties["Standort (D8)"].relation = [];
  const c = codes(compareSnapshot(s, opts)); for (const code of ["extra-management", "worker-ownership", "location-link", "unknown-worker"]) assert.ok(c.includes(code), code);
});
test("Kurzarbeit and other non-location types need no D8 location", () => {
  const s = fixture(); for (const row of [s.workers[0].d3[0], s.d7[0]]) row.properties.Standort.select.name = "Kurzarbeit";
  s.d7[0].properties["Standort (D8)"].relation = []; s.sites = [];
  assert.equal(compareSnapshot(s, opts).status, "PASS");
});
test("fractional vacation is checked, and carryover is exempt from D7 copying", () => {
  const s = fixture(); const row = archive(s, "2026-09-02"); row.properties.Standort.select.name = "Urlaub"; row.properties.Stunden.number = 1.5; row.properties.Urlaubstag.formula.number = 0.1875;
  assert.equal(compareSnapshot(s, opts).counts.error, 0);
  row.properties.Urlaubstag.formula.number = 1; assert.ok(codes(compareSnapshot(s, opts)).includes("vacation-formula-value"));
  row.properties.Wochentag = title("Urlaubsmitnahme"); row.properties.Datum.date.start = "2027-01-01"; row.properties["Sync Key"] = rt("vacation-carryover|wrk_1|2026"); row.properties["Source Page ID"] = rt(""); row.properties.Stunden.number = -16; row.properties.Urlaubstag.formula.number = -2;
  assert.equal(compareSnapshot(s, opts).status, "PASS");
});
test("duplicate and malformed carryovers fail", () => {
  const s = fixture(); const row = archive(s); row.properties.Wochentag = title("Urlaubsmitnahme");
  assert.ok(codes(compareSnapshot(s, opts)).includes("carryover"));
});
test("fresh edits await the next sync; changing snapshots and failed upstream cannot pass", () => {
  const s = fixture(); s.workers[0].d3[0].last_edited_time = "2026-10-05T13:30:00Z"; s.workers[0].d3[0].properties.Stunden.number = 9;
  const r = compareSnapshot(s, { ...opts, syncCutoff: "2026-10-05T13:15:00Z" }); assert.equal(r.status, "WARNING");
  assert.equal(compareReads(fixture(), s, opts).status, "INCOMPLETE");
  assert.ok(codes(compareReads(s, s, { ...opts, upstreamFailure: "Daily failed" })).includes("upstream-failure"));
});
test("current scope explicitly excludes historical totals", () => {
  const s = fixture(); s.sites[0].properties["Gearbeitete Stunden"].rollup.number = 999;
  const r = compareSnapshot(s, { ...opts, scope: "current" }); assert.equal(r.status, "PASS"); assert.equal(r.coverage.history, "not checked");
  assert.ok(codes(compareSnapshot(s, opts)).includes("location-total"));
});
test("collector transport refuses all business mutations", async () => {
  let calls = 0; const api = readOnlyApi(async () => { calls++; return {}; });
  for (const [url, method] of [["/pages/x", "PATCH"], ["/pages", "POST"], ["/databases/x", "DELETE"], ["/data_sources/x", "PATCH"], ["/blocks/x/children", "PATCH"]])
    await assert.rejects(api.request(url, { method }), /forbids/);
  assert.equal(calls, 0);
});
test("property pagination consumes every relation and final rollup result", async () => {
  let calls = 0; const api = readOnlyApi(async (url) => {
    calls++;
    return url.includes("start_cursor") ? { object: "list", results: [{ relation: { id: "b" } }], has_more: false, property_item: { rollup: { type: "number", number: 16 } } } :
      { object: "list", results: [{ relation: { id: "a" } }], has_more: true, next_cursor: "next", property_item: { rollup: { type: "incomplete" } } };
  });
  assert.equal((await api.property("p", "a%3Ab")).rollup.number, 16); assert.equal(calls, 2);
  const relations = readOnlyApi(async (url) => url.includes("start_cursor") ? { object: "list", results: [{ relation: { id: "b" } }], has_more: false } : { object: "list", results: [{ relation: { id: "a" } }], has_more: true, next_cursor: "next" });
  assert.deepEqual((await relations.property("p", "r")).relation, [{ id: "a" }, { id: "b" }]);
});
test("broken pagination cannot produce a clean audit", async () => {
  const api = readOnlyApi(async () => ({ object: "list", results: [], has_more: true }));
  await assert.rejects(api.queryAll("d7"), /pagination/); await assert.rejects(api.property("p", "r"), /pagination/);
});
test("audit defaults are local/current and unsupported options fail", () => {
  const config = configuration([], {}, new Date(opts.startedAt)); assert.equal(config.scope, "current"); assert.equal(config.publishNotion, false);
  assert.throws(() => configuration(["--repair"]), /Unknown/);
});
test("Berlin weekly gate handles summer, winter and both DST Sundays", () => {
  for (const date of ["2026-07-05T03:00:00Z", "2026-03-29T03:00:00Z"]) {
    assert.equal(scheduledScope("35 2 * * 0", new Date(date)), "full"); assert.equal(scheduledScope("35 3 * * 0", new Date(date)), "");
  }
  for (const date of ["2026-01-04T04:00:00Z", "2026-10-25T04:00:00Z"]) assert.equal(scheduledScope("35 3 * * 0", new Date(date)), "full");
  assert.match(markerContext({ version: 1, standortConclusion: "failure", dailyRunId: "1", dailyConclusion: "failure" }).failure, /Daily.*Standort/);
  assert.throws(() => markerContext({ version: 1, standortConclusion: "skipped" }), /Invalid/);
});
test("failed collection or publication still writes an incomplete JSON/Markdown report", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
  try {
    const result = await run({ ...opts, outputDir: dir, publishNotion: true }, { collect: async () => { throw new Error("Unavailable"); }, publish: async () => { throw new Error("Cannot publish"); } });
    assert.equal(result.status, "INCOMPLETE"); assert.equal(result.counts.incomplete, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "audit.json"))).status, "INCOMPLETE");
    assert.ok(fs.readFileSync(path.join(dir, "audit.md"), "utf8").includes("INCOMPLETE"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function publisherFixture() {
  const dsId = id(71), dbId = id(72), parent = id(73); const rows = [], blocks = [], writes = []; let lostCreate = true, lostAppend = true;
  const rtRead = (property) => ({ ...property, rich_text: property.rich_text.map((x) => ({ ...x, plain_text: x.text.content })) });
  const api = {
    getDataSource: async (n) => n === opts.d1 ? { parent: { type: "database_id", database_id: id(2) } } : { id: dsId, parent: { type: "database_id", database_id: dbId }, properties: Object.fromEntries(Object.entries(SCHEMA).map(([name, type]) => [name, { type }])) },
    getDatabase: async (n) => n === id(2) ? { parent: { page_id: parent } } : { id: dbId, parent: { page_id: parent }, data_sources: [{ id: dsId }], description: [{ plain_text: MARKER }] },
    getPage: async () => ({ properties: { title: title("Control & Automation") } }),
    listAllBlockChildren: async (n) => n === parent ? [{ id: dbId, type: "child_database", child_database: { title: "Datenprüfung" } }] : blocks,
    listAllViews: async () => [{ name: "Aktuell · letzte Prüfungen" }, { name: "Vollständig · letzte Prüfungen" }],
    queryAll: async (n) => { assert.equal(n, dsId); return rows; },
    createPage: async (p, properties) => { assert.equal(p.data_source_id, dsId); const row = { id: id(74), parent: p, properties }; rows.push(row); writes.push("create"); if (lostCreate) { lostCreate = false; throw new Error("Lost response"); } return row; },
    updatePage: async (n) => { assert.equal(n, id(74)); writes.push("update"); },
    appendBlockChildren: async (n, children) => { assert.equal(n, id(74)); blocks.push(...children.map((b) => ({ ...b, [b.type]: rtRead(b[b.type]) }))); writes.push("append"); if (lostAppend) { lostAppend = false; throw new Error("Lost append response"); } },
  };
  return { api, rows, blocks, writes };
}
test("report publication recovers ambiguous creates/appends and reuses Run ID without duplicate blocks", async () => {
  const f = publisherFixture(); const report = compareSnapshot(fixture(), opts);
  await publish(report, opts, f.api); const count = f.blocks.length; await publish(report, opts, f.api);
  assert.equal(f.rows.length, 1); assert.equal(f.blocks.length, count); assert.ok(count > 0);
});
test("publisher refuses a wrong parent or an unowned report database", async () => {
  const f = publisherFixture(); f.api.getPage = async () => ({ properties: { title: title("Wrong page") } });
  await assert.rejects(publish(compareSnapshot(fixture(), opts), opts, f.api), /verified/); assert.equal(f.writes.length, 0);
});

function collectorFixture() {
  const s = fixture(); const w = s.workers[0].worker;
  w.row.properties = { "Vor- und Nachname": title(w.name), "Worker Key": rt(w.workerKey), "Frontend Page ID": rt(w.frontendPageId), "Onboarding Status": { select: { name: "Ready" } }, "Current Month": rt(w.currentMonth), Active: { checkbox: false } };
  for (const [name, key] of [["D3 Database ID", "d3DatabaseId"], ["D3 Data Source ID", "d3DataSourceId"], ["D4 Database ID", "d4DatabaseId"], ["D4 Data Source ID", "d4DataSourceId"]]) w.row.properties[name] = rt(w[key]);
  const schema = (n, db, fields) => ({ id: n, parent: { type: "database_id", database_id: db }, properties: Object.fromEntries(Object.entries(fields).map(([name, type]) => [name, { id: name, type }])) });
  const schemas = new Map([
    [opts.d1, schema(opts.d1, id(2), { "Vor- und Nachname": "title", "Worker Key": "rich_text", "Frontend Page ID": "rich_text", "Onboarding Status": "select", "Current Month": "rich_text", ...D1_WORKER_REFERENCE_SCHEMA })],
    [opts.d7, schema(opts.d7, id(70), D7_SCHEMA)], [opts.d8, schema(opts.d8, id(80), { Standort: "title", Active: "checkbox", "Arbeitszeiten (D7)": "relation", "Gearbeitete Stunden": "rollup" })],
    [w.d3DataSourceId, schema(w.d3DataSourceId, w.d3DatabaseId, DAY_PROPERTY_TYPES)], [w.d4DataSourceId, schema(w.d4DataSourceId, w.d4DatabaseId, D4_PROPERTY_TYPES)],
  ]);
  schemas.get(w.d4DataSourceId).properties.Urlaubstag.formula = { expression: VACATION_DAY_FORMULA };
  schemas.get(opts.d7).properties["Standort (D8)"].relation = { data_source_id: opts.d8, dual_property: { synced_property_id: "Arbeitszeiten (D7)" } };
  schemas.get(opts.d8).properties["Arbeitszeiten (D7)"].relation = { data_source_id: opts.d7, dual_property: { synced_property_id: "Standort (D8)" } };
  schemas.get(opts.d8).properties["Gearbeitete Stunden"].rollup = { function: "sum", relation_property_name: "Arbeitszeiten (D7)", rollup_property_name: "Stunden" };
  const api = {
    getDataSource: async (n) => structuredClone(schemas.get(n)),
    getDatabase: async (n) => ({ id: n, data_sources: [{ id: n === w.d3DatabaseId ? w.d3DataSourceId : w.d4DataSourceId }], parent: { page_id: w.frontendPageId } }),
    getPage: async () => ({ id: w.frontendPageId, properties: { Name: title(w.name), "Worker Key": rt(w.workerKey), "D1 Record ID": rt(w.rowId) } }),
    queryAll: async (n) => structuredClone(n === opts.d1 ? [w.row] : n === opts.d7 ? s.d7 : n === opts.d8 ? s.sites : n === w.d3DataSourceId ? s.workers[0].d3 : []),
    property: async (n, prop) => structuredClone(s.sites[0].properties[prop === "rel8" ? "Arbeitszeiten (D7)" : "Gearbeitete Stunden"]),
  };
  return { s, w, api, schemas };
}
test("collector verifies inactive provisioned workers and full audit passes without writes", async () => {
  const f = collectorFixture(); const snapshot = await collect(opts, f.api);
  assert.deepEqual(snapshot.findings, []); assert.equal(compareSnapshot(snapshot, opts).status, "PASS");
});
test("pending onboarding, routing collisions, inaccessible data and rollover checkpoints are reported", async () => {
  const f = collectorFixture(); f.w.row.properties["Onboarding Status"].select.name = "Pending";
  assert.ok((await collect(opts, f.api)).findings.some((x) => x.code === "onboarding-pending"));
  f.w.row.properties["Onboarding Status"].select.name = "Ready"; f.w.row.properties["Rollover Manifest"] = rt("{}");
  assert.equal(compareSnapshot(await collect(opts, f.api), opts).status, "INCOMPLETE");
  f.w.row.properties["Rollover Manifest"] = rt(""); f.api.getDatabase = async () => { throw new Error("Forbidden"); };
  assert.equal(compareSnapshot(await collect(opts, f.api), opts).status, "INCOMPLETE");
});
test("workflow audit is gated until rollout, keeps all queues, and preserves reports on failure", () => {
  const dir = path.join(__dirname, "../.github/workflows");
  for (const name of fs.readdirSync(dir)) { const content = fs.readFileSync(path.join(dir, name), "utf8"); if (content.includes("group: herzer-notion-mutations")) assert.ok(content.includes("queue: max"), name); }
  const content = fs.readFileSync(path.join(dir, "audit.yml"), "utf8");
  assert.ok(content.includes("vars.AUDIT_ENABLED == 'true'")); assert.ok(content.includes("retention-days: 90")); assert.ok(content.includes("if: always()"));
});
test("registry collisions are detected even on pending workers", async () => {
  const f = collectorFixture(); const query = f.api.queryAll;
  f.api.queryAll = async (n) => n === opts.d1 ? [f.w.row, { ...structuredClone(f.w.row), id: id(99) }] : query(n);
  assert.ok((await collect(opts, f.api)).findings.some((x) => x.code === "registry"));
});
test("carryover saved calculation is validated against balance and source-year vacation", () => {
  const s = fixture(); const w = s.workers[0].worker;
  const snapshot = { version: 1, workerKey: w.workerKey, d1RecordId: w.rowId.replaceAll("-", ""), year: 2026, start: "2026-01-01", end: "", annualAllowance: 30, entitlement: 30, taken: 0, adjustment: -30, routing: Object.fromEntries(["d3DatabaseId", "d3DataSourceId", "d4DatabaseId", "d4DataSourceId"].map((k) => [k, w[k].replaceAll("-", "")])) };
  w.row.properties["Urlaubsmitnahme Berechnung"] = rt(JSON.stringify(snapshot));
  assert.ok(codes(compareSnapshot(s, opts)).includes("carryover-snapshot"));
  const row = archive(s); row.properties.Wochentag = title("Urlaubsmitnahme"); row.properties.Datum.date.start = "2027-01-01"; row.properties.Standort.select.name = "Urlaub"; row.properties.Stunden.number = -240; row.properties.Urlaubstag.formula.number = -30; row.properties["Sync Key"] = rt("vacation-carryover|wrk_1|2026"); row.properties["Source Page ID"] = rt("");
  assert.equal(compareSnapshot(s, opts).status, "PASS");
});
test("publisher does not overwrite an unowned database even if its title matches", async () => {
  const f = publisherFixture(); const retrieve = f.api.getDatabase;
  f.api.getDatabase = async (n) => { const db = await retrieve(n); if (db.description) db.description = []; return db; };
  await assert.rejects(publish(compareSnapshot(fixture(), opts), opts, f.api), /not owned/); assert.equal(f.writes.length, 0);
});
test("public GitHub reports never contain employee data or raw failures", () => {
  const { publicReport, publicMarkdown } = require("../scripts/audit-report");
  const s = fixture(); s.d7[0].properties.Stunden.number = 999.123; const report = compareSnapshot(s, opts);
  report.findings.push({ severity: "incomplete", code: "api-error", message: "secret personal content", worker: "New Name", records: [] });
  const output = JSON.stringify(publicReport(report)) + publicMarkdown(report);
  for (const value of ["New Name", "wrk_1", "999.123", id(21), "2026-10-01", "secret personal content", "www.notion.so"]) assert.equal(output.includes(value), false, value);
});
test("recent source deletions await sync rather than becoming confirmed orphan errors", () => {
  const s = fixture(); const deleted = s.workers[0].d3.pop(); deleted.in_trash = true; deleted.last_edited_time = "2026-10-05T13:30:00Z";
  s.workers[0].absentSources = [deleted];
  const r = compareSnapshot(s, { ...opts, syncCutoff: "2026-10-05T13:15:00Z" });
  assert.equal(r.status, "WARNING"); assert.ok(codes(r).includes("awaiting-sync"));
});
