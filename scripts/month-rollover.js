"use strict";

/**
 * Move completed D3 months to the matching worker D4 archive, then prepare
 * D3 for the current Europe/Berlin calendar month. The process is deliberately
 * ordered as an archive transaction:
 *
 *   D3 rows -> D4 + D7 upsert -> both verified -> archive D3 source pages
 *
 * No D3 page is hard-deleted. A retry can always reuse its deterministic D4
 * Sync Key (Worker Key|YYYY-MM-DD) before attempting the next stage.
 */

const {
  archivePage,
  assertPropertyTypes,
  createPage,
  databaseIdFromDataSource,
  date,
  errorMessage,
  getDataSource,
  getPage,
  getView,
  listAllViews,
  queryAll,
  requireEnv,
  richText,
  richTextValue,
  restorePage,
  select,
  title,
  titleValue,
  updateDataSource,
  updatePage,
  updateView,
  writableViewProperties,
} = require("./notion");

const {
  D1_DATA_SOURCE_ID: D1,
  D7_DATA_SOURCE_ID: D7,
  D8_DATA_SOURCE_ID: D8,
} = requireEnv("D1_DATA_SOURCE_ID", "D7_DATA_SOURCE_ID", "D8_DATA_SOURCE_ID");

const { workerStandortOptions } = require("./worker-standort-options");
const {
  planSelectOptionUpdate,
  reconcileSelectOptions,
  updateDataSourceSelect,
} = require("./select-options");
const { updateVacationChartForRollover } = require("./frontend-presentation");
const { ensureArchiveSchema } = require("./archive-presentation");
const { assertDayDataSource } = require("./day-schemas");
const { HOLIDAY_HOURS, augsburgPaidHolidayName } = require("./augsburg-holidays");
const {
  syncWorkerToManagement,
  validateD7DataSource,
} = require("./management-sync");
const { syncD7StandortRelations } = require("./sync-standorte");
const {
  buildRolloverManifest,
  manifestSourceEntries,
  parseRolloverManifest,
} = require("./rollover-manifest");
const {
  D1_WORKER_REFERENCE_SCHEMA,
  assertPageBelongsToWorkerRoute,
  assertUniqueWorkerReferences,
  assertWorkerDataSourceReference,
  missingWorkerReferences,
  normalizeNotionId,
  workerReferencesFromD1,
} = require("./worker-database-references");

const BERLIN_TIME_ZONE = "Europe/Berlin";
const WEEKDAYS = [
  "Sonntag",
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag",
];
const ROLLOVER_STATUSES = ["Ready", "Running", "Error"];

const D1_BASE_SCHEMA = {
  "Vor- und Nachname": "title",
  Active: "checkbox",
  "Onboarding Status": "select",
  "Worker Key": "rich_text",
  ...D1_WORKER_REFERENCE_SCHEMA,
};

const D1_ROLLOVER_SCHEMA = {
  "Current Month": "rich_text",
  "Last Archived Month": "rich_text",
  "Last Rollover At": "date",
  "Rollover Status": "select",
  "Rollover Error": "rich_text",
  "Rollover Manifest": "rich_text",
};

function berlinDateParts(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en", {
    timeZone: BERLIN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function monthKey({ year, month }) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function monthForDate(dateValue) {
  const value = String(dateValue || "");
  if (!validIsoDate(value)) throw new Error(`Invalid or missing calendar date "${dateValue || ""}"`);
  return value.slice(0, 7);
}

function monthDays(targetMonth) {
  if (!/^\d{4}-\d{2}$/.test(targetMonth)) {
    throw new Error(`Invalid month "${targetMonth}"`);
  }

  const [year, month] = targetMonth.split("-").map(Number);
  if (month < 1 || month > 12) throw new Error(`Invalid month "${targetMonth}"`);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return Array.from({ length: days }, (_, index) => {
    const day = index + 1;
    const isoDate = `${targetMonth}-${String(day).padStart(2, "0")}`;
    return {
      isoDate,
      weekday: WEEKDAYS[new Date(`${isoDate}T12:00:00Z`).getUTCDay()],
    };
  });
}

/**
 * A simulated date is accepted only for a GitHub Actions manual dispatch and
 * only when the caller explicitly sets ROLLOVER_SIMULATION=true. Scheduled
 * execution therefore always uses the real Berlin calendar date.
 */
function resolveRunConfiguration(environment = process.env, now = new Date()) {
  const eventName = environment.GITHUB_EVENT_NAME || "";
  const simulationRequested = environment.ROLLOVER_SIMULATION === "true";
  const simulatedDate = (environment.ROLLOVER_SIMULATED_CURRENT_DATE || "").trim();
  const targetWorker = (environment.ROLLOVER_TARGET_WORKER || "").trim();

  if (eventName !== "workflow_dispatch" && (simulationRequested || simulatedDate || targetWorker)) {
    throw new Error("Rollover target and simulation inputs are allowed only for workflow_dispatch.");
  }
  if (simulationRequested && eventName !== "workflow_dispatch") {
    throw new Error("Simulation is allowed only for workflow_dispatch.");
  }
  if (simulatedDate && !simulationRequested) {
    throw new Error("Set ROLLOVER_SIMULATION=true to use ROLLOVER_SIMULATED_CURRENT_DATE.");
  }
  if (simulationRequested && !simulatedDate) {
    throw new Error("Simulation requires ROLLOVER_SIMULATED_CURRENT_DATE (YYYY-MM-DD).");
  }
  if (simulationRequested && !targetWorker) {
    throw new Error("Simulation requires exactly one ROLLOVER_TARGET_WORKER.");
  }
  if (simulatedDate && !validIsoDate(simulatedDate)) {
    throw new Error("ROLLOVER_SIMULATED_CURRENT_DATE must be a real YYYY-MM-DD date.");
  }

  const dateParts = simulatedDate
    ? {
        year: Number(simulatedDate.slice(0, 4)),
        month: Number(simulatedDate.slice(5, 7)),
        day: Number(simulatedDate.slice(8, 10)),
      }
    : berlinDateParts(now);

  return {
    targetMonth: monthKey(dateParts),
    targetWorker,
    simulation: Boolean(simulatedDate),
    liveEnabled: environment.ROLLOVER_LIVE_ENABLED === "true",
  };
}

function rowText(row, propertyName) {
  return richTextValue(row.properties[propertyName]).trim();
}

function dateStart(row) {
  return row.properties.Datum?.date?.start || "";
}

function cloneDateProperty(sourceDate) {
  if (!sourceDate?.start) return { date: null };
  return {
    date: {
      start: sourceDate.start,
      ...(sourceDate.end ? { end: sourceDate.end } : {}),
      ...(sourceDate.time_zone ? { time_zone: sourceDate.time_zone } : {}),
    },
  };
}

function uniqueNames(names) {
  return [...new Set(names.map((name) => String(name || "").trim()).filter(Boolean))];
}

function selectNamesFromRows(rows, propertyName) {
  return uniqueNames(rows.map((row) => row.properties[propertyName]?.select?.name || ""));
}

function workerFromRow(row) {
  return {
    ...workerReferencesFromD1(row),
    active: Boolean(row.properties.Active?.checkbox),
    vacationChartViewId: rowText(row, "Urlaub Chart View ID"),
    rolloverStatus: row.properties["Rollover Status"]?.select?.name || "",
    currentMonth: rowText(row, "Current Month"),
    lastArchivedMonth: rowText(row, "Last Archived Month"),
    rolloverManifest: rowText(row, "Rollover Manifest"),
    onboardingStatus: row.properties["Onboarding Status"]?.select?.name || "",
  };
}

function missingRolloverReferences(worker) {
  return [
    ...missingWorkerReferences(worker),
    ...(worker.currentMonth ? [] : ["Current Month"]),
  ];
}

function validateRolloverRegistry(workers) {
  try {
    return assertUniqueWorkerReferences(workers, {
      reservedDataSources: [
        { id: D1, label: "D1 Data Source ID" },
        { id: D7, label: "D7 Data Source ID" },
        { id: D8, label: "D8 Data Source ID" },
      ],
    });
  } catch (failure) {
    throw new Error(`${errorMessage(failure)}. No rollover data was changed`);
  }
}

async function validateWorkerDataSources(worker) {
  const [d3DataSource, d4DataSource] = await Promise.all([
    getDataSource(worker.d3DataSourceId),
    getDataSource(worker.d4DataSourceId),
  ]);
  assertWorkerDataSourceReference(worker, "d3", d3DataSource, {
    schema: assertDayDataSource,
  });
  assertWorkerDataSourceReference(worker, "d4", d4DataSource, {
    schema: assertDayDataSource,
  });
  return { d3DataSource, d4DataSource };
}

async function ensureD1RolloverSchema() {
  let dataSource = await getDataSource(D1);
  assertPropertyTypes(dataSource, D1_BASE_SCHEMA);

  const additions = {};
  for (const [name, expectedType] of Object.entries(D1_ROLLOVER_SCHEMA)) {
    const property = dataSource.properties?.[name];
    if (property && property.type !== expectedType) {
      throw new Error(`D1 property "${name}" is ${property.type}, expected ${expectedType}`);
    }
    if (!property) {
      additions[name] = expectedType === "date" ? { date: {} } : { [expectedType]: {} };
    }
  }

  const statusOptions = dataSource.properties?.["Rollover Status"]?.select?.options || [];
  const knownStatuses = new Set(statusOptions.map((option) => option.name));
  const missingStatuses = ROLLOVER_STATUSES.filter((status) => !knownStatuses.has(status));
  if (missingStatuses.length > 0) {
    additions["Rollover Status"] = {
      select: {
        options: reconcileSelectOptions(
          statusOptions,
          missingStatuses.map((name) => ({ name, color: name === "Error" ? "red" : "blue" })),
          { retainExisting: true },
        ),
      },
    };
  }

  if (Object.keys(additions).length > 0) {
    await updateDataSource(D1, additions);
    dataSource = await getDataSource(D1);
  }
  assertPropertyTypes(dataSource, { ...D1_BASE_SCHEMA, ...D1_ROLLOVER_SCHEMA });

  const databaseId = databaseIdFromDataSource(dataSource);
  const manifestPropertyId = dataSource.properties["Rollover Manifest"].id;
  const references = await listAllViews(databaseId);
  const views = await Promise.all(references.map((reference) => getView(reference.id)));
  for (const view of views.filter(
    (candidate) =>
      normalizeNotionId(candidate.data_source_id) === normalizeNotionId(D1) &&
      candidate.type === "table",
  )) {
    const existing = writableViewProperties(
      dataSource,
      view.configuration?.properties || [],
    );
    const seen = existing.some((entry) => entry.property_id === manifestPropertyId);
    const properties = existing.map((entry) =>
      entry.property_id === manifestPropertyId ? { ...entry, visible: false } : entry,
    );
    if (!seen) properties.push({ property_id: manifestPropertyId, visible: false });
    await updateView(view.id, {
      configuration: {
        type: "table",
        properties,
      },
    });
  }
}

async function activeStandorte() {
  const rows = await queryAll(D8, {
    property: "Active",
    checkbox: { equals: true },
  });
  return uniqueNames(rows.map((row) => titleValue(row.properties.Standort)));
}

/** Add values without omitting existing options: D4 is historical and immutable. */
function historyStandortAdditions(existingOptions, names) {
  const requestedNames = uniqueNames(names);
  const desiredByName = new Map(
    workerStandortOptions(requestedNames).map((option) => [option.name, option]),
  );
  const desired = requestedNames.map(
    (name) => desiredByName.get(name) || { name, color: "blue" },
  );
  const plan = planSelectOptionUpdate(existingOptions, desired, { retainExisting: true });
  const addedNames = new Set(plan.added);
  return desired.filter((option) => addedNames.has(option.name));
}

async function addSelectOptions(dataSourceId, dataSource, propertyName, names) {
  const additions = historyStandortAdditions([], names);
  const plan = await updateDataSourceSelect({
    dataSourceId,
    dataSource,
    propertyName,
    desiredOptions: additions,
    retainExisting: true,
  });
  return plan.added.length;
}

/**
 * D3 is intentionally different: by this point old D3 rows are archived, so
 * the select list can become exactly the current active D8 list plus the
 * standard work choices. D4 and D7 are never passed through this replacement
 * function.
 */
async function rebuildD3StandortOptions(dataSourceId, activeNames, currentRows) {
  const desiredOptions = workerStandortOptions(activeNames);
  const selectedNames = selectNamesFromRows(currentRows, "Standort");
  const dataSource = await getDataSource(dataSourceId);
  try {
    planSelectOptionUpdate(
      dataSource.properties?.Standort?.select?.options || [],
      desiredOptions,
      { protectedNames: selectedNames },
    );
  } catch (failure) {
    if (!failure.message.startsWith("Cannot remove Select option(s)")) throw failure;
    const desiredNames = new Set(desiredOptions.map((option) => option.name));
    const selectedInactive = selectedNames.filter((name) => !desiredNames.has(name));
    throw new Error(
      `D3 contains current-month Standort value(s) outside active D8 sites and the standard work choices: ${selectedInactive.join(", ")}. ` +
        "Resolve those current-month entries before pruning D3 options.",
    );
  }
  await updateDataSourceSelect({
    dataSourceId,
    dataSource,
    propertyName: "Standort",
    desiredOptions,
    protectedNames: selectedNames,
  });
}

function validateD3Rows(rows, worker, targetMonth) {
  const dates = new Set();
  const normalized = [];
  for (const row of rows) {
    const dateProperty = row.properties.Datum?.date;
    if (dateProperty?.end || dateProperty?.time_zone) {
      throw new Error(
        `${worker.name}: D3 page ${row.id} must use one date without a time or date range`,
      );
    }
    const sourceDate = dateStart(row);
    const sourceMonth = monthForDate(sourceDate);
    if (dates.has(sourceDate)) {
      throw new Error(`${worker.name}: D3 has more than one row for ${sourceDate}`);
    }
    if (sourceMonth > targetMonth) {
      throw new Error(
        `${worker.name}: D3 contains future month ${sourceMonth}; refusing to archive or hide it while target is ${targetMonth}`,
      );
    }
    dates.add(sourceDate);
    normalized.push({ row, sourceDate, sourceMonth });
  }
  return normalized;
}

function archiveProperties(worker, sourceRow) {
  const properties = sourceRow.properties;
  const sourceDate = dateStart(sourceRow);
  const syncKey = `${worker.workerKey}|${sourceDate}`;
  return {
    syncKey,
    properties: {
      Wochentag: title(titleValue(properties.Wochentag)),
      Datum: cloneDateProperty(properties.Datum?.date),
      Stunden: { number: properties.Stunden?.number ?? null },
      Standort: select(properties.Standort?.select?.name || ""),
      "Sync Key": richText(syncKey),
    },
  };
}

function d4RowsByKeyAndDate(rows) {
  const byKey = new Map();
  const byDate = new Map();

  for (const row of rows) {
    const syncKey = rowText(row, "Sync Key");
    const rowDate = dateStart(row);
    if (syncKey) {
      if (byKey.has(syncKey)) throw new Error(`D4 has duplicate Sync Key ${syncKey}`);
      byKey.set(syncKey, row);
    }
    if (rowDate) {
      const collection = byDate.get(rowDate) || [];
      collection.push(row);
      byDate.set(rowDate, collection);
    }
  }
  return { byKey, byDate };
}

function dayValuesMatch(actualRow, expectedRow) {
  const expectedDate = expectedRow.properties.Datum?.date || null;
  const actualDate = actualRow.properties.Datum?.date || null;
  return (
    titleValue(actualRow.properties.Wochentag) === titleValue(expectedRow.properties.Wochentag) &&
    (actualDate?.start || "") === (expectedDate?.start || "") &&
    (actualDate?.end || null) === (expectedDate?.end || null) &&
    (actualDate?.time_zone || null) === (expectedDate?.time_zone || null) &&
    (actualRow.properties.Stunden?.number ?? null) === (expectedRow.properties.Stunden?.number ?? null) &&
    (actualRow.properties.Standort?.select?.name || "") ===
      (expectedRow.properties.Standort?.select?.name || "")
  );
}

function archiveValuesMatch(archiveRow, worker, sourceRow) {
  const expected = archiveProperties(worker, sourceRow);
  return rowText(archiveRow, "Sync Key") === expected.syncKey && dayValuesMatch(archiveRow, sourceRow);
}

function archiveSourceMonth(sourceEntries, expectedSourceMonth) {
  const sourceMonth = expectedSourceMonth || sourceEntries[0]?.sourceMonth || "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(sourceMonth || "")) {
    throw new Error(`Invalid D3 source month "${sourceMonth || ""}"`);
  }
  if (sourceEntries.some((entry) => entry.sourceMonth !== sourceMonth)) {
    throw new Error("A D4 archive transaction may contain only one D3 source month");
  }
  return sourceMonth;
}

/**
 * Each D4 is private to one worker. If either Datum or Sync Key points at the
 * source month, both must prove the same worker/date; blank or foreign keys are
 * contamination and fail closed instead of being hidden from exact checks.
 */
function scopedD4Identity(row, worker, sourceMonth) {
  const syncKey = rowText(row, "Sync Key");
  const prefix = `${worker.workerKey}|`;
  const rowDate = dateStart(row);
  const hasWorkerPrefix = syncKey.startsWith(prefix);
  const keyDate = hasWorkerPrefix ? syncKey.slice(prefix.length) : "";
  const keyIsValid = hasWorkerPrefix && validIsoDate(keyDate);
  const keyInSourceMonth = keyIsValid && keyDate.slice(0, 7) === sourceMonth;
  const rowInSourceMonth = validIsoDate(rowDate) && rowDate.slice(0, 7) === sourceMonth;

  if (hasWorkerPrefix && !keyIsValid) {
    throw new Error(
      `${worker.name}: D4 row ${row.id} has an invalid Sync Key; refusing automatic cleanup`,
    );
  }
  if (keyInSourceMonth || rowInSourceMonth) {
    if (!keyInSourceMonth || !rowInSourceMonth || keyDate !== rowDate) {
      throw new Error(
        `${worker.name}: D4 row ${row.id} has conflicting or foreign Sync Key/Datum ownership; ` +
          "refusing automatic cleanup",
      );
    }
    return { row, syncKey, keyDate, rowDate };
  }
  if (hasWorkerPrefix && keyDate !== rowDate) {
    throw new Error(
      `${worker.name}: D4 row ${row.id} has conflicting Sync Key/Datum ownership; ` +
        "refusing automatic cleanup",
    );
  }
  return null;
}

/**
 * Find only stale rows that can be proven to belong to the worker/month being
 * retried. This repairs a failed rollover after a D3 date edit or deletion
 * without touching another worker's or another month's archive history.
 */
function staleD4Rows(worker, sourceMonth, sourceEntries, archiveRows) {
  archiveSourceMonth(sourceEntries, sourceMonth);
  const expectedPairs = new Set(
    sourceEntries.map((entry) => `${worker.workerKey}|${entry.sourceDate}\u0000${entry.sourceDate}`),
  );

  return archiveRows
    .map((row) => scopedD4Identity(row, worker, sourceMonth))
    .filter(Boolean)
    .filter((identity) => !expectedPairs.has(`${identity.syncKey}\u0000${identity.rowDate}`))
    .map((identity) => identity.row);
}

/** Exact D4 barrier for the one worker/month currently being archived. */
function verifyD4ExactMonth(worker, sourceMonth, sourceEntries, archiveRows) {
  archiveSourceMonth(sourceEntries, sourceMonth);
  const scopedRows = archiveRows
    .map((row) => scopedD4Identity(row, worker, sourceMonth))
    .filter(Boolean)
    .map((identity) => identity.row);
  const expectedKeys = new Set(
    sourceEntries.map((entry) => `${worker.workerKey}|${entry.sourceDate}`),
  );

  if (expectedKeys.size !== sourceEntries.length) {
    throw new Error(`${worker.name}: D3 has duplicate dates in ${sourceMonth}`);
  }
  if (scopedRows.length !== sourceEntries.length) {
    throw new Error(
      `${worker.name}: D4 exact-set verification failed for ${sourceMonth}; ` +
        `expected ${sourceEntries.length} row(s), found ${scopedRows.length}. D3 remains unchanged`,
    );
  }

  const verifiedIndex = d4RowsByKeyAndDate(scopedRows);
  for (const entry of sourceEntries) {
    const expectedKey = `${worker.workerKey}|${entry.sourceDate}`;
    const archiveRow = verifiedIndex.byKey.get(expectedKey);
    if (!archiveRow || !archiveValuesMatch(archiveRow, worker, entry.row)) {
      throw new Error(`${worker.name}: D4 verification failed for ${expectedKey}; D3 remains unchanged`);
    }
  }
  return true;
}

function sourceSnapshotMatches(sourceEntries, freshRows, expectedSourceMonth) {
  const sourceMonth = archiveSourceMonth(sourceEntries, expectedSourceMonth);
  const expectedIds = new Set(sourceEntries.map((entry) => entry.row.id));
  const freshMonthRows = freshRows.filter((row) => monthForDate(dateStart(row)) === sourceMonth);
  if (freshMonthRows.length !== expectedIds.size) return false;
  const freshById = new Map(freshRows.map((row) => [row.id, row]));
  return sourceEntries.every((entry) => {
    const fresh = freshById.get(entry.row.id);
    return Boolean(fresh && dayValuesMatch(fresh, entry.row));
  });
}

function completedSourceMonths(
  entries,
  currentMonth,
  targetMonth,
  workerName = "Worker",
  lastArchivedMonth = "",
) {
  if (lastArchivedMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(lastArchivedMonth)) {
    throw new Error(`${workerName}: D1 Last Archived Month is invalid: "${lastArchivedMonth}"`);
  }
  const oldMonthSet = new Set(
    entries.filter((entry) => entry.sourceMonth < targetMonth).map((entry) => entry.sourceMonth),
  );
  if (currentMonth) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(currentMonth)) {
      throw new Error(`${workerName}: D1 Current Month is invalid: "${currentMonth}"`);
    }
    if (currentMonth > targetMonth) {
      throw new Error(
        `${workerName}: D1 Current Month ${currentMonth} is later than rollover target ${targetMonth}`,
      );
    }
    if (currentMonth < targetMonth) oldMonthSet.add(currentMonth);
  }
  return [...oldMonthSet]
    .filter((month) => !lastArchivedMonth || month > lastArchivedMonth)
    .sort();
}

async function reconcileWorkerD8Relations(worker) {
  const related = await syncD7StandortRelations(
    { property: "Worker Key", rich_text: { equals: worker.workerKey } },
    { verify: true },
  );
  console.log(`${worker.name}: D8 relation barrier verified (${related} D7 relation(s) updated).`);
}

async function verifyManifestBarriers(worker, manifest) {
  const sourceEntries = manifestSourceEntries(manifest);
  await ensureArchiveSchema(worker.d4DataSourceId);
  verifyD4ExactMonth(
    worker,
    manifest.sourceMonth,
    sourceEntries,
    await queryAll(worker.d4DataSourceId),
  );
  const d7Result = await syncWorkerToManagement(
    { ...worker, currentMonth: manifest.sourceMonth },
    sourceEntries.map((entry) => entry.row),
    D7,
    { reconcileMissing: true, verify: true, fullScan: true },
  );
  console.log(
    `${worker.name}: resumed D7 barrier (${d7Result.created} created, ` +
      `${d7Result.updated} updated, ${d7Result.archived} stale removed, ` +
      `${d7Result.unchanged} unchanged).`,
  );
  await reconcileWorkerD8Relations(worker);
  return sourceEntries;
}

async function rollbackManifestSourcePages(worker, sourceEntries, reason) {
  const failures = [];
  for (const entry of sourceEntries) {
    try {
      const page = await getPage(entry.row.id);
      if (page.in_trash) await restorePage(entry.row.id);
    } catch (failure) {
      failures.push(`${entry.row.id}: ${errorMessage(failure)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `${reason} Automatic source restore was incomplete (${failures.join(" | ")}); ` +
        "the Rollover Manifest was kept for a safe retry.",
    );
  }
  await setWorkerState(worker, { "Rollover Manifest": richText("") });
  throw new Error(
    `${reason} Any source pages already archived by this transaction were restored; run rollover again.`,
  );
}

async function archiveManifestSourcePages(worker, manifest, targetMonth) {
  const sourceEntries = manifestSourceEntries(manifest);
  const expectedById = new Map(sourceEntries.map((entry) => [entry.row.id, entry]));
  const visibleRows = await queryAll(worker.d3DataSourceId);
  const visibleEntries = validateD3Rows(visibleRows, worker, targetMonth)
    .filter((entry) => entry.sourceMonth === manifest.sourceMonth);
  const visibleById = new Map(visibleEntries.map((entry) => [entry.row.id, entry]));

  let driftReason = "";
  for (const visible of visibleEntries) {
    const expected = expectedById.get(visible.row.id);
    if (!expected || !dayValuesMatch(visible.row, expected.row)) {
      driftReason = `${worker.name}: D3 changed after its ${manifest.sourceMonth} archive checkpoint.`;
      break;
    }
  }

  if (!driftReason) {
    for (const entry of sourceEntries) {
      const page = await getPage(entry.row.id);
      assertManifestPageParent(worker, page);
      if (!dayValuesMatch(page, entry.row)) {
        driftReason = `${worker.name}: D3 page ${entry.row.id} changed after its archive checkpoint.`;
        break;
      }
      if (page.in_trash === visibleById.has(entry.row.id)) {
        driftReason = `${worker.name}: D3 page ${entry.row.id} has an inconsistent archive state.`;
        break;
      }
    }
  }

  if (driftReason) {
    await rollbackManifestSourcePages(worker, sourceEntries, driftReason);
  }

  for (const entry of sourceEntries) {
    const lastRead = await getPage(entry.row.id);
    assertManifestPageParent(worker, lastRead);
    if (lastRead.in_trash) continue;
    if (!dayValuesMatch(lastRead, entry.row)) {
      await rollbackManifestSourcePages(
        worker,
        sourceEntries,
        `${worker.name}: D3 changed immediately before archival for ${entry.sourceDate}.`,
      );
    }
    await archivePage(entry.row.id);
    const archivedRead = await getPage(entry.row.id);
    assertManifestPageParent(worker, archivedRead);
    if (!archivedRead.in_trash || !dayValuesMatch(archivedRead, entry.row)) {
      await rollbackManifestSourcePages(
        worker,
        sourceEntries,
        `${worker.name}: D3 changed during archival for ${entry.sourceDate}.`,
      );
    }
  }

  const remainingRows = await queryAll(worker.d3DataSourceId);
  const remainingEntries = validateD3Rows(remainingRows, worker, targetMonth);
  if (remainingEntries.some((entry) => entry.sourceMonth === manifest.sourceMonth)) {
    await rollbackManifestSourcePages(
      worker,
      sourceEntries,
      `${worker.name}: D3 gained or retained a ${manifest.sourceMonth} row during archival.`,
    );
  }
}

function assertManifestPageParent(worker, page) {
  try {
    return assertPageBelongsToWorkerRoute(page, worker, "d3", {
      description: "checkpoint page",
    });
  } catch (failure) {
    throw new Error(`${errorMessage(failure)}; refusing rollover resume`);
  }
}

async function archiveMonth(worker, sourceMonth, sourceEntries, targetMonth) {
  archiveSourceMonth(sourceEntries, sourceMonth);
  const d4DataSource = await ensureArchiveSchema(worker.d4DataSourceId);
  // D4 must be able to retain all historical values before a page write.
  await addSelectOptions(
    worker.d4DataSourceId,
    d4DataSource,
    "Standort",
    selectNamesFromRows(sourceEntries.map((entry) => entry.row), "Standort"),
  );
  const initialArchiveRows = await queryAll(worker.d4DataSourceId);
  const staleRows = staleD4Rows(worker, sourceMonth, sourceEntries, initialArchiveRows);
  for (const staleRow of staleRows) await archivePage(staleRow.id);
  if (staleRows.length > 0) {
    console.log(
      `${worker.name}: removed ${staleRows.length} stale ${sourceMonth} D4 row(s) from a prior rollover attempt.`,
    );
  }
  const staleIds = new Set(staleRows.map((row) => row.id));
  const index = d4RowsByKeyAndDate(initialArchiveRows.filter((row) => !staleIds.has(row.id)));

  for (const entry of sourceEntries) {
    const built = archiveProperties(worker, entry.row);
    const keyed = index.byKey.get(built.syncKey);
    const sameDate = index.byDate.get(entry.sourceDate) || [];

    if (sameDate.length > 1) {
      throw new Error(`${worker.name}: D4 has multiple rows for ${entry.sourceDate}; refusing an ambiguous archive upsert`);
    }
    let target = keyed;
    if (target && dateStart(target) !== entry.sourceDate) {
      throw new Error(`${worker.name}: D4 Sync Key ${built.syncKey} points to a different date`);
    }
    if (!target && sameDate.length === 1) {
      const existingKey = rowText(sameDate[0], "Sync Key");
      if (existingKey && existingKey !== built.syncKey) {
        throw new Error(`${worker.name}: D4 date ${entry.sourceDate} belongs to a different Sync Key`);
      }
      target = sameDate[0];
    }

    if (target) {
      await updatePage(target.id, built.properties);
    } else {
      target = await createPage(
        { type: "data_source_id", data_source_id: worker.d4DataSourceId },
        built.properties,
      );
      index.byKey.set(built.syncKey, target);
      index.byDate.set(entry.sourceDate, [target]);
    }
  }

  // Fresh query is the archive barrier. Never touch D3 before every source
  // page has exactly one verified, value-identical D4 row and no stale row
  // remains for this worker/source month.
  const verifiedRows = await queryAll(worker.d4DataSourceId);
  verifyD4ExactMonth(worker, sourceMonth, sourceEntries, verifiedRows);

  // D7 drives management reporting and D8 rollups. It is part of the same
  // safety barrier as D4 so late month-end edits cannot disappear when D3 is
  // archived. The shared upsert matches Source Page ID before the date key.
  const d7Result = await syncWorkerToManagement(
    { ...worker, currentMonth: sourceMonth },
    sourceEntries.map((entry) => entry.row),
    D7,
    { reconcileMissing: true, verify: true, fullScan: true },
  );
  console.log(
    `${worker.name}: D7 barrier verified (${d7Result.created} created, ` +
      `${d7Result.updated} updated, ${d7Result.archived} stale removed, ` +
      `${d7Result.unchanged} unchanged).`,
  );
  await reconcileWorkerD8Relations(worker);

  // A worker can still edit Notion while the workflow is running. Re-read D3
  // immediately before archival and abort if the verified snapshot drifted.
  const freshSourceRows = await queryAll(worker.d3DataSourceId);
  if (!sourceSnapshotMatches(sourceEntries, freshSourceRows, sourceMonth)) {
    throw new Error(
      `${worker.name}: D3 changed during rollover; ` +
        "the verified D4/D7 snapshot was not archived. Run rollover again.",
    );
  }

  // Persist the exact verified source set before the first D3 page is moved to
  // trash. If the runner stops halfway through, a retry resumes this manifest
  // instead of mistaking already-archived pages for worker deletions.
  const manifest = buildRolloverManifest(worker, sourceMonth, sourceEntries);
  await setWorkerState(worker, {
    "Rollover Status": select("Running"),
    "Rollover Error": richText(""),
    "Rollover Manifest": richText(JSON.stringify(manifest)),
  });
  await archiveManifestSourcePages(worker, manifest, targetMonth);

  // Re-run all management barriers after D3 is in trash. This closes the
  // final gap before the durable checkpoint is cleared: any D4/D7/D8 drift or
  // partial API result restores the source pages and leaves history retryable.
  try {
    await verifyManifestBarriers(worker, manifest);
  } catch (failure) {
    await rollbackManifestSourcePages(
      worker,
      manifestSourceEntries(manifest),
      `${worker.name}: post-archive D4/D7/D8 verification failed: ${errorMessage(failure)}.`,
    );
  }

  const remainingD3Rows = await queryAll(worker.d3DataSourceId);
  const remainingCompleted = remainingD3Rows.filter(
    (row) => monthForDate(dateStart(row)) <= sourceMonth,
  );
  const stillVisible = remainingD3Rows.filter((row) => sourceEntries.some((entry) => entry.row.id === row.id));
  if (stillVisible.length > 0 || remainingCompleted.length > 0) {
    await rollbackManifestSourcePages(
      worker,
      manifestSourceEntries(manifest),
      `${worker.name}: D3 archive verification found a retained or newly-added completed row.`,
    );
  }
}

async function ensureCurrentMonthRows(worker, targetMonth, currentRows) {
  const existingDates = new Set(currentRows.map((row) => dateStart(row)));
  let created = 0;
  for (const { isoDate, weekday } of monthDays(targetMonth)) {
    if (existingDates.has(isoDate)) continue;
    const holiday = augsburgPaidHolidayName(isoDate);
    await createPage(
      { type: "data_source_id", data_source_id: worker.d3DataSourceId },
      {
        Wochentag: title(weekday),
        Datum: date(isoDate),
        ...(holiday ? { Standort: select("Feiertag"), Stunden: { number: HOLIDAY_HOURS } } : {}),
      },
    );
    created += 1;
  }
  return created;
}

async function setWorkerState(worker, properties) {
  await updatePage(worker.rowId, properties);
}

async function markWorkerError(worker, failure) {
  await setWorkerState(worker, {
    "Rollover Status": select("Error"),
    "Rollover Error": richText(errorMessage(failure).slice(0, 1900)),
  });
}

async function rolloverWorker(worker, run) {
  await setWorkerState(worker, {
    "Rollover Status": select("Running"),
    "Rollover Error": richText(""),
  });

  let lastArchivedMonth = worker.lastArchivedMonth;
  let resumedManifest = false;
  const pendingManifest = parseRolloverManifest(worker.rolloverManifest, worker);
  if (pendingManifest) {
    if (pendingManifest.sourceMonth >= run.targetMonth) {
      throw new Error(
        `${worker.name}: pending Rollover Manifest month ${pendingManifest.sourceMonth} ` +
          `is not before target ${run.targetMonth}`,
      );
    }
    if (lastArchivedMonth && pendingManifest.sourceMonth <= lastArchivedMonth) {
      throw new Error(
        `${worker.name}: Rollover Manifest ${pendingManifest.sourceMonth} conflicts with ` +
          `Last Archived Month ${lastArchivedMonth}`,
      );
    }
    console.log(
      `${worker.name}: resuming verified ${pendingManifest.sourceMonth} archive checkpoint ` +
        `(${pendingManifest.days.length} D3 row(s)).`,
    );
    await verifyManifestBarriers(worker, pendingManifest);
    await archiveManifestSourcePages(worker, pendingManifest, run.targetMonth);
    try {
      await verifyManifestBarriers(worker, pendingManifest);
    } catch (failure) {
      await rollbackManifestSourcePages(
        worker,
        manifestSourceEntries(pendingManifest),
        `${worker.name}: post-archive D4/D7/D8 verification failed: ${errorMessage(failure)}.`,
      );
    }
    lastArchivedMonth = pendingManifest.sourceMonth;
    resumedManifest = true;
    await setWorkerState(worker, {
      "Rollover Status": select("Running"),
      "Current Month": richText(run.targetMonth),
      "Last Archived Month": richText(lastArchivedMonth),
      "Rollover Manifest": richText(""),
      "Rollover Error": richText(""),
    });
  }

  let d3Rows = await queryAll(worker.d3DataSourceId);
  const entries = validateD3Rows(d3Rows, worker, run.targetMonth);
  const oldMonths = completedSourceMonths(
    entries,
    worker.currentMonth,
    run.targetMonth,
    worker.name,
    lastArchivedMonth,
  );

  for (const sourceMonth of oldMonths) {
    const sourceEntries = entries.filter((entry) => entry.sourceMonth === sourceMonth);
    console.log(`${worker.name}: archiving ${sourceEntries.length} D3 row(s) for ${sourceMonth}.`);
    await archiveMonth(worker, sourceMonth, sourceEntries, run.targetMonth);
    lastArchivedMonth = sourceMonth;
    await setWorkerState(worker, {
      "Rollover Status": select("Running"),
      "Current Month": richText(run.targetMonth),
      "Last Archived Month": richText(sourceMonth),
      "Rollover Manifest": richText(""),
      "Rollover Error": richText(""),
    });
  }

  d3Rows = await queryAll(worker.d3DataSourceId);
  const remaining = validateD3Rows(d3Rows, worker, run.targetMonth);
  if (remaining.some((entry) => entry.sourceMonth !== run.targetMonth)) {
    throw new Error(`${worker.name}: D3 still contains a completed month after archival`);
  }

  // Rebuild only after an archive stage (or resume an interrupted rollover).
  // Normal daily checks leave a current D3 schema untouched.
  if (
    resumedManifest ||
    oldMonths.length > 0 ||
    (worker.rolloverStatus === "Running" && worker.currentMonth !== run.targetMonth)
  ) {
    await rebuildD3StandortOptions(
      worker.d3DataSourceId,
      await activeStandorte(),
      remaining.map((entry) => entry.row),
    );
  }

  const created = worker.active
    ? await ensureCurrentMonthRows(worker, run.targetMonth, remaining.map((entry) => entry.row))
    : 0;
  const changed = resumedManifest || oldMonths.length > 0 || created > 0;

  // A chart is presentation only: a manually deleted/stale chart reference
  // must not block a completed archive transaction or D3 month generation.
  if (worker.vacationChartViewId) {
    try {
      const refreshed = await updateVacationChartForRollover(
        worker.vacationChartViewId,
        worker.d4DataSourceId,
        run.targetMonth,
      );
      if (refreshed) console.log(`${worker.name}: Urlaub chart calendar year refreshed.`);
    } catch (chartFailure) {
      console.warn(`${worker.name}: Urlaub chart was not refreshed: ${errorMessage(chartFailure)}`);
    }
  }

  await setWorkerState(worker, {
    "Current Month": richText(run.targetMonth),
    ...(lastArchivedMonth ? { "Last Archived Month": richText(lastArchivedMonth) } : {}),
    ...(changed ? { "Last Rollover At": date(new Date().toISOString()) } : {}),
    "Rollover Status": select("Ready"),
    "Rollover Error": richText(""),
    "Rollover Manifest": richText(""),
  });
  console.log(
    `${worker.name}: ${oldMonths.length ? `${oldMonths.join(", ")} archived; ` : ""}` +
      `${created} ${run.targetMonth} D3 row(s) created${worker.active ? "" : " (inactive: no new rows)"}.`,
  );
}

function selectWorkers(rows, run) {
  const allWorkers = rows.map(workerFromRow);
  const readyWorkers = allWorkers.filter((worker) => worker.onboardingStatus === "Ready");
  if (!run.targetWorker) return readyWorkers;

  const matches = allWorkers.filter(
    (worker) => worker.workerKey === run.targetWorker || worker.name === run.targetWorker,
  );
  if (matches.length !== 1) {
    const candidates = readyWorkers.map((worker) => worker.name).join(", ") || "(none)";
    throw new Error(
      `ROLLOVER_TARGET_WORKER must match exactly one worker key or name; found ${matches.length} matches. ` +
        `Valid rollover candidates: ${candidates}.`,
    );
  }
  if (matches[0].onboardingStatus !== "Ready") {
    throw new Error(
      `${matches[0].name} is not a safe rollover target because Onboarding Status is ` +
        `${matches[0].onboardingStatus || "blank"}, not Ready. No D3 or D4 data was changed.`,
    );
  }
  return matches;
}

async function preflightWorkers(workers, run) {
  const failures = [];

  for (const worker of workers) {
    try {
      const missing = missingRolloverReferences(worker);
      if (missing.length > 0) {
        throw new Error(`${worker.name} is Ready but D1 is missing: ${missing.join(", ")}`);
      }
      completedSourceMonths(
        [],
        worker.currentMonth,
        run.targetMonth,
        worker.name,
        worker.lastArchivedMonth,
      );
      const manifest = parseRolloverManifest(worker.rolloverManifest, worker);
      if (manifest && manifest.sourceMonth >= run.targetMonth) {
        throw new Error(
          `${worker.name}: Rollover Manifest month ${manifest.sourceMonth} is not before ` +
            `target ${run.targetMonth}`,
        );
      }
      await validateWorkerDataSources(worker);
    } catch (failure) {
      failures.push({ worker, failure });
    }
  }

  if (failures.length === 0) return;
  const messages = [];
  for (const { worker, failure } of failures) {
    const message = errorMessage(failure);
    try {
      await markWorkerError(worker, failure);
      messages.push(`${worker.name}: ${message}`);
    } catch (markFailure) {
      messages.push(
        `${worker.name}: ${message}; could not mark D1 Error: ${errorMessage(markFailure)}`,
      );
    }
  }
  throw new Error(
    `${failures.length} rollover preflight failure(s); no D3/D4/D7 rows were changed: ` +
      messages.join(" | "),
  );
}

async function main() {
  const run = resolveRunConfiguration();
  // The first POC rollover must be a deliberate, one-worker simulation. Keep
  // scheduled (and accidental broad manual) runs non-mutating until management
  // enables live rollover after that validation.
  if (!run.simulation && !run.liveEnabled) {
    console.log(
      "Live rollover is disabled. Set the ROLLOVER_LIVE_ENABLED repository secret to true after the controlled simulation succeeds.",
    );
    return;
  }
  await ensureD1RolloverSchema();
  validateD7DataSource(await getDataSource(D7));
  const rows = await queryAll(D1);
  // Validate the complete registry before narrowing a one-worker simulation.
  // A target must never reuse a D3/D4 store owned by an out-of-scope or
  // not-yet-Ready row, including cross-role D3↔D4 reuse.
  validateRolloverRegistry(rows.map(workerFromRow));
  const workers = selectWorkers(rows, run);
  await preflightWorkers(workers, run);
  console.log(
    `${run.simulation ? "SIMULATION" : "LIVE Berlin calendar"}: ${run.targetMonth}; ${workers.length} worker(s) in scope.`,
  );

  const failures = [];
  for (const worker of workers) {
    try {
      await rolloverWorker(worker, run);
    } catch (failure) {
      console.error(`${worker.name}: ${errorMessage(failure)}`);
      try {
        await markWorkerError(worker, failure);
      } catch (markFailure) {
        failures.push(
          `${worker.name}: ${errorMessage(failure)}; could not mark D1 Error: ${errorMessage(markFailure)}`,
        );
        continue;
      }
      failures.push(`${worker.name}: ${errorMessage(failure)}`);
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length} rollover failure(s): ${failures.join(" | ")}`);
}

if (require.main === module) {
  main().catch((failure) => {
    console.error(errorMessage(failure));
    process.exitCode = 1;
  });
}

module.exports = {
  archiveProperties,
  berlinDateParts,
  buildRolloverManifest,
  completedSourceMonths,
  historyStandortAdditions,
  manifestSourceEntries,
  monthDays,
  monthForDate,
  parseRolloverManifest,
  resolveRunConfiguration,
  sourceSnapshotMatches,
  staleD4Rows,
  validateRolloverRegistry,
  validIsoDate,
  verifyD4ExactMonth,
};
