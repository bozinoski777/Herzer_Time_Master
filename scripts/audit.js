"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { encryptReport } = require("./audit-crypto");
const { collect } = require("./audit-reader");
const { compareReads, add, finish } = require("./audit-model");
const { markdown, publicReport, publicMarkdown, publish } = require("./audit-report");
const { berlinDate } = require("./vacation-carryover");

function configuration(args = process.argv.slice(2), env = process.env, now = new Date()) {
  let scope = "current", publishNotion = false;
  for (const arg of args) {
    if (arg === "--publish-notion") publishNotion = true;
    else if (["--scope=current", "--scope=full"].includes(arg)) scope = arg.slice(8);
    else throw new Error(`Unknown audit argument ${arg}`);
  }
  const startedAt = now.toISOString();
  return { scope, publishNotion, startedAt, currentMonth: berlinDate(now).slice(0, 7),
    d1: env.D1_DATA_SOURCE_ID, d7: env.D7_DATA_SOURCE_ID, d8: env.D8_DATA_SOURCE_ID,
    runId: env.AUDIT_RUN_ID || (env.GITHUB_RUN_ID ? `${env.GITHUB_REPOSITORY}/${env.GITHUB_RUN_ID}` : crypto.randomUUID()),
    runUrl: env.GITHUB_RUN_ID ? `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : "",
    syncCutoff: env.AUDIT_SYNC_CUTOFF || "", upstreamFailure: env.AUDIT_UPSTREAM_FAILURE || "",
    redactGithub: env.AUDIT_REDACT_GITHUB === "true",
    reportPublicKey: env.AUDIT_REPORT_PUBLIC_KEY || "",
    outputDir: env.AUDIT_OUTPUT_DIR || "audit-output", summaryFile: env.GITHUB_STEP_SUMMARY || "" };
}
async function run(config, operations = {}) {
  const read = operations.collect || collect;
  let report;
  try {
    for (const key of ["d1", "d7", "d8"]) if (!config[key]) throw new Error(`Missing ${key.toUpperCase()}_DATA_SOURCE_ID`);
    if (config.syncCutoff && Number.isNaN(Date.parse(config.syncCutoff))) throw new Error("Invalid preceding-sync timestamp");
    const first = await read(config);
    const second = await read(config);
    report = compareReads(first, second, config);
  } catch (error) {
    report = { version: 1, scope: config.scope, runId: config.runId, runUrl: config.runUrl, startedAt: config.startedAt, coverage: {}, totals: [], findings: [] };
    add(report, "incomplete", "audit-failure", error.message); finish(report);
  }
  report.encryptedDetails = Boolean(config.reportPublicKey);
  const save = () => {
    fs.mkdirSync(config.outputDir, { recursive: true });
    fs.writeFileSync(path.join(config.outputDir, "audit.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(config.outputDir, "audit.md"), markdown(report));
    if (config.redactGithub) {
      const directory = path.join(config.outputDir, "github");
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "audit.json"), JSON.stringify(publicReport(report), null, 2));
      fs.writeFileSync(path.join(directory, "audit.md"), publicMarkdown(report));
      if (config.reportPublicKey) fs.writeFileSync(path.join(directory, "audit-details.enc.json"), JSON.stringify(encryptReport(report, config.reportPublicKey)));
    }
  };
  save(); // Preserve findings even if publication fails.
  if (config.publishNotion) {
    try { report.publication = await (operations.publish || publish)(report, config); }
    catch (error) { add(report, "incomplete", "report-publication", error.message); finish(report); }
    save();
  }
  if (config.summaryFile) {
    const summary = config.redactGithub ? publicMarkdown(report) : markdown(report);
    fs.appendFileSync(config.summaryFile, summary.length > 800000 ? `${summary.slice(0, 800000)}\n\nSummary truncated; download audit.json for all findings.\n` : summary);
  }
  return report;
}
if (require.main === module) {
  Promise.resolve().then(() => run(configuration())).then((report) => {
    console.log(`Audit ${report.scope}: ${report.status}; ${report.counts.error} errors, ${report.counts.warning} warnings, ${report.counts.incomplete} incomplete checks.`);
    if (["ERROR", "INCOMPLETE"].includes(report.status)) process.exitCode = 1;
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { configuration, run };
