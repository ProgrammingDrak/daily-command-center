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
  let _form = null;         // planned purchase form: { id|null, description, amount, category, recurring }
  let _dragId = null;
  let _confirmDeleteId = null;
  let _loadSeq = 0;
  let _convertKey = null;   // per-attempt idempotency key; reused on retry
  let _convertBusy = false;
  let _rolloverSnoozed = false;
  let _vault = { items: [], milestones: { items: [], progress: { total: 0 } } };
  let _vaultOpen = false;
  let _vaultTypes = new Set(["purchase", "free", "sponsored"]);
  let _vaultCardCategories = null;
  let _vaultFilterOpen = null;
  let _vaultSearch = "";
  let _vaultForm = null;
  let _milestoneForm = null;
  let _overflowKey = null;
  let _autoResolving = false;
  let _sponsorLink = null;
  const _collapsed = new Set();  // collapsed category keys

  // Shell-to-tank tie-in (Phase 11): a shell's 10% all-done bonus banks POINTS
  // (into the Money Changer balance), so we celebrate a points *increase*, not a
  // waterline move (the waterline only rises on conversion). _lastPoints is the
  // reconciled baseline; a positive delta queues a one-shot "bank feed" moment.
  // Idempotent by value: an SSE echo/refresh that returns the same points can't
  // replay it. If the tab is hidden when it lands, we badge the tab and play the
  // animation the next time it's visible instead of dropping it on the floor.
  //
  // Shell-EXCLUSIVE: the moment fires only when the credit-earned SSE event is
  // tagged bonus_kind:"shell" (routes/slots.js), so normal task credits don't
  // splash the tank — each task type gets its own celebration over time.
  let _lastPoints = null;
  let _pendingBonus = 0;
  let _pendingBonusTitle = "";   // shell title to credit in the toast
  let _shellBonusPending = false; // armed by a shell-tagged slot-changed event
  let _shellBonusTitle = "";

  function esc(s) { return window.DCC.esc(s); }
  function toast(msg, kind) { return window.DCC.toast(msg, kind); }
  function money(c) { return fmtMoney(c); }

  // ---- data ---------------------------------------------------------------
  async function loadBudget() {
    const seq = ++_loadSeq;
    try {
      const [res, vaultRes, sponsorRes] = await Promise.all([fetch("/api/budget/state"), fetch("/api/budget/vault"), fetch("/api/budget/sponsor-link")]);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      if (!vaultRes.ok) throw new Error((await vaultRes.json().catch(() => ({}))).error || vaultRes.statusText);
      const [data, vault] = await Promise.all([res.json(), vaultRes.json()]);
      if (seq !== _loadSeq) return; // a newer load superseded this one
      _state = data;
      _vault = vault;
      _sponsorLink = sponsorRes.ok ? (await sponsorRes.json()).link : null;
    } catch (e) {
      if (seq !== _loadSeq) return;
      _state = { error: e.message || "Could not load the Budget Tank" };
    }
    // Reconcile the points baseline: a positive move means a bonus/credit just
    // banked. Queue it; render() decides whether to play it now or badge the tab.
    if (!_state.error && typeof _state.points === "number") {
      // Consume the shell-bonus arming flag HERE, past the supersede guard, so
      // only the winning load claims it — a superseded/errored load can't eat the
      // flag and drop the celebration (shell completions fire several slot-changed
      // events in a tight window, so loads race). The flag lingers across a losing
      // load and the next survivor honors it against the still-stale baseline.
      const celebrateThisLoad = _shellBonusPending;
      const shellTitle = _shellBonusTitle;
      _shellBonusPending = false;
      _shellBonusTitle = "";
      const baseline = _lastPoints == null ? _state.points : _lastPoints;
      const delta = _state.points - baseline;
      // Always reconcile the baseline (a non-shell credit updates it silently),
      // but only QUEUE the celebration when this load was armed by a shell bonus.
      if (delta > 0 && celebrateThisLoad) { _pendingBonus += delta; _pendingBonusTitle = shellTitle; }
      _lastPoints = _state.points;
    }
    render();
    autoResolveSpecificMilestones();
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

    // Tank is the user's free priority order (any order they drag). Each chest
    // carries its own little category line, since neighbors may differ.
    const zones = s.blocks.map(b => {
      const info = statusInfo(b, u.waterline_cents);
      const over = (b.tank_unlock_cents || 0) > u.capacity_cents;
      const catName = (b.category && b.category !== (b.item || b.title)) ? b.category : "";
      return '<div class="bt-zone ' + info.cls + (over ? " bt--overcap" : "") + '" draggable="true" data-id="' + b.id + '"' +
        ' style="flex-grow:' + b.value_cents + ';color:' + esc(b.color || "#f59e0b") + '">' +
        '<span class="bt-zone-sprite">' + chestSpriteFor(b) + "</span>" +
        '<div class="bt-zone-body">' +
          (catName ? '<div class="bt-zone-cat">' + esc(catName) + "</div>" : "") +
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
  // The coin slot feeding the tank: one point buys one canonical Bank Unit.
  // Its dollar quote comes from the budget model and is shared by games.
  function moneyChangerMarkup(s) {
    const unit = s.constants.bank_unit || {};
    const rate = s.constants.bank_unit_cents || s.constants.cents_per_point;
    const rateLabel = "1 pt = 1 Bank Unit";
    const quoteDetail = money(rate) + " today · budget-aware safe exchange";
    return '<div class="bt-group bt-changer">' +
      '<div class="bt-group-head"><span class="bt-group-title" id="budget-money-changer-title" tabindex="-1">🪙 Money Changer</span>' +
        '<span class="bt-group-sub">' + esc(rateLabel) + " · " + esc(quoteDetail) + "</span></div>" +
      '<div class="bt-changer-row">' +
        '<span class="bt-changer-balance">' + esc(String(s.points)) + " pts</span>" +
        '<input type="number" class="bt-changer-input" data-role="convert-amt" min="1" max="' + s.points + '" placeholder="points">' +
        '<button class="bt-btn bt-changer-max" data-act="convert-max">max</button>' +
      "</div>" +
      '<div class="bt-changer-row">' +
        '<span class="bt-changer-preview" data-role="convert-preview">0 Bank Units → $0.00 into the tank</span>' +
        '<button class="bt-btn bt-btn--primary" data-act="convert"' + (s.points < 1 ? " disabled" : "") + ">Convert</button>" +
      "</div>" +
      '<div class="bt-changer-row bt-changer-admin"><span>One Bank Unit is ' + money(rate) +
        '. Its value follows your ' + money(unit.goal_cents || 0) + ' discretionary budget and remaining headroom. Games use this same unit.</span></div>' +
      '<div class="bt-changer-choice" aria-hidden="true"><span>or</span></div>' +
      '<div class="bt-casino-choice">' +
        '<div><strong>Go for broke in the casino</strong>' +
          '<span>Use the same task-point balance for a shot at a bigger payoff.</span></div>' +
        '<button class="bt-btn bt-btn--casino" data-act="open-casino" type="button">🎰 Feeling lucky??</button>' +
      '</div>' +
    "</div>";
  }

  // Budget owns the top-level destination. The casino is a focused subview,
  // while Slots continues to own its machine state and internal sections.
  function showBudgetHome(options) {
    const opts = options || {};
    const home = document.getElementById("budget-home");
    const casino = document.getElementById("budget-casino");
    if (home) home.hidden = false;
    if (casino) casino.hidden = true;
    if (typeof window.clearSlotCoinEffects === "function") window.clearSlotCoinEffects();
    if (!opts.focus) return;
    requestAnimationFrame(() => {
      const title = document.getElementById("budget-money-changer-title");
      if (!title) return;
      title.scrollIntoView({ behavior: prefersReduced() ? "auto" : "smooth", block: "center" });
      title.focus({ preventScroll: true });
    });
  }

  function showCasino() {
    const home = document.getElementById("budget-home");
    const casino = document.getElementById("budget-casino");
    if (!home || !casino) return;
    home.hidden = true;
    casino.hidden = false;
    if (window.SlotRewards && typeof window.SlotRewards.activate === "function") {
      window.SlotRewards.activate("machine");
    } else if (window.SlotRewards && typeof window.SlotRewards.load === "function") {
      window.SlotRewards.load();
    }
    requestAnimationFrame(() => {
      const title = document.getElementById("budget-casino-title");
      if (!title) return;
      title.scrollIntoView({ behavior: prefersReduced() ? "auto" : "smooth", block: "start" });
      title.focus({ preventScroll: true });
    });
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
          ? money(estSweep) + " remains after every planned purchase. Choose where it goes before starting the new period."
          : "Nothing left over to sweep this time.") +
      "</p>" +
      (unhit.length
        ? '<p class="bt-modal-text">Didn\'t reach: ' + esc(unhit.map(u => u.title).join(", ")) + "</p>"
        : "") +
      (estSweep > 0 ? '<label class="bt-rollover-overflow">Unused overflow<select data-role="rollover-overflow"><option value="invest">Invest it and create a transfer task</option><option value="carry">Carry it into the new period</option></select></label>' : '') +
      (estSweep > 0 && (s.usage.overflow_cents || 0) > 0 ? '<button class="bt-btn bt-rollover-spin" data-act="overflow-spin">Spin the Overflow Wheel first</button>' : '') +
      '<div class="bt-form-actions"><span class="bt-rollover-label">Planned purchases:</span>' +
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

  // Card-style categories are automatic rollups, never editable envelopes.
  // Even a one-item category renders as a concrete purchase under its header.
  function categoryGroupMarkup(cat, u) {
    const collapsed = _collapsed.has(cat.key);
    const fillPct = Math.round((cat.fill_frac || 0) * 100);
    const statusText = cat.status === "claimed" ? "all claimed"
      : cat.status === "claimable" ? cat.claimable_count + " ready"
      : cat.status === "partial" ? cat.unlocked_count + "/" + cat.count + " unlocked"
      : "locked";
    const head =
      '<div class="bt-cat-head" data-cat="' + esc(cat.key) + '">' +
        '<button class="bt-cat-caret" type="button" data-act="toggle-cat" data-cat="' + esc(cat.key) + '" aria-label="Toggle ' + esc(cat.name) + '">' + (collapsed ? "▸" : "▾") + "</button>" +
        '<span class="bt-row-dot" style="background:' + esc(cat.color || "#f59e0b") + '"></span>' +
        '<span class="bt-cat-name">' + esc(cat.name) + "</span>" +
        '<span class="bt-row-tag">' + cat.count + " purchase" + (cat.count === 1 ? "" : "s") + "</span>" +
        '<span class="bt-cat-status bt--' + cat.status + '">' + statusText + "</span>" +
        '<span class="bt-cat-amt">' + money(cat.budget_cents) + "</span>" +
        '<span class="bt-cat-bar"><i style="width:' + fillPct + '%"></i></span>' +
      "</div>";
    const items = collapsed ? "" :
      '<div class="bt-cat-items">' +
        [...cat.items].reverse().map(b => blockRow(b, u)).join("") +
      "</div>";
    return '<div class="bt-cat" data-cat="' + esc(cat.key) + '">' + head + items + "</div>";
  }

  function classifyPurchase(description, s) {
    const text = String(description || "").toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim();
    const categories = (s.constants && s.constants.credit_card_categories) || [];
    return categories.find(category => category.id !== "other" &&
      (category.keywords || []).some(keyword => text.includes(String(keyword).toLowerCase()))) ||
      categories.find(category => category.id === "other") ||
      { id: "other", label: "Other", color: "#94a3b8" };
  }

  function blockFormMarkup(s) {
    const f = _form;
    const categories = (s.constants && s.constants.credit_card_categories) || [];
    const suggestion = classifyPurchase(f.description, s);
    return '<div class="bt-form" data-role="block-form">' +
      '<div class="bt-form-title">' + (f.id ? "Edit planned purchase" : "Add a planned purchase") + "</div>" +
      '<div class="bt-form-grid">' +
        '<label class="bt-form-wide">What do you want to buy?<input type="text" data-field="description" placeholder="Dinner for me and Fae" value="' + esc(f.description) + '"></label>' +
        '<label>Amount ($)<input type="number" data-field="amount" min="1" step="1" value="' + esc(f.amount) + '"></label>' +
        '<label>Card category<select data-field="category">' +
          '<option value="">Auto: ' + esc(suggestion.label) + "</option>" +
          categories.map(category => '<option value="' + esc(category.label) + '"' + (f.category === category.label ? " selected" : "") + '>' + esc(category.label) + "</option>").join("") +
        "</select></label>" +
      "</div>" +
      '<div class="bt-auto-category" data-role="auto-category"><span class="bt-auto-dot" style="background:' + esc(suggestion.color) + '"></span><span class="bt-auto-copy">Will file under <strong>' + esc(f.category || suggestion.label) + "</strong>. You can override it if the guess is off.</span></div>" +
      '<div class="bt-form-actions">' +
        '<button class="bt-btn bt-btn--primary" data-act="save-block">' + (f.id ? "Save purchase" : "Add purchase") + "</button>" +
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

  function vaultKind(item) {
    if (item.payment_source === "sponsored") return "sponsored";
    return item.max_cents > 0 ? "purchase" : "free";
  }

  function vaultPrice(item) {
    if (!item.max_cents) return "Free";
    if ((item.min_cents || 0) > 0 && item.min_cents !== item.max_cents) {
      return money(item.min_cents) + " to " + money(item.max_cents);
    }
    return money(item.max_cents);
  }

  function vaultCardCategory(item) {
    return classifyPurchase(item && item.title, _state || { constants: {} });
  }

  function vaultCard(item) {
    const kind = vaultKind(item);
    const cardCategory = vaultCardCategory(item);
    const channels = [item.quick_add && "Quick Add", item.random_draw && "Casino/Wheels", item.milestone && "Milestone"].filter(Boolean);
    const progress = _vault.milestones && _vault.milestones.progress && _vault.milestones.progress.total || 0;
    const checkpoints = ((_vault.milestones && _vault.milestones.items) || []).filter(marker => String(marker.reward_definition_id || "") === String(item.id));
    const checkpointMarkup = checkpoints.map(marker => {
      const state = marker.claimed ? "Claimed" : marker.claimable ? "Ready" : progress + "/" + marker.threshold_bank_units + " BU";
      return '<div class="rv-card-checkpoint" data-milestone-id="' + marker.id + '"><span><strong>' + marker.threshold_bank_units + ' BU checkpoint</strong>' + (marker.repeat_each_period ? ' · repeats' : '') + '</span><span class="rv-card-checkpoint-state">' + state + '</span><button data-act="milestone-delete" aria-label="Remove checkpoint">×</button></div>';
    }).join("");
    return '<article class="rv-card rv-card--' + kind + '" data-vault-id="' + item.id + '">' +
      '<div class="rv-card-top"><div><span class="rv-kind">' + (kind === "purchase" ? "Purchase" : kind === "free" ? "Self Care" : "Sponsored") + '</span>' +
        '<h4>' + esc(item.title) + '</h4></div><strong class="rv-price">' + esc(vaultPrice(item)) + '</strong></div>' +
      '<div class="rv-chips"><span class="rv-card-category"><i style="background:' + esc(cardCategory.color) + '"></i>' + esc(cardCategory.label) + '</span>' + channels.map(channel => '<span>' + esc(channel) + '</span>').join("") +
        '<span>' + (item.reuse_mode === "one_off" ? "One-off" : "Reusable") + '</span>' +
        (item.private ? '<span class="rv-private">Private</span>' : '<span>Sponsor-visible</span>') + '</div>' +
      checkpointMarkup +
      (item.notes ? '<p>' + esc(item.notes) + '</p>' : '') +
      '<div class="rv-actions">' +
        (item.quick_add && item.max_cents > 0 ? '<button class="bt-btn bt-btn--primary" data-act="vault-quick-add">Add ' + esc(money(item.max_cents)) + '</button>' : '') +
        (item.max_cents === 0 && item.milestone ? '<button class="bt-btn" data-act="milestone-from-item">Add checkpoint</button>' : '') +
        '<button class="bt-linkbtn" data-act="vault-edit">Edit</button>' +
        '<button class="bt-linkbtn rv-danger" data-act="vault-archive">Archive</button>' +
      '</div></article>';
  }

  function vaultFormMarkup() {
    if (!_vaultForm) return "";
    const f = _vaultForm;
    return '<form class="rv-form" data-role="vault-form">' +
      '<div class="rv-form-head"><strong>' + (f.id ? "Edit vault item" : "New vault item") + '</strong><button type="button" data-act="vault-form-cancel" aria-label="Close">×</button></div>' +
      '<label>Reward or purchase<input data-vf="title" value="' + esc(f.title || "") + '" placeholder="Nice dinner with Fae"></label>' +
      '<div class="rv-form-grid"><label>Type<select data-vf="type"><option value="paid"' + (f.type === "paid" ? " selected" : "") + '>Paid purchase</option><option value="free"' + (f.type === "free" ? " selected" : "") + '>Free self care</option></select></label>' +
      '<label>Reuse<select data-vf="reuse"><option value="reusable"' + (f.reuse === "reusable" ? " selected" : "") + '>Reusable</option><option value="one_off"' + (f.reuse === "one_off" ? " selected" : "") + '>One-off</option></select></label></div>' +
      '<div class="rv-form-grid rv-price-fields"><label>Minimum ($)<input type="number" min="0" step="1" data-vf="min" value="' + esc(f.min) + '"></label>' +
      '<label>Maximum reserved ($)<input type="number" min="0" step="1" data-vf="max" value="' + esc(f.max) + '"></label></div>' +
      '<label>Notes<textarea data-vf="notes" placeholder="What would make this feel rewarding?">' + esc(f.notes || "") + '</textarea></label>' +
      '<fieldset><legend>Where it can appear</legend>' +
        '<label><input type="checkbox" data-vf="quick"' + (f.quick ? " checked" : "") + '> Quick Add</label>' +
        '<label><input type="checkbox" data-vf="random"' + (f.random ? " checked" : "") + '> Casino and wheels</label>' +
        '<label><input type="checkbox" data-vf="milestone"' + (f.milestone ? " checked" : "") + '> Self-care checkpoints</label>' +
        '<label><input type="checkbox" data-vf="private"' + (f.private ? " checked" : "") + '> Private from sponsors</label>' +
      '</fieldset><button type="button" class="bt-btn bt-btn--primary" data-act="vault-form-save">Save item</button></form>';
  }

  function milestoneFormMarkup() {
    if (!_milestoneForm) return "";
    const free = (_vault.items || []).filter(item => item.max_cents === 0 && item.milestone);
    return '<form class="rv-form rv-milestone-form" data-role="milestone-form">' +
      '<div class="rv-form-head"><strong>Add self-care checkpoint</strong><button type="button" data-act="milestone-form-cancel" aria-label="Close">×</button></div>' +
      '<label>At how many Bank Units?<input type="number" min="1" step="1" data-mf="threshold" value="' + esc(_milestoneForm.threshold || "") + '" placeholder="75"></label>' +
      '<label>Reward<select data-mf="reward"><option value="">Mystery: choose or spin when reached</option>' +
        free.map(item => '<option value="' + item.id + '"' + (String(_milestoneForm.rewardId || "") === String(item.id) ? " selected" : "") + '>' + esc(item.title) + '</option>').join("") + '</select></label>' +
      '<label class="rv-check"><input type="checkbox" data-mf="repeat"' + (_milestoneForm.repeat ? " checked" : "") + '> Repeat every budget period</label>' +
      '<button type="button" class="bt-btn bt-btn--primary" data-act="milestone-form-save">Add checkpoint</button></form>';
  }

  function mysteryCheckpointCard(marker) {
    const milestones = _vault.milestones || { items: [], progress: { total: 0 } };
    const free = (_vault.items || []).filter(item => item.max_cents === 0 && item.milestone);
    const state = marker.claimed ? "Claimed" : marker.claimable ? "Ready" : milestones.progress.total + "/" + marker.threshold_bank_units + " BU";
    const choice = marker.claimable && !marker.claimed ? '<div class="rv-mystery-actions"><select data-role="mystery-choice"><option value="">Choose a free reward</option>' + free.map(item => '<option value="' + item.id + '">' + esc(item.title) + '</option>').join("") + '</select><button class="bt-btn" data-act="milestone-choose">Choose</button><button class="bt-btn bt-btn--primary" data-act="milestone-spin">Spin</button></div>' : '';
    return '<article class="rv-card rv-card--free rv-card--mystery" data-milestone-id="' + marker.id + '"><div class="rv-card-top"><div><span class="rv-kind">Mystery checkpoint</span><h4>' + marker.threshold_bank_units + ' Bank Units</h4></div><strong class="rv-price">' + state + '</strong></div><div class="rv-chips"><span>Free Self Care</span>' + (marker.repeat_each_period ? '<span>Repeats</span>' : '<span>One-time</span>') + '</div>' + choice + '<div class="rv-actions"><button class="bt-linkbtn rv-danger" data-act="milestone-delete">Remove</button></div></article>';
  }

  function vaultFilterMarkup({ id, label, plural, options, selected }) {
    const chosen = options.filter(option => selected.has(option.id));
    const only = chosen.length === 1 ? chosen[0] : null;
    const summary = chosen.length === options.length ? "All " + plural :
      chosen.length === 0 ? "No " + plural :
      only ? only.label : chosen.length + " " + plural;
    const total = options.reduce((sum, option) => sum + option.count, 0);
    const open = _vaultFilterOpen === id;
    return '<div class="rv-filter-wrap" data-role="vault-filter" data-filter-id="' + id + '">' +
      '<button type="button" class="rv-filter-trigger' + (chosen.length !== options.length ? ' selected' : '') + '" data-act="vault-filter-menu" data-filter-id="' + id + '" aria-haspopup="true" aria-expanded="' + (open ? 'true' : 'false') + '" aria-controls="rv-' + id + '-menu"><strong>' + esc(label) + '</strong><span class="rv-filter-summary">' + esc(summary) + '</span><span aria-hidden="true">⌄</span></button>' +
      (open ? '<div class="rv-filter-menu" id="rv-' + id + '-menu" role="group" aria-label="Filter rewards by ' + esc(label.toLowerCase()) + '">' +
        '<label class="rv-filter-option rv-filter-option--all"><input type="checkbox" data-role="vault-filter-all" data-filter-id="' + id + '"' + (chosen.length === options.length ? ' checked' : '') + '><span><strong>All ' + esc(plural) + '</strong><small>' + total + '</small></span></label>' +
        options.map(option => '<label class="rv-filter-option"><input type="checkbox" data-role="vault-filter-option" data-filter-id="' + id + '" value="' + option.id + '"' + (selected.has(option.id) ? ' checked' : '') + '><span><strong>' + esc(option.label) + '</strong><small>' + option.count + '</small></span></label>').join("") +
      '</div>' : '') + '</div>';
  }

  function vaultDrawerMarkup() {
    if (!_vaultOpen) return "";
    const query = _vaultSearch.toLowerCase();
    const allItems = _vault.items || [];
    const allMysteryMarkers = ((_vault.milestones && _vault.milestones.items) || []).filter(marker => marker.mystery);
    const cardCategories = (((_state || {}).constants || {}).credit_card_categories || []).map(category => ({
      id: category.id,
      label: category.label,
      count: allItems.filter(item => vaultCardCategory(item).id === category.id).length + (category.id === "other" ? allMysteryMarkers.length : 0),
    }));
    if (_vaultCardCategories === null) _vaultCardCategories = new Set(cardCategories.map(category => category.id));
    const items = allItems.filter(item =>
      _vaultCardCategories.has(vaultCardCategory(item).id) &&
      (!query || String(item.title || "").toLowerCase().includes(query))
    );
    const mysteryMarkers = allMysteryMarkers.filter(marker =>
      _vaultCardCategories.has("other") && (!query || "mystery checkpoint".includes(query))
    );
    const types = [
      { id: "purchase", label: "Purchases", description: "Paid rewards and reusable things to buy", count: allItems.filter(item => vaultKind(item) === "purchase").length },
      { id: "free", label: "Free Self Care", description: "No-cost moments and Bank Unit checkpoints", count: allItems.filter(item => vaultKind(item) === "free").length + allMysteryMarkers.length },
      { id: "sponsored", label: "Sponsored", description: "Rewards offered or funded by sponsors", count: allItems.filter(item => vaultKind(item) === "sponsored").length },
    ];
    const typeSections = types.filter(type => _vaultTypes.has(type.id)).map(type => {
      const typeItems = items.filter(item => vaultKind(item) === type.id);
      const cards = typeItems.map(vaultCard).concat(type.id === "free" ? mysteryMarkers.map(mysteryCheckpointCard) : []);
      if (query && !cards.length) return "";
      const action = type.id === "free" ? '<button class="bt-linkbtn" data-act="milestone-new">+ Mystery checkpoint</button>' : '';
      return '<section class="rv-category-section rv-category-section--' + type.id + '"><div class="rv-category-head"><div class="rv-category-title"><span class="rv-category-dot" aria-hidden="true"></span><div><h3>' + esc(type.label) + ' <span>' + cards.length + '</span></h3><p>' + esc(type.description) + '</p></div></div>' + action + '</div><div class="rv-grid">' + (cards.join("") || '<div class="rv-empty">No items match this category filter.</div>') + '</div></section>';
    }).join("");
    const progress = _vault.milestones && _vault.milestones.progress && _vault.milestones.progress.total || 0;
    return '<div class="rv-backdrop" data-role="vault-backdrop"><aside class="rv-drawer" role="dialog" aria-modal="true" aria-labelledby="rv-title" data-role="vault-drawer">' +
      '<header class="rv-head"><div><span class="rv-eyebrow">Budget rewards</span><h2 id="rv-title">Reward Vault</h2><p>One library for your plan, checkpoints, casino, and sponsors.</p></div><button class="rv-close" data-act="vault-close" aria-label="Close Reward Vault">×</button></header>' +
      '<div class="rv-toolbar"><input type="search" data-role="vault-search" value="' + esc(_vaultSearch) + '" placeholder="Search rewards"><button class="bt-btn bt-btn--primary" data-act="vault-new">+ New item</button></div>' +
      '<div class="rv-filterbar">' +
        vaultFilterMarkup({ id: "type", label: "Type", plural: "types", options: types, selected: _vaultTypes }) +
        vaultFilterMarkup({ id: "category", label: "Category", plural: "categories", options: cardCategories, selected: _vaultCardCategories }) +
      '</div>' +
      '<div class="rv-scroll">' + vaultFormMarkup() + milestoneFormMarkup() + '<section class="rv-sponsor-share"><div class="rv-sponsor-copy"><h3>Sponsor link</h3><p>Shows shared rewards only. Private cards and balances stay hidden.</p></div>' +
        (_sponsorLink && _sponsorLink.active ? '<div class="rv-share-row"><input readonly value="' + esc(location.origin + "/sponsor/" + _sponsorLink.token) + '" data-role="sponsor-url" aria-label="Guest sponsor link"><button class="bt-btn" data-act="sponsor-copy">Copy</button><button class="bt-linkbtn rv-danger" data-act="sponsor-revoke">Revoke</button></div>' : '<button class="bt-btn rv-sponsor-create" data-act="sponsor-create">Create link</button>') + '</section>' +
        '<div class="rv-vault-heading"><h3>Vault items</h3><p>Paid ranges reserve the maximum · ' + progress + ' Bank Units this period</p></div>' +
        (typeSections || '<div class="rv-empty rv-empty--categories">No rewards match the selected filters.</div>') + '</div>' +
      '</aside></div>';
  }

  function overflowMarkup(s) {
    const overflow = s.usage.overflow_cents || 0;
    if (overflow <= 0) return "";
    const affordable = (_vault.items || []).filter(item => item.random_draw && item.payment_source === "self" && item.max_cents > 0 && item.max_cents <= overflow);
    return '<div class="bt-group bt-overflow"><div class="bt-group-head"><span class="bt-group-title">Overflow Pool</span><span class="bt-group-sub">all planned purchases are covered</span></div><div class="bt-overflow-main"><div><strong>' + money(overflow) + '</strong><span>available for an affordable Vault prize</span></div><button class="bt-btn bt-btn--primary" data-act="overflow-spin"' + (!affordable.length ? " disabled" : "") + '>Spin the prize wheel</button></div>' + (!affordable.length ? '<p class="bt-overflow-note">Add a paid Casino/Wheels item priced at ' + money(overflow) + ' or less.</p>' : '<p class="bt-overflow-note">' + affordable.length + ' affordable prize' + (affordable.length === 1 ? '' : 's') + ' in the draw.</p>') + '</div>';
  }

  async function autoResolveSpecificMilestones() {
    if (_autoResolving || !_vault || !_vault.milestones) return;
    const marker = (_vault.milestones.items || []).find(item => item.claimable && item.reward_definition_id);
    if (!marker) return;
    _autoResolving = true;
    try {
      const out = await api("POST", "/api/budget/milestones/" + marker.id + "/resolve", { mode: "specific" });
      toast("Self care unlocked: " + (out.reward && out.reward.title || marker.reward_title), "success");
      if (typeof window.loadRewardsQueue === "function") window.loadRewardsQueue();
      await loadBudget();
    } catch (err) { toast(err.message || "Could not unlock self care", "error"); }
    finally { _autoResolving = false; }
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
      (u.overflow_cents > 0 ? chip("ok", "Overflow " + money(u.overflow_cents)) : "") +
      (s.investments.total_cents > 0 ? chip("ok", "Invested " + money(s.investments.total_cents)) : "") +
      (s.rollover_due ? chip("warn", "New " + period + " — rollover pending") : "");

    // Standalone budget ledger: category groups in their own stable order
    // (divorced from the tank's priority order).
    const catGroups = s.categories.map(cat => categoryGroupMarkup(cat, u)).join("");

    root.innerHTML =
      '<div class="bt-wrap">' +
        '<div class="bt-head">' +
          '<h2 class="bt-title">Budget Tank</h2>' +
          '<p class="bt-sub">Add the actual things you want to buy. Bank builds fund them bottom-to-top, and each purchase automatically rolls into a card-style category.</p>' +
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
              '<div class="bt-group-head"><span class="bt-group-title">Planned purchases</span>' +
                '<span class="bt-group-sub">concrete items · auto-categorized · bottom fills first</span></div>' +
              (catGroups || '<div class="bt-empty-note">Nothing planned yet. Add the actual purchase, like “Dinner for me and Fae” for $100, and the category will take care of itself.</div>') +
              (!_form ? '<button class="bt-add" data-act="add-block">+ add planned purchase</button>' : "") +
              (_form ? blockFormMarkup(s) : "") +
            "</div>" +
            '<div class="bt-group">' +
              '<div class="bt-group-head"><span class="bt-group-title">Necessities</span>' +
                '<span class="bt-group-sub">the reef floor · always covered</span></div>' +
              necessitiesMarkup(s) +
              '<button class="bt-vault-launch" data-act="vault-open"><span>Reward Vault</span><small>' + (_vault.items || []).length + ' rewards · self care · sponsor prizes</small><b>Open →</b></button>' +
            "</div>" +
            overflowMarkup(s) +
            investmentsMarkup(s) +
          "</div>" +
        "</div>" +
        (s.rollover_due && !_rolloverSnoozed ? rolloverModalMarkup(s) : "") + vaultDrawerMarkup() +
      "</div>";

    maybeCelebrate();
  }

  function chip(kind, text) {
    return '<span class="bt-chip bt-chip--' + kind + '">' + esc(text) + "</span>";
  }

  // ---- block form helpers ----------------------------------------------------
  function openForm(block) {
    if (block) {
      _form = {
        id: block.id,
        description: block.item || block.title,
        amount: Math.round(block.value_cents / 100),
        category: block.category || "",
        recurring: !!block.tank_recurring,
      };
    } else {
      _form = { id: null, description: "", amount: "", category: "", recurring: false };
    }
    render();
    const first = document.querySelector('#budget-root [data-field="description"]');
    if (first) first.focus();
  }

  function readForm(root) {
    const get = f => root.querySelector('[data-field="' + f + '"]');
    return {
      description: get("description").value.trim(),
      category: get("category").value.trim(),
      amount: Number(get("amount").value),
      recurring: !!(_form && _form.recurring),
    };
  }

  async function saveForm() {
    const root = document.getElementById("budget-root");
    const f = readForm(root);
    if (!f.description) { toast("What are you planning to buy?", "error"); return; }
    if (!(f.amount > 0)) { toast("Give the purchase a positive amount", "error"); return; }
    const body = { category: f.category, description: f.description, amount: f.amount, recurring: f.recurring };
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

  function openVaultForm(item) {
    _vaultForm = item ? {
      id: item.id, title: item.title, type: item.max_cents > 0 ? "paid" : "free",
      min: Math.round((item.min_cents || 0) / 100), max: Math.round((item.max_cents || 0) / 100),
      reuse: item.reuse_mode, quick: item.quick_add, random: item.random_draw,
      milestone: item.milestone, private: item.private, notes: item.notes || "",
    } : { id: null, title: "", type: "paid", min: "", max: "", reuse: "reusable", quick: true, random: true, milestone: false, private: false, notes: "" };
    render();
    requestAnimationFrame(() => document.querySelector('[data-vf="title"]')?.focus());
  }

  async function saveVaultForm(root) {
    const form = root.querySelector('[data-role="vault-form"]');
    if (!form) return;
    const get = key => form.querySelector('[data-vf="' + key + '"]');
    const type = get("type").value;
    const max = type === "free" ? 0 : Math.max(0, Number(get("max").value) || 0);
    const min = type === "free" ? 0 : Math.max(0, Number(get("min").value) || 0);
    const body = {
      title: get("title").value.trim(), min_cents: Math.round(min * 100), max_cents: Math.round(max * 100),
      kind: type === "free" ? "free" : "bank_gated", payment_source: type === "free" ? "free" : "self",
      reuse_mode: get("reuse").value, quick_add: type === "paid" && get("quick").checked,
      random_draw: get("random").checked, milestone: type === "free" && get("milestone").checked,
      private: get("private").checked, notes: get("notes").value,
    };
    if (!body.title) { toast("Give the vault item a name", "error"); return; }
    if (type === "paid" && !(max > 0)) { toast("Paid rewards need a maximum amount", "error"); return; }
    try {
      if (_vaultForm.id) await api("PUT", "/api/budget/vault/" + _vaultForm.id, body);
      else await api("POST", "/api/budget/vault", body);
      _vaultForm = null;
      toast("Vault item saved", "success");
      await loadBudget();
    } catch (err) { toast(err.message || "Could not save vault item", "error"); }
  }

  async function saveMilestoneForm(root) {
    const form = root.querySelector('[data-role="milestone-form"]');
    if (!form) return;
    const threshold = Math.floor(Number(form.querySelector('[data-mf="threshold"]').value));
    if (!(threshold > 0)) { toast("Set a positive Bank Unit threshold", "error"); return; }
    try {
      await api("POST", "/api/budget/milestones", {
        threshold_bank_units: threshold,
        reward_definition_id: form.querySelector('[data-mf="reward"]').value || null,
        repeat_each_period: form.querySelector('[data-mf="repeat"]').checked,
      });
      _milestoneForm = null;
      toast("Self-care checkpoint added", "success");
      await loadBudget();
    } catch (err) { toast(err.message || "Could not add checkpoint", "error"); }
  }

  function closeVault(root) {
    _vaultOpen = false;
    _vaultFilterOpen = null;
    _vaultForm = null;
    _milestoneForm = null;
    render();
    requestAnimationFrame(() => root.querySelector('[data-act="vault-open"]')?.focus());
  }

  // ---- events (delegated, bound once) --------------------------------------------
  function bind() {
    const root = document.getElementById("budget-root");
    if (!root || root.dataset.bound) return;
    root.dataset.bound = "1";

    root.addEventListener("click", async e => {
      if (_vaultFilterOpen && !e.target.closest('[data-role="vault-filter"]')) {
        _vaultFilterOpen = null;
        root.querySelector(".rv-filter-menu")?.remove();
        const trigger = root.querySelector('[data-act="vault-filter-menu"][aria-expanded="true"]');
        if (trigger) trigger.setAttribute("aria-expanded", "false");
      }
      if (e.target && e.target.dataset && e.target.dataset.role === "vault-backdrop") {
        closeVault(root); return;
      }
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
          const overflowSelect = root.querySelector('[data-role="rollover-overflow"]');
          const out = await api("POST", "/api/budget/rollover", {
            mode: act === "rollover-carry" ? "carry" : "fresh",
            overflow_action: overflowSelect ? overflowSelect.value : "invest",
          });
          const bits = [];
          if (out.swept_cents > 0) bits.push(money(out.swept_cents) + " swept to investments" + (out.task_block_id ? " (transfer task on today)" : ""));
          if (out.carried_over_cents > 0) bits.push(money(out.carried_over_cents) + " carried into the new period");
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
      if (act === "vault-open") { _vaultOpen = true; render(); requestAnimationFrame(() => root.querySelector('[data-role="vault-search"]')?.focus()); return; }
      if (act === "vault-close") { closeVault(root); return; }
      if (act === "vault-filter-menu") {
        const filterId = btn.dataset.filterId;
        _vaultFilterOpen = _vaultFilterOpen === filterId ? null : filterId;
        render();
        requestAnimationFrame(() => (_vaultFilterOpen ? root.querySelector('[data-role="vault-filter-all"][data-filter-id="' + filterId + '"]') : root.querySelector('[data-act="vault-filter-menu"][data-filter-id="' + filterId + '"]'))?.focus());
        return;
      }
      if (act === "vault-new") { openVaultForm(null); return; }
      if (act === "vault-form-cancel") { _vaultForm = null; render(); return; }
      if (act === "vault-form-save") { await saveVaultForm(root); return; }
      if (act === "vault-edit") {
        const card = btn.closest("[data-vault-id]");
        const item = (_vault.items || []).find(entry => String(entry.id) === card.dataset.vaultId);
        if (item) openVaultForm(item);
        return;
      }
      if (act === "vault-archive") {
        const card = btn.closest("[data-vault-id]");
        try { await api("DELETE", "/api/budget/vault/" + card.dataset.vaultId); toast("Vault item archived", "success"); await loadBudget(); }
        catch (err) { toast(err.message || "Could not archive item", "error"); }
        return;
      }
      if (act === "vault-quick-add") {
        const card = btn.closest("[data-vault-id]");
        btn.disabled = true;
        try { await api("POST", "/api/budget/vault/" + card.dataset.vaultId + "/quick-add"); toast("Added to planned purchases at the maximum amount", "success"); await loadBudget(); }
        catch (err) { toast(err.message || "Could not add purchase", "error"); btn.disabled = false; }
        return;
      }
      if (act === "sponsor-create") {
        try { const out = await api("POST", "/api/budget/sponsor-link/rotate"); _sponsorLink = out.link; render(); toast("Guest sponsor link created", "success"); }
        catch (err) { toast(err.message || "Could not create sponsor link", "error"); }
        return;
      }
      if (act === "sponsor-copy") {
        const input = root.querySelector('[data-role="sponsor-url"]');
        try { await navigator.clipboard.writeText(input.value); toast("Sponsor link copied", "success"); }
        catch (err) { input.select(); document.execCommand("copy"); toast("Sponsor link copied", "success"); }
        return;
      }
      if (act === "sponsor-revoke") {
        try { await api("DELETE", "/api/budget/sponsor-link"); _sponsorLink = null; render(); toast("Sponsor link revoked", "success"); }
        catch (err) { toast(err.message || "Could not revoke link", "error"); }
        return;
      }
      if (act === "milestone-new") { _milestoneForm = { rewardId: null, threshold: "", repeat: false }; render(); return; }
      if (act === "milestone-from-item") {
        const card = btn.closest("[data-vault-id]");
        _milestoneForm = { rewardId: card.dataset.vaultId, threshold: "", repeat: false }; render(); return;
      }
      if (act === "milestone-form-cancel") { _milestoneForm = null; render(); return; }
      if (act === "milestone-form-save") { await saveMilestoneForm(root); return; }
      if (act === "milestone-delete") {
        const marker = btn.closest("[data-milestone-id]");
        try { await api("DELETE", "/api/budget/milestones/" + marker.dataset.milestoneId); await loadBudget(); }
        catch (err) { toast(err.message || "Could not remove checkpoint", "error"); }
        return;
      }
      if (act === "milestone-spin" || act === "milestone-choose") {
        const marker = btn.closest("[data-milestone-id]");
        const choice = marker.querySelector('[data-role="mystery-choice"]');
        if (act === "milestone-choose" && !(choice && choice.value)) { toast("Choose a free reward first", "error"); return; }
        btn.disabled = true;
        try {
          const out = await api("POST", "/api/budget/milestones/" + marker.dataset.milestoneId + "/resolve", {
            mode: act === "milestone-choose" ? "choose" : "spin", reward_id: choice && choice.value || null,
          });
          toast("Self care unlocked: " + (out.reward && out.reward.title || "Reward"), "success");
          if (typeof window.loadRewardsQueue === "function") window.loadRewardsQueue();
          await loadBudget();
        } catch (err) { toast(err.message || "Could not resolve checkpoint", "error"); btn.disabled = false; }
        return;
      }
      if (act === "overflow-spin") {
        if (!_overflowKey) _overflowKey = (crypto.randomUUID ? crypto.randomUUID() : "overflow-" + Date.now() + "-" + Math.random().toString(36).slice(2));
        btn.disabled = true;
        try {
          const out = await api("POST", "/api/budget/overflow/spin", { source_key: _overflowKey });
          _overflowKey = null;
          const title = out.reward && out.reward.title || out.spin && out.spin.title || "Vault reward";
          toast("Overflow Wheel landed on “" + title + "”", "success");
          if (typeof window.loadRewardsQueue === "function") window.loadRewardsQueue();
          await loadBudget();
        } catch (err) { toast(err.message || "Overflow Wheel could not spin", "error"); btn.disabled = false; }
        return;
      }
      if (act === "convert-max") {
        const input = root.querySelector('[data-role="convert-amt"]');
        if (input) { input.value = _state.points; updateConvertPreview(root); }
        return;
      }
      if (act === "open-casino") {
        showCasino();
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
          const units = out.bank_units || (out.conversion && out.conversion.points) || pts;
          toast(out.duplicate ? "Already converted that batch" : "Clink: " + units + " Bank Units (" + money(cents) + ") into the tank", "success");
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
      if (act === "add-block") { openForm(null); return; }
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
      if (e.target.dataset.role === "vault-search") {
        _vaultSearch = e.target.value;
        const caret = e.target.selectionStart;
        render();
        requestAnimationFrame(() => { const input = root.querySelector('[data-role="vault-search"]'); if (input) { input.focus(); input.setSelectionRange(caret, caret); } });
        return;
      }
      if (e.target.dataset.role === "convert-amt") updateConvertPreview(root);
      if (e.target.dataset.field === "description" && _state) {
        const category = classifyPurchase(e.target.value, _state);
        const preview = root.querySelector('[data-role="auto-category"]');
        const select = root.querySelector('[data-field="category"]');
        if (preview && (!select || !select.value)) {
          preview.innerHTML = '<span class="bt-auto-dot" style="background:' + esc(category.color) + '"></span><span class="bt-auto-copy">Will file under <strong>' + esc(category.label) + '</strong>. You can override it if the guess is off.</span>';
        }
        const autoOption = select && select.querySelector('option[value=""]');
        if (autoOption) autoOption.textContent = "Auto: " + category.label;
      }
    });

    // Everything editable in place commits on blur/Enter (change), never per
    // keystroke — so a full re-render after save can't eat what you're typing.
    root.addEventListener("change", async e => {
      const role = e.target.dataset.role;
      if (role === "vault-filter-all") {
        const filterId = e.target.dataset.filterId;
        const optionIds = filterId === "type" ? ["purchase", "free", "sponsored"] :
          (((_state || {}).constants || {}).credit_card_categories || []).map(category => category.id);
        const next = e.target.checked ? new Set(optionIds) : new Set();
        if (filterId === "type") _vaultTypes = next;
        else _vaultCardCategories = next;
        _vaultFilterOpen = filterId;
        render();
        requestAnimationFrame(() => root.querySelector('[data-role="vault-filter-all"][data-filter-id="' + filterId + '"]')?.focus());
      } else if (role === "vault-filter-option") {
        const filterId = e.target.dataset.filterId;
        const option = e.target.value;
        const next = new Set(filterId === "type" ? _vaultTypes : _vaultCardCategories);
        if (e.target.checked) next.add(option);
        else next.delete(option);
        if (filterId === "type") _vaultTypes = next;
        else _vaultCardCategories = next;
        _vaultFilterOpen = filterId;
        render();
        requestAnimationFrame(() => root.querySelector('[data-role="vault-filter-option"][data-filter-id="' + filterId + '"][value="' + option + '"]')?.focus());
      } else if (e.target.dataset.field === "category") {
        const description = root.querySelector('[data-field="description"]');
        const automatic = classifyPurchase(description && description.value, _state);
        const chosen = ((e.target.value && ((_state.constants.credit_card_categories || []).find(category => category.label === e.target.value))) || automatic);
        const preview = root.querySelector('[data-role="auto-category"]');
        if (preview) preview.innerHTML = '<span class="bt-auto-dot" style="background:' + esc(chosen.color) + '"></span><span class="bt-auto-copy">Will file under <strong>' + esc(chosen.label) + '</strong>. You can override it if the guess is off.</span>';
      } else if (role === "income-input") {
        const dollars = Math.max(0, Math.round(Number(e.target.value) || 0));
        try { await api("PUT", "/api/budget/config", { income_cents: dollars * 100, capacity_source: "last_income" }); await loadBudget(); }
        catch (err) { toast(err.message || "Could not save income", "error"); }
      } else if (role === "nec") {
        saveNecessities(gatherNecessities(root));
      } else if (role === "item-name" || role === "item-amt") {
        saveBlockInline(e.target);
      }
    });

    root.addEventListener("keydown", e => {
      if (e.key === "Escape" && _vaultFilterOpen) {
        e.preventDefault();
        const filterId = _vaultFilterOpen;
        _vaultFilterOpen = null;
        render();
        requestAnimationFrame(() => root.querySelector('[data-act="vault-filter-menu"][data-filter-id="' + filterId + '"]')?.focus());
        return;
      }
      if (e.key === "Escape" && _vaultOpen) { e.preventDefault(); closeVault(root); return; }
      if (e.key === "Tab" && _vaultOpen) {
        const drawer = root.querySelector('[data-role="vault-drawer"]');
        if (!drawer) return;
        const focusable = Array.from(drawer.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'))
          .filter(el => el.offsetParent !== null);
        if (!focusable.length) { e.preventDefault(); drawer.focus(); return; }
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))) {
          e.preventDefault(); last.focus(); return;
        }
        if (!e.shiftKey && (document.activeElement === last || !drawer.contains(document.activeElement))) {
          e.preventDefault(); first.focus(); return;
        }
      }
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
    document.addEventListener("slot-changed", (e) => {
      if (_dragId != null || _form) return;
      const root = document.getElementById("budget-root");
      if (!root) return;
      if (root.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
      // Arm the bank-feed only for a shell all-done bonus (see routes/slots.js).
      if (e && e.detail && e.detail.bonus_kind === "shell") {
        _shellBonusPending = true;
        _shellBonusTitle = e.detail.title || "";
      }
      loadBudget();
    });

    const casinoBack = document.getElementById("budget-casino-back");
    if (casinoBack && !casinoBack.dataset.bound) {
      casinoBack.dataset.bound = "1";
      casinoBack.addEventListener("click", () => {
        showBudgetHome({ focus: true });
        loadBudget();
      });
    }
  }

  function updateConvertPreview(root) {
    const input = root.querySelector('[data-role="convert-amt"]');
    const preview = root.querySelector('[data-role="convert-preview"]');
    if (!input || !preview || !_state) return;
    const pts = Math.max(0, Math.floor(Number(input.value)) || 0);
    const rate = _state.constants.bank_unit_cents || _state.constants.cents_per_point;
    preview.textContent = pts + " Bank Unit" + (pts === 1 ? "" : "s") + " → " + money(pts * rate) + " into the tank";
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
    const name = nameEl ? nameEl.value.trim() : (block.item || block.title);
    const amount = amtEl ? Math.max(0, Math.round(Number(amtEl.value) || 0)) : Math.round(block.value_cents / 100);
    const body = { description: name, amount, recurring: block.tank_recurring };
    try { await api("PUT", "/api/budget/blocks/" + block.id, body); await loadBudget(); }
    catch (err) { toast(err.message || "Could not save", "error"); }
  }

  // ---- shell-to-tank tie-in (bank feed) ---------------------------------------
  // A silver bar drops onto the Money Changer and its points balance ticks up,
  // reusing Celebrate's flow-into-the-counter physics (which already honors
  // prefers-reduced-motion). Honest metaphor: the bonus is banked points, so the
  // Money Changer — the coin slot that feeds the tank — is what visibly moves.
  const SILVER_COLORS = ["#f1f5f9", "#e2e8f0", "#cbd5e1", "#94a3b8"]; // shell's silver language (#197)

  function prefersReduced() {
    try { return !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches); }
    catch (e) { return false; }
  }

  function ptsFmt(n) { return n + " pts"; }

  // The balance element only has layout when the Budget tab is the active one;
  // a zero-size rect means the tab is hidden, so we badge instead of animate.
  function balanceEl() { return document.querySelector("#budget-root .bt-changer-balance"); }
  function isVisible(el) {
    if (!el || el.offsetParent == null) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function budgetTabBtn() { return document.querySelector('.tab[data-tab="budget"]'); }
  function setTabBadge(on) { const b = budgetTabBtn(); if (b) b.classList.toggle("bt-has-bonus", !!on); }

  // Inject the bank-feed CSS once (kept in-file so this phase touches only budget.js).
  function ensureBankFeedCss() {
    if (document.getElementById("bt-bankfeed-css")) return;
    const css =
      ".bt-bank-bar{position:fixed;width:52px;height:26px;border-radius:5px;z-index:99998;pointer-events:none;" +
        "background:linear-gradient(135deg,#f8fafc,#cbd5e1 46%,#94a3b8);" +
        "box-shadow:0 8px 18px rgba(100,116,139,.45),inset 0 1px 0 rgba(255,255,255,.85),inset 0 -2px 3px rgba(71,85,105,.35);" +
        "animation:bt-bar-drop .52s cubic-bezier(.34,1.28,.5,1) both}" +
      ".bt-bank-bar::after{content:'';position:absolute;top:3px;left:6px;right:6px;height:6px;border-radius:3px;" +
        "background:linear-gradient(90deg,transparent,rgba(255,255,255,.9),transparent)}" +
      "@keyframes bt-bar-drop{0%{transform:translateY(-130px) rotate(-6deg);opacity:0}" +
        "18%{opacity:1}80%{transform:translateY(5px) rotate(1deg)}100%{transform:translateY(0) rotate(0)}}" +
      ".tab.bt-has-bonus{position:relative}" +
      ".tab.bt-has-bonus::after{content:'';position:absolute;top:5px;right:5px;width:8px;height:8px;border-radius:50%;" +
        "background:linear-gradient(135deg,#f1f5f9,#94a3b8);box-shadow:0 0 0 2px rgba(148,163,184,.35);" +
        "animation:bt-badge-pulse 1.8s ease-in-out infinite}" +
      "@keyframes bt-badge-pulse{0%,100%{transform:scale(1);opacity:.9}50%{transform:scale(1.25);opacity:1}}" +
      "@media (prefers-reduced-motion:reduce){.tab.bt-has-bonus::after{animation:none}}";
    const style = document.createElement("style");
    style.id = "bt-bankfeed-css";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function dropSilverBar(x, y, onDone) {
    ensureBankFeedCss();
    const bar = document.createElement("div");
    bar.className = "bt-bank-bar";
    bar.setAttribute("aria-hidden", "true");
    bar.style.left = (x - 26) + "px";
    bar.style.top = (y - 13) + "px";
    document.body.appendChild(bar);
    let done = false;
    const finish = () => { if (done) return; done = true; bar.remove(); if (onDone) onDone(); };
    bar.addEventListener("animationend", finish, { once: true });
    setTimeout(finish, 900); // safety net if animationend never fires
  }

  // Play the one-shot moment for `delta` banked points against the currently
  // visible balance. Returns false if the tank isn't visible (caller badges).
  function playBankFeed(delta) {
    const bal = balanceEl();
    if (!isVisible(bal) || !(delta > 0) || !_state || typeof _state.points !== "number") return false;
    const after = _state.points;
    const before = Math.max(0, after - delta);
    const tick = () => {
      if (window.Celebrate && Celebrate.countNumber) Celebrate.countNumber(bal, before, after, { format: ptsFmt });
      else bal.textContent = ptsFmt(after);
    };
    const r = bal.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    bal.textContent = ptsFmt(before); // start low so the tick reads as a gain
    const credit = _pendingBonusTitle ? "“" + _pendingBonusTitle + "” bonus" : "Bonus";
    try { toast("🥈 " + credit + " banked · +" + delta + " pts", "success"); } catch (e) {}
    _pendingBonusTitle = "";
    if (prefersReduced() || !window.Celebrate) { tick(); return true; }
    dropSilverBar(cx, cy, () => {
      Celebrate.confetti({ x: cx, y: cy - 42, flowTo: { x: cx, y: cy }, colors: SILVER_COLORS, count: 46, onArrive: tick });
    });
    return true;
  }

  // Called at the tail of every render(): play a queued bonus if the tank is on
  // screen, otherwise badge the tab so the moment isn't missed. Idempotent — it
  // clears _pendingBonus only once actually played.
  function maybeCelebrate() {
    if (!_state || _state.error || _pendingBonus <= 0) return;
    if (playBankFeed(_pendingBonus)) { _pendingBonus = 0; setTabBadge(false); }
    else setTabBadge(true);
  }

  // ---- public entry -------------------------------------------------------------
  function renderBudget() {
    ensureBankFeedCss();
    showBudgetHome();
    render();  // paint cached state immediately on tab switch
    bind();
    loadBudget();
    // Phase 0's localStorage config is dead — server owns the tank now.
    try { localStorage.removeItem("pa-budget-config"); } catch (e) {}
  }

  window.renderBudget = renderBudget;
  window.Budget = { render: renderBudget, reload: loadBudget };
})();
