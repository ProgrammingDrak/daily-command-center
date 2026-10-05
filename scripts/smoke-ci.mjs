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
/* global window, document, DCC, KeyboardEvent, getComputedStyle */

const BASE = process.argv[2] || "http://localhost:3987";
const USER = process.argv[3] || "drake";
const PASS = process.argv[4] || "clever123";
const TABS = ["schedule", "pet-home", "budget"];
// Count an error only if it names a real /public/ asset OR looks like a JS
// exception. HTTP-status/SSE transport errors (the two known pre-existing 404s
// on /api/brain/recent) are backend concerns, out of scope.
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

// The smoke owns product behavior after onboarding. Suppress the tutorial in
// this disposable test account so its timed launch cannot intercept later clicks.
const onboardingSuppressed = await page.evaluate(() =>
  fetch("/api/me/onboarding", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dailyCommandCenterTour: {
        version: 2,
        dismissedAt: new Date().toISOString()
      }
    })
  }).then((response) => response.ok).catch(() => false)
);
check("onboarding tutorial suppressed", onboardingSuppressed === true, String(onboardingSuppressed));

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
  const rendered = await page.evaluate(
    (t) => (document.getElementById(`tab-${t}`)?.textContent.trim().length || 0) > 10,
    tab
  );
  check(`tab ${tab} renders`, rendered === true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(`tab ${tab} no h-overflow @375`, overflow === false, String(overflow));
}

// Loose Ends is count-gated, so expose it just for layout measurement: the
// capsule must fit its widest state, all five doors, on one phone row. The
// catch-up unit tests own the count/hidden behavior; this browser smoke owns the
// real mobile header cascade and viewport geometry.
await page.evaluate(() => { document.querySelector('[data-tab="schedule"]')?.click?.(); });
const capsuleMobile = await page.evaluate(() => {
  const pill = document.getElementById("loose-ends-pill");
  const capsule = document.getElementById("queue-pill");
  const nav = document.getElementById("date-nav");
  if (!pill || !capsule || !nav) return null;
  const wasHidden = pill.hidden;
  pill.hidden = false;
  const capsuleBox = capsule.getBoundingClientRect();
  const navBox = nav.getBoundingClientRect();
  const doors = [...capsule.querySelectorAll(".queue-seg")];
  const doorBoxes = doors.map((door) => door.getBoundingClientRect());
  const otherBottoms = [...nav.children]
    .filter((child) => child !== capsule && getComputedStyle(child).display !== "none")
    .map((child) => child.getBoundingClientRect().bottom);
  const result = {
    looseEndsVisible: getComputedStyle(pill).display !== "none" && pill.getBoundingClientRect().width > 0,
    // Triage, Loose Ends, Waiting, Unscheduled and Whenever are ONE capsule on ONE row
    // of its own, so the phone header stays as tall as it was, and every label shows.
    fiveDoorsInOrder: doors.map((door) => door.id).join() === "triage-pill-nav,loose-ends-pill,waiting-pill-nav,unscheduled-pill-nav,whenever-pill-nav",
    dedicatedRow: capsuleBox.top >= Math.max(...otherBottoms),
    doorsShareOneRow: doorBoxes.every((door) => Math.abs(door.top - doorBoxes[0].top) < 1),
    capsuleFillsNav: capsuleBox.width >= navBox.width - 1,
    capsuleInsideViewport: capsuleBox.left >= 0 && capsuleBox.right <= window.innerWidth,
    capsuleLabelsUnclipped: doors.every((door) => { const label = door.querySelector("span:first-child"); return label.scrollWidth <= label.clientWidth; }),
    doorsTouchHeight: doorBoxes.every((door) => door.height >= 44)
  };
  pill.hidden = wasHidden;
  return result;
});
check("queue capsule fits one phone row with all five doors showing", !!capsuleMobile && Object.values(capsuleMobile).every(Boolean), JSON.stringify(capsuleMobile));

// The reorder drop indicator must actually PAINT. It is a pseudo-element pushed
// fully outside the row box, so `overflow:hidden` on the row erases it while
// every unit test stays green: dOver puts the right class on the right row and
// CSS then eats the paint. That shipped (ui-optimization.css added the clip in
// #342) and drag-to-reschedule lost all reorder feedback on web AND mobile.
// Asserted at both widths because the clip rule carries no media query.
for (const width of [375, 1280]) {
  await page.setViewportSize({ width, height: 812 });
  const indicator = await page.evaluate(() => {
    const list = document.getElementById("list-view");
    if (!list) return null;
    const probe = document.createElement("div");
    probe.className = "it-list-item";
    probe.style.minHeight = "64px";
    list.appendChild(probe);
    const read = (cls, pseudo) => {
      probe.className = "it-list-item " + cls;
      const row = getComputedStyle(probe);
      const bar = getComputedStyle(probe, pseudo);
      return {
        unclipped: row.overflow === "visible",
        // A sibling row would paint over the bottom silhouette without this.
        stacked: row.zIndex !== "auto" && Number(row.zIndex) >= 1,
        // Proves the indicator rule itself still exists and is not transparent.
        tall: parseFloat(bar.height) >= 20,
        painted: bar.backgroundColor !== "rgba(0, 0, 0, 0)" && bar.backgroundColor !== "transparent"
      };
    };
    const result = { top: read("drag-over-top", "::before"), bottom: read("drag-over-bottom", "::after") };
    probe.remove();
    return result;
  });
  const ok = !!indicator && [indicator.top, indicator.bottom].every((side) => side && Object.values(side).every(Boolean));
  check(`reorder drop indicator is visible @${width}`, ok, JSON.stringify(indicator));
}
await page.setViewportSize({ width: 375, height: 812 });

// budget tank renders from the live API (aquarium + /api/budget/state shape).
// The aquarium builds after an async fetch of /api/budget/state — poll for it
// rather than a fixed wait, so headless CI timing variance doesn't flake.
await page.evaluate(() => { document.querySelector('[data-tab="budget"]')?.click?.(); });
await page.waitForSelector(".bt-aquarium", { timeout: 6000 }).catch(() => {});
check("budget aquarium renders", (await page.evaluate(() => !!document.querySelector(".bt-aquarium"))) === true);
const budgetState = await page.evaluate(() =>
  fetch("/api/budget/state")
    .then((r) => r.json())
    .then((j) => !!(j.usage && j.settings && Array.isArray(j.blocks) && j.constants?.bank_units_per_point === 1 && j.constants?.bank_unit_cents >= 1))
    .catch(() => false)
);
check("GET /api/budget/state shape", budgetState === true, String(budgetState));
check("Money Changer uses Bank Units", (await page.evaluate(() => document.querySelector(".bt-changer")?.textContent.includes("1 pt = 1 Bank Unit"))) === true);
// A period rollover prompt can appear on the first Budget visit. Snooze it so
// this smoke check can inspect the purchase form without changing budget data.
const rolloverLater = page.locator('[data-act="rollover-later"]');
if (await rolloverLater.isVisible().catch(() => false)) await rolloverLater.click();
await page.locator('[data-card="discretionary"]').click();
await page.locator('[data-finance-purchase-form] input[name="description"]').fill("Dinner for me and Fae");
await page.locator('[data-finance-purchase-form] input[name="amount"]').fill("100");
await Promise.all([
  page.waitForResponse((response) => response.url().includes("/api/budget/blocks") && response.request().method() === "POST" && response.ok()),
  page.locator('[data-finance-purchase-form] button[type="submit"]').click(),
]);
const plannedPurchaseCategory = await page.evaluate(() => fetch("/api/budget/state").then((response) => response.json()).then((state) => state.blocks.find((block) => block.item === "Dinner for me and Fae")?.category || ""));
check("planned purchase auto-categorizes", plannedPurchaseCategory === "Dining", plannedPurchaseCategory);
await page.keyboard.press("Escape");
check("Slots is not a top-level tab", (await page.evaluate(() => !document.querySelector('[data-tab="slots"]'))) === true);
check("Feeling lucky launcher renders", (await page.evaluate(() => !!document.querySelector('[data-act="open-casino"]'))) === true);
await page.evaluate(() => document.querySelector('[data-act="open-casino"]')?.click());
check("casino opens inside Budget", (await page.evaluate(() => {
  const casino = document.getElementById("budget-casino");
  const home = document.getElementById("budget-home");
  return !!(casino && home && !casino.hidden && home.hidden);
})) === true);
check("all casino sections remain", (await page.evaluate(() => document.querySelectorAll("#budget-casino .slot-section-tab").length)) === 5);
check("all casino sections activate", (await page.evaluate(() => [...document.querySelectorAll("#budget-casino .slot-section-tab")].every((button) => {
  button.click();
  return document.querySelector(`[data-slot-section-panel="${button.dataset.slotSection}"]`)?.classList.contains("active");
}))) === true);
await page.evaluate(() => document.querySelector('[data-slot-section="machine"]')?.click());
check("casino no h-overflow @375", (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) === false);
await page.evaluate(() => document.getElementById("budget-casino-back")?.click());
check("casino returns to Money Changer", (await page.evaluate(() => {
  const casino = document.getElementById("budget-casino");
  const home = document.getElementById("budget-home");
  return !!(casino && home && casino.hidden && !home.hidden);
})) === true);

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
