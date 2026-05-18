(function(){
  let slotState = null;
  let filter = "all";
  let rewardSearch = "";
  let rewardCategory = "all";
  let rewardPrice = "all";
  let rewardEligibility = "all";
  let rewardSort = "category";
  let editingId = null;
  let isSpinning = false;
  let lastPendingBankCents = 0;
  let pendingDeleteRewardId = null;
  const AWARD_QUEUE_KEY = "pa-slot-award-queue";
  const coinPhysics = { coins: [], raf: null, lastTs: 0 };
  const KIND_LABELS = {
    miss: "No prize",
    free: "Free",
    small_paid: "Jackpot",
    bank_gated: "Jackpot",
    sponsor: "Sponsor",
    choice: "Choice",
    reroll: "Reroll"
  };
  const FORM_SUBTITLES = {
    miss: "No-prize outcome",
    free: "Free outcome",
    small_paid: "Money-cost jackpot",
    bank_gated: "Jackpot Jar reward",
    sponsor: "Partner-sponsored reward",
    choice: "Choice reward",
    reroll: "Reroll outcome"
  };
  const SPONSOR_LABELS = {
    self: "Self",
    accountability_partner: "Accountability",
    romantic_partner: "Romantic",
    either_partner: "Either partner"
  };
  const SPIN_SYMBOLS = ["HAT","STRAW","STICK","BRICK","BANK","CARE","BONUS","WILD","HOUSE","TOOLS","STAR","JACKPOT","PLEDGE","PICK"];
  const FILLER_SYMBOLS = ["STRAW","STICK","BRICK","HAT","TOOLS","HOUSE"];
  const TEASER_SYMBOLS = ["CARE","BONUS","BANK","JACKPOT","PLEDGE","PICK","REROLL"];
  const PAYLINES = [
    [0,1,2], [1,2,3], [2,3,4],
    [5,6,7], [6,7,8], [7,8,9],
    [10,11,12], [11,12,13], [12,13,14],
    [0,6,12], [2,6,10], [4,8,12], [2,8,14]
  ];

  function money(cents){
    return "$" + ((cents || 0) / 100).toFixed(2);
  }

  function pointLabel(count){
    return count + " point" + (count === 1 ? "" : "s");
  }

  function esc(s){
    return String(s == null ? "" : s).replace(/[&<>"']/g, ch => ({
      "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
    })[ch]);
  }

  async function api(path, opts){
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if(!res.ok) throw new Error(data.error || "Slot request failed");
    return data;
  }

  async function loadSlots(){
    const root = document.getElementById("tab-slots");
    if(!root) return;
    try {
      slotState = await api("/api/slot/state");
      renderSlots();
    } catch(e) {
      const result = document.getElementById("slot-result");
      if(result) result.textContent = e.message;
    }
  }

  function renderSlots(){
    if(!slotState) return;
    const account = slotState.account || {};
    const credits = account.point_balance || 0;
    setText("slot-credit-balance", String(credits));
    renderPiggyBank(false);
    renderSettings();
    const badge = document.getElementById("slots-credit-badge");
    if(badge){
      badge.textContent = String(credits);
      badge.style.display = credits > 0 ? "" : "none";
    }
    const bu = slotState.bankUsage || {};
    const constants = slotState.constants || {};
    setText("slot-daily-cap", "Bank bonuses: " + money(bu.today || 0) + " today; " + money(bu.week || 0) + " this week");
    setText("slot-weekly-cap", "Monthly Jackpot Jar: " + money(bu.month || 0) + " / " + money(bu.monthlyGoal || 0) + " filled; " + money(bu.monthlyRemaining || 0) + " still at risk");
    setText("slot-shortfall-line", "Shortfall consequence: " + (constants.shortfallPenalty || "Leftover goal amount gets redirected."));
    renderRewards();
    if(!isSpinning) renderHistory();
    const btn = document.getElementById("slot-spin-btn");
    const spinCost = (slotState.constants && slotState.constants.spinCost) || 1;
    if(btn) {
      btn.disabled = isSpinning || credits < spinCost;
      btn.textContent = "Spin (" + pointLabel(spinCost) + ")";
    }
  }

  function setText(id, text){
    const el = document.getElementById(id);
    if(el) el.textContent = text;
  }

  function readAwardQueue(){
    try {
      const rows = JSON.parse(localStorage.getItem(AWARD_QUEUE_KEY) || "[]");
      return Array.isArray(rows) ? rows : [];
    } catch(e) {
      return [];
    }
  }

  function isSlotsPageActive(){
    const root = document.getElementById("tab-slots");
    return !!(root && root.classList.contains("active"));
  }

  function clearSlotCoinEffects(){
    if(coinPhysics.raf){
      cancelAnimationFrame(coinPhysics.raf);
      coinPhysics.raf = null;
    }
    coinPhysics.coins.forEach(coin => {
      if(coin && coin.el) coin.el.remove();
    });
    coinPhysics.coins = [];
    const field = document.getElementById("slot-coin-field");
    if(field) field.remove();
    document.querySelectorAll(".slot-gold-transfer,.slot-bank-flow,.slot-piggy-add-pop").forEach(el => el.remove());
    document.querySelectorAll(".slot-pending-deposit.receiving").forEach(el => el.classList.remove("receiving"));
  }

  window.clearSlotCoinEffects = clearSlotCoinEffects;

  function writeAwardQueue(rows){
    try {
      localStorage.setItem(AWARD_QUEUE_KEY, JSON.stringify((rows || []).slice(-100)));
    } catch(e) {}
  }

  function queueTaskCredit(task, options){
    if(!task || !task.id) return;
    const row = { task, options: options || {}, queuedAt: new Date().toISOString() };
    const rows = readAwardQueue();
    const key = (row.options.sourceKey || row.options.source_key || row.options.sourceDate || "unknown") + ":" + task.id;
    const filtered = rows.filter(item => {
      const itemTask = item && item.task;
      const itemOptions = (item && item.options) || {};
      const itemKey = (itemOptions.sourceKey || itemOptions.source_key || itemOptions.sourceDate || "unknown") + ":" + (itemTask && itemTask.id);
      return itemKey !== key;
    });
    filtered.push(row);
    writeAwardQueue(filtered);
  }

  async function flushTaskCreditQueue(){
    const rows = readAwardQueue();
    if(!rows.length) return;
    const remaining = [];
    for(const row of rows){
      try {
        await earnTaskCredit(row.task, { ...(row.options || {}), fromQueue: true });
      } catch(e) {
        remaining.push(row);
      }
    }
    writeAwardQueue(remaining);
  }

  function renderSettings(){
    if(!slotState) return;
    const constants = slotState.constants || {};
    const spinCost = constants.spinCost || 1;
    const monthlyGoal = constants.monthlyGoalCents || 10000;
    const costInput = document.getElementById("slot-spin-cost-input");
    const goalInput = document.getElementById("slot-monthly-goal");
    const penalty = document.getElementById("slot-shortfall-penalty");
    const rationale = document.getElementById("slot-scoring-rationale");
    if(costInput && document.activeElement !== costInput) costInput.value = spinCost;
    if(goalInput && document.activeElement !== goalInput) goalInput.value = ((monthlyGoal || 0) / 100).toFixed(0);
    if(penalty && document.activeElement !== penalty) penalty.value = constants.shortfallPenalty || "";
    if(rationale && document.activeElement !== rationale) rationale.value = constants.scoringRationale || "";
    setText("slot-current-cost", pointLabel(spinCost) + " per spin");
    setText("slot-spin-cost-line", pointLabel(spinCost) + " per spin");
    setText("slot-current-goal", "Monthly goal: " + money(monthlyGoal) + "; shortfall gets redirected.");
  }

  async function saveSettings(){
    const costInput = document.getElementById("slot-spin-cost-input");
    const goalInput = document.getElementById("slot-monthly-goal");
    const penalty = document.getElementById("slot-shortfall-penalty");
    const rationale = document.getElementById("slot-scoring-rationale");
    const spinCost = Math.max(1, Math.min(250, parseInt(costInput && costInput.value, 10) || 10));
    const monthlyGoalCents = Math.max(100, Math.min(1000000, Math.round((parseFloat(goalInput && goalInput.value) || 1) * 100)));
    try {
      await api("/api/slot/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spin_cost: spinCost,
          monthly_goal_cents: monthlyGoalCents,
          shortfall_penalty: penalty ? penalty.value : "",
          scoring_rationale: rationale ? rationale.value : ""
        })
      });
      setResult("Slot rules saved.");
      await loadSlots();
    } catch(e) {
      setResult(e.message);
    }
  }

  function renderRewards(){
    const list = document.getElementById("slot-reward-list");
    if(!list || !slotState) return;
    let rewards = filterRewards(slotState.rewards || []);
    if(!rewards.length){
      list.innerHTML = '<div class="slot-empty">No rewards match this view.</div>';
      return;
    }
    list.innerHTML = rewards.map(r => {
      const value = r.value_cents ? '<span>' + money(r.value_cents) + '</span>' : '';
      const bank = r.bank_delta_cents ? '<span>+' + money(r.bank_delta_cents) + ' bank</span>' : '';
      const locked = r.eligible ? '' : '<span class="slot-locked">' + lockLabel(r.locked_reason) + '</span>';
      const sponsor = r.sponsor_type !== "self" ? '<span>' + esc(SPONSOR_LABELS[r.sponsor_type] || r.sponsor_type) + '</span>' : '';
      const symbol = rewardSymbol(r);
      return '<div class="slot-reward-row ' + (r.eligible ? '' : 'locked') + '" data-id="' + r.id + '">' +
        '<div class="slot-reward-main">' +
          '<div class="slot-reward-title"><span class="slot-symbol-badge" data-symbol="' + esc(symbol.toLowerCase()) + '">' + esc(symbol) + '</span>' + esc(r.title) + '</div>' +
          '<div class="slot-reward-meta">' +
            '<span>' + esc(KIND_LABELS[r.kind] || r.kind) + '</span>' +
            '<span>weight ' + esc(r.weight) + '</span>' +
            value + bank + sponsor + locked +
          '</div>' +
        '</div>' +
        '<div class="slot-reward-actions">' +
          (r.sponsor_type !== "self" ? '<button class="slot-mini slot-sponsor-toggle" data-id="' + r.id + '">' + (r.sponsor_active ? 'Opt out' : 'Opt in') + '</button>' : '') +
          '<button class="slot-mini slot-edit" data-id="' + r.id + '">Edit</button>' +
          '<button class="slot-mini danger slot-delete" data-id="' + r.id + '">Delete</button>' +
          (String(pendingDeleteRewardId) === String(r.id)
            ? '<div class="slot-delete-confirm" role="dialog" aria-label="Confirm reward deletion">' +
                '<span>Delete this?</span>' +
                '<button class="slot-mini danger slot-delete-confirm-yes" data-id="' + r.id + '">Delete</button>' +
                '<button class="slot-mini slot-delete-confirm-no" type="button">Cancel</button>' +
              '</div>'
            : '') +
        '</div>' +
      '</div>';
    }).join("");
    list.querySelectorAll(".slot-edit").forEach(btn => btn.addEventListener("click", () => openForm(findReward(btn.dataset.id))));
    list.querySelectorAll(".slot-delete").forEach(btn => btn.addEventListener("click", () => requestDeleteReward(btn.dataset.id)));
    list.querySelectorAll(".slot-delete-confirm-yes").forEach(btn => btn.addEventListener("click", () => deleteReward(btn.dataset.id)));
    list.querySelectorAll(".slot-delete-confirm-no").forEach(btn => btn.addEventListener("click", () => {
      pendingDeleteRewardId = null;
      renderRewards();
    }));
    list.querySelectorAll(".slot-sponsor-toggle").forEach(btn => btn.addEventListener("click", () => toggleSponsor(btn.dataset.id)));
  }

  function filterRewards(rewards){
    const query = rewardSearch.trim().toLowerCase();
    return [...rewards]
      .filter(r => {
        if(r.kind === "miss") return false;
        if(filter === "free" && r.kind !== "free") return false;
        if(filter === "jackpots" && !isJackpotReward(r)) return false;
        if(rewardCategory !== "all" && r.kind !== rewardCategory) return false;
        if(rewardEligibility === "eligible" && !r.eligible) return false;
        if(rewardEligibility === "locked" && r.eligible) return false;
        if(!matchesPriceFilter(r)) return false;
        if(query && !rewardSearchText(r).includes(query)) return false;
        return true;
      })
      .sort(compareRewards);
  }

  function rewardValueCents(reward){
    return Math.max(reward.value_cents || 0, reward.unlock_threshold_cents || 0, reward.bank_delta_cents || 0);
  }

  function rewardCostCents(reward){
    return Math.max(reward.value_cents || 0, reward.unlock_threshold_cents || 0);
  }

  function isJackpotReward(reward){
    return rewardCostCents(reward) > 0;
  }

  function matchesPriceFilter(reward){
    const value = rewardValueCents(reward);
    if(rewardPrice === "free") return value === 0;
    if(rewardPrice === "under25") return value > 0 && value < 2500;
    if(rewardPrice === "25to99") return value >= 2500 && value < 10000;
    if(rewardPrice === "100to199") return value >= 10000 && value < 20000;
    if(rewardPrice === "200plus") return value >= 20000;
    return true;
  }

  function rewardSearchText(reward){
    const parts = [
      reward.title,
      reward.kind,
      KIND_LABELS[reward.kind],
      rewardSymbol(reward),
      reward.notes,
      reward.sponsor_type,
      SPONSOR_LABELS[reward.sponsor_type],
      reward.eligible ? "eligible" : "locked",
      reward.eligible ? "" : lockLabel(reward.locked_reason),
      money(rewardValueCents(reward))
    ];
    return parts.filter(Boolean).join(" ").toLowerCase();
  }

  function compareRewards(a, b){
    const categoryA = KIND_LABELS[a.kind] || a.kind || "";
    const categoryB = KIND_LABELS[b.kind] || b.kind || "";
    const titleA = String(a.title || "").toLowerCase();
    const titleB = String(b.title || "").toLowerCase();
    const valueA = rewardValueCents(a);
    const valueB = rewardValueCents(b);
    if(rewardSort === "title") return titleA.localeCompare(titleB);
    if(rewardSort === "price-asc") return valueA - valueB || titleA.localeCompare(titleB);
    if(rewardSort === "price-desc") return valueB - valueA || titleA.localeCompare(titleB);
    if(rewardSort === "weight-desc") return (b.weight || 0) - (a.weight || 0) || titleA.localeCompare(titleB);
    if(rewardSort === "eligible") return Number(!!b.eligible) - Number(!!a.eligible) || titleA.localeCompare(titleB);
    return categoryA.localeCompare(categoryB) || valueA - valueB || titleA.localeCompare(titleB);
  }

  function lockLabel(reason){
    return ({
      inactive: "inactive",
      zero_weight: "zero weight",
      sponsor_opt_in_required: "needs sponsor opt-in",
      bank_too_small: "bank locked",
      cooldown: "cooldown",
      bank_cap: "bucket full"
    })[reason] || "locked";
  }

  function renderHistory(){
    const el = document.getElementById("slot-history");
    if(!el || !slotState) return;
    const spins = slotState.spins || [];
    if(!spins.length){
      el.innerHTML = '<div class="slot-empty">No spins yet.</div>';
      return;
    }
    el.innerHTML = spins.map(s => {
      const snap = s.reward_snapshot || {};
      const pending = s.status === "pending";
      const bankBuilderPending = pending && (s.bank_delta_cents || 0) > 0 && !s.bank_reserved_cents;
      const miss = s.status === "miss" || snap.kind === "miss";
      const symbol = rewardSymbol(snap);
      const taskDrip = snap.source_type === "task_bank_drip";
      const screenBank = snap.source_type === "slot_screen_bank_builder";
      const metaLabel = taskDrip ? "task bank drip" : screenBank ? "screen bank bonus" : "needs 3 in a row";
      const bank = s.bank_delta_cents ? ' <span class="slot-history-bank">+' + money(s.bank_delta_cents) + '</span>' : '';
      const reserve = s.bank_reserved_cents ? ' <span class="slot-history-bank">reserve ' + money(s.bank_reserved_cents) + '</span>' : '';
      const title = miss ? "No prize" : (snap.title || "Reward");
      return '<div class="slot-history-row">' +
        '<div><strong>' + esc(title) + '</strong>' + bank + reserve +
          '<div class="slot-history-meta">' + esc(symbol) + ' ' + esc(metaLabel) + ' · ' + esc(KIND_LABELS[snap.kind] || snap.kind || "") + ' · ' + new Date(s.created_at).toLocaleString() + '</div>' +
        '</div>' +
        (pending && !bankBuilderPending ? '<button class="slot-mini primary slot-confirm" data-id="' + s.id + '">Confirm</button>' : '<span class="slot-status ' + (miss ? 'miss' : '') + '">' + esc(bankBuilderPending ? "sweep pending" : (miss ? "no prize" : s.status)) + '</span>') +
      '</div>';
    }).join("");
    el.querySelectorAll(".slot-confirm").forEach(btn => btn.addEventListener("click", () => confirmSpin(btn.dataset.id)));
  }

  function findReward(id){
    return (slotState && slotState.rewards || []).find(r => String(r.id) === String(id));
  }

  async function spin(){
    const btn = document.getElementById("slot-spin-btn");
    if(btn) btn.disabled = true;
    isSpinning = true;
    setResult("Pulling the lever...");
    try {
      const spinRow = await api("/api/slot/spin", { method: "POST" });
      const snap = spinRow.reward_snapshot || {};
      setResult("Building houses...");
      await animateReels(resultSymbols(spinRow, snap));
      if((spinRow.bank_delta_cents || 0) > 0) {
        await animateBankPayout(spinRow, snap, spinRow.bank_delta_cents || 0);
        if(hasLoadedSpin(spinRow.id)) inflatePendingDeposit(spinRow.bank_delta_cents || 0);
        else addPendingDeposit(spinRow.bank_delta_cents || 0);
      }
      highlightWinningCells(spinRow, snap);
      setResult(resultText(spinRow, snap));
      isSpinning = false;
      await loadSlots();
    } catch(e) {
      isSpinning = false;
      setResult(e.message);
      if(btn) btn.disabled = false;
    }
  }

  function animateReels(finalSymbols){
    const reels = document.querySelectorAll(".slot-cell");
    if(!reels.length) return Promise.resolve();
    const targets = finalSymbols && finalSymbols.length ? finalSymbols : SPIN_SYMBOLS;
    let tick = 0;
    clearResultHighlights();
    reels.forEach(r => {
      r.classList.remove("reveal");
      r.classList.add("spinning");
    });
    return new Promise(resolve => {
      const timer = setInterval(() => {
        reels.forEach((r, i) => {
          if(r.classList.contains("stopped")) return;
          setCell(r, SPIN_SYMBOLS[(tick + i * 5) % SPIN_SYMBOLS.length]);
          r.classList.toggle("pulse", tick % 2 === 0);
        });
        tick++;
      }, 48);
      reels.forEach((r, i) => {
        setTimeout(() => {
          r.classList.add("stopped");
          setCell(r, targets[i % targets.length] || "STAR");
          r.classList.add("reveal");
        }, 700 + (i % 5) * 140 + Math.floor(i / 5) * 170);
      });
      setTimeout(() => {
        clearInterval(timer);
        reels.forEach(r => r.classList.remove("spinning", "pulse", "stopped"));
        resolve();
      }, 1900);
    });
  }

  function setReelsForReward(reward){
    const reels = document.querySelectorAll(".slot-cell");
    const words = resultSymbols({ status: reward.kind === "miss" ? "miss" : "awarded", id: reward.id || 0 }, reward);
    clearResultHighlights();
    reels.forEach((r, i) => {
      setCell(r, words[i] || "STAR");
      r.classList.add("reveal");
    });
  }

  function resultSymbols(spinRow, reward){
    if(reward && Array.isArray(reward.screen_board) && reward.screen_board.length){
      return reward.screen_board;
    }
    const seed = hashCode([spinRow.id || 0, spinRow.created_at || "", reward.title || "", reward.kind || ""].join("|"));
    const board = Array.from({ length: 15 }, (_, i) => FILLER_SYMBOLS[(seed + i * 3) % FILLER_SYMBOLS.length]);
    const symbol = rewardSymbol(reward);
    const isMiss = spinRow.status === "miss" || reward.kind === "miss";

    if(isMiss){
      const teaserA = TEASER_SYMBOLS[seed % TEASER_SYMBOLS.length];
      const teaserB = TEASER_SYMBOLS[(seed + 3) % TEASER_SYMBOLS.length];
      const teaserC = TEASER_SYMBOLS[(seed + 5) % TEASER_SYMBOLS.length];
      board[(seed + 1) % 15] = teaserA;
      board[(seed + 7) % 15] = teaserA;
      board[(seed + 4) % 15] = teaserB;
      board[(seed + 11) % 15] = teaserC;
      return board;
    }

    const line = PAYLINES[seed % PAYLINES.length];
    line.forEach(i => { board[i] = symbol; });
    board[(seed + 5) % 15] = TEASER_SYMBOLS[(seed + 2) % TEASER_SYMBOLS.length];
    board[(seed + 9) % 15] = TEASER_SYMBOLS[(seed + 4) % TEASER_SYMBOLS.length];
    return board;
  }

  function winningPositions(spinRow, snap){
    const board = snap && Array.isArray(snap.screen_board) ? snap.screen_board : resultSymbols(spinRow, snap || {});
    const payline = snap && Array.isArray(snap.screen_payline) ? snap.screen_payline : [];
    const status = spinRow && spinRow.status;
    const isMiss = status === "miss" || (snap && snap.kind === "miss");
    if(!isMiss && payline.length) return payline;

    const symbol = rewardSymbol(snap || {});
    if(!isMiss && board && board.length){
      const line = PAYLINES.find(candidate => candidate.every(i => board[i] === symbol));
      if(line) return line;
    }

    const payout = (snap && snap.bank_screen_payout) || {};
    if((spinRow && (spinRow.bank_delta_cents || 0) > 0) && Array.isArray(payout.positions)) {
      return payout.positions;
    }
    return [];
  }

  function clearResultHighlights(){
    document.querySelectorAll(".slot-cell.win-hit").forEach(cell => cell.classList.remove("win-hit"));
  }

  function highlightWinningCells(spinRow, snap){
    const reels = Array.from(document.querySelectorAll(".slot-cell"));
    const positions = winningPositions(spinRow, snap);
    clearResultHighlights();
    positions.forEach(i => {
      if(reels[i]) reels[i].classList.add("win-hit");
    });
  }

  async function animateBankPayout(spinRow, snap, deltaCents){
    const payout = (snap && snap.bank_screen_payout) || {};
    const positions = Array.isArray(payout.positions) ? payout.positions : [];
    if(!positions.length) return;
    const reels = Array.from(document.querySelectorAll(".slot-cell"));
    const cells = positions.map(i => reels[i]).filter(Boolean);
    if(!cells.length) return;

    cells.forEach(cell => cell.classList.add("bank-hit"));
    await wait(260);

    const horizontalGroups = Array.isArray(payout.horizontal_groups) ? payout.horizontal_groups : [];
    horizontalGroups.flat().forEach(i => {
      if(reels[i]) reels[i].classList.add("bank-horizontal");
    });
    await wait(horizontalGroups.length ? 420 : 120);

    const verticalGroups = Array.isArray(payout.vertical_groups) ? payout.vertical_groups : [];
    verticalGroups.flat().forEach(i => {
      if(reels[i]) reels[i].classList.add("bank-vertical");
    });
    await wait(verticalGroups.length ? 420 : 120);

    const target = document.getElementById("slot-bank-balance") || document.getElementById("slot-pending-deposit");
    if(target) flyBankLights(cells, target);
    if(deltaCents > 0) await animateBankCoinCollection(cells, deltaCents);
    else await wait(760);
    cells.forEach(cell => cell.classList.remove("bank-hit", "bank-horizontal", "bank-vertical"));
  }

  async function animateBankCoinCollection(cells, deltaCents){
    if(!isSlotsPageActive()) return;
    const field = ensureCoinField();
    if(!field) return;
    const label = field.querySelector(".slot-coin-ground-amount");
    field.classList.add("active");
    if(label){
      label.textContent = "+" + money(deltaCents);
      label.classList.remove("pop");
      void label.offsetWidth;
      label.classList.add("pop");
    }
    let idx = 0;
    cells.forEach((cell, cellIdx) => {
      for(let burst = 0; burst < 9; burst++){
        spawnPhysicsCoin(cell, idx++, cellIdx, burst);
      }
    });
    startCoinPhysics();
    await wait(900);
    if(!isSlotsPageActive()) return;
    await animateCoinPileToPiggy(deltaCents);
  }

  async function animateCoinPileToPiggy(deltaCents){
    if(!isSlotsPageActive()) return;
    const target = document.getElementById("slot-pending-deposit") || document.getElementById("slot-bank-balance");
    if(!target) return;
    const targetRect = target.getBoundingClientRect();
    const tx = targetRect.left + targetRect.width / 2;
    const ty = targetRect.top + targetRect.height / 2;
    const floorCoins = coinPhysics.coins.filter(c => c.y > window.innerHeight - 90);
    const sources = floorCoins.length ? floorCoins : coinPhysics.coins;
    target.classList.add("receiving");
    for(let i = 0; i < 14; i++){
      const source = sources.length ? sources[(i * 7) % sources.length] : null;
      const sx = source ? source.x : (window.innerWidth / 2 + (i % 5 - 2) * 28);
      const sy = source ? source.y : (window.innerHeight - 18);
      const spark = document.createElement("span");
      spark.className = "slot-gold-transfer";
      spark.style.left = sx + "px";
      spark.style.top = sy + "px";
      spark.style.setProperty("--gold-x", (tx - sx) + "px");
      spark.style.setProperty("--gold-y", (ty - sy) + "px");
      spark.style.animationDelay = (i * 42) + "ms";
      document.body.appendChild(spark);
      spark.addEventListener("animationend", () => spark.remove(), { once: true });
    }
    await wait(720);
    if(isSlotsPageActive()) showPiggyBankAddAmount(target, deltaCents);
    await wait(500);
    target.classList.remove("receiving");
  }

  function showPiggyBankAddAmount(target, deltaCents){
    const rect = target.getBoundingClientRect();
    const pop = document.createElement("span");
    pop.className = "slot-piggy-add-pop";
    pop.textContent = "+" + money(deltaCents);
    pop.style.left = (rect.left + rect.width / 2) + "px";
    pop.style.top = (rect.top + Math.min(34, rect.height / 2)) + "px";
    document.body.appendChild(pop);
    target.classList.add("deposit-impact");
    pop.addEventListener("animationend", () => pop.remove(), { once: true });
    setTimeout(() => target.classList.remove("deposit-impact"), 680);
  }

  function ensureCoinField(){
    if(!isSlotsPageActive()) return null;
    let field = document.getElementById("slot-coin-field");
    if(field) return field;
    field = document.createElement("div");
    field.id = "slot-coin-field";
    field.className = "slot-coin-field";
    field.innerHTML = '<div class="slot-coin-ground"></div><div class="slot-coin-ground-amount"></div>';
    document.body.appendChild(field);
    return field;
  }

  function spawnPhysicsCoin(cell, idx, cellIdx, burstIdx){
    const field = ensureCoinField();
    if(!field) return;
    const rect = cell.getBoundingClientRect();
    const el = document.createElement("span");
    const r = 8 + (idx % 3);
    const angle = (-Math.PI * 0.92) + (burstIdx / 8) * (Math.PI * 0.84) + ((cellIdx % 2) ? 0.08 : -0.08);
    const speed = 390 + (idx % 5) * 54;
    const coin = {
      el,
      r,
      x: rect.left + rect.width / 2 + (burstIdx - 4) * 2,
      y: rect.top + rect.height / 2,
      vx: Math.cos(angle) * speed + (Math.random() - 0.5) * 120,
      vy: Math.sin(angle) * speed - 120 - Math.random() * 130,
      rot: Math.random() * 360,
      vr: (Math.random() - 0.5) * 860,
      born: performance.now()
    };
    el.className = "slot-physics-coin";
    el.style.width = (r * 2) + "px";
    el.style.height = (r * 2) + "px";
    field.appendChild(el);
    coinPhysics.coins.push(coin);
    trimPhysicsCoins();
    renderPhysicsCoin(coin);
  }

  function trimPhysicsCoins(){
    const maxCoins = 180;
    while(coinPhysics.coins.length > maxCoins){
      const coin = coinPhysics.coins.shift();
      if(coin && coin.el) coin.el.remove();
    }
  }

  function startCoinPhysics(){
    if(!isSlotsPageActive()) return;
    if(coinPhysics.raf) return;
    coinPhysics.lastTs = performance.now();
    coinPhysics.raf = requestAnimationFrame(stepCoinPhysics);
  }

  function stepCoinPhysics(ts){
    if(!isSlotsPageActive()){
      coinPhysics.raf = null;
      return;
    }
    const dt = Math.min(0.026, Math.max(0.001, (ts - coinPhysics.lastTs) / 1000));
    coinPhysics.lastTs = ts;
    const floor = window.innerHeight - 8;
    const left = 6;
    const right = window.innerWidth - 6;
    const gravity = 1420;
    const coins = coinPhysics.coins;

    coins.forEach(c => {
      c.vy += gravity * dt;
      c.vx *= 0.992;
      c.vy *= 0.998;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.rot += c.vr * dt;

      if(c.x - c.r < left){
        c.x = left + c.r;
        c.vx = Math.abs(c.vx) * 0.48;
        c.vr *= 0.78;
      }
      if(c.x + c.r > right){
        c.x = right - c.r;
        c.vx = -Math.abs(c.vx) * 0.48;
        c.vr *= 0.78;
      }
      if(c.y + c.r > floor){
        c.y = floor - c.r;
        if(Math.abs(c.vy) > 45) c.vy = -Math.abs(c.vy) * 0.22;
        else c.vy = 0;
        c.vx *= 0.83;
        c.vr *= 0.7;
      }
    });

    for(let pass = 0; pass < 2; pass++){
      for(let i = 0; i < coins.length; i++){
        for(let j = i + 1; j < coins.length; j++){
          const a = coins[i], b = coins[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const min = a.r + b.r;
          const distSq = dx * dx + dy * dy;
          if(distSq <= 0 || distSq >= min * min) continue;
          const dist = Math.sqrt(distSq);
          const nx = dx / dist;
          const ny = dy / dist;
          const overlap = (min - dist) * 0.52;
          a.x -= nx * overlap;
          a.y -= ny * overlap;
          b.x += nx * overlap;
          b.y += ny * overlap;
          const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if(rel < 0){
            const impulse = -rel * 0.18;
            a.vx -= nx * impulse;
            a.vy -= ny * impulse;
            b.vx += nx * impulse;
            b.vy += ny * impulse;
          }
        }
      }
    }

    coins.forEach(c => renderPhysicsCoin(c));
    const moving = coins.some(c => Math.abs(c.vx) > 4 || Math.abs(c.vy) > 4);
    if(moving){
      coinPhysics.raf = requestAnimationFrame(stepCoinPhysics);
    } else {
      coinPhysics.raf = null;
    }
  }

  function renderPhysicsCoin(coin){
    coin.el.style.transform = "translate(" + (coin.x - coin.r) + "px," + (coin.y - coin.r) + "px) rotate(" + coin.rot + "deg)";
  }

  function flyBankLights(cells, target){
    if(!isSlotsPageActive()) return;
    const targetRect = target.getBoundingClientRect();
    const tx = targetRect.left + targetRect.width / 2;
    const ty = targetRect.top + targetRect.height / 2;
    cells.forEach((cell, idx) => {
      const rect = cell.getBoundingClientRect();
      const light = document.createElement("span");
      light.className = "slot-bank-flow";
      light.style.left = (rect.left + rect.width / 2) + "px";
      light.style.top = (rect.top + rect.height / 2) + "px";
      light.style.setProperty("--slot-flow-x", (tx - rect.left - rect.width / 2) + "px");
      light.style.setProperty("--slot-flow-y", (ty - rect.top - rect.height / 2) + "px");
      light.style.animationDelay = (idx * 34) + "ms";
      document.body.appendChild(light);
      light.addEventListener("animationend", () => light.remove(), { once: true });
    });
  }

  function wait(ms){
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function rewardSymbol(reward){
    if(!reward || reward.kind === "miss") return "MISS";
    if(isJackpotReward(reward)) return "JACKPOT";
    if(reward.kind === "bank_builder") return "BANK";
    if(reward.kind === "sponsor") return "PLEDGE";
    if(reward.kind === "choice") return "PICK";
    if(reward.kind === "reroll") return "REROLL";
    return "CARE";
  }

  function hashCode(text){
    let hash = 0;
    for(let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    return Math.abs(hash);
  }

  function setCell(cell, symbol){
    cell.textContent = symbol;
    cell.dataset.symbol = symbol.toLowerCase();
  }

  function resultText(spinRow, snap){
    const payout = (snap && snap.bank_screen_payout) || {};
    const bankDelta = spinRow.bank_delta_cents || payout.cents || 0;
    if(bankDelta > 0) {
      const units = payout.units ? " from " + payout.units + " bank unit" + (payout.units === 1 ? "" : "s") : "";
      const cap = payout.capped ? " Bank cap trimmed the payout." : "";
      return "Bank bonus paid " + money(bankDelta) + units + ". The light flowed into the piggy bank." + cap;
    }
    if(spinRow.status === "miss" || snap.kind === "miss") return "No reward this spin: No prize";
    if(snap.kind === "bank_builder") return "Piggy Bank grew by " + money(spinRow.bank_delta_cents || snap.bank_delta_cents || 0) + ". Sweep it into savings when you get a chance.";
    if(spinRow.status === "pending") return "Prize pending confirmation: " + (snap.title || "Reward");
    return "Prize reveal: " + (snap.title || "Reward");
  }

  function setResult(text){
    const el = document.getElementById("slot-result");
    if(el) el.textContent = text;
  }

  function openForm(reward){
    editingId = reward ? reward.id : null;
    const form = document.getElementById("slot-reward-form");
    if(!form) return;
    form.style.display = "";
    setText("slot-form-heading", reward ? "Edit reward" : "New reward");
    val("slot-form-title", reward ? reward.title : "");
    val("slot-form-kind", reward ? reward.kind : "free");
    val("slot-form-sponsor", reward ? reward.sponsor_type : "self");
    val("slot-form-weight", reward ? reward.weight : 10);
    val("slot-form-value", reward ? ((reward.value_cents || 0) / 100) : "");
    val("slot-form-cooldown", reward ? reward.cooldown_days : 0);
    checked("slot-form-active", reward ? reward.active : true);
    checked("slot-form-sponsor-active", reward ? reward.sponsor_active : false);
    checked("slot-form-confirm", reward ? reward.requires_confirmation : false);
    val("slot-form-notes", reward ? reward.notes : "");
    syncRewardFormUi();
    const title = document.getElementById("slot-form-title");
    if(title) title.focus();
  }

  function closeForm(){
    editingId = null;
    const form = document.getElementById("slot-reward-form");
    if(form) form.style.display = "none";
  }

  function syncRewardFormUi(){
    const kindEl = document.getElementById("slot-form-kind");
    const sponsorEl = document.getElementById("slot-form-sponsor");
    const kind = kindEl ? kindEl.value : "free";
    let sponsor = sponsorEl ? sponsorEl.value : "self";
    if(kind === "sponsor" && sponsor === "self"){
      val("slot-form-sponsor", "accountability_partner");
      sponsor = "accountability_partner";
    }
    const needsPrice = ["small_paid", "bank_gated", "sponsor"].includes(kind);
    const usesSponsor = kind === "sponsor";
    const sponsorOptIn = usesSponsor && sponsor !== "self";
    const form = document.getElementById("slot-reward-form");
    if(form){
      form.dataset.rewardKind = kind;
      form.querySelectorAll(".slot-kind-option").forEach(btn => {
        const active = btn.dataset.slotKind === kind;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-checked", active ? "true" : "false");
      });
      form.querySelectorAll('[data-slot-field="value"]').forEach(el => el.hidden = !needsPrice);
      form.querySelectorAll('[data-slot-field="sponsor"]').forEach(el => el.hidden = !usesSponsor);
      form.querySelectorAll('[data-slot-field="sponsor-active"]').forEach(el => el.hidden = !sponsorOptIn);
    }
    setText("slot-form-subtitle", FORM_SUBTITLES[kind] || "Reward");
    if(!usesSponsor) val("slot-form-sponsor", "self");
    if(!needsPrice) val("slot-form-value", "");
    if(!sponsorOptIn) checked("slot-form-sponsor-active", usesSponsor);
    if(kind === "bank_gated" || kind === "small_paid" || kind === "sponsor") checked("slot-form-confirm", true);
  }

  function val(id, value){
    const el = document.getElementById(id);
    if(el) el.value = value == null ? "" : value;
  }

  function checked(id, value){
    const el = document.getElementById(id);
    if(el) el.checked = !!value;
  }

  function formPayload(){
    const valueDollars = parseFloat(document.getElementById("slot-form-value").value || "0") || 0;
    const kind = document.getElementById("slot-form-kind").value;
    const sponsor = document.getElementById("slot-form-sponsor").value;
    const valueCents = Math.round(valueDollars * 100);
    return {
      title: document.getElementById("slot-form-title").value,
      kind,
      sponsor_type: sponsor,
      weight: parseInt(document.getElementById("slot-form-weight").value, 10) || 0,
      active: document.getElementById("slot-form-active").checked,
      sponsor_active: sponsor === "self" ? true : document.getElementById("slot-form-sponsor-active").checked,
      value_cents: valueCents,
      bank_delta_cents: 0,
      requires_confirmation: document.getElementById("slot-form-confirm").checked || kind === "bank_gated" || kind === "small_paid",
      cooldown_days: parseInt(document.getElementById("slot-form-cooldown").value, 10) || 0,
      unlock_threshold_cents: valueCents,
      notes: document.getElementById("slot-form-notes").value
    };
  }

  async function saveReward(){
    const payload = formPayload();
    const rewardId = editingId;
    const path = rewardId ? "/api/slot/rewards/" + rewardId : "/api/slot/rewards";
    const method = rewardId ? "PUT" : "POST";
    try {
      if(rewardId && slotState && Array.isArray(slotState.rewards)){
        const idx = slotState.rewards.findIndex(r => String(r.id) === String(rewardId));
        if(idx >= 0){
          slotState.rewards[idx] = { ...slotState.rewards[idx], ...payload, id: slotState.rewards[idx].id, eligible: payload.active && payload.weight > 0 };
          renderRewards();
        }
      }
      closeForm();
      await api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      await loadSlots();
    } catch(e) {
      await loadSlots();
      setResult(e.message);
    }
  }

  function requestDeleteReward(id){
    pendingDeleteRewardId = String(id);
    renderRewards();
    const row = document.querySelector('.slot-reward-row[data-id="' + CSS.escape(String(id)) + '"]');
    const confirmBtn = row && row.querySelector(".slot-delete-confirm-yes");
    if(confirmBtn) confirmBtn.focus();
  }

  async function deleteReward(id){
    const existing = slotState && Array.isArray(slotState.rewards)
      ? slotState.rewards.find(r => String(r.id) === String(id))
      : null;
    try {
      pendingDeleteRewardId = null;
      if(slotState && Array.isArray(slotState.rewards)){
        slotState.rewards = slotState.rewards.filter(r => String(r.id) !== String(id));
        renderRewards();
      }
      await api("/api/slot/rewards/" + id, { method: "DELETE" });
      await loadSlots();
    } catch(e) {
      if(existing && slotState && Array.isArray(slotState.rewards) && !slotState.rewards.some(r => String(r.id) === String(id))){
        slotState.rewards.push(existing);
        renderRewards();
      }
      setResult(e.message);
    }
  }

  async function toggleSponsor(id){
    const reward = findReward(id);
    if(!reward) return;
    const payload = { ...reward, sponsor_active: !reward.sponsor_active };
    try {
      await api("/api/slot/rewards/" + id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      await loadSlots();
    } catch(e) {
      setResult(e.message);
    }
  }

  async function confirmSpin(id){
    try {
      const spinRow = await api("/api/slot/spins/" + id + "/confirm", { method: "POST" });
      const snap = spinRow.reward_snapshot || {};
      setResult("Confirmed: " + (snap.title || "Reward"));
      await loadSlots();
    } catch(e) {
      setResult(e.message);
    }
  }

  function renderPiggyBank(animate){
    const account = (slotState && slotState.account) || {};
    const pending = (slotState && slotState.pendingBankDeposit) || {};
    const funding = (slotState && slotState.funding) || {};
    const bu = (slotState && slotState.bankUsage) || {};
    const readyCents = funding.ready != null ? funding.ready : (account.bank_balance_cents || 0);
    const pendingCents = funding.pending != null ? funding.pending : (pending.cents || 0);
    const totalCents = funding.total != null ? funding.total : readyCents + pendingCents;
    const monthCents = bu.month || 0;
    const monthlyGoal = bu.monthlyGoal || ((slotState.constants && slotState.constants.monthlyGoalCents) || 0);
    const shortfall = bu.monthlyRemaining != null ? bu.monthlyRemaining : Math.max(0, monthlyGoal - monthCents);
    const btn = document.getElementById("slot-pending-deposit");
    const fill = document.getElementById("slot-bank-fill");
    if(!btn) return;
    setText("slot-bank-balance", money(totalCents));
    setText("slot-bank-ready", money(readyCents));
    setText("slot-bank-pending", money(pendingCents));
    setText("slot-bank-total", money(totalCents));
    setText("slot-bank-month", money(monthCents) + " / " + money(monthlyGoal));
    setText("slot-bank-shortfall", money(shortfall));
    setText("slot-bank-action-label", pendingCents > 0 ? "Click after sweeping " + money(pendingCents) + " into savings" : (shortfall > 0 ? money(shortfall) + " left to save this month" : "Monthly bucket filled"));
    btn.disabled = pendingCents <= 0;
    btn.classList.toggle("urgent", pendingCents > 0);
    btn.title = pendingCents > 0
      ? "After you transfer " + money(pendingCents) + " into the savings account, click to mark it swept."
      : "No pending sweep. Ready funds stay available for funded rewards.";
    if(fill){
      const pct = monthlyGoal <= 0 ? 0 : Math.max(monthCents > 0 ? 8 : 0, Math.min(100, Math.round((monthCents / monthlyGoal) * 100)));
      fill.style.width = pct + "%";
    }
    if(animate && pendingCents > lastPendingBankCents) inflatePendingDeposit(pendingCents - lastPendingBankCents);
    lastPendingBankCents = pendingCents;
  }

  function inflatePendingDeposit(deltaCents){
    const btn = document.getElementById("slot-pending-deposit");
    if(!btn) return;
    btn.classList.remove("inflate");
    void btn.offsetWidth;
    btn.classList.add("inflate");
    setTimeout(() => {
      btn.classList.remove("inflate");
    }, 950);
  }

  function addPendingDeposit(deltaCents){
    if(deltaCents <= 0) return;
    if(!slotState) slotState = {};
    if(!slotState.pendingBankDeposit) slotState.pendingBankDeposit = { cents: 0, count: 0 };
    if(!slotState.funding) slotState.funding = { ready: 0, pending: 0, total: 0 };
    slotState.pendingBankDeposit.cents = (slotState.pendingBankDeposit.cents || 0) + deltaCents;
    slotState.pendingBankDeposit.count = (slotState.pendingBankDeposit.count || 0) + 1;
    slotState.funding.pending = (slotState.funding.pending || 0) + deltaCents;
    slotState.funding.total = (slotState.funding.ready || 0) + (slotState.funding.pending || 0);
    if(slotState.bankUsage){
      slotState.bankUsage.month = (slotState.bankUsage.month || 0) + deltaCents;
      slotState.bankUsage.monthlyRemaining = Math.max(0, (slotState.bankUsage.monthlyGoal || 0) - slotState.bankUsage.month);
    }
    renderPiggyBank(true);
  }

  function hasLoadedSpin(id){
    return !!(slotState && Array.isArray(slotState.spins) && slotState.spins.some(s => String(s.id) === String(id)));
  }

  async function popPendingDeposit(){
    const pending = (slotState && slotState.pendingBankDeposit) || {};
    const cents = pending.cents || 0;
    if(cents <= 0) return;
    if(!confirm("I transferred " + money(cents) + " into the dedicated savings account. Mark it swept?")) return;
    const btn = document.getElementById("slot-pending-deposit");
    if(btn) btn.classList.add("pop");
    try {
      const result = await api("/api/slot/bank-builders/confirm", { method: "POST" });
      setResult("Swept " + money(result.confirmed_cents || cents) + " into ready reward savings.");
      lastPendingBankCents = 0;
      setTimeout(async () => {
        if(btn) btn.classList.remove("pop");
        await loadSlots();
      }, 380);
    } catch(e) {
      if(btn) btn.classList.remove("pop");
      setResult(e.message);
    }
  }

  function taskDurationMinutes(task){
    if(!task) return 0;
    if(Number.isFinite(Number(task.durMin))) return Number(task.durMin);
    if(task.start && task.end && typeof dur === "function") {
      try { return Math.max(0, dur(task)); } catch(e) { return 0; }
    }
    return 0;
  }

  function taskFocusMinutes(task){
    if(!task || !task.id || typeof loadSessions !== "function") return 0;
    try {
      const sessions = loadSessions();
      const taskSessions = sessions && sessions[task.id];
      if(!Array.isArray(taskSessions)) return 0;
      return taskSessions.reduce((sum, s) => sum + (Number(s.durationMin) || 0), 0);
    } catch(e) {
      return 0;
    }
  }

  async function earnTaskCredit(task, options){
    if(!task || !task.id) return;
    options = options || {};
    const isBounty = typeof isBountyTask === "function" && isBountyTask(task.id);
    const payload = window.TaskPoints && typeof window.TaskPoints.buildPayload === "function"
      ? window.TaskPoints.buildPayload(task, { bounty: isBounty })
      : {
          task_id: task.id,
          title: task.title || task.label || "Task completed",
          type: task.type || "task",
          priority: task.priority || "",
          tags: task.tags || [],
          bounty: isBounty,
          duration_minutes: task.durMin || task.duration || 30
        };
    const sourceDate = options.sourceDate || options.completionDate || (window.__state && window.__state.date) || "unknown";
    const sourceKey = options.sourceKey || (String(sourceDate) + ":" + task.id);
    try {
      const result = await api("/api/slot/earn-task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          source_key: sourceKey,
          task_id: task.id,
          title: task.title || task.label || "Task completed",
          type: task.type || "task",
          source: task.source || "",
          priority: task.priority || "",
          tags: Array.isArray(task.tags) ? task.tags : [],
          duration_minutes: payload.duration_minutes || taskDurationMinutes(task),
          actual_minutes: payload.actual_minutes || taskFocusMinutes(task),
          completed_at: options.completedAt || new Date().toISOString()
        })
      });
      if(result.awarded && !options.silent && typeof showToast === "function") {
        const points = result.credits || result.delta || (result.scoring && result.scoring.awardPoints) || 1;
        showToast("+" + pointLabel(points));
      }
      await loadSlots();
      return result;
    } catch(e) {
      console.warn("[slots] earn failed:", e.message);
      if(!options.fromQueue) queueTaskCredit(task, options);
      throw e;
    }
  }

  async function reconcileCompletedTaskCredits(){
    if(typeof scheduled === "undefined" || !Array.isArray(scheduled)) return;
    const sourceDate = (typeof viewDate !== "undefined" && viewDate) || (window.__state && window.__state.date) || "unknown";
    const seen = new Set();
    for(const task of scheduled){
      if(!task || !task.id || seen.has(task.id)) continue;
      let done = false;
      try {
        done = typeof isDone === "function" ? !!isDone(task) : !!(manualDone && manualDone.has && manualDone.has(task.id));
      } catch(e) {}
      if(!done) continue;
      seen.add(task.id);
      const doneAtMap = typeof doneAt !== "undefined" ? doneAt : null;
      const completedAt = doneAtMap && doneAtMap[task.id]
        ? (doneAtMap[task.id] instanceof Date ? doneAtMap[task.id].toISOString() : new Date(doneAtMap[task.id]).toISOString())
        : new Date().toISOString();
      try {
        await earnTaskCredit(task, { sourceDate, completedAt, silent: true, reconcile: true });
      } catch(e) {}
    }
  }

  function init(){
    const spinBtn = document.getElementById("slot-spin-btn");
    if(spinBtn) spinBtn.addEventListener("click", spin);
    const refreshBtn = document.getElementById("slot-refresh-btn");
    if(refreshBtn) refreshBtn.addEventListener("click", loadSlots);
    const rulesBtn = document.getElementById("slot-rules-toggle");
    if(rulesBtn) rulesBtn.addEventListener("click", () => {
      const panel = document.getElementById("slot-rules-panel");
      if(panel) panel.style.display = panel.style.display === "none" ? "" : "none";
    });
    const saveSettingsBtn = document.getElementById("slot-save-settings-btn");
    if(saveSettingsBtn) saveSettingsBtn.addEventListener("click", saveSettings);
    const pendingBtn = document.getElementById("slot-pending-deposit");
    if(pendingBtn) pendingBtn.addEventListener("click", popPendingDeposit);
    const addBtn = document.getElementById("slot-add-reward-btn");
    if(addBtn) addBtn.addEventListener("click", () => openForm(null));
    const saveBtn = document.getElementById("slot-save-reward-btn");
    if(saveBtn) saveBtn.addEventListener("click", saveReward);
    const cancelBtn = document.getElementById("slot-cancel-reward-btn");
    if(cancelBtn) cancelBtn.addEventListener("click", closeForm);
    const closeRewardFormBtn = document.getElementById("slot-close-reward-form");
    if(closeRewardFormBtn) closeRewardFormBtn.addEventListener("click", closeForm);
    document.querySelectorAll(".slot-kind-option").forEach(btn => {
      btn.addEventListener("click", () => {
        val("slot-form-kind", btn.dataset.slotKind || "free");
        syncRewardFormUi();
      });
    });
    const sponsorSelect = document.getElementById("slot-form-sponsor");
    if(sponsorSelect) sponsorSelect.addEventListener("change", syncRewardFormUi);
    document.querySelectorAll(".slot-filter").forEach(btn => {
      btn.addEventListener("click", () => {
        filter = btn.dataset.slotFilter;
        document.querySelectorAll(".slot-filter").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        renderRewards();
      });
    });
    const rewardSearchInput = document.getElementById("slot-reward-search");
    if(rewardSearchInput) rewardSearchInput.addEventListener("input", () => {
      rewardSearch = rewardSearchInput.value || "";
      renderRewards();
    });
    const categorySelect = document.getElementById("slot-reward-category");
    if(categorySelect) categorySelect.addEventListener("change", () => {
      rewardCategory = categorySelect.value || "all";
      renderRewards();
    });
    const priceSelect = document.getElementById("slot-reward-price");
    if(priceSelect) priceSelect.addEventListener("change", () => {
      rewardPrice = priceSelect.value || "all";
      renderRewards();
    });
    const eligibilitySelect = document.getElementById("slot-reward-eligibility");
    if(eligibilitySelect) eligibilitySelect.addEventListener("change", () => {
      rewardEligibility = eligibilitySelect.value || "all";
      renderRewards();
    });
    const sortSelect = document.getElementById("slot-reward-sort");
    if(sortSelect) sortSelect.addEventListener("change", () => {
      rewardSort = sortSelect.value || "category";
      renderRewards();
    });
    const tabBtn = document.getElementById("slots-tab-btn");
    if(tabBtn) tabBtn.addEventListener("click", loadSlots);
    document.addEventListener("click", (event) => {
      if(!pendingDeleteRewardId) return;
      if(event.target.closest && event.target.closest(".slot-delete-confirm, .slot-delete")) return;
      pendingDeleteRewardId = null;
      renderRewards();
    });
    document.addEventListener("keydown", (event) => {
      if(event.key !== "Escape" || !pendingDeleteRewardId) return;
      pendingDeleteRewardId = null;
      renderRewards();
    });
    loadSlots();
    flushTaskCreditQueue();
    setTimeout(reconcileCompletedTaskCredits, 1500);
  }

  window.SlotRewards = { load: loadSlots, earnTaskCredit, queueTaskCredit, flushTaskCreditQueue, reconcileCompletedTaskCredits };
  document.addEventListener("slot-changed", loadSlots);
  document.addEventListener("DOMContentLoaded", init);
})();
