const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const scheduleSource = fs.readFileSync(path.join(__dirname, "public/js/schedule-tab.js"), "utf8");
const dashboardCss = fs.readFileSync(path.join(__dirname, "public/css/dashboard.css"), "utf8");

test("list rows group navigation and completion into one compact utility rail", () => {
  assert.match(scheduleSource, /class="it-list-utility"/);
  assert.match(scheduleSource, /class="it-list-nav"/);
  assert.doesNotMatch(scheduleSource, /class="wrap-collapse-spacer"/);
  assert.match(dashboardCss, /\.it-list-item\{[^}]*grid-template-columns:auto 3px minmax\(0,1fr\) auto/);
  assert.match(dashboardCss, /\.it-list-utility\{width:50px;/);
});

test("completed rows collapse the utility rail with their compact presentation", () => {
  assert.match(dashboardCss, /\.it-list-item\.done:not\(\.sub\) \.it-list-utility\{width:18px;/);
  assert.match(dashboardCss, /\.it-list-item\.done:not\(\.sub\) \.it-list-nav\{display:none\}/);
});
