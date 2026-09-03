const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const card = fs.readFileSync(require.resolve("./public/js/itinerary-card.js"), "utf8");
const list = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
const css = fs.readFileSync(require.resolve("./public/css/dashboard.css"), "utf8");

test("owner task surfaces render the durable in-progress class and label", () => {
  assert.match(card, /!guest&&window\.DCC/);
  assert.match(card, /inProgress\?" task-in-progress":""/);
  assert.match(card, /inProgress\?'<span class="task-progress-ring"/);
  assert.match(card, /task-progress-pill[^\n]+In progress/);
  assert.match(list, /isInProgress\(ev,isDoneRow\)/);
  assert.match(list, /inProgress:inProgress/);
  assert.match(list, /metaHtml:metaHtml/);
});

test("guest cards exclude private work-state styling", () => {
  assert.match(card, /var inProgress=!guest&&/);
});

test("the progress highlight pulses and becomes static for reduced motion", () => {
  assert.match(css, /@keyframes task-progress-pulse/);
  assert.match(css, /task-in-progress \.task-progress-ring[^\n]+animation:task-progress-pulse/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)[^\n]+task-in-progress \.task-progress-ring[^\n]+animation:none/);
  assert.match(css, /task-progress-pill[^\n]+color:#0068d1/);
});
