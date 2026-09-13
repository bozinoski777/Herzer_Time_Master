"use strict";

const {
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
  updatePage,
} = require("./notion");

const {
  D1_DATA_SOURCE_ID: D1,
  D7_DATA_SOURCE_ID: D7,
} = requireEnv("D1_DATA_SOURCE_ID", "D7_DATA_SOURCE_ID");

const D1_SCHEMA = {
  "Vor- und Nachname": "title",
  Active: "checkbox",
  "Onboarding Status": "select",
  "Worker Key": "rich_text",
  "D3 Database ID": "rich_text",
  "D3 Data Source ID": "rich_text",
};

const D7_SCHEMA = {
  Wochentag: "title",
  Datum: "date",
  Stunden: "number",
  Standort: "select",
  "Vor- und Nachname": "rich_text",
  "Worker Key": "rich_text",
  "Sync Key": "rich_text",
  "Source Page ID": "rich_text",
  "Source Database ID": "rich_text",
  "Last Synced At": "date",
};

async function validateSchema() {
  const d1 = await getDataSource(D1);
  assertPropertyTypes(d1, D1_SCHEMA);
  const d7 = await getDataSource(D7);
  assertPropertyTypes(d7, D7_SCHEMA);
}

async function readyWorkers() {
  const rows = await queryAll(D1, {
    and: [
      { property: "Active", checkbox: { equals: true } },
      { property: "Onboarding Status", select: { equals: "Ready" } },
    ],
  });

  return rows.map((row) => ({
    name: titleValue(row.properties["Vor- und Nachname"]).trim(),
    workerKey: richTextValue(row.properties["Worker Key"]).trim(),
    d3DatabaseId: richTextValue(row.properties["D3 Database ID"]).trim(),
    d3DataSourceId: richTextValue(row.properties["D3 Data Source ID"]).trim(),
  }));
}

async function managementIndex() {
  const rows = await queryAll(D7);
  const index = new Map();
  const duplicates = [];

  for (const row of rows) {
    const syncKey = richTextValue(row.properties["Sync Key"]).trim();
    if (!syncKey) continue;

    if (index.has(syncKey)) {
      duplicates.push(syncKey);
    } else {
      index.set(syncKey, row);
    }
  }

  if (duplicates.length > 0) {
    throw new Error(
      `D7 already contains duplicate Sync Key value(s): ${[...new Set(duplicates)].join(", ")}. Resolve them before syncing.`,
    );
  }

  return index;
}

function sourceDate(row) {
  return row.properties.Datum?.date?.start || "";
}

function managementProperties(worker, sourcePage) {
  const properties = sourcePage.properties;
  const datum = sourceDate(sourcePage);

  if (!datum) throw new Error(`D3 page ${sourcePage.id} has no Datum`);
  if (!worker.name || !worker.workerKey || !worker.d3DatabaseId) {
    throw new Error(`Worker routing data is incomplete for D3 source ${worker.d3DataSourceId}`);
  }

  const weekday = titleValue(properties.Wochentag);
  const hours = properties.Stunden?.number ?? null;
  const standort = properties.Standort?.select?.name || "";
  const syncKey = `${worker.workerKey}|${datum}`;

  return {
    syncKey,
    properties: {
      Wochentag: title(weekday),
      Datum: date(datum),
      Stunden: { number: hours },
      Standort: select(standort),
      "Vor- und Nachname": richText(worker.name),
      "Worker Key": richText(worker.workerKey),
      "Sync Key": richText(syncKey),
      "Source Page ID": richText(sourcePage.id),
      "Source Database ID": richText(worker.d3DatabaseId),
      "Last Synced At": date(new Date().toISOString()),
    },
  };
}

async function syncWorker(worker, existingManagementRows) {
  if (!worker.d3DataSourceId) {
    throw new Error(`${worker.name || "Unnamed worker"} is Ready but has no D3 Data Source ID`);
  }

  const sourceDataSource = await getDataSource(worker.d3DataSourceId);
  assertPropertyTypes(sourceDataSource, {
    Wochentag: "title",
    Datum: "date",
    Stunden: "number",
    Standort: "select",
  });

  const sourceRows = await queryAll(worker.d3DataSourceId);
  const dateKeys = new Set();

  for (const sourceRow of sourceRows) {
    const datum = sourceDate(sourceRow);
    if (!datum) {
      console.warn(`${worker.name}: skipped D3 page ${sourceRow.id} without Datum.`);
      continue;
    }
    if (dateKeys.has(datum)) {
      throw new Error(`${worker.name}: D3 has more than one page for ${datum}; refusing to create duplicates in D7`);
    }
    dateKeys.add(datum);
  }

  let created = 0;
  let updated = 0;
  for (const sourceRow of sourceRows) {
    if (!sourceDate(sourceRow)) continue;

    const built = managementProperties(worker, sourceRow);
    const existing = existingManagementRows.get(built.syncKey);

    if (existing) {
      // Values are written even when empty (null / empty select), so clearing a
      // value in D3 also clears the matching D7 value.
      await updatePage(existing.id, built.properties);
      updated += 1;
    } else {
      const createdPage = await createPage(
        { type: "data_source_id", data_source_id: D7 },
        built.properties,
      );
      existingManagementRows.set(built.syncKey, createdPage);
      created += 1;
    }
  }

  console.log(`${worker.name}: ${created} created, ${updated} updated.`);
}

async function main() {
  await validateSchema();
  const workers = await readyWorkers();
  const existingManagementRows = await managementIndex();
  const seenWorkerKeys = new Set();

  console.log(`Syncing ${workers.length} Ready worker(s) to D7.`);

  for (const worker of workers) {
    if (!worker.workerKey) {
      throw new Error(`${worker.name || "Unnamed worker"} is Ready but has no Worker Key`);
    }
    if (seenWorkerKeys.has(worker.workerKey)) {
      throw new Error(`D1 has more than one Ready worker with Worker Key ${worker.workerKey}`);
    }
    seenWorkerKeys.add(worker.workerKey);
    await syncWorker(worker, existingManagementRows);
  }
}

main().catch((failure) => {
  console.error(errorMessage(failure));
  process.exitCode = 1;
});
