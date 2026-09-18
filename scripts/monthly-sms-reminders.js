"use strict";

/**
 * Send one monthly SMS reminder to each active, Ready worker whose current
 * D3 month still has an unfinished weekday. It runs once at the end of the
 * third week and again five calendar days before month end, while the D3
 * month remains worker-visible ahead of Month Rollover.
 *
 * The D1 reminder record is reserved before contacting Twilio. That gives
 * manual re-runs at-most-once behavior even if the runner stops after an SMS
 * request has reached Twilio but before its response can be saved in Notion.
 */

const {
  assertPropertyTypes,
  date,
  errorMessage,
  getDataSource,
  queryAll,
  requireEnv,
  richText,
  richTextValue,
  select,
  updateDataSource,
  updatePage,
} = require("./notion");
const { assertDayDataSource } = require("./day-schemas");
const { reconcileSelectOptions } = require("./select-options");
const {
  D1_WORKER_REFERENCE_SCHEMA,
  assertUniqueWorkerReferences,
  assertWorkerDataSourceReference,
  missingWorkerReferences,
  workerReferencesFromD1,
} = require("./worker-database-references");

const BERLIN_TIME_ZONE = "Europe/Berlin";
const PHONE_PROPERTY = "SMS Telefonnummer";
const REMINDER_MONTH_PROPERTY = "SMS Reminder Month";
const REMINDER_STATUS_PROPERTY = "SMS Reminder Status";
const REMINDER_SENT_AT_PROPERTY = "SMS Reminder Sent At";
const REMINDER_TWILIO_SID_PROPERTY = "SMS Reminder Twilio SID";
const REMINDER_ERROR_PROPERTY = "SMS Reminder Error";

const REMINDER_STATUS = Object.freeze({
  SENDING: "Sending",
  ACCEPTED: "Accepted",
  FAILED: "Failed",
  UNCERTAIN: "Uncertain",
});

const REMINDER_STATUS_OPTIONS = Object.freeze([
  { name: REMINDER_STATUS.SENDING, color: "yellow" },
  { name: REMINDER_STATUS.ACCEPTED, color: "green" },
  { name: REMINDER_STATUS.FAILED, color: "red" },
  { name: REMINDER_STATUS.UNCERTAIN, color: "orange" },
]);

const D1_BASE_SCHEMA = Object.freeze({
  "Vor- und Nachname": "title",
  Active: "checkbox",
  "Onboarding Status": "select",
  "Onboarded At": "date",
  "Frontend URL": "url",
  "Current Month": "rich_text",
  ...D1_WORKER_REFERENCE_SCHEMA,
});

const D1_REMINDER_SCHEMA = Object.freeze({
  [PHONE_PROPERTY]: "phone_number",
  [REMINDER_MONTH_PROPERTY]: "rich_text",
  [REMINDER_STATUS_PROPERTY]: "select",
  [REMINDER_SENT_AT_PROPERTY]: "date",
  [REMINDER_TWILIO_SID_PROPERTY]: "rich_text",
  [REMINDER_ERROR_PROPERTY]: "rich_text",
});

const {
  D1_DATA_SOURCE_ID: D1,
  TWILIO_ACCOUNT_SID: TWILIO_ACCOUNT_SID,
} = requireEnv(
  "D1_DATA_SOURCE_ID",
  "TWILIO_ACCOUNT_SID",
);

function twilioAuthentication(environment = process.env) {
  const apiKeySid = String(environment.TWILIO_API_KEY_SID || "").trim();
  const apiKeySecret = String(environment.TWILIO_API_KEY_SECRET || "").trim();
  const authToken = String(environment.TWILIO_AUTH_TOKEN || "").trim();

  if (apiKeySid || apiKeySecret) {
    if (!apiKeySid || !apiKeySecret) {
      throw new Error("Set both TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET, or neither.");
    }
    return { type: "api-key", username: apiKeySid, password: apiKeySecret };
  }
  if (authToken) return { type: "auth-token", username: TWILIO_ACCOUNT_SID, password: authToken };

  throw new Error(
    "Missing Twilio authentication: set TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET (recommended), or TWILIO_AUTH_TOKEN.",
  );
}

const TWILIO_AUTHENTICATION = twilioAuthentication();

function twilioSenderConfiguration(environment = process.env) {
  const messagingServiceSid = String(environment.TWILIO_MESSAGING_SERVICE_SID || "").trim();
  const fromNumber = String(environment.TWILIO_FROM_NUMBER || "").trim();

  if (messagingServiceSid) {
    if (!/^MG[0-9a-f]{32}$/i.test(messagingServiceSid)) {
      throw new Error("TWILIO_MESSAGING_SERVICE_SID must be a Twilio Messaging Service SID beginning with MG.");
    }
    return { type: "messaging-service", messagingServiceSid };
  }
  if (fromNumber) return { type: "from-number", fromNumber };

  throw new Error(
    "Missing Twilio sender configuration: set TWILIO_MESSAGING_SERVICE_SID (recommended) or TWILIO_FROM_NUMBER.",
  );
}

const TWILIO_SENDER = twilioSenderConfiguration();

class TwilioRequestError extends Error {
  constructor(message, certainty) {
    super(message);
    this.name = "TwilioRequestError";
    this.certainty = certainty;
  }
}

function berlinDateParts(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en", {
    timeZone: BERLIN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function monthKey({ year, month }) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isoDateInBerlin(value) {
  const rawValue = String(value || "").trim();
  if (validIsoDate(rawValue)) return rawValue;

  const parsed = new Date(rawValue);
  if (Number.isNaN(parsed.valueOf())) return "";

  const parts = new Intl.DateTimeFormat("en", {
    timeZone: BERLIN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const valueFor = (type) => parts.find((part) => part.type === type)?.value;
  return `${valueFor("year")}-${valueFor("month")}-${valueFor("day")}`;
}

function datesInMonth(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || "")) {
    throw new Error(`Invalid month "${month || ""}"`);
  }
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return Array.from(
    { length: days },
    (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`,
  );
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function lastDayOfMonth(targetMonth) {
  const firstDay = `${targetMonth}-01`;
  if (!validIsoDate(firstDay)) throw new Error(`Invalid month "${targetMonth || ""}"`);
  return new Date(
    Date.UTC(Number(targetMonth.slice(0, 4)), Number(targetMonth.slice(5, 7)), 0),
  ).toISOString().slice(0, 10);
}

function thirdFriday(targetMonth) {
  const firstDay = `${targetMonth}-01`;
  if (!validIsoDate(firstDay)) throw new Error(`Invalid month "${targetMonth || ""}"`);
  const firstFridayOffset = (5 - new Date(`${firstDay}T12:00:00Z`).getUTCDay() + 7) % 7;
  return addDays(firstDay, firstFridayOffset + 14);
}

function currentReminderRun(environment = process.env, now = new Date()) {
  const eventName = environment.GITHUB_EVENT_NAME || "";
  const targetWorker = String(environment.SMS_REMINDER_TARGET_WORKER || "").trim();
  if (eventName !== "workflow_dispatch" && targetWorker) {
    throw new Error("SMS_REMINDER_TARGET_WORKER is allowed only for workflow_dispatch.");
  }
  const berlinToday = berlinDateParts(now);
  const targetMonth = monthKey(berlinToday);
  const currentDate = `${targetMonth}-${String(berlinToday.day).padStart(2, "0")}`;
  const thirdFridayDate = thirdFriday(targetMonth);
  const fiveDaysBeforeMonthEnd = addDays(lastDayOfMonth(targetMonth), -5);
  const cycle = currentDate >= fiveDaysBeforeMonthEnd
    ? "five-days-before-month-end"
    : "third-friday";
  return {
    targetMonth,
    currentDate,
    thirdFriday: thirdFridayDate,
    fiveDaysBeforeMonthEnd,
    reminderKey: `${targetMonth}:${cycle}`,
    targetWorker,
  };
}

function isRequiredWorkday(isoDate) {
  const dayOfWeek = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  return dayOfWeek >= 1 && dayOfWeek <= 5;
}

function reminderRequiredDates(targetMonth, onboardedAt) {
  const onboardingDate = isoDateInBerlin(onboardedAt);
  return datesInMonth(targetMonth).filter(
    (isoDate) =>
      isRequiredWorkday(isoDate) &&
      (!onboardingDate || isoDate >= onboardingDate),
  );
}

function dayIsComplete(row) {
  const hours = row?.properties?.Stunden?.number;
  const standort = row?.properties?.Standort?.select?.name || "";
  return Number.isFinite(hours) && Boolean(String(standort).trim());
}

/**
 * A required weekday is incomplete if no current-month D3 row exists for it,
 * or if any D3 row for that date is unfinished. The latter intentionally
 * catches a half-day split where the extra D3 row was left blank.
 */
function incompleteCurrentMonthDates(rows, targetMonth, onboardedAt) {
  const rowsByDate = new Map();
  for (const row of rows) {
    const day = row?.properties?.Datum?.date?.start || "";
    if (!validIsoDate(day) || !day.startsWith(`${targetMonth}-`)) continue;
    const collection = rowsByDate.get(day) || [];
    collection.push(row);
    rowsByDate.set(day, collection);
  }

  return reminderRequiredDates(targetMonth, onboardedAt).filter((day) => {
    const dayRows = rowsByDate.get(day) || [];
    return dayRows.length === 0 || dayRows.some((row) => !dayIsComplete(row));
  });
}

function e164PhoneNumber(value) {
  const phone = String(value || "").trim().replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : "";
}

function validHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function displayMonth(targetMonth) {
  const date = new Date(`${targetMonth}-01T12:00:00Z`);
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: BERLIN_TIME_ZONE,
    month: "long",
    year: "numeric",
  }).format(date);
}

function reminderBody(targetMonth, incompleteDayCount, frontendUrl) {
  const days = incompleteDayCount === 1 ? "1 Arbeitstag" : `${incompleteDayCount} Arbeitstage`;
  return [
    `Ihre Zeiterfassung für ${displayMonth(targetMonth)} ist noch unvollständig (${days}).`,
    `Bitte ergänzen Sie sie hier: ${frontendUrl}`,
    "Keine SMS-Erinnerungen? Bitte informieren Sie die Verwaltung.",
  ].join(" ");
}

function workerFromRow(row) {
  return {
    ...workerReferencesFromD1(row),
    active: Boolean(row.properties.Active?.checkbox),
    onboardingStatus: row.properties["Onboarding Status"]?.select?.name || "",
    onboardedAt: row.properties["Onboarded At"]?.date?.start || "",
    frontendUrl: row.properties["Frontend URL"]?.url || "",
    currentMonth: richTextValue(row.properties["Current Month"]).trim(),
    phoneNumber: row.properties[PHONE_PROPERTY]?.phone_number || "",
    reminderMonth: richTextValue(row.properties[REMINDER_MONTH_PROPERTY]).trim(),
    reminderStatus: row.properties[REMINDER_STATUS_PROPERTY]?.select?.name || "",
  };
}

function existingReminderDecision(worker, targetMonth) {
  if (
    worker.reminderStatus === REMINDER_STATUS.UNCERTAIN &&
    worker.reminderMonth &&
    worker.reminderMonth !== targetMonth
  ) {
    return {
      action: "block",
      reason:
        `resolve the ${worker.reminderMonth} SMS Reminder Status Uncertain ` +
        "before another reminder is sent",
    };
  }

  // A clear Twilio 4xx response creates no Message resource, so after the
  // phone/sender/configuration error is corrected a manual run may retry it.
  if (worker.reminderMonth === targetMonth && worker.reminderStatus === REMINDER_STATUS.FAILED) {
    return { action: "send" };
  }
  if (worker.reminderMonth !== targetMonth) return { action: "send" };

  // A missing or altered status is not evidence that no SMS was sent. Make
  // an administrator explicitly set Failed only after checking Twilio rather
  // than turning a damaged D1 row into a duplicate send.
  return {
    action: "skip",
    reason: `${REMINDER_STATUS_PROPERTY} is ${worker.reminderStatus || "blank or unrecognized"}`,
  };
}

function reminderTrackingProperties(
  targetMonth,
  status,
  { sentAt = "", twilioSid = "", error = "" } = {},
) {
  return {
    [REMINDER_MONTH_PROPERTY]: richText(targetMonth),
    [REMINDER_STATUS_PROPERTY]: select(status),
    [REMINDER_SENT_AT_PROPERTY]: date(sentAt),
    [REMINDER_TWILIO_SID_PROPERTY]: richText(twilioSid),
    [REMINDER_ERROR_PROPERTY]: richText(error.slice(0, 1900)),
  };
}

function twilioErrorText(payload, fallback) {
  // Twilio error messages can echo a recipient number. Persist only its code
  // and HTTP outcome, keeping D1 and the Actions log free of phone numbers.
  const code = payload?.code ? ` (code ${payload.code})` : "";
  const outcome = String(fallback || "rejected the SMS request").replace(/\s+/g, " ").trim();
  return `Twilio SMS request failed${code}: ${outcome}`.slice(0, 1900);
}

function twilioMessageParameters({ to, body }, sender = TWILIO_SENDER) {
  const parameters = { To: to, Body: body };
  if (sender.type === "messaging-service") {
    parameters.MessagingServiceSid = sender.messagingServiceSid;
  } else {
    parameters.From = sender.fromNumber;
  }
  return parameters;
}

async function sendTwilioSms({ to, body }) {
  const payload = new URLSearchParams(twilioMessageParameters({ to, body }));
  const authorization = Buffer.from(
    `${TWILIO_AUTHENTICATION.username}:${TWILIO_AUTHENTICATION.password}`,
  ).toString("base64");

  let response;
  try {
    response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${authorization}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: payload,
      },
    );
  } catch (failure) {
    // A dropped connection may have happened after Twilio accepted the body.
    throw new TwilioRequestError(
      "Twilio request outcome is unknown because the network request did not complete",
      "uncertain",
    );
  }

  const rawBody = await response.text();
  let responseBody;
  try {
    responseBody = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    responseBody = {};
  }

  if (!response.ok) {
    // Twilio has conclusively rejected a 4xx request. A 5xx response could be
    // ambiguous, so leave an at-most-once reservation in place for review.
    throw new TwilioRequestError(
      twilioErrorText(responseBody, `HTTP ${response.status}`),
      response.status >= 400 && response.status < 500 ? "failed" : "uncertain",
    );
  }
  if (!responseBody?.sid) {
    throw new TwilioRequestError(
      "Twilio accepted the request but did not return a Message SID; outcome is unknown",
      "uncertain",
    );
  }
  return responseBody;
}

async function ensureD1ReminderSchema() {
  let d1 = await getDataSource(D1);
  assertPropertyTypes(d1, D1_BASE_SCHEMA);

  const additions = {};
  for (const [name, expectedType] of Object.entries(D1_REMINDER_SCHEMA)) {
    const property = d1.properties?.[name];
    if (property && property.type !== expectedType) {
      throw new Error(`D1 property "${name}" is ${property.type}, expected ${expectedType}`);
    }
    if (!property) {
      if (expectedType === "select") {
        additions[name] = { select: { options: REMINDER_STATUS_OPTIONS } };
      } else if (expectedType === "date") {
        additions[name] = { date: {} };
      } else {
        additions[name] = { [expectedType]: {} };
      }
    }
  }

  const existingStatusOptions = d1.properties?.[REMINDER_STATUS_PROPERTY]?.select?.options || [];
  const knownStatuses = new Set(existingStatusOptions.map((option) => option.name));
  if (
    d1.properties?.[REMINDER_STATUS_PROPERTY] &&
    REMINDER_STATUS_OPTIONS.some((option) => !knownStatuses.has(option.name))
  ) {
    additions[REMINDER_STATUS_PROPERTY] = {
      select: {
        options: reconcileSelectOptions(existingStatusOptions, REMINDER_STATUS_OPTIONS, {
          retainExisting: true,
        }),
      },
    };
  }

  if (Object.keys(additions).length > 0) {
    await updateDataSource(D1, additions);
    d1 = await getDataSource(D1);
  }
  assertPropertyTypes(d1, { ...D1_BASE_SCHEMA, ...D1_REMINDER_SCHEMA });
  return d1;
}

function currentMonthFilter(targetMonth) {
  return {
    and: [
      { property: "Datum", date: { on_or_after: `${targetMonth}-01` } },
      { property: "Datum", date: { before: addDays(lastDayOfMonth(targetMonth), 1) } },
    ],
  };
}

async function validateWorkerCurrentMonth(worker) {
  const missing = missingWorkerReferences(worker, { roles: ["d3"] });
  if (missing.length > 0) {
    throw new Error(`${worker.name} is Ready but has incomplete D3 routing IDs`);
  }
  const currentMonthDataSource = await getDataSource(worker.d3DataSourceId);
  assertWorkerDataSourceReference(worker, "d3", currentMonthDataSource, {
    schema: assertDayDataSource,
  });
  return currentMonthDataSource;
}

async function markFailedWithoutSend(worker, targetMonth, message) {
  await updatePage(
    worker.rowId,
    reminderTrackingProperties(targetMonth, REMINDER_STATUS.FAILED, { error: message }),
  );
}

async function processWorker(worker, run) {
  const reminderDecision = existingReminderDecision(worker, run.reminderKey);
  if (reminderDecision.action === "block") {
    throw new Error(`${worker.name}: ${reminderDecision.reason}.`);
  }
  if (reminderDecision.action === "skip") {
    console.log(`${worker.name}: reminder skipped; ${reminderDecision.reason}.`);
    return { action: "skipped" };
  }

  // A worker first onboarded after the current month did not have a required
  // timekeeping period yet. Do not manufacture a retrospective obligation.
  if (reminderRequiredDates(run.targetMonth, worker.onboardedAt).length === 0) {
    console.log(`${worker.name}: no required workdays in ${run.targetMonth}; no SMS sent.`);
    return { action: "not-applicable" };
  }

  if (worker.currentMonth !== run.targetMonth) {
    throw new Error(
      `${worker.name}: Current Month is ${worker.currentMonth || "blank"}, ` +
        `not the current Berlin month ${run.targetMonth}.`,
    );
  }

  await validateWorkerCurrentMonth(worker);
  const currentMonthRows = await queryAll(
    worker.d3DataSourceId,
    currentMonthFilter(run.targetMonth),
  );
  const incompleteDates = incompleteCurrentMonthDates(
    currentMonthRows,
    run.targetMonth,
    worker.onboardedAt,
  );
  if (incompleteDates.length === 0) {
    console.log(`${worker.name}: all ${run.targetMonth} weekdays are complete; no SMS sent.`);
    return { action: "complete" };
  }

  const phone = e164PhoneNumber(worker.phoneNumber);
  if (!phone) {
    const message = `${PHONE_PROPERTY} must be an E.164 number such as +491701234567.`;
    await markFailedWithoutSend(worker, run.reminderKey, message);
    throw new Error(`${worker.name}: ${message}`);
  }
  const frontendUrl = validHttpsUrl(worker.frontendUrl);
  if (!frontendUrl) {
    const message = "Frontend URL must be a valid HTTPS URL before an SMS can be sent.";
    await markFailedWithoutSend(worker, run.reminderKey, message);
    throw new Error(`${worker.name}: ${message}`);
  }

  // Save the at-most-once reservation before the external side effect.
  await updatePage(
    worker.rowId,
    reminderTrackingProperties(run.reminderKey, REMINDER_STATUS.SENDING),
  );

  try {
    const message = await sendTwilioSms({
      to: phone,
      body: reminderBody(run.targetMonth, incompleteDates.length, frontendUrl),
    });
    await updatePage(
      worker.rowId,
      reminderTrackingProperties(run.reminderKey, REMINDER_STATUS.ACCEPTED, {
        sentAt: new Date().toISOString(),
        twilioSid: message.sid,
      }),
    );
    console.log(`${worker.name}: reminder accepted by Twilio for ${run.reminderKey}.`);
    return { action: "sent" };
  } catch (failure) {
    const certainty = failure instanceof TwilioRequestError ? failure.certainty : "uncertain";
    const status = certainty === "failed" ? REMINDER_STATUS.FAILED : REMINDER_STATUS.UNCERTAIN;
    const message = errorMessage(failure).slice(0, 1900);
    try {
      await updatePage(
        worker.rowId,
        reminderTrackingProperties(run.reminderKey, status, { error: message }),
      );
    } catch (markFailure) {
      // The initial Sending reservation is already durable. Do not retry Twilio
      // if recording its outcome fails; a later run sees Sending and skips it.
      throw new Error(
        `${worker.name}: ${message}; could not record the ${status} state: ` +
          errorMessage(markFailure),
      );
    }
    throw new Error(`${worker.name}: ${message}`);
  }
}

function selectWorkers(workers, targetWorker) {
  if (!targetWorker) return workers.filter((worker) => worker.active);

  const matches = workers.filter(
    (worker) => worker.workerKey === targetWorker || worker.name === targetWorker,
  );
  if (matches.length === 0) {
    throw new Error(`No Ready worker matches SMS_REMINDER_TARGET_WORKER "${targetWorker}".`);
  }
  if (matches.length > 1) {
    throw new Error(
      `SMS_REMINDER_TARGET_WORKER "${targetWorker}" matches multiple Ready workers; use the exact Worker Key.`,
    );
  }
  if (!matches[0].active) {
    throw new Error(`${matches[0].name} is inactive and cannot receive an SMS reminder.`);
  }
  return matches;
}

async function main() {
  const run = currentReminderRun();
  if (run.currentDate < run.thirdFriday) {
    throw new Error(
      `SMS reminders begin on ${run.thirdFriday}; today is ${run.currentDate} in Europe/Berlin.`,
    );
  }
  await ensureD1ReminderSchema();
  const rows = await queryAll(D1, {
    property: "Onboarding Status",
    select: { equals: "Ready" },
  });
  const readyWorkers = rows.map(workerFromRow);
  assertUniqueWorkerReferences(readyWorkers, { roles: ["d3"] });
  const workers = selectWorkers(readyWorkers, run.targetWorker);
  console.log(
    `Checking every ${run.targetMonth} weekday for ${workers.length} active Ready worker(s) ` +
      `(${run.reminderKey}${run.targetWorker ? `; target ${run.targetWorker}` : ""}).`,
  );

  const failures = [];
  for (const worker of workers) {
    try {
      await processWorker(worker, run);
    } catch (failure) {
      const message = errorMessage(failure);
      console.error(message);
      failures.push(message);
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} SMS reminder failure(s): ${failures.join(" | ")}`);
  }
}

if (require.main === module) {
  main().catch((failure) => {
    console.error(errorMessage(failure));
    process.exitCode = 1;
  });
}

module.exports = {
  D1_REMINDER_SCHEMA,
  PHONE_PROPERTY,
  REMINDER_ERROR_PROPERTY,
  REMINDER_MONTH_PROPERTY,
  REMINDER_SENT_AT_PROPERTY,
  REMINDER_STATUS,
  REMINDER_STATUS_PROPERTY,
  REMINDER_TWILIO_SID_PROPERTY,
  addDays,
  currentMonthFilter,
  currentReminderRun,
  dayIsComplete,
  displayMonth,
  e164PhoneNumber,
  existingReminderDecision,
  incompleteCurrentMonthDates,
  isoDateInBerlin,
  isRequiredWorkday,
  reminderBody,
  reminderRequiredDates,
  selectWorkers,
  thirdFriday,
  twilioAuthentication,
  twilioMessageParameters,
  twilioSenderConfiguration,
  validHttpsUrl,
};
