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
  return `Ab 01.10.2026 · ${c.checkedWorkers || 0}/${c.workers || 0} Mitarbeitende · D3: ${c.d3Rows || 0}, D4: ${c.d4Rows || 0}, D7: ${c.d7Rows || 0} Einträge. ${report.scope === "full" ? "Produktionshistorie und Standort-Summen geprüft." : "Aktueller Monat; Historie und Standort-Summen nicht geprüft."} ${report.counts.incomplete} unvollständige Prüfungen.`;
}
function markdown(report) {
  return [`# Datenprüfung · ${report.scope} · ${report.status}`, "", `Checked: ${report.startedAt}`, "", coverageText(report), "",
    `Errors: ${report.counts.error} · Warnings: ${report.counts.warning} · Incomplete: ${report.counts.incomplete}`, "",
    "## Findings", "", ...(report.findings.length ? report.findings.map((f) =>
      `- **${f.severity.toUpperCase()}** ${safe(f.worker)} ${safe(f.date)} — ${safe(f.message)}${f.expected !== undefined ? `; expected ${safe(JSON.stringify(f.expected))}, actual ${safe(JSON.stringify(f.actual))}` : ""} ${f.records.map((r, i) => `[record ${i + 1}](${r.url})`).join(" ")}`) : ["All checks in this scope passed."]), "",
    "## Totals", "", ...report.totals.map((t) => `- ${safe(t.database)} ${safe(t.worker || t.standort || "")}: ${safe(JSON.stringify(t.groups || { rows: t.rows, expectedHours: t.expectedHours, actualHours: t.actualHours, allTimeRollup: t.rollup }))}`), "",
    "This audit compares stored records. Matching copies do not independently prove the hours worked. Current-scope results do not cover historical totals.", ""].join("\n");
}
function notionMarkdown(report) {
  // Large import gaps can produce thousands of findings. Preserve all counts,
  // show examples for every worker/category, and keep full detail encrypted.
  const groups = new Map();
  for (const f of report.findings) {
    const key = JSON.stringify([f.severity, f.code, f.workerKey]);
    const entry = groups.get(key) || { severity: f.severity, code: f.code, worker: f.worker, findings: [] };
    entry.findings.push(f); groups.set(key, entry);
  }
  const ordered = [...groups.values()].sort((a, b) =>
    ["error", "incomplete", "warning", "info"].indexOf(a.severity) - ["error", "incomplete", "warning", "info"].indexOf(b.severity));
  const examples = ordered.flatMap((group) => group.findings.slice(0, 3));
  const body = markdown({ ...report, findings: examples, totals: report.totals.filter((t) => t.database === "D8") });
  const summary = ["## Finding groups", "", ...ordered.map((g) =>
    `- ${g.severity.toUpperCase()} · ${safe(g.worker || "System")} · ${g.code}: ${g.findings.length}`), "",
    `Showing ${examples.length} representative findings out of ${report.findings.length}. Each group includes up to three examples. ${report.encryptedDetails ? "Full findings are in the encrypted audit download on the GitHub run; the decryption key stays with the administrator." : "Full findings remain in the local audit.json report."}`, ""].join("\n");
  return body.replace("## Findings", `${summary}\n## Examples`);
}
// This repository is public. GitHub receives issue categories/counts only;
// never publish employee identifiers, dates, hours, source URLs or API errors.
function publicReport(report) {
  const issues = new Map();
  for (const f of report.findings) {
    const key = `${f.severity}:${f.code}`;
    const entry = issues.get(key) || { severity: f.severity, code: f.code, count: 0 };
    entry.count++; issues.set(key, entry);
  }
  return { version: report.version, scope: report.scope, runId: report.runId, startedAt: report.startedAt,
    status: report.status, counts: report.counts, checks: { history: report.coverage?.history || "not checked", locationTotals: report.coverage?.locationTotals || "not checked" },
    findings: [...issues.values()], detail: "Employee-level details are available only in the private Notion Datenprüfung report." };
}
function publicMarkdown(report) {
  const visible = publicReport(report);
  return [`# Datenprüfung · ${visible.scope} · ${visible.status}`, "", visible.detail, "",
    `Errors: ${visible.counts.error} · Warnings: ${visible.counts.warning} · Incomplete: ${visible.counts.incomplete}`, "",
    `History: ${visible.checks.history}; location totals: ${visible.checks.locationTotals}.`, "",
    ...visible.findings.map((f) => `- ${f.severity}: ${f.code} (${f.count})`), ""].join("\n");
}
function rich(content) { return notion.richText(String(content)).rich_text; }
function properties() {
  return { Prüfung: { title: {} }, Zeitpunkt: { date: {} }, Umfang: { select: { options: [{ name: "current", color: "blue" }, { name: "full", color: "purple" }] } },
    Status: { select: { options: [{ name: "OK", color: "green" }, { name: "Hinweise", color: "yellow" }, { name: "Fehler", color: "red" }, { name: "Unvollständig", color: "orange" }] } },
    Abdeckung: { rich_text: {} }, Fehler: { number: {} }, Hinweise: { number: {} }, "Nicht geprüft": { number: {} }, "GitHub Run": { url: {} }, "Run ID": { rich_text: {} } };
}
const HEALTH_TITLE = "System Health";
const OVERVIEW_LABELS = { current: "Aktueller Monat", full: "Gesamter Produktionszeitraum" };
const pageTitle = (page) => notion.titleValue(Object.values(page.properties || {}).find((v) => v.type === "title")).trim();
const healthyParent = (page) => { if (page.in_trash || page.archived || page.public_url) throw new Error("Report parent is trashed or publicly published"); return page; };
async function verifyParent(d1Id, api) {
  const ds = await api.getDataSource(d1Id);
  const db = await api.getDatabase(notion.databaseIdFromDataSource(ds));
  let root = healthyParent(await api.getPage(db.parent?.page_id));
  if (pageTitle(root) === "Control & Automation" && root.parent?.page_id) root = healthyParent(await api.getPage(root.parent.page_id));
  if (pageTitle(root) !== "Secure Timekeeping POC" || !root.id) throw new Error("Report destination is not the verified Secure Timekeeping POC page");
  const locate = async () => {
    const matches = (await api.listAllBlockChildren(root.id)).filter((b) => b.type === "child_page" && b.child_page.title === HEALTH_TITLE);
    if (matches.length > 1) throw new Error("Multiple System Health pages beneath the POC");
    return matches.length ? api.getPage(matches[0].id) : null;
  };
  let health = await locate();
  if (!health) {
    try { health = await api.createPage({ type: "page_id", page_id: root.id }, { title: notion.title(HEALTH_TITLE) }, { icon: { type: "emoji", emoji: "🩺" } }); }
    catch (error) { health = await locate(); if (!health) throw error; }
  }
  healthyParent(health);
  if (norm(health.parent?.page_id) !== norm(root.id) || pageTitle(health) !== HEALTH_TITLE) throw new Error("System Health is outside its verified POC parent");
  return health.id;
}
async function ensureOverview(parent, api) {
  // Managed labels identify only our own blocks; user-added content is preserved.
  const intro = "Prüfzeitraum: ab 01.10.2026. Manuell migrierte Daten bis 30.09.2026 sind ausgeschlossen. Die Prüfung liest Geschäftsdaten und repariert nichts. Tagesprüfung und vollständige Prüfung werden getrennt angezeigt.";
  const existing = await api.listAllBlockChildren(parent);
  const blocks = [
    { object: "block", type: "paragraph", paragraph: { rich_text: rich(intro) } },
    ...Object.values(OVERVIEW_LABELS).map((label) => ({ object: "block", type: "callout", callout: { icon: { type: "emoji", emoji: "⏳" }, rich_text: rich(`${label}\nNoch keine veröffentlichte Prüfung.`) } })),
  ];
  for (const block of blocks) {
    const prefix = block.type === "callout" ? block.callout.rich_text[0].text.content.split("\n")[0] : "Prüfzeitraum: ab 01.10.2026.";
    if (existing.some((b) => b.type === block.type && notion.plainText(b[b.type]?.rich_text).startsWith(prefix))) continue;
    try { await api.appendBlockChildren(parent, [block]); }
    catch (error) { if (!(await api.listAllBlockChildren(parent)).some((b) => b.type === block.type && notion.plainText(b[b.type]?.rich_text).startsWith(prefix))) throw error; }
  }
}
async function updateOverview(parent, dsId, api) {
  const rows = await api.queryAll(dsId);
  const blocks = await api.listAllBlockChildren(parent);
  for (const [scope, label] of Object.entries(OVERVIEW_LABELS)) {
    const latest = rows.filter((r) => r.properties.Umfang?.select?.name === scope)
      .sort((a, b) => (b.properties.Zeitpunkt?.date?.start || "").localeCompare(a.properties.Zeitpunkt?.date?.start || ""))[0];
    if (!latest) continue;
    const targets = blocks.filter((b) => b.type === "callout" && notion.plainText(b.callout.rich_text).startsWith(`${label}\n`));
    if (targets.length !== 1) throw new Error(`Ambiguous System Health summary: ${label}`);
    const p = latest.properties, status = p.Status.select.name;
    const when = new Date(p.Zeitpunkt.date.start).toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
    const content = `${label}\n${status} · ${when} (Berlin)\n${p.Fehler.number} Fehler · ${p.Hinweise.number} Hinweise · ${p["Nicht geprüft"].number} unvollständig\n${notion.richTextValue(p.Abdeckung)}\n`;
    await api.notion(`/blocks/${targets[0].id}`, { method: "PATCH", body: { callout: { icon: { type: "emoji", emoji: status === "OK" ? "✅" : status === "Hinweise" ? "🟡" : "🔴" }, rich_text: [...rich(content), { type: "text", text: { content: "Bericht öffnen", link: { url: latest.url || `https://www.notion.so/${norm(latest.id)}` } } }] } } });
  }
}
async function reportStore(d1Id, api) {
  const parent = await verifyParent(d1Id, api);
  await ensureOverview(parent, api);
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
  return { db, ds, parent };
}
// All writes below are confined to the newly verified report store and rows
// found there by Run ID. Business database IDs are never write destinations.
async function publish(report, config, api = notion) {
  const { db, ds, parent } = await reportStore(config.d1, api);
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
  const pendingBlocks = [];
  for (const line of notionMarkdown(report).split("\n").filter(Boolean)) {
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
      pendingBlocks.push(block);
      existing.add(key);
    }
  }
  for (let offset = 0; offset < pendingBlocks.length; offset += 50) {
    const batch = pendingBlocks.slice(offset, offset + 50);
    try { await api.appendBlockChildren(page.id, batch); }
    catch (error) {
      const saved = new Set((await api.listAllBlockChildren(page.id)).map(signature));
      if (!batch.every((block) => saved.has(signature(block)))) throw error;
    }
  }
  await api.updatePage(page.id, { Status: notion.select(STATUS[report.status]) });
  await updateOverview(parent, ds.id, api);
  return { healthPageId: parent, healthUrl: `https://www.notion.so/${norm(parent)}`, pageId: page.id, databaseId: db.id, url: page.url || `https://www.notion.so/${norm(page.id)}` };
}
module.exports = { SCHEMA, MARKER, coverageText, markdown, notionMarkdown, publicReport, publicMarkdown, reportStore, publish };
