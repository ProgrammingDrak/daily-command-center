(function(){
  let slotState = null;
  let filter = "eligible";
  let editingId = null;
  let isSpinning = false;
  let lastPendingBankCents = 0;
  const KIND_LABELS = {
    miss: "No prize",
    free: "Free",
    small_paid: "Small paid",
    bank_gated: "Bank gated",
    sponsor: "Sponsor",
    choice: "Choice",
    reroll: "Reroll"
  };
  const SPONSOR_LABELS = {
    self: "Self",
    accountability_partner: "Accountability",
    romantic_partner: "Romantic",
    either_partner: "Either partner"
  };
  const SPIN_SYMBOLS = ["HAT","STRAW","STICK","BRICK","BANK","CARE","TREAT","BONUS","WILD","HOUSE","TOOLS","STAR","JACKPOT","PLEDGE","PICK"];
  const FILLER_SYMBOLS = ["STRAW","STICK","BRICK","HAT","TOOLS","HOUSE"];
  const TEASER_SYMBOLS = ["CARE","TREAT","BANK","JACKPOT","PLEDGE","PICK","REROLL"];
  const PAYLINES = [
    [0,1,2], [1,2,3], [2,3,4],
    [5,6,7], [6,7,8], [7,8,9],
    [10,11,12], [11,12,13], [12,13,14],
    [0,6,12], [2,6,10], [4,8,12], [2,8,14]
  ];

  function money(cents){
    return "$" + ((cents || 0) / 100).toFixed(2);
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
    setText("slot-bank-balance", money(account.bank_balance_cents));
    const badge = document.getElementById("slots-credit-badge");
    if(badge){
      badge.textContent = String(credits);
      badge.style.display = credits > 0 ? "" : "none";
    }
    renderPendingDeposit(false);
    const bu = slotState.bankUsage || {};
    setText("slot-daily-cap", "Daily bank cap: " + money(bu.today || 0) + " / " + money(bu.dailyCap || 0));
    setText("slot-weekly-cap", "Weekly bank cap: " + money(bu.week || 0) + " / " + money(bu.weeklyCap || 0));
    renderRewards();
    if(!isSpinning) renderHistory();
    const btn = document.getElementById("slot-spin-btn");
    if(btn) btn.disabled = isSpinning || credits < ((slotState.constants && slotState.constants.spinCost) || 1);
  }

  function setText(id, text){
    const el = document.getElementById(id);
    if(el) el.textContent = text;
  }

  function renderRewards(){
    const list = document.getElementById("slot-reward-list");
    if(!list || !slotState) return;
    let rewards = slotState.rewards || [];
    if(filter === "eligible") rewards = rewards.filter(r => r.eligible);
    if(filter === "locked") rewards = rewards.filter(r => !r.eligible);
    if(!rewards.length){
      list.innerHTML = '<div class="slot-empty">No rewards in this view.</div>';
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
        '</div>' +
      '</div>';
    }).join("");
    list.querySelectorAll(".slot-edit").forEach(btn => btn.addEventListener("click", () => openForm(findReward(btn.dataset.id))));
    list.querySelectorAll(".slot-delete").forEach(btn => btn.addEventListener("click", () => deleteReward(btn.dataset.id)));
    list.querySelectorAll(".slot-sponsor-toggle").forEach(btn => btn.addEventListener("click", () => toggleSponsor(btn.dataset.id)));
  }

  function lockLabel(reason){
    return ({
      inactive: "inactive",
      zero_weight: "zero weight",
      sponsor_opt_in_required: "needs sponsor opt-in",
      bank_too_small: "bank locked",
      cooldown: "cooldown",
      bank_cap: "bank cap"
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
      const metaLabel = taskDrip ? "task bank drip" : screenBank ? "screen bank builders" : "needs 3 in a row";
      const bank = s.bank_delta_cents ? ' <span class="slot-history-bank">+' + money(s.bank_delta_cents) + '</span>' : '';
      const reserve = s.bank_reserved_cents ? ' <span class="slot-history-bank">reserve ' + money(s.bank_reserved_cents) + '</span>' : '';
      return '<div class="slot-history-row">' +
        '<div><strong>' + esc(snap.title || (miss ? "No prize" : "Reward")) + '</strong>' + bank + reserve +
          '<div class="slot-history-meta">' + esc(symbol) + ' ' + esc(metaLabel) + ' · ' + esc(KIND_LABELS[snap.kind] || snap.kind || "") + ' · ' + new Date(s.created_at).toLocaleString() + '</div>' +
        '</div>' +
        (pending && !bankBuilderPending ? '<button class="slot-mini primary slot-confirm" data-id="' + s.id + '">Confirm</button>' : '<span class="slot-status ' + (miss ? 'miss' : '') + '">' + esc(bankBuilderPending ? "deposit pending" : (miss ? "no prize" : s.status)) + '</span>') +
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
        await animateBankPayout(spinRow, snap);
        if(hasLoadedSpin(spinRow.id)) inflatePendingDeposit(spinRow.bank_delta_cents || 0);
        else addPendingDeposit(spinRow.bank_delta_cents || 0);
      }
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

  async function animateBankPayout(spinRow, snap){
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
    await wait(760);
    cells.forEach(cell => cell.classList.remove("bank-hit", "bank-horizontal", "bank-vertical"));
  }

  function flyBankLights(cells, target){
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
    if(!reward || reward.kind === "miss") return "BUILD";
    if(reward.kind === "bank_gated") return (reward.value_cents || reward.unlock_threshold_cents || 0) >= 20000 ? "JACKPOT" : "GOLD";
    if(reward.kind === "small_paid") return "TREAT";
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
      return "Bank builders paid " + money(bankDelta) + units + ". The light flowed into the piggy bank." + cap;
    }
    if(spinRow.status === "miss" || snap.kind === "miss") return "No reward this spin: " + (snap.title || "keep building");
    if(snap.kind === "bank_builder") return "Bank balloon grew by " + money(spinRow.bank_delta_cents || snap.bank_delta_cents || 0) + ". Transfer it, then pop it into the piggy bank.";
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
  }

  function closeForm(){
    editingId = null;
    const form = document.getElementById("slot-reward-form");
    if(form) form.style.display = "none";
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

  async function deleteReward(id){
    if(!confirm("Delete this reward?")) return;
    const existing = slotState && Array.isArray(slotState.rewards)
      ? slotState.rewards.find(r => String(r.id) === String(id))
      : null;
    try {
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

  function renderPendingDeposit(animate){
    const pending = (slotState && slotState.pendingBankDeposit) || {};
    const cents = pending.cents || 0;
    const btn = document.getElementById("slot-pending-deposit");
    const balloon = document.getElementById("slot-pending-balloon");
    if(!btn || !balloon) return;
    btn.style.display = cents > 0 ? "" : "none";
    btn.classList.toggle("urgent", cents > 0);
    btn.title = cents > 0 ? "After you transfer " + money(cents) + " to savings, click to pop it into the Piggy Bank." : "";
    balloon.textContent = money(cents);
    if(animate && cents > lastPendingBankCents) inflatePendingDeposit(cents - lastPendingBankCents);
    lastPendingBankCents = cents;
  }

  function inflatePendingDeposit(deltaCents){
    const btn = document.getElementById("slot-pending-deposit");
    const balloon = document.getElementById("slot-pending-balloon");
    if(!btn || !balloon) return;
    if(deltaCents > 0) btn.style.display = "";
    btn.classList.remove("inflate");
    balloon.classList.remove("inflate");
    void btn.offsetWidth;
    btn.classList.add("inflate");
    balloon.classList.add("inflate");
    setTimeout(() => {
      btn.classList.remove("inflate");
      balloon.classList.remove("inflate");
    }, 950);
  }

  function addPendingDeposit(deltaCents){
    if(deltaCents <= 0) return;
    if(!slotState) slotState = {};
    if(!slotState.pendingBankDeposit) slotState.pendingBankDeposit = { cents: 0, count: 0 };
    slotState.pendingBankDeposit.cents = (slotState.pendingBankDeposit.cents || 0) + deltaCents;
    slotState.pendingBankDeposit.count = (slotState.pendingBankDeposit.count || 0) + 1;
    renderPendingDeposit(true);
  }

  function hasLoadedSpin(id){
    return !!(slotState && Array.isArray(slotState.spins) && slotState.spins.some(s => String(s.id) === String(id)));
  }

  async function popPendingDeposit(){
    const pending = (slotState && slotState.pendingBankDeposit) || {};
    const cents = pending.cents || 0;
    if(cents <= 0) return;
    if(!confirm("I transferred " + money(cents) + " into the dedicated savings account. Pop it into the Piggy Bank?")) return;
    const btn = document.getElementById("slot-pending-deposit");
    if(btn) btn.classList.add("pop");
    try {
      const result = await api("/api/slot/bank-builders/confirm", { method: "POST" });
      setResult("Popped " + money(result.confirmed_cents || cents) + " into the Piggy Bank.");
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

  async function earnTaskCredit(task){
    if(!task || !task.id) return;
    const isBounty = typeof isBountyTask === "function" && isBountyTask(task.id);
    try {
      const result = await api("/api/slot/earn-task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_key: String((window.__state && window.__state.date) || "unknown") + ":" + task.id,
          task_id: task.id,
          title: task.title || task.label || "Task completed",
          bounty: isBounty
        })
      });
      if(result.awarded && typeof showToast === "function") {
        const drip = result.bankDrip || {};
        const delta = result.delta || 1;
        showToast("+" + delta + " slot credit" + (delta === 1 ? "" : "s") + (isBounty ? " (bounty)" : "") + (drip.cents > 0 ? ", +" + money(drip.cents) + " bank" : ""));
      }
      await loadSlots();
    } catch(e) {
      console.warn("[slots] earn failed:", e.message);
    }
  }

  function init(){
    const spinBtn = document.getElementById("slot-spin-btn");
    if(spinBtn) spinBtn.addEventListener("click", spin);
    const refreshBtn = document.getElementById("slot-refresh-btn");
    if(refreshBtn) refreshBtn.addEventListener("click", loadSlots);
    const pendingBtn = document.getElementById("slot-pending-deposit");
    if(pendingBtn) pendingBtn.addEventListener("click", popPendingDeposit);
    const addBtn = document.getElementById("slot-add-reward-btn");
    if(addBtn) addBtn.addEventListener("click", () => openForm(null));
    const saveBtn = document.getElementById("slot-save-reward-btn");
    if(saveBtn) saveBtn.addEventListener("click", saveReward);
    const cancelBtn = document.getElementById("slot-cancel-reward-btn");
    if(cancelBtn) cancelBtn.addEventListener("click", closeForm);
    document.querySelectorAll(".slot-filter").forEach(btn => {
      btn.addEventListener("click", () => {
        filter = btn.dataset.slotFilter;
        document.querySelectorAll(".slot-filter").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        renderRewards();
      });
    });
    const tabBtn = document.getElementById("slots-tab-btn");
    if(tabBtn) tabBtn.addEventListener("click", loadSlots);
    loadSlots();
  }

  window.SlotRewards = { load: loadSlots, earnTaskCredit };
  document.addEventListener("slot-changed", loadSlots);
  document.addEventListener("DOMContentLoaded", init);
})();
