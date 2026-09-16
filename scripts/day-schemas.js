"use strict";

const { assertPropertyTypes } = require("./notion");
const { workerStandortOptions } = require("./worker-standort-options");

const ARCHIVE_MONTH_PROPERTY = "Monat";
const ARCHIVE_MONTH_FORMULA = 'formatDate(prop("Datum"), "YYYY-MM")';

const DAY_PROPERTY_TYPES = Object.freeze({
  Wochentag: "title",
  Datum: "date",
  Stunden: "number",
  Standort: "select",
});

const D4_PROPERTY_TYPES = Object.freeze({
  ...DAY_PROPERTY_TYPES,
  "Sync Key": "rich_text",
  "Source Page ID": "rich_text",
  [ARCHIVE_MONTH_PROPERTY]: "formula",
});

function dayDatabaseProperties(standorte) {
  return {
    Wochentag: { title: {} },
    Datum: { date: {} },
    Stunden: { number: { format: "number" } },
    Standort: { select: { options: workerStandortOptions(standorte) } },
  };
}

function archiveMetadataProperties() {
  return {
    "Sync Key": { rich_text: {} },
    "Source Page ID": { rich_text: {} },
    [ARCHIVE_MONTH_PROPERTY]: {
      formula: { expression: ARCHIVE_MONTH_FORMULA },
    },
  };
}

function currentMonthDatabaseProperties(standorte) {
  return dayDatabaseProperties(standorte);
}

function archiveDatabaseProperties(standorte) {
  return {
    ...dayDatabaseProperties(standorte),
    ...archiveMetadataProperties(),
  };
}

function assertDayDataSource(dataSource) {
  assertPropertyTypes(dataSource, DAY_PROPERTY_TYPES);
  return dataSource;
}

function assertArchiveDataSource(dataSource) {
  assertPropertyTypes(dataSource, D4_PROPERTY_TYPES);
  return dataSource;
}

module.exports = {
  ARCHIVE_MONTH_FORMULA,
  ARCHIVE_MONTH_PROPERTY,
  DAY_PROPERTY_TYPES,
  D4_PROPERTY_TYPES,
  archiveDatabaseProperties,
  archiveMetadataProperties,
  assertArchiveDataSource,
  assertDayDataSource,
  currentMonthDatabaseProperties,
  dayDatabaseProperties,
};
