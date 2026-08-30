#!/usr/bin/env node

// Review-only browser walkthrough. It does not perform destructive actions.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

/* global window, document, getComputedStyle */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const base = process.argv[2] || "http://localhost:8090";
const user = process.argv[3] || "drake";
const pass = process.argv[4] || "clever123";
const snapshotDir = path.join(root, "test-results", "ui-review");
const widths = [320, 480, 760, 1024, 1440];
const tabs = ["schedule", "pet-home", "budget", "social", "vault"];
const candidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
fs.mkdirSync(snapshotDir, { recursive: true });

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
    failures += 1;
  }
}

async function noPageOverflow(page, label) {
  const result = await page.evaluate(() => ({
    viewport: window.innerWidth,
    width: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll("body *")]
      .map((node) => {
        const box = node.getBoundingClientRect();
        return { tag: node.tagName, id: node.id, className: node.className, left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) };
      })
      .filter((box) => box.left < -1 || box.right > window.innerWidth + 1)
      .slice(0, 6),
  }));
  check(`${label} has no page overflow`, result.width <= result.viewport + 1, JSON.stringify(result));
}

async function visibleTouchTargets(page, label) {
  const undersized = await page.evaluate(() => [...document.querySelectorAll("button, a, input, select, textarea")]
    .filter((node) => {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    })
    .filter((node) => {
      const box = node.getBoundingClientRect();
      return box.width < 44 || box.height < 44;
    })
    .slice(0, 8)
    .map((node) => ({ id: node.id, className: node.className, label: node.getAttribute("aria-label") || node.textContent.trim().slice(0, 30), width: Math.round(node.getBoundingClientRect().width), height: Math.round(node.getBoundingClientRect().height) })));
  check(`${label} touch targets are at least 44 pixels`, undersized.length === 0, JSON.stringify(undersized));
}

async function login(page) {
  await page.goto(`${base}/login`, { waitUntil: "load" });
  const ok = await page.evaluate(([username, password]) => fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  }).then((response) => response.json()).then((result) => Boolean(result.ok)).catch(() => false), [user, pass]);
  check("login", ok);
  return ok;
}

console.log(`UI REVIEW: ${base}`);
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.stack || String(error)));

if (await login(page)) {
  await page.evaluate(() => fetch("/api/review/reset", { method: "POST" }).catch(() => null));
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForFunction(() => Boolean(window.DCC?.shell && window.DCC?.overlay && window.DCC?.collection), { timeout: 15000 }).catch(() => {});
  check("shared interfaces load", await page.evaluate(() => Boolean(window.DCC?.shell?.activate && window.DCC?.overlay?.open && window.DCC?.collection?.mount)));
  check("Runway is absent", await page.locator('[data-tab="runway"], #tab-runway').count() === 0);
  check("Brief is absent from primary navigation", await page.locator('[data-tab="glymphatic"], #tab-glymphatic').count() === 0);

  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: width === 320 ? 760 : 1000 });
    await page.locator("#save-status").click();
    check(`save details expose Brief at ${width}`, await page.getByRole("button", { name: "Open Brief", exact: true }).count() === 1);
    await page.getByRole("button", { name: "Open Brief", exact: true }).click();
    await page.waitForTimeout(220);
    check(`Brief opens as one modal at ${width}`, await page.locator('.dcc-overlay[data-overlay-kind="modal"] #glymphatic-brief-root').count() === 1);
    const briefBounds = await page.locator(".dcc-brief-reader").evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: window.innerWidth, height: window.innerHeight };
    });
    check(`Brief fits the viewport at ${width}`, briefBounds.left >= 0 && briefBounds.right <= briefBounds.width && briefBounds.top >= 0 && briefBounds.bottom <= briefBounds.height, JSON.stringify(briefBounds));
    await noPageOverflow(page, `Brief modal at ${width}`);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".dcc-brief-reader"));
    check(`Brief restores save-status focus at ${width}`, await page.evaluate(() => document.activeElement?.id === "save-status"));
  }

  for (const width of widths) {
    await page.setViewportSize({ width, height: width <= 480 ? 900 : 1000 });
    check(`closed Task Manager stays hidden at ${width}`, await page.locator("#tasks-drawer .side-drawer-body").evaluate((node) => getComputedStyle(node).visibility === "hidden" || node.getBoundingClientRect().left >= window.innerWidth || node.getBoundingClientRect().top >= window.innerHeight));
    for (const tab of tabs) {
      await page.locator(`[data-tab="${tab}"]`).click();
      await page.waitForTimeout(80);
      check(`${tab} activates at ${width}`, await page.locator(`#tab-${tab}`).evaluate((node) => node.classList.contains("active")));
      await noPageOverflow(page, `${tab} at ${width}`);
      await visibleTouchTargets(page, `${tab} at ${width}`);
      await page.evaluate(() => { document.documentElement.style.zoom = "200%"; });
      await noPageOverflow(page, `${tab} at ${width} and 200 percent zoom`);
      await visibleTouchTargets(page, `${tab} at ${width} and 200 percent zoom`);
      await page.evaluate(() => { document.documentElement.style.zoom = ""; });
      await page.screenshot({ path: path.join(snapshotDir, `${width}-${tab}.png`), fullPage: true });
    }
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('[data-tab="schedule"]').click();

  const utilityButton = page.locator("#dcc-settings-button");
  await utilityButton.focus();
  await utilityButton.click();
  check("utilities menu opens", await page.locator("#dcc-settings-wrap").evaluate((node) => node.classList.contains("open")));
  await page.keyboard.press("Escape");

  await page.locator("#dcc-launcher-btn").click();
  check("quick add opens", await page.locator("#dcc-compose").evaluate((node) => node.classList.contains("open")));
  check("quick add identifies itself as a modal", await page.locator("#dcc-compose").evaluate((node) => node.getAttribute("role") === "dialog" && node.getAttribute("aria-modal") === "true"));
  check("quick add makes the page inert", await page.locator(".header").evaluate((node) => node.inert));
  await page.keyboard.press("Shift+Tab");
  check("quick add traps reverse focus", await page.evaluate(() => document.activeElement?.id === "dcc-launcher-btn"));
  await page.keyboard.press("Tab");
  check("quick add traps forward focus", await page.evaluate(() => document.activeElement?.closest("#dcc-compose") !== null));
  await page.locator("#task-add-launcher .tab-title").fill("Review quick-add task");
  await page.locator("#task-add-launcher .tab-add").click();
  await page.waitForTimeout(150);
  check("successful quick add restores launcher focus", await page.evaluate(() => document.activeElement?.id === "dcc-launcher-btn"));
  check("quick add appears in the itinerary", await page.locator("#tab-schedule").getByText("Review quick-add task", { exact: true }).count() > 0);
  const quickAddRow = page.locator("#list-view .it-list-item").filter({ hasText: "Review quick-add task" }).first();
  check("List rows omit redundant duration", !(await quickAddRow.locator(".it-list-meta").innerText()).includes("30m"));
  const privacyBadge = await quickAddRow.locator(".it-list-privacy").evaluate((button) => {
    const target = button.getBoundingClientRect();
    const pill = button.querySelector("span")?.getBoundingClientRect();
    return { targetHeight: target.height, pillHeight: pill?.height || 0 };
  });
  check("List privacy uses a compact visual pill", privacyBadge.pillHeight <= 24, JSON.stringify(privacyBadge));
  check("List privacy keeps a 44 pixel touch target", privacyBadge.targetHeight >= 44, JSON.stringify(privacyBadge));
  const completionRail = await quickAddRow.evaluate((row) => {
    const button = row.querySelector(".quick-complete-control");
    const target = button?.getBoundingClientRect();
    const visual = button ? getComputedStyle(button, "::before") : null;
    return {
      controls: row.querySelectorAll(".it-list-check-col button").length,
      lightning: button?.textContent?.includes("⚡") || false,
      instructions: button?.getAttribute("title") || "",
      targetHeight: target?.height || 0,
      visualWidth: visual ? Number.parseFloat(visual.width) : 0,
    };
  });
  check("List completion rail contains one control", completionRail.controls === 1, JSON.stringify(completionRail));
  check("List completion control uses the lightning bolt", completionRail.lightning, JSON.stringify(completionRail));
  check("List lightning keeps a 44 pixel touch target", completionRail.targetHeight >= 44, JSON.stringify(completionRail));
  check("List lightning visual stays compact", completionRail.visualWidth <= 28, JSON.stringify(completionRail));
  check("List lightning explains click and hold", completionRail.instructions.includes("Click") && completionRail.instructions.includes("Hold"), JSON.stringify(completionRail));
  await quickAddRow.locator(".btn-task-radial").click();
  check("Task Actions omit duplicate quick completion", await page.locator(".dest-radial-label").filter({ hasText: "Complete without notes" }).count() === 0);
  await page.keyboard.press("Escape");
  const completionButton = quickAddRow.locator(".quick-complete-control");
  const pointer = { button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true };
  await completionButton.dispatchEvent("pointerdown", pointer);
  await page.waitForTimeout(650);
  check("Holding lightning opens completion notes", await page.locator("#done-modal-overlay").evaluate((node) => node.classList.contains("open")));
  await completionButton.dispatchEvent("pointerup", pointer);
  await page.locator("#done-modal-cancel").click();
  check("Cancelling held completion leaves task open", !(await quickAddRow.evaluate((row) => row.classList.contains("done"))));
  await completionButton.click();
  await page.waitForTimeout(150);
  check("Clicking lightning quick completes", await quickAddRow.evaluate((row) => row.classList.contains("done")));
  check("quick add closes after creation", await page.locator("#dcc-compose").evaluate((node) => !node.classList.contains("open")));
  await page.locator("#dcc-launcher-btn").click();
  await page.keyboard.press("Escape");
  check("quick add restores focus after Escape", await page.evaluate(() => document.activeElement?.id === "dcc-launcher-btn"));

  await utilityButton.click();
  await page.locator("#sn-open-btn").click();
  check("Notes workspace opens", await page.locator("#sn-overlay").evaluate((node) => node.classList.contains("open")));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("sn-overlay")?.classList.contains("open"));

  await page.setViewportSize({ width: 900, height: 1000 });
  await page.evaluate(() => window.openTasksDrawer?.());
  check("Task Manager opens", await page.locator("#tasks-drawer").evaluate((node) => node.classList.contains("open")));
  check("Task Manager omits its duplicate task composer", await page.locator("#task-add-menus").count() === 0);
  check("Quick add stays visible with Task Manager", await page.locator("#dcc-launcher-btn").isVisible());
  const quickAddPlacement = await page.evaluate(() => {
    const launcher = document.getElementById("dcc-launcher")?.getBoundingClientRect();
    const drawer = document.querySelector("#tasks-drawer .side-drawer-body")?.getBoundingClientRect();
    return launcher && drawer ? { launcherRight: launcher.right, drawerLeft: drawer.left } : null;
  });
  check("Quick add moves beside Task Manager", !!quickAddPlacement && quickAddPlacement.launcherRight <= quickAddPlacement.drawerLeft - 8, JSON.stringify(quickAddPlacement));
  await page.locator("#dcc-launcher-btn").click();
  check("Quick add opens above Task Manager", await page.locator("#dcc-compose").evaluate((node) => node.classList.contains("open")));
  const mediumComposer = await page.locator("#dcc-compose").evaluate((node) => {
    const box = node.getBoundingClientRect();
    return { left: box.left, right: box.right, width: box.width, viewport: window.innerWidth };
  });
  check("Quick add stays on-screen beside a medium Task Manager", mediumComposer.left >= 0 && mediumComposer.right <= mediumComposer.viewport, JSON.stringify(mediumComposer));
  check("Task Manager stays open with Quick add", await page.locator("#tasks-drawer").evaluate((node) => node.classList.contains("open")));
  await page.keyboard.press("Escape");
  check("Escape closes Quick add before Task Manager", await page.locator("#tasks-drawer").evaluate((node) => node.classList.contains("open")));
  await page.evaluate(() => window.openTasksToRepeatResponsibilities?.());
  check("Repeat opens inside Task Manager", await page.locator("#tasks-drawer").evaluate((node) => node.dataset.soloSection === "tm-repeat-responsibilities-section"));
  await page.locator("#repeat-responsibilities-new").click();
  check("Repeat editor uses internal workspace", await page.locator("#tm-repeat-responsibilities-section .repeat-workspace").evaluate((node) => node.classList.contains("editing")));
  await page.locator("#resp-cancel").click();
  await page.locator("#tasks-drawer-close").click();
  await page.setViewportSize({ width: 1440, height: 1000 });

  check("Loose Ends does not auto-open", !(await page.evaluate(() => document.getElementById("catchup-overlay")?.classList.contains("open"))));

  const task = page.locator("#list-view .it-list-item").first();
  if (await task.count()) {
    await page.evaluate(() => document.activeElement?.blur());
    await task.locator(".it-list-main").click().catch(() => {});
    if (await page.locator("#add-modal-overlay").evaluate((node) => node.classList.contains("open"))) {
      check("Task Details identifies itself as a modal", await page.locator("#add-modal-overlay .add-modal").evaluate((node) => node.getAttribute("role") === "dialog" && node.getAttribute("aria-modal") === "true"));
      check("Task Details makes the page inert", await page.locator(".header").evaluate((node) => node.inert));
      check("Task Details starts in read mode", await page.locator("#add-modal-edit").isVisible());
      await page.locator('[data-am-tab="notes"]').click();
      check("Task Details read mode blocks note editing", await page.locator("#am-notes-block-editor [contenteditable]").first().evaluate((node) => node.getAttribute("contenteditable") === "false"));
      for (let index = 0; index < 12; index += 1) await page.keyboard.press("Tab");
      check("Task Details traps focus", await page.evaluate(() => document.activeElement?.closest("#add-modal-overlay") !== null));
      await page.locator("#add-modal-edit").click();
      check("Task Details enters edit mode explicitly", await page.locator("#add-modal-save").isVisible());
      const renameControl = await page.locator("#add-modal-title").evaluate((node) => ({
        role: node.getAttribute("role"),
        tabIndex: node.tabIndex,
        height: node.getBoundingClientRect().height,
      }));
      check("Task title rename is keyboard and touch accessible", renameControl.role === "button" && renameControl.tabIndex === 0 && renameControl.height >= 44, JSON.stringify(renameControl));
      await page.locator("#add-modal-title").focus();
      await page.keyboard.press("Enter");
      check("Enter opens task title rename", await page.locator(".am-title-edit").count() === 1);
      await page.keyboard.press("Escape");
      await page.locator("#add-modal-cancel-edit").click();
      await page.locator("#add-modal-close").click();
      await page.waitForTimeout(50);
      check("Task Details restores focus", await page.evaluate(() => document.activeElement?.closest(".it-list-item") !== null));
    }
  }

  for (const view of ["list", "calendar", "actual"]) {
    await page.locator(`[data-view="${view}"]`).first().click();
    check(`${view} schedule view activates`, await page.locator(`[data-view="${view}"]`).first().evaluate((node) => node.classList.contains("active")));
  }

  await page.locator('[data-tab="budget"]').click();
  check("Budget exposes five interactive financial cards", await page.locator(".bt-finance-card").count() === 5);
  check("Budget removes the duplicate income editor", await page.locator("#bt-income-input").count() === 0);
  check("Budget removes the redundant section bar", await page.locator(".bt-section-nav").count() === 0);
  check("Budget removes the planned-purchases panel", await page.getByText("Planned purchases", { exact: true }).count() === 0);
  const discretionarySummary = (await page.locator('[data-card="discretionary"] strong').innerText()).replace(/\s+/g, " ").trim();
  check("Discretionary Spending shows budgeted purchases against its maximum", discretionarySummary === "$200.00 / $2500.00 BUDGETED", discretionarySummary);
  const tankStage = await page.locator(".bt-main--tank").evaluate((node) => {
    const changer = node.querySelector(".bt-changer-col")?.getBoundingClientRect();
    const tank = node.querySelector(".bt-tank-col")?.getBoundingClientRect();
    return { changerRight: changer?.right || 0, tankLeft: tank?.left || 0, changerTop: changer?.top || 0, tankTop: tank?.top || 0 };
  });
  check("Money Changer sits directly left of the tank", tankStage.changerRight <= tankStage.tankLeft && Math.abs(tankStage.changerTop - tankStage.tankTop) < 2, JSON.stringify(tankStage));
  const tankBeforeConversion = await page.locator(".bt-aquarium").evaluate((node) => ({
    label: node.getAttribute("aria-label"),
    waterHeight: node.querySelector('[data-role="tank-water"]')?.getBoundingClientRect().height || 0,
    openWater: node.querySelector(".bt-open-water strong")?.textContent,
  }));
  check("Tank ceiling equals Income", tankBeforeConversion.label.includes("Income capacity $5000.00"), JSON.stringify(tankBeforeConversion));
  check("Tank floor combines expenses and savings", tankBeforeConversion.label.includes("commit $2500.00"), JSON.stringify(tankBeforeConversion));
  check("Open water equals the unconverted discretionary reserve", tankBeforeConversion.openWater === "$2500.00", JSON.stringify(tankBeforeConversion));
  const expenseFloorRatio = await page.locator(".bt-aquarium").evaluate((node) => node.querySelector(".bt-reef").getBoundingClientRect().height / node.getBoundingClientRect().height);
  check("Absolute expenses use a lower visual floor", expenseFloorRatio >= 0.14 && expenseFloorRatio <= 0.18, String(expenseFloorRatio));
  await page.locator('[data-role="convert-amt"]').fill("10");
  await page.locator('[data-act="convert"]').click();
  await page.waitForTimeout(120);
  const tankAfterConversion = await page.locator(".bt-aquarium").evaluate((node) => ({
    waterHeight: node.querySelector('[data-role="tank-water"]')?.getBoundingClientRect().height || 0,
    openWater: node.querySelector(".bt-open-water strong")?.textContent,
    coins: node.querySelectorAll(".bt-falling-coin").length,
    label: node.getAttribute("aria-label"),
  }));
  check("Converted Bank Units raise the water", tankAfterConversion.waterHeight > tankBeforeConversion.waterHeight, JSON.stringify(tankAfterConversion));
  check("A conversion produces falling coins", tankAfterConversion.coins === 10, JSON.stringify(tankAfterConversion));
  check("Open water decreases by the converted value", tankAfterConversion.openWater === "$2490.00", JSON.stringify(tankAfterConversion));
  check("Tank exposes exact reserve values without color", tankAfterConversion.label.includes("Reward Reserve contains $10.00"), JSON.stringify(tankAfterConversion));
  const persistentCoinsBeforeReload = await page.locator('[data-role="tank-coins"]').evaluate((node) => node.getBoundingClientRect().height);
  await page.evaluate(() => window.Budget.reload());
  await page.waitForTimeout(100);
  const persistentCoinsAfterReload = await page.locator('[data-role="tank-coins"]').evaluate((node) => node.getBoundingClientRect().height);
  check("Converted coins persist visibly after reloading Budget state", persistentCoinsBeforeReload >= 18 && persistentCoinsAfterReload >= 18, JSON.stringify({ persistentCoinsBeforeReload, persistentCoinsAfterReload }));
  await page.locator('[data-card="income"]').click();
  check("Income opens in the shared drawer", await page.locator('.dcc-overlay-title').textContent() === "Income");
  await page.locator('[data-finance-add="income"]').click();
  check("Income accepts source and amount rows", await page.locator('[data-finance-field="amount"]').count() >= 1);
  await page.locator('.dcc-overlay-btn--secondary').click();
  await page.locator('[data-card="expenses"]').click();
  await page.locator('[data-finance-add="expense"]').click();
  await page.locator('[data-finance-field="expense-type"]').last().selectOption("variable");
  await page.locator('[data-finance-field="min"]').last().fill("80");
  await page.locator('[data-finance-field="max"]').last().fill("120");
  check("Variable expenses display their average", (await page.locator('.bt-finance-average').last().textContent()).includes("$100.00"));
  await page.locator('.dcc-overlay-btn--secondary').click();
  await page.locator('[data-card="expenses"]').click();
  await page.locator('[data-finance-add="expense"]').click();
  const zeroAmount = page.locator('[data-finance-field="amount"]').last();
  await zeroAmount.click();
  await zeroAmount.pressSequentially("5000");
  check("Typing replaces a zero-valued number", await zeroAmount.inputValue() === "5000", await zeroAmount.inputValue());
  await page.locator('.dcc-overlay-btn--secondary').click();
  await page.locator('[data-card="discretionary"]').click();
  check("Discretionary editor keeps specific purchases", await page.locator('[data-finance-purchase-form]').count() === 1);
  check("Discretionary editor supports flexible point categories", await page.locator('[data-finance-add="category"]').count() === 1);
  await page.locator('.dcc-overlay-btn--secondary').click();
  await page.locator('[data-card="reserve"]').click();
  check("Reserve shows completed tasks through the collection pattern", await page.locator('[data-finance-completed].dcc-collection').count() === 1);
  await page.locator('.dcc-overlay-close').click();
  await page.locator('[data-act="vault-open"]').click();
  await page.waitForTimeout(80);
  const rewardLayers = await page.evaluate(() => ({
    drawer: Number.parseInt(getComputedStyle(document.querySelector(".rv-backdrop")).zIndex, 10),
    tabs: Number.parseInt(getComputedStyle(document.querySelector(".tabs")).zIndex, 10),
    header: Number.parseInt(getComputedStyle(document.querySelector(".header")).zIndex, 10),
    blur: getComputedStyle(document.querySelector(".rv-backdrop")).backdropFilter,
    legacyOpen: document.body.classList.contains("dcc-legacy-overlay-open"),
  }));
  check("Reward Vault covers sticky navigation", rewardLayers.drawer > Math.max(rewardLayers.tabs, rewardLayers.header), JSON.stringify(rewardLayers));
  check("Reward Vault blurs the background", rewardLayers.blur !== "none", JSON.stringify(rewardLayers));
  check("Reward Vault registers as a blocking legacy overlay", rewardLayers.legacyOpen, JSON.stringify(rewardLayers));
  await page.locator('[data-act="vault-close"]').click();

  await page.locator('[data-tab="social"]').click();
  for (const section of ["publish", "inbox", "friends", "feed", "access"]) {
    await page.locator(`[data-social-tab="${section}"]`).click();
    check(`Social ${section} opens`, await page.locator(".social-grid").evaluate((node, value) => node.dataset.socialActive === value, section));
  }

  await page.locator('[data-tab="vault"]').click();
  for (const view of ["explorer", "timeline", "graph"]) {
    await page.locator(`#vault-viewtoggle [data-view="${view}"]`).click();
    check(`Mycelium ${view} opens`, await page.locator(`#vault-viewtoggle [data-view="${view}"]`).evaluate((node) => node.classList.contains("active")));
  }

  for (const kind of ["popover", "modal", "drawer", "sheet"]) {
    await page.evaluate((overlayKind) => {
      window.__uiReviewTrigger = document.getElementById("vault-tab-btn");
      window.__uiReviewTrigger.focus();
      window.__uiReviewOverlay = window.DCC.overlay.open({ kind: overlayKind, title: `${overlayKind} review`, body: "Deterministic review content", anchor: window.__uiReviewTrigger, actions: [{ label: "Close", kind: "primary" }] });
    }, kind);
    check(`${kind} opens`, await page.locator(`[data-overlay-kind="${kind}"]`).count() === 1);
    await page.keyboard.press("Escape");
    await page.waitForFunction((overlayKind) => !document.querySelector(`[data-overlay-kind="${overlayKind}"]`), kind);
    check(`${kind} closes`, await page.locator(`[data-overlay-kind="${kind}"]`).count() === 0);
    check(`${kind} restores focus`, await page.evaluate(() => document.activeElement?.id === "vault-tab-btn"));
  }

  await page.evaluate(() => {
    const trigger = document.getElementById("vault-tab-btn");
    window.__uiReviewFirst = window.DCC.overlay.open({ kind: "modal", title: "First", body: "First overlay", anchor: trigger });
    window.__uiReviewSecond = window.DCC.overlay.open({ kind: "drawer", title: "Second", body: "Replacement overlay", anchor: trigger });
  });
  check("a blocking overlay replaces the previous overlay", await page.locator('[data-overlay-kind="modal"]').count() === 0 && await page.locator('[data-overlay-kind="drawer"]').count() === 1);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[data-overlay-kind="drawer"]'));
  check("replacement overlay cleanup restores the page", await page.evaluate(() => !window.DCC.overlay.activeBlocking && !document.querySelector(".header")?.inert));

  await page.setViewportSize({ width: 320, height: 900 });
  await page.locator('[data-tab="schedule"]').click();
  const mobileSticky = await page.evaluate(async () => {
    const pill = document.getElementById("loose-ends-pill");
    pill.hidden = false;
    await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
    const header = document.querySelector(".header").getBoundingClientRect();
    const tabs = document.querySelector(".tabs").getBoundingClientRect();
    pill.hidden = true;
    return { headerBottom: header.bottom, tabsTop: tabs.top };
  });
  check("mobile sticky tabs clear a wrapped header", mobileSticky.tabsTop >= mobileSticky.headerBottom - 1, JSON.stringify(mobileSticky));

  await page.locator('[data-tab="schedule"]').click();
}

for (const route of ["/login", "/admin", "/public-todo.html?token=review-invalid", "/public-pet.html?token=review-invalid"]) {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`${base}${route}`, { waitUntil: "load" });
  await page.waitForTimeout(150);
  await noPageOverflow(page, route);
  await page.screenshot({ path: path.join(snapshotDir, `standalone-${route.split(/[/?]/).filter(Boolean)[0]}.png`), fullPage: true });
}

check("no uncaught browser errors", pageErrors.length === 0, pageErrors.slice(0, 5).join(" | "));
await browser.close();
console.log(failures ? `UI REVIEW FAILED (${failures})` : "UI REVIEW PASSED");
process.exit(failures ? 1 : 0);
