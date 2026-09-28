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

test("Waiting gets its own touch-sized row below Loose Ends on mobile", () => {
  const mobileShell = css.slice(css.indexOf("@media (max-width:760px)"));
  assert.match(mobileShell, /\.header \.date-nav \.waiting-pill-nav\{[^}]*flex:1 0 100%;[^}]*order:3;[^}]*min-height:44px/);
});
