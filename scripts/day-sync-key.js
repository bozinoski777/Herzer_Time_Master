"use strict";

// A calendar date is not a row identity: workers may record several locations
// on the same day. Keep the date first so existing month-prefix queries work.
function daySyncKey(workerKey, datum, sourcePageId) {
  if (!workerKey || !/^\d{4}-\d{2}-\d{2}$/.test(datum || "") ||
      !sourcePageId || sourcePageId.includes("|")) {
    throw new Error("Cannot build a day Sync Key without worker, date, and D3 page ID");
  }
  return `${workerKey}|${datum}|${sourcePageId}`;
}

// Date-only keys are retained solely to migrate existing D4 rows in place.
function parseDaySyncKey(syncKey, workerKey) {
  const prefix = `${workerKey}|`;
  if (!syncKey.startsWith(prefix)) return null;
  const rest = syncKey.slice(prefix.length);
  const match = /^(\d{4}-\d{2}-\d{2})(?:\|([^|]+))?$/.exec(rest);
  if (!match) return null;
  const parsed = new Date(`${match[1]}T12:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== match[1]) {
    return null;
  }
  return { date: match[1], sourcePageId: match[2] || "" };
}

module.exports = { daySyncKey, parseDaySyncKey };
