"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  REMINDER_STATUS,
  currentReminderRun,
  e164PhoneNumber,
  existingReminderDecision,
  incompleteCurrentMonthDates,
  reminderBody,
  reminderRequiredDates,
  selectWorkers,
  thirdFriday,
  validHttpsUrl,
  workerFromRow,
} = require("../scripts/monthly-sms-reminders");

function currentMonthRow(isoDate, { hours = 8, standort = "Augsburg" } = {}) {
  return {
    properties: {
      Datum: { date: { start: isoDate } },
      Stunden: { number: hours },
      Standort: { select: standort ? { name: standort } : null },
    },
  };
}

test("the two reminder cycles are the third Friday and five calendar days before month end", () => {
  assert.equal(thirdFriday("2026-09"), "2026-09-18");
  assert.deepEqual(
    currentReminderRun({}, new Date("2026-09-18T06:17:00.000Z")),
    {
      targetMonth: "2026-09",
      currentDate: "2026-09-18",
      thirdFriday: "2026-09-18",
      fiveDaysBeforeMonthEnd: "2026-09-25",
      reminderKey: "2026-09:third-friday",
      targetWorker: "",
    },
  );
  assert.equal(
    currentReminderRun({}, new Date("2026-09-25T06:17:00.000Z")).reminderKey,
    "2026-09:five-days-before-month-end",
  );
});

test("manual dispatch can target one exact active worker without weakening scheduled scope", () => {
  const workers = [
    { name: "Alex Example", workerKey: "wrk_alex", active: true, smsNotification: true },
    { name: "Bea Example", workerKey: "wrk_bea", active: false, smsNotification: true },
    { name: "Chris Example", workerKey: "wrk_chris", active: true, smsNotification: false },
  ];
  assert.deepEqual(selectWorkers(workers, "wrk_alex"), [workers[0]]);
  assert.throws(() => selectWorkers(workers, "wrk_bea"), /inactive/);
  assert.throws(() => selectWorkers(workers, "wrk_chris"), /SMS Notification is unchecked/);
  assert.throws(() => selectWorkers(workers, "Chris Example"), /SMS Notification is unchecked/);
  assert.throws(() => selectWorkers(workers, "missing"), /No Ready worker matches/);
  assert.throws(
    () => currentReminderRun({ SMS_REMINDER_TARGET_WORKER: "wrk_alex" }),
    /allowed only for workflow_dispatch/,
  );
});

test("scheduled reminders require both D1 checkboxes, with missing or malformed values disabled", () => {
  const cases = [
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
    [true, undefined, false],
    [undefined, true, false],
    [true, "true", false],
    ["true", true, false],
  ];
  for (const [active, smsNotification, eligible] of cases) {
    const worker = workerFromRow({
      id: "test-worker",
      properties: {
        ...(active === undefined ? {} : { Active: { checkbox: active } }),
        ...(smsNotification === undefined ? {} : { "SMS Notification": { checkbox: smsNotification } }),
        "Onboarding Status": { select: { name: "Ready" } },
      },
    });
    assert.deepEqual(selectWorkers([worker], ""), eligible ? [worker] : []);
  }
});

test("a manual target cannot bypass missing SMS opt-in", () => {
  assert.throws(
    () => selectWorkers([{ name: "Alex Example", workerKey: "wrk_alex", active: true }], "wrk_alex"),
    /SMS Notification is unchecked/,
  );
});

test("required reminder dates include every Monday–Friday in the whole current month", () => {
  const april = reminderRequiredDates("2026-04", "2026-04-02T08:00:00.000Z");
  assert.deepEqual(april.slice(0, 2), ["2026-04-02", "2026-04-03"]);
  assert.equal(april.includes("2026-04-03"), true); // Karfreitag still needs its preset fields
  assert.equal(april.includes("2026-04-04"), false); // Saturday
  assert.equal(april.includes("2026-04-20"), true); // after third Friday still required
  assert.equal(reminderRequiredDates("2026-04", "2026-05-01").length, 0);
});

test("a missing day or a blank split-day D3 row makes that workday incomplete", () => {
  const targetMonth = "2026-04";
  const required = reminderRequiredDates(targetMonth, "2026-01-01");
  const rows = required
    .filter((day) => day !== "2026-04-07")
    .map((day) => currentMonthRow(day));
  rows.push(currentMonthRow("2026-04-08", { hours: null }));
  rows.push(currentMonthRow("2026-04-09", { standort: "" }));

  assert.deepEqual(
    incompleteCurrentMonthDates(rows, targetMonth, "2026-01-01"),
    ["2026-04-07", "2026-04-08", "2026-04-09"],
  );
});

test("only confirmed failed attempts can be retried; accepted and uncertain attempts are not resent", () => {
  assert.deepEqual(
    existingReminderDecision(
      { reminderMonth: "2026-09:third-friday", reminderStatus: REMINDER_STATUS.ACCEPTED },
      "2026-09:third-friday",
    ),
    { action: "skip", reason: "SMS Reminder Status is Accepted" },
  );
  assert.deepEqual(
    existingReminderDecision(
      { reminderMonth: "2026-09:third-friday", reminderStatus: REMINDER_STATUS.FAILED },
      "2026-09:third-friday",
    ),
    { action: "send" },
  );
  assert.equal(
    existingReminderDecision(
      { reminderMonth: "2026-09:third-friday", reminderStatus: REMINDER_STATUS.UNCERTAIN },
      "2026-09:five-days-before-month-end",
    ).action,
    "block",
  );
  assert.equal(
    existingReminderDecision(
      { reminderMonth: "2026-09:third-friday", reminderStatus: "" },
      "2026-09:third-friday",
    ).action,
    "skip",
  );
  assert.equal(
    existingReminderDecision(
      { reminderMonth: "2026-09:third-friday", reminderStatus: REMINDER_STATUS.ACCEPTED },
      "2026-09:five-days-before-month-end",
    ).action,
    "send",
  );
});

test("phone numbers and worker links must be safe to send", () => {
  assert.equal(e164PhoneNumber("+49 170 123 4567"), "+491701234567");
  assert.equal(e164PhoneNumber("0170 123 4567"), "");
  assert.equal(validHttpsUrl("https://www.notion.so/worker"), "https://www.notion.so/worker");
  assert.equal(validHttpsUrl("http://www.notion.so/worker"), "");
  assert.match(
    reminderBody("2026-09", 2, "https://www.notion.so/worker"),
    /September 2026.*2 Arbeitstage.*https:\/\/www\.notion\.so\/worker.*Keine SMS-Erinnerungen/,
  );
});
