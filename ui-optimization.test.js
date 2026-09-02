"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const scenarios = require("./test-support/ui-review-scenarios");

const root = __dirname;
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("the shared foundation exposes the approved interfaces", () => {
  assert.match(read("public/js/shell.js"), /DCC\.shell\s*=\s*\{\s*activate/);
  assert.match(read("public/js/core-ui.js"), /DCC\.overlay\s*=\s*\{\s*open/);
  assert.match(read("public/js/collection.js"), /DCC\.collection\s*=\s*\{\s*mount/);
  assert.match(read("public/js/persistence.js"), /CustomEvent\("dcc:save-status"/);
});

test("Poppins is local and the semantic palette is complete", () => {
  const tokens = read("public/css/tokens.css");
  assert.match(tokens, /font-family:\s*"Poppins"/);
  assert.match(tokens, /--surface-canvas:/);
  assert.match(tokens, /--surface-raised:/);
  assert.match(tokens, /--ink:/);
  assert.match(tokens, /--focus-ring:/);
  for (const weight of ["Regular", "Medium", "SemiBold", "Bold"]) {
    assert.ok(fs.existsSync(path.join(root, `public/fonts/Poppins-${weight}.ttf`)));
  }
});

test("responsive CSS uses only the three approved breakpoints", () => {
  const files = [
    "public/css/admin.css",
    "public/css/calendar-week.css",
    "public/css/core-ui.css",
    "public/css/dashboard.css",
    "public/css/ui-optimization.css",
    "public/css/vault.css",
    "login.html",
  ];
  const found = [];
  for (const file of files) {
    for (const match of read(file).matchAll(/@media[^\{]*(?:min|max)-width\s*:\s*(\d+)px/gi)) {
      found.push({ file, value: Number(match[1]) });
    }
  }
  assert.ok(found.length > 0);
  assert.deepEqual([...new Set(found.map((item) => item.value))].sort((a, b) => a - b), [480, 760, 1024]);
});

test("daily execution uses canonical task and movement paths", () => {
  const calendar = read("public/js/itinerary-calendar.js");
  const schedule = read("public/js/schedule-tab.js");
  const details = read("public/js/features.js");
  assert.match(calendar, /blockStore\.rescheduleBlock/);
  assert.match(calendar, /TaskModel/);
  assert.match(schedule, /DCC\.TaskModel/);
  assert.match(details, /DCC\.TaskModel\.fromBlock/);
  assert.match(read("public/js/catch-up.js"), /Loose Ends is user-opened/);
});

test("task details provide explicit read and edit controls", () => {
  const index = read("index.html");
  const details = read("public/js/features.js");
  for (const label of ["Overview", "Notes", "Subtasks", "History", "Automation"]) {
    assert.match(index, new RegExp(`data-am-tab="${label.toLowerCase()}"`));
  }
  for (const id of ["add-modal-edit", "add-modal-save", "add-modal-cancel-edit", "add-modal-close"]) {
    assert.match(index, new RegExp(`id="${id}"`));
  }
  assert.match(details, /h3\.setAttribute\('role', 'button'\)/);
  assert.match(details, /e\.key !== 'Enter' && e\.key !== ' '/);
  assert.match(details, /titleControl\.tabIndex = _addModalEditing \? 0 : -1/);
});

test("clicking a task opens the details modal already in edit mode", () => {
  const details = read("public/js/features.js");
  const open = details.slice(details.indexOf("function openAddModal("), details.indexOf("function selectAddModalTab("));
  assert.match(open, /setAddModalMode\(true\)/);
  assert.doesNotMatch(open, /setAddModalMode\(false\)/);
  const cancel = details.slice(details.indexOf("function cancelAddModalEdits("), details.indexOf("function refreshOpenAddModalDetails("));
  assert.match(cancel, /setAddModalMode\(false\)/);
});

test("Task Manager uses Quick add without duplicating task creation", () => {
  const index = read("index.html");
  const css = read("public/css/ui-optimization.css");
  assert.doesNotMatch(index, /id="task-add-menus"/);
  assert.match(index, /class="task-manager-toolbar"/);
  assert.match(css, /body\.tasks-drawer-open \.dcc-launcher/);
  assert.match(css, /\.task-manager-toolbar \.task-bank-tools \{ position: static; margin: 0; \}/);
});

test("List itinerary rows avoid redundant duration and compact privacy styling", () => {
  const schedule = read("public/js/schedule-tab.js");
  const css = read("public/css/ui-optimization.css");
  assert.doesNotMatch(schedule, /\(subTimeless\?'':'<span>'\+ms\(dur\(ev\)\)\+'<\/span>'\)/);
  assert.match(schedule, /pet-privacy-toggle it-list-privacy/);
  assert.match(css, /\.it-list-title-row \.it-list-privacy > span/);
  assert.match(css, /min-height:\s*24px/);
});

test("List itinerary rows use one hold-aware lightning completion control", () => {
  const schedule = read("public/js/schedule-tab.js");
  const css = read("public/css/ui-optimization.css");
  assert.match(schedule, /function bindQuickCompleteControl/);
  assert.match(schedule, /QUICK_COMPLETE_HOLD_MS=550/);
  assert.match(schedule, /quick-complete-control/);
  assert.match(schedule, /openDoneModal\(ev\.id,ev\.title,completeNow,ev\)/);
  assert.doesNotMatch(schedule, /label:"Complete without notes"/);
  assert.match(css, /\.quick-complete-control\.is-holding::before/);
  assert.match(css, /width:\s*28px;\s*\n\s*height:\s*28px/);
});

test("Budget overlays cover sticky navigation through the shared overlay layer", () => {
  const css = read("public/css/dashboard.css");
  const shell = read("public/js/shell.js");
  assert.match(css, /\.rv-backdrop\{[^}]*z-index:var\(--z-overlay\)/);
  assert.match(css, /\.bt-modal-backdrop\{[^}]*z-index:var\(--z-overlay\)/);
  assert.match(shell, /"\.rv-backdrop", "\.bt-modal-backdrop"/);
  assert.match(shell, /childList:\s*true/);
});

test("Budget removes redundant sections and places Money Changer beside the tank", () => {
  const css = read("public/css/dashboard.css");
  const budget = read("public/js/budget.js");
  assert.doesNotMatch(budget, /class="bt-section-nav"/);
  assert.doesNotMatch(budget, /<span class="bt-group-title">Planned purchases<\/span>/);
  assert.match(budget, /bt-changer-rewards" data-act="vault-open">Rewards<\/button>/);
  assert.match(budget, /bt-main bt-main--tank[\s\S]*?bt-changer-col[^\n]+moneyChangerMarkup\(s\)[\s\S]*?bt-tank-col[^\n]+tankMarkup\(s\)/);
  assert.match(css, /\.bt-main--tank\{display:grid;grid-template-columns:/);
  assert.doesNotMatch(budget, /data-act="vault-open">Vault<\/button>/);
});

test("Budget setup cards open shared drawers with structured financial rows", () => {
  const budget = read("public/js/budget.js");
  const css = read("public/css/ui-optimization.css");
  for (const label of ["Income", "Absolute Expenses", "Savings", "Discretionary Spending", "Reserve Unlocked"]) {
    assert.match(budget, new RegExp(`label: "${label}"`));
  }
  assert.match(budget, /window\.DCC\.overlay\.open\(\{/);
  assert.match(budget, /window\.DCC\.collection\.mount/);
  assert.match(budget, /data-finance-field="expense-type"/);
  assert.match(budget, /Math\.round\(\(min \+ max\) \/ 2\)/);
  assert.match(budget, /data-finance-purchase-form/);
  assert.doesNotMatch(budget, /id="bt-income-input"/);
  assert.match(css, /\.bt-finance-card:hover/);
  assert.match(css, /\.bt-finance-table-scroll \{[^}]*overflow-x:\s*auto/);
});

test("Budget Tank maps income, commitments, and converted reserve correctly", () => {
  const budget = read("public/js/budget.js");
  const css = read("public/css/dashboard.css");
  assert.match(budget, /const income = Math\.max\(0, u\.income_cents/);
  assert.match(budget, /u\.absolute_expenses_cents[^\n]+u\.savings_total_cents/);
  assert.match(budget, /const openWater = Math\.max\(0, maximumReserve - earnedReserve\)/);
  assert.match(budget, /const floorPct = fixedFloor > 0 \? 16 : 6/);
  assert.match(budget, /Math\.max\(4, \(amount \/ maximumReserve\) \* reserveZonePct\)/);
  assert.match(budget, /not converted into Reward Reserve/);
  assert.doesNotMatch(budget, /class="bt-tank-key"/);
  assert.match(budget, /class="bt-persistent-coins"/);
  assert.match(budget, /budgeted: u\.allocated_cents \|\| 0/);
  assert.match(budget, /class="bt-coin-rain"/);
  assert.match(budget, /runTankFillAnimation\(root\)/);
  assert.match(css, /@keyframes bt-coin-fall/);
  assert.match(css, /\.bt-persistent-coins\{[^}]*background-image:/);
  assert.match(css, /\.bt-coin-rain\{display:none\}/);
});

test("zero-valued number inputs replace zero when typing starts", () => {
  const core = read("public/js/core.js");
  assert.match(core, /isReplaceableZeroNumberInput/);
  assert.match(core, /addEventListener\("focusin"/);
  assert.match(core, /addEventListener\("pointerup"/);
  assert.match(core, /addEventListener\("beforeinput"/);
  assert.match(core, /event\.target\.value\s*=\s*""/);
  assert.match(core, /data-keep-leading-zero/);
});

test("Runway is removed and Brief opens from save status", () => {
  const index = read("index.html");
  const shell = read("public/js/shell.js");
  const brief = read("public/js/glymphatic-brief.js");
  assert.doesNotMatch(index, /data-tab="runway"|id="tab-runway"|data-tab="glymphatic"|id="tab-glymphatic"/);
  assert.doesNotMatch(read("public/js/mobile-shell.js"), /Runway|tab:"glymphatic"/);
  assert.match(shell, /data-open-brief/);
  assert.match(shell, /DCC\.brief\.open\(button\)/);
  assert.match(brief, /DCC\.brief\s*=\s*\{\s*open:/);
});

test("review-only scenarios cover every required state and tutorial step", () => {
  assert.deepEqual(scenarios.commonStates, ["empty", "loading", "error", "long-text", "dense", "permission-limited"]);
  assert.equal(scenarios.onboarding.length, 10);
  assert.ok(Object.keys(scenarios.surfaces).length >= 19);
  assert.equal(read("index.html").includes("ui-review-scenarios"), false);
});

test("Social bulk publishing cannot reuse hidden stale selections", () => {
  const social = read("public/js/social.js");
  assert.match(social, /function reconcileSelectedPosts\(\)/);
  assert.match(social, /visibleIds\.has\(String\(postId\)\)/);
  assert.match(social, /selectedPosts\.delete\(String\(postId\)\)/);
  assert.match(social, /async function bulkDecision\(action\) \{\s*reconcileSelectedPosts\(\);/);
});

test("calendar completion and blocked holds keep canonical safeguards", () => {
  const calendar = read("public/js/itinerary-calendar.js");
  const schedule = read("public/js/schedule-tab.js");
  assert.match(calendar, /input\.value==="done"[\s\S]*?toggleComplete\(ev,true\)/);
  assert.doesNotMatch(calendar, /input\.name==="status"[\s\S]{0,240}setTaskCompletion/);
  assert.match(schedule, /chkBlocked\?completeNow:/);
  assert.match(schedule, /completeBlocked\?completeNow:/);
});

test("Quick add is a modal with focus containment and inert cleanup", () => {
  const html = read("index.html");
  const launcher = read("public/js/launcher.js");
  assert.match(html, /id="dcc-compose"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(launcher, /function setPageInert/);
  assert.match(launcher, /event\.key === "Tab" && open/);
  assert.match(launcher, /setPageInert\(false\)/);
});

test("public Pet Home loads shared helpers before its controller", () => {
  const html = read("public-pet.html");
  assert.ok(html.indexOf("/public/js/core.js") < html.indexOf("/public/js/public-pet-home.js"));
});
