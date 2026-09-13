"use strict";

/**
 * Small, dependency-free Notion REST client.
 *
 * Notion moved database rows and schema operations to data-source endpoints in
 * API version 2025-09-03. This POC deliberately uses the current API version
 * and Node's built-in fetch instead of placing a token or an SDK in the repo.
 */

const NOTION_API_BASE_URL = "https://api.notion.com/v1";
const NOTION_VERSION = process.env.NOTION_VERSION || "2026-03-11";
const REQUEST_SPACING_MS = 350;
const MAX_RETRIES = 5;

let nextRequestAt = 0;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireEnv(...names) {
  const missing = names.filter((name) => !process.env[name]?.trim());

  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }

  return Object.fromEntries(names.map((name) => [name, process.env[name].trim()]));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseResponseBody(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function retryDelayMilliseconds(response, attempt) {
  const retryAfter = Number(response.headers.get("retry-after"));

  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter * 1000;
  }

  // Bounded exponential backoff, with a small deterministic spread.
  return Math.min(1000 * 2 ** attempt, 16000) + 137;
}

async function waitForRequestSlot() {
  const waitMilliseconds = Math.max(0, nextRequestAt - Date.now());
  if (waitMilliseconds > 0) await sleep(waitMilliseconds);
  nextRequestAt = Date.now() + REQUEST_SPACING_MS;
}

/**
 * Make an authenticated Notion REST request. The token is read only when a
 * request is made, so `node --check` never needs credentials or contacts Notion.
 */
async function notion(path, options = {}) {
  const { NOTION_TOKEN } = requireEnv("NOTION_TOKEN");
  const method = options.method || "GET";
  // Retrying an ambiguous create can produce a second page/database. Queries,
  // reads, and PATCHes are safe to repeat; creates are recovered by the caller.
  const retrySafe = method === "GET" || method === "PATCH" || path.endsWith("/query");

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await waitForRequestSlot();

    let response;
    try {
      response = await fetch(`${NOTION_API_BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (error) {
      if (!retrySafe || attempt === MAX_RETRIES) {
        throw new Error(`Notion network request failed: ${errorMessage(error)}`);
      }

      await sleep(Math.min(1000 * 2 ** attempt, 16000) + 137);
      continue;
    }

    const body = parseResponseBody(await response.text());

    if (response.ok) return body;

    if (
      retrySafe &&
      (response.status === 429 || response.status >= 500) &&
      attempt < MAX_RETRIES
    ) {
      await sleep(retryDelayMilliseconds(response, attempt));
      continue;
    }

    const detail = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`Notion ${method} ${path} failed (${response.status}): ${detail}`);
  }

  throw new Error(`Notion ${method} ${path} failed after retries`);
}

async function queryAll(dataSourceId, filter) {
  const results = [];
  let startCursor;

  do {
    const response = await notion(`/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body: {
        page_size: 100,
        ...(filter ? { filter } : {}),
        ...(startCursor ? { start_cursor: startCursor } : {}),
      },
    });

    results.push(...response.results);
    startCursor = response.has_more ? response.next_cursor : undefined;
  } while (startCursor);

  return results;
}

async function listAllBlockChildren(blockId) {
  const results = [];
  let startCursor;

  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (startCursor) query.set("start_cursor", startCursor);

    const response = await notion(`/blocks/${blockId}/children?${query.toString()}`);
    results.push(...response.results);
    startCursor = response.has_more ? response.next_cursor : undefined;
  } while (startCursor);

  return results;
}

function plainText(items = []) {
  return items.map((item) => item.plain_text || "").join("");
}

function titleValue(property) {
  return plainText(property?.title);
}

function richTextValue(property) {
  return plainText(property?.rich_text);
}

function selectValue(property) {
  return property?.select?.name || "";
}

function textItems(content) {
  if (!content) return [];

  // Notion caps a text.content value at 2,000 characters.
  return String(content)
    .match(/.{1,2000}/gs)
    .map((chunk) => ({ type: "text", text: { content: chunk } }));
}

function title(content) {
  return { title: textItems(content) };
}

function richText(content) {
  return { rich_text: textItems(content) };
}

function select(name) {
  return { select: name ? { name } : null };
}

function date(start) {
  return { date: start ? { start } : null };
}

function getDataSource(dataSourceId) {
  return notion(`/data_sources/${dataSourceId}`);
}

function getDatabase(databaseId) {
  return notion(`/databases/${databaseId}`);
}

function getPage(pageId) {
  return notion(`/pages/${pageId}`);
}

function updatePage(pageId, properties, extra = {}) {
  return notion(`/pages/${pageId}`, {
    method: "PATCH",
    body: { properties, ...extra },
  });
}

/**
 * Soft-remove a Notion page. This is intentionally the only removal primitive
 * exposed to the POC: archive keeps the source page recoverable and avoids any
 * hard-delete path during a month rollover.
 */
function archivePage(pageId) {
  return notion(`/pages/${pageId}`, {
    method: "PATCH",
    // Notion API 2026-03-11 removed the former `archived` alias. `in_trash`
    // is recoverable and is the only supported soft-removal mechanism.
    body: { in_trash: true },
  });
}

function createPage(parent, properties, extra = {}) {
  return notion("/pages", {
    method: "POST",
    body: { parent, properties, ...extra },
  });
}

/**
 * Move one regular page without copying its content. This is used by the
 * onboarding migration path to turn a legacy worker page into a row in the
 * private Employee Front-ends data source.
 */
function movePage(pageId, parent) {
  return notion(`/pages/${pageId}/move`, {
    method: "POST",
    body: { parent },
  });
}

/**
 * Append (or insert after a known block) content blocks in a page. Callers
 * recover after any ambiguous network failure by checking the page first.
 */
function appendBlockChildren(blockId, children, afterBlockId) {
  return notion(`/blocks/${blockId}/children`, {
    method: "PATCH",
    body: {
      children,
      ...(afterBlockId
        ? {
            position: {
              type: "after_block",
              after_block: { id: afterBlockId },
            },
          }
        : {}),
    },
  });
}

function updateDataSource(dataSourceId, properties) {
  return notion(`/data_sources/${dataSourceId}`, {
    method: "PATCH",
    body: { properties },
  });
}

function updateDatabase(databaseId, attributes) {
  return notion(`/databases/${databaseId}`, {
    method: "PATCH",
    body: attributes,
  });
}

function dataSourceIdFromDatabase(database) {
  const id = database?.data_sources?.[0]?.id;
  if (!id) throw new Error(`Database ${database?.id || "(unknown)"} has no data source`);
  return id;
}

function databaseIdFromDataSource(dataSource) {
  const parent = dataSource?.parent;
  if (parent?.type !== "database_id" || !parent.database_id) {
    throw new Error(`Data source ${dataSource?.id || "(unknown)"} is not parented by a database`);
  }
  return parent.database_id;
}

function assertPropertyTypes(dataSource, expectedTypes) {
  const problems = [];

  for (const [name, expectedType] of Object.entries(expectedTypes)) {
    const property = dataSource.properties?.[name];
    if (!property) {
      problems.push(`missing \"${name}\"`);
    } else if (property.type !== expectedType) {
      problems.push(`\"${name}\" is ${property.type}, expected ${expectedType}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Data source ${dataSource.id} does not match the POC schema: ${problems.join("; ")}`,
    );
  }
}

module.exports = {
  NOTION_VERSION,
  appendBlockChildren,
  archivePage,
  assertPropertyTypes,
  createPage,
  dataSourceIdFromDatabase,
  databaseIdFromDataSource,
  date,
  errorMessage,
  getDataSource,
  getDatabase,
  getPage,
  listAllBlockChildren,
  movePage,
  notion,
  plainText,
  queryAll,
  requireEnv,
  richText,
  richTextValue,
  select,
  selectValue,
  title,
  titleValue,
  updateDataSource,
  updateDatabase,
  updatePage,
};
