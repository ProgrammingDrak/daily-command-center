const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync("index.html", "utf8");
const budgetSource = fs.readFileSync("public/js/budget.js", "utf8");
const slotsSource = fs.readFileSync("public/js/slots.js", "utf8");
const mobileSource = fs.readFileSync("public/js/mobile-shell.js", "utf8");

test("Slots is embedded as a focused Budget subview", () => {
  assert.doesNotMatch(html, /data-tab="slots"/);
  assert.doesNotMatch(html, /id="tab-slots"/);
  assert.match(html, /id="tab-budget"[\s\S]*id="budget-home"[\s\S]*id="budget-casino"/);
  assert.equal((html.match(/data-slot-section="/g) || []).length, 5);
  assert.match(html, /id="budget-casino-back"/);
});

test("Money Changer owns the casino entry and return flow", () => {
  assert.match(budgetSource, /data-act="open-casino"[^>]*>🎰 Feeling lucky\?\?<\/button>/);
  assert.match(budgetSource, /1 pt = 1 Bank Unit/);
  assert.match(budgetSource, /constants\.bank_unit_cents/);
  assert.doesNotMatch(budgetSource, /data-role="rate-input"/);
  assert.match(budgetSource, /window\.SlotRewards\.activate\("machine"\)/);
  assert.match(budgetSource, /showBudgetHome\(\{ focus: true \}\)/);
});

test("Budget entry is purchase-first and card categories are automatic rollups", () => {
  assert.match(budgetSource, /What do you want to buy\?/);
  assert.match(budgetSource, /Dinner for me and Fae/);
  assert.match(budgetSource, /Auto: /);
  assert.match(budgetSource, /classifyPurchase/);
  assert.match(budgetSource, /Planned purchases/);
  assert.doesNotMatch(budgetSource, /\+ add category \/ item/);
  assert.doesNotMatch(budgetSource, /data-role="cat-name"/);
});

test("Reward Vault is a keyboard-contained Budget drawer", () => {
  assert.match(budgetSource, /role="dialog" aria-modal="true" aria-labelledby="rv-title"/);
  assert.match(budgetSource, /data-act="vault-open"/);
  assert.match(budgetSource, /e\.key === "Escape" && _vaultOpen/);
  assert.match(budgetSource, /e\.key === "Tab" && _vaultOpen/);
  assert.match(budgetSource, /requestAnimationFrame\(\(\) => root\.querySelector\('\[data-act="vault-open"\]'\)\?\.focus\(\)\)/);
});

test("Reward Vault integrates checkpoints into cards and keeps sponsor access compact", () => {
  assert.doesNotMatch(budgetSource, /<section class="rv-milestones"/);
  assert.match(budgetSource, /rv-card-checkpoint/);
  assert.match(budgetSource, /rv-card--mystery/);
  assert.match(budgetSource, /class="rv-sponsor-share"/);
  assert.match(budgetSource, />Create link<\/button>/);
});

test("Reward Vault groups cards by type and filters by type plus card category", () => {
  assert.match(budgetSource, /new Set\(\["purchase", "free", "sponsored"\]\)/);
  assert.match(budgetSource, /id: "type", label: "Type", plural: "types"/);
  assert.match(budgetSource, /id: "category", label: "Category", plural: "categories"/);
  assert.match(budgetSource, /credit_card_categories/);
  assert.match(budgetSource, /data-role="vault-filter-option"/);
  assert.match(budgetSource, /vaultCardCategory/);
  assert.match(budgetSource, /rv-card-category/);
  assert.match(budgetSource, /rv-category-section rv-category-section--/);
  assert.match(budgetSource, /type\.id === "free" \? mysteryMarkers\.map\(mysteryCheckpointCard\)/);
  assert.doesNotMatch(budgetSource, /data-act="vault-category-menu"/);
});

test("Slots targets the embedded casino and mobile navigation targets Budget", () => {
  assert.match(slotsSource, /getElementById\("budget-casino"\)/);
  assert.doesNotMatch(slotsSource, /getElementById\("tab-slots"\)/);
  assert.doesNotMatch(slotsSource, /getElementById\("slots-tab-btn"\)/);
  assert.match(mobileSource, /key:"budget",\s+label:"Budget",\s+icon:"💰"/);
  assert.doesNotMatch(mobileSource, /activateTab\("slots"\)/);
});

test("Casino rewards are filtered from canonical Vault definitions", () => {
  assert.match(fs.readFileSync("slot-store.js", "utf8"), /const casinoRewardRows = rewardRows\.filter\(isCasinoVaultDefinition\)/);
  assert.match(fs.readFileSync("slot-store.js", "utf8"), /row\.tank_position == null/);
  assert.match(fs.readFileSync("slot-store.js", "utf8"), /row\.vault_random_draw !== false/);
});
