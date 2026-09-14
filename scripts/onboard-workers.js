"use strict";

const crypto = require("node:crypto");

const {
  appendBlockChildren,
  assertPropertyTypes,
  createPage,
  dataSourceIdFromDatabase,
  databaseIdFromDataSource,
  date,
  errorMessage,
  getDataSource,
  getDatabase,
  getPage,
  listAllBlockChildren,
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
  ensureVacationDivider,
  ensureVacationChart,
  hideInternalFrontendColumnsInManagementView,
} = require("./frontend-presentation");
const { workerStandortOptions } = require("./worker-standort-options");
const { reconcileSelectOptions } = require("./select-options");
const {
  D1_OFFBOARDING_SCHEMA,
  OFFBOARDING_STATUS,
  ensureD1OffboardingSchema,
  ensureD1OffboardingView,
} = require("./offboarding");

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
const { HOLIDAY_HOURS, augsburgPaidHolidayName } = require("./augsburg-holidays");
const WORKER_FRONTEND_ICON = { type: "emoji", emoji: "👤" };
const VACATION_CHART_VIEW_ID_PROPERTY = "Urlaub Chart View ID";
const ANNUAL_VACATION_PROPERTY = "Jahresurlaub";
const MANUAL_ONBOARDING_CHECKLIST_ITEMS = [
  {
    text: "In Aktueller Monat die Vorlage Teil-Tag anlegen und Datum auf das aktuelle Datum setzen.",
  },
  {
    text: "Archiv sperren.",
  },
  {
    text: "Archiv: DB-Titel ausblenden und Urlaub-Chart benennen.",
  },
  {
    text: "Archiv an dieselbe E-Mail einladen: Can view.",
    permission: "Can view",
  },
  {
    text: "Aktueller Monat an dieselbe E-Mail einladen: Can edit content.",
    permission: "Can edit content",
  },
  {
    text: "Diese Frontend-Seite an die oben angezeigte E-Mail einladen: Can view.",
    permission: "Can view",
  },
];

const D1_CORE_SCHEMA = {
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
const D1_SCHEMA = {
  ...D1_CORE_SCHEMA,
  ...D1_OFFBOARDING_SCHEMA,
  [ANNUAL_VACATION_PROPERTY]: "number",
};

const FRONTENDS_CORE_SCHEMA = {
  "Vor- und Nachname": "title",
  "Worker Key": "rich_text",
  "D1 Record ID": "rich_text",
};
const FRONTENDS_SCHEMA = {
  ...FRONTENDS_CORE_SCHEMA,
  Email: "email",
  [ANNUAL_VACATION_PROPERTY]: "number",
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

function emailValue(row) {
  return row.properties.Email?.email?.trim() || "";
}

function annualVacationValue(row) {
  const value = row.properties[ANNUAL_VACATION_PROPERTY]?.number;
  if (value === null || value === undefined) {
    throw new Error(`D1 row ${row.id} needs a manually entered ${ANNUAL_VACATION_PROPERTY} value before onboarding`);
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`D1 row ${row.id} has an invalid ${ANNUAL_VACATION_PROPERTY} value; use a non-negative number`);
  }
  return value;
}

function hasAnnualVacationValue(row) {
  const value = row.properties[ANNUAL_VACATION_PROPERTY]?.number;
  return value !== null && value !== undefined;
}

function frontendUrl(page) {
  return page.url || `https://www.notion.so/${page.id.replaceAll("-", "")}`;
}

async function updateD1(rowId, properties) {
  return updatePage(rowId, properties);
}

function frontendProperties(name, email, key, d1RecordId, annualVacation) {
  return {
    "Vor- und Nachname": title(name),
    Email: { email: email || null },
    [ANNUAL_VACATION_PROPERTY]: { number: annualVacation },
    "Worker Key": richText(key),
    "D1 Record ID": richText(d1RecordId),
  };
}

function blockText(block) {
  return (block?.[block?.type]?.rich_text || [])
    .map((item) => item.plain_text || item.text?.content || "")
    .join("");
}

function checklistRichText({ text, permission }) {
  if (!permission) return [{ type: "text", text: { content: text } }];
  const permissionStart = text.lastIndexOf(permission);
  return [
    { type: "text", text: { content: text.slice(0, permissionStart) } },
    {
      type: "text",
      text: { content: permission },
      annotations: { bold: true },
    },
    { type: "text", text: { content: text.slice(permissionStart + permission.length) } },
  ];
}

function manualOnboardingChecklistBlocks() {
  return MANUAL_ONBOARDING_CHECKLIST_ITEMS.map((item) => ({
    object: "block",
    type: "to_do",
    to_do: {
      rich_text: checklistRichText(item),
      checked: false,
    },
  }));
}

async function ensureManualOnboardingChecklist(pageId) {
  let blocks = await listAllBlockChildren(pageId);
  const idsForItem = (item) => blocks
    .filter((block) => block.type === "to_do" && blockText(block) === item)
    .map((block) => block.id);

  for (const item of MANUAL_ONBOARDING_CHECKLIST_ITEMS) {
    if (idsForItem(item.text).length > 1) {
      throw new Error(`Worker page ${pageId} has a duplicate onboarding checklist item; refusing to create another.`);
    }
  }

  const missingItems = MANUAL_ONBOARDING_CHECKLIST_ITEMS.filter((item) => idsForItem(item.text).length === 0);
  if (missingItems.length > 0) {
    await appendBlockChildren(pageId, manualOnboardingChecklistBlocks().filter(
      (block) => missingItems.some((item) => blockText(block) === item.text),
    ));
    blocks = await listAllBlockChildren(pageId);
  }

  const checklistIds = MANUAL_ONBOARDING_CHECKLIST_ITEMS.flatMap((item) => idsForItem(item.text));
  if (checklistIds.length !== MANUAL_ONBOARDING_CHECKLIST_ITEMS.length) {
    throw new Error(`Could not recover every onboarding checklist item on worker page ${pageId}`);
  }
  return checklistIds;
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

  let frontends = await getDataSource(employeeFrontendsDataSourceId);
  assertPropertyTypes(frontends, FRONTENDS_CORE_SCHEMA);
  const email = frontends.properties?.Email;
  const annualVacation = frontends.properties?.[ANNUAL_VACATION_PROPERTY];
  if (email && email.type !== "email") {
    throw new Error(`Employee Front-ends property "Email" is ${email.type}, expected email`);
  }
  if (annualVacation && annualVacation.type !== "number") {
    throw new Error(
      `Employee Front-ends property "${ANNUAL_VACATION_PROPERTY}" is ${annualVacation.type}, expected number`,
    );
  }
  const additions = {};
  if (!email) additions.Email = { email: {} };
  if (!annualVacation) additions[ANNUAL_VACATION_PROPERTY] = { number: { format: "number" } };
  if (Object.keys(additions).length > 0) {
    await updateDataSource(employeeFrontendsDataSourceId, additions);
    frontends = await getDataSource(employeeFrontendsDataSourceId);
  }
  assertPropertyTypes(frontends, FRONTENDS_SCHEMA);
  return employeeFrontendsDataSourceId;
}

async function validateSchema() {
  let d1 = await ensureD1OffboardingSchema(D1);
  await ensureD1OffboardingView(D1);
  assertPropertyTypes(d1, D1_CORE_SCHEMA);
  const chartViewId = d1.properties?.[VACATION_CHART_VIEW_ID_PROPERTY];
  const annualVacation = d1.properties?.[ANNUAL_VACATION_PROPERTY];
  if (chartViewId && chartViewId.type !== "rich_text") {
    throw new Error(`D1 property "${VACATION_CHART_VIEW_ID_PROPERTY}" is ${chartViewId.type}, expected rich_text`);
  }
  if (annualVacation && annualVacation.type !== "number") {
    throw new Error(`D1 property "${ANNUAL_VACATION_PROPERTY}" is ${annualVacation.type}, expected number`);
  }
  const additions = {};
  if (!chartViewId) additions[VACATION_CHART_VIEW_ID_PROPERTY] = { rich_text: {} };
  if (!annualVacation) additions[ANNUAL_VACATION_PROPERTY] = { number: { format: "number" } };
  if (Object.keys(additions).length > 0) {
    await updateDataSource(D1, additions);
    d1 = await getDataSource(D1);
  }
  assertPropertyTypes(d1, { ...D1_SCHEMA, [VACATION_CHART_VIEW_ID_PROPERTY]: "rich_text" });
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

async function setFrontendIndexProperties(pageId, name, email, key, d1RecordId, annualVacation) {
  await updatePage(
    pageId,
    frontendProperties(name, email, key, d1RecordId, annualVacation),
    { icon: WORKER_FRONTEND_ICON },
  );
}

function frontendIdentity(candidate) {
  return {
    d1RecordId: richTextValue(candidate.properties["D1 Record ID"]).trim(),
    key: richTextValue(candidate.properties["Worker Key"]).trim(),
  };
}

function assertFrontendIdentity(candidate, key, d1RecordId) {
  const expectedD1RecordId = String(d1RecordId || "").trim();
  const expectedKey = String(key || "").trim();
  const stored = frontendIdentity(candidate);
  if (!expectedD1RecordId) {
    throw new Error("A D1 Record ID is required to validate a worker frontend");
  }
  if (stored.d1RecordId && stored.d1RecordId !== expectedD1RecordId) {
    throw new Error(
      `Frontend ${candidate.id} belongs to D1 Record ID ${stored.d1RecordId}, not ${expectedD1RecordId}.`,
    );
  }
  if (stored.key && expectedKey && stored.key !== expectedKey) {
    throw new Error(
      `Frontend ${candidate.id} belongs to Worker Key ${stored.key}, not ${expectedKey}.`,
    );
  }
  return candidate;
}

function selectRecoverableFrontend(rows, key, d1RecordId) {
  const expectedD1RecordId = String(d1RecordId || "").trim();
  const expectedKey = String(key || "").trim();
  if (!expectedD1RecordId) {
    throw new Error("A D1 Record ID is required to recover a worker frontend");
  }

  const d1Matches = rows.filter(
    (candidate) => frontendIdentity(candidate).d1RecordId === expectedD1RecordId,
  );
  if (d1Matches.length > 1) {
    throw new Error(
      `Employee Front-ends has multiple rows with D1 Record ID ${expectedD1RecordId}; refusing to choose one.`,
    );
  }

  // Empty Worker Keys are never identifiers. A key is considered only after
  // the exact D1 record lookup, and duplicate keys are always unsafe.
  const keyMatches = expectedKey
    ? rows.filter((candidate) => frontendIdentity(candidate).key === expectedKey)
    : [];
  if (keyMatches.length > 1) {
    throw new Error(
      `Employee Front-ends has multiple rows with Worker Key ${expectedKey}; refusing to choose one.`,
    );
  }

  if (d1Matches.length === 1) {
    const d1Match = d1Matches[0];
    if (keyMatches.length === 1 && keyMatches[0].id !== d1Match.id) {
      throw new Error(
        `D1 Record ID ${expectedD1RecordId} and Worker Key ${expectedKey} identify different frontend rows.`,
      );
    }
    const storedKey = frontendIdentity(d1Match).key;
    if (storedKey && expectedKey && storedKey !== expectedKey) {
      throw new Error(
        `Frontend ${d1Match.id} has D1 Record ID ${expectedD1RecordId} but Worker Key ${storedKey}, not ${expectedKey}.`,
      );
    }
    return d1Match;
  }

  if (keyMatches.length === 0) return undefined;

  const keyMatch = keyMatches[0];
  const keyMatchD1RecordId = frontendIdentity(keyMatch).d1RecordId;
  if (keyMatchD1RecordId && keyMatchD1RecordId !== expectedD1RecordId) {
    throw new Error(
      `Worker Key ${expectedKey} belongs to D1 Record ID ${keyMatchD1RecordId}, not ${expectedD1RecordId}.`,
    );
  }
  return keyMatch;
}

async function findRecoverableFrontend(name, key, d1RecordId) {
  const rows = await queryAll(await frontendsDataSourceId());
  try {
    return selectRecoverableFrontend(rows, key, d1RecordId);
  } catch (failure) {
    throw new Error(`Cannot recover the frontend for ${name}: ${errorMessage(failure)}`);
  }
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
  const email = emailValue(row);
  const annualVacation = annualVacationValue(row);
  const frontendsDataSource = await frontendsDataSourceId();

  if (rememberedId) {
    const rememberedPage = assertFrontendIdentity(await getPage(rememberedId), key, row.id);
    const remembered = await moveLegacyPageIntoIndex(rememberedPage, frontendsDataSource);
    await setFrontendIndexProperties(remembered.id, name, email, key, row.id, annualVacation);
    await persistFrontend(row.id, remembered);
    return remembered;
  }

  // A prior run can create the row before it writes D1. Recover the one
  // deterministic match rather than creating a second worker-facing page.
  const existing = await findRecoverableFrontend(name, key, row.id);
  if (existing) {
    const recovered = await getPage(existing.id);
    await setFrontendIndexProperties(recovered.id, name, email, key, row.id, annualVacation);
    await persistFrontend(row.id, recovered);
    return recovered;
  }

  const created = await createPage(
    { type: "data_source_id", data_source_id: frontendsDataSource },
    frontendProperties(name, email, key, row.id, annualVacation),
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

function recoveredStandortOptions(existing, standorte) {
  const existingNames = new Set(existing.map((option) => option.name));
  const additions = workerStandortOptions(standorte).filter(
    (option) => !existingNames.has(option.name),
  );
  return {
    additions,
    options: reconcileSelectOptions(existing, additions, { retainExisting: true }),
  };
}

async function ensureStandortOptions(dataSourceId, standorte) {
  const dataSource = await getDataSource(dataSourceId);
  const property = dataSource.properties?.Standort;
  if (!property || property.type !== "select") {
    throw new Error(`Data source ${dataSourceId} needs a Select property named "Standort"`);
  }
  const plan = recoveredStandortOptions(property.select.options || [], standorte);
  if (plan.additions.length === 0) return 0;

  await updateDataSource(dataSourceId, {
    Standort: {
      select: {
        options: plan.options,
      },
    },
  });
  return plan.additions.length;
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
    const holiday = augsburgPaidHolidayName(isoDate);
    await createPage(
      { type: "data_source_id", data_source_id: dataSourceId },
      {
        Wochentag: title(weekday),
        Datum: date(isoDate),
        ...(holiday ? { Standort: select("Feiertag"), Stunden: { number: HOLIDAY_HOURS } } : {}),
      },
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
    await ensureManualOnboardingChecklist(workerPage.id);

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
    const vacationDividerId = await ensureVacationDivider(workerPage.id, d3.databaseId);
    const vacationChartViewId = await ensureVacationChart(
      workerPage.id,
      vacationDividerId,
      d4.dataSourceId,
      berlinCurrentMonthKey(),
      d1Value(row, VACATION_CHART_VIEW_ID_PROPERTY),
    );
    await updateD1(row.id, { [VACATION_CHART_VIEW_ID_PROPERTY]: richText(vacationChartViewId) });

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
      [VACATION_CHART_VIEW_ID_PROPERTY]: richText(vacationChartViewId),
      "Current Month": richText(berlinCurrentMonthKey()),
      "Sharing Status": select("Ready for Invite"),
      "Onboarding Status": select("Ready"),
      "Onboarding Error": richText(""),
      "Onboarded At": date(new Date().toISOString()),
      "Offboarding Status": select(OFFBOARDING_STATUS.ACTIVE),
      "Offboarding Error": richText(""),
      "Final Sync At": date(""),
      "Frontend Access Revoked": { checkbox: false },
      "D3 Access Revoked": { checkbox: false },
      "D4 Access Revoked": { checkbox: false },
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

function executionMode(args = process.argv.slice(2)) {
  const modes = args.filter((arg) => ["--validate-only", "--provision-only"].includes(arg));
  if (modes.length > 1) {
    throw new Error("Use at most one of --validate-only or --provision-only");
  }
  if (modes.length === 1) {
    return modes[0] === "--validate-only" ? "validate" : "provision";
  }
  return "full";
}

async function main() {
  const mode = executionMode();
  if (mode !== "provision") {
    console.log("Stage: validating Notion POC schemas and frontend layout.");
    await validateSchema();
  }
  if (mode === "validate") {
    console.log("Preflight complete; no worker pages or time-entry databases were provisioned.");
    return;
  }

  console.log("Stage: finding pending workers and provisioning their frontends, D3, KPI, and D4.");
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

  const waitingForAnnualVacation = candidates.filter((candidate) => !hasAnnualVacationValue(candidate));
  const workersToProvision = candidates.filter(hasAnnualVacationValue);
  console.log(`Found ${candidates.length} worker(s) awaiting provisioning.`);
  if (waitingForAnnualVacation.length > 0) {
    const names = waitingForAnnualVacation
      .map((candidate) => titleValue(candidate.properties["Vor- und Nachname"]).trim() || candidate.id)
      .join(", ");
    console.log(
      `Waiting for manually entered ${ANNUAL_VACATION_PROPERTY} in D1 before provisioning: ${names}.`,
    );
  }
  console.log(`Provisioning ${workersToProvision.length} worker(s).`);
  const failures = [];
  for (const candidate of workersToProvision) {
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
  assertFrontendIdentity,
  berlinCurrentMonthKey,
  annualVacationValue,
  currentMonthDates,
  dayDatabaseProperties,
  executionMode,
  frontendProperties,
  hasAnnualVacationValue,
  manualOnboardingChecklistBlocks,
  recoveredStandortOptions,
  selectRecoverableFrontend,
};
