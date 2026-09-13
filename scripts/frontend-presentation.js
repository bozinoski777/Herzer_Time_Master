"use strict";

/**
 * Worker-facing presentation for the per-worker D3 and D4 databases.
 *
 * A database created through the Notion API starts with one table named
 * "Default view". These helpers update that one view instead of creating a
 * second view, which keeps provisioning resumable and avoids view duplicates.
 */

const {
  assertPropertyTypes,
  databaseIdFromDataSource,
  getDataSource,
  getDatabase,
  getView,
  listAllViews,
  plainText,
  updateDataSource,
  updateDatabase,
  updateView,
} = require("./notion");

const CURRENT_MONTH_DATABASE_TITLE = "Aktueller Monat";
const ARCHIVE_DATABASE_TITLE = "Archiv";
const ARCHIVE_MONTH_PROPERTY = "Monat";
const ARCHIVE_MONTH_FORMULA = 'formatDate(prop("Datum"), "YYYY-MM")';

const DAY_SCHEMA = {
  Wochentag: "title",
  Datum: "date",
  Stunden: "number",
  Tagtyp: "select",
  Standort: "select",
};

const D3_VISIBLE_COLUMNS = ["Wochentag", "Datum", "Standort", "Stunden", "Tagtyp"];
const D4_VISIBLE_COLUMNS = ["Wochentag", "Datum", "Standort", "Stunden", "Tagtyp"];

function textItems(content) {
  return [{ type: "text", text: { content } }];
}

function validMonth(targetMonth) {
  if (!/^\d{4}-\d{2}$/.test(targetMonth || "")) return false;
  const month = Number(targetMonth.slice(5, 7));
  return month >= 1 && month <= 12;
}

function monthBounds(targetMonth) {
  if (!validMonth(targetMonth)) throw new Error(`Invalid month "${targetMonth}"`);

  const year = Number(targetMonth.slice(0, 4));
  const month = Number(targetMonth.slice(5, 7));
  const next = new Date(Date.UTC(year, month, 1));
  const nextMonth = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`;

  return { firstDay: `${targetMonth}-01`, nextMonth };
}

function currentMonthFilter(targetMonth) {
  const { firstDay, nextMonth } = monthBounds(targetMonth);
  return {
    and: [
      { property: "Datum", date: { on_or_after: firstDay } },
      { property: "Datum", date: { before: nextMonth } },
    ],
  };
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

function currentMonthViewPayload(dataSource, targetMonth) {
  assertPropertyTypes(dataSource, DAY_SCHEMA);
  return {
    filter: currentMonthFilter(targetMonth),
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

async function configureCurrentMonthView(databaseId, dataSourceId, targetMonth) {
  const dataSource = await getDataSource(dataSourceId);
  const view = await defaultTableView(databaseId, dataSourceId);
  await updateView(view.id, currentMonthViewPayload(dataSource, targetMonth));
}

async function configureArchiveView(databaseId, dataSourceId) {
  const dataSource = await ensureArchiveSchema(dataSourceId);
  const view = await defaultTableView(databaseId, dataSourceId);
  await updateView(view.id, archiveViewPayload(dataSource));
}

async function ensureCurrentMonthPresentation(databaseId, dataSourceId, targetMonth) {
  await setDatabaseAndDataSourceTitle(databaseId, dataSourceId, CURRENT_MONTH_DATABASE_TITLE);
  await configureCurrentMonthView(databaseId, dataSourceId, targetMonth);
}

async function ensureArchivePresentation(databaseId, dataSourceId) {
  await setDatabaseAndDataSourceTitle(databaseId, dataSourceId, ARCHIVE_DATABASE_TITLE);
  await configureArchiveView(databaseId, dataSourceId);
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

/**
 * Rollover must update the D3's concrete date range, but it must not restyle
 * legacy D3 databases that pre-date this future-worker presentation. The exact
 * visible title is the migration marker written by onboarding.
 */
async function updateCurrentMonthViewForRollover(dataSourceId, targetMonth) {
  const dataSource = await getDataSource(dataSourceId);
  const databaseId = databaseIdFromDataSource(dataSource);
  const database = await getDatabase(databaseId);
  if (plainText(database.title) !== CURRENT_MONTH_DATABASE_TITLE) return false;

  const view = await defaultTableView(databaseId, dataSourceId);
  await updateView(view.id, currentMonthViewPayload(dataSource, targetMonth));
  return true;
}

module.exports = {
  ARCHIVE_DATABASE_TITLE,
  ARCHIVE_MONTH_FORMULA,
  ARCHIVE_MONTH_PROPERTY,
  CURRENT_MONTH_DATABASE_TITLE,
  archiveSchemaProperties,
  archiveViewPayload,
  configureArchiveView,
  configureCurrentMonthView,
  currentMonthFilter,
  currentMonthViewPayload,
  ensureArchivePresentation,
  ensureArchiveSchema,
  ensureCurrentMonthPresentation,
  hideInternalFrontendColumnsInManagementView,
  managementViewProperties,
  monthBounds,
  updateCurrentMonthViewForRollover,
};
