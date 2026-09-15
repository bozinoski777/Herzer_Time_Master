"use strict";

const {
  assertPropertyTypes,
  databaseIdFromDataSource,
  richTextValue,
} = require("./notion");
const {
  normalizeNotionId,
  workerIdentityFromD1,
} = require("./worker-identity");

const WORKER_DATABASE_ROUTES = Object.freeze({
  d3: Object.freeze({
    label: "D3",
    databaseField: "d3DatabaseId",
    dataSourceField: "d3DataSourceId",
    databaseProperty: "D3 Database ID",
    dataSourceProperty: "D3 Data Source ID",
  }),
  d4: Object.freeze({
    label: "D4",
    databaseField: "d4DatabaseId",
    dataSourceField: "d4DataSourceId",
    databaseProperty: "D4 Database ID",
    dataSourceProperty: "D4 Data Source ID",
  }),
});

const D1_WORKER_REFERENCE_SCHEMA = Object.freeze({
  "D3 Database ID": "rich_text",
  "D3 Data Source ID": "rich_text",
  "D4 Database ID": "rich_text",
  "D4 Data Source ID": "rich_text",
});

function routeDefinition(role) {
  const route = WORKER_DATABASE_ROUTES[String(role || "").toLowerCase()];
  if (!route) throw new Error(`Unknown worker database role "${role || ""}"`);
  return route;
}

function rowText(row, propertyName) {
  return richTextValue(row?.properties?.[propertyName]).trim();
}

function workerReferencesFromD1(row) {
  return {
    ...workerIdentityFromD1(row),
    d3DatabaseId: rowText(row, "D3 Database ID"),
    d3DataSourceId: rowText(row, "D3 Data Source ID"),
    d4DatabaseId: rowText(row, "D4 Database ID"),
    d4DataSourceId: rowText(row, "D4 Data Source ID"),
  };
}

function selectedRoutes(roles = ["d3", "d4"]) {
  return roles.map(routeDefinition);
}

function missingWorkerReferences(
  worker,
  {
    roles = ["d3", "d4"],
    requireWorkerKey = true,
    requireFrontend = false,
  } = {},
) {
  const missing = [];
  if (requireWorkerKey && !String(worker?.workerKey || "").trim()) {
    missing.push("Worker Key");
  }
  if (requireFrontend && !String(worker?.frontendPageId || "").trim()) {
    missing.push("Frontend Page ID");
  }
  for (const route of selectedRoutes(roles)) {
    if (!String(worker?.[route.databaseField] || "").trim()) {
      missing.push(route.databaseProperty);
    }
    if (!String(worker?.[route.dataSourceField] || "").trim()) {
      missing.push(route.dataSourceProperty);
    }
  }
  return missing;
}

function reservedEntries(entries = [], fallbackLabel) {
  return entries
    .map((entry) =>
      typeof entry === "string"
        ? { id: entry, label: fallbackLabel }
        : { id: entry?.id || "", label: entry?.label || fallbackLabel },
    )
    .filter((entry) => String(entry.id || "").trim());
}

/**
 * Reject every non-empty Worker Key/database/data-source collision. D3 and D4
 * deliberately share the same maps, so crossed roles fail as well.
 */
function assertUniqueWorkerReferences(
  workers,
  {
    roles = ["d3", "d4"],
    includeWorkerKeys = true,
    reservedDataSources = [],
    reservedDatabases = [],
  } = {},
) {
  const routes = selectedRoutes(roles);
  const workerKeys = new Map();
  const databases = new Map();
  const dataSources = new Map();

  const reserve = (owners, entries, fallbackLabel) => {
    for (const entry of reservedEntries(entries, fallbackLabel)) {
      const key = normalizeNotionId(entry.id);
      const prior = owners.get(key);
      if (prior) {
        throw new Error(
          `Reserved ${fallbackLabel} ${entry.id} conflicts with ${prior.role} for ${prior.workerName}`,
        );
      }
      owners.set(key, { role: entry.label, workerName: "the POC" });
    }
  };
  reserve(dataSources, reservedDataSources, "data source");
  reserve(databases, reservedDatabases, "database");

  const register = (owners, rawValue, worker, role, normalize = normalizeNotionId) => {
    const value = normalize(rawValue);
    if (!value) return;
    const prior = owners.get(value);
    if (prior) {
      throw new Error(
        `D1 reuses ${role} ${rawValue} for ${worker.name}; it is already ${prior.role} ` +
          `for ${prior.workerName}`,
      );
    }
    owners.set(value, { workerName: worker.name, role });
  };

  for (const worker of workers) {
    if (includeWorkerKeys) {
      register(
        workerKeys,
        worker.workerKey,
        worker,
        "Worker Key",
        (value) => String(value || "").trim(),
      );
    }
    for (const route of routes) {
      register(
        databases,
        worker[route.databaseField],
        worker,
        route.databaseProperty,
      );
      register(
        dataSources,
        worker[route.dataSourceField],
        worker,
        route.dataSourceProperty,
      );
    }
  }
  return workers;
}

function applySchemaAssertion(dataSource, schema) {
  if (!schema) return;
  if (typeof schema === "function") {
    schema(dataSource);
    return;
  }
  assertPropertyTypes(dataSource, schema);
}

function assertWorkerDataSourceReference(worker, role, dataSource, { schema } = {}) {
  const route = routeDefinition(role);
  const databaseId = String(worker?.[route.databaseField] || "").trim();
  const dataSourceId = String(worker?.[route.dataSourceField] || "").trim();
  if (!databaseId || !dataSourceId) {
    throw new Error(`${worker?.name || "Unnamed worker"}: ${route.label} routing data is incomplete`);
  }

  applySchemaAssertion(dataSource, schema);
  if (normalizeNotionId(dataSource?.id) !== normalizeNotionId(dataSourceId)) {
    throw new Error(
      `${worker.name}: retrieved data source ${dataSource?.id || "(unknown)"} does not match stored ` +
        `${route.dataSourceProperty} ${dataSourceId}`,
    );
  }
  const actualDatabaseId = databaseIdFromDataSource(dataSource);
  if (normalizeNotionId(actualDatabaseId) !== normalizeNotionId(databaseId)) {
    throw new Error(
      `${worker.name}: ${route.dataSourceProperty} ${dataSourceId} belongs to database ` +
        `${actualDatabaseId}, not the stored ${route.databaseProperty} ${databaseId}`,
    );
  }
  return dataSource;
}

function databaseDataSourceIds(database) {
  return (database?.data_sources || []).map((source) => source?.id).filter(Boolean);
}

function assertWorkerDatabaseReference(
  worker,
  role,
  database,
  { expectedParentPageId } = {},
) {
  const route = routeDefinition(role);
  const databaseId = String(worker?.[route.databaseField] || "").trim();
  const dataSourceId = String(worker?.[route.dataSourceField] || "").trim();
  if (!databaseId || !dataSourceId) {
    throw new Error(`${worker?.name || "Unnamed worker"}: ${route.label} routing data is incomplete`);
  }
  if (normalizeNotionId(database?.id) !== normalizeNotionId(databaseId)) {
    throw new Error(
      `${worker.name}: retrieved database ${database?.id || "(unknown)"} does not match stored ` +
        `${route.databaseProperty} ${databaseId}`,
    );
  }
  if (
    !databaseDataSourceIds(database).some(
      (candidateId) => normalizeNotionId(candidateId) === normalizeNotionId(dataSourceId),
    )
  ) {
    throw new Error(
      `${worker.name}: ${route.databaseProperty} ${databaseId} does not contain stored ` +
        `${route.dataSourceProperty} ${dataSourceId}`,
    );
  }

  const parentPageId = String(expectedParentPageId || "").trim();
  if (parentPageId) {
    const actualParentPageId = database?.parent?.page_id || "";
    if (normalizeNotionId(actualParentPageId) !== normalizeNotionId(parentPageId)) {
      throw new Error(
        `${worker.name}: ${route.databaseProperty} ${databaseId} belongs to page ` +
          `${actualParentPageId || "(unknown)"}, not frontend page ${parentPageId}`,
      );
    }
  }
  return database;
}

function assertPageBelongsToWorkerRoute(
  page,
  worker,
  role,
  { description = "page" } = {},
) {
  const route = routeDefinition(role);
  const expectedParents = new Set(
    [worker?.[route.databaseField], worker?.[route.dataSourceField]]
      .map(normalizeNotionId)
      .filter(Boolean),
  );
  if (expectedParents.size !== 2) {
    throw new Error(`${worker?.name || "Unnamed worker"}: ${route.label} routing data is incomplete`);
  }
  const parentId = page?.parent?.data_source_id || page?.parent?.database_id || "";
  if (!parentId || !expectedParents.has(normalizeNotionId(parentId))) {
    throw new Error(
      `${worker.name}: ${description} ${page?.id || "(unknown)"} no longer belongs to the recorded ` +
        `${route.label}`,
    );
  }
  return page;
}

function workerDataSourceTargets(
  workers,
  {
    roles = ["d3", "d4"],
    includeWorkerKeys = true,
    reservedDataSources = [],
    reservedDatabases = [],
  } = {},
) {
  assertUniqueWorkerReferences(workers, {
    roles,
    includeWorkerKeys,
    reservedDataSources,
    reservedDatabases,
  });
  const targets = [];
  for (const worker of workers) {
    for (const route of selectedRoutes(roles)) {
      const databaseId = String(worker?.[route.databaseField] || "").trim();
      const dataSourceId = String(worker?.[route.dataSourceField] || "").trim();
      if (!databaseId && !dataSourceId) continue;
      if (!databaseId || !dataSourceId) {
        throw new Error(
          `${worker?.name || "Unnamed worker"}: ${route.label} routing data is incomplete`,
        );
      }
      targets.push({
        worker,
        role: route.label.toLowerCase(),
        label: `${worker.name} ${route.label}`,
        databaseId,
        dataSourceId,
      });
    }
  }
  return targets;
}

module.exports = {
  D1_WORKER_REFERENCE_SCHEMA,
  WORKER_DATABASE_ROUTES,
  assertPageBelongsToWorkerRoute,
  assertUniqueWorkerReferences,
  assertWorkerDatabaseReference,
  assertWorkerDataSourceReference,
  missingWorkerReferences,
  normalizeNotionId,
  workerDataSourceTargets,
  workerReferencesFromD1,
};
