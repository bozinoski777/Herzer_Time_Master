"use strict";

// Manual, repeatable migration. No row values are written; Notion computes
// Urlaubstag for historic entries as soon as the formula is installed.
const notion = require("./notion");
const {
  VACATION_DAY_PROPERTY, assertDayDataSource, assertVacationDayFormula,
} = require("./day-schemas");
const { archiveColumnUpdate, ensureArchiveSchema } = require("./archive-presentation");
const { isVacationChart, vacationChartUpdate } = require("./frontend-presentation");
const {
  D1_WORKER_REFERENCE_SCHEMA, assertUniqueWorkerReferences,
  assertWorkerDatabaseReference, assertWorkerDataSourceReference,
  missingWorkerReferences, normalizeNotionId, workerReferencesFromD1,
} = require("./worker-database-references");

function berlinMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit",
  }).formatToParts(now);
  return `${parts.find((part) => part.type === "year").value}-${parts.find((part) => part.type === "month").value}`;
}

async function buildMigrationPlans(d1Id, operations = {}) {
  const api = { ...notion, ...operations };
  notion.assertPropertyTypes(await api.getDataSource(d1Id), {
    ...D1_WORKER_REFERENCE_SCHEMA,
    "Vor- und Nachname": "title", "Worker Key": "rich_text",
    "Frontend Page ID": "rich_text", "Urlaub Chart View ID": "rich_text",
  });
  const workers = (await api.queryAll(d1Id)).map(workerReferencesFromD1);
  assertUniqueWorkerReferences(workers, { reservedDataSources: [d1Id] });
  const plans = [];
  const errors = [];
  for (const worker of workers) {
    // Pending workers with no D4 will receive the new schema on onboarding.
    if (!worker.d4DatabaseId && !worker.d4DataSourceId &&
        worker.row.properties?.["Onboarding Status"]?.select?.name !== "Ready") continue;
    try {
      const missing = missingWorkerReferences(worker, { roles: ["d4"], requireFrontend: true });
      const chartId = notion.richTextValue(worker.row.properties?.["Urlaub Chart View ID"]).trim();
      if (!chartId) missing.push("Urlaub Chart View ID");
      if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
      const source = await api.getDataSource(worker.d4DataSourceId);
      assertWorkerDataSourceReference(worker, "d4", source, { schema: assertDayDataSource });
      assertVacationDayFormula(source, { allowMissing: true });
      for (const name of ["Sync Key", "Source Page ID"]) {
        if (source.properties[name] && source.properties[name].type !== "rich_text") {
          throw new Error(`incompatible ${name} property`);
        }
      }
      if (!source.properties.Standort.select?.options?.some((option) => option.name === "Urlaub")) {
        throw new Error('missing Standort option "Urlaub"');
      }
      assertWorkerDatabaseReference(worker, "d4", await api.getDatabase(worker.d4DatabaseId), {
        expectedParentPageId: worker.frontendPageId,
      });
      const views = await Promise.all((await api.listAllViews(worker.d4DatabaseId))
        .map((reference) => api.getView(reference.id)));
      const tables = ["Alle", "Urlaub"].map((name) => {
        const candidates = views.filter((view) => view.name === name);
        if (candidates.length !== 1 || candidates[0].type !== "table" ||
            normalizeNotionId(candidates[0].data_source_id) !== normalizeNotionId(source.id)) {
          throw new Error(`missing, duplicate, or incompatible ${name} view`);
        }
        return candidates[0];
      });
      const chart = await api.getView(chartId);
      if (!isVacationChart(chart, source.id, { knownView: true })) {
        throw new Error("saved Urlaub chart does not match this worker's D4 number chart");
      }
      plans.push({ worker, tables, chart });
    } catch (error) {
      errors.push(`${worker.name}: ${notion.errorMessage(error)}`);
    }
  }
  if (errors.length) throw new Error(`Vacation migration preflight failed:\n${errors.join("\n")}`);
  return plans;
}

function columnsMatch(dataSource, view, expected) {
  const actual = notion.writableViewProperties(dataSource, view.configuration?.properties || []);
  const visible = actual.filter((entry) => entry.visible !== false).map((entry) => entry.property_id);
  const desiredVisible = expected.filter((entry) => entry.visible).map((entry) => entry.property_id);
  return JSON.stringify(visible) === JSON.stringify(desiredVisible) && expected.every((entry) => {
    const current = actual.find((candidate) => candidate.property_id === entry.property_id);
    return current && (current.visible !== false) === entry.visible;
  });
}

function verifyVacationRows(rows, targetMonth) {
  let total = 0;
  for (const row of rows) {
    const props = row.properties;
    const expected = props.Standort?.select?.name === "Urlaub" ? (props.Stunden?.number ?? 0) / 8 : 0;
    const result = props[VACATION_DAY_PROPERTY]?.formula;
    if (result?.type !== "number" || typeof result.number !== "number" ||
        !Number.isFinite(result.number) || Math.abs(result.number - expected) > 1e-9) {
      throw new Error(`Urlaubstag verification failed for archive row ${row.id}`);
    }
    if (props.Datum?.date?.start?.slice(0, 4) === targetMonth.slice(0, 4)) total += result.number;
  }
  return { rows: rows.length, vacationDays: total };
}

async function applyMigrationPlan(plan, targetMonth, operations = {}) {
  const api = { ...notion, ...operations };
  // Recheck ownership just before writing, in case D1 changed since preflight.
  const currentWorker = workerReferencesFromD1(await api.getPage(plan.worker.rowId));
  for (const field of ["workerKey", "frontendPageId", "d4DatabaseId", "d4DataSourceId"]) {
    if (currentWorker[field] !== plan.worker[field]) throw new Error(`${plan.worker.name}: worker routing changed`);
  }
  const chartId = notion.richTextValue(currentWorker.row.properties?.["Urlaub Chart View ID"]).trim();
  if (normalizeNotionId(chartId) !== normalizeNotionId(plan.chart.id)) throw new Error("Worker chart reference changed");
  assertWorkerDataSourceReference(currentWorker, "d4", await api.getDataSource(currentWorker.d4DataSourceId), {
    schema: assertDayDataSource,
  });
  assertWorkerDatabaseReference(currentWorker, "d4", await api.getDatabase(currentWorker.d4DatabaseId), {
    expectedParentPageId: currentWorker.frontendPageId,
  });
  const source = await ensureArchiveSchema(currentWorker.d4DataSourceId, api);
  for (const previous of plan.tables) {
    const view = await api.getView(previous.id);
    if (view.name !== previous.name || view.type !== "table" ||
        normalizeNotionId(view.data_source_id) !== normalizeNotionId(source.id)) {
      throw new Error(`Archive view ${view.id} changed since preflight`);
    }
    const payload = archiveColumnUpdate(source, view);
    if (!columnsMatch(source, view, payload.configuration.properties)) await api.updateView(view.id, payload);
    const verified = await api.getView(view.id);
    if (!columnsMatch(source, verified, payload.configuration.properties) ||
        JSON.stringify([view.filter, view.sorts, view.configuration?.group_by]) !==
        JSON.stringify([verified.filter, verified.sorts, verified.configuration?.group_by])) {
      throw new Error(`Archive view ${view.id} failed verification`);
    }
  }
  const chart = await api.getView(chartId);
  if (!isVacationChart(chart, source.id, { knownView: true })) throw new Error("Worker chart changed since preflight");
  const payload = vacationChartUpdate(chart, source, targetMonth);
  if (Object.keys(payload).length) await api.updateView(chart.id, payload);
  const verified = await api.getView(chart.id);
  if (verified.name !== chart.name || Object.keys(vacationChartUpdate(verified, source, targetMonth)).length) {
    throw new Error(`Vacation chart ${chart.id} failed verification`);
  }
  return verifyVacationRows(await api.queryAll(source.id), targetMonth);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply")) throw new Error("Usage: npm run migrate-vacation-days -- [--apply]");
  const { D1_DATA_SOURCE_ID } = notion.requireEnv("D1_DATA_SOURCE_ID");
  const plans = await buildMigrationPlans(D1_DATA_SOURCE_ID);
  console.log(`Validated ${plans.length} worker archive(s), including inactive workers.`);
  if (!args.includes("--apply")) {
    for (const plan of plans) console.log(`${plan.worker.name}: formula, Alle/Urlaub columns, vacation sum.`);
    console.log("Dry run only. Add --apply to migrate and verify.");
    return;
  }
  const targetMonth = berlinMonth();
  const failures = [];
  for (const plan of plans) {
    try {
      const result = await applyMigrationPlan(plan, targetMonth);
      console.log(`${plan.worker.name}: verified ${result.rows} rows; ${result.vacationDays} vacation days in ${targetMonth.slice(0, 4)}.`);
    } catch (error) {
      failures.push(`${plan.worker.name}: ${notion.errorMessage(error)}`);
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

if (require.main === module) main().catch((error) => {
  console.error(notion.errorMessage(error));
  process.exitCode = 1;
});

module.exports = { applyMigrationPlan, berlinMonth, buildMigrationPlans, verifyVacationRows };
