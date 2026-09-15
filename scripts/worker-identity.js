"use strict";

const { richTextValue, titleValue } = require("./notion");

const D1_WORKER_IDENTITY_SCHEMA = Object.freeze({
  "Vor- und Nachname": "title",
  "Worker Key": "rich_text",
  "Frontend Page ID": "rich_text",
  "User Page ID": "rich_text",
});

const FRONTEND_IDENTITY_SCHEMA = Object.freeze({
  "Worker Key": "rich_text",
  "D1 Record ID": "rich_text",
});

/** Notion returns the same page ID both with and without UUID hyphens. */
function normalizeNotionId(value) {
  return String(value || "").trim().replaceAll("-", "").toLowerCase();
}

function rowText(row, propertyName) {
  return richTextValue(row?.properties?.[propertyName]).trim();
}

function workerIdentityFromD1(row) {
  if (!row?.id) throw new Error("A D1 row ID is required to identify a worker");
  const currentFrontendPageId = rowText(row, "Frontend Page ID");
  const legacyFrontendPageId = rowText(row, "User Page ID");
  return {
    row,
    rowId: row.id,
    d1RecordId: row.id,
    name: titleValue(row.properties?.["Vor- und Nachname"]).trim() || row.id,
    workerKey: rowText(row, "Worker Key"),
    frontendPageId: currentFrontendPageId || legacyFrontendPageId,
    userPageId: legacyFrontendPageId,
  };
}

function frontendIdentity(candidate) {
  return {
    d1RecordId: rowText(candidate, "D1 Record ID"),
    workerKey: rowText(candidate, "Worker Key"),
  };
}

function expectedIdentity(identity = {}) {
  return {
    d1RecordId: String(identity.d1RecordId || identity.rowId || "").trim(),
    workerKey: String(identity.workerKey || identity.key || "").trim(),
  };
}

function assertFrontendIdentity(candidate, identity) {
  const expected = expectedIdentity(identity);
  const stored = frontendIdentity(candidate);
  if (!expected.d1RecordId) {
    throw new Error("A D1 Record ID is required to validate a worker frontend");
  }
  if (
    stored.d1RecordId &&
    normalizeNotionId(stored.d1RecordId) !== normalizeNotionId(expected.d1RecordId)
  ) {
    throw new Error(
      `Frontend ${candidate.id} belongs to D1 Record ID ${stored.d1RecordId}, not ${expected.d1RecordId}.`,
    );
  }
  if (stored.workerKey && expected.workerKey && stored.workerKey !== expected.workerKey) {
    throw new Error(
      `Frontend ${candidate.id} belongs to Worker Key ${stored.workerKey}, not ${expected.workerKey}.`,
    );
  }
  return candidate;
}

/**
 * Recover by the immutable D1 page ID first. A non-empty Worker Key is only a
 * fallback for a create that completed before D1 could store the frontend ID.
 * A worker name is deliberately never an identity.
 */
function selectRecoverableFrontend(rows, identity) {
  const expected = expectedIdentity(identity);
  if (!expected.d1RecordId) {
    throw new Error("A D1 Record ID is required to recover a worker frontend");
  }

  const normalizedD1RecordId = normalizeNotionId(expected.d1RecordId);
  const d1Matches = rows.filter(
    (candidate) =>
      normalizeNotionId(frontendIdentity(candidate).d1RecordId) === normalizedD1RecordId,
  );
  if (d1Matches.length > 1) {
    throw new Error(
      `Employee Front-ends has multiple rows with D1 Record ID ${expected.d1RecordId}; refusing to choose one.`,
    );
  }

  const keyMatches = expected.workerKey
    ? rows.filter(
        (candidate) => frontendIdentity(candidate).workerKey === expected.workerKey,
      )
    : [];
  if (keyMatches.length > 1) {
    throw new Error(
      `Employee Front-ends has multiple rows with Worker Key ${expected.workerKey}; refusing to choose one.`,
    );
  }

  if (d1Matches.length === 1) {
    const d1Match = d1Matches[0];
    if (
      keyMatches.length === 1 &&
      normalizeNotionId(keyMatches[0].id) !== normalizeNotionId(d1Match.id)
    ) {
      throw new Error(
        `D1 Record ID ${expected.d1RecordId} and Worker Key ${expected.workerKey} identify different frontend rows.`,
      );
    }
    const storedKey = frontendIdentity(d1Match).workerKey;
    if (storedKey && expected.workerKey && storedKey !== expected.workerKey) {
      throw new Error(
        `Frontend ${d1Match.id} has D1 Record ID ${expected.d1RecordId} but Worker Key ${storedKey}, not ${expected.workerKey}.`,
      );
    }
    return d1Match;
  }

  if (keyMatches.length === 0) return undefined;

  const keyMatch = keyMatches[0];
  const keyMatchD1RecordId = frontendIdentity(keyMatch).d1RecordId;
  if (
    keyMatchD1RecordId &&
    normalizeNotionId(keyMatchD1RecordId) !== normalizedD1RecordId
  ) {
    throw new Error(
      `Worker Key ${expected.workerKey} belongs to D1 Record ID ${keyMatchD1RecordId}, not ${expected.d1RecordId}.`,
    );
  }
  return keyMatch;
}

module.exports = {
  D1_WORKER_IDENTITY_SCHEMA,
  FRONTEND_IDENTITY_SCHEMA,
  assertFrontendIdentity,
  frontendIdentity,
  normalizeNotionId,
  selectRecoverableFrontend,
  workerIdentityFromD1,
};
