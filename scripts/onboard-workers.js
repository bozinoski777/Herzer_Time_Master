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
  listAllBlockChildren,
  notion,
  queryAll,
  requireEnv,
  richText,
  richTextValue,
  select,
  title,
  titleValue,
  updatePage,
} = require("./notion");

const {
  D1_DATA_SOURCE_ID: D1,
  D8_DATA_SOURCE_ID: D8,
  EMPLOYEE_FRONTEND_PAGE_ID: EMPLOYEE_FRONTEND_PAGE,
} = requireEnv(
  "D1_DATA_SOURCE_ID",
  "D8_DATA_SOURCE_ID",
  "EMPLOYEE_FRONTEND_PAGE_ID",
);

const TAGTYP_OPTIONS = [
  { name: "Arbeit", color: "green" },
  { name: "Urlaub", color: "blue" },
  { name: "Krank", color: "red" },
  { name: "Feiertag", color: "purple" },
  { name: "Sonderurlaub", color: "orange" },
  { name: "Überstundenausgleich", color: "yellow" },
];

const WEEKDAYS = [
  "Sonntag",
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag",
];

const D1_SCHEMA = {
  "Vor- und Nachname": "title",
  Active: "checkbox",
  "Onboarding Status": "select",
  "Onboarding Error": "rich_text",
  "Onboarded At": "date",
  "Worker Key": "rich_text",
  "User Page ID": "rich_text",
  "D3 Database ID": "rich_text",
  "D3 Data Source ID": "rich_text",
  "D4 Database ID": "rich_text",
  "D4 Data Source ID": "rich_text",
};

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

async function updateD1(rowId, properties) {
  return updatePage(rowId, properties);
}

async function validateSchema() {
  const d1 = await getDataSource(D1);
  assertPropertyTypes(d1, D1_SCHEMA);

  const d8 = await getDataSource(D8);
  assertPropertyTypes(d8, { Standort: "title", Active: "checkbox" });
}

async function activeStandorte() {
  const rows = await queryAll(D8, {
    property: "Active",
    checkbox: { equals: true },
  });

  return [...new Set(
    rows
      .map((row) => titleValue(row.properties.Standort).trim())
      .filter(Boolean),
  )];
}

async function findExactChild(parentPageId, blockType, name) {
  const matches = (await listAllBlockChildren(parentPageId)).filter(
    (block) => block.type === blockType && block[blockType]?.title === name,
  );

  if (matches.length > 1) {
    throw new Error(`Found multiple ${blockType} blocks named \"${name}\" under ${parentPageId}`);
  }

  return matches[0];
}

async function resolveWorkerPage(row, name) {
  const rememberedId = d1Value(row, "User Page ID");
  if (rememberedId) return rememberedId;

  // This handles a crash after a page was created but before its ID was saved.
  const existing = await findExactChild(EMPLOYEE_FRONTEND_PAGE, "child_page", name);
  if (existing) {
    await updateD1(row.id, { "User Page ID": richText(existing.id) });
    return existing.id;
  }

  const page = await createPage(
    { type: "page_id", page_id: EMPLOYEE_FRONTEND_PAGE },
    { title: title(name) },
    { icon: { type: "emoji", emoji: "👷" } },
  );

  // Persist immediately: every subsequently-created object can be recovered.
  await updateD1(row.id, { "User Page ID": richText(page.id) });
  return page.id;
}

function dayDatabaseProperties(standorte) {
  return {
    Wochentag: { title: {} },
    Datum: { date: {} },
    Stunden: { number: { format: "number" } },
    Tagtyp: { select: { options: TAGTYP_OPTIONS } },
    Standort: {
      select: {
        options: standorte.map((name) => ({ name, color: "blue" })),
      },
    },
  };
}

async function createWorkerDatabase(parentPageId, databaseTitle, standorte) {
  const database = await notion("/databases", {
    method: "POST",
    body: {
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: databaseTitle } }],
      is_inline: false,
      initial_data_source: { properties: dayDatabaseProperties(standorte) },
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

  // This is the second recovery path for a crash between database creation and
  // the immediate D1 write.
  const existing = await findExactChild(parentPageId, "child_database", labels.title);
  if (existing) {
    databaseId = existing.id;
    dataSourceId = dataSourceIdFromDatabase(await getDatabase(databaseId));
    await updateD1(row.id, {
      [labels.databaseIdProperty]: richText(databaseId),
      [labels.dataSourceIdProperty]: richText(dataSourceId),
    });
    return { databaseId, dataSourceId, created: false };
  }

  const created = await createWorkerDatabase(parentPageId, labels.title, labels.standorte);

  // Both identifiers are stored in the first write after Notion creates them.
  await updateD1(row.id, {
    [labels.databaseIdProperty]: richText(created.databaseId),
    [labels.dataSourceIdProperty]: richText(created.dataSourceId),
  });

  return { ...created, created: true };
}

async function ensureCurrentMonthDayRows(dataSourceId) {
  const expectedDays = currentMonthDates();
  const existingRows = await queryAll(dataSourceId);
  const existingDates = new Set(
    existingRows
      .map((row) => row.properties.Datum?.date?.start)
      .filter(Boolean),
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
  const message = errorMessage(failure).slice(0, 1900);
  await updateD1(rowId, {
    "Onboarding Status": select("Error"),
    "Onboarding Error": richText(message),
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
    const userPageId = await resolveWorkerPage(row, name);
    const d3 = await resolveWorkerDatabase(row, userPageId, {
      title: "D3 · Current Month",
      databaseIdProperty: "D3 Database ID",
      dataSourceIdProperty: "D3 Data Source ID",
      standorte,
    });

    // It is safe to run after an interruption: existing dates are not recreated.
    const createdDayRows = await ensureCurrentMonthDayRows(d3.dataSourceId);

    const d4 = await resolveWorkerDatabase(row, userPageId, {
      title: "D4 · Archive",
      databaseIdProperty: "D4 Database ID",
      dataSourceIdProperty: "D4 Data Source ID",
      standorte,
    });

    await updateD1(row.id, {
      "Worker Key": richText(key),
      "User Page ID": richText(userPageId),
      "D3 Database ID": richText(d3.databaseId),
      "D3 Data Source ID": richText(d3.dataSourceId),
      "D4 Database ID": richText(d4.databaseId),
      "D4 Data Source ID": richText(d4.dataSourceId),
      "Onboarding Status": select("Ready"),
      "Onboarding Error": richText(""),
      "Onboarded At": date(new Date().toISOString()),
    });

    console.log(`${name}: Ready (${createdDayRows} current-month row(s) created)`);
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

  // Provisioning is included to recover safely after an interrupted workflow.
  // Error rows are intentionally not retried until a human changes them to Pending.
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

  // Sequential requests keep this safely below Notion's average rate limit.
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

main().catch((failure) => {
  console.error(errorMessage(failure));
  process.exitCode = 1;
});
