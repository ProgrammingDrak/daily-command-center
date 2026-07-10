#!/usr/bin/env node
// smoke-ci.mjs — CI-runnable twin of smoke.mjs.
//
// smoke.mjs drives the gstack `browse` daemon (a local-only binary, absent in
// GitHub Actions). This one drives Playwright's Chromium so the SAME
// load-bearing invariants run in CI. Keep the two assertion sets in sync — the
// valuable parts are the 375px overflow check and the console-error assertion.
//
// Boots nothing itself: point it at a running server (default localhost:3987).
// Run:  node scripts/smoke-ci.mjs [baseURL] [user] [pass]
// Requires the chromium binary (CI: `npx playwright-core install chromium`).
// Exits non-zero on the first failed assertion.

import { chromium } from "playwright-core";

/* Browser-context globals referenced inside page.evaluate() callbacks (they run
   in Chromium, not Node). smoke.mjs escapes this by passing browser code as
   strings; here it is real code, so declare the globals for the linter. */
/* global window, document, DCC, KeyboardEvent */

const BASE = process.argv[2] || "http://localhost:3987";
const USER = process.argv[3] || "drake";
const PASS = process.argv[4] || "clever123";
const TABS = ["schedule", "glymphatic", "pet-home", "slots", "runway", "budget"];
// Count an error only if it names a real /public/ asset OR looks like a JS
// exception. HTTP-status/SSE transport errors (the two known pre-existing 404s
// on /api/brain/recent and /api/runway-state) are backend concerns, out of scope.
const APP_ERROR_RX = /\/public\/|TypeError|ReferenceError|SyntaxError|is not defined|is not a function|Uncaught/;

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); failures++; }
}

console.log(`SMOKE(ci): ${BASE}`);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

// Collect console errors + uncaught exceptions across the whole run.
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", (err) => consoleErrors.push(String(err)));

// login (sets the session cookie in this browser context). The seed user is
// created asynchronously on server boot (ensureDefaultUser) and can lag the
// /api/health gate, so retry briefly rather than flake on a cold-start race.
await page.goto(`${BASE}/login`, { waitUntil: "load" });
let loggedIn = false;
for (let attempt = 0; attempt < 10 && !loggedIn; attempt++) {
  if (attempt) await page.waitForTimeout(500);
  loggedIn = await page.evaluate(
    ([u, p]) =>
      fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, password: p })
      }).then((r) => r.json()).then((j) => !!j.ok).catch(() => false),
    [USER, PASS]
  );
}
check("login", loggedIn === true, String(loggedIn));

await page.goto(`${BASE}/`, { waitUntil: "load" });
// Wait for the DCC core to bootstrap rather than a fixed sleep (cold CI runners
// are slower); fall through on timeout so the next check FAILs cleanly.
await page.waitForFunction(() => !!window.DCC, { timeout: 10000 }).catch(() => {});

// core present (short-circuit on window.DCC so a missing core FAILs, not throws)
const core = await page.evaluate(
  () =>
    !!window.DCC &&
    ["esc", "api", "toast"].every((k) => typeof window.DCC[k] === "function") &&
    typeof DCC.dates.todayKey === "function" &&
    typeof DCC.modal === "function" &&
    typeof DCC.sheet === "function" &&
    !!DCC.tabs
);
check("DCC core present", core === true, String(core));

// every tab activates + renders, no horizontal overflow @375
await page.setViewportSize({ width: 375, height: 812 });
for (const tab of TABS) {
  await page.evaluate((t) => { document.querySelector(`[data-tab="${t}"]`)?.click?.(); }, tab);
  const active = await page.evaluate(
    (t) => (document.getElementById(`tab-${t}`)?.classList.contains("active") ? "active" : "inactive"),
    tab
  );
  check(`tab ${tab} activates`, active === "active", active);
  // runway is an iframe; its panel has no text content — skip the render check
  if (tab !== "runway") {
    const rendered = await page.evaluate(
      (t) => (document.getElementById(`tab-${t}`)?.textContent.trim().length || 0) > 10,
      tab
    );
    check(`tab ${tab} renders`, rendered === true);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(`tab ${tab} no h-overflow @375`, overflow === false, String(overflow));
}

// budget tank renders from the live API (aquarium + /api/budget/state shape).
// The aquarium builds after an async fetch of /api/budget/state — poll for it
// rather than a fixed wait, so headless CI timing variance doesn't flake.
await page.evaluate(() => { document.querySelector('[data-tab="budget"]')?.click?.(); });
await page.waitForSelector(".bt-aquarium", { timeout: 6000 }).catch(() => {});
check("budget aquarium renders", (await page.evaluate(() => !!document.querySelector(".bt-aquarium"))) === true);
const budgetState = await page.evaluate(() =>
  fetch("/api/budget/state")
    .then((r) => r.json())
    .then((j) => !!(j.usage && j.settings && Array.isArray(j.blocks)))
    .catch(() => false)
);
check("GET /api/budget/state shape", budgetState === true, String(budgetState));

// overlay primitives open + close (dispatch Escape on document, matching smoke.mjs)
await page.evaluate(() => { window.__smk = DCC.modal({ title: "smoke", body: "x", actions: [{ label: "ok", kind: "primary" }] }); });
check("modal opens", (await page.evaluate(() => !!document.querySelector(".dcc-modal"))) === true);
await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
await page.waitForTimeout(400);
check("modal closes on Escape", (await page.evaluate(() => !document.querySelector(".dcc-modal"))) === true);

// console errors (minus the known-allowlisted 404s)
const unexpected = consoleErrors.filter((l) => APP_ERROR_RX.test(l));
check("no app-code console errors", unexpected.length === 0, unexpected.slice(0, 3).join(" ; "));

await browser.close();
console.log(failures ? `\nSMOKE FAILED (${failures})` : "\nSMOKE PASSED");
process.exit(failures ? 1 : 0);
