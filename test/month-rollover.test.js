"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// The module validates its runtime configuration at load time, but these unit
// tests exercise only exported date/simulation helpers and never call Notion.
process.env.D1_DATA_SOURCE_ID = "test-d1";
process.env.D8_DATA_SOURCE_ID = "test-d8";

const {
  berlinDateParts,
  monthDays,
  monthForDate,
  resolveRunConfiguration,
} = require("../scripts/month-rollover");
const {
  HOLIDAY_HOURS,
  augsburgHolidayName,
  augsburgPaidHolidayName,
} = require("../scripts/augsburg-holidays");

test("Berlin calendar date crosses a UTC month boundary correctly", () => {
  assert.deepEqual(
    berlinDateParts(new Date("2026-09-30T22:30:00.000Z")),
    { year: 2026, month: 10, day: 1 },
  );
});

test("month generation covers leap-year February with German weekdays", () => {
  const days = monthDays("2028-02");
  assert.equal(days.length, 29);
  assert.deepEqual(days[0], { isoDate: "2028-02-01", weekday: "Dienstag" });
  assert.deepEqual(days.at(-1), { isoDate: "2028-02-29", weekday: "Dienstag" });
});

test("Augsburg statutory holidays include Bavaria, Mariä Himmelfahrt, and Friedensfest", () => {
  assert.equal(augsburgHolidayName("2026-04-03"), "Karfreitag");
  assert.equal(augsburgHolidayName("2026-06-04"), "Fronleichnam");
  assert.equal(augsburgHolidayName("2026-08-08"), "Augsburger Friedensfest");
  assert.equal(augsburgHolidayName("2026-08-15"), "Mariä Himmelfahrt");
  assert.equal(augsburgHolidayName("2026-10-03"), "Tag der Deutschen Einheit");
});

test("only Monday–Friday Augsburg holidays receive the standard eight-hour preset", () => {
  assert.equal(augsburgPaidHolidayName("2026-04-03"), "Karfreitag");
  assert.equal(HOLIDAY_HOURS, 8);
  assert.equal(augsburgPaidHolidayName("2026-08-08"), null);
  assert.equal(augsburgPaidHolidayName("2026-10-03"), null);
});

test("manual simulation is opt-in and limited to workflow_dispatch", () => {
  assert.deepEqual(
    resolveRunConfiguration({
      GITHUB_EVENT_NAME: "workflow_dispatch",
      ROLLOVER_SIMULATION: "true",
      ROLLOVER_SIMULATED_CURRENT_DATE: "2026-10-01",
      ROLLOVER_TARGET_WORKER: "wrk_poc_a",
    }),
    {
      targetMonth: "2026-10",
      targetWorker: "wrk_poc_a",
      simulation: true,
      liveEnabled: false,
    },
  );
  assert.throws(
    () =>
      resolveRunConfiguration({
        GITHUB_EVENT_NAME: "schedule",
        ROLLOVER_SIMULATION: "true",
        ROLLOVER_SIMULATED_CURRENT_DATE: "2026-10-01",
        ROLLOVER_TARGET_WORKER: "wrk_poc_a",
      }),
    /allowed only for workflow_dispatch/,
  );
});

test("source rows must have real ISO calendar dates", () => {
  assert.equal(monthForDate("2026-09-30"), "2026-09");
  assert.throws(() => monthForDate("2026-02-30"), /Invalid or missing calendar date/);
});
