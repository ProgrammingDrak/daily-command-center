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
  assert.match(source, /#clerkSignIn \.cl-signIn-start :where\(\.cl-header, \.cl-form, \.cl-dividerRow, \.cl-footer\)/);
  assert.doesNotMatch(source, /querySelector\("\.logo"\)\.style\.display\s*=\s*"none"/);
});

test("managed and credential login methods share one visible card", () => {
  assert.match(source, /<section id="managedAuth"[\s\S]*?<div id="clerkSignIn"/);
  assert.match(source, /or use your username or email/);
  assert.match(source, /<form id="authForm">/);
  assert.doesNotMatch(source, /legacyForm\.style\.display\s*=\s*"none"/);
  assert.doesNotMatch(source, /tabsEl\.style\.display\s*=\s*"none"/);
});

test("register mode returns the shared credential field to username-only copy", () => {
  assert.match(source, /usernameLabel\.textContent = isRegister \? "Username" : "Username or email"/);
  assert.match(source, /usernameInput\.placeholder = isRegister \? "drake" : "drake or you@example\.com"/);
  assert.match(source, /clerkDividerText\.textContent = isRegister \? "or create with a username" : "or use your username or email"/);
});

test("Clerk contributes only the provider row at start and preserves continuation forms", () => {
  assert.match(source, /#clerkSignIn \.cl-signIn-start :where\(\.cl-header, \.cl-form, \.cl-dividerRow, \.cl-footer\)/);
  assert.doesNotMatch(source, /form: \{ display: "none" \}/);
  assert.doesNotMatch(source, /dividerRow: \{ display: "none" \}/);
  assert.doesNotMatch(source, /footer: \{ display: "none" \}/);
  assert.match(source, /socialButtonsBlockButton: \{ width: "100%"/);
});

test("unavailable managed auth preserves the credential fallback", () => {
  assert.match(source, /reason === "no-key"/);
  assert.match(source, /managedAuthEl\.hidden = true/);
  assert.match(source, /Google sign-in is temporarily unavailable\. Use your username or email below\./);
});

test("dynamic auth controls expose accessible state", () => {
  assert.match(source, /id="error" role="alert" aria-live="assertive"/);
  assert.match(source, /id="loginTab" aria-pressed="true"/);
  assert.match(source, /togglePw\.setAttribute\("aria-label", isHidden \? "Hide password" : "Show password"\)/);
  assert.match(source, /\.auth-provider-status \{\s*background: #0f1117;\s*border: 1px solid #2d3148;\s*border-radius: 8px;\s*color: #94a3b8;/);
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
