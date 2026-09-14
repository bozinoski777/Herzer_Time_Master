"use strict";

/**
 * Statutory public holidays for an 8-hour, Monday–Friday work schedule in
 * Augsburg, Bavaria. The calendar is calculated locally so month rollover is
 * not dependent on a third-party holiday service being available.
 *
 * This includes the Bavaria-wide holidays, Mariä Himmelfahrt (a statutory
 * holiday in Augsburg), and Augsburg's 8 August Hohes Friedensfest.
 */

const HOLIDAY_HOURS = 8;

function validIsoDate(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate || "")) return false;
  const parsed = new Date(`${isoDate}T12:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === isoDate;
}

function isoDate(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Gregorian computus, returning the ISO date for Easter Sunday. */
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return isoDate(year, month, day);
}

function augsburgHolidayName(isoDateValue) {
  if (!validIsoDate(isoDateValue)) {
    throw new Error(`Invalid Augsburg holiday date "${isoDateValue || ""}"`);
  }

  const year = Number(isoDateValue.slice(0, 4));
  const fixedHolidays = new Map([
    [isoDate(year, 1, 1), "Neujahr"],
    [isoDate(year, 1, 6), "Heilige Drei Könige"],
    [isoDate(year, 5, 1), "Tag der Arbeit"],
    [isoDate(year, 8, 8), "Augsburger Friedensfest"],
    [isoDate(year, 8, 15), "Mariä Himmelfahrt"],
    [isoDate(year, 10, 3), "Tag der Deutschen Einheit"],
    [isoDate(year, 11, 1), "Allerheiligen"],
    [isoDate(year, 12, 25), "Erster Weihnachtstag"],
    [isoDate(year, 12, 26), "Zweiter Weihnachtstag"],
  ]);
  if (fixedHolidays.has(isoDateValue)) return fixedHolidays.get(isoDateValue);

  const easter = easterSunday(year);
  const movableHolidays = new Map([
    [addDays(easter, -2), "Karfreitag"],
    [addDays(easter, 1), "Ostermontag"],
    [addDays(easter, 39), "Christi Himmelfahrt"],
    [addDays(easter, 50), "Pfingstmontag"],
    [addDays(easter, 60), "Fronleichnam"],
  ]);
  return movableHolidays.get(isoDateValue) || null;
}

function augsburgPaidHolidayName(isoDateValue) {
  const holiday = augsburgHolidayName(isoDateValue);
  const dayOfWeek = new Date(`${isoDateValue}T12:00:00Z`).getUTCDay();
  return holiday && dayOfWeek >= 1 && dayOfWeek <= 5 ? holiday : null;
}

module.exports = {
  HOLIDAY_HOURS,
  addDays,
  augsburgHolidayName,
  augsburgPaidHolidayName,
  easterSunday,
};
