"use strict";

// Independent comparisons: no sync planners or mutation helpers belong here.
const { titleValue, richTextValue } = require("./notion");
const { normalizeNotionId: norm } = require("./worker-identity");
const { parseDaySyncKey } = require("./day-sync-key");
const { carryoverRowsByYear } = require("./vacation-carryover-record");
const { parseSnapshot, SNAPSHOT_PROPERTY } = require("./vacation-carryover");
const { WORK_TYPE_OPTIONS, LEGACY_WORK_TYPE_OPTIONS, ONBOARDING_WORK_TYPE_OPTIONS } = require("./worker-standort-options");
const EPSILON = 1e-6;
// The production boundary is permanent, not a rolling historical window.
const AUDIT_START = "2026-10-01";
const workTypes = new Set([...WORK_TYPE_OPTIONS, ...LEGACY_WORK_TYPE_OPTIONS, ...ONBOARDING_WORK_TYPE_OPTIONS].map((x) => x.name));
const text = (row, name) => richTextValue(row?.properties?.[name]).trim();
const link = (id) => `https://www.notion.so/${norm(id)}`;
const equalNumber = (a, b) => a === b || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= EPSILON);
const dateOf = (row) => row.properties?.Datum?.date?.start || "";
const inScope = (row) => !validDate(dateOf(row)) || dateOf(row) >= AUDIT_START;
const hoursOf = (row) => row.properties?.Stunden?.number ?? null;
const siteOf = (row) => row.properties?.Standort?.select?.name || "";
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

function add(report, severity, code, message, worker, rows = [], expected, actual) {
  report.findings.push({ severity, code, message, workerKey: worker?.workerKey || "", worker: worker?.name || "",
    date: dateOf(rows[0] || {}), records: rows.filter((r) => r?.id).map((r) => ({ id: r.id, url: link(r.id) })),
    ...(expected !== undefined ? { expected } : {}), ...(actual !== undefined ? { actual } : {}) });
}
function finish(report) {
  report.counts = Object.fromEntries(["error", "incomplete", "warning", "info"].map((level) =>
    [level, report.findings.filter((f) => f.severity === level).length]));
  report.status = report.counts.incomplete ? "INCOMPLETE" : report.counts.error ? "ERROR" : report.counts.warning ? "WARNING" : "PASS";
  return report;
}
function fresh(row, cutoff) {
  return Boolean(cutoff && row?.last_edited_time && Date.parse(row.last_edited_time) > Date.parse(cutoff));
}
function values(row) {
  return { date: row.properties?.Datum?.date || null, hours: hoursOf(row), standort: siteOf(row), weekday: titleValue(row.properties?.Wochentag) };
}
function sameValues(a, b) {
  const x = values(a), y = values(b);
  return JSON.stringify(x.date) === JSON.stringify(y.date) && equalNumber(x.hours, y.hours) && x.standort === y.standort && x.weekday === y.weekday;
}
function index(rows, key) {
  const result = new Map();
  for (const row of rows) { const k = key(row); if (k) result.set(k, [...(result.get(k) || []), row]); }
  return result;
}
function duplicates(report, rows, key, label, worker) {
  for (const matches of index(rows, key).values()) if (matches.length > 1)
    add(report, "error", "duplicate", `Duplicate ${label}`, worker, matches, 1, matches.length);
}
function aggregates(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([dateOf(row).slice(0, 7), siteOf(row)]);
    const group = groups.get(key) || { month: dateOf(row).slice(0, 7), standort: siteOf(row), rows: 0, hours: 0, nullHours: 0 };
    group.rows++; group.hours += hoursOf(row) ?? 0; if (hoursOf(row) === null) group.nullHours++;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function checkIdentity(report, row, worker, role) {
  const source = text(row, "Source Page ID");
  const parsed = parseDaySyncKey(text(row, "Sync Key"), worker.workerKey);
  if (!/^[a-f0-9]{32}$/.test(norm(source)) || !parsed || !parsed.sourcePageId) {
    add(report, "incomplete", "provenance", `${role}: source identity cannot be verified`, worker, [row]); return false;
  }
  if (parsed.date !== dateOf(row) || norm(parsed.sourcePageId) !== norm(source))
    add(report, "error", "sync-key", `${role}: Sync Key disagrees with date/source`, worker, [row]);
  if (role === "D7" && text(row, "Worker Key") !== worker.workerKey)
    add(report, "error", "worker-ownership", "D7 belongs to a different worker", worker, [row], worker.workerKey, text(row, "Worker Key"));
  return true;
}
function compareWorker(report, data, d7, cutoff) {
  const { worker, d3 = [], d4 = [] } = data;
  const routes = new Set([worker.d3DatabaseId, worker.d4DatabaseId].map(norm));
  const sourceIds = new Set([...d3.map((r) => norm(r.id)), ...d4.map((r) => norm(text(r, "Source Page ID")))].filter(Boolean));
  const owned = d7.filter((r) => text(r, "Worker Key") === worker.workerKey || routes.has(norm(text(r, "Source Database ID"))) || sourceIds.has(norm(text(r, "Source Page ID"))) || text(r, "Sync Key").startsWith(`${worker.workerKey}|`));
  const bySource = index(owned, (r) => norm(text(r, "Source Page ID")));
  const expectedIds = new Set();
  const currentIds = new Set(d3.map((r) => norm(r.id)));
  for (const row of owned) {
    checkIdentity(report, row, worker, "D7");
    if (!routes.has(norm(text(row, "Source Database ID")))) add(report, "error", "database-ownership", "D7 has an unexpected source database", worker, [row]);
    const name = text(row, "Vor- und Nachname");
    if (name && name !== worker.name) add(report, "info", "display-name", "Stored display name differs from D1; identity still uses Worker Key", worker, [row], worker.name, name);
  }
    for (const row of d3) {
    const matches = bySource.get(norm(row.id)) || [];
    expectedIds.add(norm(row.id));
    if (fresh(row, cutoff)) {
      add(report, "warning", "awaiting-sync", "D3 was edited after the preceding sync; awaiting next sync", worker, [row, ...matches]); continue;
    }
    if (!dateOf(row)) {
      add(report, "warning", "undated-source", "D3 has no date and is outside normal sync coverage", worker, [row]);
      if (matches.length) add(report, "error", "undated-copy", "Undated D3 still has a D7 copy", worker, [row, ...matches]);
      continue;
    }
    if (!validDate(dateOf(row)) || row.properties.Datum.date.end || row.properties.Datum.date.time_zone)
      add(report, "error", "invalid-date", "D3 needs one calendar date", worker, [row]);
    if (dateOf(row).slice(0, 7) !== worker.currentMonth)
      add(report, "incomplete", "unclosed-month", "D3 contains a date outside the worker's Current Month", worker, [row]);
    if (matches.length !== 1) add(report, "error", "current-copy-count", "D3 entry must have exactly one D7 copy", worker, [row, ...matches], 1, matches.length);
    else {
      if (!sameValues(row, matches[0])) add(report, "error", "current-values", "D3 and D7 values differ", worker, [row, matches[0]], values(row), values(matches[0]));
    }
  }
  if (report.scope === "full") {
    let carryovers = new Map();
    try { carryovers = carryoverRowsByYear(d4, worker); }
    catch (error) { add(report, "error", "carryover", error.message, worker); }
    const special = new Set([...carryovers.values()].map((r) => r.id));
    duplicates(report, d4.filter((r) => !special.has(r.id)), (r) => norm(text(r, "Source Page ID")), "D4 Source Page ID", worker);
    duplicates(report, d4, (r) => text(r, "Sync Key"), "D4 Sync Key", worker);
    for (const row of d4) {
      const expected = siteOf(row) === "Urlaub" ? (hoursOf(row) ?? 0) / 8 : 0;
      const actual = row.properties?.Urlaubstag?.formula?.number;
      if (!equalNumber(expected, actual)) add(report, "error", "vacation-formula-value", "Urlaubstag does not match the recorded hours", worker, [row], expected, actual ?? null);
      if (special.has(row.id)) continue;
      if (!checkIdentity(report, row, worker, "D4")) continue;
      const id = norm(text(row, "Source Page ID")); expectedIds.add(id);
      if (dateOf(row).slice(0, 7) >= worker.currentMonth) add(report, "error", "archive-month", "D4 ordinary entry is not in a completed month", worker, [row]);
      const matches = bySource.get(id) || [];
      if (matches.length === 0) add(report, "error", "archive-missing", "D4 entry has no D7 copy", worker, [row], 1, 0);
      else if (matches.length === 1 && !sameValues(row, matches[0])) add(report, "error", "archive-values", "D4 and D7 values differ", worker, [row, matches[0]], values(row), values(matches[0]));
    }
    try {
      const snapshot = parseSnapshot(text(worker.row, SNAPSHOT_PROPERTY), worker);
      if (snapshot) {
        const balance = carryovers.get(snapshot.year);
        if (snapshot.adjustment === 0 ? Boolean(balance) : !balance || !equalNumber(hoursOf(balance), snapshot.adjustment * 8))
          add(report, "error", "carryover-snapshot", "Urlaubsmitnahme disagrees with its saved calculation", worker, balance ? [balance] : [], snapshot.adjustment * 8, balance ? hoursOf(balance) : null);
        const taken = d4.filter((r) => dateOf(r).startsWith(`${snapshot.year}-`) && siteOf(r) === "Urlaub").reduce((sum, r) => sum + (hoursOf(r) ?? 0) / 8, 0);
        if (`${snapshot.year}-01-01` >= AUDIT_START) {
          if (!equalNumber(taken, snapshot.taken)) add(report, "error", "carryover-history", "Vacation history changed relative to the carryover calculation", worker, [], snapshot.taken, taken);
        } else add(report, "info", "carryover-baseline", "Saved balance is checked; its source-year vacation total includes manually migrated history outside audit coverage", worker);
      }
    } catch (error) { add(report, "error", "carryover-snapshot", error.message, worker); }
    report.totals.push({ workerKey: worker.workerKey, worker: worker.name, database: "D4", groups: aggregates(d4) });
  }
  for (const row of owned) {
    if (text(row, "Sync Key").startsWith("vacation-carryover|")) add(report, "error", "carryover-in-d7", "Vacation carryover must not be a D7 work entry", worker, [row]);
    const id = norm(text(row, "Source Page ID"));
    if (!id || expectedIds.has(id)) continue;
    const absent = (data.absentSources || []).find((source) => norm(source.id) === id);
    if (absent && fresh(absent, cutoff)) add(report, "warning", "awaiting-sync", "D3 source changed or was deleted after the preceding sync; awaiting next sync", worker, [absent, row]);
    else if (report.scope === "full" || dateOf(row).slice(0, 7) === worker.currentMonth || currentIds.has(id))
      add(report, "error", "extra-management", "D7 entry has no matching source in the audited scope", worker, [row]);
  }
  report.totals.push({ workerKey: worker.workerKey, worker: worker.name, database: "D3", groups: aggregates(d3) },
    { workerKey: worker.workerKey, worker: worker.name, database: "D7", groups: aggregates(owned) });
}

function compareSnapshot(snapshot, config) {
  const allD7 = snapshot.d7;
  snapshot = scopedSnapshot(snapshot);
  const report = { version: 1, scope: config.scope, runId: config.runId, startedAt: config.startedAt, runUrl: config.runUrl || "",
    findings: [...snapshot.findings], totals: [], coverage: { workers: snapshot.workers.length, checkedWorkers: 0, d3Rows: 0, d4Rows: 0,
      d7Rows: snapshot.d7.length, sites: snapshot.sites.length, startDate: AUDIT_START,
      history: config.scope === "full" ? "checked from 2026-10-01" : "not checked",
      locationTotals: config.scope === "full" ? "production entries from 2026-10-01" : "not checked",
      legacyHistory: "excluded through 2026-09-30", allTimeRollups: "not certified when they include pre-production records" } };
  const { d7, sites } = snapshot;
  duplicates(report, d7, (r) => norm(text(r, "Source Page ID")), "D7 Source Page ID");
  duplicates(report, d7, (r) => text(r, "Sync Key"), "D7 Sync Key");
  const keys = new Set(snapshot.workers.map((w) => w.worker.workerKey).filter(Boolean));
  const siteIndex = new Map();
  for (const site of sites) {
    const name = titleValue(site.properties?.Standort).trim();
    if (!name) { if (site.properties?.Active?.checkbox) add(report, "error", "blank-location", "Active D8 location has no name", null, [site]); continue; }
    if (siteIndex.has(name)) add(report, "error", "duplicate-location", "D8 location name is not unique", null, [siteIndex.get(name), site]);
    siteIndex.set(name, site);
  }
  for (const data of snapshot.workers) {
    if (!data.verified) continue;
    report.coverage.checkedWorkers++; report.coverage.d3Rows += data.d3.length; report.coverage.d4Rows += data.d4.length;
    compareWorker(report, data, d7, config.syncCutoff);
  }
  for (const row of d7) {
    const workerKey = text(row, "Worker Key");
    const owner = snapshot.workers.find((w) => w.worker.workerKey === workerKey)?.worker;
    if (!keys.has(workerKey)) add(report, "error", "unknown-worker", "D7 Worker Key is missing from D1", null, [row]);
    const site = siteIndex.get(siteOf(row));
    const expected = site ? [norm(site.id)] : [];
    const actual = (row.properties?.["Standort (D8)"]?.relation || []).map((x) => norm(x.id)).sort();
    if (siteOf(row) && !site && !workTypes.has(siteOf(row))) add(report, "error", "unknown-location", "D7 Standort has no D8 location", owner, [row]);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) add(report, "error", "location-link", "D7 location relation does not match its Standort", owner, [row], expected, actual);
  }
  if (config.scope === "full") for (const site of sites) {
    const expectedRows = d7.filter((r) => siteIndex.get(siteOf(r))?.id === site.id);
    const expectedHours = expectedRows.reduce((sum, r) => sum + (hoursOf(r) ?? 0), 0);
    const allById = new Map(allD7.map((r) => [norm(r.id), r]));
    const relationIds = (site.properties?.["Arbeitszeiten (D7)"]?.relation || []).map((r) => norm(r.id));
    const missing = relationIds.filter((id) => !allById.has(id));
    if (missing.length) add(report, "incomplete", "location-coverage", "D8 links to inaccessible D7 records whose audit scope cannot be established", null, [site], 0, missing.length);
    const actualIds = relationIds.filter((id) => allById.has(id) && inScope(allById.get(id))).sort();
    const hasLegacy = relationIds.some((id) => allById.has(id) && !inScope(allById.get(id)));
    const actualHours = actualIds.reduce((sum, id) => sum + (hoursOf(allById.get(id)) ?? 0), 0);
    const expectedIds = expectedRows.map((r) => norm(r.id)).sort();
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) add(report, "error", "location-membership", "D8 relation membership differs from D7 Standort assignments", null, [site], expectedIds, actualIds);
    if (!equalNumber(expectedHours, actualHours)) add(report, "error", "location-total", "D8 hours differ from independently summed D7 hours", null, [site], expectedHours, actualHours ?? null);
    if (!hasLegacy && !missing.length && !equalNumber(expectedHours, site.properties?.["Gearbeitete Stunden"]?.rollup?.number))
      add(report, "error", "location-total", "Production-only D8 rollup differs from D7 hours", null, [site], expectedHours, site.properties?.["Gearbeitete Stunden"]?.rollup?.number ?? null);
    report.totals.push({ database: "D8", standort: titleValue(site.properties?.Standort), expectedHours, actualHours, rows: expectedRows.length,
      rollup: hasLegacy ? "excluded: includes pre-production history" : "checked" });
  }
  return finish(report);
}

function scopedSnapshot(snapshot) {
  return { ...snapshot, d7: snapshot.d7.filter(inScope),
    workers: snapshot.workers.map((data) => ({ ...data, d3: data.d3.filter(inScope), d4: data.d4.filter(inScope) })) };
}

function fingerprint(value) {
  const stable = (v) => Array.isArray(v) ? v.map(stable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) :
    v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().filter((k) => !["url", "public_url", "last_edited_by", "created_by", "request_id"].includes(k)).map((k) => [k, stable(v[k])])) : v;
  return JSON.stringify(stable(value));
}
function compareReads(first, second, config) {
  const report = compareSnapshot(second, config);
  // Pre-production edits are outside the audit, including changes to mixed
  // all-time rollups. Keep scoped relation membership in the stability check.
  const stabilityScope = (snapshot) => {
    const scoped = scopedSnapshot(snapshot);
    const legacy = new Set(snapshot.d7.filter((r) => !inScope(r)).map((r) => norm(r.id)));
    scoped.sites = snapshot.sites.map((site) => {
      const relation = site.properties?.["Arbeitszeiten (D7)"];
      if (!relation?.relation?.some((r) => legacy.has(norm(r.id)))) return site;
      const props = { ...site.properties, "Arbeitszeiten (D7)": { ...relation, relation: relation.relation.filter((r) => !legacy.has(norm(r.id))) } };
      delete props["Gearbeitete Stunden"];
      const { last_edited_time, ...stable } = site;
      return { ...stable, properties: props };
    });
    return scoped;
  };
  first = stabilityScope(first); second = stabilityScope(second);
  const unstableKeys = new Set();
  for (const data of second.workers) {
    const previous = first.workers.find((w) => w.worker.rowId === data.worker.rowId);
    if (fingerprint(previous) !== fingerprint(data)) unstableKeys.add(data.worker.workerKey);
  }
  const sharedChanged = fingerprint(first.d7) !== fingerprint(second.d7) || fingerprint(first.sites) !== fingerprint(second.sites) || fingerprint(first.registry) !== fingerprint(second.registry) || fingerprint(first.schemas) !== fingerprint(second.schemas);
  if (sharedChanged || unstableKeys.size) {
    for (const finding of report.findings) if (finding.severity === "error" && (sharedChanged || unstableKeys.has(finding.workerKey))) finding.severity = "incomplete";
    add(report, "incomplete", "unstable-read", "Data changed between audit reads; repeat the audit before treating discrepancies as confirmed");
    report.readChanges = { shared: sharedChanged, workerKeys: [...unstableKeys] };
  }
  if (config.upstreamFailure) add(report, "incomplete", "upstream-failure", `Preceding sync did not complete successfully: ${config.upstreamFailure}`);
  return finish(report);
}
module.exports = { AUDIT_START, inScope, EPSILON, text, link, equalNumber, add, finish, values, aggregates, compareSnapshot, compareReads, fingerprint };
