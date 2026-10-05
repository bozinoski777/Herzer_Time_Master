"use strict";

const notion = require("./notion");
const { reconcileSelectOptions } = require("./select-options");
const { assertArchiveDataSource, assertDayDataSource, assertVacationDayFormula } = require("./day-schemas");
const { assertFrontendIdentity, normalizeNotionId } = require("./worker-identity");
const {
  D1_WORKER_REFERENCE_SCHEMA, assertPageBelongsToWorkerRoute, assertUniqueWorkerReferences,
  assertWorkerDatabaseReference, assertWorkerDataSourceReference, missingWorkerReferences,
  workerReferencesFromD1,
} = require("./worker-database-references");
const { updateVacationChartForRollover } = require("./frontend-presentation");
const {
  FIRST_CARRYOVER_YEAR, carryoverProperties, carryoverRowsByYear, validYear,
} = require("./vacation-carryover-record");

const EMPLOYMENT_SCHEMA = Object.freeze({ Eintrittsdatum: "date", Austrittsdatum: "date" });
const YEAR_PROPERTY = "Urlaubsmitnahme Jahr";
const STATUS_PROPERTY = "Urlaubsmitnahme Status";
const ERROR_PROPERTY = "Urlaubsmitnahme Fehler";
const SNAPSHOT_PROPERTY = "Urlaubsmitnahme Berechnung";
const CARRYOVER_SCHEMA = Object.freeze({
  ...EMPLOYMENT_SCHEMA,
  [YEAR_PROPERTY]: "number", [STATUS_PROPERTY]: "select",
  [ERROR_PROPERTY]: "rich_text", [SNAPSHOT_PROPERTY]: "rich_text",
});
const BASE_SCHEMA = Object.freeze({
  "Vor- und Nachname": "title", Active: "checkbox", "Onboarding Status": "select",
  "Worker Key": "rich_text", "Frontend Page ID": "rich_text", Jahresurlaub: "number",
  ...D1_WORKER_REFERENCE_SCHEMA,
  "Current Month": "rich_text", "Last Archived Month": "rich_text",
  "Rollover Status": "select", "Rollover Manifest": "rich_text",
});
const STATUS_OPTIONS = [
  { name: "Running", color: "blue" }, { name: "Complete", color: "green" }, { name: "Error", color: "red" },
];
const ROUTING_FIELDS = ["d3DatabaseId", "d3DataSourceId", "d4DatabaseId", "d4DataSourceId"];
// Only floating-point noise is removed; fractional vacation is not rounded.
const EPSILON = 1e-9;
const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= EPSILON;
const cleanBalance = (value) => Math.abs(value) <= EPSILON ? 0 : value;
const rowText = (row, name) => notion.richTextValue(row.properties?.[name]).trim();

function berlinDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function calendarDate(property, label, required = true) {
  const value = property?.date;
  if (!value && !required) return "";
  if (!validDate(value?.start) || value.end || value.time_zone) {
    throw new Error(`${label} needs one real calendar date (YYYY-MM-DD)`);
  }
  return value.start;
}

function resolveRunConfiguration(environment = process.env, now = new Date()) {
  const currentDate = berlinDate(now);
  const currentYear = Number(currentDate.slice(0, 4));
  const event = environment.GITHUB_EVENT_NAME || "";
  const inputYear = (environment.VACATION_CARRYOVER_YEAR || "").trim();
  const targetWorker = (environment.VACATION_CARRYOVER_TARGET_WORKER || "").trim();
  const previewInput = environment.VACATION_CARRYOVER_PREVIEW || "false";
  if (!["true", "false"].includes(previewInput)) throw new Error("Preview must be true or false");
  if (event && event !== "workflow_dispatch" && (inputYear || targetWorker || previewInput === "true")) {
    throw new Error("Carryover inputs are allowed only for workflow_dispatch or a local manual run");
  }
  if (inputYear && !/^\d{4}$/.test(inputYear)) throw new Error("Ending year must contain four digits");
  const year = inputYear ? Number(inputYear) : currentYear - 1;
  if (event === "schedule" && (currentDate.slice(5, 7) !== "01" || year < FIRST_CARRYOVER_YEAR)) {
    return { year, currentDate, targetWorker, preview: false, skip: true };
  }
  if (currentYear <= FIRST_CARRYOVER_YEAR) {
    throw new Error("The first supported vacation year closes on January 1, 2027; preview and apply are available after that date");
  }
  if (!validYear(year) || year >= currentYear) {
    throw new Error(`Ending year must be a closed year from ${FIRST_CARRYOVER_YEAR} through ${currentYear - 1}`);
  }
  return { year, currentDate, targetWorker, preview: previewInput === "true", skip: false };
}

function employmentDates(worker) {
  const start = calendarDate(worker.row.properties.Eintrittsdatum, `${worker.name}: Eintrittsdatum`);
  const end = calendarDate(worker.row.properties.Austrittsdatum, `${worker.name}: Austrittsdatum`, false);
  if (end && end < start) throw new Error(`${worker.name}: Austrittsdatum is before Eintrittsdatum`);
  return { start, end };
}

function entitlementForYear(annualAllowance, start, end, year) {
  if (!Number.isFinite(annualAllowance) || annualAllowance < 0) {
    throw new Error("Jahresurlaub must be a manually entered non-negative number");
  }
  if (!validDate(start) || (end && (!validDate(end) || end < start)) || !validYear(year)) {
    throw new Error("Invalid employment dates or ending year");
  }
  let months = 0;
  for (let month = 1; month <= 12; month += 1) {
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const prefix = `${year}-${String(month).padStart(2, "0")}`;
    const first = `${prefix}-01`;
    const last = `${prefix}-${days}`;
    const from = start > first ? start : first;
    const to = end && end < last ? end : last;
    if (from <= to) months += (Number(to.slice(8)) - Number(from.slice(8)) + 1) / days;
  }
  const entitlement = annualAllowance * (months / 12);
  if (!Number.isFinite(entitlement)) throw new Error("Vacation entitlement is not finite");
  return entitlement;
}

function vacationTotal(rows, year) {
  const ids = new Set();
  const keys = new Set();
  const sources = new Set();
  let total = 0;
  for (const row of rows) {
    const datum = calendarDate(row.properties?.Datum, `D4 page ${row.id}: Datum`);
    const key = rowText(row, "Sync Key");
    const source = rowText(row, "Source Page ID");
    const pageId = normalizeNotionId(row.id);
    const sourceId = normalizeNotionId(source);
    if (!pageId || ids.has(pageId) || (key && keys.has(key)) || (sourceId && sources.has(sourceId))) {
      throw new Error(`D4 contains a duplicate page, Sync Key, or Source Page ID at ${row.id}`);
    }
    ids.add(pageId);
    if (key) keys.add(key);
    if (sourceId) sources.add(sourceId);
    if (Number(datum.slice(0, 4)) !== year) continue;
    const hours = row.properties.Stunden?.number ?? 0;
    const formula = row.properties.Urlaubstag?.formula;
    const expected = row.properties.Standort?.select?.name === "Urlaub" ? hours / 8 : 0;
    if (!Number.isFinite(hours) || formula?.type !== "number" || !close(formula.number, expected)) {
      throw new Error(`Urlaubstag formula verification failed for D4 page ${row.id}`);
    }
    total += formula.number;
  }
  if (!Number.isFinite(total)) throw new Error("Vacation total is not finite");
  return total;
}

function routing(worker) {
  return Object.fromEntries(ROUTING_FIELDS.map((field) => [field, normalizeNotionId(worker[field])]));
}

function buildSnapshot(worker, year, rows) {
  const { start, end } = employmentDates(worker);
  const annualAllowance = worker.row.properties.Jahresurlaub?.number;
  const entitlement = entitlementForYear(annualAllowance, start, end, year);
  const taken = vacationTotal(rows, year);
  const adjustment = cleanBalance(taken - entitlement);
  if (!Number.isFinite(adjustment * 8)) throw new Error("Carryover hours are not finite");
  return {
    version: 1, workerKey: worker.workerKey, d1RecordId: normalizeNotionId(worker.rowId),
    routing: routing(worker), year, start, end, annualAllowance, entitlement, taken, adjustment,
  };
}

function parseSnapshot(value, worker) {
  if (!value) return null;
  let snapshot;
  try { snapshot = JSON.parse(value); } catch { throw new Error(`${worker.name}: invalid carryover snapshot JSON`); }
  if (snapshot?.version !== 1 || snapshot.workerKey !== worker.workerKey ||
      snapshot.d1RecordId !== normalizeNotionId(worker.rowId) || !validYear(snapshot.year) ||
      !snapshot.routing || ROUTING_FIELDS.some((field) => snapshot.routing[field] !== routing(worker)[field])) {
    throw new Error(`${worker.name}: carryover snapshot does not match this worker or D3/D4 routing`);
  }
  const entitlement = entitlementForYear(snapshot.annualAllowance, snapshot.start, snapshot.end, snapshot.year);
  if (!close(snapshot.entitlement, entitlement) || !Number.isFinite(snapshot.taken) ||
      snapshot.adjustment !== cleanBalance(snapshot.taken - entitlement) ||
      !Number.isFinite(snapshot.adjustment * 8)) {
    throw new Error(`${worker.name}: carryover snapshot has an invalid calculation`);
  }
  return snapshot;
}

function carryoverState(worker) {
  const year = worker.row.properties[YEAR_PROPERTY]?.number ?? null;
  const status = worker.row.properties[STATUS_PROPERTY]?.select?.name || "";
  const snapshot = parseSnapshot(rowText(worker.row, SNAPSHOT_PROPERTY), worker);
  if ((year !== null && !validYear(year)) || (status && !STATUS_OPTIONS.some((option) => option.name === status)) ||
      (snapshot && snapshot.year !== year) || (year !== null && (!snapshot || !status)) ||
      (["Running", "Complete"].includes(status) && !snapshot)) {
    throw new Error(`${worker.name}: inconsistent carryover year/status/snapshot`);
  }
  return { year, status, snapshot };
}

function assertSequentialYear(worker, state, year, start) {
  if (state.year !== null && state.year > year) throw new Error(`${worker.name}: historical recalculation is not supported`);
  if (state.year === year) return;
  const firstYear = Math.max(FIRST_CARRYOVER_YEAR, Number(start.slice(0, 4)));
  if ((state.year !== null && state.status !== "Complete") ||
      (year > firstYear && (state.year !== year - 1 || state.status !== "Complete"))) {
    throw new Error(`${worker.name}: complete the preceding carryover year before ${year}; recover missed years in order`);
  }
}

function assertDecemberClosed(worker, year, d3Rows) {
  const currentMonth = rowText(worker.row, "Current Month");
  const lastArchived = rowText(worker.row, "Last Archived Month");
  const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
  if (!monthPattern.test(currentMonth) || currentMonth < `${year + 1}-01` ||
      !monthPattern.test(lastArchived) || lastArchived < `${year}-12` ||
      worker.row.properties["Rollover Status"]?.select?.name !== "Ready" ||
      rowText(worker.row, "Rollover Manifest")) {
    throw new Error(`${worker.name}: December ${year} rollover is not verified complete; retry after Month Rollover`);
  }
  for (const row of d3Rows) {
    assertPageBelongsToWorkerRoute(row, worker, "d3");
    if (calendarDate(row.properties?.Datum, `D3 page ${row.id}: Datum`) < `${year + 1}-01-01`) {
      throw new Error(`${worker.name}: ending-year entries remain in D3; finish Month Rollover first`);
    }
  }
}

function workerFromRow(row) {
  return {
    ...workerReferencesFromD1(row),
    active: row.properties.Active?.checkbox === true,
    onboardingStatus: row.properties["Onboarding Status"]?.select?.name || "",
  };
}

function selectWorkers(workers, targetWorker) {
  if (!targetWorker) return workers.filter((worker) => worker.active && worker.onboardingStatus === "Ready");
  const matches = workers.filter((worker) => worker.workerKey === targetWorker || worker.name === targetWorker);
  if (matches.length !== 1) throw new Error(`Carryover target must match exactly one Worker Key or name; found ${matches.length}`);
  if (!matches[0].active || matches[0].onboardingStatus !== "Ready") {
    throw new Error(`${matches[0].name}: carryover target must be active and Ready`);
  }
  return matches;
}

function assertOptionalSchema(dataSource) {
  for (const [name, type] of Object.entries(CARRYOVER_SCHEMA)) {
    if (dataSource.properties[name] && dataSource.properties[name].type !== type) {
      throw new Error(`D1 property "${name}" must be ${type}`);
    }
  }
}

async function ensureD1CarryoverSchema(d1Id, operations = {}) {
  const api = { ...notion, ...operations };
  let source = await api.getDataSource(d1Id);
  notion.assertPropertyTypes(source, BASE_SCHEMA);
  assertOptionalSchema(source);
  const additions = {};
  for (const [name, type] of Object.entries(CARRYOVER_SCHEMA)) {
    if (!source.properties[name]) additions[name] = { [type]: type === "number" ? { format: "number" } : {} };
  }
  const options = source.properties[STATUS_PROPERTY]?.select?.options || [];
  if (STATUS_OPTIONS.some((option) => !options.some((current) => current.name === option.name))) {
    additions[STATUS_PROPERTY] = { select: { options: reconcileSelectOptions(options, STATUS_OPTIONS, { retainExisting: true }) } };
  }
  if (Object.keys(additions).length) {
    await api.updateDataSource(d1Id, additions);
    source = await api.getDataSource(d1Id);
  }
  notion.assertPropertyTypes(source, { ...BASE_SCHEMA, ...CARRYOVER_SCHEMA });
  const id = source.properties[SNAPSHOT_PROPERTY].id;
  const references = await api.listAllViews(notion.databaseIdFromDataSource(source));
  for (const reference of references) {
    const view = await api.getView(reference.id);
    if (view.type !== "table" || normalizeNotionId(view.data_source_id) !== normalizeNotionId(d1Id)) continue;
    const existing = notion.writableViewProperties(source, view.configuration?.properties || []);
    if (existing.some((property) => property.property_id === id && property.visible === false)) continue;
    const properties = existing.map((property) => property.property_id === id ? { ...property, visible: false } : property);
    if (!properties.some((property) => property.property_id === id)) properties.push({ property_id: id, visible: false });
    await api.updateView(view.id, { configuration: { type: "table", properties } });
  }
  return source;
}

async function validateWorkerRoute(worker, api) {
  const missing = missingWorkerReferences(worker, { requireFrontend: true });
  if (missing.length) throw new Error(`${worker.name}: missing ${missing.join(", ")}`);
  const frontend = await api.getPage(worker.frontendPageId);
  assertFrontendIdentity(frontend, worker);
  if (rowText(frontend, "Worker Key") !== worker.workerKey ||
      normalizeNotionId(rowText(frontend, "D1 Record ID")) !== normalizeNotionId(worker.rowId)) {
    throw new Error(`${worker.name}: frontend lacks this worker's exact identity`);
  }
  let archiveSource;
  for (const role of ["d3", "d4"]) {
    const database = await api.getDatabase(worker[`${role}DatabaseId`]);
    assertWorkerDatabaseReference(worker, role, database, { expectedParentPageId: worker.frontendPageId });
    const source = await api.getDataSource(worker[`${role}DataSourceId`]);
    assertWorkerDataSourceReference(worker, role, source, { schema: role === "d3" ? assertDayDataSource : assertArchiveDataSource });
    if (role === "d4") {
      assertVacationDayFormula(source);
      if (!source.properties.Standort.select?.options?.some((option) => option.name === "Urlaub")) {
        throw new Error(`${worker.name}: D4 lacks the Urlaub Standort option`);
      }
      archiveSource = source;
    }
  }
  return archiveSource;
}

function verifyBalance(rows, worker, snapshot) {
  const carryovers = carryoverRowsByYear(rows, worker);
  const row = carryovers.get(snapshot.year);
  if (snapshot.adjustment === 0) {
    if (row) throw new Error(`${worker.name}: zero balance has an unexpected Urlaubsmitnahme page`);
    return;
  }
  if (!row || !close(row.properties.Stunden.number, snapshot.adjustment * 8) ||
      row.properties.Urlaubstag?.formula?.type !== "number" ||
      !close(row.properties.Urlaubstag.formula.number, snapshot.adjustment)) {
    throw new Error(`${worker.name}: Urlaubsmitnahme readback does not match the saved calculation`);
  }
  assertPageBelongsToWorkerRoute(row, worker, "d4", { description: "Urlaubsmitnahme page" });
}

async function processWorker(originalWorker, run, operations = {}) {
  const api = { ...notion, ...operations };
  const worker = workerFromRow(await api.getPage(originalWorker.rowId));
  if (normalizeNotionId(worker.rowId) !== normalizeNotionId(originalWorker.rowId) ||
      worker.workerKey !== originalWorker.workerKey || worker.frontendPageId !== originalWorker.frontendPageId ||
      ROUTING_FIELDS.some((field) => normalizeNotionId(worker[field]) !== normalizeNotionId(originalWorker[field]))) {
    throw new Error(`${originalWorker.name}: worker routing changed since registry validation`);
  }
  if (!worker.active || worker.onboardingStatus !== "Ready") throw new Error(`${worker.name}: worker is no longer active and Ready`);
  const { start, end } = employmentDates(worker);
  if (start > `${run.year}-12-31` || (end && end < `${run.year + 1}-01-01`)) {
    return { worker: worker.name, result: "ineligible" };
  }
  const state = carryoverState(worker);
  assertSequentialYear(worker, state, run.year, start);
  const archiveSource = await validateWorkerRoute(worker, api);
  const rows = await api.queryAll(worker.d4DataSourceId);
  for (const row of rows) assertPageBelongsToWorkerRoute(row, worker, "d4");
  const carryovers = carryoverRowsByYear(rows, worker);
  if (state.status === "Complete" && state.snapshot) verifyBalance(rows, worker, state.snapshot);
  if (state.year === run.year && state.status === "Complete") {
    return { worker: worker.name, result: "already complete", ...state.snapshot };
  }
  assertDecemberClosed(worker, run.year, await api.queryAll(worker.d3DataSourceId));
  // Validate formulas even when resuming, but keep the saved annual allowance
  // and result: a January allowance edit must not rewrite a committed balance.
  const taken = vacationTotal(rows, run.year);
  const snapshot = state.year === run.year && state.snapshot ? state.snapshot : buildSnapshot(worker, run.year, rows);
  if (!close(taken, snapshot.taken)) {
    throw new Error(`${worker.name}: ending-year vacation total changed since the calculation checkpoint; review the saved balance before retrying`);
  }
  const existing = carryovers.get(run.year);
  if (existing) verifyBalance(rows, worker, snapshot);
  if (run.preview) return { worker: worker.name, result: "preview", ...snapshot };

  await api.updatePage(worker.rowId, {
    [YEAR_PROPERTY]: { number: run.year }, [STATUS_PROPERTY]: notion.select("Running"),
    [ERROR_PROPERTY]: notion.richText(""), [SNAPSHOT_PROPERTY]: notion.richText(JSON.stringify(snapshot)),
  });
  const savedWorker = workerFromRow(await api.getPage(worker.rowId));
  const saved = carryoverState(savedWorker);
  if (saved.year !== run.year || saved.status !== "Running" || JSON.stringify(saved.snapshot) !== JSON.stringify(snapshot)) {
    throw new Error(`${worker.name}: calculation checkpoint verification failed`);
  }
  if (snapshot.adjustment !== 0 && !existing) {
    await api.createPage(
      { type: "data_source_id", data_source_id: worker.d4DataSourceId },
      carryoverProperties(worker.workerKey, run.year, snapshot.adjustment),
    );
  }
  verifyBalance(await api.queryAll(worker.d4DataSourceId), worker, snapshot);
  const chartId = rowText(worker.row, "Urlaub Chart View ID");
  if (chartId) {
    await updateVacationChartForRollover(chartId, worker.d4DataSourceId, `${run.currentDate.slice(0, 4)}-01`, {
      ...api, ensureArchiveSchema: async () => archiveSource,
    });
  }
  await api.updatePage(worker.rowId, { [STATUS_PROPERTY]: notion.select("Complete"), [ERROR_PROPERTY]: notion.richText("") });
  const completed = carryoverState(workerFromRow(await api.getPage(worker.rowId)));
  if (completed.year !== run.year || completed.status !== "Complete" || JSON.stringify(completed.snapshot) !== JSON.stringify(snapshot)) {
    throw new Error(`${worker.name}: carryover completion verification failed`);
  }
  return { worker: worker.name, result: "complete", ...snapshot };
}

async function runCarryover(d1Id, run, operations = {}, reservedDataSources = []) {
  if (run.skip) return [];
  const api = { ...notion, ...operations };
  const d1 = await api.getDataSource(d1Id);
  if (normalizeNotionId(d1.id) !== normalizeNotionId(d1Id)) throw new Error("Retrieved D1 does not match configured D1");
  notion.assertPropertyTypes(d1, BASE_SCHEMA);
  assertOptionalSchema(d1);
  const workers = (await api.queryAll(d1Id)).map(workerFromRow);
  assertUniqueWorkerReferences(workers, {
    reservedDataSources: [d1Id, ...reservedDataSources],
    reservedDatabases: [notion.databaseIdFromDataSource(d1)],
  });
  const selected = selectWorkers(workers, run.targetWorker);
  if (!run.preview) await ensureD1CarryoverSchema(d1Id, api);
  const results = [];
  const failures = [];
  for (const worker of selected) {
    try {
      const result = await processWorker(worker, run, api);
      results.push(result);
      console.log(`${run.year} · ${worker.name}: ${result.result}` +
        (result.adjustment === undefined ? "" : `; entitlement ${result.entitlement}, vacation total ${result.taken}, adjustment ${result.adjustment} days`));
    } catch (failure) {
      const detail = notion.errorMessage(failure);
      let message = detail.startsWith(`${worker.name}:`) ? detail : `${worker.name}: ${detail}`;
      if (!run.preview) {
        try {
          const current = await api.getPage(worker.rowId);
          // A failed attempt for a later year must not revoke the preceding
          // year's completion marker, which is required for ordered recovery.
          const preserveComplete = current.properties[STATUS_PROPERTY]?.select?.name === "Complete" &&
            current.properties[YEAR_PROPERTY]?.number !== run.year;
          await api.updatePage(worker.rowId, {
            ...(!preserveComplete ? { [STATUS_PROPERTY]: notion.select("Error") } : {}),
            [ERROR_PROPERTY]: notion.richText(message),
          });
        } catch (markFailure) { message += `; could not record D1 error: ${notion.errorMessage(markFailure)}`; }
      }
      failures.push(message);
      console.error(message);
    }
  }
  if (failures.length) throw new Error(`${failures.length} carryover failure(s): ${failures.join(" | ")}`);
  return results;
}

async function main() {
  const run = resolveRunConfiguration();
  if (run.skip) { console.log("No annual carryover is due on this Berlin date."); return; }
  const { D1_DATA_SOURCE_ID: d1Id } = notion.requireEnv("D1_DATA_SOURCE_ID");
  await runCarryover(d1Id, run, {}, [process.env.D7_DATA_SOURCE_ID, process.env.D8_DATA_SOURCE_ID,
    process.env.EMPLOYEE_FRONTENDS_DATA_SOURCE_ID].filter(Boolean));
}

if (require.main === module) {
  main().catch((failure) => { console.error(notion.errorMessage(failure)); process.exitCode = 1; });
}

module.exports = {
  BASE_SCHEMA, CARRYOVER_SCHEMA, EMPLOYMENT_SCHEMA, YEAR_PROPERTY, STATUS_PROPERTY, ERROR_PROPERTY,
  SNAPSHOT_PROPERTY, assertDecemberClosed, berlinDate, buildSnapshot, carryoverState,
  ensureD1CarryoverSchema, entitlementForYear, parseSnapshot, processWorker, resolveRunConfiguration,
  runCarryover, selectWorkers, vacationTotal, workerFromRow,
};
