"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  WORK_TYPE_OPTIONS,
  workerStandortNames,
  workerStandortOptions,
} = require("../scripts/worker-standort-options");

process.env.D1_DATA_SOURCE_ID = "test-d1";
process.env.D8_DATA_SOURCE_ID = "test-d8";
process.env.EMPLOYEE_FRONTENDS_DATA_SOURCE_ID = "test-frontends";

const {
  annualVacationValue,
  dayDatabaseProperties,
  ensureManualOnboardingChecklist,
  executionMode,
  frontendProperties,
  hasAnnualVacationValue,
  manualOnboardingChecklistBlocks,
} = require("../scripts/onboard-workers");

test("Standort combines active sites and the former day-type choices once", () => {
  assert.deepEqual(workerStandortNames(["Berlin", "Urlaub", "Berlin"]), [
    "Berlin",
    "Teil-Tag",
    "Urlaub",
    "Sonderurlaub",
    "Überstundenausgleich",
    "Feiertag",
    "Krank",
  ]);

  const options = workerStandortOptions(["Berlin"]);
  assert.deepEqual(options.find((option) => option.name === "Berlin"), { name: "Berlin", color: "blue" });
  assert.deepEqual(options.find((option) => option.name === "Teil-Tag"), { name: "Teil-Tag", color: "gray" });
  assert.ok(WORK_TYPE_OPTIONS.every((option) => option.color === "gray"));
  assert.equal(options.length, WORK_TYPE_OPTIONS.length + 1);
});

test("onboarding workflow modes keep preflight separate from provisioning", () => {
  assert.equal(executionMode([]), "full");
  assert.equal(executionMode(["--validate-only"]), "validate");
  assert.equal(executionMode(["--provision-only"]), "provision");
  assert.throws(
    () => executionMode(["--validate-only", "--provision-only"]),
    /at most one/,
  );
});

test("annual vacation must be entered manually as a non-negative number before onboarding", () => {
  assert.equal(
    annualVacationValue({ id: "worker-1", properties: { Jahresurlaub: { number: 30 } } }),
    30,
  );
  assert.equal(
    annualVacationValue({ id: "worker-2", properties: { Jahresurlaub: { number: 0 } } }),
    0,
  );
  assert.throws(
    () => annualVacationValue({ id: "worker-3", properties: { Jahresurlaub: { number: null } } }),
    /manually entered Jahresurlaub/,
  );
  assert.throws(
    () => annualVacationValue({ id: "worker-4", properties: { Jahresurlaub: { number: -1 } } }),
    /invalid Jahresurlaub/,
  );
  assert.equal(
    hasAnnualVacationValue({ id: "worker-5", properties: { Jahresurlaub: { number: 0 } } }),
    true,
  );
  assert.equal(
    hasAnnualVacationValue({ id: "worker-6", properties: { Jahresurlaub: { number: null } } }),
    false,
  );
});

test("new worker D3/D4 schemas use one Standort select and no Tagtyp property", () => {
  const d3 = dayDatabaseProperties(["Berlin"]);
  const d4 = dayDatabaseProperties(["Berlin"], true);

  assert.equal("Tagtyp" in d3, false);
  assert.equal("Tagtyp" in d4, false);
  assert.deepEqual(
    d3.Standort.select.options.map((option) => option.name),
    ["Berlin", ...WORK_TYPE_OPTIONS.map((option) => option.name)],
  );
  assert.ok(d4["Sync Key"]);
  assert.ok(d4.Monat);
});

test("new worker frontends put the exact four-section manual checklist in a callout", () => {
  const properties = frontendProperties("Tea Smea", "tea@example.com", "wrk_1", "d1_1", 30);
  assert.deepEqual(properties.Email, { email: "tea@example.com" });
  assert.deepEqual(properties.Jahresurlaub, { number: 30 });
  assert.equal(properties["Worker Key"].rich_text[0].text.content, "wrk_1");

  const checklist = manualOnboardingChecklistBlocks();
  assert.equal(checklist.length, 1);
  const callout = checklist[0];
  assert.equal(callout.type, "callout");
  assert.deepEqual(callout.callout.rich_text, []);
  assert.deepEqual(callout.callout.icon, { type: "emoji", emoji: "☑️" });
  assert.equal(callout.callout.color, "gray_background");
  const sections = callout.callout.children;
  const blockText = (block) => block[block.type].rich_text.map((item) => item.text.content).join("");
  assert.deepEqual(sections.map(blockText), [
    "Aktueller Monat:", "Urlaub KPI:", "Archiv:", "Berechtigungen:",
  ]);
  assert.deepEqual(sections.map((section) => section.bulleted_list_item.children.map(blockText)), [
    [
      "Vorlage Teil-Tag anlegen und Datum auf das aktuelle Datum setzen.",
      "Spalten: Wochentag, Datum, Stunden, verengen.",
      "Spalten Icons ändern",
      "Sperren.",
    ],
    [
      "Chart Title umbenennen in: Genommene Urlaubstage bis Ende letzten Monats.",
      "Titel ausblenden.",
      "DB sperren.",
    ],
    ["Spalten: Wochentag, Datum, Stunden, verengen.", "Spalten Icons ändern", "Sperren."],
    [
      "Diese Frontend-Seite an die oben angezeigte E-Mail einladen: Can view.",
      "Archiv an dieselbe E-Mail einladen: Can view.",
      "Aktueller Monat an dieselbe E-Mail einladen: Can edit content.",
    ],
  ]);
  const items = sections.flatMap((section) => section.bulleted_list_item.children);
  assert.equal(items.length, 13);
  assert.ok(items.every((block) => block.type === "to_do" && block.to_do.checked === false));
  assert.deepEqual(
    sections[1].bulleted_list_item.children[0].to_do.rich_text
      .filter((item) => item.annotations?.bold).map((item) => item.text.content),
    ["Genommene Urlaubstage bis Ende letzten Monats."],
  );
  assert.deepEqual(
    sections[3].bulleted_list_item.children.flatMap((block) =>
      block.to_do.rich_text.filter((item) => item.annotations?.bold).map((item) => item.text.content)),
    ["Can view", "Can view", "Can edit content"],
  );
});

function checklistFixture(initialBlocks = []) {
  const children = new Map([["frontend", []]]);
  let nextId = 0;
  let appends = 0;
  function add(parentId, block) {
    const id = block.id || `block-${++nextId}`;
    const copy = structuredClone(block);
    const nested = copy[copy.type].children || [];
    delete copy[copy.type].children;
    copy.id = id;
    children.get(parentId).push(copy);
    children.set(id, []);
    for (const child of nested) add(id, child);
    return copy;
  }
  for (const block of initialBlocks) add("frontend", block);
  return {
    children,
    get appends() { return appends; },
    operations: {
      listAllBlockChildren: async (id) => structuredClone(children.get(id) || []),
      appendBlockChildren: async (id, blocks) => {
        appends += 1;
        return blocks.map((block) => add(id, block));
      },
    },
  };
}

test("checklist provisioning recovers a partial callout without duplicating sections or to-dos", async () => {
  const fixture = checklistFixture();
  let interrupted = false;
  const operations = {
    ...fixture.operations,
    appendBlockChildren: async (...args) => {
      const result = await fixture.operations.appendBlockChildren(...args);
      if (!interrupted && fixture.appends === 2) {
        interrupted = true;
        throw new Error("append succeeded but response was lost");
      }
      return result;
    },
  };
  await assert.rejects(
    ensureManualOnboardingChecklist("frontend", operations),
    /response was lost/,
  );
  const calloutId = await ensureManualOnboardingChecklist("frontend", fixture.operations);
  assert.equal(fixture.children.get("frontend").length, 1);
  assert.equal(fixture.children.get(calloutId).length, 4);
  assert.deepEqual(
    fixture.children.get(calloutId).map((section) => fixture.children.get(section.id).length),
    [4, 3, 3, 3],
  );
  const writesBeforeRetry = fixture.appends;
  assert.equal(await ensureManualOnboardingChecklist("frontend", fixture.operations), calloutId);
  assert.equal(fixture.appends, writesBeforeRetry);
});

test("old flat checklist is preserved for manual review rather than silently duplicated", async () => {
  const fixture = checklistFixture([{
    type: "to_do",
    to_do: {
      rich_text: [{ type: "text", text: { content: "Archiv sperren." } }],
      checked: true,
    },
  }]);
  await assert.rejects(
    ensureManualOnboardingChecklist("frontend", fixture.operations),
    /earlier flat setup checklist/,
  );
  assert.equal(fixture.appends, 0);
  assert.equal(fixture.children.get("frontend")[0].to_do.checked, true);
});
