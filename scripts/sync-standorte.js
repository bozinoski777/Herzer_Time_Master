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
const { workerStandortNames } = require("./worker-standort-options");

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

/**
 * Add missing active sites while explicitly retaining every current option.
 * Notion removes select options omitted from a schema PATCH, so preserving the
 * existing option IDs here is intentional and protects historic time entries.
 */
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

async function main() {
  await validateSchema();

  const standorte = workerStandortNames(await getActiveStandorte());
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

    const added = await addMissingStandortOptions(worker.d3DataSourceId, standorte);
    console.log(`${worker.name}: ${added} Standort option(s) added.`);
  }

  const d7Added = await addMissingStandortOptions(D7, standorte);
  console.log(`D7: ${d7Added} Standort option(s) added.`);
}

main().catch((failure) => {
  console.error(errorMessage(failure));
  process.exitCode = 1;
});
