"use strict";

/** Linked views of D7 on each D8 Standort page; no duplicate day store. */

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
  updateDatabase,
  updateView,
} = require("./notion");
const { propertyId, viewProperties } = require("./database-presentation");

const HOURS_CHART_TITLE = "Arbeitsstunden gesamt";
const DAYS_TABLE_TITLE = "Arbeitszeiten am Standort";
const NAME_COLUMN = "Name";
const NAME_FORMULA = 'prop("Vor- und Nachname")';
const LEGACY_DASHBOARD_TITLE = "Standort-KPIs";
const LEGACY_WORKERS_WIDGET_TITLE = "Eingesetzte Mitarbeitende";
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
  });
  assertPropertyTypes(d8, {
    Standort: "title",
    Active: "checkbox",
    "Arbeitszeiten (D7)": "relation",
    "Gearbeitete Stunden": "rollup",
  });
}

function nameFormulaMatches(d7) {
  const property = d7.properties?.[NAME_COLUMN];
  if (!property) return false;
  if (property.type !== "formula") {
    throw new Error(`D7 property "${NAME_COLUMN}" exists but is not a Formula`);
  }
  const expression = property.formula?.expression || "";
  const sourceId = canonicalPropertyId(propertyId(d7, "Vor- und Nachname"));
  const canonicalExpression = canonicalPropertyId(expression);
  const isDirectToken = canonicalExpression.startsWith(
    `{{notion:block_property:${sourceId}:`,
  ) && canonicalExpression.endsWith("}}");
  if (expression !== NAME_FORMULA && !isDirectToken) {
    throw new Error(
      `D7 property "${NAME_COLUMN}" is not a direct formula for "Vor- und Nachname"; ` +
        "correct it manually before Standort sync changes these views",
    );
  }
  return true;
}

async function ensureNameFormula(d7, operations = {}) {
  if (nameFormulaMatches(d7)) return d7;
  const update = operations.updateDataSource || updateDataSource;
  const retrieve = operations.getDataSource || getDataSource;
  await update(d7.id, { [NAME_COLUMN]: { formula: { expression: NAME_FORMULA } } });
  const refreshed = await retrieve(d7.id);
  if (!nameFormulaMatches(refreshed)) {
    throw new Error(`D7 did not expose the new "${NAME_COLUMN}" formula`);
  }
  return refreshed;
}

function siteD7Filter(sitePageId) {
  return { property: D7_D8_RELATION, relation: { contains: sitePageId } };
}

function hoursChartPayload(d7, sitePageId) {
  return {
    name: HOURS_CHART_TITLE,
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

function daysTablePayload(d7, sitePageId) {
  const visible = [NAME_COLUMN, "Wochentag", "Datum", "Stunden"];
  return {
    name: DAYS_TABLE_TITLE,
    filter: siteD7Filter(sitePageId),
    sorts: [{ property: "Datum", direction: "descending" }],
    configuration: {
      type: "table",
      properties: viewProperties(
        d7,
        visible,
        Object.keys(d7.properties).filter((name) => !visible.includes(name)),
      ),
      group_by: null,
    },
  };
}

function propertyReferenceMatches(actual, name, property) {
  return actual === name ||
    canonicalPropertyId(actual) === canonicalPropertyId(property?.id);
}

function managedViewMatches(view, payload, d7, type) {
  if (view.name !== payload.name || view.type !== type || view.data_source_id !== d7.id) {
    return false;
  }
  const filterName = payload.filter.property;
  if (!propertyReferenceMatches(
    view.filter?.property, filterName, d7.properties?.[filterName],
  ) || view.filter?.relation?.contains !== payload.filter.relation.contains) {
    return false;
  }

  if (type === "chart") {
    return view.configuration?.chart_type === "number" &&
      view.configuration?.value?.aggregator === "sum" &&
      view.configuration?.height === "small" &&
      view.configuration?.hide_title === false &&
      canonicalPropertyId(view.configuration?.value?.property_id) ===
        canonicalPropertyId(payload.configuration.value.property_id);
  }

  const expected = payload.configuration.properties;
  const actual = view.configuration?.properties || [];
  const actualById = new Map(actual.map((entry) => [
    canonicalPropertyId(entry.property_id), entry,
  ]));
  if (!expected.every((entry) => {
    const current = actualById.get(canonicalPropertyId(entry.property_id));
    return current && (entry.visible ? current.visible !== false : current.visible === false);
  })) return false;
  const actualVisible = actual.filter((entry) => entry.visible !== false)
    .map((entry) => canonicalPropertyId(entry.property_id));
  const expectedVisible = expected.filter((entry) => entry.visible)
    .map((entry) => canonicalPropertyId(entry.property_id));
  if (JSON.stringify(actualVisible) !== JSON.stringify(expectedVisible)) return false;
  const sort = view.sorts?.[0];
  return propertyReferenceMatches(sort?.property, "Datum", d7.properties?.Datum) &&
    sort?.direction === "descending" && view.configuration?.group_by == null;
}

async function directManagedViews(pageId, operations = {}) {
  const listChildren = operations.listAllBlockChildren || listAllBlockChildren;
  const listViews = operations.listAllViews || listAllViews;
  const retrieveView = operations.getView || getView;
  const blocks = await listChildren(pageId);
  const names = [HOURS_CHART_TITLE, DAYS_TABLE_TITLE, LEGACY_DASHBOARD_TITLE];
  const found = [];
  for (const [blockIndex, block] of blocks.entries()) {
    if (block.type !== "child_database") continue;
    for (const reference of await listViews(block.id)) {
      const view = await retrieveView(reference.id);
      if (!view.dashboard_view_id && names.includes(view.name)) {
        found.push({ view, blockId: block.id, blockIndex });
      }
    }
  }
  for (const name of names) {
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

async function assertLegacyDashboardSafe(dashboard, blockId, d7, d8, operations = {}) {
  assertManagedView(dashboard, LEGACY_DASHBOARD_TITLE, "dashboard", null);
  const listViews = operations.listAllViews || listAllViews;
  const references = await listViews(blockId);
  if (references.length !== 1 || references[0].id !== dashboard.id) {
    throw new Error(
      `Standort dashboard ${dashboard.id} shares a linked database with other views; ` +
        "remove it manually before migration",
    );
  }
  const retrieve = operations.getView || getView;
  const allowed = new Map([
    [HOURS_CHART_TITLE, { type: "chart", dataSourceId: d7.id }],
    [LEGACY_WORKERS_WIDGET_TITLE, { type: "list", dataSourceId: d8.id }],
  ]);
  const seen = new Set();
  for (const row of dashboard.configuration?.rows || []) {
    for (const widget of row.widgets || []) {
      const view = await retrieve(widget.view_id);
      const expected = allowed.get(view?.name);
      if (!expected || seen.has(view.name) || view.type !== expected.type ||
          view.data_source_id !== expected.dataSourceId ||
          view.dashboard_view_id !== dashboard.id) {
        throw new Error(
          `Standort dashboard ${dashboard.id} contains an unknown or changed widget; ` +
            "remove it manually before migration",
        );
      }
      seen.add(view.name);
    }
  }
}

function assertPlaceable(pageId, views) {
  const chart = views.find((entry) => entry.view.name === HOURS_CHART_TITLE);
  const table = views.find((entry) => entry.view.name === DAYS_TABLE_TITLE);
  const legacy = views.find((entry) => entry.view.name === LEGACY_DASHBOARD_TITLE);
  if ((chart && table && chart.blockIndex >= table.blockIndex) ||
      (!chart && table && (!legacy || legacy.blockIndex >= table.blockIndex))) {
    throw new Error(
      `D8 page ${pageId} has its D7 table above the hours chart; ` +
        "move the table below the chart in Notion before retrying",
    );
  }
}

async function ensureStandortPagePresentation(site, d7, d8, operations = {}) {
  const name = siteName(site);
  if (!site.id || !name) {
    throw new Error(`D8 page ${site.id || "(missing ID)"} needs a non-empty Standort title`);
  }
  const create = operations.createView || createView;
  const update = operations.updateView || updateView;
  const trashDatabase = operations.updateDatabase || updateDatabase;
  let views = await directManagedViews(site.id, operations);
  assertPlaceable(site.id, views);
  const legacy = views.find((entry) => entry.view.name === LEGACY_DASHBOARD_TITLE);
  if (legacy) await assertLegacyDashboardSafe(legacy.view, legacy.blockId, d7, d8, operations);

  let chart = views.find((entry) => entry.view.name === HOURS_CHART_TITLE);
  const chartPayload = hoursChartPayload(d7, site.id);
  if (chart) {
    assertManagedView(chart.view, HOURS_CHART_TITLE, "chart", d7.id);
    if (!managedViewMatches(chart.view, chartPayload, d7, "chart")) {
      await update(chart.view.id, chartPayload);
    }
  } else {
    await create({
      create_database: {
        parent: { type: "page_id", page_id: site.id },
        ...(legacy ? {
          position: { type: "after_block", block_id: legacy.blockId },
        } : {}),
      },
      data_source_id: d7.id,
      name: HOURS_CHART_TITLE,
      type: "chart",
      ...chartPayload,
    });
    views = await directManagedViews(site.id, operations);
    chart = views.find((entry) => entry.view.name === HOURS_CHART_TITLE);
    if (!chart) throw new Error(`Could not recover the D7 hours chart on D8 page ${site.id}`);
    assertManagedView(chart.view, HOURS_CHART_TITLE, "chart", d7.id);
  }

  const table = views.find((entry) => entry.view.name === DAYS_TABLE_TITLE);
  const tablePayload = daysTablePayload(d7, site.id);
  if (table) {
    assertManagedView(table.view, DAYS_TABLE_TITLE, "table", d7.id);
    if (!managedViewMatches(table.view, tablePayload, d7, "table")) {
      await update(table.view.id, tablePayload);
    }
  } else {
    await create({
      create_database: {
        parent: { type: "page_id", page_id: site.id },
        position: { type: "after_block", block_id: chart.blockId },
      },
      data_source_id: d7.id,
      name: DAYS_TABLE_TITLE,
      type: "table",
      ...tablePayload,
    });
    views = await directManagedViews(site.id, operations);
    const recovered = views.find((entry) => entry.view.name === DAYS_TABLE_TITLE);
    if (!recovered) throw new Error(`Could not recover the D7 table on D8 page ${site.id}`);
    assertManagedView(recovered.view, DAYS_TABLE_TITLE, "table", d7.id);
  }

  // The old Business-only dashboard is a linked view, not a D7/D8 data store.
  // Trash it only after both replacement views exist in the correct order.
  views = await directManagedViews(site.id, operations);
  assertPlaceable(site.id, views);
  for (const [viewName, type, payload] of [
    [HOURS_CHART_TITLE, "chart", chartPayload],
    [DAYS_TABLE_TITLE, "table", tablePayload],
  ]) {
    const replacement = views.find((entry) => entry.view.name === viewName)?.view;
    if (!replacement || !managedViewMatches(replacement, payload, d7, type)) {
      throw new Error(`D8 page ${site.id} did not verify its new "${viewName}" view`);
    }
  }
  if (legacy) await trashDatabase(legacy.blockId, { in_trash: true });
}

async function ensureAllStandortPagePresentations(d7DataSourceId, d8DataSourceId, operations = {}) {
  const retrieve = operations.getDataSource || getDataSource;
  const query = operations.queryAll || queryAll;
  const originalD7 = await retrieve(d7DataSourceId);
  const d8 = await retrieve(d8DataSourceId);
  validatePresentationSchemas(originalD7, d8);
  const rows = await query(d8DataSourceId);
  const seenNames = new Set();
  for (const row of rows) {
    const name = siteName(row);
    if (!name || seenNames.has(name)) {
      throw new Error(`D8 contains a blank or duplicate Standort title (${name || "blank"})`);
    }
    seenNames.add(name);
  }
  const d7 = await ensureNameFormula(originalD7, operations);
  for (const row of rows) await ensureStandortPagePresentation(row, d7, d8, operations);
  return rows.length;
}

module.exports = {
  DAYS_TABLE_TITLE,
  HOURS_CHART_TITLE,
  LEGACY_DASHBOARD_TITLE,
  NAME_COLUMN,
  daysTablePayload,
  directManagedViews,
  ensureAllStandortPagePresentations,
  ensureNameFormula,
  ensureStandortPagePresentation,
  hoursChartPayload,
  managedViewMatches,
  siteD7Filter,
};
