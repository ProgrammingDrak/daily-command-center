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

test("the queue capsule takes one touch-sized row below Loose Ends on mobile, four equal doors", () => {
  const mobileShell = css.slice(css.indexOf("@media (max-width:760px)"));
  // One row for all four doors, so the phone header is no taller than with two pills.
  assert.match(mobileShell, /\.header \.date-nav \.queue-pill\{[^}]*flex:1 0 100%;[^}]*order:3/);
  // Label over count: side by side, "Unscheduled" alone overflows a quarter of 375px.
  assert.match(mobileShell, /\.header \.date-nav \.queue-seg\{[^}]*flex:1 1 0;[^}]*flex-direction:column;[^}]*min-height:48px/);
  assert.doesNotMatch(mobileShell, /\.waiting-pill-nav\{/, "Waiting is a door in the capsule now, not its own pill");
});
