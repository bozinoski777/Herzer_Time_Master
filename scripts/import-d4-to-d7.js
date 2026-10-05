"use strict";

// Manual, create-only historical backfill. Never call the D3 reconciler here:
// its current-month ownership and stale-row cleanup rules do not apply to D4.
const {
  assertPropertyTypes, createPage, databaseIdFromDataSource, date, getDataSource,
  getDatabase, getPage, queryAll, requireEnv, richText, richTextValue, select,
  title, titleValue,
} = require("./notion");
const { assertArchiveDataSource } = require("./day-schemas");
const { D7_SCHEMA } = require("./management-sync");
const { daySyncKey, parseDaySyncKey } = require("./day-sync-key");
const { carryoverYear } = require("./vacation-carryover-record");
const { normalizeNotionId: norm, assertFrontendIdentity } = require("./worker-identity");
const {
  D1_WORKER_REFERENCE_SCHEMA, assertUniqueWorkerReferences, workerReferencesFromD1,
  assertWorkerDatabaseReference, assertWorkerDataSourceReference, assertPageBelongsToWorkerRoute,
} = require("./worker-database-references");

const D1_SCHEMA = {
  ...D1_WORKER_REFERENCE_SCHEMA,
  "Vor- und Nachname": "title", "Worker Key": "rich_text", "Frontend Page ID": "rich_text",
  "Onboarding Status": "select", "Current Month": "rich_text",
  "Rollover Manifest": "rich_text", "Rollover Status": "select", Active: "checkbox",
};
const D8_SCHEMA = {
  Standort: "title", Active: "checkbox", "Arbeitszeiten (D7)": "relation", "Gearbeitete Stunden": "rollup",
};
const text = (row, name) => richTextValue(row.properties?.[name]).trim();
const link = (id) => `https://www.notion.so/${norm(id)}`;
const stable = (value) => JSON.stringify(value);
const counts = () => ({ eligible: 0, alreadyPresent: 0, toCopy: 0, excluded: 0, conflicting: 0 });

function uuid(value, label) {
  if (!/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(value || "")) {
    throw new Error(`${label} must be a Notion UUID`);
  }
  return value;
}

function configuration(env = process.env) {
  const preview = env.D4_D7_PREVIEW_ONLY ?? "true";
  if (!["true", "false"].includes(preview)) throw new Error("D4_D7_PREVIEW_ONLY must be true or false");
  return {
    d1: uuid(env.D1_DATA_SOURCE_ID, "D1"), d7: uuid(env.D7_DATA_SOURCE_ID, "D7"),
    d8: uuid(env.D8_DATA_SOURCE_ID, "D8"), previewOnly: preview === "true",
  };
}

function activeStandorte(rows) {
  const allNames = new Map();
  const active = [];
  for (const row of rows) {
    const name = titleValue(row.properties?.Standort).trim();
    if (!name) {
      if (row.properties?.Active?.checkbox) throw new Error(`Active D8 Standort has no name: ${link(row.id)}`);
      continue;
    }
    if (allNames.has(name)) {
      throw new Error(`Duplicate D8 Standort ${JSON.stringify(name)}: ${link(allNames.get(name))}, ${link(row.id)}`);
    }
    allNames.set(name, row.id);
    if (row.properties.Active?.checkbox) active.push({ name, id: uuid(row.id, "D8 page") });
  }
  return active.sort((a, b) => a.name.localeCompare(b.name));
}

function workerFromRow(row) {
  return {
    ...workerReferencesFromD1(row), currentMonth: text(row, "Current Month"),
    onboardingStatus: row.properties["Onboarding Status"]?.select?.name || "",
    rolloverManifest: text(row, "Rollover Manifest"),
    rolloverStatus: row.properties["Rollover Status"]?.select?.name || "",
  };
}

function workerSnapshot(worker) {
  return Object.fromEntries([
    "rowId", "name", "workerKey", "frontendPageId", "d3DatabaseId", "d3DataSourceId",
    "d4DatabaseId", "d4DataSourceId", "currentMonth", "onboardingStatus", "rolloverManifest", "rolloverStatus",
  ].map((key) => [key, worker[key]]));
}

function assertRelation(property, target, label) {
  const relation = property.relation || {};
  const matches = relation.data_source_id
    ? norm(relation.data_source_id) === norm(target.id)
    : norm(relation.database_id) === norm(databaseIdFromDataSource(target));
  if (!matches || relation.type !== "dual_property") throw new Error(`${label} must be a two-way relation to the configured database`);
}

function samePropertyId(left, right) {
  if (!left || !right) return false;
  const decode = (value) => { try { return decodeURIComponent(value); } catch { return value; } };
  return decode(left) === decode(right);
}

async function readRegistry(config, api) {
  const sources = {};
  for (const [key, schema] of [["d1", D1_SCHEMA], ["d7", D7_SCHEMA], ["d8", D8_SCHEMA]]) {
    const source = await api.getDataSource(config[key]);
    if (norm(source.id) !== norm(config[key])) throw new Error(`Retrieved ${key} does not match configured ID`);
    assertPropertyTypes(source, schema);
    sources[key] = source;
  }
  assertRelation(sources.d7.properties["Standort (D8)"], sources.d8, "D7 Standort (D8)");
  assertRelation(sources.d8.properties["Arbeitszeiten (D7)"], sources.d7, "D8 Arbeitszeiten (D7)");
  const rollup = sources.d8.properties["Gearbeitete Stunden"].rollup || {};
  const d7Relation = sources.d7.properties["Standort (D8)"];
  const d8Relation = sources.d8.properties["Arbeitszeiten (D7)"];
  if (!samePropertyId(d7Relation.relation.dual_property?.synced_property_id, d8Relation.id) ||
      !samePropertyId(d8Relation.relation.dual_property?.synced_property_id, d7Relation.id)) {
    throw new Error("D7 Standort (D8) and D8 Arbeitszeiten (D7) must be the same reciprocal relation");
  }
  const hours = sources.d7.properties.Stunden;
  if (rollup.function !== "sum" ||
      !(rollup.relation_property_id ? samePropertyId(rollup.relation_property_id, d8Relation.id) : rollup.relation_property_name === "Arbeitszeiten (D7)") ||
      !(rollup.rollup_property_id ? samePropertyId(rollup.rollup_property_id, hours.id) : rollup.rollup_property_name === "Stunden")) {
    throw new Error("D8 Gearbeitete Stunden must sum D7 Stunden through Arbeitszeiten (D7)");
  }
  const workers = (await api.queryAll(config.d1)).map(workerFromRow);
  assertUniqueWorkerReferences(workers, {
    reservedDataSources: [config.d1, config.d7, config.d8],
    reservedDatabases: Object.values(sources).map(databaseIdFromDataSource),
  });
  return { workers, sites: activeStandorte(await api.queryAll(config.d8)) };
}

async function archiveRows(worker, api) {
  if (worker.onboardingStatus !== "Ready") throw new Error(`${worker.name}: archive exists but onboarding is not Ready`);
  if (!titleValue(worker.row.properties["Vor- und Nachname"]).trim() || !worker.workerKey || worker.workerKey.includes("|")) {
    throw new Error(`${link(worker.rowId)}: missing worker name or valid Worker Key`);
  }
  for (const key of ["frontendPageId", "d4DatabaseId", "d4DataSourceId"]) uuid(worker[key], `${worker.name}: ${key}`);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(worker.currentMonth)) throw new Error(`${worker.name}: invalid Current Month`);
  if (worker.rolloverManifest || worker.rolloverStatus === "Running") throw new Error(`${worker.name}: pending/running rollover; finish it first`);
  const frontend = await api.getPage(worker.frontendPageId);
  assertFrontendIdentity(frontend, worker);
  if (norm(frontend.id) !== norm(worker.frontendPageId) ||
      norm(text(frontend, "D1 Record ID")) !== norm(worker.rowId) || text(frontend, "Worker Key") !== worker.workerKey) {
    throw new Error(`${worker.name}: frontend identity is incomplete or changed`);
  }
  assertWorkerDatabaseReference(worker, "d4", await api.getDatabase(worker.d4DatabaseId), {
    expectedParentPageId: worker.frontendPageId,
  });
  assertWorkerDataSourceReference(worker, "d4", await api.getDataSource(worker.d4DataSourceId), {
    schema: assertArchiveDataSource,
  });
  const rows = await api.queryAll(worker.d4DataSourceId);
  const ids = new Set();
  for (const row of rows) {
    uuid(row.id, "D4 page");
    if (ids.has(norm(row.id))) throw new Error(`Duplicate D4 page ${link(row.id)}`);
    ids.add(norm(row.id));
    assertPageBelongsToWorkerRoute(row, worker, "d4");
  }
  return rows;
}

function sourceSnapshot(rows) {
  return stable(rows.map((row) => ({
    id: norm(row.id), weekday: titleValue(row.properties.Wochentag),
    date: row.properties.Datum?.date || null, hours: row.properties.Stunden?.number ?? null,
    site: row.properties.Standort?.select?.name || "", key: text(row, "Sync Key"), source: text(row, "Source Page ID"),
  })).sort((a, b) => a.id.localeCompare(b.id)));
}

function entryFromRow(worker, row, site) {
  const value = row.properties.Datum?.date;
  const datum = value?.start;
  const parsed = new Date(`${datum}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum || "") || Number.isNaN(parsed.valueOf()) ||
      parsed.toISOString().slice(0, 10) !== datum || value.end || value.time_zone) throw new Error("invalid/missing date-only Datum");
  if (datum.slice(0, 7) >= worker.currentMonth) throw new Error(`Datum ${datum} is in/after D1 Current Month ${worker.currentMonth}`);
  const hours = row.properties.Stunden?.number ?? null;
  if (hours !== null && !Number.isFinite(hours)) throw new Error("invalid Stunden");
  const sourceId = uuid(text(row, "Source Page ID"), "Original Source Page ID");
  const parsedKey = parseDaySyncKey(text(row, "Sync Key"), worker.workerKey);
  if (!parsedKey || parsedKey.date !== datum || (parsedKey.sourcePageId && norm(parsedKey.sourcePageId) !== norm(sourceId))) {
    throw new Error("D4 Sync Key disagrees with worker/date/original source");
  }
  return {
    worker, archiveId: row.id, sourceId, datum, hours, site,
    weekday: titleValue(row.properties.Wochentag), syncKey: daySyncKey(worker.workerKey, datum, sourceId),
  };
}

function canonicalKey(key) {
  const match = /^(.*)\|(\d{4}-\d{2}-\d{2})\|([^|]+)$/.exec(key);
  return match ? `${match[1]}|${match[2]}|${norm(match[3])}` : key;
}

function matches(row, entry) {
  const p = row.properties;
  const route = norm(text(row, "Source Database ID"));
  const relations = p["Standort (D8)"]?.relation || [];
  return norm(text(row, "Source Page ID")) === norm(entry.sourceId) &&
    canonicalKey(text(row, "Sync Key")) === canonicalKey(entry.syncKey) &&
    text(row, "Worker Key") === entry.worker.workerKey && text(row, "Vor- und Nachname") === entry.worker.name &&
    [entry.worker.d3DatabaseId, entry.worker.d4DatabaseId].filter(Boolean).some((id) => norm(id) === route) &&
    titleValue(p.Wochentag) === entry.weekday && p.Datum?.date?.start === entry.datum &&
    !p.Datum.date.end && !p.Datum.date.time_zone && (p.Stunden?.number ?? null) === entry.hours &&
    (p.Standort?.select?.name || "").trim() === entry.site.name &&
    !p["Standort (D8)"]?.has_more && relations.length === 1 && norm(relations[0].id) === norm(entry.site.id);
}

function reconcile(entries, rows) {
  const conflicts = [];
  const duplicateRows = new Set();
  const index = (value, label) => {
    const map = new Map();
    for (const row of rows) {
      const key = value(row);
      if (!key) continue;
      if (map.has(key)) {
        conflicts.push(`Duplicate D7 ${label}: ${link(map.get(key).id)}, ${link(row.id)}`);
        duplicateRows.add(map.get(key));
        duplicateRows.add(row);
      } else map.set(key, row);
    }
    return map;
  };
  const bySource = index((row) => norm(text(row, "Source Page ID")), "Source Page ID");
  const byKey = index((row) => canonicalKey(text(row, "Sync Key")), "Sync Key");
  const legacyByWorkerDate = new Map();
  const legacyByNameDate = new Map();
  for (const row of rows) {
    if (text(row, "Source Page ID")) continue;
    const workerKey = text(row, "Worker Key");
    const map = workerKey ? legacyByWorkerDate : legacyByNameDate;
    const key = stable([workerKey || text(row, "Vor- und Nachname"), row.properties.Datum?.date?.start]);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  const results = entries.map((entry) => {
    const candidates = new Set([
      bySource.get(norm(entry.sourceId)), bySource.get(norm(entry.archiveId)), byKey.get(canonicalKey(entry.syncKey)),
      byKey.get(`${entry.worker.workerKey}|${entry.datum}`),
    ].filter(Boolean));
    // A legacy row without provenance might already represent this day. Never
    // guess by date/hours: legitimate split-day entries can have identical values.
    for (const row of [
      ...(legacyByWorkerDate.get(stable([entry.worker.workerKey, entry.datum])) || []),
      ...(legacyByNameDate.get(stable([entry.worker.name, entry.datum])) || []),
    ]) candidates.add(row);
    const existing = [...candidates];
    let status = "toCopy";
    if (existing.length === 1 && !duplicateRows.has(existing[0]) && matches(existing[0], entry)) status = "alreadyPresent";
    else if (existing.length) {
      status = "conflicting";
      conflicts.push(`D4 ${link(entry.archiveId)} conflicts with D7 ${existing.map((row) => link(row.id)).join(", ")}`);
    }
    return { entry, status };
  });
  return { results, conflicts };
}

function properties(entry, now) {
  return {
    Wochentag: title(entry.weekday), Datum: date(entry.datum), Stunden: { number: entry.hours },
    Standort: select(entry.site.name), "Standort (D8)": { relation: [{ id: entry.site.id }] },
    "Vor- und Nachname": richText(entry.worker.name), "Worker Key": richText(entry.worker.workerKey),
    "Sync Key": richText(entry.syncKey), "Source Page ID": richText(entry.sourceId),
    "Source Database ID": richText(entry.worker.d4DatabaseId), "Last Synced At": date(now),
  };
}

async function prepareImport(config, api) {
  const registry = await readRegistry(config, api);
  const plan = { ...registry, scans: [], skipped: [], entries: [], conflicts: [], results: [] };
  if (!registry.sites.length) return plan;
  const sites = new Map(registry.sites.map((site) => [site.name, site]));
  const sources = new Map();
  for (const worker of registry.workers) {
    if (!worker.d4DatabaseId && !worker.d4DataSourceId) {
      plan.skipped.push(`${worker.name}: no D4 archive`);
      continue;
    }
    const rows = await archiveRows(worker, api);
    const scan = { worker, snapshot: sourceSnapshot(rows), excluded: [], invalid: [] };
    plan.scans.push(scan);
    for (const row of rows) {
      const name = (row.properties.Standort?.select?.name || "").trim();
      try {
        if (carryoverYear(row, worker) !== null || !sites.has(name)) {
          scan.excluded.push(name || "(blank)");
          continue;
        }
        const entry = entryFromRow(worker, row, sites.get(name));
        if (sources.has(norm(entry.sourceId))) throw new Error(`duplicate original source, also in ${link(sources.get(norm(entry.sourceId)))}`);
        sources.set(norm(entry.sourceId), row.id);
        plan.entries.push(entry);
      } catch (error) {
        scan.invalid.push(name || "(blank)");
        plan.conflicts.push(`${worker.name}: ${link(row.id)}: ${error.message}`);
      }
    }
  }
  const destination = reconcile(plan.entries, await api.queryAll(config.d7));
  plan.results = destination.results;
  plan.conflicts.push(...destination.conflicts);
  return plan;
}

function report(plan) {
  const workers = new Map(plan.scans.map((scan) => [scan.worker.rowId, { name: scan.worker.name, ...counts() }]));
  const sites = new Map(plan.sites.map((site) => [site.name, counts()]));
  const siteCounts = (name) => {
    if (!sites.has(name)) sites.set(name, counts());
    return sites.get(name);
  };
  for (const scan of plan.scans) {
    const worker = workers.get(scan.worker.rowId);
    for (const name of scan.excluded) { worker.excluded++; siteCounts(name).excluded++; }
    for (const name of scan.invalid) { worker.conflicting++; siteCounts(name).conflicting++; }
  }
  for (const { entry, status } of plan.results) {
    for (const count of [workers.get(entry.worker.rowId), siteCounts(entry.site.name)]) { count.eligible++; count[status]++; }
  }
  return {
    activeStandorte: plan.sites.map((site) => ({ name: site.name, url: link(site.id) })),
    workers: [...workers.values()], standorte: [...sites].map(([name, count]) => ({ name, ...count })),
    skipped: plan.skipped, conflicts: plan.conflicts,
  };
}

function assertNoConflicts(plan) {
  if (plan.conflicts.length) throw new Error(`Import blocked by ${plan.conflicts.length} conflict(s):\n${plan.conflicts.join("\n")}`);
}

async function recheck(plan, config, api, scan) {
  const registry = await readRegistry(config, api);
  if (stable(registry.sites) !== stable(plan.sites)) throw new Error("Active D8 Standorte changed; run a fresh preview");
  const current = registry.workers.find((worker) => norm(worker.rowId) === norm(scan.worker.rowId));
  if (!current || stable(workerSnapshot(current)) !== stable(workerSnapshot(scan.worker))) {
    throw new Error(`${scan.worker.name}: worker routing/state changed; run a fresh preview`);
  }
  if (sourceSnapshot(await archiveRows(current, api)) !== scan.snapshot) {
    throw new Error(`${current.name}: D4 source values changed; run a fresh preview`);
  }
}

async function verify(entries, config, api) {
  // Only re-read on delayed visibility; never repeat a create here.
  for (const delay of [0, 1000, 2000, 4000, 8000]) {
    if (delay) await api.sleep(delay);
    const result = reconcile(entries, await api.queryAll(config.d7));
    assertNoConflicts(result);
    if (result.results.every((item) => item.status === "alreadyPresent")) return;
  }
  throw new Error("D7 verification still has missing entries after five reads. Start a fresh preview before retrying; copies may already exist.");
}

async function runImport(config, operations = {}) {
  const api = {
    createPage, getDataSource, getDatabase, getPage, queryAll,
    log: console.log, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...operations,
  };
  // Direct callers must explicitly opt into writes too.
  const previewOnly = config.previewOnly !== false;
  const plan = await prepareImport(config, api);
  api.log(JSON.stringify({ mode: previewOnly ? "preview" : "copy", ...report(plan) }, null, 2));
  assertNoConflicts(plan);
  if (previewOnly || !plan.sites.length || !plan.entries.length) return plan;
  let created = 0;
  for (const scan of plan.scans) {
    await recheck(plan, config, api, scan);
    const refreshed = reconcile(plan.entries, await api.queryAll(config.d7));
    assertNoConflicts(refreshed);
    for (const { entry, status } of refreshed.results) {
      if (entry.worker.rowId !== scan.worker.rowId || status !== "toCopy") continue;
      try {
        await api.createPage({ type: "data_source_id", data_source_id: config.d7 }, properties(entry, new Date().toISOString()));
        created++;
      } catch (error) {
        throw new Error(`Copy stopped after ${created} acknowledged create(s), at D4 ${link(entry.archiveId)}. ` +
          `The last create may have succeeded; start a new preview to recover without duplicates. ${error.message}`);
      }
    }
    api.log(`${scan.worker.name}: completed; ${created} total entries created`);
  }
  await verify(plan.entries, config, api);
  for (const scan of plan.scans) await recheck(plan, config, api, scan);
  api.log(`Verified ${plan.entries.length} D7 entries and their D8 relations; created ${created}. D4 archives unchanged.`);
  return plan;
}

if (require.main === module) {
  Promise.resolve().then(() => {
    requireEnv("NOTION_TOKEN");
    return runImport(configuration());
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = {
  D1_SCHEMA, D8_SCHEMA, configuration, activeStandorte, workerFromRow,
  entryFromRow, reconcile, properties, prepareImport, report, runImport,
};
