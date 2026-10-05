"use strict";
const notion = require("./notion");
const { normalizeNotionId: norm } = require("./worker-identity");
const TITLE = "Datenprüfung";
const MARKER = "herzer-independent-audit-v1";
const STATUS = { PASS: "OK", WARNING: "Hinweise", ERROR: "Fehler", INCOMPLETE: "Unvollständig" };
const SCHEMA = { Prüfung: "title", Zeitpunkt: "date", Umfang: "select", Status: "select", Abdeckung: "rich_text", Fehler: "number", Hinweise: "number", "Nicht geprüft": "number", "GitHub Run": "url", "Run ID": "rich_text" };
const safe = (value) => String(value ?? "").replace(/[\r\n|]/g, " ").replace(/[<>]/g, "").replace(/([\\`*_[\]])/g, "\\$1");
function coverageText(report) {
  const c = report.coverage || {};
  return `${c.checkedWorkers || 0}/${c.workers || 0} workers; D3 ${c.d3Rows || 0}, D4 ${c.d4Rows || 0}, D7 ${c.d7Rows || 0} rows. History: ${c.history || "not checked"}; location totals: ${c.locationTotals || "not checked"}. ${report.counts.incomplete} incomplete checks.`;
}
function markdown(report) {
  return [`# Datenprüfung · ${report.scope} · ${report.status}`, "", `Checked: ${report.startedAt}`, "", coverageText(report), "",
    `Errors: ${report.counts.error} · Warnings: ${report.counts.warning} · Incomplete: ${report.counts.incomplete}`, "",
    "## Findings", "", ...(report.findings.length ? report.findings.map((f) =>
      `- **${f.severity.toUpperCase()}** ${safe(f.worker)} ${safe(f.date)} — ${safe(f.message)}${f.expected !== undefined ? `; expected ${safe(JSON.stringify(f.expected))}, actual ${safe(JSON.stringify(f.actual))}` : ""} ${f.records.map((r, i) => `[record ${i + 1}](${r.url})`).join(" ")}`) : ["All checks in this scope passed."]), "",
    "## Totals", "", ...report.totals.map((t) => `- ${safe(t.database)} ${safe(t.worker || t.standort || "")}: ${safe(JSON.stringify(t.groups || { rows: t.rows, expectedHours: t.expectedHours, actualHours: t.actualHours }))}`), "",
    "This audit compares stored records. Matching copies do not independently prove the hours worked. Current-scope results do not cover historical totals.", ""].join("\n");
}
function rich(content) { return notion.richText(String(content)).rich_text; }
function properties() {
  return { Prüfung: { title: {} }, Zeitpunkt: { date: {} }, Umfang: { select: { options: [{ name: "current", color: "blue" }, { name: "full", color: "purple" }] } },
    Status: { select: { options: [{ name: "OK", color: "green" }, { name: "Hinweise", color: "yellow" }, { name: "Fehler", color: "red" }, { name: "Unvollständig", color: "orange" }] } },
    Abdeckung: { rich_text: {} }, Fehler: { number: {} }, Hinweise: { number: {} }, "Nicht geprüft": { number: {} }, "GitHub Run": { url: {} }, "Run ID": { rich_text: {} } };
}
async function verifyParent(d1Id, api) {
  const ds = await api.getDataSource(d1Id);
  const db = await api.getDatabase(notion.databaseIdFromDataSource(ds));
  const parent = db.parent?.page_id;
  if (!parent) throw new Error("D1 is not directly under Control & Automation");
  const page = await api.getPage(parent);
  const title = notion.titleValue(Object.values(page.properties || {}).find((p) => p.type === "title"));
  if (title !== "Control & Automation" || page.in_trash) throw new Error("Report destination is not the verified Control & Automation page");
  return parent;
}
async function reportStore(d1Id, api) {
  const parent = await verifyParent(d1Id, api);
  async function locate() {
    const children = await api.listAllBlockChildren(parent);
    const candidates = children.filter((b) => b.type === "child_database" && b.child_database?.title === TITLE);
    if (candidates.length > 1) throw new Error("Multiple Datenprüfung databases; refusing an ambiguous report destination");
    return candidates[0] ? api.getDatabase(candidates[0].id) : null;
  }
  let db = await locate();
  if (!db) {
    try {
      db = await api.notion("/databases", { method: "POST", body: { parent: { type: "page_id", page_id: parent }, title: rich(TITLE), description: rich(MARKER), is_inline: true, initial_data_source: { properties: properties() } } });
    } catch (error) { db = await locate(); if (!db) throw error; }
  }
  if (norm(db.parent?.page_id) !== norm(parent) || db.in_trash || notion.plainText(db.description) !== MARKER) throw new Error("Report database is not owned by the audit publisher");
  const ds = await api.getDataSource(notion.dataSourceIdFromDatabase(db));
  if (norm(notion.databaseIdFromDataSource(ds)) !== norm(db.id)) throw new Error("Report data source has an unexpected parent");
  notion.assertPropertyTypes(ds, SCHEMA);
  for (const scope of ["current", "full"]) {
    const name = scope === "current" ? "Aktuell · letzte Prüfungen" : "Vollständig · letzte Prüfungen";
    const matches = (await api.listAllViews(db.id)).filter((v) => v.name === name);
    if (matches.length > 1) throw new Error(`Duplicate audit view ${name}`);
    if (!matches.length) {
      try { await api.createView({ database_id: db.id, data_source_id: ds.id, name, type: "table", filter: { property: "Umfang", select: { equals: scope } }, sorts: [{ property: "Zeitpunkt", direction: "descending" }] }); }
      catch (error) { if (!(await api.listAllViews(db.id)).some((v) => v.name === name)) throw error; }
    }
  }
  return { db, ds };
}
// All writes below are confined to the newly verified report store and rows
// found there by Run ID. Business database IDs are never write destinations.
async function publish(report, config, api = notion) {
  const { db, ds } = await reportStore(config.d1, api);
  const lookup = () => api.queryAll(ds.id, { property: "Run ID", rich_text: { equals: report.runId } });
  let matches = await lookup();
  if (matches.length > 1) throw new Error("Duplicate audit Run ID in report store");
  const props = { Prüfung: notion.title(`${report.scope} · ${report.startedAt}`), Zeitpunkt: notion.date(report.startedAt), Umfang: notion.select(report.scope), Status: notion.select("Unvollständig"), Abdeckung: notion.richText(coverageText(report)), Fehler: { number: report.counts.error }, Hinweise: { number: report.counts.warning }, "Nicht geprüft": { number: report.counts.incomplete }, "GitHub Run": { url: report.runUrl || null }, "Run ID": notion.richText(report.runId) };
  let page = matches[0];
  if (!page) {
    try { page = await api.createPage({ type: "data_source_id", data_source_id: ds.id }, props); }
    catch (error) { matches = await lookup(); if (matches.length !== 1) throw error; page = matches[0]; }
  }
  if (norm(page.parent?.data_source_id) !== norm(ds.id) && norm(page.parent?.database_id) !== norm(db.id)) throw new Error("Audit report page is outside its verified store");
  await api.updatePage(page.id, props);
  // Compare rendered block content to recover ambiguous append responses.
  // Render headings and clickable record links as native Notion content.
  const signature = (block) => `${block.type}:${JSON.stringify((block[block.type]?.rich_text || []).map((item) => [item.plain_text ?? item.text?.content ?? "", item.text?.link?.url || item.href || ""]))}`;
  const existing = new Set((await api.listAllBlockChildren(page.id)).map(signature));
  for (const line of markdown(report).split("\n").filter(Boolean)) {
    const type = line.startsWith("# ") ? "heading_2" : line.startsWith("## ") ? "heading_3" : "paragraph";
    const plain = line.replace(/^#{1,2} /, "").replace(/\*\*/g, "").replace(/^- /, "");
    for (const content of plain.match(/.{1,1600}/gs) || []) {
      const items = []; let cursor = 0;
      const pattern = /\[([^\]]+)\]\((https:\/\/www\.notion\.so\/[a-f0-9]+)\)/g;
      for (const match of content.matchAll(pattern)) {
        if (match.index > cursor) items.push(...rich(content.slice(cursor, match.index)));
        items.push({ type: "text", text: { content: match[1], link: { url: match[2] } } });
        cursor = match.index + match[0].length;
      }
      if (cursor < content.length) items.push(...rich(content.slice(cursor)));
      const block = { object: "block", type, [type]: { rich_text: items } };
      const key = signature(block);
      if (existing.has(key)) continue;
      try { await api.appendBlockChildren(page.id, [block]); }
      catch (error) { if (!(await api.listAllBlockChildren(page.id)).some((b) => signature(b) === key)) throw error; }
      existing.add(key);
    }
  }
  await api.updatePage(page.id, { Status: notion.select(STATUS[report.status]) });
  return { pageId: page.id, databaseId: db.id, url: page.url || `https://www.notion.so/${norm(page.id)}` };
}
module.exports = { SCHEMA, MARKER, coverageText, markdown, reportStore, publish };
