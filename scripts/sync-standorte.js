"use strict";

const {
  assertPropertyTypes,
  errorMessage,
  getDataSource,
  queryAll,
  requireEnv,
  richTextValue,
  titleValue,
  updateDataSource,
} = require("./notion");
const { workerStandortNames, workerStandortOptions } = require("./worker-standort-options");

const {
  D1_DATA_SOURCE_ID: D1,
  D7_DATA_SOURCE_ID: D7,
  D8_DATA_SOURCE_ID: D8,
} = requireEnv("D1_DATA_SOURCE_ID", "D7_DATA_SOURCE_ID", "D8_DATA_SOURCE_ID");

function workerD3Id(row) {
  return richTextValue(row.properties["D3 Data Source ID"]).trim();
}

async function validateSchema() {
  const d1 = await getDataSource(D1);
  assertPropertyTypes(d1, {
    Active: "checkbox",
    "Onboarding Status": "select",
    "D3 Data Source ID": "rich_text",
  });

  const d8 = await getDataSource(D8);
  assertPropertyTypes(d8, { Standort: "title", Active: "checkbox" });
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
    name: titleValue(row.properties["Vor- und Nachname"]).trim() || row.id,
    d3DataSourceId: workerD3Id(row),
  }));
}

/** D7 is history, so it retains every existing option and only gains new ones. */
async function addMissingStandortOptions(dataSourceId, standorte) {
  const dataSource = await getDataSource(dataSourceId);
  const property = dataSource.properties?.Standort;

  if (!property || property.type !== "select") {
    throw new Error(`Data source ${dataSourceId} needs a Select property named \"Standort\"`);
  }

  const existingOptions = property.select.options || [];
  const existingNames = new Set(existingOptions.map((option) => option.name));
  const additions = standorte.filter((name) => !existingNames.has(name));

  if (additions.length === 0) return 0;

  await updateDataSource(dataSourceId, {
    Standort: {
      select: {
        options: [
          // Sending all existing options prevents removal during the PATCH.
          ...existingOptions.map((option) => ({ id: option.id, name: option.name })),
          ...additions.map((name) => ({ name, color: "blue" })),
        ],
      },
    },
  });

  return additions.length;
}

function selectedStandortNames(rows) {
  return [...new Set(
    rows.map((row) => row.properties.Standort?.select?.name || "").filter(Boolean),
  )];
}

function optionForUpdate(existing, desired) {
  return {
    ...(existing?.id ? { id: existing.id } : {}),
    name: desired.name,
    color: desired.color,
  };
}

/**
 * D3 contains only the current month, so it may drop inactive D8 sites.
 * A selected value is never removed: Notion would invalidate that current day.
 */
function planD3StandortOptions(existingOptions, desiredOptions, rows) {
  const desiredNames = new Set(desiredOptions.map((option) => option.name));
  const selectedInactive = selectedStandortNames(rows).filter((name) => !desiredNames.has(name));
  if (selectedInactive.length > 0) {
    throw new Error(
      `D3 still uses inactive Standort option(s): ${selectedInactive.join(", ")}. ` +
        "Change or clear those current-month entries before the option can be removed.",
    );
  }

  const existingByName = new Map(existingOptions.map((option) => [option.name, option]));
  const nextOptions = desiredOptions.map((desired) => optionForUpdate(existingByName.get(desired.name), desired));
  const removed = existingOptions
    .map((option) => option.name)
    .filter((name) => !desiredNames.has(name));
  const added = desiredOptions
    .map((option) => option.name)
    .filter((name) => !existingByName.has(name));
  const currentPresentation = existingOptions.map((option) => ({ name: option.name, color: option.color }));
  const nextPresentation = nextOptions.map((option) => ({ name: option.name, color: option.color }));

  return {
    added,
    removed,
    nextOptions,
    changed: JSON.stringify(currentPresentation) !== JSON.stringify(nextPresentation),
  };
}

async function syncD3StandortOptions(dataSourceId, desiredOptions) {
  const dataSource = await getDataSource(dataSourceId);
  const property = dataSource.properties?.Standort;
  if (!property || property.type !== "select") {
    throw new Error(`Data source ${dataSourceId} needs a Select property named "Standort"`);
  }

  const plan = planD3StandortOptions(
    property.select.options || [],
    desiredOptions,
    await queryAll(dataSourceId),
  );
  if (!plan.changed) return plan;

  await updateDataSource(dataSourceId, {
    Standort: { select: { options: plan.nextOptions } },
  });
  return plan;
}

async function main() {
  await validateSchema();

  const activeStandorte = await getActiveStandorte();
  const standorte = workerStandortNames(activeStandorte);
  const d3Options = workerStandortOptions(activeStandorte);
  const workers = await readyWorkers();
  const seenDataSources = new Set();

  console.log(`Distributing ${standorte.length} Standort/work option(s) to ${workers.length} worker(s).`);

  for (const worker of workers) {
    if (!worker.d3DataSourceId) {
      throw new Error(`${worker.name} is Ready but has no D3 Data Source ID in D1`);
    }
    if (seenDataSources.has(worker.d3DataSourceId)) {
      throw new Error(`D1 assigns D3 data source ${worker.d3DataSourceId} to more than one worker`);
    }
    seenDataSources.add(worker.d3DataSourceId);

    const result = await syncD3StandortOptions(worker.d3DataSourceId, d3Options);
    console.log(`${worker.name}: ${result.added.length} added, ${result.removed.length} inactive option(s) removed.`);
  }

  const d7Added = await addMissingStandortOptions(D7, standorte);
  console.log(`D7: ${d7Added} Standort option(s) added.`);
}

if (require.main === module) {
  main().catch((failure) => {
    console.error(errorMessage(failure));
    process.exitCode = 1;
  });
}

module.exports = { planD3StandortOptions };
