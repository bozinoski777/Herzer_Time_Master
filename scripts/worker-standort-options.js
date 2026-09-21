"use strict";

/**
 * A worker chooses one value per D3 entry. A value is either an active Standort
 * or one of these non-location day choices; keeping them in one select avoids
 * asking workers to edit two selects for the same entry. Distinct entries may
 * share a date when the worker splits hours between locations.
 */
const WORK_TYPE_OPTIONS = [
  { name: "Urlaub", color: "gray" },
  { name: "Sonderurlaub", color: "gray" },
  { name: "Überstundenausgleich", color: "gray" },
  { name: "Feiertag", color: "gray" },
  { name: "Krank", color: "gray" },
];

// Retain old selections, but never provision these choices for new workers.
const LEGACY_WORK_TYPE_OPTIONS = [{ name: "Teil-Tag", color: "gray" }];

function uniqueNames(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function workerStandortNames(standorte) {
  const workTypeNames = WORK_TYPE_OPTIONS.map((option) => option.name);
  const reservedNames = [...workTypeNames, ...LEGACY_WORK_TYPE_OPTIONS.map((option) => option.name)];
  const locations = uniqueNames(standorte).filter((name) => !reservedNames.includes(name));
  return [...locations, ...workTypeNames];
}

function workerStandortOptions(standorte) {
  const workTypeByName = new Map(WORK_TYPE_OPTIONS.map((option) => [option.name, option]));
  return workerStandortNames(standorte).map(
    (name) => workTypeByName.get(name) || { name, color: "blue" },
  );
}

function preserveLegacyStandortOptions(desiredOptions, existingOptions) {
  const legacyNames = new Set(LEGACY_WORK_TYPE_OPTIONS.map((option) => option.name));
  const desiredNames = new Set(desiredOptions.map((option) => option.name));
  return [
    ...desiredOptions,
    ...existingOptions.filter((option) => legacyNames.has(option.name) && !desiredNames.has(option.name)),
  ];
}

module.exports = {
  LEGACY_WORK_TYPE_OPTIONS,
  WORK_TYPE_OPTIONS,
  preserveLegacyStandortOptions,
  workerStandortNames,
  workerStandortOptions,
};
