"use strict";

/**
 * Management-facing content on each D8 Standort row page. Every view below is
 * linked to the existing D7/D8 data sources; no new day store is created.
 */

const {
  assertPropertyTypes,
  createView,
  getDataSource,
  getView,
  listAllBlockChildren,
  listAllViews,
  queryAll,
  titleValue,
  updateDataSource,
  updateView,
} = require("./notion");
const { propertyId, viewProperties } = require("./database-presentation");

const DASHBOARD_TITLE = "Standort-KPIs";
const HOURS_WIDGET_TITLE = "Arbeitsstunden gesamt";
const WORKERS_WIDGET_TITLE = "Eingesetzte Mitarbeitende";
const DAYS_TABLE_TITLE = "Arbeitszeiten am Standort";
const WORKER_NAMES_ROLLUP = "Mitarbeitende (einmalig)";
const D8_D7_RELATION = "Arbeitszeiten (D7)";
const D7_D8_RELATION = "Standort (D8)";

function siteName(row) {
  return titleValue(row.properties?.Standort).trim();
}

function canonicalPropertyId(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function validatePresentationSchemas(d7, d8) {
  assertPropertyTypes(d7, {
    Wochentag: "title",
    Datum: "date",
    Stunden: "number",
    Standort: "select",
    [D7_D8_RELATION]: "relation",
    "Vor- und Nachname": "rich_text",
    "Worker Key": "rich_text",
    "Sync Key": "rich_text",
    "Source Page ID": "rich_text",
    "Source Database ID": "rich_text",
    "Last Synced At": "date",
  });
  assertPropertyTypes(d8, {
    Standort: "title",
    Active: "checkbox",
    [D8_D7_RELATION]: "relation",
    "Gearbeitete Stunden": "rollup",
  });
}

function workerNamesRollupMatches(d7, d8) {
  const property = d8.properties?.[WORKER_NAMES_ROLLUP];
  if (!property) return false;
  if (property.type !== "rollup") {
    throw new Error(`D8 property "${WORKER_NAMES_ROLLUP}" exists but is not a Rollup`);
  }
  const rollup = property.rollup || {};
  const relationMatches =
    canonicalPropertyId(rollup.relation_property_id) ===
      canonicalPropertyId(propertyId(d8, D8_D7_RELATION)) ||
    rollup.relation_property_name === D8_D7_RELATION;
  const sourceMatches =
    canonicalPropertyId(rollup.rollup_property_id) ===
      canonicalPropertyId(propertyId(d7, "Vor- und Nachname")) ||
    rollup.rollup_property_name === "Vor- und Nachname";
  if (!relationMatches || !sourceMatches || rollup.function !== "show_unique") {
    throw new Error(
      `D8 property "${WORKER_NAMES_ROLLUP}" has a different configuration; ` +
        "correct it manually before Standort sync changes this page",
    );
  }
  return true;
}

async function ensureWorkerNamesRollup(d7, d8, operations = {}) {
  const update = operations.updateDataSource || updateDataSource;
  const retrieve = operations.getDataSource || getDataSource;
  validatePresentationSchemas(d7, d8);
  if (workerNamesRollupMatches(d7, d8)) return d8;

  await update(d8.id, {
    [WORKER_NAMES_ROLLUP]: {
      rollup: {
        relation_property_name: D8_D7_RELATION,
        rollup_property_name: "Vor- und Nachname",
        function: "show_unique",
      },
    },
  });
  const refreshed = await retrieve(d8.id);
  validatePresentationSchemas(d7, refreshed);
  if (!workerNamesRollupMatches(d7, refreshed)) {
    throw new Error(`D8 did not expose the new "${WORKER_NAMES_ROLLUP}" rollup`);
  }
  return refreshed;
}

function siteD7Filter(sitePageId) {
  return { property: D7_D8_RELATION, relation: { contains: sitePageId } };
}

function siteD8Filter(name) {
  // Current data-source filters use rich_text for text comparisons, including
  // the title property; there is no separate title filter in this API version.
  return { property: "Standort", rich_text: { equals: name } };
}

function hoursWidgetPayload(d7, sitePageId) {
  return {
    name: HOURS_WIDGET_TITLE,
    filter: siteD7Filter(sitePageId),
    configuration: {
      type: "chart",
      chart_type: "number",
      value: { aggregator: "sum", property_id: propertyId(d7, "Stunden") },
      height: "small",
      hide_title: false,
    },
  };
}

function workersWidgetPayload(d8, name) {
  return {
    name: WORKERS_WIDGET_TITLE,
    filter: siteD8Filter(name),
    configuration: {
      type: "list",
      properties: viewProperties(
        d8,
        ["Standort", WORKER_NAMES_ROLLUP],
        ["Active", D8_D7_RELATION, "Gearbeitete Stunden"],
      ),
    },
  };
}

function daysTablePayload(d7, sitePageId) {
  return {
    name: DAYS_TABLE_TITLE,
    filter: siteD7Filter(sitePageId),
    sorts: [{ property: "Datum", direction: "descending" }],
    configuration: {
      type: "table",
      properties: viewProperties(
        d7,
        ["Wochentag", "Datum", "Vor- und Nachname", "Stunden", "Standort"],
        [
          D7_D8_RELATION,
          "Worker Key",
          "Sync Key",
          "Source Page ID",
          "Source Database ID",
          "Last Synced At",
        ],
      ),
      group_by: null,
    },
  };
}

function propertyReferenceMatches(actual, name, property) {
  return (
    actual === name ||
    canonicalPropertyId(actual) === canonicalPropertyId(property?.id)
  );
}

function managedViewMatches(view, payload, dataSource, kind) {
  if (view.name !== payload.name || view.type !== kind || view.data_source_id !== dataSource.id) {
    return false;
  }
  const expectedFilter = payload.filter;
  const actualFilter = view.filter;
  const filterName = expectedFilter.property;
  if (!propertyReferenceMatches(actualFilter?.property, filterName, dataSource.properties?.[filterName])) {
    return false;
  }
  if (expectedFilter.relation?.contains !== actualFilter?.relation?.contains) return false;
  if (expectedFilter.rich_text?.equals !== actualFilter?.rich_text?.equals) return false;

  if (kind === "chart") {
    return (
      view.configuration?.chart_type === "number" &&
      view.configuration?.value?.aggregator === "sum" &&
      view.configuration?.hide_title !== true &&
      canonicalPropertyId(view.configuration?.value?.property_id) ===
        canonicalPropertyId(payload.configuration.value.property_id)
    );
  }

  const expectedProperties = payload.configuration.properties;
  const actualProperties = view.configuration?.properties || [];
  const actualById = new Map(actualProperties.map((entry) => [
    canonicalPropertyId(entry.property_id), entry,
  ]));
  if (!expectedProperties.every((entry) => {
    const actual = actualById.get(canonicalPropertyId(entry.property_id));
    if (!actual) return false;
    return entry.visible ? actual.visible !== false : actual.visible === false;
  })) return false;

  if (kind === "table") {
    const firstSort = view.sorts?.[0];
    return (
      propertyReferenceMatches(firstSort?.property, "Datum", dataSource.properties?.Datum) &&
      firstSort?.direction === "descending"
    );
  }
  return true;
}

async function directManagedViews(pageId, operations = {}) {
  const listChildren = operations.listAllBlockChildren || listAllBlockChildren;
  const listViews = operations.listAllViews || listAllViews;
  const retrieveView = operations.getView || getView;
  const blocks = await listChildren(pageId);
  const found = [];
  for (const block of blocks) {
    if (block.type !== "child_database") continue;
    for (const reference of await listViews(block.id)) {
      const view = await retrieveView(reference.id);
      if (view.dashboard_view_id) continue;
      if ([DASHBOARD_TITLE, DAYS_TABLE_TITLE].includes(view.name)) {
        found.push({ view, blockId: block.id });
      }
    }
  }
  for (const name of [DASHBOARD_TITLE, DAYS_TABLE_TITLE]) {
    if (found.filter((entry) => entry.view.name === name).length > 1) {
      throw new Error(`D8 page ${pageId} has multiple "${name}" views; refusing to create another`);
    }
  }
  return found;
}

function assertManagedView(view, name, type, dataSourceId) {
  if (view.name !== name || view.type !== type || view.data_source_id !== dataSourceId) {
    throw new Error(`Managed Standort view "${name}" conflicts with an existing view ${view.id}`);
  }
}

async function dashboardWidgets(dashboardId, operations = {}) {
  const retrieve = operations.getView || getView;
  const dashboard = await retrieve(dashboardId);
  const widgets = [];
  for (const [rowIndex, row] of (dashboard.configuration?.rows || []).entries()) {
    for (const widget of row.widgets || []) {
      widgets.push({ view: await retrieve(widget.view_id), rowIndex });
    }
  }
  for (const name of [HOURS_WIDGET_TITLE, WORKERS_WIDGET_TITLE]) {
    if (widgets.filter((entry) => entry.view.name === name).length > 1) {
      throw new Error(`Standort dashboard ${dashboardId} has multiple "${name}" widgets`);
    }
  }
  return widgets;
}

async function ensureWidget(dashboardId, name, type, dataSource, payload, placement, operations = {}) {
  const create = operations.createView || createView;
  const update = operations.updateView || updateView;
  const widgets = await dashboardWidgets(dashboardId, operations);
  const existing = widgets.find((entry) => entry.view.name === name);
  if (existing) {
    assertManagedView(existing.view, name, type, dataSource.id);
    if (!managedViewMatches(existing.view, payload, dataSource, type)) {
      await update(existing.view.id, payload);
    }
    return existing;
  }
  await create({
    view_id: dashboardId,
    data_source_id: dataSource.id,
    name,
    type,
    placement,
    ...payload,
  });
  const recovered = (await dashboardWidgets(dashboardId, operations)).find(
    (entry) => entry.view.name === name,
  );
  if (!recovered) throw new Error(`Could not recover "${name}" after creating it`);
  assertManagedView(recovered.view, name, type, dataSource.id);
  return recovered;
}

async function ensureStandortPagePresentation(site, d7, d8, operations = {}) {
  const name = siteName(site);
  if (!site.id || !name) {
    throw new Error(`D8 page ${site.id || "(missing ID)"} needs a non-empty Standort title`);
  }
  const create = operations.createView || createView;
  const update = operations.updateView || updateView;
  const views = await directManagedViews(site.id, operations);
  let dashboard = views.find((entry) => entry.view.name === DASHBOARD_TITLE);
  if (dashboard) {
    assertManagedView(dashboard.view, DASHBOARD_TITLE, "dashboard", null);
  } else {
    await create({
      create_database: { parent: { type: "page_id", page_id: site.id } },
      data_source_id: d7.id,
      name: DASHBOARD_TITLE,
      type: "dashboard",
    });
    dashboard = (await directManagedViews(site.id, operations)).find(
      (entry) => entry.view.name === DASHBOARD_TITLE,
    );
    if (!dashboard) throw new Error(`Could not recover the KPI dashboard on D8 page ${site.id}`);
  }

  const hours = await ensureWidget(
    dashboard.view.id,
    HOURS_WIDGET_TITLE,
    "chart",
    d7,
    hoursWidgetPayload(d7, site.id),
    { type: "new_row", row_index: 0 },
    operations,
  );
  await ensureWidget(
    dashboard.view.id,
    WORKERS_WIDGET_TITLE,
    "list",
    d8,
    workersWidgetPayload(d8, name),
    { type: "existing_row", row_index: hours.rowIndex },
    operations,
  );
  const finalWidgets = await dashboardWidgets(dashboard.view.id, operations);
  const hoursRow = finalWidgets.find((entry) => entry.view.name === HOURS_WIDGET_TITLE)?.rowIndex;
  const workersRow = finalWidgets.find((entry) => entry.view.name === WORKERS_WIDGET_TITLE)?.rowIndex;
  if (hoursRow !== workersRow) {
    throw new Error(
      `D8 page ${site.id} has Standort KPI widgets in different dashboard rows; ` +
        "move them side by side in Notion before retrying",
    );
  }

  const existingDays = views.find((entry) => entry.view.name === DAYS_TABLE_TITLE);
  const payload = daysTablePayload(d7, site.id);
  if (existingDays) {
    assertManagedView(existingDays.view, DAYS_TABLE_TITLE, "table", d7.id);
    if (!managedViewMatches(existingDays.view, payload, d7, "table")) {
      await update(existingDays.view.id, payload);
    }
  } else {
    await create({
      create_database: {
        parent: { type: "page_id", page_id: site.id },
        position: { type: "after_block", block_id: dashboard.blockId },
      },
      data_source_id: d7.id,
      name: DAYS_TABLE_TITLE,
      type: "table",
      ...payload,
    });
    const recovered = (await directManagedViews(site.id, operations)).find(
      (entry) => entry.view.name === DAYS_TABLE_TITLE,
    );
    if (!recovered) throw new Error(`Could not recover the D7 table on D8 page ${site.id}`);
    assertManagedView(recovered.view, DAYS_TABLE_TITLE, "table", d7.id);
  }
}

async function ensureAllStandortPagePresentations(d7DataSourceId, d8DataSourceId, operations = {}) {
  const retrieve = operations.getDataSource || getDataSource;
  const query = operations.queryAll || queryAll;
  const d7 = await retrieve(d7DataSourceId);
  const originalD8 = await retrieve(d8DataSourceId);
  validatePresentationSchemas(d7, originalD8);
  const rows = await query(d8DataSourceId);
  const seenNames = new Set();
  for (const row of rows) {
    const name = siteName(row);
    if (!name || seenNames.has(name)) {
      throw new Error(`D8 contains a blank or duplicate Standort title (${name || "blank"})`);
    }
    seenNames.add(name);
  }
  const d8 = await ensureWorkerNamesRollup(d7, originalD8, operations);
  for (const row of rows) await ensureStandortPagePresentation(row, d7, d8, operations);
  return rows.length;
}

module.exports = {
  DASHBOARD_TITLE,
  DAYS_TABLE_TITLE,
  HOURS_WIDGET_TITLE,
  WORKERS_WIDGET_TITLE,
  WORKER_NAMES_ROLLUP,
  daysTablePayload,
  directManagedViews,
  ensureAllStandortPagePresentations,
  ensureStandortPagePresentation,
  ensureWorkerNamesRollup,
  hoursWidgetPayload,
  managedViewMatches,
  siteD7Filter,
  workersWidgetPayload,
};
