"use strict";

/**
 * Add the rollover runbook to the Control & Automation page that owns D1.
 * This intentionally derives its target from D1, then verifies the exact page
 * title, instead of accepting a broad Notion page ID that could point outside
 * the Secure Timekeeping POC.
 */

const {
  appendBlockChildren,
  databaseIdFromDataSource,
  errorMessage,
  getDataSource,
  getDatabase,
  getPage,
  listAllBlockChildren,
  requireEnv,
  titleValue,
} = require("./notion");

const { D1_DATA_SOURCE_ID: D1 } = requireEnv("D1_DATA_SOURCE_ID");
const HEADING = "Month Rollover – What Happens";

function textBlock(type, content) {
  return {
    object: "block",
    type,
    [type]: {
      rich_text: [{ type: "text", text: { content } }],
    },
  };
}

function pageTitle(page) {
  const property = Object.values(page.properties || {}).find((candidate) => candidate.type === "title");
  return titleValue(property).trim();
}

function isHeading(block) {
  return (
    block.type === "heading_2" &&
    (block.heading_2?.rich_text || []).map((item) => item.plain_text || "").join("") === HEADING
  );
}

async function controlAutomationPageId() {
  const d1 = await getDataSource(D1);
  const d1Database = await getDatabase(databaseIdFromDataSource(d1));
  const parentPageId = d1Database.parent?.page_id;
  if (!parentPageId) {
    throw new Error("D1 is not directly inside a Control & Automation page; refusing to guess a documentation target.");
  }

  const parentPage = await getPage(parentPageId);
  if (pageTitle(parentPage) !== "Control & Automation") {
    throw new Error(
      `D1 parent page is "${pageTitle(parentPage) || "(untitled)"}", not "Control & Automation"; refusing to write outside the POC documentation page.`,
    );
  }
  return parentPageId;
}

async function main() {
  const pageId = await controlAutomationPageId();
  const blocks = await listAllBlockChildren(pageId);
  if (blocks.some(isHeading)) {
    console.log(`"${HEADING}" is already present; no documentation change needed.`);
    return;
  }

  await appendBlockChildren(pageId, [
    textBlock("heading_2", HEADING),
    textBlock(
      "paragraph",
      "At the start of a new Europe/Berlin calendar month, the automation checks every onboarded worker with valid D3 and D4 references, including former workers marked Active = false.",
    ),
    textBlock(
      "bulleted_list_item",
      "It copies each completed D3 day to the worker’s D4 archive using Worker Key|YYYY-MM-DD, preserving weekday, date, hours, day type, site, and historic sites that are no longer active.",
    ),
    textBlock(
      "bulleted_list_item",
      "It verifies every expected D4 archive row before touching D3. If verification fails, D3 remains unchanged and the worker receives a visible D1 rollover error.",
    ),
    textBlock(
      "bulleted_list_item",
      "After verification, it soft-archives old D3 pages rather than permanently deleting them, then rebuilds D3 site choices from currently active D8 sites only.",
    ),
    textBlock(
      "bulleted_list_item",
      "Active workers receive one blank D3 row for every day of the new/current month. Inactive workers keep D4 history but receive no new month.",
    ),
    textBlock(
      "bulleted_list_item",
      "D7 remains the all-time management history. Rollover never deletes D7 rows; normal daily sync continues to update current D3 days.",
    ),
    textBlock(
      "paragraph",
      "Errors and retries: D1 shows Current Month, Last Archived Month, Last Rollover At, Rollover Status, and Rollover Error. A retry reuses D4 Sync Keys and creates only missing D3 days, so it does not duplicate archive or current-month records.",
    ),
  ]);
  console.log(`Added "${HEADING}" to the verified Control & Automation page.`);
}

main().catch((failure) => {
  console.error(errorMessage(failure));
  process.exitCode = 1;
});
