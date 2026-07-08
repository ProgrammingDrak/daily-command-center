// ======== BUDGET TANK (aquarium) ========
// A real fish tank: the gravel bed is the necessities (bills live under water
// by default), budget blocks are decorations anchored up the back wall at
// their cumulative unlock heights, and the waterline is this period's bank
// build (positive spin deltas + Money Changer conversions). Fish join the
// tank as blocks get claimed. Server is the source of truth
// (/api/budget/state); blocks are slot_rewards rows shared with the machine.
(function () {
  "use strict";

  let _state = null;        // last /api/budget/state payload
  let _editMode = false;
  let _form = null;         // { id|null, category, item, amount, recurring, color }
  let _necDraft = null;     // necessities editor working copy
  let _dragId = null;
  let _confirmDeleteId = null;
  let _loadSeq = 0;
  let _convertKey = null;   // per-attempt idempotency key; reused on retry
  let _convertBusy = false;
  let _rolloverSnoozed = false;

  function esc(s) { return window.DCC.esc(s); }
  function toast(msg, kind) { return window.DCC.toast(msg, kind); }
  function money(c) { return fmtMoney(c); }

  // ---- data ---------------------------------------------------------------
  async function loadBudget() {
    const seq = ++_loadSeq;
    try {
      const res = await fetch("/api/budget/state");
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const data = await res.json();
      if (seq !== _loadSeq) return; // a newer load superseded this one
      _state = data;
    } catch (e) {
      if (seq !== _loadSeq) return;
      _state = { error: e.message || "Could not load the Budget Tank" };
    }
    render();
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  }

  // ---- decorations (inline SVG sprites, tinted via currentColor) ----------
  // Reward blocks are treasure chests (the thing you unlock and open). The
  // necessities reef below is dressed with scenery (castle/coral/plants/rocks/
  // shells) — the pretty stuff on the aquarium floor, already underwater.
  const SPRITES = {
    chest:
      '<svg viewBox="0 0 40 32" class="bt-sprite"><path d="M4 14h32v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill="currentColor"/><path d="M4 14c0-6 7-9 16-9s16 3 16 9z" fill="currentColor" opacity=".75"/><rect x="17" y="12" width="6" height="8" rx="1" fill="#0b1020" opacity=".55"/><path d="M4 14h32" stroke="#0b1020" stroke-opacity=".4" stroke-width="1.5"/></svg>',
    chestOpen:
      '<svg viewBox="0 0 40 32" class="bt-sprite"><path d="M4 16h32v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill="currentColor"/><path d="M5 14C3 7 9 2 20 2s17 5 15 12l-15-3z" fill="currentColor" opacity=".55"/><circle cx="14" cy="13" r="1.6" fill="#ffe08a"/><circle cx="21" cy="11" r="1.6" fill="#ffe08a"/><circle cx="27" cy="13" r="1.6" fill="#ffe08a"/></svg>',
    coral:
      '<svg viewBox="0 0 40 32" class="bt-scenery-svg"><path d="M20 30V12M20 18c-4-1-6-4-6-9M20 15c5-1 7-4 7-10M14 9c0 2 1 3 2 4M27 5c0 3-1 5-3 6" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" fill="none"/></svg>',
    castle:
      '<svg viewBox="0 0 40 32" class="bt-scenery-svg"><path d="M8 30V12l3 2 3-2 3 2V8l3 2 3-2v6l3-2 3 2 3-2v18z" fill="currentColor"/><rect x="18" y="20" width="5" height="10" rx="2" fill="#0b1020" opacity=".5"/><rect x="11" y="17" width="3" height="4" rx="1" fill="#0b1020" opacity=".4"/><rect x="27" y="17" width="3" height="4" rx="1" fill="#0b1020" opacity=".4"/></svg>',
    plant:
      '<svg viewBox="0 0 40 32" class="bt-scenery-svg"><path d="M20 30C20 18 14 12 12 4c6 3 9 9 10 14 1-7 4-12 9-15-2 9-7 14-9 27" fill="currentColor"/></svg>',
    rocks:
      '<svg viewBox="0 0 40 32" class="bt-scenery-svg"><path d="M2 30c2-8 8-12 14-10 3-6 10-7 15-2 4-1 8 2 8 6 0 3-2 6-6 6z" fill="currentColor"/></svg>',
    shell:
      '<svg viewBox="0 0 40 32" class="bt-scenery-svg"><path d="M20 30C8 30 3 16 8 8c3-5 21-5 24 0 5 8 0 22-12 22z" fill="currentColor"/><path d="M20 30V9M20 30c-4 0-8-4-10-9M20 30c4 0 8-4 10-9" stroke="#0b1020" stroke-opacity=".3" stroke-width="1.4" fill="none"/></svg>',
  };
  const SCENERY = ["castle", "coral", "plant", "rocks", "shell"];

  function chestSpriteFor(block) {
    return block.claimed ? SPRITES.chestOpen : SPRITES.chest;
  }

  // The submerged reef of necessities: one scenery sprite per bill, cycling the
  // set, tinted with the bill's color. Always covered — no bank-build needed.
  function reefSceneryMarkup(necessities) {
    return (necessities || []).map((n, i) =>
      '<span class="bt-scenery" style="color:' + esc(n.color || "#8aa0c0") + '" title="' +
        esc(n.name) + " " + money(n.amount_cents) + '">' + SPRITES[SCENERY[i % SCENERY.length]] + "</span>"
    ).join("");
  }

  const FISH_SVG =
    '<svg viewBox="0 0 34 18" class="bt-fish-svg"><path d="M4 9c5-6 13-8 20-4 3 1.5 5 3 7 4-2 1-4 2.5-7 4-7 4-15 2-20-4z" fill="currentColor"/><path d="M4 9L0 4v10z" fill="currentColor" opacity=".8"/><circle cx="24" cy="8" r="1.4" fill="#0b1020"/></svg>';
  const FISH_COLORS = ["#fbbf24", "#fb7185", "#60a5fa", "#4ade80", "#c084fc", "#f97316"];

  // ---- status text ---------------------------------------------------------
  function statusInfo(block, waterline) {
    const bottom = block.tank_unlock_cents - block.value_cents;
    if (block.claimed) return { cls: "bt--claimed", label: "claimed ✓" };
    if (block.status === "claimable") return { cls: "bt--claimable", label: "ready to claim" };
    if (block.status === "short") return { cls: "bt--short", label: "unlocked · reserve short " + money(block.shortfall_cents) };
    if (waterline > bottom && waterline < block.tank_unlock_cents) {
      const pct = Math.round(((waterline - bottom) / (block.value_cents || 1)) * 100);
      return { cls: "bt--filling", label: "filling · " + pct + "%" };
    }
    return { cls: "bt--locked", label: "needs " + money(block.needs_cents) + " more banked" };
  }

  // ---- tank markup ----------------------------------------------------------
  // Geometry: the whole tank height is last period's income. The bottom is the
  // NECESSITIES reef (proportional to their dollar total, always submerged);
  // above it, reward-block chests stack in the discretionary zone (income -
  // necessities), each sized by its dollar value, with open water for the
  // unallocated remainder. Water covers all of the reef plus the banked
  // fraction of the discretionary zone. `.bt-zones` is column-reverse, so the
  // reef (first child) sits at the visual bottom with priority-1 just above it.
  function tankMarkup(s) {
    const u = s.usage;
    const income = Math.max(u.income_cents, u.necessities_total_cents + u.allocated_cents, 1);
    const waterPct = Math.min(100, ((u.necessities_total_cents + u.waterline_cents) / income) * 100);
    const claimedCount = s.blocks.filter(b => b.claimed).length;
    const fishCount = Math.min(6, claimedCount);

    const zones = s.blocks.map(b => {
      const info = statusInfo(b, u.waterline_cents);
      const over = (b.tank_unlock_cents || 0) > u.capacity_cents;
      return '<div class="bt-zone ' + info.cls + (over ? " bt--overcap" : "") + '" draggable="true" data-id="' + b.id + '"' +
        ' style="flex-grow:' + b.value_cents + ';color:' + esc(b.color || "#f59e0b") + '">' +
        '<span class="bt-zone-sprite">' + chestSpriteFor(b) + "</span>" +
        '<div class="bt-zone-body">' +
          '<div class="bt-zone-top"><span class="bt-zone-name">' + esc(b.title) + "</span>" +
          '<span class="bt-zone-amt">' + money(b.value_cents) + "</span></div>" +
          '<div class="bt-zone-status">' + esc(info.label) + (over ? " · over budget" : "") +
            (b.claimable ? ' <button class="bt-claim-btn" data-act="claim">Claim</button>' : "") +
          "</div>" +
        "</div>" +
        "</div>";
    }).join("");

    const openDisc = Math.max(0, u.capacity_cents - u.allocated_cents);
    const spacer = openDisc > 0
      ? '<div class="bt-zone bt-zone--open" style="flex-grow:' + openDisc + '">' +
        '<span class="bt-open-label">open water · ' + money(openDisc) + " left to allocate</span></div>"
      : "";

    // The reef: necessities as submerged scenery, proportional to their total.
    const reef = '<div class="bt-reef" style="flex-grow:' + Math.max(u.necessities_total_cents, 1) + '">' +
      '<div class="bt-reef-floor">' + reefSceneryMarkup(s.settings.necessities) + "</div>" +
      '<span class="bt-reef-label">Necessities · ' + money(u.necessities_total_cents) + " · covered</span>" +
    "</div>";

    const bubbles = Array.from({ length: 7 }, (_, i) =>
      '<span class="bt-bubble" style="left:' + (8 + (i * 13) % 84 + "%") + ";animation-delay:" + (i * 1.4) + 's"></span>').join("");

    const fish = Array.from({ length: fishCount }, (_, i) =>
      '<span class="bt-fish" style="color:' + FISH_COLORS[i % FISH_COLORS.length] + ";bottom:" + (12 + (i * 17) % 62) + "%;animation-delay:" + (i * 2.3) + 's;animation-duration:' + (11 + (i % 4) * 3) + 's">' + FISH_SVG + "</span>").join("");

    return '<div class="bt-aquarium">' +
      '<div class="bt-zones" data-role="zones">' +
        reef + zones + spacer +
      "</div>" +
      // Tank ceiling = the discretionary budget (the full reward reserve you can
      // earn this period). Water reaches it when every block is unlocked.
      '<div class="bt-cap-line"><span>Budget ceiling · ' + money(u.capacity_cents) + " to unlock</span></div>" +
      '<div class="bt-water" style="height:' + waterPct.toFixed(2) + '%">' +
        '<div class="bt-caustics" aria-hidden="true"></div>' +
        bubbles + fish +
      "</div>" +
      // Surface line + Reward-Reserve label, pinned to the waterline (unclipped).
      '<div class="bt-surface" style="bottom:' + waterPct.toFixed(2) + '%">' +
        '<span class="bt-water-amt">Reward Reserve · ' +
          money(u.waterline_cents) + " earned this " + esc(s.settings.period_type) + "</span>" +
      "</div>" +
      '<div class="bt-glass" aria-hidden="true"></div>' +
    "</div>";
  }

  // ---- money changer ---------------------------------------------------------
  // The coin slot feeding the tank: points -> bank at the configured rate, the
  // safe 1:1 floor to gambling those points at the slot machine.
  function moneyChangerMarkup(s) {
    const rate = s.constants.cents_per_point;
    const rateLabel = "1 pt = " + (rate === 100 ? "$1.00" : rate + "¢");
    return '<div class="bt-group bt-changer">' +
      '<div class="bt-group-head"><span class="bt-group-title">🪙 Money Changer</span>' +
        '<span class="bt-group-sub">' + esc(rateLabel) + " · safe exchange</span></div>" +
      '<div class="bt-changer-row">' +
        '<span class="bt-changer-balance">' + esc(String(s.points)) + " pts</span>" +
        '<input type="number" class="bt-changer-input" data-role="convert-amt" min="1" max="' + s.points + '" placeholder="points">' +
        '<button class="bt-btn bt-changer-max" data-act="convert-max">max</button>' +
      "</div>" +
      '<div class="bt-changer-row">' +
        '<span class="bt-changer-preview" data-role="convert-preview">→ $0.00 into the tank</span>' +
        '<button class="bt-btn bt-btn--primary" data-act="convert"' + (s.points < 1 ? " disabled" : "") + ">Convert</button>" +
      "</div>" +
      (_editMode
        ? '<div class="bt-changer-row bt-changer-admin"><label>Rate (¢ per point)' +
          '<input type="number" class="bt-changer-input" data-role="rate-input" min="1" max="1000" value="' + rate + '"></label>' +
          '<button class="bt-btn" data-act="save-rate">Set rate</button></div>'
        : "") +
    "</div>";
  }

  // ---- rollover modal + investments -------------------------------------------
  function rolloverModalMarkup(s) {
    const p = s.rollover_preview || {};
    const estSweep = Math.min(p.leftover_cents || 0, s.funding.ready || 0);
    const unhit = p.unhit || [];
    return '<div class="bt-modal-backdrop"><div class="bt-modal">' +
      '<div class="bt-modal-title">🐟 New ' + esc(s.settings.period_type) + ", new tank</div>" +
      '<p class="bt-modal-text">' + esc(p.closing_key || "Last period") + " closed at " +
        money(p.closing_waterline_cents || 0) + " banked. " +
        (estSweep > 0
          ? money(estSweep) + " above your last funded block sweeps to investments, and a transfer task lands on today."
          : "Nothing left over to sweep this time.") +
      "</p>" +
      (unhit.length
        ? '<p class="bt-modal-text">Didn\'t reach: ' + esc(unhit.map(u => u.title).join(", ")) + "</p>"
        : "") +
      '<div class="bt-form-actions">' +
        '<button class="bt-btn bt-btn--primary" data-act="rollover-carry">Carry unhit to the bottom</button>' +
        '<button class="bt-btn" data-act="rollover-fresh">Start fresh</button>' +
        '<button class="bt-btn bt-modal-later" data-act="rollover-later">later</button>' +
      "</div>" +
    "</div></div>";
  }

  function investmentsMarkup(s) {
    const inv = s.investments;
    if (!inv || !inv.entries.length) return "";
    const rows = inv.entries.map(e =>
      '<div class="bt-nec-row"><span class="bt-row-name">' + esc(e.period_key) + " sweep" +
      (e.task_block_id ? ' <span class="bt-row-tag">task created</span>' : "") + "</span>" +
      '<span class="bt-row-amt">' + money(e.amount_cents) + "</span></div>").join("");
    return '<div class="bt-group">' +
      '<div class="bt-group-head"><span class="bt-group-title">📈 Investments</span>' +
      '<span class="bt-group-sub">unspent leftovers · ' + money(inv.total_cents) + " total</span></div>" +
      rows + "</div>";
  }

  // ---- breakdown / editors ---------------------------------------------------
  function blockRow(b, u) {
    const info = statusInfo(b, u.waterline_cents);
    const confirming = _confirmDeleteId === b.id;
    return '<div class="bt-row ' + info.cls + '" draggable="true" data-id="' + b.id + '">' +
      '<span class="bt-row-grip" title="Drag to reprioritize">⋮⋮</span>' +
      '<span class="bt-row-dot" style="background:' + esc(b.color || "#f59e0b") + '"></span>' +
      '<span class="bt-row-name">' + esc(b.title) +
        (b.tank_recurring ? '<span class="bt-row-tag">monthly</span>' : "") + "</span>" +
      '<span class="bt-row-amt">' + money(b.value_cents) + "</span>" +
      '<span class="bt-row-fund">' + esc(info.label) + "</span>" +
      (b.claimable ? '<button class="bt-claim-btn" data-act="claim">Claim</button>' : "") +
      (_editMode
        ? '<button class="bt-row-btn" data-act="edit-block" title="Edit">✎</button>' +
          '<button class="bt-row-btn bt-row-btn--danger" data-act="del-block">' + (confirming ? "Sure?" : "×") + "</button>"
        : "") +
      "</div>";
  }

  function blockFormMarkup(s) {
    const f = _form;
    const catList = Array.from(new Set(s.blocks.map(b => b.category).filter(Boolean)));
    return '<div class="bt-form" data-role="block-form">' +
      '<div class="bt-form-title">' + (f.id ? "Edit block" : "New block") + "</div>" +
      '<div class="bt-form-grid">' +
        '<label>Category<input type="text" data-field="category" list="bt-cat-list" placeholder="Restaurants" value="' + esc(f.category) + '"></label>' +
        '<datalist id="bt-cat-list">' + catList.map(c => '<option value="' + esc(c) + '">').join("") + "</datalist>" +
        '<label>What exactly? <span class="bt-form-hint">(optional)</span><input type="text" data-field="item" placeholder="Anniversary dinner at Coral with Fae" value="' + esc(f.item) + '"></label>' +
        '<label>Amount ($)<input type="number" data-field="amount" min="1" step="1" value="' + esc(f.amount) + '"></label>' +
        '<label class="bt-form-check"><input type="checkbox" data-field="recurring"' + (f.recurring ? " checked" : "") + "> Refills every period (envelope)</label>" +
      "</div>" +
      '<div class="bt-form-actions">' +
        '<button class="bt-btn bt-btn--primary" data-act="save-block">' + (f.id ? "Save" : "Drop it in the tank") + "</button>" +
        '<button class="bt-btn" data-act="cancel-block">Cancel</button>' +
      "</div>" +
    "</div>";
  }

  function necessitiesMarkup(s) {
    if (!_editMode || !_necDraft) {
      const rows = s.settings.necessities.map(n =>
        '<div class="bt-nec-row"><span class="bt-row-dot" style="background:' + esc(n.color) + '"></span>' +
        '<span class="bt-row-name">' + esc(n.name) + '</span><span class="bt-row-amt">' + money(n.amount_cents) + "</span></div>").join("");
      return rows || '<div class="bt-empty-note">No necessities configured.</div>';
    }
    return _necDraft.map((n, i) =>
      '<div class="bt-nec-row bt-nec-row--edit" data-idx="' + i + '">' +
        '<span class="bt-row-dot" style="background:' + esc(n.color) + '"></span>' +
        '<input type="text" class="bt-nec-name" value="' + esc(n.name) + '" placeholder="Name">' +
        '<input type="number" class="bt-nec-amt" value="' + Math.round(n.amount_cents / 100) + '" min="0" step="1">' +
        '<button class="bt-row-btn bt-row-btn--danger" data-act="del-nec">×</button>' +
      "</div>").join("") +
      '<div class="bt-form-actions bt-nec-actions">' +
        '<button class="bt-btn" data-act="add-nec">+ add bill</button>' +
        '<button class="bt-btn bt-btn--primary" data-act="save-nec">Save necessities</button>' +
      "</div>";
  }

  // ---- main render -------------------------------------------------------------
  function render() {
    const root = document.getElementById("budget-root");
    if (!root) return;

    if (!_state) {
      root.innerHTML = '<div class="bt-wrap"><div class="bt-loading">Filling the tank…</div></div>';
      return;
    }
    if (_state.error) {
      root.innerHTML = '<div class="bt-wrap"><div class="bt-error">' + esc(_state.error) +
        ' <button class="bt-btn" data-act="retry">Retry</button></div></div>';
      return;
    }

    const s = _state;
    const u = s.usage;
    const period = s.settings.period_type === "week" ? "week" : "month";
    const capSource = s.settings.capacity_source === "fixed" ? "fixed budget"
      : s.settings.capacity_source === "prior_period_banked" ? "last " + period + "'s build"
      : "your stated income";
    const usingIncome = s.settings.capacity_source === "last_income";

    const chips =
      chip("info", "Discretionary budget " + money(u.capacity_cents)) +
      chip("info", "Necessities " + money(u.necessities_total_cents) + " · covered") +
      chip(u.waterline_cents >= u.capacity_cents && u.capacity_cents > 0 ? "ok" : "info",
        "Banked " + money(u.period_banked_cents) + " this " + period) +
      chip("info", "Reserve " + money(s.funding.total)) +
      (u.income_cents > 0 && u.necessities_total_cents >= u.income_cents
        ? chip("warn", "Necessities use the whole income") : "") +
      (u.allocated_cents > u.capacity_cents ? chip("warn", "Over budget by " + money(u.allocated_cents - u.capacity_cents)) : "") +
      (s.investments.total_cents > 0 ? chip("ok", "Invested " + money(s.investments.total_cents)) : "") +
      (s.rollover_due ? chip("warn", "New " + period + " — rollover pending") : "");

    // Legend mirrors the tank: top row = top of tank (funded last).
    const rowsTopDown = [...s.blocks].reverse().map(b => blockRow(b, u)).join("");

    root.innerHTML =
      '<div class="bt-wrap">' +
        '<div class="bt-head">' +
          '<h2 class="bt-title">Budget Tank</h2>' +
          '<p class="bt-sub">Bank builds fill the water. Blocks unlock bottom-to-top in your priority order — ' +
            "drag them to decide what gets topped up first.</p>" +
        "</div>" +
        '<div class="bt-controls">' +
          '<div class="bt-income">' +
            '<label class="bt-income-label" for="bt-income-input">Income from last ' + period + "</label>" +
            '<div class="bt-income-field">' +
              '<span class="bt-income-prefix">$</span>' +
              '<input type="number" id="bt-income-input" class="bt-income-input" data-role="income-input" min="0" step="1" ' +
                'value="' + Math.round((s.settings.income_cents || 0) / 100) + '">' +
            "</div>" +
            '<span class="bt-income-note">' +
              (usingIncome ? "sets your tank budget" :
                '<button class="bt-linkbtn" data-act="use-income">use this as the budget</button> · now: ' + esc(capSource)) +
            "</span>" +
          "</div>" +
          '<div class="bt-chips">' + chips + "</div>" +
          '<button class="bt-btn bt-edit-btn" data-act="toggle-edit">' + (_editMode ? "Done" : "Edit") + "</button>" +
        "</div>" +
        '<div class="bt-main">' +
          '<div class="bt-tank-col">' + tankMarkup(s) + moneyChangerMarkup(s) + "</div>" +
          '<div class="bt-breakdown">' +
            '<div class="bt-group">' +
              '<div class="bt-group-head"><span class="bt-group-title">Priority stack</span>' +
                '<span class="bt-group-sub">top of tank first · bottom fills first</span></div>' +
              (rowsTopDown || '<div class="bt-empty-note">Nothing in the tank yet. Drop in your first block — a dinner, a splurge, a category.</div>') +
              (_editMode && !_form ? '<button class="bt-add" data-act="add-block">+ add block</button>' : "") +
              (_form ? blockFormMarkup(s) : "") +
            "</div>" +
            '<div class="bt-group">' +
              '<div class="bt-group-head"><span class="bt-group-title">Necessities</span>' +
                '<span class="bt-group-sub">the reef floor · always covered</span></div>' +
              necessitiesMarkup(s) +
            "</div>" +
            investmentsMarkup(s) +
          "</div>" +
        "</div>" +
        (s.rollover_due && !_rolloverSnoozed ? rolloverModalMarkup(s) : "") +
      "</div>";
  }

  function chip(kind, text) {
    return '<span class="bt-chip bt-chip--' + kind + '">' + esc(text) + "</span>";
  }

  // ---- block form helpers ----------------------------------------------------
  function openForm(block) {
    if (block) {
      let item = "";
      let category = block.category || "";
      if (category && block.title.indexOf(category + ": ") === 0) item = block.title.slice(category.length + 2);
      else if (!category) category = block.title;
      else if (block.title !== category) item = block.title;
      _form = { id: block.id, category, item, amount: Math.round(block.value_cents / 100), recurring: !!block.tank_recurring, color: block.color };
    } else {
      _form = { id: null, category: "", item: "", amount: "", recurring: false, color: null };
    }
    render();
    const first = document.querySelector('#budget-root [data-field="category"]');
    if (first) first.focus();
  }

  function readForm(root) {
    const get = f => root.querySelector('[data-field="' + f + '"]');
    return {
      category: get("category").value.trim(),
      item: get("item").value.trim(),
      amount: Number(get("amount").value),
      recurring: get("recurring").checked,
    };
  }

  async function saveForm() {
    const root = document.getElementById("budget-root");
    const f = readForm(root);
    if (!f.category && !f.item) { toast("Give the block a category or a label", "error"); return; }
    if (!(f.amount > 0)) { toast("Give the block a positive amount", "error"); return; }
    const body = { category: f.category, item: f.item, amount: f.amount, recurring: f.recurring };
    try {
      if (_form.id) await api("PUT", "/api/budget/blocks/" + _form.id, body);
      else await api("POST", "/api/budget/blocks", body);
      _form = null;
      await loadBudget();
    } catch (e) { toast(e.message || "Could not save block", "error"); }
  }

  // ---- drag reorder ------------------------------------------------------------
  // One rule for both surfaces (tank zones and legend rows both read top of
  // screen = top of tank): dropping above the target's midpoint puts the block
  // HIGHER in the tank (later in priority order), below puts it lower.
  function orderAfterDrop(targetId, insertAfter) {
    const order = _state.blocks.map(b => b.id).filter(id => id !== _dragId);
    const at = order.indexOf(targetId);
    if (at < 0) return null;
    order.splice(insertAfter ? at + 1 : at, 0, _dragId);
    return order;
  }

  async function commitOrder(order) {
    const byId = Object.fromEntries(_state.blocks.map(b => [b.id, b]));
    _state.blocks = order.map((id, i) => Object.assign(byId[id], { tank_position: (i + 1) * 1000 }));
    // Optimistic threshold reflow so lock states read right pre-roundtrip.
    let run = 0;
    for (const b of _state.blocks) { run += b.value_cents; b.tank_unlock_cents = run; }
    render();
    try {
      await api("POST", "/api/budget/blocks/reorder", {
        items: order.map((id, i) => ({ id, tank_position: (i + 1) * 1000 })),
      });
      await loadBudget();
    } catch (e) {
      toast("Reorder failed: " + (e.message || e), "error");
      await loadBudget();
    }
  }

  function dragTargetEl(e) {
    return e.target.closest(".bt-zone[data-id], .bt-row[data-id]");
  }

  // ---- events (delegated, bound once) --------------------------------------------
  function bind() {
    const root = document.getElementById("budget-root");
    if (!root || root.dataset.bound) return;
    root.dataset.bound = "1";

    root.addEventListener("click", async e => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === "retry") { _state = null; render(); loadBudget(); return; }
      if (act === "toggle-edit") {
        _editMode = !_editMode;
        _form = null;
        _confirmDeleteId = null;
        _necDraft = _editMode ? _state.settings.necessities.map(n => ({ ...n })) : null;
        render();
        return;
      }
      if (act === "use-income") {
        try {
          await api("PUT", "/api/budget/config", { capacity_source: "last_income" });
          await loadBudget();
        } catch (err) { toast(err.message || "Could not switch", "error"); }
        return;
      }
      if (act === "rollover-later") { _rolloverSnoozed = true; render(); return; }
      if (act === "rollover-carry" || act === "rollover-fresh") {
        btn.disabled = true;
        try {
          const out = await api("POST", "/api/budget/rollover", { mode: act === "rollover-carry" ? "carry" : "fresh" });
          const bits = [];
          if (out.swept_cents > 0) bits.push(money(out.swept_cents) + " swept to investments" + (out.task_block_id ? " (transfer task on today)" : ""));
          bits.push("new budget " + money(out.new_capacity_cents));
          toast("Tank rolled into " + out.new_period + " — " + bits.join(" · "), "success");
          _rolloverSnoozed = false;
          await loadBudget();
        } catch (err) {
          toast(err.message || "Rollover failed", "error");
          btn.disabled = false;
        }
        return;
      }
      if (act === "convert-max") {
        const input = root.querySelector('[data-role="convert-amt"]');
        if (input) { input.value = _state.points; updateConvertPreview(root); }
        return;
      }
      if (act === "convert") {
        if (_convertBusy) return;
        const input = root.querySelector('[data-role="convert-amt"]');
        const pts = Math.floor(Number(input && input.value));
        if (!(pts > 0)) { toast("How many points?", "error"); return; }
        if (pts > _state.points) { toast("You only have " + _state.points + " points", "error"); return; }
        _convertBusy = true;
        btn.disabled = true;
        if (!_convertKey) _convertKey = (crypto.randomUUID ? crypto.randomUUID() : "cv-" + Date.now() + "-" + Math.random().toString(36).slice(2));
        try {
          const out = await api("POST", "/api/budget/convert", { points: pts, source_key: _convertKey });
          _convertKey = null;
          const cents = out.conversion ? out.conversion.cents : 0;
          toast(out.duplicate ? "Already converted that batch" : "Clink — " + money(cents) + " into the tank", "success");
          await loadBudget();
        } catch (err) {
          toast(err.message || "Conversion failed", "error"); // key kept: retry can't double-spend
          btn.disabled = false;
        }
        _convertBusy = false;
        return;
      }
      if (act === "save-rate") {
        const input = root.querySelector('[data-role="rate-input"]');
        const rate = Math.floor(Number(input && input.value));
        if (!(rate >= 1)) { toast("Rate must be at least 1", "error"); return; }
        try {
          await api("PUT", "/api/budget/config", { cents_per_point: rate });
          toast("Rate set: 1 pt = " + rate + "¢", "success");
          await loadBudget();
        } catch (err) { toast(err.message || "Could not set rate", "error"); }
        return;
      }
      if (act === "claim") {
        const el = btn.closest("[data-id]");
        const block = _state.blocks.find(b => String(b.id) === el.dataset.id);
        if (!block) return;
        btn.disabled = true;
        try {
          const out = await api("POST", "/api/budget/blocks/" + block.id + "/claim");
          await loadBudget();
          if (typeof window.loadRewardsQueue === "function") window.loadRewardsQueue();
          const title = block.title;
          if (out.reward_queue_item && typeof window.showToast === "function") {
            window.showToast("Claimed “" + title + "” — it's in your rewards", "success", 8000, {
              label: "Schedule now",
              onClick: () => window.scheduleRewardQueueItem && window.scheduleRewardQueueItem(out.reward_queue_item),
            });
          } else {
            toast("Claimed “" + title + "”", "success");
          }
        } catch (err) {
          toast(err.message || "Could not claim", "error");
          btn.disabled = false;
        }
        return;
      }
      if (act === "add-block") { openForm(null); return; }
      if (act === "cancel-block") { _form = null; render(); return; }
      if (act === "save-block") { saveForm(); return; }
      if (act === "edit-block") {
        const row = btn.closest("[data-id]");
        const block = _state.blocks.find(b => String(b.id) === row.dataset.id);
        if (block) openForm(block);
        return;
      }
      if (act === "del-block") {
        const row = btn.closest("[data-id]");
        const id = Number(row.dataset.id);
        if (_confirmDeleteId !== id) { _confirmDeleteId = id; render(); return; }
        _confirmDeleteId = null;
        try {
          await api("DELETE", "/api/budget/blocks/" + id);
          toast("Block removed", "success");
          await loadBudget();
        } catch (err) { toast(err.message || "Could not remove block", "error"); }
        return;
      }
      if (act === "add-nec") {
        _necDraft.push({ id: "nec-" + Date.now().toString(36), name: "", amount_cents: 0, color: "#22c55e" });
        render();
        return;
      }
      if (act === "del-nec") {
        const idx = Number(btn.closest("[data-idx]").dataset.idx);
        readNecDraft(root);
        _necDraft.splice(idx, 1);
        render();
        return;
      }
      if (act === "save-nec") {
        readNecDraft(root);
        const cleaned = _necDraft.filter(n => n.name.trim());
        try {
          const out = await api("PUT", "/api/budget/config", { necessities: cleaned });
          _state.settings = out.settings;
          _necDraft = out.settings.necessities.map(n => ({ ...n }));
          toast("Necessities saved", "success");
          await loadBudget();
        } catch (err) { toast(err.message || "Could not save necessities", "error"); }
        return;
      }
    });

    root.addEventListener("input", e => {
      if (e.target.dataset.role === "convert-amt") updateConvertPreview(root);
    });

    // Income field commits on blur/Enter (change), not per keystroke. Stating
    // income makes it the tank budget (capacity_source = last_income).
    root.addEventListener("change", async e => {
      if (e.target.dataset.role !== "income-input") return;
      const dollars = Math.max(0, Math.round(Number(e.target.value) || 0));
      try {
        await api("PUT", "/api/budget/config", { income_cents: dollars * 100, capacity_source: "last_income" });
        await loadBudget();
      } catch (err) { toast(err.message || "Could not save income", "error"); }
    });

    root.addEventListener("keydown", e => {
      if (e.key === "Enter" && e.target.closest('[data-role="block-form"]') && e.target.tagName === "INPUT" && e.target.type !== "checkbox") {
        e.preventDefault();
        saveForm();
      }
    });

    // Native DnD (same approach as the reward-card reorder in slots.js).
    root.addEventListener("dragstart", e => {
      const el = dragTargetEl(e);
      if (!el) return;
      _dragId = Number(el.dataset.id);
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", el.dataset.id); } catch (err) {}
      el.classList.add("bt-dragging");
    });
    root.addEventListener("dragend", () => {
      _dragId = null;
      root.querySelectorAll(".bt-dragging, .bt-drop-above, .bt-drop-below").forEach(el =>
        el.classList.remove("bt-dragging", "bt-drop-above", "bt-drop-below"));
    });
    root.addEventListener("dragover", e => {
      const el = dragTargetEl(e);
      if (!el || _dragId == null || Number(el.dataset.id) === _dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = el.getBoundingClientRect();
      const above = e.clientY < r.top + r.height / 2;
      el.classList.toggle("bt-drop-above", above);
      el.classList.toggle("bt-drop-below", !above);
    });
    root.addEventListener("dragleave", e => {
      const el = dragTargetEl(e);
      if (el) el.classList.remove("bt-drop-above", "bt-drop-below");
    });
    root.addEventListener("drop", e => {
      const el = dragTargetEl(e);
      if (!el || _dragId == null) return;
      e.preventDefault();
      const targetId = Number(el.dataset.id);
      if (targetId === _dragId) return;
      const r = el.getBoundingClientRect();
      const above = e.clientY < r.top + r.height / 2;
      // Above midpoint = higher in the tank = later in priority order.
      const order = orderAfterDrop(targetId, above);
      el.classList.remove("bt-drop-above", "bt-drop-below");
      if (order) commitOrder(order);
    });

    // Any economy change (spin, conversion, claim, reorder from another tab)
    // refreshes the tank — unless mid-drag or mid-form, where a rerender would
    // eat the user's input.
    document.addEventListener("slot-changed", () => {
      if (_dragId != null || _form || (_editMode && _necDraft)) return;
      if (document.getElementById("budget-root")) loadBudget();
    });
  }

  function updateConvertPreview(root) {
    const input = root.querySelector('[data-role="convert-amt"]');
    const preview = root.querySelector('[data-role="convert-preview"]');
    if (!input || !preview || !_state) return;
    const pts = Math.max(0, Math.floor(Number(input.value)) || 0);
    preview.textContent = "→ " + money(pts * _state.constants.cents_per_point) + " into the tank";
  }

  function readNecDraft(root) {
    root.querySelectorAll(".bt-nec-row--edit").forEach(row => {
      const idx = Number(row.dataset.idx);
      if (!_necDraft[idx]) return;
      _necDraft[idx].name = row.querySelector(".bt-nec-name").value;
      _necDraft[idx].amount_cents = Math.max(0, Math.round(Number(row.querySelector(".bt-nec-amt").value) * 100) || 0);
    });
  }

  // ---- public entry -------------------------------------------------------------
  function renderBudget() {
    render();  // paint cached state immediately on tab switch
    bind();
    loadBudget();
    // Phase 0's localStorage config is dead — server owns the tank now.
    try { localStorage.removeItem("pa-budget-config"); } catch (e) {}
  }

  window.renderBudget = renderBudget;
  window.Budget = { render: renderBudget, reload: loadBudget };
})();
