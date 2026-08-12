const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "public/js/side-drawers.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "public/css/dashboard.css"), "utf8");

test("task shortcut rail opens modal managers instead of a persistent slide-out drawer", () => {
  assert.match(html, /id="tasks-drawer"/);
  assert.ok(html.indexOf('id="sidecar-tabs"') < html.indexOf('id="tasks-drawer"'), "the shortcut rail remains outside the hidden modal subtree");
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="tasks-drawer-title"/);
  assert.match(css, /\.side-drawer-body\{[^}]*top:50%;left:50%[^}]*border-radius:14px[^}]*opacity:0/);
  assert.match(css, /\.side-drawer\.open \.side-drawer-body\{[^}]*scale\(1\)[^}]*opacity:1/);
  assert.match(css, /\.side-drawer-backdrop\{display:block/);
  assert.doesNotMatch(source, /TASKS_OPEN_KEY/);
  assert.match(source, /trapFocus\(e, d\.querySelector\("\.side-drawer-body"\)\)/);
  assert.match(source, /if\(!wasOpen\) modalTrigger = document\.activeElement/);
  assert.match(source, /if\(!root\.contains\(document\.activeElement\)\)/);
  assert.match(source, /setTimeout\(focusInsideTasks, 0\)/);
});

test("repeat shortcut bypasses the general task manager and opens its dedicated modal", () => {
  assert.match(source, /sectionId === "tm-repeat-responsibilities-section"/);
  assert.match(source, /window\.openRepeatResponsibilityManager\(\)/);
  assert.match(source, /document\.querySelectorAll\("#tasks-drawer \.tm-section"\)/);
  assert.match(html, /data-sidecar-label="Repeat responsibilities"/);
});
