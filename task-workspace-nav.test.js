// Task workspace navigation: markup contract, retired routes, and the real
// DCC.nav controller from tabs.js running against a small DOM stand-in.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");
const html = read("index.html");
const NavState = require("./public/js/nav-state.js");
const ActualProjection = require("./public/js/actual-projection.js");

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, "markers found: " + startMarker);
  return source.slice(start, end);
}

// ── Markup and wiring contracts ──

test("touched browser scripts parse", () => {
  for (const file of ["nav-state.js", "actual-projection.js", "tabs.js", "shell.js", "schedule-tab.js", "itinerary-calendar.js",
    "working-queue.js", "mobile-shell.js", "persistence.js", "day-review.js", "features.js", "meeting-reviews.js", "social.js",
    "vault-tab.js", "vault-search.js", "device-views/glasses.js", "onboarding-tour.js", "responsibilities.js"]) {
    assert.doesNotThrow(() => new vm.Script(read("public/js/" + file), { filename: file }), file);
  }
});

test("the header is pages plus one clock, cog and sync dot cluster; branding is visually hidden", () => {
  const header = slice(html, '<header class="header dcc-topbar"', "</header>");
  assert.match(header, /<h1 class="dcc-visually-hidden">Daily Command Center<\/h1>/);
  assert.doesNotMatch(header, /powered by The Most Clever Assistant/);
  const pages = [...header.matchAll(/data-page="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(pages, ["tasks", "budget", "activity"]);
  const cluster = header.slice(header.indexOf('class="dcc-cluster"'));
  assert.ok(cluster.indexOf('id="clock"') < cluster.indexOf('id="dcc-settings-button"'));
  assert.ok(cluster.indexOf('id="dcc-settings-button"') < cluster.indexOf('id="save-status"'));
  assert.match(cluster, /id="dcc-settings-button"[^>]*aria-label="Settings and utilities"/);
  assert.match(cluster, /id="save-status"[^>]*aria-describedby="save-status-tooltip"/);
  assert.match(cluster, /id="save-status-tooltip" role="tooltip"/);
  assert.match(cluster, /id="save-status-live" role="status" aria-live="polite"/);
  for (const id of ["dcc-review-tomorrow", "dcc-day-start", "dcc-schedule-defaults", "dcc-setup-integrations", "dcc-replay-tutorial", "dcc-sign-out", "todo-share-open", "todo-reactions-toggle", "sn-open-btn"]) {
    assert.match(cluster, new RegExp('id="' + id + '"'), "utility kept: " + id);
  }
  assert.equal((html.match(/id="save-status"/g) || []).length, 1, "one sync control");
});

test("Tasks head orders views, the date row with queues, then Day Progress", () => {
  const head = slice(html, '<section class="task-workspace-head"', "</section>\n");
  const order = ["task-view-switch", "task-actual-toggle", "date-nav", "dn-prev", "date-label", "dn-next", "queue-pill", "date-picker-drop", "day-progress-title"].map((id) => head.indexOf('id="' + id + '"'));
  assert.ok(order.every((at) => at >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  for (const door of ["triage-pill-nav", "waiting-pill-nav", "unscheduled-pill-nav", "whenever-pill-nav", "loose-ends-pill"]) assert.match(head, new RegExp('id="' + door + '"'));
  assert.match(head, /role="tablist" aria-label="Task views"/);
  assert.match(head, /data-task-view="queue"[^>]*aria-controls="tab-working-queue"/);
  assert.match(head, /id="task-view-list"[^>]*data-task-view="list"[^>]*>Itinerary<\/button>/);
  assert.match(head, /id="task-actual-toggle" aria-pressed="false"[^>]*hidden>Actual</);
});

test("Actual is not a view: no Actual view button, Itinerary and Calendar keep their containers", () => {
  assert.doesNotMatch(html, /class="svt-btn[^"]*" data-view="actual"/);
  assert.doesNotMatch(html, /id="sched-view-toggle"/);
  const schedule = slice(html, 'id="tab-schedule"', "<!-- Anytime dock");
  for (const id of ["actual-summary", "actual-view", "list-view", "calendar-view"]) assert.match(schedule, new RegExp('id="' + id + '"'));
  const tab = read("public/js/schedule-tab.js");
  assert.doesNotMatch(tab, /schedView\s*=\s*["']actual["']/);
  assert.doesNotMatch(read("public/js/persistence.js"), /"actual"\s*:\s*\(/);
  assert.match(read("public/js/features.js"), /actualView:[^\n]*DCC\.nav\.reviewOpen\(\)/);
});

test("retired pages have no visible route from the top bar, mobile, tutorial or shortcuts", () => {
  for (const name of ["meeting-reviews", "pet-home", "social", "vault"]) {
    assert.doesNotMatch(html, new RegExp('data-tab="' + name + '"'), name);
    assert.match(html, new RegExp('id="tab-' + name + '"'), "panel kept for records: " + name);
  }
  assert.doesNotMatch(html, /data-social-open-pet/);
  const mobile = read("public/js/mobile-shell.js");
  assert.doesNotMatch(mobile, /tab:"pet-home"|tab:"delegated"|tab:"social"|tab:"vault"/);
  assert.doesNotMatch(read("public/js/onboarding-tour.js"), /Pet Home|Slots support/);
  assert.match(read("public/js/vault-search.js"), /DCC\.nav\.isRetired\("vault"\)\) return;\n\s*if \(\(e\.metaKey/);
  assert.match(read("public/js/vault-tab.js"), /if \(!vaultRetired\(\)\) loadOntology\(\)/);
  assert.match(read("public/js/meeting-reviews.js"), /isRetired\("meeting-reviews"\)\) return;\n\s*window\.addEventListener\("online", refresh\)/);
  assert.match(read("public/js/social.js"), /isRetired\?\.\("social"\)\) return;\n\s*\/\/ Silent on failure/);
  // Pet Home still loads: the courier, nudges and task awards read it.
  assert.match(read("public/js/pet-home.js"), /load\(\)\.then\(renderPetHome\)/);
  assert.match(html, /<script src="\/public\/js\/pet-courier\.js"><\/script>/);
});

test("glasses keeps a visible Full app exit and task navigation", () => {
  const glasses = read("public/js/device-views/glasses.js");
  assert.doesNotMatch(glasses, /\.header h1'\)\?\.append\(exit\)/);
  assert.match(glasses, /bar\.append\(prev, position, next, tools, exit, status\)/);
  const css = read("public/css/device-views/glasses.css");
  assert.match(css, /\.device-glasses \.glasses-exit\{display:inline-flex;[^}]*min-height:46px/);
  assert.match(css, /:not\(\.glasses-tools-open\) :is\(#tab-bar,\.source-row,\.header>div:last-child,#task-view-bar,#actual-summary\)/);
});

test("phones keep the clock, cog and dot, and show every page label whole", () => {
  const css = read("public/css/task-workspace.css");
  const phone = css.slice(css.indexOf("@media (max-width: 760px)"));
  assert.match(phone, /\.dcc-cluster \.time-now \{ display: flex !important;/);
  assert.match(phone, /\.header\.dcc-topbar > \.dcc-cluster \{ order: 1; display: flex !important; position: relative; inset: auto; width: 100%; \}/);
  assert.match(phone, /\.header\.dcc-topbar > \.dcc-pages \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);[^}]*overflow: visible;/, "no clipped Workouts & meals");
  assert.match(phone, /\.dcc-pages \.tab \{[^}]*min-height: var\(--target-min\);[^}]*white-space: normal;/);
  // The old fixed top-right badge must not leak offsets into the cluster.
  const desktop = css.slice(0, css.indexOf("@media (max-width: 760px)"));
  assert.match(desktop, /\.dcc-cluster \.save-status \{[^}]*position: relative;\s*inset: auto;[^}]*width: var\(--target-min\);[^}]*height: var\(--target-min\);/);
  assert.match(desktop, /\.dcc-cluster \.dcc-settings-button \{[^}]*width: var\(--target-min\);[^}]*height: var\(--target-min\) !important;/);
  assert.match(read("public/css/dashboard.css"), /\.save-status\{\s*position:fixed;top:12px;right:12px;/, "the legacy rule this reset targets still exists");
  assert.doesNotMatch(read("public/css/dashboard.css"), /\.header>div:last-child\{display:none!important\}/);
  assert.doesNotMatch(read("public/css/ui-optimization.css"), /\.header > div:last-child > :not\(#save-status\) \{ display: none/);
});

test("new controls meet the 44px target and the tooltip can be hovered and dismissed", () => {
  const css = read("public/css/task-workspace.css");
  const rule = (selector) => {
    const at = css.indexOf(selector + " {");
    assert.ok(at >= 0, selector);
    return css.slice(at, css.indexOf("}", at));
  };
  for (const selector of [".dcc-pages .tab", ".task-view-switch [role=\"tab\"]", ".task-actual-toggle", ".actual-summary-actions button"]) {
    assert.match(rule(selector), /min-height: var\(--target-min\)/, selector);
  }
  assert.doesNotMatch(css, /min-height: (3\d|40)px/, "no sub-44 minimums left in the new stylesheet");
  assert.match(rule(".it-actual-edit::after"), /height: var\(--target-min\)/, "compact chip, full hit area");
  assert.match(css, /\.save-status:hover \.save-status-tooltip \{ opacity: 1; visibility: visible; pointer-events: auto; \}/);
  assert.match(css, /\.save-status:focus-visible \.save-status-tooltip \{ opacity: 1; visibility: visible; pointer-events: auto; \}/);
  assert.match(rule(".dcc-cluster .save-status-tooltip::before"), /bottom: 100%;[\s\S]*height: 8px/, "bridge over the gap");
  assert.match(css, /\.save-status:is\(\.tooltip-dismissed, \[aria-expanded="true"\]\) \.save-status-tooltip \{ opacity: 0; visibility: hidden; \}/);
  assert.match(read("public/js/shell.js"), /document\.activeElement === button \|\| button\.matches\(":hover"\)\) button\.classList\.add\("tooltip-dismissed"\)/);
});

// ── The real controller ──

function element(tag, attrs = {}) {
  const listeners = {};
  const attributes = new Map(Object.entries(attrs));
  const classes = new Set(String(attrs.class || "").split(/\s+/).filter(Boolean));
  const el = {
    tagName: tag.toUpperCase(),
    dataset: {},
    hidden: attrs.hidden === true,
    tabIndex: 0,
    style: {},
    get id() { return attributes.get("id") || ""; },
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { const want = on === undefined ? !classes.has(c) : !!on; if (want) classes.add(c); else classes.delete(c); return want; }
    },
    getAttribute: (k) => (attributes.has(k) ? attributes.get(k) : null),
    setAttribute: (k, v) => attributes.set(k, String(v)),
    removeAttribute: (k) => attributes.delete(k),
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch: (type, event = {}) => (listeners[type] || []).forEach((fn) => fn(Object.assign({ type, preventDefault() {}, target: el }, event))),
    click: () => el.dispatch("click"),
    focus: () => { doc.activeElement = el; },
    contains: (other) => other === el || (el.children || []).includes(other),
    children: []
  };
  Object.keys(attrs).filter((k) => k.startsWith("data-")).forEach((k) => {
    el.dataset[k.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = attrs[k];
  });
  return el;
}

let doc;
function harness({ search = "", storage = {}, historyState = null } = {}) {
  const byId = {};
  const add = (el) => { if (el.id) byId[el.id] = el; return el; };
  const pages = ["tasks", "budget", "activity"].map((p) => add(element("button", { class: "tab" + (p === "tasks" ? " active" : ""), "data-page": p, id: p + "-page-btn" })));
  const views = ["queue", "list", "calendar"].map((v) => add(element("button", { role: "tab", "data-task-view": v, id: "task-view-" + v })));
  const toggle = add(element("button", { id: "task-actual-toggle", hidden: true }));
  const panels = ["working-queue", "schedule", "budget", "activity", "social", "vault"].map((p) => add(element("div", { class: "tab-content" + (p === "working-queue" ? " active" : ""), id: "tab-" + p })));
  const docListeners = {};
  const events = [];
  doc = {
    readyState: "complete",
    activeElement: null,
    body: element("body"),
    getElementById: (id) => byId[id] || null,
    querySelectorAll: (selector) => ({
      ".tab-content": panels,
      "#tab-bar .tab[data-page]": pages,
      "[data-task-view]": views,
      ".task-add-pop .sub-add-input": []
    })[selector] || [],
    addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
    dispatchEvent: (event) => { events.push(event); (docListeners[event.type] || []).forEach((fn) => fn(event)); }
  };
  const store = new Map(Object.entries(storage));
  const location = { href: "https://dcc.test/" + search, search };
  // A browser-like session history: an index into entries, with forward kept.
  const entries = [{ state: historyState, href: location.href }];
  let at = 0;
  const go = (delta) => {
    at += delta;
    const u = new URL(entries[at].href);
    location.href = u.href; location.search = u.search;
    winListeners.popstate.forEach((fn) => fn({}));
  };
  const history = {
    get state() { return entries[at].state === undefined ? null : JSON.parse(JSON.stringify(entries[at].state)); },
    pushState(state, _t, url) { const u = new URL(String(url || location.href), location.href); entries.splice(at + 1); entries.push({ state: JSON.parse(JSON.stringify(state)), href: u.href }); at = entries.length - 1; location.href = u.href; location.search = u.search; },
    replaceState(state, _t, url) { const u = new URL(String(url || location.href), location.href); entries[at] = { state: JSON.parse(JSON.stringify(state)), href: u.href }; location.href = u.href; location.search = u.search; },
    get length() { return entries.length; },
    back() { go(-1); },
    forward() { go(1); }
  };
  const winListeners = { popstate: [] };
  const toasts = [], runs = [], scheduleViews = [];
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  const DCC = {
    NavState,
    toast: (message) => toasts.push(message),
    tabs: { register() {}, run: (name) => runs.push(name) }
  };
  const window = {
    DCC, localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    addEventListener: (type, fn) => { (winListeners[type] = winListeners[type] || []).push(fn); },
    applyScheduleView: (state, prev) => scheduleViews.push({ state: Object.assign({}, state), prev: prev && Object.assign({}, prev) }),
    fetch: () => { throw new Error("navigation must not call the network"); }
  };
  const context = vm.createContext({ window, document: doc, location, history, URL, URLSearchParams, CustomEvent, DCC, setTimeout: (fn) => fn(), console });
  const source = read("public/js/tabs.js");
  vm.runInContext(slice(source, "// ======== NAVIGATION ========", "// ======== TASK MENU ACCORDION ========"), context);
  return { DCC, doc, pages, views, toggle, panels, location, history, store, toasts, runs, scheduleViews, events, byId };
}
const activePanel = (h) => h.panels.find((p) => p.classList.contains("active")).id;
// Objects built inside the VM have another realm's prototype; compare by value.
const sameState = (value, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(value)), expected, message);

test("a bare entry opens the Working Queue and leaves the URL bare", () => {
  const h = harness();
  assert.equal(activePanel(h), "tab-working-queue");
  sameState(h.DCC.nav.get(), { page: "tasks", view: "queue", actual: false });
  assert.equal(h.location.search, "");
  sameState(h.history.state.dccNav, { page: "tasks", view: "queue", actual: false });
  assert.equal(h.toggle.hidden, true, "Actual is not offered on the queue");
  assert.equal(h.byId["task-view-queue"].getAttribute("aria-selected"), "true");
  assert.equal(h.pages[0].getAttribute("aria-current"), "page");
});

test("views, pages, Actual and Back follow one state and keep other parameters", () => {
  const h = harness({ search: "?task=abc" });
  h.views[1].click();
  assert.equal(activePanel(h), "tab-schedule");
  assert.equal(h.location.search, "?task=abc&tab=tasks&view=list");
  assert.equal(h.store.get(NavState.VIEW_KEY), "list");
  assert.equal(h.toggle.hidden, false);
  assert.equal(h.scheduleViews.at(-1).state.view, "list");
  const depth = h.history.length;
  h.toggle.click();
  assert.equal(h.history.length, depth, "Actual replaces, never pushes");
  assert.equal(h.location.search, "?task=abc&tab=tasks&view=list&actual=1");
  assert.equal(h.toggle.getAttribute("aria-pressed"), "true");
  assert.equal(h.store.get(NavState.ACTUAL_KEY), "1");
  assert.equal(h.doc.body.dataset.navActual, "on");
  h.pages[1].click();
  assert.equal(activePanel(h), "tab-budget");
  assert.equal(h.location.search, "?task=abc&tab=budget");
  assert.equal(h.toggle.hidden, true);
  assert.equal(h.pages[1].getAttribute("aria-current"), "page");
  assert.equal(h.pages[0].getAttribute("aria-current"), null);
  h.pages[0].click();
  sameState(h.DCC.nav.get(), { page: "tasks", view: "list", actual: true }, "Tasks keeps its last view and Actual");
  h.history.back();
  assert.equal(activePanel(h), "tab-budget");
  h.history.back();
  sameState(h.DCC.nav.get(), { page: "tasks", view: "list", actual: true });
  const changes = h.events.filter((e) => e.type === "dcc:nav-changed");
  assert.ok(changes.length >= 5);
  assert.equal(changes.at(-1).detail.source, "history");
});

// A reload keeps the URL, the entry's history state and storage.
const reload = (h) => harness({ search: h.location.search, storage: Object.fromEntries(h.store), historyState: h.history.state });

test("queue, Itinerary, Actual, Calendar, Budget, Tasks, Back, Back, Forward, Tasks keeps Calendar", () => {
  const h = harness();
  h.views[1].click();          // Itinerary
  h.toggle.click();            // Actual on
  h.views[2].click();          // Calendar
  h.pages[1].click();          // Budget
  h.pages[0].click();          // Tasks
  sameState(h.DCC.nav.get(), { page: "tasks", view: "calendar", actual: true });
  h.history.back();            // Budget
  sameState(h.DCC.nav.get(), { page: "budget", view: "calendar", actual: true });
  h.history.back();            // Calendar
  sameState(h.DCC.nav.get(), { page: "tasks", view: "calendar", actual: true });
  h.history.forward();         // Budget
  assert.equal(activePanel(h), "tab-budget");
  sameState(h.DCC.nav.get(), { page: "budget", view: "calendar", actual: true });
  h.pages[0].click();          // Tasks
  sameState(h.DCC.nav.get(), { page: "tasks", view: "calendar", actual: true }, "return from Budget history preserves the task view");
  assert.equal(h.location.search, "?tab=tasks&view=calendar&actual=1");
  // Reloading on Budget keeps the workspace too.
  h.pages[1].click();
  const again = reload(h);
  sameState(again.DCC.nav.get(), { page: "budget", view: "calendar", actual: true });
  again.pages[0].click();
  sameState(again.DCC.nav.get(), { page: "tasks", view: "calendar", actual: true });
});

test("explicit Actual off survives reload and Back on a past day", () => {
  const h = harness({ search: "?tab=tasks&view=list&actual=0&date=2026-10-01&task=example", storage: { [NavState.ACTUAL_KEY]: "1" } });
  sameState(h.DCC.nav.get(), { page: "tasks", view: "list", actual: false });
  assert.equal(h.location.search, "?tab=tasks&view=list&actual=0&date=2026-10-01&task=example", "the explicit off is not serialized away");
  const r = reload(h);
  r.DCC.nav.setArchive(true);
  assert.equal(r.DCC.nav.get().actual, false, "a past-day default cannot re-enable it");
  r.views[2].click();
  assert.equal(new URL(r.location.href).searchParams.get("actual"), "0");
  r.history.back();
  r.DCC.nav.setArchive(true);
  sameState(r.DCC.nav.get(), { page: "tasks", view: "list", actual: false });
});

test("on a past day, Itinerary -> Calendar -> Back/Forward keeps the Actual default; returning to today restores the preference", () => {
  const h = harness({ search: "?tab=tasks&view=list&date=2026-10-01" });
  h.DCC.nav.setArchive(true);
  sameState(h.DCC.nav.get(), { page: "tasks", view: "list", actual: true });
  h.views[2].click();
  sameState(h.DCC.nav.get(), { page: "tasks", view: "calendar", actual: true });
  h.history.back();
  sameState(h.DCC.nav.get(), { page: "tasks", view: "list", actual: true }, "Back on the same past day keeps the default");
  assert.equal(h.toggle.getAttribute("aria-pressed"), "true");
  h.history.forward();
  sameState(h.DCC.nav.get(), { page: "tasks", view: "calendar", actual: true });
  assert.equal(h.history.state.dccNav.actual, false, "history still records the preference");
  assert.equal(h.store.has(NavState.ACTUAL_KEY), false, "nothing persisted");
  h.DCC.nav.setArchive(false);
  sameState(h.DCC.nav.get(), { page: "tasks", view: "calendar", actual: false }, "today returns to the saved preference");
  h.history.back();
  sameState(h.DCC.nav.get(), { page: "tasks", view: "list", actual: false }, "no default once back on today");
});

test("on a past day, explicit Actual off survives Itinerary -> Calendar -> Back/Forward", () => {
  const h = harness({ search: "?tab=tasks&view=list&actual=0&date=2026-10-01" });
  h.DCC.nav.setArchive(true);
  assert.equal(h.DCC.nav.get().actual, false);
  h.views[2].click();
  assert.equal(h.DCC.nav.get().actual, false);
  h.history.back();
  sameState(h.DCC.nav.get(), { page: "tasks", view: "list", actual: false });
  h.history.forward();
  sameState(h.DCC.nav.get(), { page: "tasks", view: "calendar", actual: false });
  // A saved preference on is also honoured as-is, without becoming a default.
  const pref = harness({ search: "?tab=tasks&view=list", storage: { [NavState.ACTUAL_KEY]: "1" } });
  pref.DCC.nav.setArchive(true);
  pref.views[2].click();
  pref.history.back();
  pref.DCC.nav.setArchive(false);
  sameState(pref.DCC.nav.get(), { page: "tasks", view: "list", actual: true });
});

test("a past-day default is never written as a choice", () => {
  const h = harness({ search: "?tab=tasks&view=list" });
  h.DCC.nav.setArchive(true);
  assert.equal(h.DCC.nav.get().actual, true);
  h.views[2].click();
  assert.equal(h.location.search, "?tab=tasks&view=calendar", "no actual parameter from a default");
  assert.equal(h.history.state.dccNav.actual, false, "history records the preference, not the default");
  assert.equal(h.history.state.dccActualExplicit, false);
});

test("arrow keys move between task views", () => {
  const h = harness();
  h.views[0].dispatch("keydown", { key: "ArrowRight" });
  assert.equal(h.DCC.nav.get().view, "list");
  h.views[1].dispatch("keydown", { key: "End" });
  assert.equal(h.DCC.nav.get().view, "calendar");
  assert.equal(h.doc.activeElement, h.views[2]);
  h.views[2].dispatch("keydown", { key: "Home" });
  assert.equal(h.DCC.nav.get().view, "queue");
});

test("retired links land on Tasks with a notice and keep deep-link parameters", () => {
  const h = harness({ search: "?tab=vault&task=keep" });
  assert.equal(activePanel(h), "tab-working-queue");
  assert.equal(h.location.search, "?tab=tasks&task=keep&view=queue");
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0], /^Mycelium is no longer in navigation\. Its records are kept\./);
  assert.equal(h.panels.find((p) => p.id === "tab-vault").classList.contains("active"), false);
});

test("old Itinerary links and a stored legacy Actual view open Itinerary with Actual on", () => {
  const h = harness({ search: "?tab=schedule", storage: { [NavState.VIEW_KEY]: "actual" } });
  sameState(h.DCC.nav.get(), { page: "tasks", view: "list", actual: true });
  assert.equal(h.location.search, "?tab=tasks&view=list", "a migrated preference is not written into the URL as a choice");
  assert.equal(h.store.get(NavState.VIEW_KEY), "list");
  assert.equal(h.store.get(NavState.ACTUAL_KEY), "1");
  assert.equal(h.toasts.length, 0);
});

test("hydration never rewrites a saved base view", () => {
  const h = harness({ search: "?tab=tasks&view=queue", storage: { [NavState.VIEW_KEY]: "calendar" } });
  assert.equal(h.store.get(NavState.VIEW_KEY), "calendar");
  h.DCC.tabs.select("schedule");
  assert.equal(h.DCC.nav.get().view, "calendar");
});

test("the compatibility adapter drives the same state", () => {
  const h = harness();
  h.DCC.tabs.select("schedule");
  assert.equal(activePanel(h), "tab-schedule");
  h.DCC.tabs.select("activity");
  assert.equal(activePanel(h), "tab-activity");
  h.DCC.tabs.select("working-queue");
  sameState(h.DCC.nav.get(), { page: "tasks", view: "queue", actual: false });
  h.DCC.tabs.select("pet-home");
  assert.equal(activePanel(h), "tab-working-queue");
  assert.match(h.toasts.at(-1), /^Pet Home is no longer in navigation/);
  assert.equal(h.DCC.tabs.select("unknown-panel"), null);
});

test("past days default Actual on without overriding a choice or the saved preference", () => {
  const h = harness({ search: "?tab=tasks&view=calendar" });
  h.DCC.nav.setArchive(true);
  assert.equal(h.DCC.nav.get().actual, true);
  assert.equal(h.store.has(NavState.ACTUAL_KEY), false, "archive default is not persisted");
  assert.equal(h.location.search, "?tab=tasks&view=calendar", "archive default is not written to the URL");
  h.DCC.nav.setArchive(false);
  assert.equal(h.DCC.nav.get().actual, false);
  const chosen = harness({ search: "?tab=tasks&view=list&actual=0" });
  chosen.DCC.nav.setArchive(true);
  assert.equal(chosen.DCC.nav.get().actual, false, "an explicit choice wins");
  assert.equal(chosen.DCC.nav.get().view, "list");
});

test("a focused editor inside a view counts as a draft", () => {
  const h = harness();
  const list = element("div", { id: "list-view" });
  const input = element("input");
  list.children.push(input);
  assert.equal(h.DCC.nav.hasDraftIn(list), false);
  input.focus();
  assert.equal(h.DCC.nav.hasDraftIn(list), true);
});

test("Day review opens only as an explicit panel under Actual", () => {
  const h = harness({ search: "?tab=tasks&view=list&actual=1" });
  assert.equal(h.DCC.nav.reviewOpen(), false);
  h.DCC.nav.setReviewOpen(true);
  assert.equal(h.DCC.nav.reviewOpen(), true);
  h.DCC.nav.setActual(false);
  assert.equal(h.DCC.nav.reviewOpen(), false, "turning Actual off hides it");
  h.DCC.nav.go({ view: "queue" });
  assert.equal(h.DCC.nav.reviewOpen(), false);
});

// ── Itinerary Actual presentation ──

function listActualContext(entries, scheduled, nav = { page: "tasks", view: "list", actual: true }) {
  const strip = { hidden: true, innerHTML: "", querySelector: () => ({ addEventListener() {} }) };
  const context = vm.createContext({
    window: {}, document: { getElementById: (id) => (id === "actual-summary" ? strip : null) },
    scheduled, viewDate: "2026-11-02", schedView: nav.view,
    blockStore: { getTimeEntries: () => entries }, loadSessions: () => ({}),
    isDeleted: () => false,
    escHtml: (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
    DCC: { ActualProjection, nav: { get: () => nav, reviewOpen: () => false } }
  });
  context.window = context;
  const source = read("public/js/schedule-tab.js");
  vm.runInContext(slice(source, "function _schedViewDate()", "function _buildUnlessDraft(") +
    slice(source, "// ── Actual evidence for the List view ──", "// Subtask row helpers"), context);
  return { context, strip };
}

test("Itinerary Actual adds evidence chips and an edit entry point to each row", () => {
  const scheduled = [
    { id: "a", title: "Write brief", start: "09:00", end: "10:00" },
    { id: "b", title: "Call vendor", start: "10:00", end: "10:30", actualTimeUnknown: true },
    { id: "c", title: "Plan <Q1>", start: "11:00", end: "12:00" }
  ];
  const entries = [{ id: "t1", type: "time_entry", date: "2026-11-02", properties: { blockId: "a", start: "09:05", durSec: 1500 } }];
  const { context } = listActualContext(entries, scheduled);
  const day = vm.runInContext("actualDayProjection()", context);
  const row = (id) => vm.runInContext("_actualRowHtml(scheduled.find(e=>e.id===" + JSON.stringify(id) + "),day)", Object.assign(context, { day }));
  assert.match(row("a"), /class="it-actual it-actual--recorded"[^>]*>Actual 25m · 9:05 AM to 9:30 AM</);
  assert.match(row("b"), /it-actual--unknown[^>]*>Actual time unknown</);
  assert.match(row("c"), /it-actual--none[^>]*>No recorded actual</);
  assert.match(row("c"), /data-actual-edit="c" aria-label="Add or edit actual time for Plan &lt;Q1&gt;">\+ time</);
});

test("Itinerary Actual summary keeps the completion review and Day review entry points", () => {
  const entries = [
    { id: "t1", type: "time_entry", date: "2026-11-02", properties: { blockId: "a", durSec: 600 } },
    { id: "t2", type: "time_entry", date: "2026-11-02", properties: { allocationKind: "unknown", durSec: 300 } }
  ];
  const { context, strip } = listActualContext(entries, [{ id: "a", title: "A", start: "09:00", end: "10:00" }]);
  vm.runInContext("renderActualSummary()", context);
  assert.equal(strip.hidden, false);
  assert.match(strip.innerHTML, /<b>10m<\/b> Known actual/);
  assert.match(strip.innerHTML, /<b>10m<\/b> Without a clock time/);
  assert.match(strip.innerHTML, /<b>5m<\/b> Unknown time \(not focused\)/);
  assert.match(strip.innerHTML, /data-completion-review data-review-date="2026-11-02">Did these happen\?/);
  assert.match(strip.innerHTML, /class="actual-review-toggle" aria-expanded="false" aria-controls="actual-view">Day review</);
  assert.match(strip.innerHTML, /Waiting time is not focused effort/);
});

test("the summary stays hidden when Actual is off or on the queue", () => {
  for (const nav of [{ page: "tasks", view: "list", actual: false }, { page: "tasks", view: "queue", actual: true }]) {
    const { context, strip } = listActualContext([], [], nav);
    strip.hidden = false; strip.innerHTML = "stale";
    vm.runInContext("renderActualSummary()", context);
    assert.equal(strip.hidden, true);
    assert.equal(strip.innerHTML, "");
  }
});

test("the calendar layer repaints without rebuilding and never plots plan times", () => {
  const calendar = read("public/js/itinerary-calendar.js");
  assert.match(calendar, /state\.entries=\(result\.blocks\|\|\[\]\)\.filter\(b=>b&&b\.type==="time_entry"/);
  assert.match(calendar, /paintActual:setActualLayer/);
  assert.match(calendar, /layer\.segments\.forEach/);
  assert.doesNotMatch(slice(calendar, "function paintActual()", "function inspectorActualHtml("), /ev\.start|minuteOf\(ev/);
  assert.match(calendar, /e\.target\.closest\("\.iwc-event,\.iwc-actual-seg"\)/, "a segment click never creates a draft task");
  const tab = read("public/js/schedule-tab.js");
  assert.match(tab, /else if\(actualChanged&&window\.ItineraryCalendar&&ItineraryCalendar\.paintActual\)ItineraryCalendar\.paintActual\(\);/);
});

test("the sync dot reports queue conflicts without resolving them", () => {
  const shell = read("public/js/shell.js");
  assert.match(shell, /if \(queue\.conflict\) \{ state = "needs-attention"/);
  assert.match(shell, /"Review queue update"/);
  assert.match(shell, /discard\.textContent = "Confirm discard"/, "discard asks first");
  assert.doesNotMatch(shell, /persist\(':conflict'|removeItem\("dcc-working-queue/);
  const queue = read("public/js/working-queue.js");
  assert.match(queue, /function syncState\(\)\{return \{pending:!!pending,conflict:/);
  assert.match(queue, /Itinerary and Calendar plan when\./);
  assert.match(queue, /function activate\(id\)\{if\(DCC\.nav\)DCC\.nav\.go\(\{page:'tasks',view:'queue'\}\)/);
});
