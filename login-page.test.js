const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(require.resolve("./login.html"), "utf8");

test("login page inline scripts remain syntactically valid", () => {
  const scripts = Array.from(source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g), match => match[1]);
  assert.ok(scripts.length >= 2);
  scripts.forEach(script => assert.doesNotThrow(() => new Function(script)));
});

test("Clerk card is constrained to the DCC card at every width", () => {
  assert.match(source, /\.clerk-mount :where\(\.cl-rootBox, \.cl-cardBox, \.cl-card, \.cl-main\)/);
  assert.match(source, /cardBox: \{ width: "100%", maxWidth: "100%", minWidth: "0"/);
  assert.match(source, /header: \{ display: "none" \}/);
});

test("OAuth returns directly into the pre-paint verification state", () => {
  const headEnd = source.indexOf("</head>");
  const prePaintMarker = source.indexOf("markOAuthReturnBeforePaint");
  assert.ok(prePaintMarker > 0 && prePaintMarker < headEnd);
  assert.match(source, /returnParams\.set\("auth", "verifying"\)/);
  assert.match(source, /forceRedirectUrl: authReturnUrl/);
  assert.match(source, /html\.auth-verifying \.card \{ display: none; \}/);
  assert.match(source, /role="status" aria-live="polite" aria-busy="true"/);
});

test("verification state recovers instead of hanging when Clerk has no user", () => {
  assert.match(source, /Google did not finish the sign-in\. Please try again\./);
  assert.match(source, /}, 10000\);/);
  assert.match(source, /clearClerkHandoff\(\);[\s\S]*?hideAuthProgress\(\);/);
});
