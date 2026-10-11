"use strict";
const fs = require("node:fs");
function markerContext(marker) {
  if (marker.version !== 1 || !["success", "failure"].includes(marker.standortConclusion)) throw new Error("Invalid Standort completion marker");
  if (marker.auditScope && !["current", "full"].includes(marker.auditScope)) throw new Error("Invalid audit scope in Standort completion marker");
  if (marker.syncCutoff && Number.isNaN(Date.parse(marker.syncCutoff))) throw new Error("Invalid upstream sync time");
  if (marker.dailyRunId && !["success", "failure"].includes(marker.dailyConclusion)) throw new Error("Invalid Daily sync conclusion");
  return { scope: marker.auditScope || "", cutoff: marker.syncCutoff || "", failure: [marker.dailyRunId && marker.dailyConclusion !== "success" ? `Daily sync ${marker.dailyRunId}: ${marker.dailyConclusion}` : "", marker.standortConclusion !== "success" ? `Standort sync: ${marker.standortConclusion}` : ""].filter(Boolean).join("; ") };
}
if (require.main === module) {
  if (process.argv[2] === "marker") {
    const context = markerContext(JSON.parse(fs.readFileSync(process.argv[3], "utf8")));
    if ((process.env.AUDIT_SCOPE === "full" && context.scope !== "full") ||
        (context.scope && context.scope !== process.env.AUDIT_SCOPE))
      throw new Error("Standort completion marker disagrees with audit scope");
    fs.appendFileSync(process.env.GITHUB_ENV, `AUDIT_SYNC_CUTOFF=${context.cutoff}\nAUDIT_UPSTREAM_FAILURE=${context.failure}\n`);
  } else throw new Error("Expected marker command");
}
module.exports = { markerContext };
