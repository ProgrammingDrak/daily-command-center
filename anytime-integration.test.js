const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const db = require("./db");
const TaskModel = require("./public/js/task-model.js");

test("Anytime definitions stay outside every task-row projection", () => {
  const row = {type: "block", date: null, properties: {kind: "anytime_item", title: "Drink water"}};
  assert.equal(db.isTaskRow(row), false);
  assert.equal(TaskModel.isTaskRow(row), false);

  const schema = fs.readFileSync(require.resolve("./pg-schema.js"), "utf8");
  const fn = schema.match(/CREATE OR REPLACE FUNCTION dcc_is_task_row[\s\S]*?\$fn\$;/);
  assert.ok(fn, "dcc_is_task_row definition must remain discoverable");
  assert.match(fn[0], /'anytime_item'/);
});

test("Anytime scripts load model-first and the panel stays non-modal", () => {
  const html = fs.readFileSync(require.resolve("./index.html"), "utf8");
  const store = html.indexOf('/public/js/anytime-store.js');
  const dock = html.indexOf('/public/js/anytime-dock.js');
  const nudge = html.indexOf('/public/js/pet-nudge.js');
  assert.ok(store !== -1 && store < dock && dock < nudge);
  const panelStart = html.indexOf('<div class="anytime-panel"');
  assert.ok(panelStart !== -1 && panelStart < dock, "panel must exist before its controller executes");
  const panel = html.match(/<div class="anytime-panel"[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(panel, "Anytime panel markup must remain present");
  assert.doesNotMatch(panel[0], /dcc-overlay|modal-overlay|drawer-overlay/);
});
