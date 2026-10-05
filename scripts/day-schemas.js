"use strict";

const { assertPropertyTypes } = require("./notion");
const { workerStandortOptions } = require("./worker-standort-options");

const VACATION_DAY_PROPERTY = "Urlaubstag";
const VACATION_DAY_FORMULA = 'if(prop("Standort") == "Urlaub", if(empty(prop("Stunden")), 0, prop("Stunden") / 8), 0)';

const DAY_PROPERTY_TYPES = Object.freeze({
  Wochentag: "title",
  Datum: "date",
  Stunden: "number",
  Standort: "select",
});

const D4_PROPERTY_TYPES = Object.freeze({
  ...DAY_PROPERTY_TYPES,
  [VACATION_DAY_PROPERTY]: "formula",
  "Sync Key": "rich_text",
  "Source Page ID": "rich_text",
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
  };
}

function archiveFormulaProperties() {
  return { [VACATION_DAY_PROPERTY]: { formula: { expression: VACATION_DAY_FORMULA } } };
}

function assertVacationDayFormula(dataSource, { allowMissing = false } = {}) {
  const property = dataSource.properties?.[VACATION_DAY_PROPERTY];
  if (!property && allowMissing) return;
  if (property?.type !== "formula") {
    throw new Error(`D4 ${dataSource.id} property "${VACATION_DAY_PROPERTY}" must be a formula`);
  }
  // The API can return property references by ID and insignificant whitespace.
  const expression = String(property.formula?.expression || "").replace(
    /prop\("([^\"]+)"\)/g,
    (reference, id) => {
      const entry = Object.entries(dataSource.properties).find(([name, value]) =>
        name === id || value.id === id || decodeURIComponent(value.id || "") === id);
      return entry ? `prop(${JSON.stringify(entry[0])})` : reference;
    },
  );
  const compact = (value) => value.replace(/"(?:\\.|[^"\\])*"|\s+/g,
    (token) => token.startsWith('"') ? token : "");
  if (compact(expression) !== compact(VACATION_DAY_FORMULA)) {
    throw new Error(`D4 ${dataSource.id} has an incompatible "${VACATION_DAY_PROPERTY}" formula`);
  }
}

function currentMonthDatabaseProperties(standorte) {
  return dayDatabaseProperties(standorte);
}

function archiveDatabaseProperties(standorte) {
  return {
    ...dayDatabaseProperties(standorte),
    ...archiveFormulaProperties(),
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
  DAY_PROPERTY_TYPES,
  D4_PROPERTY_TYPES,
  VACATION_DAY_PROPERTY,
  VACATION_DAY_FORMULA,
  archiveFormulaProperties,
  assertVacationDayFormula,
  archiveDatabaseProperties,
  archiveMetadataProperties,
  assertArchiveDataSource,
  assertDayDataSource,
  currentMonthDatabaseProperties,
  dayDatabaseProperties,
};
