"use strict";

const { date, richText, richTextValue, select, title, titleValue } = require("./notion");

const FIRST_CARRYOVER_YEAR = 2026;
const CARRYOVER_PREFIX = "vacation-carryover|";
const CARRYOVER_TITLE = "Urlaubsmitnahme";

function validYear(year) {
  return Number.isInteger(year) && year >= FIRST_CARRYOVER_YEAR && year <= 9998;
}

function carryoverKey(workerKey, year) {
  if (!workerKey || workerKey.includes("|") || !validYear(year)) {
    throw new Error("Urlaubsmitnahme needs a valid Worker Key and ending year");
  }
  return `${CARRYOVER_PREFIX}${workerKey}|${year}`;
}

function carryoverProperties(workerKey, year, adjustment) {
  if (!Number.isFinite(adjustment) || adjustment === 0 || !Number.isFinite(adjustment * 8)) {
    throw new Error("Only a finite, nonzero balance creates an Urlaubsmitnahme page");
  }
  return {
    Wochentag: title(CARRYOVER_TITLE),
    Datum: date(`${year + 1}-01-01`),
    Standort: select("Urlaub"),
    Stunden: { number: adjustment * 8 },
    "Sync Key": richText(carryoverKey(workerKey, year)),
    "Source Page ID": richText(""),
  };
}

// A title alone never grants an exemption from the D3 archive barriers. The
// reserved key must prove the worker, year, date, and synthetic row shape.
function carryoverYear(row, worker) {
  const key = richTextValue(row.properties?.["Sync Key"]).trim();
  const name = titleValue(row.properties?.Wochentag);
  if (!key.startsWith(CARRYOVER_PREFIX) && name !== CARRYOVER_TITLE) return null;
  const match = /^vacation-carryover\|([^|]+)\|(\d{4})$/.exec(key);
  const year = Number(match?.[2]);
  const datum = row.properties?.Datum?.date;
  const hours = row.properties?.Stunden?.number;
  if (!match || match[1] !== worker.workerKey || !validYear(year) ||
      name !== CARRYOVER_TITLE || datum?.start !== `${year + 1}-01-01` ||
      datum.end || datum.time_zone || row.properties?.Standort?.select?.name !== "Urlaub" ||
      !Number.isFinite(hours) || hours === 0 ||
      richTextValue(row.properties?.["Source Page ID"]).trim()) {
    throw new Error(`${worker.name}: malformed or foreign Urlaubsmitnahme page ${row.id}`);
  }
  return year;
}

function carryoverRowsByYear(rows, worker) {
  const byYear = new Map();
  for (const row of rows) {
    const year = carryoverYear(row, worker);
    if (year === null) continue;
    if (byYear.has(year)) {
      throw new Error(`${worker.name}: duplicate Urlaubsmitnahme for ${year}`);
    }
    byYear.set(year, row);
  }
  return byYear;
}

function archiveDayRows(rows, worker) {
  const carryovers = new Set(carryoverRowsByYear(rows, worker).values());
  return rows.filter((row) => !carryovers.has(row));
}

module.exports = {
  FIRST_CARRYOVER_YEAR, CARRYOVER_PREFIX, CARRYOVER_TITLE,
  archiveDayRows, carryoverKey, carryoverProperties, carryoverRowsByYear, carryoverYear, validYear,
};
