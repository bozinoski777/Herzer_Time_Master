"use strict";

const { titleValue } = require("./notion");
const { normalizeNotionId } = require("./worker-identity");

const ROUTING_FIELDS = [
  "d3DatabaseId",
  "d3DataSourceId",
  "d4DatabaseId",
  "d4DataSourceId",
];

function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function manifestDay(entry) {
  return {
    id: entry.row.id,
    date: entry.sourceDate,
    weekday: titleValue(entry.row.properties.Wochentag),
    hours: entry.row.properties.Stunden?.number ?? null,
    standort: entry.row.properties.Standort?.select?.name || "",
  };
}

function manifestRouting(worker) {
  return Object.fromEntries(
    ROUTING_FIELDS.map((field) => [field, normalizeNotionId(worker[field])]),
  );
}

function buildRolloverManifest(worker, sourceMonth, sourceEntries) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(sourceMonth || "")) {
    throw new Error(`Invalid D3 source month "${sourceMonth || ""}"`);
  }
  if (sourceEntries.some((entry) => entry.sourceMonth !== sourceMonth)) {
    throw new Error("A rollover manifest may contain only one D3 source month");
  }
  if (!worker.workerKey || ROUTING_FIELDS.some((field) => !worker[field])) {
    throw new Error(`${worker.name}: cannot checkpoint rollover with incomplete D3/D4 routing`);
  }
  return {
    version: 2,
    workerKey: worker.workerKey,
    sourceMonth,
    routing: manifestRouting(worker),
    days: sourceEntries.map(manifestDay),
  };
}

function sourceEntryFromManifestDay(day, sourceMonth) {
  return {
    sourceDate: day.date,
    sourceMonth,
    row: {
      id: day.id,
      properties: {
        Wochentag: { title: day.weekday ? [{ plain_text: day.weekday }] : [] },
        Datum: { date: { start: day.date } },
        Stunden: { number: day.hours },
        Standort: { select: day.standort ? { name: day.standort } : null },
      },
    },
  };
}

function parseRolloverManifest(value, worker) {
  const text = String(value || "").trim();
  if (!text) return null;

  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error(`${worker.name}: Rollover Manifest is not valid JSON`);
  }
  const expectedRouting = manifestRouting(worker);
  if (
    manifest?.version !== 2 ||
    manifest.workerKey !== worker.workerKey ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(manifest.sourceMonth || "") ||
    !manifest.routing ||
    ROUTING_FIELDS.some((field) => manifest.routing[field] !== expectedRouting[field]) ||
    !Array.isArray(manifest.days)
  ) {
    throw new Error(
      `${worker.name}: Rollover Manifest does not match this worker, its D3/D4 routing, or schema`,
    );
  }

  const ids = new Set();
  for (const day of manifest.days) {
    if (
      !day ||
      typeof day.id !== "string" ||
      !day.id ||
      !validIsoDate(day.date) ||
      day.date.slice(0, 7) !== manifest.sourceMonth ||
      typeof day.weekday !== "string" ||
      !(day.hours === null || Number.isFinite(day.hours)) ||
      typeof day.standort !== "string"
    ) {
      throw new Error(`${worker.name}: Rollover Manifest contains an invalid day snapshot`);
    }
    if (ids.has(day.id)) {
      throw new Error(`${worker.name}: Rollover Manifest contains duplicate page IDs`);
    }
    ids.add(day.id);
  }
  return manifest;
}

function manifestSourceEntries(manifest) {
  return manifest.days.map((day) => sourceEntryFromManifestDay(day, manifest.sourceMonth));
}

function hasPendingRollover(worker) {
  const manifest = parseRolloverManifest(worker.rolloverManifest, worker);
  if (!manifest) return false;
  if (!["Running", "Error"].includes(worker.rolloverStatus)) {
    throw new Error(
      `${worker.name}: Rollover Manifest exists while Rollover Status is ` +
        `${worker.rolloverStatus || "blank"}; set the status to Error and retry Month Rollover`,
    );
  }
  return true;
}

module.exports = {
  buildRolloverManifest,
  hasPendingRollover,
  manifestSourceEntries,
  normalizedNotionId: normalizeNotionId,
  parseRolloverManifest,
};
