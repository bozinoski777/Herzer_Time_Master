"use strict";
const fs = require("node:fs");
function scheduledScope(schedule, now = new Date()) {
  const offset = new Intl.DateTimeFormat("en", { timeZone: "Europe/Berlin", timeZoneName: "shortOffset" }).formatToParts(now).find((p) => p.type === "timeZoneName").value;
  return (offset === "GMT+2" && schedule === "35 2 * * 0") || (offset === "GMT+1" && schedule === "35 3 * * 0") ? "full" : "";
}
function markerContext(marker) {
  if (marker.version !== 1 || !["success", "failure"].includes(marker.standortConclusion)) throw new Error("Invalid Standort completion marker");
  if (marker.syncCutoff && Number.isNaN(Date.parse(marker.syncCutoff))) throw new Error("Invalid upstream sync time");
  if (marker.dailyRunId && !["success", "failure"].includes(marker.dailyConclusion)) throw new Error("Invalid Daily sync conclusion");
  return { cutoff: marker.syncCutoff || "", failure: [marker.dailyRunId && marker.dailyConclusion !== "success" ? `Daily sync ${marker.dailyRunId}: ${marker.dailyConclusion}` : "", marker.standortConclusion !== "success" ? `Standort sync: ${marker.standortConclusion}` : ""].filter(Boolean).join("; ") };
}
if (require.main === module) {
  if (process.argv[2] === "marker") {
    const context = markerContext(JSON.parse(fs.readFileSync(process.argv[3], "utf8")));
    fs.appendFileSync(process.env.GITHUB_ENV, `AUDIT_SYNC_CUTOFF=${context.cutoff}\nAUDIT_UPSTREAM_FAILURE=${context.failure}\n`);
  } else {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `scope=${scheduledScope(process.env.AUDIT_SCHEDULE)}\n`);
  }
}
module.exports = { scheduledScope, markerContext };
