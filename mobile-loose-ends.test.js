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

test("Waiting and Whenever share one touch-sized row below Loose Ends on mobile", () => {
  const mobileShell = css.slice(css.indexOf("@media (max-width:760px)"));
  // Half a row each (minus half the 6px gap), so neither can ride up onto the date row
  // and a third pill does not add a third full-width row to the phone header.
  assert.match(mobileShell, /\.header \.date-nav \.waiting-pill-nav\{[^}]*flex:1 0 calc\(50% - 3px\);[^}]*order:3;[^}]*min-height:44px/);
  assert.match(mobileShell, /\.header \.date-nav \.whenever-pill-nav\{[^}]*flex:1 0 calc\(50% - 3px\);[^}]*order:4;[^}]*min-height:44px/);
});
