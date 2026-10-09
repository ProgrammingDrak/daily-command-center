const test = require("node:test");
const assert = require("node:assert/strict");
const createStore = require("./responsibility-store");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const today = "2026-10-13";
function rule() {
  return { version: 1, patternType: "calendar", timeZone: "America/New_York", startDate: today,
    frequency: "daily", interval: 1, times: ["06:25"], end: { type: "never" } };
}
function definition(properties = {}) {
  return { id: "commute-series", workspace_id: "owner-workspace", properties: {
    kind: "responsibility_item", repeatType: "scheduled", title: "Commute there",
    slug: "commute-there", estimatedMinutes: 20, status: "active", scheduleRule: rule(),
    defaultSubtasks: ["Complete outbound commute"], ...properties,
  } };
}
function fixture(properties = {}, occurrences = []) {
  const definitions = new Map([["commute-series", definition(properties)]]);
  const generated = structuredClone(occurrences);
  const batches = [];
  const creates = [];
  const dayRoots = new Map();
  const client = { transaction: true };
  const db = {
    async withRepeatSeriesLock(_id, _workspaceId, work) { return work(client); },
    async getResponsibilityBlocks() { return [...definitions.values()].filter(row => !row.deleted_at); },
    async getBlock(id) { return definitions.get(id) || dayRoots.get(id) || generated.find(row => row.id === id) || null; },
    async ensureDayRoot(date) {
      const id = `day-${date}`;
      if (!dayRoots.has(id)) dayRoots.set(id, { id, date, properties: { _subtasks: { unrelated: [{ id: "other-child", text: "Keep me", publicVisibility: "private" }] } } });
      return id;
    },
    async getBlocksByIdempotencyKeys(_workspaceId, keys) {
      return generated.filter(row => keys.includes(row.properties.idempotency_key));
    },
    async getRepeatSeriesBlocks(id) {
      return generated.filter(row => row.properties.repeatSeriesId === id && !row.deleted_at);
    },
    async createItineraryTasks(rows) {
      const saved = structuredClone(rows).map(row => ({ ...row, workspace_id: "owner-workspace" }));
      creates.push(saved); generated.push(...saved); return saved;
    },
    async createBlock(row) {
      const saved = { ...structuredClone(row), id: "new-definition" };
      definitions.set(saved.id, saved); return saved;
    },
    async findResponsibilityBySlug(slug) {
      return [...definitions.values()].find(row => row.properties.slug === slug) || null;
    },
    async updateBlock(id, changes) {
      const row = await db.getBlock(id);
      if (changes.properties) row.properties = structuredClone(changes.properties);
      if (changes.date) row.date = changes.date;
      return row;
    },
    async batchOp(ops, tx) {
      assert.equal(tx, client, "privacy changes remain inside the series lock transaction");
      batches.push(structuredClone(ops));
      const blocks = [];
      for (const op of ops) {
        if (op.op === "update") blocks.push(await db.updateBlock(op.id, op));
        else if (op.op === "delete") {
          const row = await db.getBlock(op.id); row.deleted_at = "2026-10-13T12:00:00Z"; blocks.push(row);
        } else if (op.op === "create") {
          const row = { ...structuredClone(op), workspace_id: "owner-workspace" };
          definitions.set(row.id, row); blocks.push(row);
        }
      }
      return { blocks };
    },
  };
  const store = createStore({ blockDB: db, getScheduleBlocks: async () => [],
    getTodayStr: () => today, assertBlockOwnership() {}, appTimeZone: "America/New_York" });
  return { store, db, generated, definitions, batches, creates, dayRoots };
}
function materialize(f, date = today) {
  return f.store.materializeScheduledRepeatsForDate({ date, workspaceId: "owner-workspace", userId: "owner" });
}
function allVisibility(rows, expected) {
  assert.ok(rows.length > 0);
  assert.deepEqual(rows.map(row => row.properties.publicVisibility), rows.map(() => expected));
}
function occurrence(id, date, properties = {}) {
  const rootId = properties.repeatOccurrenceRootId || id;
  return { id, workspace_id: "owner-workspace", date, properties: {
    kind: "scheduled_repeat_task", type: "task", title: "Commute there", duration: 20,
    start: "06:25", end: "06:45", status: "open", local_id: id,
    repeatSeriesId: "commute-series", repeatOccurrenceRootId: rootId,
    repeatOccurrenceKey: `${date}T06:25`, repeatOccurrenceInstant: `${date}T10:25:00.000Z`,
    repeatTimeZone: "America/New_York", idempotency_key: rootId === id ? `repeat:commute-series:${date}T06:25` : null,
    ...properties,
  } };
}

for (const visibility of ["private", "public"]) {
  test(`ordinary scheduled roots and checklist children inherit explicit ${visibility} sharing`, async () => {
    const f = fixture({ publicVisibility: visibility });
    allVisibility(await materialize(f), visibility);
    assert.equal(f.generated.length, 2, "one root and one default checklist child");
    const ids = f.generated.map(row => row.id);
    assert.deepEqual(await materialize(f), [], "retry does not duplicate the occurrence");
    assert.deepEqual(f.generated.map(row => row.id), ids);
    allVisibility(f.generated, visibility);
  });
  test(`promoted template anchors, steps and nested children inherit ${visibility}`, async () => {
    const f = fixture({ publicVisibility: visibility, templateTree: { version: 1, root: {
      title: "Travel routine", type: "shell", children: [
        { title: "Pack bag", edge: "wrap", durationMin: 5, children: [
          { title: "Pack shoes", edge: "subtask", durationMin: 1 },
        ] },
        { title: "Travel", edge: "wrap", durationMin: 20 },
      ],
    } } });
    const rows = await materialize(f);
    assert.equal(rows.length, 4);
    allVisibility(rows, visibility);
    assert.equal(rows[0].properties.occurrenceAnchor, true);
    assert.ok(rows.some(row => row.properties.subtaskOf), "nested children are included");
  });
  test(`readiness task builder inherits explicit ${visibility}`, () => {
    const result = createStore.buildResponsibilityTaskProps(definition({ repeatType: "readiness", publicVisibility: visibility }),
      { duration: 20, slot: 385, localId: "readiness-instance", sourceProps: {} });
    assert.equal(result.publicVisibility, visibility);
  });
  test(`readiness checklist storage inherits ${visibility} without rewriting unrelated children`, async () => {
    const f = fixture({ publicVisibility: visibility, repeatType: "readiness" });
    await f.store.attachDefaultSubtasks("travel-local-id", f.definitions.get("commute-series").properties, {}, today, "owner", "owner-workspace");
    const subtasks = f.dayRoots.get(`day-${today}`).properties._subtasks;
    assert.equal(subtasks["travel-local-id"].length, 1);
    assert.equal(subtasks["travel-local-id"][0].publicVisibility, visibility);
    assert.deepEqual(subtasks.unrelated, [{ id: "other-child", text: "Keep me", publicVisibility: "private" }]);
  });
}

test("legacy ordinary definitions without visibility preserve their historical public default", async () => {
  const f = fixture();
  allVisibility(await materialize(f), "public");
  assert.equal(createStore.buildResponsibilityTaskProps(definition({ repeatType: "readiness" }),
    { duration: 20, slot: 385, localId: "readiness-instance", sourceProps: {} }).publicVisibility, "public");
});

test("new personal definitions save explicit private sharing, while explicit public remains public", async () => {
  for (const properties of [{ domain: "personal" }, { domain: "health" }, { domain: "personal", publicVisibility: "public" }]) {
    const f = fixture();
    const saved = await f.store.upsertResponsibility({ workspaceId: "owner-workspace", userId: "owner",
      properties: { title: "New travel", slug: "new-travel", repeatType: "scheduled", scheduleRule: rule(), ...properties } });
    assert.equal(saved.properties.publicVisibility, properties.publicVisibility || "private");
  }
});

test("editing a legacy personal definition does not silently change its public default", async () => {
  const f = fixture({ domain: "personal" });
  const saved = await f.store.upsertResponsibility({ workspaceId: "owner-workspace", userId: "owner",
    properties: { title: "Travel renamed", slug: "commute-there", domain: "personal", repeatType: "scheduled", scheduleRule: rule() } });
  assert.equal(saved.id, "commute-series");
  assert.notEqual(saved.properties.publicVisibility, "private");
  allVisibility(await materialize(f), "public");
});

test("invalid ordinary visibility is rejected without saving a definition", async () => {
  const f = fixture();
  await assert.rejects(f.store.upsertResponsibility({ workspaceId: "owner-workspace", userId: "owner",
    properties: { title: "Bad sharing", slug: "bad-sharing", repeatType: "scheduled", scheduleRule: rule(), publicVisibility: "everyone" } }), /visibility/i);
  assert.equal(f.definitions.size, 1);
  assert.equal(f.generated.length, 0);
});

for (const activityTaskType of ["workout", "meal"]) {
  test(`${activityTaskType} repeats remain private even with an explicit public input`, async () => {
    const f = fixture({ activityTaskType, publicVisibility: "public" });
    allVisibility(await materialize(f), "private");
    assert.equal(f.generated[0].properties.type, activityTaskType);
    const ready = createStore.buildResponsibilityTaskProps(definition({ activityTaskType, publicVisibility: "public" }),
      { duration: 20, slot: 385, localId: "readiness-instance", sourceProps: {} });
    assert.equal(ready.publicVisibility, "private");
  });
}

test("restricting an open series keeps row IDs, itinerary placement, pause state and completed history", async () => {
  const root = occurrence("root-open", today, { publicVisibility: "public" });
  const child = occurrence("child-open", today, { publicVisibility: "public", repeatOccurrenceRootId: root.id,
    duration: 0, end: "06:25", subtaskOf: root.id });
  const completed = occurrence("root-completed", "2026-10-14", { publicVisibility: "public", status: "done", completedAt: "2026-10-14T11:00:00Z" });
  const f = fixture({ publicVisibility: "public", pausedUntil: "forever" }, [root, child, completed]);
  const baseline = structuredClone(f.generated);
  await f.store.changeScheduledSeries({ id: "commute-series", workspaceId: "owner-workspace", action: "update", scope: "series",
    changes: { publicVisibility: "private" } });
  assert.equal(f.definitions.get("commute-series").properties.publicVisibility, "private");
  assert.equal(f.definitions.get("commute-series").properties.pausedUntil, "forever");
  allVisibility(f.generated.slice(0, 2), "private");
  for (let i = 0; i < 2; i++) {
    const before = baseline[i], after = f.generated[i];
    for (const key of ["id", "date", "deleted_at"]) assert.equal(after[key], before[key]);
    for (const key of ["start", "end", "duration", "local_id", "repeatOccurrenceKey", "repeatOccurrenceRootId", "subtaskOf"])
      assert.equal(after.properties[key], before.properties[key], `${key} must remain stable`);
  }
  assert.deepEqual(f.generated[2], baseline[2], "completed history is unchanged");
  assert.ok(f.batches.flat().every(op => op.op === "update"), "restriction does not delete or replace records");
  assert.deepEqual(await materialize(f, "2026-10-16"), [], "privacy edit does not resume a paused repeat");
});

test("ordinary title edits never reshare an independently private occurrence or its child", async () => {
  const root = occurrence("independent-root", today, { publicVisibility: "private" });
  const child = occurrence("independent-child", today, { publicVisibility: "private", repeatOccurrenceRootId: root.id, duration: 0, end: "06:25" });
  const f = fixture({ publicVisibility: "public" }, [root, child]);
  await f.store.changeScheduledSeries({ id: "commute-series", workspaceId: "owner-workspace", action: "update", scope: "series",
    changes: { title: "Outbound journey" } });
  allVisibility(f.generated.filter(row => [root.id, child.id].includes(row.id)), "private");
  assert.equal(f.generated.find(row => row.id === root.id).properties.title, "Outbound journey");
});

test("following-series title edits retain independently private sharing on replacement occurrences", async () => {
  const date = "2026-10-16";
  const root = occurrence("following-private-root", date, { publicVisibility: "private" });
  const child = occurrence("following-private-child", date, { publicVisibility: "private", repeatOccurrenceRootId: root.id, duration: 0, end: "06:25" });
  const f = fixture({ publicVisibility: "public" }, [root, child]);
  const result = await f.store.changeScheduledSeries({ id: "commute-series", workspaceId: "owner-workspace", action: "update", scope: "following",
    occurrenceKey: `${date}T06:25`, changes: { title: "Travel renamed" } });
  const replacements = f.generated.filter(row => !row.deleted_at && row.properties.repeatOccurrenceKey === `${date}T06:25`);
  assert.equal(replacements.length, 2);
  allVisibility(replacements, "private");
  assert.equal(replacements[0].properties.title, "Travel renamed");
  assert.equal(f.definitions.get(result.newDefinitionId).properties.publicVisibility, "public", "an occurrence restriction must not rewrite the owner's explicitly public series setting");
});

test("a private series restriction also protects independently moved occurrence overrides", async () => {
  const root = occurrence("moved-root", today, { recurrenceOverride: true, publicVisibility: "public", start: "08:00", end: "08:20" });
  const child = occurrence("moved-child", today, { repeatOccurrenceRootId: root.id, publicVisibility: "public", start: "08:00", end: "08:00", duration: 0 });
  const f = fixture({ publicVisibility: "public" }, [root, child]);
  await f.store.changeScheduledSeries({ id: "commute-series", workspaceId: "owner-workspace", action: "update", scope: "series",
    changes: { publicVisibility: "private" } });
  allVisibility(f.generated, "private");
  assert.equal(f.generated[0].properties.start, "08:00");
  assert.equal(f.generated[0].properties.end, "08:20");
  assert.equal(f.generated[0].properties.recurrenceOverride, true);
});

test("pause retains existing private records; resuming a fixed private definition generates only private tasks", async () => {
  const f = fixture({ publicVisibility: "private" });
  await materialize(f);
  const baseline = structuredClone(f.generated);
  await f.store.pauseResponsibility("commute-series", "owner-workspace", { existing: f.definitions.get("commute-series") });
  assert.equal(f.definitions.get("commute-series").properties.pausedUntil, "forever");
  assert.deepEqual(f.generated, baseline);
  assert.deepEqual(await materialize(f, "2026-10-16"), []);
  await f.store.resumeResponsibility("commute-series", "owner-workspace", { existing: f.definitions.get("commute-series") });
  allVisibility(await materialize(f, "2026-10-16"), "private");
  assert.deepEqual(f.generated.slice(0, baseline.length), baseline);
});

// Exercise the public browser entry points and the actual bound Save handler.
// Only form fields are modeled: rendering, schedule writes and HTTP requests
// remain observable boundaries rather than copies of the client implementation.
async function browserFixture(items = []) {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const elements = new Map();
  const listeners = new Map();
  function element(id) {
    const handlers = new Map();
    return { id, value: "", style: {}, dataset: {}, disabled: false,
      classList: { add() {}, remove() {} }, focus() {}, querySelectorAll() { return []; },
      addEventListener(type, callback) { handlers.set(type, callback); },
      async click() { return handlers.get("click")?.({ target: this }); },
      async change(value) { this.value=value;return handlers.get("change")?.({target:this}); },
    };
  }
  for (const match of html.matchAll(/id="((?:resp-|repeat-occurrence-|responsibility-modal-overlay)[^"]*)"/g)) {
    if (match[1] !== "resp-default-subtasks-list") elements.set(match[1], element(match[1]));
  }
  const document = {
    getElementById(id) { return elements.get(id) || null; },
    querySelectorAll() { return []; }, querySelector() { return null; },
    addEventListener(type, callback) { listeners.set(type, callback); },
  };
  const requests = [], children = [], pickerCalls = [], notices = [];
  const DCC = { esc: value => String(value ?? ""), TaskModel: { selectNotDeleted: rows => rows || [], selectOpen: rows => rows || [] } };
  const window = { DCC, urgency: { DUE_THRESHOLD: 75 }, DCC_APP_TIME_ZONE: "America/New_York" };
  const context = { window, DCC, document, scheduled: [], console, Intl, Date, Math, JSON,
    encodeURIComponent, setTimeout() { return 1; }, clearTimeout() {},
    showToast(message) { notices.push(message); },
    openSchedulePicker(title, duration, options) { pickerCalls.push({ title, duration, options }); },
    addSubtask(id, title, placement) { children.push({ id, title, placement }); return { _persisted: Promise.resolve() }; },
    fetch: async (url, options) => {
      requests.push({ url, method: options?.method || "GET", body: options?.body ? JSON.parse(options.body) : null });
      return { ok: true, json: async () => ({ items }) };
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "public/js/responsibilities.js"), "utf8"), context);
  listeners.get("DOMContentLoaded")();
  await window.loadResponsibilities();
  return { window, elements, requests, children, pickerCalls, notices, html };
}

for (const publicVisibility of ["private", "public"]) {
  test(`task-to-repeat form saves source ${publicVisibility} sharing explicitly`, async () => {
    const b = await browserFixture();
    assert.match(b.html, /<select[^>]+id="resp-public-visibility"[^>]*>[\s\S]*?<option value="private">[\s\S]*?<option value="public">/);
    b.window.openRepeatResponsibilityFromTask({ id: "source-travel", title: "Travel", type: "task", duration: 20, publicVisibility });
    assert.equal(b.elements.get("resp-public-visibility").value, publicVisibility);
    await b.elements.get("resp-save").click();
    const save = b.requests.find(request => request.method === "POST" && request.url === "/api/responsibilities");
    assert.ok(save, b.notices.join("\n"));
    assert.equal(save.body.properties.publicVisibility, publicVisibility);
    assert.equal(save.body.properties.estimatedMinutes, 20);
  });

  test(`client scheduling passes ${publicVisibility} to the parent and future checklist children`, async () => {
    const b = await browserFixture([definition({ publicVisibility, repeatType: "readiness" })]);
    b.window.scheduleRepeatResponsibility("commute-series");
    assert.equal(b.pickerCalls.length, 1);
    assert.equal(b.pickerCalls[0].options.publicVisibility, publicVisibility);
    await b.pickerCalls[0].options.onScheduled({ localId: "future-travel", dateStr: "2026-10-16", start: "06:25", persisted: Promise.resolve() });
    assert.equal(b.children.length, 1);
    assert.equal(b.children[0].placement.publicVisibility, publicVisibility);
    assert.equal(b.children[0].placement.date, "2026-10-16");
    assert.equal(b.children[0].placement.parentStart, "06:25");
  });
}

test("editing a paused private repeat round-trips sharing without resuming or changing status", async () => {
  const b = await browserFixture([definition({ publicVisibility: "private", pausedUntil: "forever", status: "archived" })]);
  await b.window.openScheduledOccurrenceActions({ title: "Travel", repeatMode: "scheduled", repeatSeriesId: "commute-series",
    repeatOccurrenceKey: `${today}T06:25`, repeatOccurrenceRootId: "travel-root", duration: 20 });
  b.elements.get("repeat-occurrence-scope").value = "series";
  await b.elements.get("repeat-occurrence-edit").click();
  assert.equal(b.elements.get("resp-public-visibility").value, "private");
  b.elements.get("resp-title").value = "Travel renamed";
  await b.elements.get("resp-save").click();
  const save = b.requests.find(request => request.method === "PATCH");
  assert.ok(save, b.notices.join("\n"));
  assert.equal(save.body.properties.publicVisibility, "private");
  assert.equal(save.body.properties.status, "archived");
  assert.ok(!b.requests.some(request => /\/resume$/.test(request.url)));
});

test("workout source sharing is private and cannot be changed to public in the repeat editor", async () => {
  const b = await browserFixture();
  b.window.openRepeatResponsibilityFromTask({ id: "workout-source", _blockId: "workout-server-id", title: "Strength Training", type: "workout", publicVisibility: "public" });
  assert.equal(b.elements.get("resp-public-visibility").value, "private");
  assert.equal(b.elements.get("resp-public-visibility").disabled, true);
  await b.elements.get("resp-save").click();
  const save = b.requests.find(request => request.method === "POST");
  assert.ok(save, b.notices.join("\n"));
  assert.equal(save.body.properties.publicVisibility, "private");
  assert.equal(save.body.properties.activityPlanSourceId, "workout-server-id");
});

for (const domain of ["personal","health"]) test(`new repeat domain ${domain} defaults private until sharing is explicitly selected`, async () => {
  const b=await browserFixture();b.window.openResponsibilityModalWithMenus([]);
  b.elements.get("resp-title").value="Private repeat";
  await b.elements.get("resp-domain").change(domain);
  assert.equal(b.elements.get("resp-public-visibility").value,"private");
  await b.elements.get("resp-save").click();
  assert.equal(b.requests.find(r=>r.method==="POST").body.properties.publicVisibility,"private");
  b.window.openResponsibilityModalWithMenus([]);
  await b.elements.get("resp-public-visibility").change("public");
  await b.elements.get("resp-domain").change(domain);
  assert.equal(b.elements.get("resp-public-visibility").value,"public");
});
