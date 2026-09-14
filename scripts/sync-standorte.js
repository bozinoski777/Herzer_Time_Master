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
  updatePage,
} = require("./notion");
const { workerStandortNames, workerStandortOptions } = require("./worker-standort-options");

const D7_STANDORT_RELATION = "Standort (D8)";

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
    name: titleValue(row.properties["Vor- und Nachname"]).trim() || row.id,
    d3DataSourceId: workerD3Id(row),
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
  const updates = [];

  for (const row of d7Rows) {
    const selectedName = row.properties.Standort?.select?.name || "";
    const relatedD8Id = d8ByName.get(selectedName);
    const desiredIds = relatedD8Id ? [relatedD8Id] : [];
    const currentIds = relationIds(row);

    if (JSON.stringify(currentIds) !== JSON.stringify(desiredIds)) {
      updates.push({ pageId: row.id, relatedD8Id: relatedD8Id || null });
    }
  }

  return updates;
}

async function syncD7StandortRelations() {
  const [d8Rows, d7Rows] = await Promise.all([queryAll(D8), queryAll(D7)]);
  const updates = planD7StandortRelations(d7Rows, d8Rows);

  for (const update of updates) {
    await updatePage(update.pageId, {
      [D7_STANDORT_RELATION]: {
        relation: update.relatedD8Id ? [{ id: update.relatedD8Id }] : [],
      },
    });
  }

  return updates.length;
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
  // Notion permits a color when a select option is created, but rejects a
  // color update for an existing option ID. Preserve existing options exactly
  // as they are; new options still receive the intended worker-facing color.
  if (existing?.id) {
    return { id: existing.id, name: existing.name };
  }

  return { name: desired.name, color: desired.color };
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
  // Existing option colors are intentionally not part of the update plan:
  // the public API rejects changing them. The names/order determine whether
  // the option list needs a safe reconciliation.
  const currentNames = existingOptions.map((option) => option.name);
  const nextNames = nextOptions.map((option) => option.name);

  return {
    added,
    removed,
    nextOptions,
    changed: JSON.stringify(currentNames) !== JSON.stringify(nextNames),
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

  const related = await syncD7StandortRelations();
  console.log(`D7: ${related} Standort relation(s) reconciled.`);
}

if (require.main === module) {
  main().catch((failure) => {
    console.error(errorMessage(failure));
    process.exitCode = 1;
  });
}

module.exports = { planD3StandortOptions, planD7StandortRelations };
