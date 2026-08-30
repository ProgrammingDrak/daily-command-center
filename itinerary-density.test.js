const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const scheduleSource = fs.readFileSync(path.join(__dirname, "public/js/schedule-tab.js"), "utf8");
const dashboardCss = fs.readFileSync(path.join(__dirname, "public/css/dashboard.css"), "utf8");
const optimizationCss = fs.readFileSync(path.join(__dirname, "public/css/ui-optimization.css"), "utf8");

test("list rows keep one completion control in a compact utility rail", () => {
  assert.match(scheduleSource, /class="it-list-utility"/);
  assert.match(scheduleSource, /class="it-list-nav"/);
  assert.doesNotMatch(scheduleSource, /class="wrap-collapse-spacer"/);
  assert.doesNotMatch(scheduleSource, /<button class="chk-quick"/);
  assert.match(scheduleSource, /quick-complete-control/);
  assert.match(scheduleSource, /bindQuickCompleteControl/);
  assert.doesNotMatch(scheduleSource, /label:"Complete without notes"/);
  assert.match(optimizationCss, /\.it-list-item:not\(\.done\) \.it-list-utility/);
  assert.match(optimizationCss, /\.it-list-item:not\(\.done\) \.quick-complete-control::before/);
});

test("completed rows collapse the utility rail with their compact presentation", () => {
  assert.match(dashboardCss, /\.it-list-item\.done:not\(\.sub\) \.it-list-utility\{width:18px;/);
  assert.match(dashboardCss, /\.it-list-item\.done:not\(\.sub\) \.it-list-nav\{display:none\}/);
});
