"use strict";

const {
  assertPropertyTypes,
  errorMessage,
  getDataSource,
  queryAll,
  requireEnv,
  richTextValue,
  titleValue,
  updatePage,
} = require("./notion");
const {
  WORK_TYPE_OPTIONS,
  workerStandortNames,
  workerStandortOptions,
} = require("./worker-standort-options");
const {
  planSelectOptionUpdate,
  updateDataSourceSelect,
} = require("./select-options");
const { hasPendingRollover } = require("./rollover-manifest");
const {
  D1_WORKER_REFERENCE_SCHEMA,
  assertUniqueWorkerReferences,
  assertWorkerDataSourceReference,
  workerReferencesFromD1,
} = require("./worker-database-references");
const { assertDayDataSource } = require("./day-schemas");

const D7_STANDORT_RELATION = "Standort (D8)";

const {
  D1_DATA_SOURCE_ID: D1,
  D7_DATA_SOURCE_ID: D7,
  D8_DATA_SOURCE_ID: D8,
} = requireEnv("D1_DATA_SOURCE_ID", "D7_DATA_SOURCE_ID", "D8_DATA_SOURCE_ID");

function shouldSyncWorkerD3Options(worker) {
  return !hasPendingRollover(worker);
}

async function validateSchema() {
  const d1 = await getDataSource(D1);
  assertPropertyTypes(d1, {
    "Vor- und Nachname": "title",
    Active: "checkbox",
    "Onboarding Status": "select",
    "Worker Key": "rich_text",
    ...D1_WORKER_REFERENCE_SCHEMA,
  });
  const rolloverManifest = d1.properties?.["Rollover Manifest"];
  if (rolloverManifest && rolloverManifest.type !== "rich_text") {
    throw new Error(`D1 property "Rollover Manifest" is ${rolloverManifest.type}, expected rich_text`);
  }

  await validateStandortRelationSchema();
}

async function validateStandortRelationSchema() {
  const d8 = await getDataSource(D8);
  assertPropertyTypes(d8, {
    Standort: "title",
    Active: "checkbox",
    "Arbeitszeiten (D7)": "relation",
    "Gearbeitete Stunden": "rollup",
  });

  const d7 = await getDataSource(D7);
  assertPropertyTypes(d7, {
    Standort: "select",
    [D7_STANDORT_RELATION]: "relation",
  });
}

async function getActiveStandorte() {
  const rows = await queryAll(D8, {
    property: "Active",
    checkbox: { equals: true },
  });

  return [...new Set(
    rows
      .map((row) => titleValue(row.properties.Standort).trim())
      .filter(Boolean),
  )];
}

async function readyWorkers() {
  const rows = await queryAll(D1, {
    and: [
      { property: "Active", checkbox: { equals: true } },
      { property: "Onboarding Status", select: { equals: "Ready" } },
    ],
  });

  return rows.map((row) => ({
    ...workerReferencesFromD1(row),
    rolloverManifest: richTextValue(row.properties["Rollover Manifest"]).trim(),
    rolloverStatus: row.properties["Rollover Status"]?.select?.name || "",
  }));
}

function d8StandortIndex(rows) {
  const byName = new Map();

  for (const row of rows) {
    const name = titleValue(row.properties.Standort).trim();
    if (!name) continue;
    if (byName.has(name)) {
      throw new Error(
        `D8 contains more than one Standort named "${name}". Resolve the duplicate before syncing relations.`,
      );
    }
    byName.set(name, row.id);
  }

  return byName;
}

function relationIds(row) {
  return (row.properties[D7_STANDORT_RELATION]?.relation || []).map((related) => related.id);
}

/**
 * D7's relation is automation-owned and always mirrors its Standort select.
 * D8 includes inactive locations too, so historic rows keep their site link.
 */
function planD7StandortRelations(d7Rows, d8Rows) {
  const d8ByName = d8StandortIndex(d8Rows);
  const workTypeNames = new Set(WORK_TYPE_OPTIONS.map((option) => option.name));
  const updates = [];

  for (const row of d7Rows) {
    const selectedName = row.properties.Standort?.select?.name || "";
    const relatedD8Id = d8ByName.get(selectedName);
    if (selectedName && !relatedD8Id && !workTypeNames.has(selectedName)) {
      throw new Error(
        `D7 row ${row.id} uses Standort "${selectedName}", but D8 has no matching location. ` +
          "Create/correct the D8 Standort before clearing or changing its relation.",
      );
    }
    const desiredIds = relatedD8Id ? [relatedD8Id] : [];
    const currentIds = relationIds(row);

    if (JSON.stringify(currentIds) !== JSON.stringify(desiredIds)) {
      updates.push({ pageId: row.id, relatedD8Id: relatedD8Id || null });
    }
  }

  return updates;
}

async function syncD7StandortRelations(d7Filter, { verify = false } = {}) {
  await validateStandortRelationSchema();
  const [d8Rows, d7Rows] = await Promise.all([queryAll(D8), queryAll(D7, d7Filter)]);
  const updates = planD7StandortRelations(d7Rows, d8Rows);

  for (const update of updates) {
    await updatePage(update.pageId, {
      [D7_STANDORT_RELATION]: {
        relation: update.relatedD8Id ? [{ id: update.relatedD8Id }] : [],
      },
    });
  }

  if (verify) {
    const remaining = planD7StandortRelations(await queryAll(D7, d7Filter), d8Rows);
    if (remaining.length > 0) {
      throw new Error(
        `D7 Standort relation verification failed for ${remaining.length} row(s)`,
      );
    }
  }

  return updates.length;
}

function standortOptionAdditions(existingOptions, standorte) {
  const requestedNames = [...new Set(
    standorte.map((name) => String(name || "").trim()).filter(Boolean),
  )];
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

/** D7 is history, so it retains every existing option and only gains new ones. */
async function addMissingStandortOptions(dataSourceId, standorte) {
  const additions = standortOptionAdditions([], standorte);
  const plan = await updateDataSourceSelect({
    dataSourceId,
    propertyName: "Standort",
    desiredOptions: additions,
    retainExisting: true,
  });
  return plan.added.length;
}

function selectedStandortNames(rows) {
  return [...new Set(
    rows.map((row) => row.properties.Standort?.select?.name || "").filter(Boolean),
  )];
}

/**
 * D3 contains only the current month, so it may drop inactive D8 sites.
 * A selected value is never removed: Notion would invalidate that current day.
 */
function planD3StandortOptions(existingOptions, desiredOptions, rows) {
  try {
    return planSelectOptionUpdate(existingOptions, desiredOptions, {
      protectedNames: selectedStandortNames(rows),
    });
  } catch (failure) {
    if (!failure.message.startsWith("Cannot remove Select option(s)")) throw failure;
    const desiredNames = new Set(desiredOptions.map((option) => option.name));
    const selectedInactive = selectedStandortNames(rows).filter(
      (name) => !desiredNames.has(name),
    );
    throw new Error(
      `D3 still uses inactive Standort option(s): ${selectedInactive.join(", ")}. ` +
        "Change or clear those current-month entries before the option can be removed.",
    );
  }
}

async function syncD3StandortOptions(dataSourceId, desiredOptions, worker) {
  const dataSource = await getDataSource(dataSourceId);
  if (worker) {
    assertWorkerDataSourceReference(worker, "d3", dataSource, {
      schema: assertDayDataSource,
    });
  }
  const rows = await queryAll(dataSourceId);
  // Produce the worker-specific diagnostic before handing the actual update
  // to the shared, in-use-safe Select service.
  planD3StandortOptions(
    dataSource.properties?.Standort?.select?.options || [],
    desiredOptions,
    rows,
  );
  return updateDataSourceSelect({
    dataSourceId,
    dataSource,
    propertyName: "Standort",
    desiredOptions,
    protectedNames: selectedStandortNames(rows),
  });
}

/**
 * Keep worker-specific D3 failures isolated from the shared D7/D8 work. A
 * failed D3 must still make the workflow red, but it must not prevent relation
 * repairs for D7 rows that an earlier Daily-sync worker already committed.
 */
async function runStandortSynchronization(
  workers,
  activeStandorte,
  operations = {},
) {
  const syncWorkerOptions = operations.syncD3StandortOptions || syncD3StandortOptions;
  const addD7Options = operations.addMissingStandortOptions || addMissingStandortOptions;
  const syncD7Relations = operations.syncD7StandortRelations || syncD7StandortRelations;
  const standorte = workerStandortNames(activeStandorte);
  const d3Options = workerStandortOptions(activeStandorte);
  const failures = [];
  let registrySafe = true;
  try {
    assertUniqueWorkerReferences(workers, {
      // Standort sync mutates only D3. D4 is parsed for a pending rollover
      // checkpoint but otherwise remains outside this workflow's scope.
      roles: ["d3"],
      reservedDataSources: [
        { id: D1, label: "D1 Data Source ID" },
        { id: D7, label: "D7 Data Source ID" },
        { id: D8, label: "D8 Data Source ID" },
      ],
    });
  } catch (failure) {
    registrySafe = false;
    failures.push(`D1 worker routing: ${errorMessage(failure)}`);
  }

  console.log(`Distributing ${standorte.length} Standort/work option(s) to ${workers.length} worker(s).`);

  for (const worker of workers) {
    if (!worker.d3DataSourceId) {
      failures.push(`${worker.name} is Ready but has no D3 Data Source ID in D1`);
      continue;
    }
    if (!registrySafe) continue;
    let shouldSyncOptions;
    try {
      shouldSyncOptions = shouldSyncWorkerD3Options(worker);
    } catch (failure) {
      failures.push(`${worker.name}: ${errorMessage(failure)}`);
      continue;
    }
    if (!shouldSyncOptions) {
      console.log(
        `${worker.name}: D3 options skipped because Month Rollover has a pending archive checkpoint.`,
      );
      continue;
    }

    try {
      const result = await syncWorkerOptions(worker.d3DataSourceId, d3Options, worker);
      console.log(
        `${worker.name}: ${result.added.length} added, ` +
          `${result.removed.length} inactive option(s) removed.`,
      );
    } catch (failure) {
      failures.push(`${worker.name}: ${errorMessage(failure)}`);
    }
  }

  try {
    const d7Added = await addD7Options(D7, standorte);
    console.log(`D7: ${d7Added} Standort option(s) added.`);
  } catch (failure) {
    failures.push(`D7 Standort options: ${errorMessage(failure)}`);
  }

  try {
    const related = await syncD7Relations(undefined, { verify: true });
    console.log(`D7: ${related} Standort relation(s) reconciled.`);
  } catch (failure) {
    failures.push(`D7 Standort relations: ${errorMessage(failure)}`);
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} Standort sync failure(s): ${failures.join(" | ")}`);
  }
}

async function main() {
  await validateSchema();

  const activeStandorte = await getActiveStandorte();
  const workers = await readyWorkers();
  await runStandortSynchronization(workers, activeStandorte);
}

if (require.main === module) {
  main().catch((failure) => {
    console.error(errorMessage(failure));
    process.exitCode = 1;
  });
}

module.exports = {
  planD3StandortOptions,
  planD7StandortRelations,
  runStandortSynchronization,
  standortOptionAdditions,
  shouldSyncWorkerD3Options,
  syncD7StandortRelations,
  validateStandortRelationSchema,
};
