"use strict";

/**
 * Worker-facing presentation for the per-worker D3 and D4 databases.
 *
 * A database created through the Notion API starts with one table named
 * "Default view". These helpers update that one view instead of creating a
 * second view, which keeps provisioning resumable and avoids view duplicates.
 */

const {
  appendBlockChildren,
  assertPropertyTypes,
  createView,
  databaseIdFromDataSource,
  getDataSource,
  getView,
  listAllBlockChildren,
  listAllViews,
  updateDataSource,
  updateDatabase,
  updateView,
} = require("./notion");

const CURRENT_MONTH_DATABASE_TITLE = "Aktueller Monat";
const ARCHIVE_DATABASE_TITLE = "Archiv";
const ARCHIVE_MONTH_PROPERTY = "Monat";
const ARCHIVE_MONTH_FORMULA = 'formatDate(prop("Datum"), "YYYY-MM")';
const VACATION_CHART_TITLE = "Genommene Urlaubstage bis Ende letzten Monats";
// Kept only for crash recovery of a worker whose provisioning started on the
// immediately preceding template revision.
const LEGACY_VACATION_CHART_TITLE = "Urlaubstage bis Ende letzten Monats";

const DAY_SCHEMA = {
  Wochentag: "title",
  Datum: "date",
  Stunden: "number",
  Standort: "select",
};

const D3_VISIBLE_COLUMNS = ["Wochentag", "Datum", "Standort", "Stunden"];
const D4_VISIBLE_COLUMNS = ["Wochentag", "Datum", "Standort", "Stunden"];

function textItems(content) {
  return [{ type: "text", text: { content } }];
}

function validMonth(targetMonth) {
  if (!/^\d{4}-\d{2}$/.test(targetMonth || "")) return false;
  const month = Number(targetMonth.slice(5, 7));
  return month >= 1 && month <= 12;
}

function vacationFilter(targetMonth) {
  if (!validMonth(targetMonth)) throw new Error(`Invalid month "${targetMonth}"`);
  const year = Number(targetMonth.slice(0, 4));
  return {
    and: [
      { property: "Standort", select: { equals: "Urlaub" } },
      { property: "Datum", date: { on_or_after: `${year}-01-01` } },
      // An exclusive next-January boundary covers the complete calendar year,
      // including every day in December.
      { property: "Datum", date: { before: `${year + 1}-01-01` } },
    ],
  };
}

function vacationChartUsesCalendarYear(view, targetMonth) {
  if (!validMonth(targetMonth)) throw new Error(`Invalid month "${targetMonth}"`);
  const expectedRange = vacationFilter(targetMonth).and.filter((condition) => condition.property === "Datum");
  const actualRange = (view?.filter?.and || []).filter((condition) => condition.property === "Datum");

  return expectedRange.every((expected) => actualRange.some((actual) => (
    actual.date?.on_or_after === expected.date?.on_or_after &&
    actual.date?.before === expected.date?.before
  )));
}

function propertyId(dataSource, propertyName) {
  const property = dataSource.properties?.[propertyName];
  if (!property?.id) {
    throw new Error(`Data source ${dataSource.id} is missing property "${propertyName}"`);
  }
  return property.id;
}

function viewProperties(dataSource, visibleNames, hiddenNames = []) {
  const visible = new Set(visibleNames);
  const hidden = new Set(hiddenNames);
  return [...visibleNames, ...hiddenNames].map((name) => ({
    property_id: propertyId(dataSource, name),
    visible: visible.has(name) && !hidden.has(name),
  }));
}

function currentMonthViewPayload(dataSource) {
  assertPropertyTypes(dataSource, DAY_SCHEMA);
  return {
    sorts: [{ property: "Datum", direction: "ascending" }],
    configuration: {
      type: "table",
      properties: viewProperties(dataSource, D3_VISIBLE_COLUMNS),
      group_by: null,
    },
  };
}

function archiveViewPayload(dataSource) {
  assertPropertyTypes(dataSource, { ...DAY_SCHEMA, "Sync Key": "rich_text", [ARCHIVE_MONTH_PROPERTY]: "formula" });
  const monthPropertyId = propertyId(dataSource, ARCHIVE_MONTH_PROPERTY);
  return {
    sorts: [{ property: "Datum", direction: "descending" }],
    configuration: {
      type: "table",
      properties: viewProperties(dataSource, D4_VISIBLE_COLUMNS, ["Sync Key", ARCHIVE_MONTH_PROPERTY]),
      group_by: {
        type: "formula",
        property_id: monthPropertyId,
        group_by: {
          type: "text",
          group_by: "exact",
          sort: { type: "descending" },
        },
        hide_empty_groups: true,
      },
    },
  };
}

function vacationChartPayload(dataSource, targetMonth) {
  assertPropertyTypes(dataSource, DAY_SCHEMA);
  return {
    name: VACATION_CHART_TITLE,
    filter: vacationFilter(targetMonth),
    configuration: {
      type: "chart",
      chart_type: "number",
      value: { aggregator: "count" },
      x_axis: null,
      y_axis: null,
      x_axis_property_id: null,
      y_axis_property_id: null,
      stack_by: null,
      color_theme: "blue",
      height: "small",
      // Notion exposes only this show/hide toggle for a number chart title;
      // it does not expose a field for changing the generated "Count all" text.
      hide_title: false,
    },
  };
}

function directChildAfter(blocks, blockId) {
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index < 0) {
    throw new Error(`Could not find expected direct child block ${blockId} on the worker page`);
  }
  return blocks[index + 1];
}

async function ensureVacationDivider(workerPageId, d3DatabaseId) {
  let blocks = await listAllBlockChildren(workerPageId);
  let nextBlock = directChildAfter(blocks, d3DatabaseId);
  if (nextBlock?.type === "divider") return nextBlock.id;

  await appendBlockChildren(workerPageId, [{
    object: "block",
    type: "divider",
    divider: {},
  }], d3DatabaseId);

  blocks = await listAllBlockChildren(workerPageId);
  nextBlock = directChildAfter(blocks, d3DatabaseId);
  if (nextBlock?.type !== "divider") {
    throw new Error(`Could not recover the vacation KPI divider on worker page ${workerPageId}`);
  }
  return nextBlock.id;
}

async function defaultTableView(databaseId, dataSourceId) {
  const references = await listAllViews(databaseId);
  const views = await Promise.all(references.map((reference) => getView(reference.id)));
  const tableViews = views.filter(
    (view) => view.data_source_id === dataSourceId && view.type === "table",
  );
  const defaultViews = tableViews.filter((view) => view.name === "Default view");

  if (defaultViews.length === 1) return defaultViews[0];
  if (defaultViews.length > 1) {
    throw new Error(`Database ${databaseId} has multiple table views named "Default view"`);
  }
  if (tableViews.length === 1) return tableViews[0];

  throw new Error(
    `Database ${databaseId} has no uniquely identifiable default table view; refusing to create or overwrite a view.`,
  );
}

async function setDatabaseAndDataSourceTitle(databaseId, dataSourceId, databaseTitle) {
  // Database and data source titles are distinct in the current Notion API.
  // Set both so the visible label stays exact in either Notion surface.
  await updateDatabase(databaseId, { is_inline: true, title: textItems(databaseTitle) });
  await updateDataSource(dataSourceId, {}, { title: textItems(databaseTitle) });
}

function archiveSchemaProperties() {
  return {
    "Sync Key": { rich_text: {} },
    [ARCHIVE_MONTH_PROPERTY]: {
      formula: { expression: ARCHIVE_MONTH_FORMULA },
    },
  };
}

async function ensureArchiveSchema(dataSourceId) {
  let dataSource = await getDataSource(dataSourceId);
  assertPropertyTypes(dataSource, DAY_SCHEMA);

  const syncKey = dataSource.properties?.["Sync Key"];
  if (syncKey && syncKey.type !== "rich_text") {
    throw new Error(`D4 ${dataSourceId} property "Sync Key" is ${syncKey.type}, expected rich_text`);
  }

  const month = dataSource.properties?.[ARCHIVE_MONTH_PROPERTY];
  if (month && month.type !== "formula") {
    throw new Error(
      `D4 ${dataSourceId} property "${ARCHIVE_MONTH_PROPERTY}" is ${month.type}, expected formula`,
    );
  }

  const additions = {};
  if (!syncKey) additions["Sync Key"] = { rich_text: {} };
  if (!month || month.formula?.expression !== ARCHIVE_MONTH_FORMULA) {
    additions[ARCHIVE_MONTH_PROPERTY] = archiveSchemaProperties()[ARCHIVE_MONTH_PROPERTY];
  }

  if (Object.keys(additions).length > 0) {
    await updateDataSource(dataSourceId, additions);
    dataSource = await getDataSource(dataSourceId);
  }

  assertPropertyTypes(dataSource, {
    ...DAY_SCHEMA,
    "Sync Key": "rich_text",
    [ARCHIVE_MONTH_PROPERTY]: "formula",
  });
  return dataSource;
}

async function configureCurrentMonthView(databaseId, dataSourceId) {
  const dataSource = await getDataSource(dataSourceId);
  const view = await defaultTableView(databaseId, dataSourceId);
  await updateView(view.id, currentMonthViewPayload(dataSource));
}

async function configureArchiveView(databaseId, dataSourceId) {
  const dataSource = await ensureArchiveSchema(dataSourceId);
  const view = await defaultTableView(databaseId, dataSourceId);
  await updateView(view.id, archiveViewPayload(dataSource));
}

async function ensureCurrentMonthPresentation(databaseId, dataSourceId) {
  await setDatabaseAndDataSourceTitle(databaseId, dataSourceId, CURRENT_MONTH_DATABASE_TITLE);
  await configureCurrentMonthView(databaseId, dataSourceId);
}

async function ensureArchivePresentation(databaseId, dataSourceId) {
  await setDatabaseAndDataSourceTitle(databaseId, dataSourceId, ARCHIVE_DATABASE_TITLE);
  await configureArchiveView(databaseId, dataSourceId);
}

function isVacationChart(view, dataSourceId) {
  return (
    view?.data_source_id === dataSourceId &&
    view.type === "chart" &&
    [VACATION_CHART_TITLE, LEGACY_VACATION_CHART_TITLE].includes(view.name)
  );
}

async function recoverVacationChartFromWorkerPage(workerPageId, dataSourceId) {
  const databaseBlocks = (await listAllBlockChildren(workerPageId)).filter(
    (block) => block.type === "child_database",
  );
  const candidates = [];

  for (const databaseBlock of databaseBlocks) {
    const references = await listAllViews(databaseBlock.id);
    const views = await Promise.all(references.map((reference) => getView(reference.id)));
    candidates.push(...views.filter((view) => isVacationChart(view, dataSourceId)));
  }

  if (candidates.length > 1) {
    throw new Error(
      `Worker page ${workerPageId} has multiple "${VACATION_CHART_TITLE}" chart views; refusing to create another.`,
    );
  }
  return candidates[0];
}

async function ensureVacationChart(
  workerPageId,
  insertAfterBlockId,
  d4DataSourceId,
  targetMonth,
  knownViewId = "",
) {
  const dataSource = await getDataSource(d4DataSourceId);
  const payload = vacationChartPayload(dataSource, targetMonth);
  let view;

  if (knownViewId) {
    view = await getView(knownViewId);
    if (!isVacationChart(view, d4DataSourceId)) {
      throw new Error(`D1 Urlaub chart view ${knownViewId} does not match the worker D4 data source`);
    }
  } else {
    view = await recoverVacationChartFromWorkerPage(workerPageId, d4DataSourceId);
  }

  if (view) {
    await updateView(view.id, payload);
    return view.id;
  }

  const created = await createView({
    data_source_id: d4DataSourceId,
    name: VACATION_CHART_TITLE,
    type: "chart",
    create_database: {
      parent: { type: "page_id", page_id: workerPageId },
      position: { type: "after_block", block_id: insertAfterBlockId },
    },
    ...payload,
  });
  return created.id;
}

async function updateVacationChartForRollover(viewId, d4DataSourceId, targetMonth) {
  if (!viewId) return false;
  const view = await getView(viewId);
  if (!isVacationChart(view, d4DataSourceId)) {
    throw new Error(`D1 Urlaub chart view ${viewId} does not match the worker D4 data source`);
  }
  if (vacationChartUsesCalendarYear(view, targetMonth)) return false;
  const dataSource = await getDataSource(d4DataSourceId);
  await updateView(view.id, vacationChartPayload(dataSource, targetMonth));
  return true;
}

function managementViewProperties(dataSource, configuration = {}) {
  const hiddenNames = new Set(["Worker Key", "D1 Record ID"]);
  const hiddenIds = new Set(
    [...hiddenNames].map((name) => propertyId(dataSource, name)),
  );
  const existing = configuration.properties || [];
  const seen = new Set();
  const properties = existing.map((entry) => {
    const isHidden = hiddenIds.has(entry.property_id) || hiddenNames.has(entry.property_id);
    seen.add(entry.property_id);
    return { ...entry, ...(isHidden ? { visible: false } : {}) };
  });

  for (const property of Object.values(dataSource.properties || {})) {
    if (seen.has(property.id) || seen.has(property.name)) continue;
    properties.push({ property_id: property.id, visible: !hiddenNames.has(property.name) });
  }
  return properties;
}

/** Hide internal columns in the private Employee Front-ends table view. This
 * affects table presentation only; Notion's public API has no page-property
 * layout endpoint, so it cannot hide properties on an opened row page. */
async function hideInternalFrontendColumnsInManagementView(dataSourceId) {
  const dataSource = await getDataSource(dataSourceId);
  assertPropertyTypes(dataSource, {
    "Vor- und Nachname": "title",
    "Worker Key": "rich_text",
    "D1 Record ID": "rich_text",
  });
  const databaseId = databaseIdFromDataSource(dataSource);
  const view = await defaultTableView(databaseId, dataSourceId);
  await updateView(view.id, {
    configuration: {
      ...(view.configuration || {}),
      type: "table",
      properties: managementViewProperties(dataSource, view.configuration || {}),
    },
  });
}

module.exports = {
  ARCHIVE_DATABASE_TITLE,
  ARCHIVE_MONTH_FORMULA,
  ARCHIVE_MONTH_PROPERTY,
  CURRENT_MONTH_DATABASE_TITLE,
  LEGACY_VACATION_CHART_TITLE,
  VACATION_CHART_TITLE,
  archiveSchemaProperties,
  archiveViewPayload,
  configureArchiveView,
  configureCurrentMonthView,
  currentMonthViewPayload,
  ensureArchivePresentation,
  ensureArchiveSchema,
  ensureCurrentMonthPresentation,
  ensureVacationDivider,
  ensureVacationChart,
  hideInternalFrontendColumnsInManagementView,
  managementViewProperties,
  updateVacationChartForRollover,
  vacationChartPayload,
  vacationChartUsesCalendarYear,
  vacationFilter,
};
