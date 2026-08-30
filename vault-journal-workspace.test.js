"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const workspace = require("./public/js/vault-journal-workspace");

test("focus mode always fits inside the viewport", () => {
  const desktop = workspace.fitToViewport({ width: 1440, height: 900 });
  assert.ok(desktop.x >= 0 && desktop.y >= 0);
  assert.ok(desktop.x + desktop.width <= 1440);
  assert.ok(desktop.y + desktop.height <= 900);

  const phone = workspace.fitToViewport({ width: 320, height: 568 });
  assert.ok(phone.width <= 320);
  assert.ok(phone.height <= 568);
});

test("a stale floating geometry is pulled back on screen", () => {
  const settled = workspace.settle({
    mode: "float", x: 4000, y: -300, width: 1800, height: 1200,
    dockWidth: 480, collapsed: false,
  }, { width: 1024, height: 768 });
  assert.deepEqual(
    { x: settled.x, y: settled.y, width: settled.width, height: settled.height },
    { x: 0, y: 0, width: 1024, height: 768 },
  );
});

test("docking refuses narrow viewports and never takes over half a desktop", () => {
  const phone = workspace.settle({
    ...workspace.DEFAULT_PREFERENCES, mode: "dock-right", dockWidth: 700,
  }, { width: 700, height: 900 });
  assert.equal(phone.mode, "focus");

  const desktop = workspace.settle({
    ...workspace.DEFAULT_PREFERENCES, mode: "dock-left", dockWidth: 1000,
  }, { width: 1200, height: 900 });
  assert.equal(desktop.mode, "dock-left");
  assert.equal(desktop.dockWidth, 600);
});

test("closing resets focus while minimizing remains distinct", () => {
  const closed = workspace.afterClose({
    ...workspace.DEFAULT_PREFERENCES, mode: "dock-right", collapsed: true,
  });
  assert.equal(closed.mode, "focus");
  assert.equal(closed.collapsed, false);
});

test("stored preferences accept only known modes and finite geometry", () => {
  const parsed = workspace.parsePreferences(JSON.stringify({
    mode: "offscreen", x: "no", y: Infinity, width: 640, height: 500,
    dockWidth: 410, collapsed: true,
  }));
  assert.equal(parsed.mode, "dock-right");
  assert.equal(parsed.x, workspace.DEFAULT_PREFERENCES.x);
  assert.equal(parsed.y, workspace.DEFAULT_PREFERENCES.y);
  assert.equal(parsed.width, 640);
  assert.equal(parsed.collapsed, true);
});

test("journal outline keeps authored order and ignores fenced headings", () => {
  const outline = workspace.projectOutline([
    "# Morning",
    "## Notes",
    "```md",
    "## Not a heading",
    "```",
    "## Notes",
    "### Links",
  ].join("\n"));
  assert.deepEqual(outline.map((entry) => entry.label), ["Morning", "Notes", "Notes", "Links"]);
  assert.deepEqual(outline.map((entry) => entry.id), [
    "journal-section-morning", "journal-section-notes", "journal-section-notes-2", "journal-section-links",
  ]);
});

test("Mycelium loads and routes journal entries through the workspace", () => {
  const index = fs.readFileSync(require.resolve("./index.html"), "utf8");
  const tab = fs.readFileSync(require.resolve("./public/js/vault-tab.js"), "utf8");
  const css = fs.readFileSync(require.resolve("./public/css/vault.css"), "utf8");
  assert.match(index, /vault-journal-workspace\.js/);
  assert.match(tab, /VaultJournalWorkspace\.open\(node\)/);
  assert.match(tab, /editNode: \(node\) => window\.VaultEditor/);
  assert.match(css, /body\.vault-journal-dock-left\{padding-left:/);
  assert.match(css, /body\.vault-journal-collapsed #vault-journal-restore\{display:block\}/);
});
