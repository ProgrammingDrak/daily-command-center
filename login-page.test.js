const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(require.resolve("./login.html"), "utf8");

test("login page scripts remain syntactically valid", () => {
  const scripts = Array.from(source.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g));
  assert.ok(scripts.length >= 3);
  scripts.forEach(([, attrs, script]) => {
    if (/type=["']module["']/.test(attrs)) {
      const withoutImport = script.replace(/^\s*import\s+[^;]+;\s*/m, "");
      assert.doesNotThrow(() => new Function(`return (async () => {${withoutImport}});`));
    } else {
      assert.doesNotThrow(() => new Function(script));
    }
  });
});

test("Clerk card is constrained to the DCC card at every width", () => {
  assert.match(source, /\.clerk-mount :where\(\.cl-rootBox, \.cl-cardBox, \.cl-card, \.cl-main\)/);
  assert.match(source, /cardBox: \{ width: "100%", maxWidth: "100%", minWidth: "0"/);
  assert.match(source, /header: \{ display: "none" \}/);
  assert.doesNotMatch(source, /querySelector\("\.logo"\)\.style\.display\s*=\s*"none"/);
});

test("OAuth returns directly into the pre-paint verification state", () => {
  const headEnd = source.indexOf("</head>");
  const prePaintMarker = source.indexOf("markOAuthReturnBeforePaint");
  assert.ok(prePaintMarker > 0 && prePaintMarker < headEnd);
  assert.match(source, /returnParams\.set\("auth", "verifying"\)/);
  assert.match(source, /redirectUrl: authReturnUrl/);
  assert.match(source, /html\.auth-verifying \.card \{ display: none; \}/);
  assert.match(source, /role="status" aria-live="polite" aria-busy="true"/);
});

test("verification state recovers instead of hanging when Clerk has no user", () => {
  assert.match(source, /Google did not finish the sign-in\. Please try again\./);
  assert.match(source, /}, 10000\);/);
  assert.match(source, /clearClerkHandoff\(\);[\s\S]*?hideAuthProgress\(\);/);
});
