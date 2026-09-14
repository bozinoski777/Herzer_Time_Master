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
      "It copies each completed D3 day to the worker’s D4 archive using Worker Key|YYYY-MM-DD, preserving weekday, date, hours, and the worker’s single Standort/work choice, including historic locations that are no longer active.",
    ),
    textBlock(
      "bulleted_list_item",
      "It verifies every expected D4 archive row, upserts and verifies the same final values in management D7, and verifies the matching D8 relations. The hidden checkpoint is bound to the exact D3/D4 routing. After D3 is soft-archived, all three barriers are verified again; a failed final barrier restores the source pages and leaves a visible D1 rollover error.",
    ),
    textBlock(
      "bulleted_list_item",
      "After verification, it soft-archives old D3 pages rather than permanently deleting them, then rebuilds D3 Standort choices from currently active D8 sites plus the standard work choices.",
    ),
    textBlock(
      "bulleted_list_item",
      "Active workers receive one blank D3 row for every day of the new/current month. Inactive workers keep D4 history but receive no new month.",
    ),
    textBlock(
      "bulleted_list_item",
      "D7 remains the all-time management history. Rollover secures final completed-month values itself, while Daily sync uses Source Page ID to reconcile date changes and current-month deletions.",
    ),
    textBlock(
      "paragraph",
      "Errors and retries: D1 shows Current Month, Last Archived Month, Last Rollover At, Rollover Status, and Rollover Error. A retry reuses D4 Sync Keys and D7 Source Page IDs, then creates only missing D3 days, so it does not duplicate records.",
    ),
  ]);
  console.log(`Added "${HEADING}" to the verified Control & Automation page.`);
}

main().catch((failure) => {
  console.error(errorMessage(failure));
  process.exitCode = 1;
});
