"use strict";

const { getDataSource, updateDataSource } = require("./notion");

const MAX_SELECT_OPTIONS_PER_SCHEMA_UPDATE = 100;

/**
 * Build a Notion select-option update without attempting to recolor an
 * existing option. IDs retain the target property's existing metadata, so
 * colors are included only when creating a new option.
 *
 * Desired options are matched to the target property's existing options by
 * name. An ID supplied only by a desired option is ignored: option IDs belong
 * to one property and cannot safely be copied from another select property.
 */
function reconcileSelectOptions(
  existingOptions,
  desiredOptions,
  { retainExisting = false } = {},
) {
  const existing = existingOptions || [];
  const desired = desiredOptions || [];
  const existingByName = new Map(existing.map((option) => [option.name, option]));
  const candidates = retainExisting ? [...existing, ...desired] : desired;
  const seenNames = new Set();
  const reconciled = [];

  for (const candidate of candidates) {
    const name = String(candidate?.name || "");
    if (!name || seenNames.has(name)) continue;
    seenNames.add(name);

    const targetOption = existingByName.get(name);
    if (targetOption?.id) {
      reconciled.push({ id: targetOption.id, name: targetOption.name });
      continue;
    }

    reconciled.push({
      name,
      ...(candidate.color ? { color: candidate.color } : {}),
    });
  }

  return reconciled;
}

function optionNames(options) {
  return (options || [])
    .map((option) => String(option?.name || ""))
    .filter(Boolean);
}

/**
 * Plan one complete, color-safe Select update.
 *
 * `protectedNames` is intended for values that are still selected by rows.
 * Removing one would make the resulting data ambiguous, so the planner fails
 * before an API write. Desired colors for existing options are deliberately
 * ignored so automated reconciliation preserves their current presentation.
 */
function planSelectOptionUpdate(
  existingOptions,
  desiredOptions,
  { retainExisting = false, protectedNames = [] } = {},
) {
  const existing = existingOptions || [];
  const desired = desiredOptions || [];
  const currentNames = optionNames(existing);
  const nextOptions = reconcileSelectOptions(existing, desired, { retainExisting });
  const nextNames = optionNames(nextOptions);
  const existingNames = new Set(currentNames);
  const nextNameSet = new Set(nextNames);
  const added = nextNames.filter((name) => !existingNames.has(name));
  const removed = currentNames.filter((name) => !nextNameSet.has(name));
  const protectedSet = new Set(
    (protectedNames || []).map((name) => String(name || "")).filter(Boolean),
  );
  const blockedRemovals = removed.filter((name) => protectedSet.has(name));

  if (blockedRemovals.length > 0) {
    throw new Error(
      `Cannot remove Select option(s) that are still in use: ${blockedRemovals.join(", ")}`,
    );
  }

  return {
    added,
    removed,
    nextOptions,
    changed: JSON.stringify(currentNames) !== JSON.stringify(nextNames),
  };
}

function selectProperty(dataSource, dataSourceId, propertyName) {
  const property = dataSource?.properties?.[propertyName];
  if (!property || property.type !== "select") {
    throw new Error(
      `Data source ${dataSourceId || dataSource?.id || "unknown"} needs a Select property named "${propertyName}"`,
    );
  }
  return property;
}

/**
 * Fetch, plan, and apply a Select property update only when names/order differ.
 * A schema options array replaces the entire list; it cannot safely be split
 * into batches. A historical caller that writes every requested value to real
 * pages may explicitly defer oversized additive updates to those page writes.
 * Notion adds missing select names on page writes without removing historical
 * choices. Existing colors survive; newly added names use Notion's default
 * color because page values cannot set schema option colors.
 */
async function updateDataSourceSelect({
  dataSourceId,
  dataSource,
  propertyName,
  desiredOptions,
  retainExisting = false,
  protectedNames = [],
  allowPageWritesToAdd = false,
}) {
  if (!dataSourceId) throw new Error("A data source ID is required for a Select update");
  const currentDataSource = dataSource || await getDataSource(dataSourceId);
  const property = selectProperty(currentDataSource, dataSourceId, propertyName);
  const plan = planSelectOptionUpdate(
    property.select?.options || [],
    desiredOptions,
    { retainExisting, protectedNames },
  );

  if (plan.changed) {
    if (plan.nextOptions.length > MAX_SELECT_OPTIONS_PER_SCHEMA_UPDATE) {
      if (retainExisting && allowPageWritesToAdd && plan.removed.length === 0) {
        return { ...plan, deferred: [...plan.added] };
      }
      throw new Error(
        `Select property "${propertyName}" in data source ${dataSourceId} needs ` +
        `${plan.nextOptions.length} options in one schema update; Notion accepts at most ` +
        `${MAX_SELECT_OPTIONS_PER_SCHEMA_UPDATE}. Existing options were preserved. ` +
        "Use real page writes to add historical values, or reduce the requested active choices. " +
        "Splitting the schema options list would remove omitted options.",
      );
    }
    await updateDataSource(dataSourceId, {
      [propertyName]: { select: { options: plan.nextOptions } },
    });
  }
  return plan;
}

module.exports = {
  MAX_SELECT_OPTIONS_PER_SCHEMA_UPDATE,
  optionNames,
  planSelectOptionUpdate,
  reconcileSelectOptions,
  selectProperty,
  updateDataSourceSelect,
};
