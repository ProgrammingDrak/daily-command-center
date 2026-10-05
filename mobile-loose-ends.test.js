const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "public/css/dashboard.css"), "utf8");

test("Loose Ends is a door in the queue capsule, not a row of its own", () => {
  const mobileShell = css.slice(css.indexOf("@media (max-width:760px)"));
  assert.match(mobileShell, /\.header \.date-nav\{[^}]*flex-wrap:wrap/);
  assert.doesNotMatch(css, /\.loose-ends-pill\{/, "Loose Ends styles as a .queue-seg now");
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const capsule = html.slice(html.indexOf('id="queue-pill"'), html.indexOf('id="date-picker-drop"'));
  assert.match(capsule, /id="loose-ends-pill"/);
});

test("the queue capsule takes one touch-sized row on mobile, every door label over its count", () => {
  const mobileShell = css.slice(css.indexOf("@media (max-width:760px)"));
  // One row for all five doors, so the phone header is no taller than before.
  assert.match(mobileShell, /\.header \.date-nav \.queue-pill\{[^}]*flex:1 0 100%;[^}]*order:2/);
  // Grow from the label's width: equal fifths of 375px would cut "Unscheduled" short.
  assert.match(mobileShell, /\.header \.date-nav \.queue-seg\{[^}]*flex:1 1 auto;[^}]*flex-direction:column;[^}]*min-height:48px/);
  assert.doesNotMatch(mobileShell, /\.waiting-pill-nav\{/, "Waiting is a door in the capsule now, not its own pill");
});
