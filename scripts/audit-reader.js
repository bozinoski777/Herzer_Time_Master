"use strict";
const notion = require("./notion");
const { workerReferencesFromD1, assertUniqueWorkerReferences, assertWorkerDatabaseReference, assertWorkerDataSourceReference, assertPageBelongsToWorkerRoute, D1_WORKER_REFERENCE_SCHEMA } = require("./worker-database-references");
const { assertFrontendIdentity, normalizeNotionId: norm } = require("./worker-identity");
const { assertDayDataSource, assertArchiveDataSource, assertVacationDayFormula } = require("./day-schemas");
const { D7_SCHEMA } = require("./management-sync");
const canonicalPropertyId = (value) => { try { return decodeURIComponent(String(value || "")); } catch { return String(value || ""); } };
const { text, add } = require("./audit-model");

// Explicit transport allowlist. Even an accidental writer call cannot modify
// a business record through the collector's API.
function readOnlyApi(transport = notion.notion) {
  async function request(path, options = {}) {
    const method = options.method || "GET";
    if (!((method === "GET" && /^\/(?:pages|databases|data_sources)\//.test(path)) ||
      (method === "POST" && /^\/data_sources\/[^/?]+\/query$/.test(path)))) throw new Error("Audit collector forbids Notion mutations");
    return transport(path, options);
  }
  async function queryAll(id, filter) {
    const results = []; const seen = new Set(); let cursor;
    do {
      const response = await request(`/data_sources/${id}/query`, { method: "POST", body: { page_size: 100, ...(filter ? { filter } : {}), ...(cursor ? { start_cursor: cursor } : {}) } });
      results.push(...response.results);
      cursor = response.has_more ? response.next_cursor : null;
      if (response.has_more && (!cursor || seen.has(cursor))) throw new Error("Incomplete query pagination");
      seen.add(cursor);
    } while (cursor);
    return results;
  }
  async function property(pageId, propertyId) {
    const items = []; const seen = new Set(); let cursor, rollup;
    do {
      const query = new URLSearchParams({ page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) });
      const response = await request(`/pages/${pageId}/properties/${encodeURIComponent(canonicalPropertyId(propertyId))}?${query}`);
      if (response.object !== "list") return response;
      items.push(...response.results);
      if (response.property_item?.rollup) rollup = response.property_item.rollup;
      cursor = response.has_more ? response.next_cursor : null;
      if (response.has_more && (!cursor || seen.has(cursor))) throw new Error("Incomplete property pagination");
      seen.add(cursor);
    } while (cursor);
    if (rollup && rollup.type !== "number") throw new Error(`Rollup calculation is ${rollup.type}, not a complete number`);
    return rollup ? { type: "rollup", rollup } : { type: "relation", relation: items.map((item) => item.relation).filter(Boolean), has_more: false };
  }
  return Object.freeze({ request, queryAll, property, getPage: (id) => request(`/pages/${id}`), getDatabase: (id) => request(`/databases/${id}`), getDataSource: (id) => request(`/data_sources/${id}`) });
}
function assertLive(value) { if (value.in_trash || value.archived) throw new Error(`Resource ${value.id} is in Trash`); return value; }
async function hydrate(rows, names, api, always = false) {
  for (const row of rows) for (const name of names) {
    const property = row.properties?.[name];
    if (!property) throw new Error(`Page ${row.id} is missing ${name}`);
    if (always || property.has_more || property.rollup?.type === "incomplete") {
      if (!property.id) throw new Error(`Page ${row.id} lacks a property ID for ${name}`);
      row.properties[name] = { ...property, ...await api.property(row.id, property.id), has_more: false };
    }
  }
}
function validateRelations(d7, d8) {
  const a = d7.properties["Standort (D8)"], b = d8.properties["Arbeitszeiten (D7)"];
  const targetMatches = (property, target) => norm(property.relation?.data_source_id) === norm(target.id) || norm(property.relation?.database_id) === norm(notion.databaseIdFromDataSource(target));
  if (!targetMatches(a, d8) || !targetMatches(b, d7)) throw new Error("D7/D8 relation targets are incorrect");
  const same = (a, b) => Boolean(a && b && canonicalPropertyId(a) === canonicalPropertyId(b));
  if (!same(a.relation.dual_property?.synced_property_id, b.id) || !same(b.relation.dual_property?.synced_property_id, a.id)) throw new Error("D7/D8 relations are not reciprocal");
  const rollup = d8.properties["Gearbeitete Stunden"].rollup;
  if (rollup?.function !== "sum" || !(same(rollup.relation_property_id, b.id) || rollup.relation_property_name === "Arbeitszeiten (D7)") ||
      !(same(rollup.rollup_property_id, d7.properties.Stunden.id) || rollup.rollup_property_name === "Stunden")) throw new Error("D8 rollup must sum D7 Stunden through Arbeitszeiten (D7)");
}
function nextMonth(month) { const d = new Date(`${month}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); }
async function collect(config, api = readOnlyApi()) {
  const snapshot = { registry: [], workers: [], d7: [], sites: [], findings: [], schemas: {} };
  const failure = (code, error, worker) => add(snapshot, "incomplete", code, error.message, worker);
  for (const key of ["d1", "d7", "d8"]) {
    try { snapshot.schemas[key] = assertLive(await api.getDataSource(config[key])); }
    catch (error) { failure("schema-access", error); }
  }
  try {
    notion.assertPropertyTypes(snapshot.schemas.d1, { "Vor- und Nachname": "title", "Worker Key": "rich_text", "Frontend Page ID": "rich_text", "Onboarding Status": "select", "Current Month": "rich_text", ...D1_WORKER_REFERENCE_SCHEMA });
    notion.assertPropertyTypes(snapshot.schemas.d7, D7_SCHEMA);
    notion.assertPropertyTypes(snapshot.schemas.d8, { Standort: "title", Active: "checkbox", "Arbeitszeiten (D7)": "relation", "Gearbeitete Stunden": "rollup" });
    validateRelations(snapshot.schemas.d7, snapshot.schemas.d8);
  } catch (error) { failure("schema", error); }
  try {
    snapshot.registry = await api.queryAll(config.d1);
    snapshot.workers = snapshot.registry.map((row) => ({ worker: { ...workerReferencesFromD1(row), currentMonth: text(row, "Current Month") }, d3: [], d4: [], verified: false }));
    assertUniqueWorkerReferences(snapshot.workers.map((w) => w.worker), { reservedDataSources: [config.d1, config.d7, config.d8], reservedDatabases: Object.values(snapshot.schemas).map(notion.databaseIdFromDataSource) });
    const frontends = new Set();
    for (const { worker } of snapshot.workers) if (worker.frontendPageId) {
      if (frontends.has(norm(worker.frontendPageId))) throw new Error("D1 workers share the same frontend page");
      frontends.add(norm(worker.frontendPageId));
    }
  } catch (error) { failure("registry", error); }
  try {
    snapshot.sites = await api.queryAll(config.d8);
    if (config.scope === "full") await hydrate(snapshot.sites, ["Arbeitszeiten (D7)", "Gearbeitete Stunden"], api, true);
  } catch (error) { failure("location-access", error); }
  for (const data of snapshot.workers) {
    const { worker } = data;
    const status = worker.row.properties?.["Onboarding Status"]?.select?.name;
    if (status !== "Ready") { add(snapshot, "warning", "onboarding-pending", `Worker onboarding is ${status || "unset"}; reported separately`, worker, [worker.row]); continue; }
    try {
      if (!worker.workerKey || worker.workerKey.includes("|") || !worker.frontendPageId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(worker.currentMonth)) throw new Error("Worker identity or Current Month is incomplete");
      const frontend = assertLive(await api.getPage(worker.frontendPageId));
      assertFrontendIdentity(frontend, worker);
      if (norm(text(frontend, "D1 Record ID")) !== norm(worker.rowId) || text(frontend, "Worker Key") !== worker.workerKey) throw new Error("Frontend identity is incomplete");
      const title = Object.values(frontend.properties || {}).find((p) => p.type === "title");
      if (title && notion.titleValue(title).trim() !== worker.name) add(snapshot, "info", "frontend-name", "Frontend title differs from D1", worker, [frontend]);
      data.frontend = frontend;
      data.schemas = {};
      for (const role of ["d3", "d4"]) {
        const db = assertLive(await api.getDatabase(worker[`${role}DatabaseId`]));
        assertWorkerDatabaseReference(worker, role, db, { expectedParentPageId: worker.frontendPageId });
        const ds = assertLive(await api.getDataSource(worker[`${role}DataSourceId`]));
        assertWorkerDataSourceReference(worker, role, ds, { schema: role === "d3" ? assertDayDataSource : assertArchiveDataSource });
        data.schemas[role] = ds;
        if (role === "d4" && config.scope === "full") assertVacationDayFormula(ds);
      }
      if (text(worker.row, "Rollover Manifest") || ["Running", "Error"].includes(worker.row.properties?.["Rollover Status"]?.select?.name)) throw new Error("Worker has an unresolved rollover checkpoint or error");
      data.d3 = await api.queryAll(worker.d3DataSourceId);
      if (config.scope === "full") data.d4 = await api.queryAll(worker.d4DataSourceId);
      for (const role of ["d3", "d4"]) for (const row of data[role]) assertPageBelongsToWorkerRoute(row, worker, role);
      data.verified = true;
    } catch (error) { failure("worker-access-or-state", error, worker); }
  }
  try {
    if (config.scope === "full") snapshot.d7 = await api.queryAll(config.d7);
    else {
      const found = new Map();
      const months = new Set([config.currentMonth, ...snapshot.workers.map((w) => w.worker.currentMonth)].filter((m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || "")));
      const filters = [...months].map((m) => ({ and: [{ property: "Datum", date: { on_or_after: `${m}-01` } }, { property: "Datum", date: { before: nextMonth(m) } }] }));
      for (const { worker, d3 } of snapshot.workers) {
        if (worker.workerKey && worker.currentMonth) filters.push({ property: "Sync Key", rich_text: { starts_with: `${worker.workerKey}|${worker.currentMonth}-` } });
        for (let i = 0; i < d3.length; i += 50) filters.push({ or: d3.slice(i, i + 50).map((r) => ({ property: "Source Page ID", rich_text: { equals: r.id } })) });
      }
      for (const filter of filters) for (const row of await api.queryAll(config.d7, filter)) found.set(norm(row.id), row);
      snapshot.d7 = [...found.values()];
    }
    await hydrate(snapshot.d7, ["Standort (D8)"], api);
    // A source deleted after the preceding sync is a pending edit, not yet a
    // confirmed orphan. Resolve only current-month unmatched source IDs.
    if (config.syncCutoff) for (const data of snapshot.workers.filter((w) => w.verified)) {
      const ids = new Set(data.d3.map((r) => norm(r.id)));
      data.absentSources = [];
      for (const row of snapshot.d7) {
        const source = text(row, "Source Page ID");
        if (!source || ids.has(norm(source)) || text(row, "Worker Key") !== data.worker.workerKey ||
            norm(text(row, "Source Database ID")) !== norm(data.worker.d3DatabaseId) ||
            !row.properties?.Datum?.date?.start?.startsWith(data.worker.currentMonth)) continue;
        try {
          const page = await api.getPage(source);
          assertPageBelongsToWorkerRoute(page, data.worker, "d3");
          data.absentSources.push(page);
        } catch (error) { failure("source-access", error, data.worker); }
      }
    }
  } catch (error) { failure("management-access", error); }
  return snapshot;
}
module.exports = { readOnlyApi, hydrate, validateRelations, collect };
