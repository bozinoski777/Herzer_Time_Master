"use strict";

const {
  assertPropertyTypes,
  databaseIdFromDataSource,
  getDataSource,
  getView,
  listAllViews,
  updateDataSource,
  updateView,
  writableViewProperties,
} = require("./notion");
const { reconcileSelectOptions } = require("./select-options");

const OFFBOARDING_STATUS = {
  ACTIVE: "Active",
  REVOKE_ACCESS: "Revoke Access",
  FINAL_SYNC: "Final Sync",
  COMPLETE: "Complete",
  ERROR: "Error",
};

const OFFBOARDING_STATUS_OPTIONS = [
  { name: OFFBOARDING_STATUS.ACTIVE, color: "green" },
  { name: OFFBOARDING_STATUS.REVOKE_ACCESS, color: "yellow" },
  { name: OFFBOARDING_STATUS.FINAL_SYNC, color: "blue" },
  { name: OFFBOARDING_STATUS.COMPLETE, color: "gray" },
  { name: OFFBOARDING_STATUS.ERROR, color: "red" },
];

const ACCESS_REVOCATION_PROPERTIES = [
  "Frontend Access Revoked",
  "D3 Access Revoked",
  "D4 Access Revoked",
];

const D1_OFFBOARDING_SCHEMA = {
  "Current Month": "rich_text",
  "Offboarding Status": "select",
  "Offboarding Error": "rich_text",
  "Final Sync At": "date",
  "Frontend Access Revoked": "checkbox",
  "D3 Access Revoked": "checkbox",
  "D4 Access Revoked": "checkbox",
};

const OFFBOARDING_VIEW_PROPERTY_NAMES = [
  "Offboarding Status",
  "Offboarding Error",
  "Final Sync At",
  ...ACCESS_REVOCATION_PROPERTIES,
];

function offboardingState(row) {
  return {
    status: row.properties["Offboarding Status"]?.select?.name || "",
    finalSyncAt: row.properties["Final Sync At"]?.date?.start || "",
    accessRevoked: Object.fromEntries(
      ACCESS_REVOCATION_PROPERTIES.map((name) => [
        name,
        Boolean(row.properties[name]?.checkbox),
      ]),
    ),
  };
}

function accessRevocationComplete(worker) {
  return ACCESS_REVOCATION_PROPERTIES.every((name) => Boolean(worker.accessRevoked?.[name]));
}

function offboardingComplete(worker) {
  return (
    !worker.active &&
    worker.offboardingStatus === OFFBOARDING_STATUS.COMPLETE &&
    accessRevocationComplete(worker) &&
    Boolean(worker.finalSyncAt) &&
    worker.sharingStatus === "Revoked"
  );
}

function hasActiveStatusConflict(worker) {
  if (!worker.active) return false;
  if (worker.offboardingStatus) {
    return worker.offboardingStatus !== OFFBOARDING_STATUS.ACTIVE;
  }
  return Boolean(worker.finalSyncAt || worker.sharingStatus === "Revoked");
}

function hasActiveOffboardingConflict(worker) {
  return Boolean(
    worker.active &&
      (hasActiveStatusConflict(worker) ||
        Object.values(worker.accessRevoked || {}).some(Boolean)),
  );
}

function assertValidWorkerState(worker) {
  if (hasActiveStatusConflict(worker)) {
    throw new Error(
      `${worker.name}: Active is true but Offboarding Status is ` +
        `${worker.offboardingStatus || "blank with prior final-sync/revocation evidence"}. ` +
        "Restore the three Notion shares, then manually reset Offboarding Status to Active.",
    );
  }
  if (worker.active && Object.values(worker.accessRevoked || {}).some(Boolean)) {
    throw new Error(
      `${worker.name}: Active is true but one or more access-revocation boxes are checked. ` +
        "Restore the three Notion shares, clear the boxes, and keep Offboarding Status Active.",
    );
  }
}

async function ensureD1OffboardingSchema(dataSourceId) {
  let dataSource = await getDataSource(dataSourceId);
  const additions = {};

  for (const [name, expectedType] of Object.entries(D1_OFFBOARDING_SCHEMA)) {
    const property = dataSource.properties?.[name];
    if (property && property.type !== expectedType) {
      throw new Error(`D1 property "${name}" is ${property.type}, expected ${expectedType}`);
    }
    if (!property) additions[name] = { [expectedType]: {} };
  }

  const existingStatusOptions = dataSource.properties?.["Offboarding Status"]?.select?.options || [];
  const missingStatusOptions = OFFBOARDING_STATUS_OPTIONS.filter(
    (desired) => !existingStatusOptions.some((existing) => existing.name === desired.name),
  );
  if (missingStatusOptions.length > 0) {
    additions["Offboarding Status"] = {
      select: {
        options: reconcileSelectOptions(existingStatusOptions, missingStatusOptions, {
          retainExisting: true,
        }),
      },
    };
  }

  const sharingStatus = dataSource.properties?.["Sharing Status"];
  if (sharingStatus) {
    if (sharingStatus.type !== "select") {
      throw new Error(`D1 property "Sharing Status" is ${sharingStatus.type}, expected select`);
    }
    const existingSharingOptions = sharingStatus.select?.options || [];
    if (!existingSharingOptions.some((option) => option.name === "Revoked")) {
      additions["Sharing Status"] = {
        select: {
          options: reconcileSelectOptions(
            existingSharingOptions,
            [{ name: "Revoked", color: "gray" }],
            { retainExisting: true },
          ),
        },
      };
    }
  }

  if (Object.keys(additions).length > 0) {
    await updateDataSource(dataSourceId, additions);
    dataSource = await getDataSource(dataSourceId);
  }
  assertPropertyTypes(dataSource, D1_OFFBOARDING_SCHEMA);
  return dataSource;
}

function offboardingViewProperties(dataSource, configuration = {}) {
  const desiredIds = new Set(
    OFFBOARDING_VIEW_PROPERTY_NAMES.map((name) => {
      const property = dataSource.properties?.[name];
      if (!property?.id) throw new Error(`D1 is missing offboarding property "${name}"`);
      return property.id;
    }),
  );
  const existing = writableViewProperties(dataSource, configuration.properties || []);
  const seen = new Set();
  const properties = existing.map((entry) => {
    seen.add(entry.property_id);
    return desiredIds.has(entry.property_id) ? { ...entry, visible: true } : entry;
  });
  for (const propertyId of desiredIds) {
    if (!seen.has(propertyId)) properties.push({ property_id: propertyId, visible: true });
  }
  return properties;
}

/** Make the manager-owned offboarding state/checklist visible in D1 table views. */
async function ensureD1OffboardingView(dataSourceId) {
  const dataSource = await getDataSource(dataSourceId);
  assertPropertyTypes(dataSource, D1_OFFBOARDING_SCHEMA);
  const databaseId = databaseIdFromDataSource(dataSource);
  const references = await listAllViews(databaseId);
  const views = await Promise.all(references.map((reference) => getView(reference.id)));
  const tableViews = views.filter(
    (view) => view.data_source_id === dataSourceId && view.type === "table",
  );
  if (tableViews.length === 0) {
    throw new Error("D1 has no table view in which to show the offboarding checklist");
  }
  for (const view of tableViews) {
    await updateView(view.id, {
      configuration: {
        type: "table",
        properties: offboardingViewProperties(dataSource, view.configuration || {}),
      },
    });
  }
}

module.exports = {
  ACCESS_REVOCATION_PROPERTIES,
  D1_OFFBOARDING_SCHEMA,
  OFFBOARDING_STATUS,
  accessRevocationComplete,
  assertValidWorkerState,
  ensureD1OffboardingSchema,
  ensureD1OffboardingView,
  hasActiveOffboardingConflict,
  offboardingComplete,
  offboardingState,
  offboardingViewProperties,
};
