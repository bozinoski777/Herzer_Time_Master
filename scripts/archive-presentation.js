"use strict";

const {
  createView,
  getDataSource,
  getView,
  listAllViews,
  updateDataSource,
  updateView,
} = require("./notion");
const {
  ARCHIVE_MONTH_FORMULA,
  ARCHIVE_MONTH_PROPERTY,
  D4_PROPERTY_TYPES,
  archiveMetadataProperties,
  assertArchiveDataSource,
  assertDayDataSource,
} = require("./day-schemas");
const {
  propertyId,
  setDatabaseAndDataSourceTitle,
  viewProperties,
} = require("./database-presentation");

const ARCHIVE_DATABASE_TITLE = "Archiv";
const ARCHIVE_VACATION_VIEW_TITLE = "Urlaub";
const D4_VISIBLE_COLUMNS = ["Wochentag", "Datum", "Standort", "Stunden"];

function canonicalPropertyId(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function archiveViewPayload(dataSource) {
  assertArchiveDataSource(dataSource);
  const monthPropertyId = propertyId(dataSource, ARCHIVE_MONTH_PROPERTY);
  return {
    sorts: [{ property: "Datum", direction: "descending" }],
    configuration: {
      type: "table",
      properties: viewProperties(
        dataSource,
        D4_VISIBLE_COLUMNS,
        ["Sync Key", ARCHIVE_MONTH_PROPERTY],
      ),
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
        D4_VISIBLE_COLUMNS,
        ["Sync Key", ARCHIVE_MONTH_PROPERTY],
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
  const defaults = candidates.filter((view) => view.name === "Default view");
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

async function ensureArchiveSchema(dataSourceId) {
  let dataSource = await getDataSource(dataSourceId);
  assertDayDataSource(dataSource);

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
  const metadata = archiveMetadataProperties();
  if (!syncKey) additions["Sync Key"] = metadata["Sync Key"];
  if (!month || month.formula?.expression !== ARCHIVE_MONTH_FORMULA) {
    additions[ARCHIVE_MONTH_PROPERTY] = metadata[ARCHIVE_MONTH_PROPERTY];
  }

  if (Object.keys(additions).length > 0) {
    await updateDataSource(dataSourceId, additions);
    dataSource = await getDataSource(dataSourceId);
  }

  assertArchiveDataSource(dataSource);
  return dataSource;
}

async function configureArchiveView(databaseId, dataSourceId) {
  const dataSource = await ensureArchiveSchema(dataSourceId);
  const view = await archivePrimaryTableView(databaseId, dataSourceId);
  await updateView(view.id, archiveViewPayload(dataSource));
}

async function ensureArchivePresentation(databaseId, dataSourceId) {
  await setDatabaseAndDataSourceTitle(databaseId, dataSourceId, ARCHIVE_DATABASE_TITLE);
  await configureArchiveView(databaseId, dataSourceId);
}

module.exports = {
  ARCHIVE_DATABASE_TITLE,
  ARCHIVE_VACATION_VIEW_TITLE,
  ARCHIVE_MONTH_FORMULA,
  ARCHIVE_MONTH_PROPERTY,
  D4_PROPERTY_TYPES,
  archiveSchemaProperties: archiveMetadataProperties,
  archiveViewPayload,
  archiveVacationViewPayload,
  archivePrimaryTableView,
  configureArchiveView,
  ensureArchivePresentation,
  ensureArchiveSchema,
  ensureArchiveVacationView,
};
