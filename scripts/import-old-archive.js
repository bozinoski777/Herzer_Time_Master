"use strict";

/**
 * Manual, copy-only migration from the legacy shared archive into one worker's
 * D4. The source is pinned deliberately; it is never an update target.
 */

const {
  assertPropertyTypes,
  createPage,
  date,
  getDataSource,
  getDatabase,
  getPage,
  queryAll,
  requireEnv,
  richText,
  richTextValue,
  select,
  title,
  titleValue,
} = require("./notion");
const { assertArchiveDataSource } = require("./day-schemas");
const { daySyncKey } = require("./day-sync-key");
const { updateDataSourceSelect } = require("./select-options");
const {
  assertFrontendIdentity,
  normalizeNotionId,
} = require("./worker-identity");
const {
  D1_WORKER_REFERENCE_SCHEMA,
  assertWorkerDatabaseReference,
  assertWorkerDataSourceReference,
  workerReferencesFromD1,
} = require("./worker-database-references");

const SOURCE_DATABASE_ID = "4206edef-dfc8-435c-b9a9-296500003907";
const SOURCE_DATA_SOURCE_ID = "13ee17a3-c636-42fa-90cd-08a6cb719628";
const EXCLUSIVE_CUTOFF = "2026-09-01";
const SOURCE_SCHEMA = Object.freeze({
  Wochentag: "title",
  Date: "date",
  Stunden: "number",
  Standort: "select",
  "Vor- und Nachname": "rich_text",
});
const D1_SCHEMA = Object.freeze({
  "Vor- und Nachname": "title",
  "Worker Key": "rich_text",
  "Frontend Page ID": "rich_text",
  "Onboarding Status": "select",
  "Current Month": "rich_text",
  "Rollover Manifest": "rich_text",
  ...D1_WORKER_REFERENCE_SCHEMA,
});

function validUuid(value, label) {
  const id = String(value || "").trim();
  if (!/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(id)) {
    throw new Error(`${label} must be a Notion database or data-source ID (UUID), not a URL`);
  }
  return id;
}

function rowText(row, propertyName) {
  return richTextValue(row?.properties?.[propertyName]).trim();
}

function selectWorker(rows, exactName, destinationId) {
  const matches = rows.filter(
    (row) => titleValue(row.properties?.["Vor- und Nachname"]).trim() === exactName,
  );
  if (matches.length !== 1) {
    throw new Error(
      `D1 has ${matches.length} exact workers named "${exactName}"; the name must identify exactly one D1 record`,
    );
  }
  const worker = workerReferencesFromD1(matches[0]);
  const destination = normalizeNotionId(destinationId);
  if (![worker.d4DatabaseId, worker.d4DataSourceId].some(
    (id) => normalizeNotionId(id) === destination,
  )) {
    throw new Error(`${exactName}: destination ID does not match this worker's D1 D4 archive`);
  }
  if (rows.some((row) => row.id !== worker.rowId && [
    "D3 Database ID", "D3 Data Source ID", "D4 Database ID", "D4 Data Source ID",
  ].some((property) => normalizeNotionId(rowText(row, property)) === destination))) {
    throw new Error(`${exactName}: another D1 worker also references the destination ID`);
  }
  if (!worker.workerKey || !worker.frontendPageId ||
      !worker.d4DatabaseId || !worker.d4DataSourceId) {
    throw new Error(`${exactName}: D1 worker identity or D4 routing is incomplete`);
  }
  if (matches[0].properties["Onboarding Status"]?.select?.name !== "Ready") {
    throw new Error(`${exactName}: onboarding must be Ready before historical import`);
  }
  const currentMonth = rowText(matches[0], "Current Month");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(currentMonth) ||
      currentMonth < EXCLUSIVE_CUTOFF.slice(0, 7)) {
    throw new Error(`${exactName}: D1 Current Month must be September 2026 or later`);
  }
  if (rowText(matches[0], "Rollover Manifest")) {
    throw new Error(`${exactName}: complete the pending month rollover before importing`);
  }
  if (matches[0].properties["Rollover Status"]?.select?.name === "Running") {
    throw new Error(`${exactName}: month rollover is marked Running; resolve it first`);
  }
  return worker;
}

function dateOnly(value, pageId) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) {
    throw new Error(`Old archive page ${pageId} needs one date-only Date value`);
  }
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Old archive page ${pageId} has an invalid Date (${value})`);
  }
  return value;
}

function sourceEntry(row, exactName, workerKey) {
  if (!row?.id || richTextValue(row.properties?.["Vor- und Nachname"]).trim() !== exactName) {
    throw new Error(`Old archive returned a row outside exact worker "${exactName}"`);
  }
  const sourceDate = row.properties?.Date?.date;
  const datum = dateOnly(sourceDate?.start, row.id);
  if (sourceDate.end || sourceDate.time_zone) {
    throw new Error(`Old archive page ${row.id} has a date range or time zone`);
  }
  const hours = row.properties.Stunden?.number ?? null;
  if (hours !== null && (typeof hours !== "number" || !Number.isFinite(hours))) {
    throw new Error(`Old archive page ${row.id} has invalid Stunden`);
  }
  return {
    sourcePageId: row.id,
    datum,
    wochentag: titleValue(row.properties.Wochentag),
    stunden: hours,
    standort: row.properties.Standort?.select?.name || "",
    syncKey: daySyncKey(workerKey, datum, row.id),
  };
}

function selectedEntries(sourceRows, exactName, workerKey) {
  const seenIds = new Set();
  const entries = [];
  let excluded = 0;
  for (const row of sourceRows) {
    if (seenIds.has(normalizeNotionId(row.id))) {
      throw new Error(`Old archive returned duplicate page ${row.id}`);
    }
    seenIds.add(normalizeNotionId(row.id));
    const entry = sourceEntry(row, exactName, workerKey);
    if (entry.datum < EXCLUSIVE_CUTOFF) entries.push(entry);
    else excluded += 1;
  }
  entries.sort((a, b) => a.datum.localeCompare(b.datum) ||
    a.sourcePageId.localeCompare(b.sourcePageId));
  return { entries, excluded };
}

function importProperties(entry) {
  return {
    Wochentag: title(entry.wochentag),
    Datum: date(entry.datum),
    Stunden: { number: entry.stunden },
    Standort: select(entry.standort),
    "Sync Key": richText(entry.syncKey),
    "Source Page ID": richText(entry.sourcePageId),
  };
}

function archiveRowMatches(row, entry) {
  const actualDate = row.properties?.Datum?.date;
  return rowText(row, "Sync Key") === entry.syncKey &&
    normalizeNotionId(rowText(row, "Source Page ID")) === normalizeNotionId(entry.sourcePageId) &&
    titleValue(row.properties.Wochentag) === entry.wochentag &&
    actualDate?.start === entry.datum && !actualDate.end && !actualDate.time_zone &&
    (row.properties.Stunden?.number ?? null) === entry.stunden &&
    (row.properties.Standort?.select?.name || "") === entry.standort;
}

/** Existing D4 rows may only be exact copies from an earlier partial run. */
function reconcileDestination(entries, destinationRows) {
  const expected = new Map(entries.map((entry) => [entry.syncKey, entry]));
  const present = new Set();
  for (const row of destinationRows) {
    const key = rowText(row, "Sync Key");
    const entry = expected.get(key);
    if (!entry || present.has(key) || !archiveRowMatches(row, entry)) {
      throw new Error(
        `Destination contains an unexpected, duplicate, or changed D4 page ${row.id}; no import writes made`,
      );
    }
    present.add(key);
  }
  return entries.filter((entry) => !present.has(entry.syncKey));
}

function requiredStandortOptions(entries, sourceDataSource) {
  const sourceOptions = new Map(
    (sourceDataSource.properties.Standort.select?.options || [])
      .map((option) => [option.name, option]),
  );
  return [...new Set(entries.map((entry) => entry.standort).filter(Boolean))]
    .map((name) => {
      const sourceOption = sourceOptions.get(name);
      if (!sourceOption) throw new Error(`Old archive Standort option "${name}" is missing from its schema`);
      return { name, ...(sourceOption.color ? { color: sourceOption.color } : {}) };
    });
}

async function prepareImport({ exactName, destinationId, d1DataSourceId }, operations = {}) {
  const api = {
    getDataSource, getDatabase, getPage, queryAll,
    ...operations,
  };
  const name = String(exactName || "").trim();
  if (!name) throw new Error("Name must be the exact D1 Vor- und Nachname");
  const destination = validUuid(destinationId, "Destination archive");
  const d1Id = validUuid(d1DataSourceId, "D1 data source");
  if ([SOURCE_DATABASE_ID, SOURCE_DATA_SOURCE_ID, d1Id].some(
    (id) => normalizeNotionId(id) === normalizeNotionId(destination),
  )) throw new Error("Destination cannot be the old archive or D1");

  const d1 = await api.getDataSource(d1Id);
  assertPropertyTypes(d1, D1_SCHEMA);
  if (normalizeNotionId(d1.id) !== normalizeNotionId(d1Id)) {
    throw new Error("Retrieved D1 data source does not match configured D1 ID");
  }
  const allD1Rows = await api.queryAll(d1Id);
  const worker = selectWorker(allD1Rows, name, destination);

  // Sequential calls honor the shared client's request spacing even during
  // preflight; parallel requests would otherwise bunch at one rate-limit slot.
  const frontend = await api.getPage(worker.frontendPageId);
  const sourceDatabase = await api.getDatabase(SOURCE_DATABASE_ID);
  const sourceDataSource = await api.getDataSource(SOURCE_DATA_SOURCE_ID);
  const destinationDatabase = await api.getDatabase(worker.d4DatabaseId);
  const destinationDataSource = await api.getDataSource(worker.d4DataSourceId);
  assertFrontendIdentity(frontend, worker);
  if (normalizeNotionId(richTextValue(frontend.properties?.["D1 Record ID"])) !==
      normalizeNotionId(worker.rowId) ||
      richTextValue(frontend.properties?.["Worker Key"]) !== worker.workerKey) {
    throw new Error(`${name}: frontend page does not carry this worker's exact D1 Record ID and Worker Key`);
  }
  if (normalizeNotionId(sourceDatabase.id) !== normalizeNotionId(SOURCE_DATABASE_ID) ||
      !(sourceDatabase.data_sources || []).some(
        (dataSource) => normalizeNotionId(dataSource.id) === normalizeNotionId(SOURCE_DATA_SOURCE_ID),
      ) || normalizeNotionId(sourceDataSource.id) !== normalizeNotionId(SOURCE_DATA_SOURCE_ID) ||
      normalizeNotionId(sourceDataSource.parent?.database_id) !== normalizeNotionId(SOURCE_DATABASE_ID)) {
    throw new Error("Pinned old archive database/data-source pairing changed; refusing to import");
  }
  assertPropertyTypes(sourceDataSource, SOURCE_SCHEMA);
  assertWorkerDatabaseReference(worker, "d4", destinationDatabase, {
    expectedParentPageId: worker.frontendPageId,
  });
  assertWorkerDataSourceReference(worker, "d4", destinationDataSource, {
    schema: assertArchiveDataSource,
  });

  const sourceRows = await api.queryAll(SOURCE_DATA_SOURCE_ID, {
    property: "Vor- und Nachname", rich_text: { equals: name },
  });
  if (sourceRows.length === 0) {
    throw new Error(`Old archive has no rows for exact worker "${name}"; check the source name before importing`);
  }
  const destinationRows = await api.queryAll(worker.d4DataSourceId);
  const { entries, excluded } = selectedEntries(sourceRows, name, worker.workerKey);
  const missing = reconcileDestination(entries, destinationRows);
  const requiredOptions = requiredStandortOptions(entries, sourceDataSource);
  return { worker, entries, missing, excluded, requiredOptions };
}

async function runImport(config, operations = {}) {
  const api = {
    createPage, getDataSource, queryAll, updateDataSourceSelect,
    ...operations,
  };
  const plan = await prepareImport(config, api);
  console.log(
    `${plan.worker.name}: ${plan.entries.length} eligible before ${EXCLUSIVE_CUTOFF}; ` +
    `${plan.excluded} excluded on/after cutoff; ${plan.entries.length - plan.missing.length} already copied`,
  );
  if (config.preflightOnly) return plan;

  // The source is never passed to a mutation function. Only this worker's
  // validated D4 data source can receive new options or pages.
  if (plan.missing.length) {
    const destinationDataSource = await api.getDataSource(plan.worker.d4DataSourceId);
    assertWorkerDataSourceReference(plan.worker, "d4", destinationDataSource, {
      schema: assertArchiveDataSource,
    });
    const optionPlan = await api.updateDataSourceSelect({
      dataSourceId: plan.worker.d4DataSourceId,
      dataSource: destinationDataSource,
      propertyName: "Standort",
      desiredOptions: plan.requiredOptions,
      retainExisting: true,
    });
    if (optionPlan.added.length) {
      console.log(`Added ${optionPlan.added.length} missing Standort options to destination D4`);
    }
    const checked = await api.getDataSource(plan.worker.d4DataSourceId);
    assertWorkerDataSourceReference(plan.worker, "d4", checked, {
      schema: assertArchiveDataSource,
    });
    const names = new Set((checked.properties.Standort.select?.options || []).map((option) => option.name));
    if (plan.requiredOptions.some((option) => !names.has(option.name))) {
      throw new Error("Destination Standort options could not be verified; no pages created");
    }
  }

  for (const [index, entry] of plan.missing.entries()) {
    // POST /pages is intentionally not automatically retried. If the response
    // is ambiguous, this run stops and the next manual run re-queries D4.
    await api.createPage(
      { type: "data_source_id", data_source_id: plan.worker.d4DataSourceId },
      importProperties(entry),
    );
    if ((index + 1) % 25 === 0 || index + 1 === plan.missing.length) {
      console.log(`Copied ${index + 1}/${plan.missing.length} remaining historical pages`);
    }
  }
  const finalRows = await api.queryAll(plan.worker.d4DataSourceId);
  if (reconcileDestination(plan.entries, finalRows).length) {
    throw new Error("Destination verification failed: some historical pages are missing");
  }
  console.log(`Verified ${plan.entries.length} exact destination pages; old archive unchanged`);
  return plan;
}

async function main() {
  const { D1_DATA_SOURCE_ID } = requireEnv("NOTION_TOKEN", "D1_DATA_SOURCE_ID");
  const exactName = process.env.IMPORT_WORKER_NAME;
  const destinationId = process.env.IMPORT_DESTINATION_ARCHIVE_ID;
  await runImport({
    exactName,
    destinationId,
    d1DataSourceId: D1_DATA_SOURCE_ID,
    preflightOnly: process.argv.includes("--preflight-only"),
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  EXCLUSIVE_CUTOFF,
  SOURCE_DATABASE_ID,
  SOURCE_DATA_SOURCE_ID,
  archiveRowMatches,
  importProperties,
  prepareImport,
  reconcileDestination,
  requiredStandortOptions,
  runImport,
  selectedEntries,
  selectWorker,
  sourceEntry,
};
