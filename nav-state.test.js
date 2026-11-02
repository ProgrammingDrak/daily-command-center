// Navigation state contract for the Tasks / Budget / Workouts & meals pages.
const test = require("node:test");
const assert = require("node:assert/strict");
const N = require("./public/js/nav-state.js");

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    dump: () => Object.fromEntries(map)
  };
}
const prefs = (baseView = "list", actual = false) => ({ baseView, actual });

test("explicit tasks URLs win and keep every other parameter", () => {
  const out = N.parse("?device=glasses&tab=tasks&view=calendar&actual=1&task=abc", null, prefs("list", false));
  assert.deepEqual(out.state, { page: "tasks", view: "calendar", actual: true });
  assert.equal(out.explicitActual, true);
  assert.equal(out.legacy, null);
  assert.equal(N.toSearch(out.state, "?device=glasses&task=abc&tl=xyz", { explicitActual: true }), "?device=glasses&task=abc&tl=xyz&tab=tasks&view=calendar&actual=1");
  assert.equal(N.toSearch(out.state, "?task=abc"), "?task=abc&tab=tasks&view=calendar", "a preference-derived Actual is not written");
});

test("tasks without a view opens the Working Queue; actual=0 overrides a saved preference", () => {
  assert.deepEqual(N.parse("?tab=tasks", null, prefs()).state, { page: "tasks", view: "queue", actual: false });
  const off = N.parse("?tab=tasks&view=list&actual=0", null, prefs("calendar", true));
  assert.deepEqual(off.state, { page: "tasks", view: "list", actual: false });
  assert.equal(off.explicitActual, true);
});

test("legacy panel links map onto Tasks views without losing the saved base view", () => {
  assert.deepEqual(N.parse("?tab=working-queue", null, prefs("calendar")).state, { page: "tasks", view: "queue", actual: false });
  const schedule = N.parse("?tab=schedule", null, prefs("calendar", true));
  assert.deepEqual(schedule.state, { page: "tasks", view: "calendar", actual: true });
  assert.equal(schedule.legacy.retired, false);
  assert.equal(schedule.canonical, false);
  const oldActual = N.parse("?tab=schedule&view=actual", null, prefs("calendar", false));
  assert.deepEqual(oldActual.state, { page: "tasks", view: "calendar", actual: true });
  assert.equal(oldActual.explicitActual, true);
});

test("retired pages land on the Working Queue with a labelled notice and no other change", () => {
  for (const [tab, label] of [["meeting-reviews", "Meeting Reviews"], ["pet-home", "Pet Home"], ["social", "Social"], ["vault", "Mycelium"]]) {
    const out = N.parse("?tab=" + tab + "&task=keep", null, prefs("calendar", true));
    assert.deepEqual(out.state, { page: "tasks", view: "queue", actual: true });
    assert.deepEqual(out.legacy, { from: tab, retired: true, label });
    assert.equal(N.toSearch(out.state, "?tab=" + tab + "&task=keep"), "?tab=tasks&task=keep&view=queue");
    assert.equal(N.isRetired(tab), true);
  }
  const unknown = N.parse("?tab=slots", null, prefs());
  assert.deepEqual(unknown.state, { page: "tasks", view: "queue", actual: false });
  assert.equal(unknown.legacy.retired, false);
});

test("history state is a fallback only, including the old dccTab shape", () => {
  assert.deepEqual(N.parse("", { dccNav: { page: "tasks", view: "calendar", actual: true } }, prefs()).state, { page: "tasks", view: "calendar", actual: true });
  assert.deepEqual(N.parse("", { dccTab: "schedule" }, prefs("calendar")).state.view, "calendar");
  assert.deepEqual(N.parse("?tab=budget", { dccNav: { page: "tasks", view: "list", actual: true } }, prefs()).state.page, "budget");
  assert.deepEqual(N.parse("", null, prefs()).state, { page: "tasks", view: "queue", actual: false });
});

test("budget and activity drop only nav keys; canonical URLs are recognised", () => {
  const s = { page: "budget", view: "list", actual: true };
  assert.equal(N.toSearch(s, "?tab=tasks&view=list&actual=1&date=2026-11-02"), "?tab=budget&date=2026-11-02");
  assert.equal(N.parse("?tab=activity", null, prefs()).canonical, true);
  assert.equal(N.parse("?tab=tasks&view=list", null, prefs()).canonical, true);
  assert.equal(N.parse("?tab=tasks&view=queue&actual=1", null, prefs()).canonical, true, "an explicit choice survives the queue view");
  assert.equal(N.parse("?tab=tasks&view=list&actual=0", null, prefs()).canonical, true, "explicit off is canonical, not dropped");
});

test("explicit Actual off survives canonicalization, reload, Back and a past-day default", () => {
  const first = N.parse("?tab=tasks&view=list&actual=0&date=2026-10-01&task=example", null, prefs("list", true));
  assert.deepEqual(first.state, { page: "tasks", view: "list", actual: false });
  assert.equal(first.explicitActual, true);
  const url = N.toSearch(first.state, "?tab=tasks&view=list&actual=0&date=2026-10-01&task=example", { explicitActual: first.explicitActual });
  assert.equal(url, "?tab=tasks&view=list&actual=0&date=2026-10-01&task=example");
  const history = { dccNav: first.state, dccActualExplicit: first.explicitActual };
  const reloaded = N.parse(url, history, prefs("list", true));
  assert.deepEqual(reloaded.state, first.state);
  assert.equal(reloaded.explicitActual, true);
  assert.deepEqual(N.withArchiveDefault(reloaded.state, { archive: true, explicitActual: reloaded.explicitActual }), first.state, "archive cannot re-enable an explicit off");
  // Without a choice the same past day still defaults on, and nothing is written.
  const plain = N.parse("?tab=tasks&view=list", null, prefs("list", false));
  assert.equal(plain.explicitActual, false);
  assert.equal(N.withArchiveDefault(plain.state, { archive: true, explicitActual: false }).actual, true);
  assert.equal(N.toSearch(plain.state, "?tab=tasks&view=list", { explicitActual: false }), "?tab=tasks&view=list");
});

test("Budget and Workouts & meals keep the Tasks workspace through history and reload", () => {
  // queue -> List -> Actual -> Calendar -> Budget: the Budget entry records the workspace.
  const workspace = { page: "budget", view: "calendar", actual: true };
  const entry = { dccNav: workspace, dccActualExplicit: true };
  const budget = N.parse("?tab=budget", entry, prefs("list", false));
  assert.deepEqual(budget.state, workspace);
  assert.equal(budget.explicitActual, true);
  assert.equal(N.toSearch(budget.state, "?tab=budget", { explicitActual: true }), "?tab=budget", "Budget's URL names only the page");
  // Forward to Budget, then Tasks: merging page keeps the remembered view.
  assert.deepEqual(Object.assign({}, budget.state, { page: "tasks" }), { page: "tasks", view: "calendar", actual: true });
  // An entry without saved nav falls back to the in-memory workspace.
  assert.deepEqual(N.parse("?tab=activity", null, prefs(), { page: "tasks", view: "list", actual: true }).state, { page: "activity", view: "list", actual: true });
  // An explicit task URL still wins over anything remembered.
  assert.deepEqual(N.parse("?tab=tasks&view=queue&actual=0", entry, prefs()).state, { page: "tasks", view: "queue", actual: false });
  // Explicit actual on a non-task URL overrides the remembered value.
  assert.equal(N.parse("?tab=budget&actual=0", entry, prefs()).state.actual, false);
});

test("a stored legacy actual view migrates once to List plus the toggle", () => {
  const storage = memoryStorage({ [N.VIEW_KEY]: "actual" });
  const first = N.readPrefs(storage);
  assert.deepEqual(first, { baseView: "list", actual: true, migrated: true });
  assert.deepEqual(storage.dump(), { [N.VIEW_KEY]: "list", [N.ACTUAL_KEY]: "1" });
  assert.deepEqual(N.readPrefs(storage), { baseView: "list", actual: true, migrated: false });
  const chosen = memoryStorage({ [N.VIEW_KEY]: "calendar", [N.ACTUAL_KEY]: "0" });
  assert.deepEqual(N.readPrefs(chosen), { baseView: "calendar", actual: false, migrated: false });
  const respectsOff = memoryStorage({ [N.VIEW_KEY]: "actual", [N.ACTUAL_KEY]: "0" });
  assert.deepEqual(N.readPrefs(respectsOff), { baseView: "list", actual: false, migrated: true });
  assert.deepEqual(N.readPrefs(memoryStorage({ [N.VIEW_KEY]: "actual" }), { write: false }).migrated, true);
});

test("preference writers ignore invalid views", () => {
  const storage = memoryStorage({ [N.VIEW_KEY]: "calendar" });
  N.saveBaseView(storage, "queue");
  N.saveBaseView(storage, "actual");
  assert.equal(storage.getItem(N.VIEW_KEY), "calendar");
  N.saveActual(storage, true);
  assert.equal(storage.getItem(N.ACTUAL_KEY), "1");
});

test("archive days default Actual on only when the person has not chosen", () => {
  const base = { page: "tasks", view: "calendar", actual: false };
  assert.deepEqual(N.withArchiveDefault(base, { archive: true, explicitActual: false }), { page: "tasks", view: "calendar", actual: true });
  assert.deepEqual(N.withArchiveDefault(base, { archive: true, explicitActual: true }), base);
  assert.deepEqual(N.withArchiveDefault(base, { archive: false }), base);
});

test("panels map to the existing tab contents", () => {
  assert.equal(N.panelFor({ page: "tasks", view: "queue" }), "working-queue");
  assert.equal(N.panelFor({ page: "tasks", view: "list" }), "schedule");
  assert.equal(N.panelFor({ page: "tasks", view: "calendar" }), "schedule");
  assert.equal(N.panelFor({ page: "budget" }), "budget");
  assert.equal(N.panelFor({ page: "activity" }), "activity");
  assert.equal(N.panelFor({ page: "social" }), "working-queue", "unknown pages normalise to Tasks");
});
