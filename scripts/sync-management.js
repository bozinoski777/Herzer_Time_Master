"use strict";

const {
  assertPropertyTypes,
  date,
  errorMessage,
  getDataSource,
  getPage,
  queryAll,
  requireEnv,
  richText,
  richTextValue,
  select,
  titleValue,
  updatePage,
} = require("./notion");
const {
  syncWorkerToManagement,
  validateWorkerD3DataSource,
  validateD7DataSource,
} = require("./management-sync");
const {
  OFFBOARDING_STATUS,
  accessRevocationComplete,
  assertValidWorkerState,
  ensureD1OffboardingSchema,
  ensureD1OffboardingView,
  hasActiveOffboardingConflict,
  offboardingComplete,
  offboardingState,
} = require("./offboarding");
const { hasPendingRollover } = require("./rollover-manifest");
const {
  D1_WORKER_REFERENCE_SCHEMA,
  assertUniqueWorkerReferences,
  missingWorkerReferences,
  workerReferencesFromD1,
} = require("./worker-database-references");

const {
  D1_DATA_SOURCE_ID: D1,
  D7_DATA_SOURCE_ID: D7,
} = requireEnv("D1_DATA_SOURCE_ID", "D7_DATA_SOURCE_ID");

const D1_SCHEMA = {
  "Vor- und Nachname": "title",
  Active: "checkbox",
  "Onboarding Status": "select",
  "Worker Key": "rich_text",
  ...D1_WORKER_REFERENCE_SCHEMA,
  "Sharing Status": "select",
  "Current Month": "rich_text",
  "Offboarding Status": "select",
  "Offboarding Error": "rich_text",
  "Final Sync At": "date",
  "Frontend Access Revoked": "checkbox",
  "D3 Access Revoked": "checkbox",
  "D4 Access Revoked": "checkbox",
};

function berlinCurrentMonth(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}`;
}

async function validateSchema() {
  const d1 = await ensureD1OffboardingSchema(D1);
  assertPropertyTypes(d1, D1_SCHEMA);
  await ensureD1OffboardingView(D1);
  const rolloverManifest = d1.properties?.["Rollover Manifest"];
  if (rolloverManifest && rolloverManifest.type !== "rich_text") {
    throw new Error(
      `D1 property "Rollover Manifest" is ${rolloverManifest.type}, expected rich_text`,
    );
  }
  validateD7DataSource(await getDataSource(D7));
}

function workerFromRow(row, fallbackMonth = berlinCurrentMonth()) {
  const state = offboardingState(row);
  return {
    ...workerReferencesFromD1(row),
    active: Boolean(row.properties.Active?.checkbox),
    currentMonth: richTextValue(row.properties["Current Month"]).trim() || fallbackMonth,
    offboardingStatus: state.status,
    finalSyncAt: state.finalSyncAt,
    accessRevoked: state.accessRevoked,
    sharingStatus: row.properties["Sharing Status"]?.select?.name || "",
    rolloverManifest: richTextValue(row.properties["Rollover Manifest"]).trim(),
    rolloverStatus: row.properties["Rollover Status"]?.select?.name || "",
    onboardingStatus: row.properties["Onboarding Status"]?.select?.name || "",
  };
}

function shouldSyncWorker(worker) {
  return !hasPendingRollover(worker) && (worker.active || !offboardingComplete(worker));
}

async function readyWorkers() {
  const rows = await queryAll(D1, {
    property: "Onboarding Status",
    select: { equals: "Ready" },
  });
  return rows.map((row) => workerFromRow(row));
}

function validateWorkerRegistry(workers) {
  return assertUniqueWorkerReferences(workers, {
    // Daily synchronization reads only D3. Incomplete onboarding rows remain
    // isolated, while every D3 route in scope is still globally unique.
    roles: ["d3"],
    reservedDataSources: [
      { id: D1, label: "D1 Data Source ID" },
      { id: D7, label: "D7 Data Source ID" },
    ],
  });
}

async function sourceRowsForWorker(worker) {
  const missing = missingWorkerReferences(worker, { roles: ["d3"] });
  if (missing.length > 0) {
    throw new Error(`${worker.name} is Ready but has incomplete D3/D7 routing IDs`);
  }
  const sourceDataSource = await getDataSource(worker.d3DataSourceId);
  validateWorkerD3DataSource(worker, sourceDataSource);
  return queryAll(worker.d3DataSourceId);
}

async function updateOffboarding(worker, properties) {
  return updatePage(worker.rowId, properties);
}

function sourceRowSnapshot(row) {
  const sourceDate = row.properties.Datum?.date;
  return {
    id: row.id,
    weekday: titleValue(row.properties.Wochentag),
    date: sourceDate
      ? {
          start: sourceDate.start || "",
          end: sourceDate.end || null,
          timeZone: sourceDate.time_zone || null,
        }
      : null,
    hours: row.properties.Stunden?.number ?? null,
    standort: row.properties.Standort?.select?.name || "",
  };
}

function sourceRowsSnapshot(rows) {
  return rows.map(sourceRowSnapshot).sort((left, right) => left.id.localeCompare(right.id));
}

function assertFinalOffboardingCheckpoint(worker, refreshedWorker, sourceRows, refreshedSourceRows) {
  const stableFields = [
    ["D1 row", worker.rowId, refreshedWorker.rowId],
    ["worker name", worker.name, refreshedWorker.name],
    ["Worker Key", worker.workerKey, refreshedWorker.workerKey],
    ["D3 Database ID", worker.d3DatabaseId, refreshedWorker.d3DatabaseId],
    ["D3 Data Source ID", worker.d3DataSourceId, refreshedWorker.d3DataSourceId],
    ["Current Month", worker.currentMonth, refreshedWorker.currentMonth],
    [
      "Current Month field",
      richTextValue(worker.row?.properties?.["Current Month"]).trim(),
      richTextValue(refreshedWorker.row?.properties?.["Current Month"]).trim(),
    ],
    ["Final Sync At", worker.finalSyncAt, refreshedWorker.finalSyncAt],
    ["Sharing Status", worker.sharingStatus, refreshedWorker.sharingStatus],
  ];
  const changedField = stableFields.find(([, before, after]) => before !== after)?.[0];
  if (
    changedField ||
    refreshedWorker.onboardingStatus !== "Ready" ||
    refreshedWorker.active ||
    refreshedWorker.offboardingStatus !== OFFBOARDING_STATUS.FINAL_SYNC ||
    !accessRevocationComplete(refreshedWorker) ||
    refreshedWorker.rolloverManifest
  ) {
    throw new Error(
      `${worker.name}: D1 changed during final offboarding sync; ` +
        "the final state was not recorded. Review the worker and retry.",
    );
  }

  if (
    JSON.stringify(sourceRowsSnapshot(sourceRows)) !==
    JSON.stringify(sourceRowsSnapshot(refreshedSourceRows))
  ) {
    throw new Error(
      `${worker.name}: D3 changed during final offboarding sync; ` +
        "the final state was not recorded. Retry to reconcile the latest values.",
    );
  }
}

async function syncWorker(worker) {
  assertValidWorkerState(worker);
  const completingOffboarding = !worker.active && accessRevocationComplete(worker);
  // Validate the paired D3 database/data-source IDs before writing any state.
  const sourceRows = await sourceRowsForWorker(worker);

  if (!worker.active) {
    await updateOffboarding(worker, {
      "Offboarding Status": select(
        completingOffboarding
          ? OFFBOARDING_STATUS.FINAL_SYNC
          : OFFBOARDING_STATUS.REVOKE_ACCESS,
      ),
      "Offboarding Error": richText(""),
    });
  }

  if (completingOffboarding && sourceRows.some((row) => !row.properties.Datum?.date?.start)) {
    throw new Error(`${worker.name}: final offboarding sync cannot complete while D3 contains an undated row`);
  }

  const result = await syncWorkerToManagement(worker, sourceRows, D7, {
    reconcileMissing: true,
    verify: completingOffboarding,
    fullScan: completingOffboarding,
  });
  for (const warning of result.warnings) console.warn(warning);

  if (completingOffboarding) {
    const refreshedWorker = workerFromRow(await getPage(worker.rowId), worker.currentMonth);
    const refreshedSourceRows = await sourceRowsForWorker(worker);
    assertFinalOffboardingCheckpoint(worker, refreshedWorker, sourceRows, refreshedSourceRows);
  }

  const completionProperties = {};
  if (!richTextValue(worker.row.properties["Current Month"]).trim()) {
    completionProperties["Current Month"] = richText(worker.currentMonth);
  }
  if (completingOffboarding) {
    completionProperties["Offboarding Status"] = select(OFFBOARDING_STATUS.COMPLETE);
    completionProperties["Offboarding Error"] = richText("");
    completionProperties["Final Sync At"] = date(new Date().toISOString());
    completionProperties["Sharing Status"] = select("Revoked");
  } else if (!worker.active) {
    completionProperties["Offboarding Status"] = select(OFFBOARDING_STATUS.REVOKE_ACCESS);
    completionProperties["Offboarding Error"] = richText("");
  } else if (!worker.offboardingStatus) {
    completionProperties["Offboarding Status"] = select(OFFBOARDING_STATUS.ACTIVE);
    completionProperties["Offboarding Error"] = richText("");
  } else if (
    worker.offboardingStatus === OFFBOARDING_STATUS.ACTIVE &&
    (worker.finalSyncAt || worker.sharingStatus === "Revoked")
  ) {
    completionProperties["Final Sync At"] = date("");
    completionProperties["Offboarding Error"] = richText("");
    if (worker.sharingStatus === "Revoked") {
      // Resetting Offboarding Status to Active is the manager's attestation
      // that the three shares were restored before reactivation.
      completionProperties["Sharing Status"] = select("Invited");
    }
  }
  if (Object.keys(completionProperties).length > 0) {
    await updateOffboarding(worker, completionProperties);
  }

  console.log(
    `${worker.name}: ${result.created} created, ${result.updated} updated, ` +
      `${result.archived} stale removed, ${result.unchanged} unchanged` +
      `${completingOffboarding ? "; final offboarding sync verified" : ""}.`,
  );
}

async function markOffboardingError(worker, failure) {
  if (worker.active && !hasActiveOffboardingConflict(worker)) return;
  await updateOffboarding(worker, {
    "Offboarding Status": select(OFFBOARDING_STATUS.ERROR),
    "Offboarding Error": richText(errorMessage(failure).slice(0, 1900)),
  });
}

async function main() {
  await validateSchema();
  const allReadyWorkers = await readyWorkers();
  validateWorkerRegistry(allReadyWorkers);
  const workers = [];
  const checkpointed = [];
  const manifestFailures = [];
  for (const worker of allReadyWorkers) {
    try {
      if (hasPendingRollover(worker)) checkpointed.push(worker);
      else if (worker.active || !offboardingComplete(worker)) workers.push(worker);
    } catch (failure) {
      manifestFailures.push(`${worker.name}: ${errorMessage(failure)}`);
    }
  }
  for (const worker of checkpointed) {
    console.log(
      `${worker.name}: skipped because Month Rollover has a pending verified archive checkpoint.`,
    );
  }
  console.log(`Syncing ${workers.length} active/offboarding Ready worker(s) to D7.`);

  const failures = [...manifestFailures];
  for (const worker of workers) {
    try {
      await syncWorker(worker);
    } catch (failure) {
      console.error(`${worker.name}: ${errorMessage(failure)}`);
      try {
        await markOffboardingError(worker, failure);
      } catch (markFailure) {
        failures.push(
          `${worker.name}: ${errorMessage(failure)}; could not write offboarding error: ${errorMessage(markFailure)}`,
        );
        continue;
      }
      failures.push(`${worker.name}: ${errorMessage(failure)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} management sync failure(s): ${failures.join(" | ")}`);
  }
}

if (require.main === module) {
  main().catch((failure) => {
    console.error(errorMessage(failure));
    process.exitCode = 1;
  });
}

module.exports = {
  assertFinalOffboardingCheckpoint,
  berlinCurrentMonth,
  shouldSyncWorker,
  validateWorkerRegistry,
  workerFromRow,
};
