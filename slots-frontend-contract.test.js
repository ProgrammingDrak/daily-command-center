const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function loadSlotFrontendHelpers() {
  const source = fs.readFileSync(require.resolve("./public/js/slots.js"), "utf8")
    .replace(
      "window.SlotRewards = {",
      "window.__slotTest = { resultSymbols, winningPositions, rewardSymbol, scrubAccidentalWins }; window.SlotRewards = {"
    );
  const context = {
    console,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem() { return null; },
      setItem() {},
    },
    window: {
      addEventListener() {},
      __state: {},
    },
    document: {
      addEventListener() {},
      querySelectorAll() { return []; },
      querySelector() { return null; },
      getElementById() { return null; },
      createElement() {
        return {
          className: "",
          dataset: {},
          style: { setProperty() {} },
          classList: { add() {}, remove() {}, toggle() {} },
          appendChild() {},
          remove() {},
          querySelector() { return null; },
          querySelectorAll() { return []; },
          addEventListener() {},
          setAttribute() {},
        };
      },
      body: { appendChild() {} },
    },
    CSS: { escape(value) { return String(value); } },
    performance: { now() { return Date.now(); } },
    requestAnimationFrame(callback) { return setTimeout(() => callback(Date.now()), 0); },
  };
  context.window.localStorage = context.localStorage;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.window.__slotTest;
}

test("frontend resultSymbols preserves authoritative backend screen boards", () => {
  const { resultSymbols } = loadSlotFrontendHelpers();
  const board = [
    "MISS", "BANK", "BANK", "BANK", "MISS",
    "MISS", "MISS", "BANK", "MISS", "MISS",
    "JACKPOT", "MISS", "MISS", "MISS", "MISS",
  ];

  assert.deepEqual(
    resultSymbols(
      { id: 101, status: "pending", bank_delta_cents: 154, created_at: "now" },
      { kind: "bank_builder", screen_board: board, bank_screen_payout: { positions: [1, 2, 3, 7] } }
    ),
    board
  );
});

test("frontend winningPositions highlights bank tiles even when reserve payout is capped", () => {
  const { winningPositions } = loadSlotFrontendHelpers();
  const snap = {
    kind: "bank_builder",
    slot_stages: { bank_builder_hit: true, jackpot_hit: false },
    bank_screen_payout: {
      positions: [1, 7, 13],
      cents: 0,
      capped: true,
    },
  };

  assert.deepEqual(winningPositions({ id: 102, status: "pending", bank_delta_cents: 0 }, snap), [1, 7, 13]);
});

test("frontend winningPositions uses backend jackpot paylines exactly", () => {
  const { winningPositions } = loadSlotFrontendHelpers();
  const snap = {
    kind: "free",
    screen_board: [
      "MISS", "MISS", "MISS", "MISS", "MISS",
      "JACKPOT", "JACKPOT", "JACKPOT", "JACKPOT", "MISS",
      "MISS", "MISS", "MISS", "MISS", "MISS",
    ],
    screen_payline: [5, 6, 7, 8],
    slot_stages: {
      jackpot_hit: true,
      jackpot_payline: [5, 6, 7, 8],
    },
  };

  assert.deepEqual(winningPositions({ id: 103, status: "awarded" }, snap), [5, 6, 7, 8]);
});
