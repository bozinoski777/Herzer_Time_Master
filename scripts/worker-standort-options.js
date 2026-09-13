"use strict";

/**
 * A worker chooses one value per day.  A value is either an active Standort
 * or one of these non-location day choices; keeping them in one select avoids
 * asking workers to edit two selects for the same day.
 */
const WORK_TYPE_OPTIONS = [
  { name: "Arbeit", color: "green" },
  { name: "Urlaub", color: "blue" },
  { name: "Krank", color: "red" },
  { name: "Feiertag", color: "purple" },
  { name: "Sonderurlaub", color: "orange" },
  { name: "Überstundenausgleich", color: "yellow" },
];

function uniqueNames(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function workerStandortNames(standorte) {
  return uniqueNames([...standorte, ...WORK_TYPE_OPTIONS.map((option) => option.name)]);
}

function workerStandortOptions(standorte) {
  const workTypeByName = new Map(WORK_TYPE_OPTIONS.map((option) => [option.name, option]));
  return workerStandortNames(standorte).map(
    (name) => workTypeByName.get(name) || { name, color: "blue" },
  );
}

module.exports = {
  WORK_TYPE_OPTIONS,
  workerStandortNames,
  workerStandortOptions,
};
