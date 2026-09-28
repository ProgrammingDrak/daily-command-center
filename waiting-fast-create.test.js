"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync(require.resolve("./index.html"), "utf8");
const client = fs.readFileSync(require.resolve("./public/js/delegated.js"), "utf8");

test("Waiting creation offers existing tasks and a conditional new task field", () => {
  const form = html.slice(html.indexOf('id="delegated-modal-form"'), html.indexOf('id="dm-save"'));
  assert.match(form, /<select id="dm-task-link"/);
  assert.match(form, /<input type="text" id="dm-new-task"[^>]*hidden/);
  assert.match(form, /<input type="hidden" id="dm-my-task"/);
  assert.match(client, /addOption\("__new__", "\+ New Waiting task"/);
});

test("task conversion is sent with creation instead of deleting the task locally", () => {
  assert.match(client, /convertTaskId: convertedFrom/);
  assert.doesNotMatch(client, /window\.removeTaskForConversion\(convertedFrom\)/);
});
