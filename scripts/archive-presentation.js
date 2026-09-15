"use strict";

const {
  getDataSource,
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
  defaultTableView,
  propertyId,
  setDatabaseAndDataSourceTitle,
  viewProperties,
} = require("./database-presentation");

const ARCHIVE_DATABASE_TITLE = "Archiv";
const D4_VISIBLE_COLUMNS = ["Wochentag", "Datum", "Standort", "Stunden"];

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
  const view = await defaultTableView(databaseId, dataSourceId);
  await updateView(view.id, archiveViewPayload(dataSource));
}

async function ensureArchivePresentation(databaseId, dataSourceId) {
  await setDatabaseAndDataSourceTitle(databaseId, dataSourceId, ARCHIVE_DATABASE_TITLE);
  await configureArchiveView(databaseId, dataSourceId);
}

module.exports = {
  ARCHIVE_DATABASE_TITLE,
  ARCHIVE_MONTH_FORMULA,
  ARCHIVE_MONTH_PROPERTY,
  D4_PROPERTY_TYPES,
  archiveSchemaProperties: archiveMetadataProperties,
  archiveViewPayload,
  configureArchiveView,
  ensureArchivePresentation,
  ensureArchiveSchema,
};
