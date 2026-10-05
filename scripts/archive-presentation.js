"use strict";

const {
  createView,
  getDataSource,
  getView,
  listAllViews,
  updateDataSource,
  updateView,
  writableViewProperties,
} = require("./notion");
const {
  D4_PROPERTY_TYPES,
  VACATION_DAY_PROPERTY,
  archiveFormulaProperties,
  assertVacationDayFormula,
  archiveMetadataProperties,
  assertArchiveDataSource,
  assertDayDataSource,
} = require("./day-schemas");
const {
  propertyId,
  setDatabaseAndDataSourceTitle,
  viewProperties,
} = require("./database-presentation");

const LEGACY_ARCHIVE_DATABASE_TITLE = "Archiv";
const ARCHIVE_ALL_VIEW_TITLE = "Alle";
const ARCHIVE_VACATION_VIEW_TITLE = "Urlaub";
const D4_VISIBLE_COLUMNS = ["Wochentag", "Datum", "Standort", "Stunden"];

function archiveDatabaseTitle(workerName) {
  const name = String(workerName || "").trim();
  if (!name) throw new Error("An archive database title requires a worker name");
  return `${name}s Archiv`;
}

function archiveHiddenColumns(dataSource) {
  // Older archives can keep their unused Monat formula without exposing it.
  return ["Sync Key", "Source Page ID", ...(dataSource.properties?.Monat ? ["Monat"] : [])];
}

function canonicalPropertyId(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function archiveViewPayload(dataSource) {
  assertArchiveDataSource(dataSource);
  return {
    sorts: [{ property: "Datum", direction: "descending" }],
    configuration: {
      type: "table",
      properties: viewProperties(
        dataSource,
        D4_VISIBLE_COLUMNS,
        [VACATION_DAY_PROPERTY, ...archiveHiddenColumns(dataSource)],
      ),
      group_by: {
        type: "date",
        property_id: propertyId(dataSource, "Datum"),
        group_by: "month",
        sort: { type: "descending" },
        hide_empty_groups: true,
      },
    },
  };
}

function archiveVacationViewPayload(dataSource) {
  assertArchiveDataSource(dataSource);
  const options = dataSource.properties.Standort.select?.options || [];
  if (!options.some((option) => option.name === ARCHIVE_VACATION_VIEW_TITLE)) {
    throw new Error(
      `D4 ${dataSource.id} needs the Standort select option "Urlaub" before creating its Urlaub view`,
    );
  }
  return {
    name: ARCHIVE_VACATION_VIEW_TITLE,
    filter: { property: "Standort", select: { equals: "Urlaub" } },
    sorts: [{ property: "Datum", direction: "descending" }],
    configuration: {
      type: "table",
      properties: viewProperties(
        dataSource,
        ["Wochentag", "Datum", "Standort", VACATION_DAY_PROPERTY],
        ["Stunden", ...archiveHiddenColumns(dataSource)],
      ),
      group_by: {
        type: "date",
        property_id: propertyId(dataSource, "Datum"),
        group_by: "year",
        sort: { type: "descending" },
        hide_empty_groups: true,
      },
    },
  };
}

async function archivePrimaryTableView(databaseId, dataSourceId, operations = {}) {
  const listViews = operations.listAllViews || listAllViews;
  const retrieveView = operations.getView || getView;
  const views = await Promise.all(
    (await listViews(databaseId)).map((reference) => retrieveView(reference.id)),
  );
  const candidates = views.filter((view) =>
    view.type === "table" && view.data_source_id === dataSourceId &&
    view.name !== ARCHIVE_VACATION_VIEW_TITLE);
  const allViews = candidates.filter((view) => view.name === ARCHIVE_ALL_VIEW_TITLE);
  const defaults = candidates.filter((view) => view.name === "Default view");
  if (allViews.length > 1 || defaults.length > 1 || (allViews.length && defaults.length)) {
    throw new Error(`D4 database ${databaseId} has ambiguous main archive table views`);
  }
  if (allViews.length === 1) return allViews[0];
  if (defaults.length === 1) return defaults[0];
  if (candidates.length === 1) return candidates[0];
  throw new Error(
    `D4 database ${databaseId} has no uniquely identifiable main archive table view`,
  );
}

function archiveVacationViewMatches(view, payload, dataSource) {
  if (view.name !== ARCHIVE_VACATION_VIEW_TITLE || view.type !== "table" ||
      view.data_source_id !== dataSource.id) return false;
  const propertyReferenceMatches = (actual, name) =>
    actual === name || canonicalPropertyId(actual) === canonicalPropertyId(propertyId(dataSource, name));
  if (!propertyReferenceMatches(view.filter?.property, "Standort") ||
      view.filter?.select?.equals !== "Urlaub") return false;
  if (!propertyReferenceMatches(view.sorts?.[0]?.property, "Datum") ||
      view.sorts?.[0]?.direction !== "descending") return false;
  const group = view.configuration?.group_by;
  if (group?.type !== "date" ||
      canonicalPropertyId(group.property_id) !== canonicalPropertyId(propertyId(dataSource, "Datum")) ||
      group.group_by !== "year" || group.sort?.type !== "descending" ||
      group.hide_empty_groups !== true) return false;

  const expected = payload.configuration.properties;
  const actual = view.configuration?.properties || [];
  const actualById = new Map(actual.map((entry) => [
    canonicalPropertyId(entry.property_id), entry,
  ]));
  return expected.every((entry) => {
    const current = actualById.get(canonicalPropertyId(entry.property_id));
    return current && (entry.visible ? current.visible !== false : current.visible === false);
  });
}

async function ensureArchiveVacationView(databaseId, dataSourceId, operations = {}) {
  const retrieveDataSource = operations.getDataSource || getDataSource;
  const listViews = operations.listAllViews || listAllViews;
  const retrieveView = operations.getView || getView;
  const create = operations.createView || createView;
  const update = operations.updateView || updateView;
  const dataSource = await retrieveDataSource(dataSourceId);
  const payload = archiveVacationViewPayload(dataSource);
  const views = await Promise.all(
    (await listViews(databaseId)).map((reference) => retrieveView(reference.id)),
  );
  const matches = views.filter((view) => view.name === ARCHIVE_VACATION_VIEW_TITLE);
  if (matches.length > 1) {
    throw new Error(`D4 database ${databaseId} has multiple "Urlaub" views`);
  }
  const existing = matches[0];
  if (existing) {
    if (existing.type !== "table" || existing.data_source_id !== dataSourceId) {
      throw new Error(`D4 database ${databaseId} has an incompatible "Urlaub" view`);
    }
    if (!archiveVacationViewMatches(existing, payload, dataSource)) {
      await update(existing.id, payload);
    }
    return existing.id;
  }
  const created = await create({
    database_id: databaseId,
    data_source_id: dataSourceId,
    name: ARCHIVE_VACATION_VIEW_TITLE,
    type: "table",
    ...payload,
  });
  return created.id;
}

async function ensureArchiveSchema(dataSourceId, operations = {}) {
  const retrieveDataSource = operations.getDataSource || getDataSource;
  const updateSchema = operations.updateDataSource || updateDataSource;
  let dataSource = await retrieveDataSource(dataSourceId);
  assertDayDataSource(dataSource);
  assertVacationDayFormula(dataSource, { allowMissing: true });

  const syncKey = dataSource.properties?.["Sync Key"];
  if (syncKey && syncKey.type !== "rich_text") {
    throw new Error(`D4 ${dataSourceId} property "Sync Key" is ${syncKey.type}, expected rich_text`);
  }

  const sourcePageId = dataSource.properties?.["Source Page ID"];
  if (sourcePageId && sourcePageId.type !== "rich_text") {
    throw new Error(`D4 ${dataSourceId} property "Source Page ID" is ${sourcePageId.type}, expected rich_text`);
  }

  const additions = {};
  if (!dataSource.properties[VACATION_DAY_PROPERTY]) {
    Object.assign(additions, archiveFormulaProperties());
  }
  const metadata = archiveMetadataProperties();
  if (!syncKey) additions["Sync Key"] = metadata["Sync Key"];
  if (!sourcePageId) additions["Source Page ID"] = metadata["Source Page ID"];

  if (Object.keys(additions).length > 0) {
    await updateSchema(dataSourceId, additions);
    dataSource = await retrieveDataSource(dataSourceId);
  }

  assertArchiveDataSource(dataSource);
  assertVacationDayFormula(dataSource);
  return dataSource;
}

// Change only column presentation on existing views. Preserve filters, groups,
// sorts, widths, and any unrelated settings configured by management.
function archiveColumnUpdate(dataSource, view) {
  const vacation = view.name === ARCHIVE_VACATION_VIEW_TITLE;
  const payload = vacation ? archiveVacationViewPayload(dataSource) : archiveViewPayload(dataSource);
  const existing = writableViewProperties(dataSource, view.configuration?.properties || []);
  const expected = payload.configuration.properties;
  const managedIds = new Set(expected.map((entry) => entry.property_id));
  const properties = expected.map((entry) => ({
    ...existing.find((current) => current.property_id === entry.property_id),
    ...entry,
  }));
  properties.push(...existing.filter((entry) => !managedIds.has(entry.property_id)));
  return { configuration: { type: "table", properties } };
}

async function configureArchiveView(databaseId, dataSourceId, operations = {}) {
  const ensureSchema = operations.ensureArchiveSchema || ensureArchiveSchema;
  const update = operations.updateView || updateView;
  const dataSource = await ensureSchema(dataSourceId);
  const view = await archivePrimaryTableView(databaseId, dataSourceId, operations);
  await update(view.id, { name: ARCHIVE_ALL_VIEW_TITLE, ...archiveViewPayload(dataSource) });
}

async function ensureArchivePresentation(databaseId, dataSourceId, databaseTitle) {
  // Maintenance of an existing archive must not rename it. Onboarding passes
  // the worker-specific title explicitly when it creates or recovers D4.
  if (databaseTitle) await setDatabaseAndDataSourceTitle(databaseId, dataSourceId, databaseTitle);
  await configureArchiveView(databaseId, dataSourceId);
}

module.exports = {
  LEGACY_ARCHIVE_DATABASE_TITLE,
  ARCHIVE_ALL_VIEW_TITLE,
  ARCHIVE_VACATION_VIEW_TITLE,
  D4_PROPERTY_TYPES,
  archiveDatabaseTitle,
  archiveColumnUpdate,
  archiveSchemaProperties: archiveMetadataProperties,
  archiveViewPayload,
  archiveVacationViewPayload,
  archivePrimaryTableView,
  configureArchiveView,
  ensureArchivePresentation,
  ensureArchiveSchema,
  ensureArchiveVacationView,
};
