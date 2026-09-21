"use strict";

/**
 * One-time, manual-only migration for existing Secure Timekeeping POC data.
 *
 * Future onboarding never creates Tagtyp. This migration moves an old
 * Tagtyp value into Standort only when Standort is blank, then removes the
 * legacy property. A row with two different values is intentionally a hard
 * stop: a single-select cannot retain both without a management decision.
 */

const {
  assertPropertyTypes,
  databaseIdFromDataSource,
  errorMessage,
  getDataSource,
  queryAll,
  requireEnv,
  updateDataSource,
  updatePage,
} = require("./notion");
const {
  ensureCurrentMonthPresentation,
} = require("./frontend-presentation");
const { ensureArchivePresentation } = require("./archive-presentation");
const { WORK_TYPE_OPTIONS, LEGACY_WORK_TYPE_OPTIONS } = require("./worker-standort-options");
const {
  planSelectOptionUpdate,
  updateDataSourceSelect,
} = require("./select-options");
const { assertDayDataSource } = require("./day-schemas");
const {
  D1_WORKER_REFERENCE_SCHEMA,
  assertWorkerDataSourceReference,
  workerDataSourceTargets,
  workerReferencesFromD1,
} = require("./worker-database-references");

const {
  D1_DATA_SOURCE_ID: D1,
  D7_DATA_SOURCE_ID: D7,
} = requireEnv("D1_DATA_SOURCE_ID", "D7_DATA_SOURCE_ID");

const LEGACY_PROPERTY = "Tagtyp";
const D1_SCHEMA = {
  "Vor- und Nachname": "title",
  "Worker Key": "rich_text",
  ...D1_WORKER_REFERENCE_SCHEMA,
};

function selectValue(page, propertyName) {
  return page.properties[propertyName]?.select?.name || "";
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function mergeStandortOptions(standortOptions, legacyOptions, legacyValues) {
  const candidates = [
    ...WORK_TYPE_OPTIONS,
    ...LEGACY_WORK_TYPE_OPTIONS,
    ...legacyOptions,
    ...unique(legacyValues).map((name) => ({ name, color: "blue" })),
  ];
  return planSelectOptionUpdate(standortOptions, candidates, {
    retainExisting: true,
  }).nextOptions;
}

function optionNames(options) {
  return options.map((option) => option.name);
}

function planSource(target, dataSource, rows) {
  const standort = dataSource.properties?.Standort;
  if (!standort || standort.type !== "select") {
    throw new Error(`${target.label}: needs a Select property named "Standort"`);
  }

  const legacy = dataSource.properties?.[LEGACY_PROPERTY];
  if (!legacy) return null;
  if (legacy.type !== "select") {
    throw new Error(`${target.label}: ${LEGACY_PROPERTY} is ${legacy.type}, expected select`);
  }

  const moves = [];
  const conflicts = [];
  for (const row of rows) {
    const oldValue = selectValue(row, LEGACY_PROPERTY);
    const standortValue = selectValue(row, "Standort");
    if (!oldValue || oldValue === standortValue) continue;
    if (standortValue) {
      conflicts.push({ rowId: row.id, standort: standortValue, legacy: oldValue });
    } else {
      moves.push({ rowId: row.id, value: oldValue });
    }
  }

  const options = mergeStandortOptions(
    standort.select.options || [],
    legacy.select.options || [],
    rows.map((row) => selectValue(row, LEGACY_PROPERTY)),
  );
  const existingNames = optionNames(standort.select.options || []);
  return {
    ...target,
    dataSourceId: dataSource.id,
    moves,
    conflicts,
    options,
    needsOptionUpdate: JSON.stringify(existingNames) !== JSON.stringify(optionNames(options)),
  };
}

async function targetsFromD1() {
  const d1 = await getDataSource(D1);
  assertPropertyTypes(d1, D1_SCHEMA);
  const targets = new Map([[D7, { dataSourceId: D7, label: "D7", kinds: new Set(["d7"]) }]]);

  const workers = (await queryAll(D1)).map(workerReferencesFromD1);
  const workerTargets = workerDataSourceTargets(workers, {
    reservedDataSources: [
      { id: D1, label: "D1 Data Source ID" },
      { id: D7, label: "D7 Data Source ID" },
    ],
  });
  for (const target of workerTargets) {
    targets.set(target.dataSourceId, {
      ...target,
      kinds: new Set([target.role]),
    });
  }
  return [...targets.values()];
}

async function buildPlans() {
  const plans = [];
  for (const target of await targetsFromD1()) {
    const dataSource = await getDataSource(target.dataSourceId);
    if (target.worker) {
      assertWorkerDataSourceReference(target.worker, target.role, dataSource, {
        schema: assertDayDataSource,
      });
    }
    const plan = planSource(target, dataSource, await queryAll(target.dataSourceId));
    if (plan) plans.push(plan);
  }
  return plans;
}

function conflictMessage(plans) {
  const details = plans.flatMap((plan) =>
    plan.conflicts.map(
      (conflict) =>
        `${plan.label} row ${conflict.rowId}: Standort=${conflict.standort}, ${LEGACY_PROPERTY}=${conflict.legacy}`,
    ),
  );
  return details.join(" | ");
}

async function applyPlan(plan) {
  if (plan.needsOptionUpdate) {
    await updateDataSourceSelect({
      dataSourceId: plan.dataSourceId,
      propertyName: "Standort",
      desiredOptions: plan.options,
    });
  }

  for (const move of plan.moves) {
    await updatePage(move.rowId, { Standort: { select: { name: move.value } } });
  }

  if (plan.moves.length > 0) {
    const refreshedRows = new Map((await queryAll(plan.dataSourceId)).map((row) => [row.id, row]));
    for (const move of plan.moves) {
      if (selectValue(refreshedRows.get(move.rowId), "Standort") !== move.value) {
        throw new Error(`${plan.label}: could not verify migrated row ${move.rowId}; ${LEGACY_PROPERTY} was retained`);
      }
    }
  }

  // The public Notion API removes a data-source property when its value is
  // null. This happens only after every transferable row has been verified.
  await updateDataSource(plan.dataSourceId, { [LEGACY_PROPERTY]: null });
  const refreshed = await getDataSource(plan.dataSourceId);
  if (refreshed.properties?.[LEGACY_PROPERTY]) {
    throw new Error(`${plan.label}: could not remove ${LEGACY_PROPERTY}`);
  }

  const databaseId = databaseIdFromDataSource(refreshed);
  if (plan.kinds.has("d3")) {
    await ensureCurrentMonthPresentation(databaseId, plan.dataSourceId);
  }
  if (plan.kinds.has("d4")) {
    await ensureArchivePresentation(databaseId, plan.dataSourceId);
  }
}

async function main() {
  const plans = await buildPlans();
  const conflicts = conflictMessage(plans);
  if (conflicts) {
    throw new Error(
      `No POC data was changed. Resolve rows with two different single-select values before retrying: ${conflicts}`,
    );
  }

  const moved = plans.reduce((total, plan) => total + plan.moves.length, 0);
  console.log(
    `Prepared ${plans.length} legacy ${LEGACY_PROPERTY} data source(s); ${moved} row(s) can move to Standort.`,
  );
  if (process.env.TAGTYP_MIGRATION_EXECUTE !== "true") {
    console.log("Dry run only. Set TAGTYP_MIGRATION_EXECUTE=true to apply this reviewed migration.");
    return;
  }

  for (const plan of plans) {
    await applyPlan(plan);
    console.log(`${plan.label}: removed ${LEGACY_PROPERTY} (${plan.moves.length} row(s) moved).`);
  }
}

if (require.main === module) {
  main().catch((failure) => {
    console.error(errorMessage(failure));
    process.exitCode = 1;
  });
}

module.exports = { mergeStandortOptions, planSource };
