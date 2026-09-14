"use strict";

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

module.exports = { reconcileSelectOptions };
