"use strict";

const crypto = require("node:crypto");

const {
  assertPropertyTypes,
  createPage,
  dataSourceIdFromDatabase,
  databaseIdFromDataSource,
  date,
  errorMessage,
  getDataSource,
  getDatabase,
  getPage,
  movePage,
  notion,
  queryAll,
  requireEnv,
  richText,
  richTextValue,
  select,
  title,
  titleValue,
  updateDataSource,
  updatePage,
} = require("./notion");

const {
  ARCHIVE_DATABASE_TITLE,
  CURRENT_MONTH_DATABASE_TITLE,
  archiveSchemaProperties,
  ensureArchivePresentation,
  ensureCurrentMonthPresentation,
  hideInternalFrontendColumnsInManagementView,
} = require("./frontend-presentation");
const { workerStandortNames, workerStandortOptions } = require("./worker-standort-options");

const { D1_DATA_SOURCE_ID: D1, D8_DATA_SOURCE_ID: D8 } = requireEnv(
  "D1_DATA_SOURCE_ID",
  "D8_DATA_SOURCE_ID",
);

// The new secret is the normal configuration. The legacy parent-page secret is
// retained only as a migration fallback so a deployed workflow can find the
// one Employee Front-ends database without guessing outside this POC.
const EMPLOYEE_FRONTENDS_DATA_SOURCE_ID =
  process.env.EMPLOYEE_FRONTENDS_DATA_SOURCE_ID?.trim() || "";
const LEGACY_EMPLOYEE_FRONTEND_PAGE_ID =
  process.env.EMPLOYEE_FRONTEND_PAGE_ID?.trim() || "";

if (!EMPLOYEE_FRONTENDS_DATA_SOURCE_ID && !LEGACY_EMPLOYEE_FRONTEND_PAGE_ID) {
  throw new Error(
    "Missing EMPLOYEE_FRONTENDS_DATA_SOURCE_ID (or legacy EMPLOYEE_FRONTEND_PAGE_ID for migration discovery)",
  );
}

const WEEKDAYS = [
  "Sonntag",
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag",
];
const WORKER_FRONTEND_ICON = { type: "emoji", emoji: "👤" };

const D1_SCHEMA = {
  "Vor- und Nachname": "title",
  Email: "email",
  Active: "checkbox",
  "Onboarding Status": "select",
  "Onboarding Error": "rich_text",
  "Onboarded At": "date",
  "Worker Key": "rich_text",
  // Retained while existing POC records migrate to the clearer frontend names.
  "User Page ID": "rich_text",
  "Frontend Page ID": "rich_text",
  "Frontend URL": "url",
  "Sharing Status": "select",
  "D3 Database ID": "rich_text",
  "D3 Data Source ID": "rich_text",
  "D4 Database ID": "rich_text",
  "D4 Data Source ID": "rich_text",
};

const FRONTENDS_SCHEMA = {
  "Vor- und Nachname": "title",
  "Worker Key": "rich_text",
  "D1 Record ID": "rich_text",
};

let employeeFrontendsDataSourceId;
let legacyPocPageId;

function workerKey() {
  return `wrk_${crypto.randomUUID()}`;
}

function berlinCurrentMonth() {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());

  const part = (type) => Number(parts.find((item) => item.type === type)?.value);
  return { year: part("year"), month: part("month") };
}

function berlinCurrentMonthKey() {
  const { year, month } = berlinCurrentMonth();
  return `${year}-${String(month).padStart(2, "0")}`;
}

function currentMonthDates() {
  const { year, month } = berlinCurrentMonth();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const isoDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const weekday = WEEKDAYS[new Date(`${isoDate}T12:00:00Z`).getUTCDay()];
    return { isoDate, weekday };
  });
}

function d1Value(row, propertyName) {
  return richTextValue(row.properties[propertyName]).trim();
}

function frontendUrl(page) {
  return page.url || `https://www.notion.so/${page.id.replaceAll("-", "")}`;
}

async function updateD1(rowId, properties) {
  return updatePage(rowId, properties);
}

async function findExactChild(parentPageId, blockType, names) {
  const acceptedNames = new Set(Array.isArray(names) ? names : [names]);
  const matches = (await listAllBlockChildren(parentPageId)).filter(
    (block) => block.type === blockType && acceptedNames.has(block[blockType]?.title),
  );

  if (matches.length > 1) {
    throw new Error(
      `Found multiple ${blockType} blocks named "${[...acceptedNames].join('" or "')}" under ${parentPageId}`,
    );
  }
  return matches[0];
}

async function legacyPocParentId() {
  if (legacyPocPageId) return legacyPocPageId;
  if (!LEGACY_EMPLOYEE_FRONTEND_PAGE_ID) return "";

  const legacyParent = await getPage(LEGACY_EMPLOYEE_FRONTEND_PAGE_ID);
  const pageId = legacyParent.parent?.page_id;
  if (!pageId) {
    throw new Error(
      `Legacy employee front-end page ${LEGACY_EMPLOYEE_FRONTEND_PAGE_ID} is not inside a POC page`,
    );
  }
  legacyPocPageId = pageId;
  return legacyPocPageId;
}

async function frontendsDataSourceId() {
  if (employeeFrontendsDataSourceId) return employeeFrontendsDataSourceId;

  if (EMPLOYEE_FRONTENDS_DATA_SOURCE_ID) {
    employeeFrontendsDataSourceId = EMPLOYEE_FRONTENDS_DATA_SOURCE_ID;
  } else {
    const pocPageId = await legacyPocParentId();
    const indexDatabase = await findExactChild(pocPageId, "child_database", "Employee Front-ends");
    if (!indexDatabase) {
      throw new Error(
        "Could not find the Employee Front-ends database. Set EMPLOYEE_FRONTENDS_DATA_SOURCE_ID explicitly.",
      );
    }
    employeeFrontendsDataSourceId = dataSourceIdFromDatabase(await getDatabase(indexDatabase.id));
  }

  const frontends = await getDataSource(employeeFrontendsDataSourceId);
  assertPropertyTypes(frontends, FRONTENDS_SCHEMA);
  return employeeFrontendsDataSourceId;
}

async function validateSchema() {
  const d1 = await getDataSource(D1);
  assertPropertyTypes(d1, D1_SCHEMA);
  const d8 = await getDataSource(D8);
  assertPropertyTypes(d8, { Standort: "title", Active: "checkbox" });
  const frontendsDataSource = await frontendsDataSourceId();
  // This hides internal identifiers in the private management table. It does
  // not remove either property or change any frontend row values.
  await hideInternalFrontendColumnsInManagementView(frontendsDataSource);
}

async function activeStandorte() {
  const rows = await queryAll(D8, {
    property: "Active",
    checkbox: { equals: true },
  });
  return [...new Set(
    rows.map((row) => titleValue(row.properties.Standort).trim()).filter(Boolean),
  )];
}

async function persistFrontend(rowId, page) {
  await updateD1(rowId, {
    "Frontend Page ID": richText(page.id),
    "Frontend URL": { url: frontendUrl(page) },
    // Keep the old field synchronized until every consumer has moved over.
    "User Page ID": richText(page.id),
  });
}

async function setFrontendIndexProperties(pageId, name, key, d1RecordId) {
  await updatePage(pageId, {
    "Vor- und Nachname": title(name),
    "Worker Key": richText(key),
    "D1 Record ID": richText(d1RecordId),
  }, { icon: WORKER_FRONTEND_ICON });
}

async function findRecoverableFrontend(name, key, d1RecordId) {
  const rows = await queryAll(await frontendsDataSourceId());
  const matches = rows.filter((candidate) => {
    const candidateName = titleValue(candidate.properties["Vor- und Nachname"]).trim();
    const candidateKey = richTextValue(candidate.properties["Worker Key"]).trim();
    const candidateD1Id = richTextValue(candidate.properties["D1 Record ID"]).trim();
    return candidateName === name || candidateKey === key || candidateD1Id === d1RecordId;
  });
  if (matches.length > 1) {
    throw new Error(
      `Employee Front-ends has multiple rows that could belong to ${name}; refusing to create or choose a duplicate.`,
    );
  }
  return matches[0];
}

async function moveLegacyPageIntoIndex(page, frontendsDataSource) {
  if (page.parent?.type === "data_source_id") {
    if (page.parent.data_source_id === frontendsDataSource) return page;
    throw new Error(
      `Frontend page ${page.id} belongs to a different data source; refusing to move it outside the POC boundary.`,
    );
  }

  const pocPageId = await legacyPocParentId();
  const approvedParents = new Set([pocPageId, LEGACY_EMPLOYEE_FRONTEND_PAGE_ID]);
  if (page.parent?.type !== "page_id" || !approvedParents.has(page.parent.page_id)) {
    throw new Error(
      `Frontend page ${page.id} is not in an approved Secure Timekeeping POC legacy location; refusing to move it.`,
    );
  }

  return movePage(page.id, {
    type: "data_source_id",
    data_source_id: frontendsDataSource,
  });
}

async function resolveWorkerPage(row, name, key) {
  const rememberedId = d1Value(row, "Frontend Page ID") || d1Value(row, "User Page ID");
  const frontendsDataSource = await frontendsDataSourceId();

  if (rememberedId) {
    const remembered = await moveLegacyPageIntoIndex(await getPage(rememberedId), frontendsDataSource);
    await setFrontendIndexProperties(remembered.id, name, key, row.id);
    await persistFrontend(row.id, remembered);
    return remembered;
  }

  // A prior run can create the row before it writes D1. Recover the one
  // deterministic match rather than creating a second worker-facing page.
  const existing = await findRecoverableFrontend(name, key, row.id);
  if (existing) {
    const recovered = await getPage(existing.id);
    await setFrontendIndexProperties(recovered.id, name, key, row.id);
    await persistFrontend(row.id, recovered);
    return recovered;
  }

  const created = await createPage(
    { type: "data_source_id", data_source_id: frontendsDataSource },
    {
      "Vor- und Nachname": title(name),
      "Worker Key": richText(key),
      "D1 Record ID": richText(row.id),
    },
    { icon: WORKER_FRONTEND_ICON },
  );
  // Persist immediately: every later stage can recover this exact page.
  await persistFrontend(row.id, created);
  return created;
}

function dayDatabaseProperties(standorte, archive = false) {
  return {
    Wochentag: { title: {} },
    Datum: { date: {} },
    Stunden: { number: { format: "number" } },
    Standort: { select: { options: workerStandortOptions(standorte) } },
    ...(archive ? archiveSchemaProperties() : {}),
  };
}

async function createWorkerDatabase(parentPageId, databaseTitle, standorte, archive) {
  const database = await notion("/databases", {
    method: "POST",
    body: {
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: databaseTitle } }],
      is_inline: true,
      initial_data_source: { properties: dayDatabaseProperties(standorte, archive) },
    },
  });
  return {
    databaseId: database.id,
    dataSourceId: dataSourceIdFromDatabase(database),
  };
}

/**
 * Resolve a D3/D4 pair from D1 whenever possible. If just one ID was saved,
 * derive and save the other. If neither was saved, inspect the worker page for
 * a database of the expected name before considering a new database.
 */
async function resolveWorkerDatabase(row, parentPageId, labels) {
  let databaseId = d1Value(row, labels.databaseIdProperty);
  let dataSourceId = d1Value(row, labels.dataSourceIdProperty);

  if (databaseId && !dataSourceId) {
    dataSourceId = dataSourceIdFromDatabase(await getDatabase(databaseId));
    await updateD1(row.id, { [labels.dataSourceIdProperty]: richText(dataSourceId) });
  } else if (dataSourceId && !databaseId) {
    databaseId = databaseIdFromDataSource(await getDataSource(dataSourceId));
    await updateD1(row.id, { [labels.databaseIdProperty]: richText(databaseId) });
  }
  if (databaseId && dataSourceId) return { databaseId, dataSourceId, created: false };

  // Recover after a crash between database creation and the immediate D1 write.
  const existing = await findExactChild(
    parentPageId,
    "child_database",
    labels.recoveryTitles || labels.title,
  );
  if (existing) {
    databaseId = existing.id;
    dataSourceId = dataSourceIdFromDatabase(await getDatabase(databaseId));
    await updateD1(row.id, {
      [labels.databaseIdProperty]: richText(databaseId),
      [labels.dataSourceIdProperty]: richText(dataSourceId),
    });
    return { databaseId, dataSourceId, created: false };
  }

  const created = await createWorkerDatabase(
    parentPageId,
    labels.title,
    labels.standorte,
    labels.archive,
  );
  await updateD1(row.id, {
    [labels.databaseIdProperty]: richText(created.databaseId),
    [labels.dataSourceIdProperty]: richText(created.dataSourceId),
  });
  return { ...created, created: true };
}

async function ensureStandortOptions(dataSourceId, standorte) {
  const dataSource = await getDataSource(dataSourceId);
  const property = dataSource.properties?.Standort;
  if (!property || property.type !== "select") {
    throw new Error(`Data source ${dataSourceId} needs a Select property named "Standort"`);
  }
  const existing = property.select.options || [];
  const existingNames = new Set(existing.map((option) => option.name));
  const additions = workerStandortNames(standorte).filter((name) => !existingNames.has(name));
  if (additions.length === 0) return 0;

  await updateDataSource(dataSourceId, {
    Standort: {
      select: {
        // Existing IDs are included so historic select values are never removed.
        options: [
          ...existing.map((option) => ({ id: option.id, name: option.name })),
          ...additions.map((name) => ({ name, color: "blue" })),
        ],
      },
    },
  });
  return additions.length;
}

async function ensureCurrentMonthDayRows(dataSourceId) {
  const expectedDays = currentMonthDates();
  const existingRows = await queryAll(dataSourceId);
  const existingDates = new Set(
    existingRows.map((row) => row.properties.Datum?.date?.start).filter(Boolean),
  );

  let created = 0;
  for (const { isoDate, weekday } of expectedDays) {
    if (existingDates.has(isoDate)) continue;
    await createPage(
      { type: "data_source_id", data_source_id: dataSourceId },
      { Wochentag: title(weekday), Datum: date(isoDate) },
    );
    created += 1;
  }
  return created;
}

async function markError(rowId, failure) {
  await updateD1(rowId, {
    "Onboarding Status": select("Error"),
    "Onboarding Error": richText(errorMessage(failure).slice(0, 1900)),
  });
}

async function provisionWorker(row) {
  const name = titleValue(row.properties["Vor- und Nachname"]).trim();
  const key = d1Value(row, "Worker Key") || workerKey();
  const currentStatus = row.properties["Onboarding Status"]?.select?.name;

  try {
    if (!name) throw new Error(`D1 row ${row.id} has no worker name`);
    if (currentStatus !== "Provisioning") {
      await updateD1(row.id, {
        "Onboarding Status": select("Provisioning"),
        "Onboarding Error": richText(""),
        "Worker Key": richText(key),
      });
    } else if (!d1Value(row, "Worker Key")) {
      await updateD1(row.id, { "Worker Key": richText(key) });
    }

    const standorte = await activeStandorte();
    const workerPage = await resolveWorkerPage(row, name, key);

    // D3 → D4. Each database ID is written to D1 before the
    // following stage, so a retry never creates a duplicate store or view.
    const d3 = await resolveWorkerDatabase(row, workerPage.id, {
      title: CURRENT_MONTH_DATABASE_TITLE,
      recoveryTitles: [CURRENT_MONTH_DATABASE_TITLE, "D3 · Current Month"],
      databaseIdProperty: "D3 Database ID",
      dataSourceIdProperty: "D3 Data Source ID",
      standorte,
    });
    await ensureCurrentMonthPresentation(d3.databaseId, d3.dataSourceId);

    const d4 = await resolveWorkerDatabase(row, workerPage.id, {
      title: ARCHIVE_DATABASE_TITLE,
      recoveryTitles: [ARCHIVE_DATABASE_TITLE, "D4 · Archive"],
      databaseIdProperty: "D4 Database ID",
      dataSourceIdProperty: "D4 Data Source ID",
      standorte,
      archive: true,
    });
    await ensureArchivePresentation(d4.databaseId, d4.dataSourceId);

    // Existing dates and active Standort options are preserved, never duplicated.
    const createdDayRows = await ensureCurrentMonthDayRows(d3.dataSourceId);
    await ensureStandortOptions(d3.dataSourceId, standorte);
    await ensureStandortOptions(d4.dataSourceId, standorte);

    await updateD1(row.id, {
      "Worker Key": richText(key),
      "Frontend Page ID": richText(workerPage.id),
      "Frontend URL": { url: frontendUrl(workerPage) },
      "User Page ID": richText(workerPage.id),
      "D3 Database ID": richText(d3.databaseId),
      "D3 Data Source ID": richText(d3.dataSourceId),
      "D4 Database ID": richText(d4.databaseId),
      "D4 Data Source ID": richText(d4.dataSourceId),
      "Sharing Status": select("Ready for Invite"),
      "Onboarding Status": select("Ready"),
      "Onboarding Error": richText(""),
      "Onboarded At": date(new Date().toISOString()),
    });
    console.log(`${name}: Ready (${createdDayRows} current-month row(s) created; manual invite pending)`);
  } catch (failure) {
    try {
      await markError(row.id, failure);
    } catch (markFailure) {
      throw new Error(
        `${name}: provisioning failed (${errorMessage(failure)}); could not mark D1 Error (${errorMessage(markFailure)})`,
      );
    }
    throw new Error(`${name}: ${errorMessage(failure)}`);
  }
}

async function main() {
  await validateSchema();
  // Provisioning resumes an interrupted run. Error rows need an intentional
  // human change back to Pending, so diagnostic failures cannot loop forever.
  const candidates = await queryAll(D1, {
    and: [
      { property: "Active", checkbox: { equals: true } },
      {
        or: [
          { property: "Onboarding Status", select: { equals: "Pending" } },
          { property: "Onboarding Status", select: { equals: "Provisioning" } },
        ],
      },
    ],
  });

  console.log(`Found ${candidates.length} worker(s) to provision.`);
  const failures = [];
  for (const candidate of candidates) {
    try {
      await provisionWorker(candidate);
    } catch (failure) {
      console.error(errorMessage(failure));
      failures.push(errorMessage(failure));
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} worker(s) failed onboarding. See D1 Onboarding Error.`);
  }
}

if (require.main === module) {
  main().catch((failure) => {
    console.error(errorMessage(failure));
    process.exitCode = 1;
  });
}

module.exports = {
  berlinCurrentMonthKey,
  currentMonthDates,
  dayDatabaseProperties,
};
