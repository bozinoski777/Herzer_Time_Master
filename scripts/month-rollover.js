"use strict";

/**
 * Move completed D3 months to the matching worker D4 archive, then prepare
 * D3 for the current Europe/Berlin calendar month. The process is deliberately
 * ordered as an archive transaction:
 *
 *   D3 rows -> D4 upsert -> D4 verification -> archive D3 source pages
 *
 * No D3 page is hard-deleted. A retry can always reuse its deterministic D4
 * Sync Key (Worker Key|YYYY-MM-DD) before attempting the next stage.
 */

const {
  archivePage,
  assertPropertyTypes,
  createPage,
  date,
  errorMessage,
  getDataSource,
  queryAll,
  requireEnv,
  richText,
  richTextValue,
  select,
  title,
  titleValue,
  updateDataSource,
  updatePage,
} = require("./notion");

const {
  D1_DATA_SOURCE_ID: D1,
  D8_DATA_SOURCE_ID: D8,
} = requireEnv("D1_DATA_SOURCE_ID", "D8_DATA_SOURCE_ID");

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
  "Worker Key": "rich_text",
  "D3 Data Source ID": "rich_text",
  "D4 Data Source ID": "rich_text",
};

const D1_ROLLOVER_SCHEMA = {
  "Current Month": "rich_text",
  "Last Archived Month": "rich_text",
  "Last Rollover At": "date",
  "Rollover Status": "select",
  "Rollover Error": "rich_text",
};

const DAY_SCHEMA = {
  Wochentag: "title",
  Datum: "date",
  Stunden: "number",
  Tagtyp: "select",
  Standort: "select",
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
  const value = String(dateValue || "").slice(0, 10);
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

function optionDefinitions(options) {
  return options.map((option) => ({
    ...(option.id ? { id: option.id } : {}),
    name: option.name,
    ...(option.color ? { color: option.color } : {}),
  }));
}

function uniqueNames(names) {
  return [...new Set(names.map((name) => String(name || "").trim()).filter(Boolean))];
}

function selectNamesFromRows(rows, propertyName) {
  return uniqueNames(rows.map((row) => row.properties[propertyName]?.select?.name || ""));
}

function workerFromRow(row) {
  return {
    row,
    rowId: row.id,
    name: titleValue(row.properties["Vor- und Nachname"]).trim() || row.id,
    workerKey: rowText(row, "Worker Key"),
    active: Boolean(row.properties.Active?.checkbox),
    d3DataSourceId: rowText(row, "D3 Data Source ID"),
    d4DataSourceId: rowText(row, "D4 Data Source ID"),
    rolloverStatus: row.properties["Rollover Status"]?.select?.name || "",
    currentMonth: rowText(row, "Current Month"),
  };
}

function hasCompleteRolloverReferences(worker) {
  return Boolean(worker.workerKey && worker.d3DataSourceId && worker.d4DataSourceId);
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
        options: [
          ...optionDefinitions(statusOptions),
          ...missingStatuses.map((name) => ({ name, color: name === "Error" ? "red" : "blue" })),
        ],
      },
    };
  }

  if (Object.keys(additions).length > 0) {
    await updateDataSource(D1, additions);
    dataSource = await getDataSource(D1);
  }
  assertPropertyTypes(dataSource, { ...D1_BASE_SCHEMA, ...D1_ROLLOVER_SCHEMA });
}

async function ensureD4Schema(dataSourceId) {
  let dataSource = await getDataSource(dataSourceId);
  assertPropertyTypes(dataSource, DAY_SCHEMA);
  const syncKey = dataSource.properties?.["Sync Key"];

  if (syncKey && syncKey.type !== "rich_text") {
    throw new Error(`D4 ${dataSourceId} property "Sync Key" is ${syncKey.type}, expected rich_text`);
  }
  if (!syncKey) {
    await updateDataSource(dataSourceId, { "Sync Key": { rich_text: {} } });
    dataSource = await getDataSource(dataSourceId);
  }
  assertPropertyTypes(dataSource, { ...DAY_SCHEMA, "Sync Key": "rich_text" });
  return dataSource;
}

async function activeStandorte() {
  const rows = await queryAll(D8, {
    property: "Active",
    checkbox: { equals: true },
  });
  return uniqueNames(rows.map((row) => titleValue(row.properties.Standort)));
}

/** Add values without omitting existing options: D4 is historical and immutable. */
async function addSelectOptions(dataSourceId, dataSource, propertyName, names) {
  const property = dataSource.properties?.[propertyName];
  if (!property || property.type !== "select") {
    throw new Error(`Data source ${dataSourceId} needs a Select property named "${propertyName}"`);
  }
  const existing = property.select.options || [];
  const existingNames = new Set(existing.map((option) => option.name));
  const additions = uniqueNames(names).filter((name) => !existingNames.has(name));
  if (additions.length === 0) return 0;

  await updateDataSource(dataSourceId, {
    [propertyName]: {
      select: {
        options: [
          ...optionDefinitions(existing),
          ...additions.map((name) => ({ name, color: "blue" })),
        ],
      },
    },
  });
  return additions.length;
}

/**
 * D3 is intentionally different: by this point old D3 rows are archived, so
 * the select list can become exactly the current active D8 list. D4 and D7
 * are never passed through this replacement function.
 */
async function rebuildD3StandortOptions(dataSourceId, activeNames, currentRows) {
  const selectedInactive = selectNamesFromRows(currentRows, "Standort").filter(
    (name) => !activeNames.includes(name),
  );
  if (selectedInactive.length > 0) {
    throw new Error(
      `D3 contains current-month Standort value(s) no longer active in D8: ${selectedInactive.join(", ")}. ` +
        "Resolve those current-month entries before pruning D3 options.",
    );
  }

  const dataSource = await getDataSource(dataSourceId);
  const property = dataSource.properties?.Standort;
  if (!property || property.type !== "select") {
    throw new Error(`Data source ${dataSourceId} needs a Select property named "Standort"`);
  }
  const existingByName = new Map((property.select.options || []).map((option) => [option.name, option]));
  const desired = uniqueNames(activeNames).map((name) => {
    const existing = existingByName.get(name);
    return existing ? optionDefinitions([existing])[0] : { name, color: "blue" };
  });

  await updateDataSource(dataSourceId, { Standort: { select: { options: desired } } });
}

function validateD3Rows(rows, worker, targetMonth) {
  const dates = new Set();
  const normalized = [];
  for (const row of rows) {
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
      Tagtyp: select(properties.Tagtyp?.select?.name || ""),
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

function archiveValuesMatch(archiveRow, worker, sourceRow) {
  const expected = archiveProperties(worker, sourceRow);
  const expectedDate = sourceRow.properties.Datum?.date || null;
  const actualDate = archiveRow.properties.Datum?.date || null;
  return (
    rowText(archiveRow, "Sync Key") === expected.syncKey &&
    titleValue(archiveRow.properties.Wochentag) === titleValue(sourceRow.properties.Wochentag) &&
    (actualDate?.start || "") === (expectedDate?.start || "") &&
    (actualDate?.end || null) === (expectedDate?.end || null) &&
    (actualDate?.time_zone || null) === (expectedDate?.time_zone || null) &&
    (archiveRow.properties.Stunden?.number ?? null) === (sourceRow.properties.Stunden?.number ?? null) &&
    (archiveRow.properties.Tagtyp?.select?.name || "") ===
      (sourceRow.properties.Tagtyp?.select?.name || "") &&
    (archiveRow.properties.Standort?.select?.name || "") ===
      (sourceRow.properties.Standort?.select?.name || "")
  );
}

async function archiveMonth(worker, sourceEntries) {
  const d4DataSource = await ensureD4Schema(worker.d4DataSourceId);
  // D4 must be able to retain all historical values before a page write.
  await addSelectOptions(
    worker.d4DataSourceId,
    d4DataSource,
    "Standort",
    selectNamesFromRows(sourceEntries.map((entry) => entry.row), "Standort"),
  );
  await addSelectOptions(
    worker.d4DataSourceId,
    await getDataSource(worker.d4DataSourceId),
    "Tagtyp",
    selectNamesFromRows(sourceEntries.map((entry) => entry.row), "Tagtyp"),
  );

  const initialArchiveRows = await queryAll(worker.d4DataSourceId);
  const index = d4RowsByKeyAndDate(initialArchiveRows);

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
  // page has exactly one verified, value-identical D4 row.
  const verifiedRows = await queryAll(worker.d4DataSourceId);
  const verifiedIndex = d4RowsByKeyAndDate(verifiedRows);
  for (const entry of sourceEntries) {
    const expectedKey = `${worker.workerKey}|${entry.sourceDate}`;
    const archiveRow = verifiedIndex.byKey.get(expectedKey);
    if (!archiveRow || !archiveValuesMatch(archiveRow, worker, entry.row)) {
      throw new Error(`${worker.name}: D4 verification failed for ${expectedKey}; D3 remains unchanged`);
    }
  }

  for (const entry of sourceEntries) {
    await archivePage(entry.row.id);
  }

  const remainingD3Rows = await queryAll(worker.d3DataSourceId);
  const remainingOld = remainingD3Rows.filter((row) => monthForDate(dateStart(row)) < sourceEntries[0].sourceMonth);
  const stillVisible = remainingD3Rows.filter((row) => sourceEntries.some((entry) => entry.row.id === row.id));
  if (stillVisible.length > 0 || remainingOld.length > 0) {
    throw new Error(`${worker.name}: D3 archive verification failed after D4 was verified`);
  }
}

async function ensureCurrentMonthRows(worker, targetMonth, currentRows) {
  const existingDates = new Set(currentRows.map((row) => dateStart(row)));
  let created = 0;
  for (const { isoDate, weekday } of monthDays(targetMonth)) {
    if (existingDates.has(isoDate)) continue;
    await createPage(
      { type: "data_source_id", data_source_id: worker.d3DataSourceId },
      { Wochentag: title(weekday), Datum: date(isoDate) },
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

  const d3DataSource = await getDataSource(worker.d3DataSourceId);
  assertPropertyTypes(d3DataSource, DAY_SCHEMA);
  let d3Rows = await queryAll(worker.d3DataSourceId);
  const entries = validateD3Rows(d3Rows, worker, run.targetMonth);
  const oldMonths = [...new Set(entries.filter((entry) => entry.sourceMonth < run.targetMonth).map((entry) => entry.sourceMonth))].sort();

  let lastArchivedMonth = "";
  for (const sourceMonth of oldMonths) {
    const sourceEntries = entries.filter((entry) => entry.sourceMonth === sourceMonth);
    console.log(`${worker.name}: archiving ${sourceEntries.length} D3 row(s) for ${sourceMonth}.`);
    await archiveMonth(worker, sourceEntries);
    lastArchivedMonth = sourceMonth;
    await setWorkerState(worker, {
      "Rollover Status": select("Running"),
      "Last Archived Month": richText(sourceMonth),
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
  if (oldMonths.length > 0 || (worker.rolloverStatus === "Running" && worker.currentMonth !== run.targetMonth)) {
    await rebuildD3StandortOptions(
      worker.d3DataSourceId,
      await activeStandorte(),
      remaining.map((entry) => entry.row),
    );
  }

  const created = worker.active
    ? await ensureCurrentMonthRows(worker, run.targetMonth, remaining.map((entry) => entry.row))
    : 0;
  const changed = oldMonths.length > 0 || created > 0;

  await setWorkerState(worker, {
    "Current Month": richText(run.targetMonth),
    ...(lastArchivedMonth ? { "Last Archived Month": richText(lastArchivedMonth) } : {}),
    ...(changed ? { "Last Rollover At": date(new Date().toISOString()) } : {}),
    "Rollover Status": select("Ready"),
    "Rollover Error": richText(""),
  });
  console.log(
    `${worker.name}: ${oldMonths.length ? `${oldMonths.join(", ")} archived; ` : ""}` +
      `${created} ${run.targetMonth} D3 row(s) created${worker.active ? "" : " (inactive: no new rows)"}.`,
  );
}

function selectWorkers(rows, run) {
  const workers = rows.map(workerFromRow).filter(hasCompleteRolloverReferences);
  if (!run.targetWorker) return workers;

  const matches = workers.filter(
    (worker) => worker.workerKey === run.targetWorker || worker.name === run.targetWorker,
  );
  if (matches.length !== 1) {
    throw new Error(
      `ROLLOVER_TARGET_WORKER must match exactly one valid worker key or name; found ${matches.length} matches.`,
    );
  }
  return matches;
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
  const rows = await queryAll(D1);
  const workers = selectWorkers(rows, run);
  console.log(
    `${run.simulation ? "SIMULATION" : "LIVE Berlin calendar"}: ${run.targetMonth}; ${workers.length} worker(s) in scope.`,
  );

  const seenWorkerKeys = new Set();
  const failures = [];
  for (const worker of workers) {
    if (seenWorkerKeys.has(worker.workerKey)) {
      throw new Error(`D1 has more than one valid worker with Worker Key ${worker.workerKey}`);
    }
    seenWorkerKeys.add(worker.workerKey);
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
  monthDays,
  monthForDate,
  resolveRunConfiguration,
  validIsoDate,
};
