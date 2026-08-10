const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

test("browser completion surfaces cannot bypass setTaskCompletion", () => {
  const dir = path.join(__dirname, "public", "js");
  const bypasses = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".js") || name === "block-store.js") continue;
    const source = codeOnly(fs.readFileSync(path.join(dir, name), "utf8"));
    if (/completionIntent\s*:/.test(source)) bypasses.push(name + ": completionIntent");
    if (/updateBlock\([\s\S]{0,300}?status\s*:\s*["']done["']/.test(source)) bypasses.push(name + ": done via updateBlock");
  }
  assert.deepEqual(bypasses, []);
});

test("all known completion surfaces route through the dedicated primitive", () => {
  const required = ["schedule.js", "features.js", "itinerary-calendar.js", "sync.js"];
  for (const name of required) {
    const source = fs.readFileSync(path.join(__dirname, "public", "js", name), "utf8");
    assert.match(source, /setTaskCompletion\s*\(/, name + " must use the dedicated completion primitive");
  }
});
