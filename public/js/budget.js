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
  let _form = null;         // add-block form: { id|null, category, item, amount, recurring, color }
  let _dragId = null;
  let _confirmDeleteId = null;
  let _loadSeq = 0;
  let _convertKey = null;   // per-attempt idempotency key; reused on retry
  let _convertBusy = false;
  let _rolloverSnoozed = false;
  const _collapsed = new Set();  // collapsed category keys

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
    gift:
      '<svg viewBox="0 0 40 32" class="bt-scenery-svg"><rect x="7" y="13" width="26" height="17" rx="2" fill="currentColor"/><rect x="5" y="9" width="30" height="6" rx="2" fill="currentColor" opacity=".8"/><rect x="18" y="9" width="4" height="21" fill="#0b1020" opacity=".4"/><path d="M20 9c-4-7-11-4-6 0M20 9c4-7 11-4 6 0" stroke="currentColor" stroke-width="2.5" fill="none"/></svg>',
    star:
      '<svg viewBox="0 0 40 32" class="bt-scenery-svg"><path d="M20 3l4.6 9.6 10.4 1.3-7.6 7.2 2 10.4L20 26.6 10.6 31.7l2-10.4L5 14.1l10.4-1.3z" fill="currentColor"/></svg>',
    heart:
      '<svg viewBox="0 0 40 32" class="bt-scenery-svg"><path d="M20 30C6 21 4 12 9 7c4-4 9-2 11 2 2-4 7-6 11-2 5 5 3 14-11 23z" fill="currentColor"/></svg>',
  };
  // Shapes the user can pick for a tank decoration (necessity or block).
  const SHAPES = ["chest", "gift", "star", "heart", "castle", "coral", "plant", "rocks", "shell"];
  const SCENERY = ["castle", "coral", "plant", "rocks", "shell"];

  function shapeSprite(shape, claimed) {
    if (shape === "chest") return claimed ? SPRITES.chestOpen : SPRITES.chest;
    return SPRITES[shape] || (claimed ? SPRITES.chestOpen : SPRITES.chest);
  }

  // A reward block's chest (or its chosen shape). Claimed chests open.
  function chestSpriteFor(block) {
    return shapeSprite(block.shape || "chest", block.claimed);
  }

  // The submerged reef of necessities: each bill is a labeled scenery piece
  // (shape + color the user picked). Always covered — no bank-build needed.
  function reefSceneryMarkup(necessities) {
    return (necessities || []).map((n, i) =>
      '<span class="bt-scenery" style="color:' + esc(n.color || "#8aa0c0") + '">' +
        SPRITES[n.shape && SPRITES[n.shape] ? n.shape : SCENERY[i % SCENERY.length]] +
        '<span class="bt-scenery-name">' + esc(n.name) + "</span>" +
      "</span>"
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
  // Geometry: the NECESSITIES reef is a modest fixed-height decorative base at
  // the bottom (always submerged) — bills are context, not the show. Everything
  // above it is the discretionary zone: reward-block chests stack in cents-space
  // (column-reverse, priority-1 at the bottom) with open water for the
  // unallocated remainder. The waterline fills the discretionary zone as the
  // Reward Reserve is earned, so its level = reef + (waterline/budget) of the
  // space above the reef. The level labels sit in a gutter to the LEFT.
  const REEF_PX = 88;

  function tankMarkup(s) {
    const u = s.usage;
    const waterFrac = u.capacity_cents > 0 ? Math.min(1, u.waterline_cents / u.capacity_cents) : 0;
    const level = "calc(" + REEF_PX + "px + (100% - " + REEF_PX + "px) * " + waterFrac.toFixed(4) + ")";
    const claimedCount = s.blocks.filter(b => b.claimed).length;
    const fishCount = Math.min(6, claimedCount);

    // Walk in fill order; a category divider marks each group's base (column
    // reverse puts DOM-earlier items lower, so the band sits under its group).
    let prevCat = null;
    const zones = s.blocks.map(b => {
      const info = statusInfo(b, u.waterline_cents);
      const over = (b.tank_unlock_cents || 0) > u.capacity_cents;
      const catName = b.category || b.title;
      let band = "";
      if (catName !== prevCat) {
        prevCat = catName;
        band = '<div class="bt-cat-band" style="color:' + esc(b.color || "#7dd3fc") + '"><span>' + esc(catName) + "</span></div>";
      }
      return band + '<div class="bt-zone ' + info.cls + (over ? " bt--overcap" : "") + '" draggable="true" data-id="' + b.id + '"' +
        ' style="flex-grow:' + b.value_cents + ';color:' + esc(b.color || "#f59e0b") + '">' +
        '<span class="bt-zone-sprite">' + chestSpriteFor(b) + "</span>" +
        '<div class="bt-zone-body">' +
          '<div class="bt-zone-top"><span class="bt-zone-name">' + esc(b.item || b.title) + "</span>" +
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

    // The reef: necessities as labeled submerged scenery, a modest fixed base.
    const reef = '<div class="bt-reef">' +
      '<div class="bt-reef-floor">' + reefSceneryMarkup(s.settings.necessities) + "</div>" +
      '<span class="bt-reef-label">Necessities · ' + money(u.necessities_total_cents) + " · covered</span>" +
    "</div>";

    const bubbles = Array.from({ length: 7 }, (_, i) =>
      '<span class="bt-bubble" style="left:' + (8 + (i * 13) % 84 + "%") + ";animation-delay:" + (i * 1.4) + 's"></span>').join("");

    const fish = Array.from({ length: fishCount }, (_, i) =>
      '<span class="bt-fish" style="color:' + FISH_COLORS[i % FISH_COLORS.length] + ";bottom:" + (12 + (i * 17) % 62) + "%;animation-delay:" + (i * 2.3) + 's;animation-duration:' + (11 + (i % 4) * 3) + 's">' + FISH_SVG + "</span>").join("");

    // Level labels in a gutter to the LEFT, each pinned to its level: budget
    // ceiling at the top, Reward Reserve at the waterline (same calc as water).
    const sideLabels =
      '<div class="bt-side" aria-hidden="false">' +
        '<div class="bt-side-label bt-side-cap">' +
          '<span class="bt-side-t">Budget ceiling</span>' +
          '<span class="bt-side-val">' + money(u.capacity_cents) + "</span>" +
          '<span class="bt-side-sub">to unlock</span>' +
        "</div>" +
        '<div class="bt-side-label bt-side-reserve" style="bottom:' + level + '">' +
          '<span class="bt-side-t">Reward Reserve</span>' +
          '<span class="bt-side-val">' + money(u.waterline_cents) + "</span>" +
          '<span class="bt-side-sub">earned this ' + esc(s.settings.period_type) + "</span>" +
        "</div>" +
      "</div>";

    return '<div class="bt-tank-frame">' +
      sideLabels +
      '<div class="bt-aquarium">' +
        '<div class="bt-zones" data-role="zones">' +
          zones + spacer +
        "</div>" +
        reef +
        '<div class="bt-cap-line"></div>' +
        '<div class="bt-water" style="height:' + level + '">' +
          '<div class="bt-caustics" aria-hidden="true"></div>' +
          bubbles + fish +
        "</div>" +
        '<div class="bt-surface" style="bottom:' + level + '"></div>' +
        '<div class="bt-glass" aria-hidden="true"></div>' +
      "</div>" +
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
      '<div class="bt-changer-row bt-changer-admin"><label>Rate (¢ per point)' +
        '<input type="number" class="bt-changer-input" data-role="rate-input" min="1" max="1000" value="' + rate + '"></label></div>' +
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
  // Every row is editable in place — no edit mode. The name and amount are
  // borderless inputs that save on blur/Enter; a grip drags, × deletes.
  function amtInput(role, cents) {
    return '<span class="bt-amt-edit">$<input type="number" class="bt-amt-in" data-role="' + role +
      '" value="' + Math.round((cents || 0) / 100) + '" min="0" step="1"></span>';
  }

  // A specific purchase item, nested under its category header.
  function blockRow(b, u) {
    const info = statusInfo(b, u.waterline_cents);
    const confirming = _confirmDeleteId === b.id;
    return '<div class="bt-row bt-row--nested ' + info.cls + '" draggable="true" data-id="' + b.id + '">' +
      '<span class="bt-row-grip" title="Drag to reprioritize">⋮⋮</span>' +
      '<span class="bt-row-dot" style="background:' + esc(b.color || "#f59e0b") + '"></span>' +
      '<input class="bt-name-in" data-role="item-name" value="' + esc(b.item || b.title) + '" placeholder="what to buy">' +
      (b.tank_recurring ? '<span class="bt-row-tag">monthly</span>' : "") +
      amtInput("item-amt", b.value_cents) +
      '<span class="bt-row-fund">' + esc(info.label) + "</span>" +
      (b.claimable ? '<button class="bt-claim-btn" data-act="claim">Claim</button>' : "") +
      '<button class="bt-row-btn bt-row-btn--danger" data-act="del-block">' + (confirming ? "Sure?" : "×") + "</button>" +
      "</div>";
  }

  // A Monarch/Mint-style category group. The header name is editable in place
  // (renames the whole group); its amount is the read-only rollup. A lone
  // generic envelope (single item labeled like the category) becomes the
  // editable header row itself, with its own amount + claim + delete.
  function categoryGroupMarkup(cat, u) {
    const collapsed = _collapsed.has(cat.key);
    const lone = cat.count === 1 && (cat.items[0].item || "").trim().toLowerCase() === cat.name.trim().toLowerCase();
    const fillPct = Math.round((cat.fill_frac || 0) * 100);
    const statusText = cat.status === "claimed" ? "all claimed"
      : cat.status === "claimable" ? cat.claimable_count + " ready"
      : cat.status === "partial" ? cat.unlocked_count + "/" + cat.count + " unlocked"
      : "locked";
    const one = cat.items[0];
    const confirmingLone = lone && _confirmDeleteId === one.id;
    const head =
      '<div class="bt-cat-head" data-cat="' + esc(cat.key) + '"' + (lone ? ' data-id="' + one.id + '"' : "") + ">" +
        (lone ? '<span class="bt-cat-caret bt-cat-caret--none"></span>'
              : '<span class="bt-cat-caret" data-act="toggle-cat" data-cat="' + esc(cat.key) + '">' + (collapsed ? "▸" : "▾") + "</span>") +
        '<span class="bt-row-dot" style="background:' + esc(cat.color || "#f59e0b") + '"></span>' +
        '<input class="bt-name-in bt-cat-name-in" data-role="cat-name" data-cat="' + esc(cat.key) + '" value="' + esc(cat.name) + '">' +
        '<span class="bt-cat-status bt--' + cat.status + '">' + statusText + "</span>" +
        (lone ? amtInput("item-amt", one.value_cents)
              : '<span class="bt-cat-amt">' + money(cat.budget_cents) + "</span>") +
        '<span class="bt-cat-bar"><i style="width:' + fillPct + '%"></i></span>' +
        (lone && one.claimable ? '<button class="bt-claim-btn" data-act="claim" data-id="' + one.id + '">Claim</button>' : "") +
        (lone ? '<button class="bt-row-btn bt-row-btn--danger" data-act="del-block" data-id="' + one.id + '">' + (confirmingLone ? "Sure?" : "×") + "</button>" : "") +
      "</div>";
    if (lone) return '<div class="bt-cat" data-cat="' + esc(cat.key) + '">' + head + "</div>";
    const items = collapsed ? "" :
      '<div class="bt-cat-items">' +
        [...cat.items].reverse().map(b => blockRow(b, u)).join("") +
        '<button class="bt-add bt-add--sub" data-act="add-block" data-cat="' + esc(cat.name) + '">+ add to ' + esc(cat.name) + "</button>" +
      "</div>";
    return '<div class="bt-cat" data-cat="' + esc(cat.key) + '">' + head + items + "</div>";
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

  function shapePicker(current) {
    return '<div class="bt-shape-pick">' + SHAPES.map(sh =>
      '<button type="button" class="bt-shape-btn' + (sh === current ? " is-sel" : "") + '" ' +
        'data-act="nec-shape" data-shape="' + sh + '" title="' + sh + '">' +
        (SPRITES[sh] || "") + "</button>").join("") + "</div>";
  }

  // Necessities are always editable in place (no edit mode). Each row's fields
  // save the whole list on blur/Enter (they live in one settings blob); the
  // shape picker saves on click. data-necid preserves stable ids.
  function necessitiesMarkup(s) {
    const rows = s.settings.necessities.map((n) =>
      '<div class="bt-nec-row bt-nec-row--edit" data-necid="' + esc(n.id || "") + '" data-shape="' + esc(n.shape || "castle") + '">' +
        '<div class="bt-nec-top">' +
          '<input type="color" class="bt-nec-color" data-role="nec" value="' + esc(n.color || "#22c55e") + '" title="Color">' +
          '<input type="text" class="bt-nec-name bt-name-in" data-role="nec" value="' + esc(n.name) + '" placeholder="Rent, Utilities…">' +
          '<span class="bt-amt-edit">$<input type="number" class="bt-nec-amt bt-amt-in" data-role="nec" value="' + Math.round(n.amount_cents / 100) + '" min="0" step="1"></span>' +
          '<button class="bt-row-btn bt-row-btn--danger" data-act="del-nec">×</button>' +
        "</div>" +
        shapePicker(n.shape) +
      "</div>").join("");
    return rows + '<button class="bt-add" data-act="add-nec">+ add bill</button>';
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

    // Monarch/Mint-style: category groups (top of tank first), each rolling up
    // its items. Reversed so the last-to-fill category sits on top, matching the
    // tank above it.
    const catGroups = [...s.categories].reverse().map(cat => categoryGroupMarkup(cat, u)).join("");

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
        "</div>" +
        '<div class="bt-main">' +
          '<div class="bt-tank-col">' + tankMarkup(s) + moneyChangerMarkup(s) + "</div>" +
          '<div class="bt-breakdown">' +
            '<div class="bt-group">' +
              '<div class="bt-group-head"><span class="bt-group-title">Priority stack</span>' +
                '<span class="bt-group-sub">categories roll up · bottom fills first</span></div>' +
              (catGroups || '<div class="bt-empty-note">Nothing in the tank yet. Add a category and drop in what you want to buy — a dinner, a gift, a trip.</div>') +
              (!_form ? '<button class="bt-add" data-act="add-block">+ add category / item</button>' : "") +
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
  function openForm(block, presetCategory) {
    if (block) {
      let item = "";
      let category = block.category || "";
      if (category && block.title.indexOf(category + ": ") === 0) item = block.title.slice(category.length + 2);
      else if (!category) category = block.title;
      else if (block.title !== category) item = block.title;
      _form = { id: block.id, category, item, amount: Math.round(block.value_cents / 100), recurring: !!block.tank_recurring, color: block.color };
    } else {
      _form = { id: null, category: presetCategory || "", item: "", amount: "", recurring: false, color: null };
    }
    render();
    // Land focus on the item field when the category is already chosen.
    const focusSel = presetCategory ? '[data-field="item"]' : '[data-field="category"]';
    const first = document.querySelector("#budget-root " + focusSel);
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
      if (act === "toggle-cat") {
        const key = btn.dataset.cat;
        if (_collapsed.has(key)) _collapsed.delete(key); else _collapsed.add(key);
        render();
        return;
      }
      if (act === "add-block") { openForm(null, btn.dataset.cat || ""); return; }
      if (act === "cancel-block") { _form = null; render(); return; }
      if (act === "save-block") { saveForm(); return; }
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
        const palette = ["#22c55e", "#10b981", "#14b8a6", "#06b6d4", "#0ea5e9", "#6366f1"];
        const scenery = ["castle", "coral", "plant", "rocks", "shell"];
        const list = gatherNecessities(root);
        const n = list.length;
        list.push({ id: "nec-" + Date.now().toString(36), name: "New bill", amount_cents: 0,
          color: palette[n % palette.length], shape: scenery[n % scenery.length] });
        saveNecessities(list);
        return;
      }
      if (act === "nec-shape") {
        const row = btn.closest(".bt-nec-row--edit");
        if (row) row.dataset.shape = btn.dataset.shape;
        saveNecessities(gatherNecessities(root));
        return;
      }
      if (act === "del-nec") {
        const rows = [...root.querySelectorAll(".bt-nec-row--edit")];
        const idx = rows.indexOf(btn.closest(".bt-nec-row--edit"));
        const list = gatherNecessities(root);
        if (idx >= 0) list.splice(idx, 1);
        saveNecessities(list);
        return;
      }
    });

    root.addEventListener("input", e => {
      if (e.target.dataset.role === "convert-amt") updateConvertPreview(root);
    });

    // Everything editable in place commits on blur/Enter (change), never per
    // keystroke — so a full re-render after save can't eat what you're typing.
    root.addEventListener("change", async e => {
      const role = e.target.dataset.role;
      if (role === "income-input") {
        const dollars = Math.max(0, Math.round(Number(e.target.value) || 0));
        try { await api("PUT", "/api/budget/config", { income_cents: dollars * 100, capacity_source: "last_income" }); await loadBudget(); }
        catch (err) { toast(err.message || "Could not save income", "error"); }
      } else if (role === "rate-input") {
        const rate = Math.max(1, Math.floor(Number(e.target.value) || 1));
        try { await api("PUT", "/api/budget/config", { cents_per_point: rate }); await loadBudget(); }
        catch (err) { toast(err.message || "Could not set rate", "error"); }
      } else if (role === "nec") {
        saveNecessities(gatherNecessities(root));
      } else if (role === "item-name" || role === "item-amt") {
        saveBlockInline(e.target);
      } else if (role === "cat-name") {
        renameCategory(e.target.dataset.cat, e.target.value);
      }
    });

    root.addEventListener("keydown", e => {
      if (e.key !== "Enter") return;
      if (e.target.closest('[data-role="block-form"]') && e.target.tagName === "INPUT" && e.target.type !== "checkbox") {
        e.preventDefault(); saveForm();
      } else if (e.target.classList && e.target.classList.contains("bt-name-in")) {
        e.preventDefault(); e.target.blur();  // commit inline edit
      }
    });

    // Native DnD (same approach as the reward-card reorder in slots.js).
    root.addEventListener("dragstart", e => {
      // Don't hijack drags that start inside an inline editor.
      if (e.target.closest && e.target.closest("input,button,select,.bt-shape-pick")) { e.preventDefault(); return; }
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
    // refreshes the tank — unless mid-drag, mid-add-form, or while an inline
    // field is focused, where a rerender would eat what's being typed.
    document.addEventListener("slot-changed", () => {
      if (_dragId != null || _form) return;
      const root = document.getElementById("budget-root");
      if (!root) return;
      if (root.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
      loadBudget();
    });
  }

  function updateConvertPreview(root) {
    const input = root.querySelector('[data-role="convert-amt"]');
    const preview = root.querySelector('[data-role="convert-preview"]');
    if (!input || !preview || !_state) return;
    const pts = Math.max(0, Math.floor(Number(input.value)) || 0);
    preview.textContent = "→ " + money(pts * _state.constants.cents_per_point) + " into the tank";
  }

  // ---- inline save helpers ----------------------------------------------------
  function gatherNecessities(root) {
    return [...root.querySelectorAll(".bt-nec-row--edit")].map(row => ({
      id: row.dataset.necid || undefined,
      name: row.querySelector(".bt-nec-name").value,
      amount_cents: Math.max(0, Math.round(Number(row.querySelector(".bt-nec-amt").value) * 100) || 0),
      color: row.querySelector(".bt-nec-color").value,
      shape: row.dataset.shape || "castle",
    }));
  }

  async function saveNecessities(list) {
    try {
      await api("PUT", "/api/budget/config", { necessities: list.filter(n => (n.name || "").trim()) });
      await loadBudget();
    } catch (err) { toast(err.message || "Could not save necessities", "error"); }
  }

  // Save an item's inline name/amount edit. Sends the whole block so the server
  // rebuilds "Category: item" and keeps the amount/recurring in sync.
  async function saveBlockInline(input) {
    const rowEl = input.closest("[data-id]");
    if (!rowEl) return;
    const block = _state.blocks.find(b => String(b.id) === rowEl.dataset.id);
    if (!block) return;
    const nameEl = rowEl.querySelector('[data-role="item-name"]');
    const amtEl = rowEl.querySelector('[data-role="item-amt"]');
    const category = block.category || "";
    const curItem = block.item && block.item !== block.category ? block.item : "";
    const name = nameEl ? nameEl.value.trim() : curItem;
    const amount = amtEl ? Math.max(0, Math.round(Number(amtEl.value) || 0)) : Math.round(block.value_cents / 100);
    // A lone envelope (name == category) keeps category==title; a real item
    // nests under its category.
    const body = curItem || category
      ? { category, item: (name === category ? "" : name), amount, recurring: block.tank_recurring }
      : { title: name, amount, recurring: block.tank_recurring };
    try { await api("PUT", "/api/budget/blocks/" + block.id, body); await loadBudget(); }
    catch (err) { toast(err.message || "Could not save", "error"); }
  }

  // Rename a whole category in place — recategorize every item under it.
  async function renameCategory(key, newName) {
    const name = (newName || "").trim();
    if (!name) { loadBudget(); return; }
    const cat = (_state.categories || []).find(c => c.key === key);
    if (!cat || name.toLowerCase() === cat.name.toLowerCase()) return;
    try {
      for (const it of cat.items) {
        const curItem = it.item && it.item !== it.category ? it.item : "";
        await api("PUT", "/api/budget/blocks/" + it.id, {
          category: name, item: curItem, amount: Math.round(it.value_cents / 100), recurring: it.tank_recurring,
        });
      }
      await loadBudget();
    } catch (err) { toast(err.message || "Could not rename category", "error"); }
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
