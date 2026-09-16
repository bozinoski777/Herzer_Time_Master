"use strict";

/**
 * Canonical D7 upsert/reconciliation service.
 *
 * Daily sync and Month Rollover both use this module so Source Page identity,
 * edited dates, deleted rows, verification, and stale-row cleanup follow one
 * implementation.
 */

const {
  archivePage,
  assertPropertyTypes,
  createPage,
  date,
  queryAll,
  richText,
  richTextValue,
  select,
  title,
  titleValue,
  updatePage,
} = require("./notion");
const { DAY_PROPERTY_TYPES } = require("./day-schemas");
const { daySyncKey } = require("./day-sync-key");
const { assertWorkerDataSourceReference } = require("./worker-database-references");

const D3_DAY_SCHEMA = DAY_PROPERTY_TYPES;

const D7_SCHEMA = {
  ...DAY_PROPERTY_TYPES,
  "Standort (D8)": "relation",
  "Vor- und Nachname": "rich_text",
  "Worker Key": "rich_text",
  "Sync Key": "rich_text",
  "Source Page ID": "rich_text",
  "Source Database ID": "rich_text",
  "Last Synced At": "date",
};

function sourceDate(row) {
  return row.properties.Datum?.date?.start || "";
}

function assertDateOnlySource(row) {
  const value = sourceDate(row);
  const dateProperty = row.properties.Datum?.date;
  const parsed = value ? new Date(`${value}T12:00:00Z`) : null;
  const isRealDate =
    !value ||
    (/^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === value);
  if (!isRealDate || dateProperty?.end || dateProperty?.time_zone) {
    throw new Error(
      `D3 page ${row.id} has a time-bearing, ranged, or invalid Datum (${value}); ` +
        "use one real date without a time",
    );
  }
  return value;
}

function assertSourceRowsMatchWorkerMonth(worker, sourceRows) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(worker.currentMonth || "")) {
    throw new Error(`${worker.name}: D1 Current Month is invalid or missing (${worker.currentMonth || "blank"})`);
  }
  const pageIds = new Set();
  for (const row of sourceRows) {
    if (!row.id || pageIds.has(row.id)) {
      throw new Error(`${worker.name}: D3 contains a missing or duplicate page ID`);
    }
    pageIds.add(row.id);
    const datum = assertDateOnlySource(row);
    if (!datum) continue;
    if (datum.slice(0, 7) !== worker.currentMonth) {
      throw new Error(
        `${worker.name}: D3 page ${row.id} is dated ${datum}, outside D1 Current Month ` +
          `${worker.currentMonth}; run/fix Month Rollover before management sync`,
      );
    }
  }
}

function rowText(row, propertyName) {
  return richTextValue(row.properties[propertyName]).trim();
}

function monthOf(dateValue) {
  return /^\d{4}-\d{2}/.test(dateValue || "") ? dateValue.slice(0, 7) : "";
}

function monthDateRange(targetMonth) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(targetMonth || "")) {
    throw new Error(`Invalid management-sync month ${targetMonth || "(blank)"}`);
  }
  const year = Number(targetMonth.slice(0, 4));
  const month = Number(targetMonth.slice(5, 7));
  const nextMonth = month === 12
    ? `${year + 1}-01`
    : `${year}-${String(month + 1).padStart(2, "0")}`;
  return {
    start: `${targetMonth}-01`,
    end: `${nextMonth}-01`,
  };
}

function assertWorkerRouting(worker) {
  if (!worker.name || !worker.workerKey || !worker.d3DatabaseId || !worker.d3DataSourceId) {
    throw new Error(`${worker.name || "Unnamed worker"}: D3/D7 routing data is incomplete`);
  }
}

function validateWorkerD3DataSource(worker, dataSource) {
  assertWorkerRouting(worker);
  return assertWorkerDataSourceReference(worker, "d3", dataSource, {
    schema: D3_DAY_SCHEMA,
  });
}

function managementProperties(worker, sourcePage, syncedAt = new Date().toISOString()) {
  assertWorkerRouting(worker);
  const datum = assertDateOnlySource(sourcePage);
  if (!datum) throw new Error(`D3 page ${sourcePage.id} has no Datum`);

  const syncKey = daySyncKey(worker.workerKey, datum, sourcePage.id);
  return {
    syncKey,
    properties: {
      Wochentag: title(titleValue(sourcePage.properties.Wochentag)),
      Datum: date(datum),
      Stunden: { number: sourcePage.properties.Stunden?.number ?? null },
      Standort: select(sourcePage.properties.Standort?.select?.name || ""),
      "Vor- und Nachname": richText(worker.name),
      "Worker Key": richText(worker.workerKey),
      "Sync Key": richText(syncKey),
      "Source Page ID": richText(sourcePage.id),
      "Source Database ID": richText(worker.d3DatabaseId),
      "Last Synced At": date(syncedAt),
    },
  };
}

/**
 * Return the smallest safe D7 PATCH. Last Synced At is audit metadata: it is
 * written only alongside an actual value/routing repair, never by itself.
 */
function managementPropertyChanges(
  row,
  worker,
  sourcePage,
  syncedAt = new Date().toISOString(),
) {
  const expected = managementProperties(worker, sourcePage, syncedAt);
  const changes = {};
  const managementDate = row.properties.Datum?.date;

  if (titleValue(row.properties.Wochentag) !== titleValue(sourcePage.properties.Wochentag)) {
    changes.Wochentag = expected.properties.Wochentag;
  }
  if (
    managementDate?.start !== sourceDate(sourcePage) ||
    managementDate?.end ||
    managementDate?.time_zone
  ) {
    changes.Datum = expected.properties.Datum;
  }
  if ((row.properties.Stunden?.number ?? null) !== (sourcePage.properties.Stunden?.number ?? null)) {
    changes.Stunden = expected.properties.Stunden;
  }
  if (
    (row.properties.Standort?.select?.name || "") !==
    (sourcePage.properties.Standort?.select?.name || "")
  ) {
    changes.Standort = expected.properties.Standort;
  }
  for (const [propertyName, actual, desired] of [
    ["Vor- und Nachname", rowText(row, "Vor- und Nachname"), worker.name],
    ["Worker Key", rowText(row, "Worker Key"), worker.workerKey],
    ["Sync Key", rowText(row, "Sync Key"), expected.syncKey],
    ["Source Page ID", rowText(row, "Source Page ID"), sourcePage.id],
    ["Source Database ID", rowText(row, "Source Database ID"), worker.d3DatabaseId],
  ]) {
    if (actual !== desired) changes[propertyName] = expected.properties[propertyName];
  }

  if (Object.keys(changes).length > 0) {
    changes["Last Synced At"] = expected.properties["Last Synced At"];
  }
  return changes;
}

function managementValuesMatch(row, worker, sourcePage) {
  return Object.keys(
    managementPropertyChanges(row, worker, sourcePage, "ignored"),
  ).length === 0;
}

function uniqueIndex(rows, valueForRow, label) {
  const index = new Map();
  for (const row of rows) {
    const value = valueForRow(row);
    if (!value) continue;
    if (index.has(value)) {
      throw new Error(`D7 contains duplicate ${label} value ${value}`);
    }
    index.set(value, row);
  }
  return index;
}

function multiIndex(rows, valueForRow) {
  const index = new Map();
  for (const row of rows) {
    const value = valueForRow(row);
    if (!value) continue;
    const matches = index.get(value) || [];
    matches.push(row);
    index.set(value, matches);
  }
  return index;
}

function assertResolvableSyncKeys(rows, desiredKeyBySourcePageId) {
  const groups = multiIndex(rows, (row) => rowText(row, "Sync Key"));
  for (const [syncKey, matches] of groups) {
    if (matches.length < 2) continue;
    // A crash during a date swap can temporarily leave two legacy date-only
    // keys equal. Both can be repaired if each row belongs to a different,
    // known current D3 page with a unique source-qualified destination key.
    const desiredKeys = matches.map((row) =>
      desiredKeyBySourcePageId.get(rowText(row, "Source Page ID")),
    );
    const resolvableMove =
      desiredKeys.every(Boolean) &&
      new Set(desiredKeys).size === desiredKeys.length &&
      new Set(matches.map((row) => rowText(row, "Source Page ID"))).size === matches.length;
    if (!resolvableMove) {
      throw new Error(`D7 contains duplicate Sync Key value ${syncKey}`);
    }
  }
}

function assertCurrentMonthManagementOwnership(worker, sourceRows, managementRows) {
  if (!worker.currentMonth) return;
  const currentSourceIds = new Set(sourceRows.map((row) => row.id));

  for (const row of managementRows) {
    const sourcePageId = rowText(row, "Source Page ID");
    const workerKey = rowText(row, "Worker Key");
    const sourceDatabaseId = rowText(row, "Source Database ID");
    const syncKey = rowText(row, "Sync Key");
    const belongsToCurrentSource = sourcePageId && currentSourceIds.has(sourcePageId);
    const isCurrentMonth = monthOf(sourceDate(row)) === worker.currentMonth;
    const hasWorkerKeyPrefix = syncKey.startsWith(`${worker.workerKey}|`);
    const isRoutedToWorker =
      workerKey === worker.workerKey ||
      sourceDatabaseId === worker.d3DatabaseId ||
      hasWorkerKeyPrefix;

    if (!belongsToCurrentSource && !(isCurrentMonth && isRoutedToWorker)) continue;
    if (
      !sourcePageId ||
      workerKey !== worker.workerKey ||
      sourceDatabaseId !== worker.d3DatabaseId
    ) {
      throw new Error(
        `${worker.name}: D7 row ${row.id} has ambiguous current-month ownership; ` +
          "correct Worker Key, Source Page ID, and Source Database ID before syncing",
      );
    }
  }
}

function staleManagementRows(worker, sourceRows, managementRows, reconcileMissing) {
  if (!reconcileMissing) return [];

  const allSourceIds = new Set(sourceRows.map((row) => row.id));
  const undatedSourceIds = new Set(
    sourceRows.filter((row) => !sourceDate(row)).map((row) => row.id),
  );
  // D3 is reused every month, so historic D7 rows have this same source
  // database ID after their original D3 pages are archived. Only the D1
  // current month is eligible for missing-source reconciliation; deriving the
  // scope from an edited date could accidentally remove valid history.
  const sourceMonths = new Set(worker.currentMonth ? [worker.currentMonth] : []);

  return managementRows.filter((row) => {
    const sourcePageId = rowText(row, "Source Page ID");
    if (sourcePageId && undatedSourceIds.has(sourcePageId)) return true;
    if (rowText(row, "Source Database ID") !== worker.d3DatabaseId) return false;
    if (!sourcePageId || allSourceIds.has(sourcePageId)) return false;
    return sourceMonths.has(monthOf(sourceDate(row)));
  });
}

/**
 * Produce a deterministic reconciliation plan without making API calls.
 * Source Page ID is the durable identity; Sync Key also includes that ID so
 * same-date entries cannot collide in D7 or downstream rollups.
 */
function planManagementSync(
  worker,
  sourceRows,
  managementRows,
  { reconcileMissing = true, syncedAt = new Date().toISOString() } = {},
) {
  assertWorkerRouting(worker);
  assertSourceRowsMatchWorkerMonth(worker, sourceRows);

  assertCurrentMonthManagementOwnership(worker, sourceRows, managementRows);

  const archives = staleManagementRows(worker, sourceRows, managementRows, reconcileMissing);
  const archivedIds = new Set(archives.map((row) => row.id));
  const retainedRows = managementRows.filter((row) => !archivedIds.has(row.id));
  const desiredKeyBySourcePageId = new Map(
    sourceRows
      .filter((row) => sourceDate(row))
      .map((row) => [row.id, daySyncKey(worker.workerKey, sourceDate(row), row.id)]),
  );
  // Historical duplicates and unknown owners fail closed so D7/D8 can never
  // silently double-count. The sole exception is a provably resumable
  // current-source date move interrupted between page updates.
  assertResolvableSyncKeys(retainedRows, desiredKeyBySourcePageId);
  const bySyncKey = multiIndex(retainedRows, (row) => rowText(row, "Sync Key"));
  const bySourcePageId = uniqueIndex(
    retainedRows,
    (row) => rowText(row, "Source Page ID"),
    "Source Page ID",
  );

  const creates = [];
  const updates = [];
  const unchanged = [];
  const warnings = [];

  for (const sourceRow of sourceRows) {
    const datum = sourceDate(sourceRow);
    if (!datum) {
      warnings.push(`${worker.name}: D3 page ${sourceRow.id} has no Datum; its D7 copy was removed.`);
      continue;
    }

    const built = managementProperties(worker, sourceRow, syncedAt);
    const bySource = bySourcePageId.get(sourceRow.id);
    const keyMatches = bySyncKey.get(built.syncKey) || [];
    const foreignKeyOwners = keyMatches.filter((row) => row.id !== bySource?.id);
    const unclaimedKeyRows = [];
    for (const owner of foreignKeyOwners) {
      const ownerSourcePageId = rowText(owner, "Source Page ID");
      if (!ownerSourcePageId) {
        unclaimedKeyRows.push(owner);
        continue;
      }
      const ownerDesiredKey = desiredKeyBySourcePageId.get(ownerSourcePageId);
      if (!ownerDesiredKey || ownerDesiredKey === built.syncKey) {
        throw new Error(
          `${worker.name}: D7 Sync Key ${built.syncKey} belongs to another D3 page`,
        );
      }
    }

    let target = bySource;
    if (!target && unclaimedKeyRows.length > 0) {
      if (unclaimedKeyRows.length > 1) {
        throw new Error(`${worker.name}: D7 contains duplicate unclaimed Sync Key ${built.syncKey}`);
      }
      target = unclaimedKeyRows[0];
    }
    if (target) {
      const targetSourceId = rowText(target, "Source Page ID");
      if (targetSourceId && targetSourceId !== sourceRow.id) {
        throw new Error(`${worker.name}: D7 Sync Key ${built.syncKey} belongs to another D3 page`);
      }
      const changedProperties = managementPropertyChanges(
        target,
        worker,
        sourceRow,
        syncedAt,
      );
      if (Object.keys(changedProperties).length === 0) {
        unchanged.push({ row: target, sourceRow, ...built });
      } else {
        updates.push({ row: target, sourceRow, ...built, properties: changedProperties });
      }

    } else {
      creates.push({ sourceRow, ...built });
    }
  }

  return { archives, creates, updates, unchanged, warnings };
}

function relevantManagementFilter(worker, sourceRows = []) {
  assertWorkerRouting(worker);
  const { start, end } = monthDateRange(worker.currentMonth);
  const sourcePageIds = [...new Set(sourceRows.map((row) => row.id).filter(Boolean))];
  const inCurrentMonth = (routeFilter) => ({
    and: [
      { property: "Datum", date: { on_or_after: start } },
      { property: "Datum", date: { before: end } },
      routeFilter,
    ],
  });

  // Notion supports only two compound-filter levels. Keep routing alternatives
  // at the root: Worker Key and D3 database matches are date-bounded, while the
  // already month-specific Sync Key prefix remains able to heal a bad Datum.
  return {
    or: [
      ...sourcePageIds.map((sourcePageId) => ({
        property: "Source Page ID",
        rich_text: { equals: sourcePageId },
      })),
      inCurrentMonth({ property: "Worker Key", rich_text: { equals: worker.workerKey } }),
      inCurrentMonth({
        property: "Source Database ID",
        rich_text: { equals: worker.d3DatabaseId },
      }),
      {
        property: "Sync Key",
        rich_text: { starts_with: `${worker.workerKey}|${worker.currentMonth}-` },
      },
    ],
  };
}

async function relevantManagementRows(d7DataSourceId, worker, sourceRows = []) {
  return queryAll(d7DataSourceId, relevantManagementFilter(worker, sourceRows));
}

async function applyManagementPlan(plan, d7DataSourceId, operations = {}) {
  const archive = operations.archivePage || archivePage;
  const update = operations.updatePage || updatePage;
  const create = operations.createPage || createPage;
  // Remove stale current-month copies first so a moved date can safely reuse a
  // Sync Key formerly held by a deleted source page. Removal is recoverable.
  for (const row of plan.archives) await archive(row.id);
  for (const change of plan.updates) await update(change.row.id, change.properties);
  for (const creation of plan.creates) {
    await create(
      { type: "data_source_id", data_source_id: d7DataSourceId },
      creation.properties,
    );
  }
  return {
    archived: plan.archives.length,
    created: plan.creates.length,
    updated: plan.updates.length,
    unchanged: plan.unchanged.length,
  };
}

function verifyManagementRows(
  worker,
  sourceRows,
  managementRows,
  { reconcileMissing = false } = {},
) {
  assertSourceRowsMatchWorkerMonth(worker, sourceRows);
  assertCurrentMonthManagementOwnership(worker, sourceRows, managementRows);
  const bySyncKey = uniqueIndex(managementRows, (row) => rowText(row, "Sync Key"), "Sync Key");
  const bySourcePageId = uniqueIndex(
    managementRows,
    (row) => rowText(row, "Source Page ID"),
    "Source Page ID",
  );

  for (const sourceRow of sourceRows) {
    if (!sourceDate(sourceRow)) continue;
    const expectedKey = daySyncKey(worker.workerKey, sourceDate(sourceRow), sourceRow.id);
    const keyed = bySyncKey.get(expectedKey);
    const sourced = bySourcePageId.get(sourceRow.id);
    if (!keyed || !sourced || keyed.id !== sourced.id || !managementValuesMatch(keyed, worker, sourceRow)) {
      throw new Error(`${worker.name}: D7 verification failed for ${expectedKey}; D3 remains unchanged`);
    }
  }

  if (reconcileMissing && worker.currentMonth) {
    const sourceIds = new Set(sourceRows.map((row) => row.id));
    const stale = managementRows.filter((row) => {
      const sourcePageId = rowText(row, "Source Page ID");
      return (
        rowText(row, "Source Database ID") === worker.d3DatabaseId &&
        monthOf(sourceDate(row)) === worker.currentMonth &&
        sourcePageId &&
        !sourceIds.has(sourcePageId)
      );
    });
    if (stale.length > 0) {
      throw new Error(
        `${worker.name}: D7 verification found ${stale.length} stale ${worker.currentMonth} row(s); ` +
          "D3 remains unchanged",
      );
    }
  }
}

async function syncWorkerToManagement(
  worker,
  sourceRows,
  d7DataSourceId,
  { reconcileMissing = true, verify = false, fullScan = false } = {},
) {
  const rows = fullScan
    ? await queryAll(d7DataSourceId)
    : await relevantManagementRows(d7DataSourceId, worker, sourceRows);
  const plan = planManagementSync(worker, sourceRows, rows, { reconcileMissing });
  const counts = await applyManagementPlan(plan, d7DataSourceId);
  if (verify) {
    verifyManagementRows(
      worker,
      sourceRows,
      fullScan
        ? await queryAll(d7DataSourceId)
        : await relevantManagementRows(d7DataSourceId, worker, sourceRows),
      { reconcileMissing },
    );
  }
  return { ...counts, warnings: plan.warnings };
}

function validateD7DataSource(dataSource) {
  assertPropertyTypes(dataSource, D7_SCHEMA);
}

const validateManagementDataSource = validateD7DataSource;

module.exports = {
  D3_DAY_SCHEMA,
  D7_SCHEMA,
  applyManagementPlan,
  assertSourceRowsMatchWorkerMonth,
  managementProperties,
  managementPropertyChanges,
  managementValuesMatch,
  monthDateRange,
  planManagementSync,
  relevantManagementFilter,
  relevantManagementRows,
  sourceDate,
  syncWorkerToManagement,
  validateWorkerD3DataSource,
  validateD7DataSource,
  validateManagementDataSource,
  verifyManagementRows,
};
