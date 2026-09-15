"use strict";

const {
  getView,
  listAllViews,
  updateDataSource,
  updateDatabase,
} = require("./notion");

function textItems(content) {
  return [{ type: "text", text: { content } }];
}

function propertyId(dataSource, propertyName) {
  const property = dataSource.properties?.[propertyName];
  if (!property?.id) {
    throw new Error(`Data source ${dataSource.id} is missing property "${propertyName}"`);
  }
  return property.id;
}

function viewProperties(dataSource, visibleNames, hiddenNames = []) {
  const visible = new Set(visibleNames);
  const hidden = new Set(hiddenNames);
  return [...visibleNames, ...hiddenNames].map((name) => ({
    property_id: propertyId(dataSource, name),
    visible: visible.has(name) && !hidden.has(name),
  }));
}

async function defaultTableView(databaseId, dataSourceId) {
  const references = await listAllViews(databaseId);
  const views = await Promise.all(references.map((reference) => getView(reference.id)));
  const tableViews = views.filter(
    (view) => view.data_source_id === dataSourceId && view.type === "table",
  );
  const defaultViews = tableViews.filter((view) => view.name === "Default view");

  if (defaultViews.length === 1) return defaultViews[0];
  if (defaultViews.length > 1) {
    throw new Error(`Database ${databaseId} has multiple table views named "Default view"`);
  }
  if (tableViews.length === 1) return tableViews[0];

  throw new Error(
    `Database ${databaseId} has no uniquely identifiable default table view; refusing to create or overwrite a view.`,
  );
}

async function setDatabaseAndDataSourceTitle(databaseId, dataSourceId, databaseTitle) {
  await updateDatabase(databaseId, { is_inline: true, title: textItems(databaseTitle) });
  await updateDataSource(dataSourceId, {}, { title: textItems(databaseTitle) });
}

module.exports = {
  defaultTableView,
  propertyId,
  setDatabaseAndDataSourceTitle,
  viewProperties,
};
