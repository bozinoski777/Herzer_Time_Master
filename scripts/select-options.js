"use strict";

const { getDataSource, updateDataSource } = require("./notion");

/**
 * Build a Notion select-option update without attempting to recolor an
 * existing option. Notion rejects `color` when an option is addressed by ID,
 * so IDs and colors are deliberately mutually exclusive in the result.
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
 * before an API write. Existing option colors are deliberately ignored:
 * Notion does not permit changing the color of an option addressed by ID.
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

/** Fetch, plan, and apply a Select property update only when names/order differ. */
async function updateDataSourceSelect({
  dataSourceId,
  dataSource,
  propertyName,
  desiredOptions,
  retainExisting = false,
  protectedNames = [],
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
    await updateDataSource(dataSourceId, {
      [propertyName]: { select: { options: plan.nextOptions } },
    });
  }
  return plan;
}

module.exports = {
  optionNames,
  planSelectOptionUpdate,
  reconcileSelectOptions,
  selectProperty,
  updateDataSourceSelect,
};
