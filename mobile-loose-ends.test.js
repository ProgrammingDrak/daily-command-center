const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "public/css/dashboard.css"), "utf8");

test("Loose Ends gets a dedicated full-width row in the mobile date toolbar", () => {
  const mobileShell = css.slice(css.indexOf("@media (max-width:760px)"));
  assert.match(mobileShell, /\.header \.date-nav\{[^}]*flex-wrap:wrap/);
  assert.match(
    mobileShell,
    /\.header \.date-nav \.loose-ends-pill\{[^}]*flex:1 0 100%;[^}]*order:2;[^}]*justify-content:center/
  );
});

test("Waiting and the Unscheduled · Whenever capsule share one touch-sized row below Loose Ends on mobile", () => {
  const mobileShell = css.slice(css.indexOf("@media (max-width:760px)"));
  // 30% + 70% minus the 6px gap is exactly one row, so neither can ride up onto the date
  // row, and a third header control does not add a third full-width row on a phone.
  assert.match(mobileShell, /\.header \.date-nav \.waiting-pill-nav\{[^}]*flex:1 0 calc\(30% - 4px\);[^}]*order:3;[^}]*min-height:44px/);
  assert.match(mobileShell, /\.header \.date-nav \.untimed-pill\{[^}]*flex:1 0 calc\(70% - 2px\);[^}]*order:4/);
  assert.match(mobileShell, /\.header \.date-nav \.untimed-seg\{[^}]*min-height:44px/);
});
