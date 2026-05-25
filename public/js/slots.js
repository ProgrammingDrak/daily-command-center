(function(){
  let slotState = null;
  let filter = "all";
  let rewardSearch = "";
  let rewardCategory = "all";
  let rewardPrice = "all";
  let rewardEligibility = "all";
  let rewardSort = "category";
  let editingId = null;
  let sponsorSplitsDraft = [];
  let isSpinning = false;
  let lastPendingBankCents = 0;
  let pendingDeleteRewardId = null;
  let bankDetailsOpen = false;
  let activeSlotSection = "machine";
  let activeJackpotChoiceSpin = null;
  let activeJackpotChoiceFilter = "any";
  let slotPetHome = null;
  let slotPetReactionTimer = null;
  let slotRewardAnimationTimer = null;
  let activeBankPetRunRestore = null;
  const AWARD_QUEUE_KEY = "pa-slot-award-queue";
  const SLOT_SOUND_KEY = "pa-slot-sound-on";
  const coinPhysics = { coins: [], raf: null, lastTs: 0 };
  let slotSoundOn = readSlotSoundPreference();
  let slotAudioCtx = null;
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
    bank_gated: "Reward Reserve prize",
    sponsor: "Partner-sponsored reward",
    choice: "Choice reward",
    reroll: "Reroll outcome"
  };
  const SPONSOR_LABELS = {
    self: "Self",
    accountability_partner: "Accountability",
    romantic_partner: "Romantic",
    either_partner: "Either partner",
    split: "Split sponsor"
  };
  const SPONSOR_PRESETS = {
    accountability_partner: "Accountability partner",
    romantic_partner: "Romantic partner",
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

  function slotPetGlyph(base){
    return { sprout: "S", mossling: "M", moonpup: "P", pufflet: "F" }[base] || "S";
  }

  function slotPetAccessory(accessory){
    return { bandana: "◇", hat: "^", necklace: "o", flower: "*" }[accessory] || "";
  }

  function readSlotSoundPreference(){
    try {
      return localStorage.getItem(SLOT_SOUND_KEY) !== "off";
    } catch(e) {
      return true;
    }
  }

  function writeSlotSoundPreference(){
    try {
      localStorage.setItem(SLOT_SOUND_KEY, slotSoundOn ? "on" : "off");
    } catch(e) {}
  }

  function updateSlotSoundButton(){
    const btn = document.getElementById("slot-sound-toggle");
    if(!btn) return;
    btn.textContent = "Sound: " + (slotSoundOn ? "On" : "Off");
    btn.setAttribute("aria-pressed", slotSoundOn ? "true" : "false");
  }

  function toggleSlotSound(){
    slotSoundOn = !slotSoundOn;
    writeSlotSoundPreference();
    updateSlotSoundButton();
    if(slotSoundOn) slotPlay("toggle");
  }

  function getSlotAudioContext(){
    if(!slotSoundOn) return null;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if(!AudioCtx) return null;
    if(!slotAudioCtx) slotAudioCtx = new AudioCtx();
    if(slotAudioCtx.state === "suspended" && slotAudioCtx.resume) slotAudioCtx.resume().catch(() => {});
    return slotAudioCtx;
  }

  function slotTone(freq, duration, options){
    const ctx = getSlotAudioContext();
    if(!ctx) return;
    const opts = options || {};
    const start = ctx.currentTime + (opts.delay || 0);
    const dur = Math.max(0.02, duration || 0.08);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const gainValue = opts.gain == null ? 0.08 : opts.gain;
    const attack = opts.attack == null ? 0.006 : opts.attack;
    const release = opts.release == null ? 0.05 : opts.release;
    osc.type = opts.type || "sine";
    osc.frequency.setValueAtTime(freq, start);
    if(opts.endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.endFreq), start + dur);
    if(opts.detune) osc.detune.setValueAtTime(opts.detune, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainValue), start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur + release);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur + release + 0.02);
  }

  function slotNoise(duration, options){
    const ctx = getSlotAudioContext();
    if(!ctx) return;
    const opts = options || {};
    const start = ctx.currentTime + (opts.delay || 0);
    const dur = Math.max(0.03, duration || 0.1);
    const sampleCount = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for(let i = 0; i < sampleCount; i++) data[i] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    source.buffer = buffer;
    filter.type = opts.filterType || "bandpass";
    filter.frequency.setValueAtTime(opts.filterFreq || 1200, start);
    filter.Q.setValueAtTime(opts.q || 1.6, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, opts.gain == null ? 0.04 : opts.gain), start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    source.start(start);
    source.stop(start + dur + 0.02);
  }

  function slotPlay(name, detail){
    if(!slotSoundOn) return;
    const d = detail || {};
    try {
      if(name === "toggle"){
        slotTone(660, 0.08, { type: "triangle", gain: 0.07 });
        slotTone(990, 0.11, { type: "triangle", gain: 0.06, delay: 0.08 });
      } else if(name === "lever"){
        slotNoise(0.08, { filterType: "lowpass", filterFreq: 240, gain: 0.12 });
        slotTone(120, 0.16, { type: "sawtooth", gain: 0.06, endFreq: 62 });
      } else if(name === "reelStart"){
        slotTone(180, 0.18, { type: "sawtooth", gain: 0.035, endFreq: 320 });
        slotNoise(0.14, { filterFreq: 620, gain: 0.035, delay: 0.04 });
      } else if(name === "tick"){
        slotTone(520 + ((d.tick || 0) % 5) * 38, 0.025, { type: "square", gain: 0.018, release: 0.012 });
      } else if(name === "stop"){
        slotTone(760 + ((d.index || 0) % 5) * 28, 0.04, { type: "triangle", gain: 0.035, release: 0.018 });
        slotNoise(0.025, { filterFreq: 1900, gain: 0.018 });
      } else if(name === "win"){
        [523, 659, 784, 1046].forEach((freq, i) => slotTone(freq, 0.13, { type: "triangle", gain: 0.07, delay: i * 0.075 }));
        slotTone(1318, 0.24, { type: "sine", gain: 0.05, delay: 0.27 });
      } else if(name === "miss"){
        slotTone(330, 0.12, { type: "triangle", gain: 0.045, endFreq: 260 });
        slotTone(220, 0.16, { type: "triangle", gain: 0.04, endFreq: 160, delay: 0.12 });
        slotNoise(0.07, { filterType: "lowpass", filterFreq: 180, gain: 0.045, delay: 0.21 });
      } else if(name === "pending"){
        slotTone(622, 0.1, { type: "triangle", gain: 0.055 });
        slotTone(932, 0.14, { type: "triangle", gain: 0.05, delay: 0.1 });
      } else if(name === "bankLine"){
        slotTone(392, 0.08, { type: "square", gain: 0.04 });
        slotTone(784, 0.12, { type: "triangle", gain: 0.05, delay: 0.08 });
      } else if(name === "coins"){
        for(let i = 0; i < 12; i++){
          slotTone(820 + (i % 4) * 92, 0.035, { type: "triangle", gain: 0.026, delay: i * 0.036, release: 0.018 });
        }
        slotNoise(0.32, { filterFreq: 2600, gain: 0.025 });
      } else if(name === "sweep"){
        slotTone(440, 0.09, { type: "sine", gain: 0.04 });
        slotTone(880, 0.18, { type: "sine", gain: 0.045, delay: 0.09 });
      } else if(name === "deposit"){
        slotTone(1046, 0.08, { type: "triangle", gain: 0.06 });
        slotTone(1568, 0.16, { type: "sine", gain: 0.045, delay: 0.08 });
      } else if(name === "confirm"){
        slotTone(740, 0.08, { type: "triangle", gain: 0.045 });
        slotTone(988, 0.1, { type: "triangle", gain: 0.04, delay: 0.08 });
      } else if(name === "error"){
        slotTone(180, 0.16, { type: "sawtooth", gain: 0.04, endFreq: 120 });
      }
    } catch(e) {}
  }

  async function api(path, opts){
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if(!res.ok) throw new Error(data.error || "Slot request failed");
    return data;
  }

  async function loadSlotPetHome(){
    try {
      const data = await api("/api/pet-home/state");
      slotPetHome = data && data.home ? data.home : null;
      renderSlotPetHome();
    } catch(e) {}
  }

  function renderSlotPetHome(){
    const avatar = document.getElementById("slot-pet-avatar");
    if(!avatar) return;
    const pet = (slotPetHome && slotPetHome.pet) || {};
    avatar.style.setProperty("--slot-pet-color", pet.color || "#f2b56b");
    setText("slot-pet-glyph", slotPetGlyph(pet.base));
    setText("slot-pet-accessory", slotPetAccessory(pet.accessory));
  }

  function slotPetReact(mood, message, duration){
    const machine = document.querySelector(".slots-machine");
    const avatar = document.getElementById("slot-pet-avatar");
    const speech = document.getElementById("slot-pet-speech");
    if(slotPetReactionTimer) clearTimeout(slotPetReactionTimer);
    if(avatar) {
      avatar.dataset.mood = mood || "idle";
      avatar.classList.remove("slot-pet-bump");
      void avatar.offsetWidth;
    }
    if(speech && message) speech.textContent = message;
    if(machine) machine.classList.toggle("pet-helping", mood === "pull");
    slotPetReactionTimer = setTimeout(() => {
      if(avatar) avatar.dataset.mood = "idle";
      if(machine) machine.classList.remove("pet-helping");
      if(speech) speech.textContent = "Ready.";
    }, duration || 1800);
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
    applySlotSection();
    renderSlotPetHome();
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
    setText("slot-daily-cap", "Bank Building: " + money(bu.today || 0) + " today; " + money(bu.week || 0) + " this week");
    setText("slot-weekly-cap", "Monthly Discretionary Spending: " + money(bu.month || 0) + " / " + money(bu.monthlyGoal || 0) + " unlocked; " + money(bu.monthlyRemaining || 0) + " still locked");
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

  function switchSlotSection(section){
    activeSlotSection = section || "machine";
    applySlotSection();
    if(activeSlotSection === "rewards") renderRewards();
    if(activeSlotSection === "rules") {
      renderSettings();
      renderHistory();
    }
  }

  function applySlotSection(){
    document.querySelectorAll(".slot-section-tab").forEach(btn => {
      const active = btn.dataset.slotSection === activeSlotSection;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll("[data-slot-section-panel]").forEach(panel => {
      panel.classList.toggle("active", panel.dataset.slotSectionPanel === activeSlotSection);
    });
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
    restoreActiveBankPetRunner();
    document.querySelectorAll(".slot-gold-transfer,.slot-bank-flow,.slot-bank-pet-dust,.slot-bank-pet-money,.slot-bank-collect-pop,.slot-piggy-add-pop,.slot-bank-total-pop,.slot-bank-link,.slot-bank-multiplier-pop,.slot-bank-impact-spark,.slot-bank-math-overlay").forEach(el => el.remove());
    document.querySelectorAll(".slot-pending-deposit.receiving").forEach(el => el.classList.remove("receiving"));
    clearSlotRewardEffects();
  }

  function restoreActiveBankPetRunner(){
    if(typeof activeBankPetRunRestore === "function") {
      activeBankPetRunRestore();
      activeBankPetRunRestore = null;
    }
  }

  function clearSlotRewardEffects(){
    if(slotRewardAnimationTimer){
      clearTimeout(slotRewardAnimationTimer);
      slotRewardAnimationTimer = null;
    }
    const machine = document.querySelector(".slots-machine");
    if(machine){
      machine.classList.remove("reward-bank", "reward-pledge", "reward-jackpot", "reward-choice", "reward-reroll", "reward-care", "reward-miss");
    }
    const avatar = document.getElementById("slot-pet-avatar");
    if(avatar){
      avatar.classList.remove("slot-pet-reward", "slot-pet-reward-bank", "slot-pet-reward-pledge", "slot-pet-reward-jackpot", "slot-pet-reward-choice", "slot-pet-reward-reroll", "slot-pet-reward-care", "slot-pet-reward-miss");
    }
    document.querySelectorAll(".slot-cell.reward-focus").forEach(cell => cell.classList.remove("reward-focus"));
    document.querySelectorAll(".slot-reward-burst,.slot-reward-token,.slot-reward-beam,.slot-reward-caption,.slot-pet-trail").forEach(el => el.remove());
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

  async function syncCompletedTaskCredits(){
    await flushTaskCreditQueue();
    await reconcileCompletedTaskCredits();
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
    const spinCost = Math.max(1, Math.min(250, parseInt(costInput && costInput.value, 10) || 25));
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
      const symbol = rewardSymbol(r);
      const oddsLabel = oddsText(r, slotState.rewards || []);
      return '<div class="slot-reward-row ' + (r.eligible ? '' : 'locked') + '" data-id="' + r.id + '">' +
        '<div class="slot-reward-main">' +
          '<div class="slot-reward-title"><span class="slot-symbol-badge" data-symbol="' + esc(symbol.toLowerCase()) + '">' + esc(symbol) + '</span>' + esc(r.title) + '</div>' +
          '<div class="slot-reward-meta">' +
            '<span>' + esc(KIND_LABELS[r.kind] || r.kind) + '</span>' +
            '<span>' + esc(oddsLabel) + '</span>' +
            value + bank + locked +
          '</div>' +
        '</div>' +
        '<div class="slot-reward-actions">' +
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
  }

  function oddsText(reward, rewards){
    const weight = reward && reward.weight ? Number(reward.weight) : 0;
    const pool = (rewards || []).filter(r => r && r.kind !== "miss" && r.active !== false && (r.weight || 0) > 0);
    const total = pool.reduce((sum, r) => sum + (Number(r.weight) || 0), 0);
    const pct = total > 0 && weight > 0 ? (weight / total) * 100 : 0;
    const pctText = pct >= 10 ? pct.toFixed(0) : pct >= 1 ? pct.toFixed(1) : pct > 0 ? pct.toFixed(2) : "0";
    return weight + " odds share" + (weight === 1 ? "" : "s") + " (~" + pctText + "%)";
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
    return rewardCostCents(reward) > 0 || (reward && reward.kind === "sponsor");
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
      bank_too_small: "bank locked",
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
      const metaLabel = taskDrip ? "task bank drip" : screenBank ? "Bank Building hit" : "needs 3 in a row";
      const bank = s.bank_delta_cents ? ' <span class="slot-history-bank">+' + money(s.bank_delta_cents) + '</span>' : '';
      const reserve = s.bank_reserved_cents ? ' <span class="slot-history-bank">reserve ' + money(s.bank_reserved_cents) + '</span>' : '';
      const title = miss ? "No prize" : (snap.title || "Reward");
      return '<div class="slot-history-row">' +
        '<div><strong>' + esc(title) + '</strong>' + bank + reserve +
          '<div class="slot-history-meta">' + esc(symbol) + ' ' + esc(metaLabel) + ' · ' + esc(KIND_LABELS[snap.kind] || snap.kind || "") + ' · ' + new Date(s.created_at).toLocaleString() + '</div>' +
        '</div>' +
        (pending && snap.requires_jackpot_choice ? '<button class="slot-mini primary slot-pick-jackpot" data-id="' + s.id + '">Pick jackpot</button>' :
          pending && !bankBuilderPending ? '<button class="slot-mini primary slot-confirm" data-id="' + s.id + '">Confirm</button>' : '<span class="slot-status ' + (miss ? 'miss' : '') + '">' + esc(bankBuilderPending ? "reserve pending" : (miss ? "no prize" : s.status)) + '</span>') +
      '</div>';
    }).join("");
    el.querySelectorAll(".slot-confirm").forEach(btn => btn.addEventListener("click", () => confirmSpin(btn.dataset.id)));
    el.querySelectorAll(".slot-pick-jackpot").forEach(btn => btn.addEventListener("click", () => {
      const spinRow = (slotState.spins || []).find(s => String(s.id) === String(btn.dataset.id));
      if(spinRow) openJackpotChoice(spinRow);
    }));
  }

  function findReward(id){
    return (slotState && slotState.rewards || []).find(r => String(r.id) === String(id));
  }

  function reserveAvailableCents(){
    const funding = (slotState && slotState.funding) || {};
    const account = (slotState && slotState.account) || {};
    const pending = (slotState && slotState.pendingBankDeposit) || {};
    if(funding.total != null) return funding.total || 0;
    return (account.bank_balance_cents || 0) + (pending.cents || 0);
  }

  function jackpotChoiceCost(reward){
    if(!reward || !["small_paid", "bank_gated"].includes(reward.kind)) return 0;
    return Math.max(reward.value_cents || 0, reward.unlock_threshold_cents || 0, reward.reserve_cost_cents || 0);
  }

  function jackpotChoiceType(reward){
    if(!reward) return "any";
    return reward.kind === "sponsor" ? "partner" : "self";
  }

  function jackpotChoices(){
    const available = reserveAvailableCents();
    return (slotState && slotState.rewards || [])
      .filter(r => r && r.active !== false && (r.weight || 0) > 0 && ["small_paid", "bank_gated", "sponsor"].includes(r.kind))
      .map(r => {
        const cost = jackpotChoiceCost(r);
        return {
          ...r,
          choice_type: jackpotChoiceType(r),
          choice_cost_cents: cost,
          choice_affordable: cost <= available,
          choice_shortfall_cents: Math.max(0, cost - available)
        };
      });
  }

  function openJackpotChoice(spinRow){
    activeJackpotChoiceSpin = spinRow;
    activeJackpotChoiceFilter = "any";
    renderJackpotChoiceModal();
  }

  function closeJackpotChoiceModal(){
    activeJackpotChoiceSpin = null;
    const modal = document.getElementById("slot-jackpot-choice-modal");
    if(modal) modal.remove();
  }

  function renderJackpotChoiceModal(){
    if(!activeJackpotChoiceSpin) return;
    let modal = document.getElementById("slot-jackpot-choice-modal");
    if(!modal){
      modal = document.createElement("div");
      modal.id = "slot-jackpot-choice-modal";
      modal.className = "slot-jackpot-modal";
      document.body.appendChild(modal);
    }
    const available = reserveAvailableCents();
    const choices = jackpotChoices().filter(r => activeJackpotChoiceFilter === "any" || r.choice_type === activeJackpotChoiceFilter);
    const rows = choices.length ? choices.map(r => {
      const disabled = !r.choice_affordable;
      const sponsor = r.kind === "sponsor" ? '<span>' + esc(SPONSOR_LABELS[r.sponsor_type] || "Partner") + '</span>' : '';
      const price = r.choice_cost_cents > 0 ? '<span>' + money(r.choice_cost_cents) + '</span>' : '<span>partner-covered</span>';
      const lock = disabled ? '<em>Need ' + money(r.choice_shortfall_cents) + ' more reserve</em>' : '<em>Available now</em>';
      return '<button class="slot-jackpot-choice ' + (disabled ? 'locked' : '') + '" data-id="' + r.id + '" ' + (disabled ? 'disabled' : '') + '>' +
        '<strong>' + esc(r.title || "Jackpot") + '</strong>' +
        '<span class="slot-jackpot-choice-meta">' +
          '<span>' + esc(r.choice_type === "partner" ? "Partner Jackpot" : "Self Jackpot") + '</span>' +
          price + sponsor + lock +
        '</span>' +
      '</button>';
    }).join("") : '<div class="slot-empty">No jackpots in this category yet.</div>';
    modal.innerHTML =
      '<div class="slot-jackpot-backdrop"></div>' +
      '<section class="slot-jackpot-dialog" role="dialog" aria-modal="true" aria-label="Choose jackpot">' +
        '<div class="slot-jackpot-head">' +
          '<div><div class="slot-jackpot-kicker">Jackpot hit</div><h3>Pick your prize</h3><p>Reward Reserve available: <strong>' + money(available) + '</strong></p></div>' +
          '<button class="slot-icon-btn slot-jackpot-close" type="button" aria-label="Close jackpot picker">&times;</button>' +
        '</div>' +
        '<div class="slot-jackpot-filters" role="tablist" aria-label="Jackpot types">' +
          jackpotFilterButton("any", "Any") +
          jackpotFilterButton("self", "Self") +
          jackpotFilterButton("partner", "Partner") +
        '</div>' +
        '<div class="slot-jackpot-list">' + rows + '</div>' +
      '</section>';
    modal.querySelector(".slot-jackpot-backdrop").addEventListener("click", closeJackpotChoiceModal);
    modal.querySelector(".slot-jackpot-close").addEventListener("click", closeJackpotChoiceModal);
    modal.querySelectorAll(".slot-jackpot-filter").forEach(btn => btn.addEventListener("click", () => {
      activeJackpotChoiceFilter = btn.dataset.jackpotFilter || "any";
      renderJackpotChoiceModal();
    }));
    modal.querySelectorAll(".slot-jackpot-choice:not(:disabled)").forEach(btn => btn.addEventListener("click", () => chooseJackpotReward(btn.dataset.id)));
  }

  function jackpotFilterButton(name, label){
    const active = activeJackpotChoiceFilter === name;
    return '<button class="slot-jackpot-filter ' + (active ? 'active' : '') + '" data-jackpot-filter="' + name + '" type="button" aria-selected="' + (active ? 'true' : 'false') + '">' + label + '</button>';
  }

  async function chooseJackpotReward(rewardId){
    if(!activeJackpotChoiceSpin || !rewardId) return;
    try {
      const spinRow = await api("/api/slot/spins/" + activeJackpotChoiceSpin.id + "/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reward_id: rewardId })
      });
      const snap = spinRow.reward_snapshot || {};
      slotPlay("confirm");
      closeJackpotChoiceModal();
      setResult("Jackpot selected: " + (snap.title || "Reward"));
      await loadSlots();
    } catch(e) {
      setResult(e.message);
      slotPlay("error");
      await loadSlots();
      renderJackpotChoiceModal();
    }
  }

  async function spin(){
    if(isSpinning) return;
    const btn = document.getElementById("slot-spin-btn");
    if(btn) btn.disabled = true;
    isSpinning = true;
    setResult("Pulling the lever...");
    const petHelps = Math.random() < 0.42;
    slotPetReact(petHelps ? "pull" : "idle", petHelps ? "I got it." : "Here we go.", 1200);
    slotPlay("lever");
    try {
      const spinRow = await api("/api/slot/spin", { method: "POST" });
      const snap = spinRow.reward_snapshot || {};
      setResult("Building houses...");
      await animateReels(resultSymbols(spinRow, snap));
      const bankHit = (spinRow.bank_delta_cents || 0) > 0;
      if(bankHit) {
        highlightWinningCells(spinRow, snap);
        animateRewardReveal(spinRow, snap);
      }
      if((spinRow.bank_delta_cents || 0) > 0) {
        await animateBankPayout(spinRow, snap, spinRow.bank_delta_cents || 0);
        if(hasLoadedSpin(spinRow.id)) inflatePendingDeposit(spinRow.bank_delta_cents || 0);
        else addPendingDeposit(spinRow.bank_delta_cents || 0);
      }
      if(!bankHit) {
        highlightWinningCells(spinRow, snap);
        animateRewardReveal(spinRow, snap);
      }
      setResult(resultText(spinRow, snap));
      if((spinRow.bank_delta_cents || 0) > 0) {
        slotPlay("win");
        slotPetReact("happy", "Bank hit!", 2400);
      } else if(spinRow.status === "miss" || snap.kind === "miss") {
        slotPlay("miss");
        slotPetReact("sad", "Almost.", 2100);
      } else if(spinRow.status === "pending") {
        slotPlay("pending");
        slotPetReact("happy", snap.requires_jackpot_choice ? "Pick one." : "Prize waiting.", 2300);
      } else {
        slotPlay("win");
        slotPetReact("happy", "Nice pull.", 2300);
      }
      isSpinning = false;
      await loadSlots();
      if(snap.requires_jackpot_choice) {
        const refreshed = (slotState && slotState.spins || []).find(s => String(s.id) === String(spinRow.id)) || spinRow;
        openJackpotChoice(refreshed);
      }
    } catch(e) {
      isSpinning = false;
      setResult(e.message);
      slotPlay("error");
      slotPetReact("sad", "Need more points.", 2200);
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
    slotPlay("reelStart");
    return new Promise(resolve => {
      const timer = setInterval(() => {
        reels.forEach((r, i) => {
          if(r.classList.contains("stopped")) return;
          setCell(r, SPIN_SYMBOLS[(tick + i * 5) % SPIN_SYMBOLS.length]);
          r.classList.toggle("pulse", tick % 2 === 0);
        });
        if(tick % 3 === 0) slotPlay("tick", { tick });
        tick++;
      }, 48);
      reels.forEach((r, i) => {
        setTimeout(() => {
          r.classList.add("stopped");
          setCell(r, targets[i % targets.length] || "STAR");
          r.classList.add("reveal");
          slotPlay("stop", { index: i });
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
    const payout = (snap && snap.bank_screen_payout) || {};
    if((spinRow && (spinRow.bank_delta_cents || 0) > 0) && Array.isArray(payout.positions)) {
      return payout.positions;
    }
    if(!isMiss && payline.length) return payline;

    const symbol = rewardSymbol(snap || {});
    if(!isMiss && board && board.length){
      const line = PAYLINES.find(candidate => candidate.every(i => board[i] === symbol));
      if(line) return line;
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

  function rewardAnimationKind(spinRow, snap){
    const payout = (snap && snap.bank_screen_payout) || {};
    const bankDelta = (spinRow && (spinRow.bank_delta_cents || 0)) || payout.cents || 0;
    const status = spinRow && spinRow.status;
    const kind = snap && snap.kind;
    if(bankDelta > 0 || kind === "bank_builder" || (snap && snap.source_type === "slot_screen_bank_builder")) return "bank";
    if(status === "miss" || kind === "miss") return "miss";
    if(kind === "sponsor") return "pledge";
    if(kind === "choice") return "choice";
    if(kind === "reroll") return "reroll";
    if((snap && snap.requires_jackpot_choice) || isJackpotReward(snap || {})) return "jackpot";
    return "care";
  }

  function rewardAnimationConfig(kind, spinRow, snap){
    const title = (snap && snap.title) || "";
    const jackpotLabel = (snap && snap.requires_jackpot_choice) ? "Pick a prize" : "Jackpot";
    const bankDelta = (spinRow && (spinRow.bank_delta_cents || 0)) || ((snap && snap.bank_screen_payout && snap.bank_screen_payout.cents) || 0);
    const configs = {
      bank: { caption: bankDelta > 0 ? "+" + money(bankDelta) + " Reserve" : "Reserve up", tokens: ["BANK", "+$", "+$"], beams: 5 },
      pledge: { caption: title ? "Pledge: " + title : "Pledge hit", tokens: ["PLEDGE", "PARTNER", "SIGNED"], beams: 4 },
      jackpot: { caption: title || jackpotLabel, tokens: ["JACKPOT", "UNLOCK", "PRIZE"], beams: 6 },
      choice: { caption: "Pick your prize", tokens: ["PICK", "1", "2", "3"], beams: 3 },
      reroll: { caption: "Reroll charged", tokens: ["REROLL", "AGAIN", "SPIN"], beams: 4 },
      care: { caption: title || "Reward hit", tokens: ["CARE", "WIN", "READY"], beams: 4 },
      miss: { caption: "Almost", tokens: ["MISS", "NEXT", "TRY"], beams: 2 }
    };
    return configs[kind] || configs.care;
  }

  function animateRewardReveal(spinRow, snap){
    if(!isSlotsPageActive()) return null;
    const kind = rewardAnimationKind(spinRow || {}, snap || {});
    const config = rewardAnimationConfig(kind, spinRow || {}, snap || {});
    const machine = document.querySelector(".slots-machine");
    const frame = document.querySelector(".slot-reels-frame");
    const reels = Array.from(document.querySelectorAll(".slot-cell"));
    if(!frame || !reels.length) return null;

    clearSlotRewardEffects();
    if(machine) machine.classList.add("reward-" + kind);
    const positions = winningPositions(spinRow || {}, snap || {});
    const cells = (positions.length ? positions : [2, 7, 12]).map(i => reels[i]).filter(Boolean);
    cells.forEach(cell => cell.classList.add("reward-focus"));
    triggerPetRewardAnimation(kind);
    const caption = showRewardCaption(frame, kind, config.caption);
    const tokens = spawnRewardTokens(cells, kind, config.tokens);
    const beams = spawnRewardBeams(kind, cells, config.beams);
    slotRewardAnimationTimer = setTimeout(clearSlotRewardEffects, kind === "miss" ? 1900 : (kind === "bank" ? 3900 : 3100));
    return { kind, caption, tokens, beams };
  }

  function triggerPetRewardAnimation(kind){
    const avatar = document.getElementById("slot-pet-avatar");
    const companion = document.getElementById("slot-pet-companion");
    if(!avatar) return;
    avatar.classList.remove("slot-pet-reward", "slot-pet-reward-bank", "slot-pet-reward-pledge", "slot-pet-reward-jackpot", "slot-pet-reward-choice", "slot-pet-reward-reroll", "slot-pet-reward-care", "slot-pet-reward-miss");
    void avatar.offsetWidth;
    avatar.classList.add("slot-pet-reward", "slot-pet-reward-" + kind);
    if(companion) spawnPetTrail(companion, kind);
  }

  function showRewardCaption(frame, kind, text){
    const rect = frame.getBoundingClientRect();
    const caption = document.createElement("div");
    caption.className = "slot-reward-caption " + kind;
    caption.textContent = text || "Reward hit";
    caption.style.left = (rect.left + rect.width / 2) + "px";
    caption.style.top = (rect.top + 20) + "px";
    document.body.appendChild(caption);
    return caption;
  }

  function spawnRewardTokens(cells, kind, labels){
    const tokens = [];
    const sourceCells = cells.length ? cells : Array.from(document.querySelectorAll(".slot-cell")).slice(0, 3);
    sourceCells.forEach((cell, cellIdx) => {
      const rect = cell.getBoundingClientRect();
      for(let i = 0; i < 3; i++){
        const token = document.createElement("span");
        token.className = "slot-reward-token " + kind;
        token.textContent = labels[(cellIdx + i) % labels.length] || "WIN";
        token.style.left = (rect.left + rect.width / 2) + "px";
        token.style.top = (rect.top + rect.height / 2) + "px";
        token.style.setProperty("--reward-dx", (((i - 1) * 32) + (cellIdx % 2 ? 20 : -20)) + "px");
        token.style.setProperty("--reward-dy", (-70 - (i * 18) - (cellIdx * 5)) + "px");
        token.style.animationDelay = ((cellIdx * 120) + (i * 80)) + "ms";
        document.body.appendChild(token);
        tokens.push(token);
      }
    });
    return tokens;
  }

  function spawnRewardBeams(kind, cells, count){
    const avatar = document.getElementById("slot-pet-avatar");
    const beams = [];
    if(!avatar || !cells.length || kind === "miss") return beams;
    const petRect = avatar.getBoundingClientRect();
    const px = petRect.left + petRect.width / 2;
    const py = petRect.top + petRect.height / 2;
    const max = Math.max(1, Math.min(count || 3, cells.length * 2));
    for(let i = 0; i < max; i++){
      const cell = cells[i % cells.length];
      const rect = cell.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const dx = x - px;
      const dy = y - py;
      const beam = document.createElement("span");
      beam.className = "slot-reward-beam " + kind;
      beam.style.left = px + "px";
      beam.style.top = py + "px";
      beam.style.width = Math.sqrt(dx * dx + dy * dy) + "px";
      beam.style.transform = "rotate(" + Math.atan2(dy, dx) + "rad)";
      beam.style.animationDelay = (i * 135) + "ms";
      document.body.appendChild(beam);
      beams.push(beam);
    }
    return beams;
  }

  function spawnPetTrail(companion, kind){
    const rect = companion.getBoundingClientRect();
    for(let i = 0; i < 7; i++){
      const dot = document.createElement("span");
      dot.className = "slot-pet-trail " + kind;
      dot.style.left = (rect.left + rect.width - 42 - (i * 7)) + "px";
      dot.style.top = (rect.top + rect.height - 36 + ((i % 3) * 6)) + "px";
      dot.style.animationDelay = (i * 70) + "ms";
      document.body.appendChild(dot);
    }
  }

  async function animateBankPayout(spinRow, snap, deltaCents){
    const payout = (snap && snap.bank_screen_payout) || {};
    const positions = Array.isArray(payout.positions) ? payout.positions : [];
    if(!positions.length) return;
    const reels = Array.from(document.querySelectorAll(".slot-cell"));
    const cells = positions.map(i => reels[i]).filter(Boolean);
    if(!cells.length) return;

    cells.forEach(cell => cell.classList.add("bank-hit"));
    slotPlay("bankLine");
    const math = showBankMathOverlay(cells, payout, deltaCents);
    updateBankMathOverlay(math, "Bank tiles", bankUnitLine(payout.base_units || cells.length, 0, 0), bankTotalLine(payout, deltaCents, "base"));
    await wait(340);

    const horizontalGroups = Array.isArray(payout.horizontal_groups) ? payout.horizontal_groups : [];
    horizontalGroups.flat().forEach(i => {
      if(reels[i]) reels[i].classList.add("bank-horizontal");
    });
    const verticalGroups = Array.isArray(payout.vertical_groups) ? payout.vertical_groups : [];
    verticalGroups.flat().forEach(i => {
      if(reels[i]) reels[i].classList.add("bank-vertical");
    });

    updateBankMathOverlay(math, "Chain reaction", bankUnitLine(payout.base_units || cells.length, payout.horizontal_bonus_units || 0, payout.vertical_bonus_units || 0), "Bank links are firing together.");
    const horizontalPromise = playBankLightningGroups(horizontalGroups, reels, "row", "Double Points!");
    const verticalPromise = playBankLightningGroups(verticalGroups, reels, "column", "+1 Bank Unit!");
    const target = document.getElementById("slot-bank-balance") || document.getElementById("slot-pending-deposit");
    const reservePromise = target ? animateBankReserveDrain(cells, target, deltaCents) : Promise.resolve();
    await wait(520);
    updateBankMathOverlay(math, "Reserve math", bankFinalFormula(payout), bankTotalLine(payout, deltaCents, "final"));
    const [horizontalLinks, verticalLinks] = await Promise.all([horizontalPromise, verticalPromise]);
    await reservePromise;
    await wait(160);
    dismissBankMathOverlay(math);
    [...horizontalLinks, ...verticalLinks].forEach(link => link.remove());
    if(deltaCents <= 0) await wait(360);
    cells.forEach(cell => cell.classList.remove("bank-hit", "bank-horizontal", "bank-vertical"));
  }

  function bankUnitLine(baseUnits, horizontalUnits, verticalUnits){
    const parts = [baseUnits + " BANK"];
    if(horizontalUnits > 0) parts.push("+ " + horizontalUnits + " row");
    if(verticalUnits > 0) parts.push("+ " + verticalUnits + " column");
    const total = baseUnits + horizontalUnits + verticalUnits;
    return parts.join(" ") + " = " + total + " unit" + (total === 1 ? "" : "s");
  }

  function bankFinalFormula(payout){
    const units = payout.units || 0;
    const baseCents = payout.base_cents || 0;
    return units + " x " + money(baseCents) + " = " + money((payout.raw_cents != null ? payout.raw_cents : units * baseCents));
  }

  function bankTotalLine(payout, deltaCents, step){
    if(step === "base") return "Each BANK starts one unit.";
    if(step === "horizontal" && (payout.horizontal_bonus_units || 0) > 0) return "Connected rows multiply the bank units.";
    if(step === "vertical" && (payout.vertical_bonus_units || 0) > 0) return "Connected columns add another boost.";
    if(payout.capped) return "Cap applied: +" + money(deltaCents);
    if(step === "final") return "Reserve add: +" + money(deltaCents);
    return "No extra link bonus here.";
  }

  function showBankMathOverlay(cells, payout, deltaCents){
    if(!isSlotsPageActive()) return null;
    const frame = document.querySelector(".slot-reels-frame");
    const frameRect = frame ? frame.getBoundingClientRect() : null;
    const overlay = document.createElement("div");
    overlay.className = "slot-bank-math-overlay";
    const panel = document.createElement("div");
    panel.className = "slot-bank-math-panel";
    if(frameRect){
      panel.style.left = (frameRect.left + frameRect.width / 2) + "px";
      panel.style.top = (frameRect.top + 16) + "px";
    }
    panel.innerHTML = '<span class="slot-bank-math-title"></span><strong class="slot-bank-math-formula"></strong><em class="slot-bank-math-total"></em>';
    overlay.appendChild(panel);
    cells.forEach((cell, idx) => {
      const rect = cell.getBoundingClientRect();
      const node = document.createElement("span");
      node.className = "slot-bank-math-node";
      node.textContent = "+1";
      node.style.left = (rect.left + rect.width / 2) + "px";
      node.style.top = (rect.top + rect.height / 2) + "px";
      node.style.animationDelay = (idx * 45) + "ms";
      overlay.appendChild(node);
    });
    document.body.appendChild(overlay);
    return {
      overlay,
      title: panel.querySelector(".slot-bank-math-title"),
      formula: panel.querySelector(".slot-bank-math-formula"),
      total: panel.querySelector(".slot-bank-math-total"),
      payout,
      deltaCents
    };
  }

  function updateBankMathOverlay(math, title, formula, total){
    if(!math) return;
    if(math.title) math.title.textContent = title;
    if(math.formula) math.formula.textContent = formula;
    if(math.total) math.total.textContent = total;
    math.overlay.classList.remove("step-pop");
    void math.overlay.offsetWidth;
    math.overlay.classList.add("step-pop");
  }

  function dismissBankMathOverlay(math){
    if(!math || !math.overlay) return;
    math.overlay.classList.add("leaving");
    setTimeout(() => {
      if(math.overlay) math.overlay.remove();
    }, 360);
  }

  async function playBankLightningGroups(groups, reels, tone, impactLabel){
    if(!isSlotsPageActive() || !Array.isArray(groups) || !groups.length) return [];
    const links = [];
    groups.forEach((group) => {
      for(let i = 0; i < group.length - 1; i++){
        const from = reels[group[i]];
        const to = reels[group[i + 1]];
        if(!from || !to) continue;
        const fromRect = from.getBoundingClientRect();
        const toRect = to.getBoundingClientRect();
        const x1 = fromRect.left + fromRect.width / 2;
        const y1 = fromRect.top + fromRect.height / 2;
        const x2 = toRect.left + toRect.width / 2;
        const y2 = toRect.top + toRect.height / 2;
        const dx = x2 - x1;
        const dy = y2 - y1;
        const link = document.createElement("span");
        link.className = "slot-bank-link " + tone;
        link.style.left = x1 + "px";
        link.style.top = y1 + "px";
        link.style.width = Math.sqrt(dx * dx + dy * dy) + "px";
        link.style.transform = "rotate(" + Math.atan2(dy, dx) + "rad)";
        link.style.animationDelay = "0ms";
        link.dataset.startX = String(x1);
        link.dataset.startY = String(y1);
        link.dataset.impactX = String(x2);
        link.dataset.impactY = String(y2);
        links.push({ link, from, to });
      }
    });
    const renderedLinks = [];
    links.forEach((item, idx) => {
      const { link, from, to } = item;
      const startX = Number(link.dataset.startX || 0);
      const startY = Number(link.dataset.startY || 0);
      const impactX = Number(link.dataset.impactX || 0);
      const impactY = Number(link.dataset.impactY || 0);
      const delay = idx * 145;
      setTimeout(() => {
        if(!isSlotsPageActive()) return;
        showBankTileSurge(startX, startY, tone, "charge");
        if(from) {
          from.classList.remove("bank-zap-source");
          void from.offsetWidth;
          from.classList.add("bank-zap-source");
        }
      }, delay);
      setTimeout(() => {
        if(!isSlotsPageActive()) return;
        document.body.appendChild(link);
        renderedLinks.push(link);
        slotPlay("bankLine");
      }, delay + 105);
      setTimeout(() => {
        if(!isSlotsPageActive()) return;
        if(to) {
          to.classList.remove("bank-zap-impact");
          void to.offsetWidth;
          to.classList.add("bank-zap-impact");
        }
        showBankTileSurge(impactX, impactY, tone, "impact");
        showBankMultiplierPop(impactX, impactY, impactLabel, tone);
      }, delay + 620);
      setTimeout(() => {
        if(from) from.classList.remove("bank-zap-source");
        if(to) to.classList.remove("bank-zap-impact");
      }, delay + 1250);
    });
    await wait(links.length ? 1460 + ((links.length - 1) * 145) : 0);
    return renderedLinks;
  }

  function showBankTileSurge(x, y, tone, phase){
    if(!isSlotsPageActive()) return;
    const spark = document.createElement("span");
    spark.className = "slot-bank-impact-spark " + tone + " " + (phase || "impact");
    spark.style.left = x + "px";
    spark.style.top = y + "px";
    document.body.appendChild(spark);
    spark.addEventListener("animationend", () => spark.remove(), { once: true });
  }

  function showBankMultiplierPop(x, y, label, tone){
    if(!isSlotsPageActive()) return;
    const pop = document.createElement("span");
    pop.className = "slot-bank-multiplier-pop " + tone;
    pop.textContent = label;
    pop.style.left = x + "px";
    pop.style.top = y + "px";
    document.body.appendChild(pop);
    pop.addEventListener("animationend", () => pop.remove(), { once: true });
  }

  async function previewBankAnimationScenario(name){
    const scenarios = {
      base: {
        board: ["BANK","STRAW","STICK","BRICK","BANK","TOOLS","HAT","STRAW","JACKPOT","HOUSE","STRAW","HOUSE","CARE","STICK","HOUSE"],
        payout: { positions: [0,4], horizontal_groups: [], vertical_groups: [], base_cents: 22, base_units: 2, horizontal_bonus_units: 0, vertical_bonus_units: 0, units: 2, raw_cents: 44, cents: 44 }
      },
      row: {
        board: ["BANK","BANK","BANK","STICK","REROLL","TOOLS","HAT","STRAW","JACKPOT","HOUSE","STRAW","HOUSE","CARE","STICK","HOUSE"],
        payout: { positions: [0,1,2], horizontal_groups: [[0,1,2]], vertical_groups: [], base_cents: 22, base_units: 3, horizontal_bonus_units: 6, vertical_bonus_units: 0, units: 9, raw_cents: 198, cents: 198 }
      },
      column: {
        board: ["BANK","STRAW","STICK","BRICK","REROLL","BANK","HAT","STRAW","JACKPOT","HOUSE","BANK","HOUSE","CARE","STICK","HOUSE"],
        payout: { positions: [0,5,10], horizontal_groups: [], vertical_groups: [[0,5,10]], base_cents: 22, base_units: 3, horizontal_bonus_units: 0, vertical_bonus_units: 3, units: 6, raw_cents: 132, cents: 132 }
      },
      mixed: {
        board: ["BANK","BANK","BANK","BRICK","REROLL","TOOLS","HAT","BANK","JACKPOT","HOUSE","STRAW","HOUSE","BANK","STICK","HOUSE"],
        payout: { positions: [0,1,2,7,12], horizontal_groups: [[0,1,2]], vertical_groups: [[2,7,12]], base_cents: 22, base_units: 5, horizontal_bonus_units: 6, vertical_bonus_units: 3, units: 14, raw_cents: 308, cents: 308 }
      },
      capped: {
        board: ["BANK","BANK","BANK","BANK","BANK","TOOLS","HAT","BANK","JACKPOT","HOUSE","STRAW","HOUSE","BANK","STICK","HOUSE"],
        payout: { positions: [0,1,2,3,4,7,12], horizontal_groups: [[0,1,2,3,4]], vertical_groups: [[2,7,12]], base_cents: 22, base_units: 7, horizontal_bonus_units: 20, vertical_bonus_units: 3, units: 30, raw_cents: 660, cents: 500, capped: true }
      }
    };
    const scenario = scenarios[name] || scenarios.mixed;
    const reels = Array.from(document.querySelectorAll(".slot-cell"));
    if(!reels.length) return null;
    clearSlotCoinEffects();
    clearResultHighlights();
    reels.forEach((cell, idx) => {
      setCell(cell, scenario.board[idx] || "STRAW");
      cell.classList.remove("bank-hit", "bank-horizontal", "bank-vertical", "reveal", "spinning", "pulse", "stopped");
      cell.classList.add("reveal");
    });
    const snap = { bank_screen_payout: scenario.payout, screen_board: scenario.board, kind: "bank_builder", source_type: "slot_screen_bank_builder" };
    const spinRow = { id: Date.now(), status: "pending", bank_delta_cents: scenario.payout.cents };
    highlightWinningCells(spinRow, snap);
    animateRewardReveal(spinRow, snap);
    await animateBankPayout(spinRow, snap, scenario.payout.cents);
    highlightWinningCells(spinRow, snap);
    return scenario.payout;
  }

  async function previewRewardAnimationScenario(name){
    const scenarios = {
      bank: { kind: "bank_builder", status: "pending", symbol: "BANK", title: "Reserve boost", bank_delta_cents: 462, payout: { positions: [0, 1, 2, 7, 12], cents: 462 } },
      pledge: { kind: "sponsor", status: "awarded", symbol: "PLEDGE", title: "Partner chooses a shared playlist night" },
      jackpot: { kind: "bank_gated", status: "pending", symbol: "JACKPOT", title: "Fancy dinner night", requires_jackpot_choice: true },
      choice: { kind: "choice", status: "pending", symbol: "PICK", title: "Choose one of three rewards" },
      reroll: { kind: "reroll", status: "awarded", symbol: "REROLL", title: "Extra spin" },
      care: { kind: "free", status: "awarded", symbol: "CARE", title: "Care package" },
      miss: { kind: "miss", status: "miss", symbol: "MISS", title: "No prize" }
    };
    const scenario = scenarios[name] || scenarios.pledge;
    const reels = Array.from(document.querySelectorAll(".slot-cell"));
    if(!reels.length) return null;
    clearSlotCoinEffects();
    clearResultHighlights();
    const seed = hashCode(scenario.kind + "|" + scenario.title);
    const board = Array.from({ length: 15 }, (_, i) => FILLER_SYMBOLS[(seed + i * 4) % FILLER_SYMBOLS.length]);
    const line = scenario.status === "miss" ? [1, 7, 13] : PAYLINES[seed % PAYLINES.length];
    line.forEach(i => { board[i] = scenario.symbol; });
    reels.forEach((cell, idx) => {
      setCell(cell, board[idx] || "STRAW");
      cell.classList.remove("bank-hit", "bank-horizontal", "bank-vertical", "reveal", "spinning", "pulse", "stopped", "win-hit", "reward-focus");
      cell.classList.add("reveal");
    });
    const snap = {
      kind: scenario.kind,
      title: scenario.title,
      screen_board: board,
      screen_payline: scenario.status === "miss" ? [] : line,
      requires_jackpot_choice: !!scenario.requires_jackpot_choice,
      bank_screen_payout: scenario.payout || {}
    };
    const spinRow = { id: Date.now(), status: scenario.status, bank_delta_cents: scenario.bank_delta_cents || 0 };
    highlightWinningCells(spinRow, snap);
    return animateRewardReveal(spinRow, snap);
  }

  async function animateBankReserveDrain(cells, target, deltaCents){
    if(!isSlotsPageActive() || !target) return;
    target.classList.add("receiving");
    await animateBankPetRunner(cells, target, deltaCents);
    if(isSlotsPageActive()) showPiggyBankAddAmount(target, deltaCents);
    await wait(420);
    target.classList.remove("receiving");
  }

  async function animateBankPetRunner(cells, target, deltaCents){
    const avatar = document.getElementById("slot-pet-avatar");
    if(!avatar || !cells.length || !target) {
      showBankReserveTotalPop(target, deltaCents);
      flyBankLights(cells, target, 2, 42);
      await wait(760);
      return;
    }
    const runner = makeBankPetRunner(avatar);
    const avatarRect = avatar.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const start = centerPoint(avatarRect);
    const reserve = centerPoint(targetRect);
    runner.style.left = start.x + "px";
    runner.style.top = start.y + "px";
    slotPlay("sweep", { cents: deltaCents });
    await wait(40);

    const route = cells.map(cell => ({ cell, point: centerPoint(cell.getBoundingClientRect()) }));
    const ordered = route;
    for(let i = 0; i < ordered.length; i++){
      const step = ordered[i];
      const duration = i === 0 ? 220 : 128;
      await moveBankPetRunner(runner, step.point, duration, i);
      flashBankPetCollect(step.cell, step.point, i);
      if(i === 0) runner.classList.add("carrying");
      await wait(28);
    }

    await moveBankPetRunner(runner, reserve, 260, ordered.length);
    showBankReserveTotalPop(target, deltaCents);
    runner.classList.add("depositing");
    await wait(220);
    runner.classList.remove("carrying", "depositing");
    const homeRect = runner.dataset.homeLeft ? {
      left: Number(runner.dataset.homeLeft),
      top: Number(runner.dataset.homeTop),
      width: Number(runner.dataset.homeWidth),
      height: Number(runner.dataset.homeHeight)
    } : avatarRect;
    await moveBankPetRunner(runner, centerPoint(homeRect), 260, ordered.length + 1);
    restoreActiveBankPetRunner();
  }

  function makeBankPetRunner(avatar){
    restoreActiveBankPetRunner();
    const runner = avatar;
    const rect = runner.getBoundingClientRect();
    const original = {
      className: runner.className,
      cssText: runner.style.cssText,
      mood: runner.dataset.mood,
      parent: runner.parentNode,
      nextSibling: runner.nextSibling
    };
    runner.dataset.homeLeft = String(rect.left);
    runner.dataset.homeTop = String(rect.top);
    runner.dataset.homeWidth = String(rect.width);
    runner.dataset.homeHeight = String(rect.height);
    runner.style.left = (rect.left + rect.width / 2) + "px";
    runner.style.top = (rect.top + rect.height / 2) + "px";
    runner.style.width = rect.width + "px";
    runner.style.height = rect.height + "px";
    runner.style.margin = (-rect.height / 2) + "px 0 0 " + (-rect.width / 2) + "px";
    runner.classList.add("slot-bank-pet-runner");
    runner.classList.remove("slot-pet-reward-bank", "slot-pet-reward", "slot-pet-bump");
    runner.dataset.mood = "idle";
    activeBankPetRunRestore = () => {
      runner.querySelectorAll(".slot-bank-pet-money").forEach(el => el.remove());
      if(original.parent && runner.parentNode !== original.parent) {
        original.parent.insertBefore(runner, original.nextSibling);
      }
      runner.className = original.className;
      runner.style.cssText = original.cssText;
      if(original.mood == null) runner.removeAttribute("data-mood");
      else runner.dataset.mood = original.mood;
      delete runner.dataset.homeLeft;
      delete runner.dataset.homeTop;
      delete runner.dataset.homeWidth;
      delete runner.dataset.homeHeight;
    };
    const money = document.createElement("span");
    money.className = "slot-bank-pet-money";
    money.textContent = "$";
    runner.appendChild(money);
    return runner;
  }

  function centerPoint(rect){
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function moveBankPetRunner(runner, point, duration, step){
    return new Promise(resolve => {
      if(!runner || !isSlotsPageActive()) return resolve();
      const currentX = parseFloat(runner.style.left || "0");
      const currentY = parseFloat(runner.style.top || "0");
      const dx = point.x - currentX;
      runner.style.setProperty("--runner-turn", dx < 0 ? "-1" : "1");
      runner.style.setProperty("--runner-step", String(step % 2));
      runner.classList.remove("running");
      void runner.offsetWidth;
      runner.classList.add("running");
      spawnBankPetDust(currentX, currentY, step);
      runner.style.transitionDuration = duration + "ms";
      runner.style.left = point.x + "px";
      runner.style.top = point.y + "px";
      setTimeout(resolve, duration + 18);
    });
  }

  function spawnBankPetDust(x, y, step){
    for(let i = 0; i < 3; i++){
      const dust = document.createElement("span");
      dust.className = "slot-bank-pet-dust";
      dust.style.left = (x - 16 + i * 8) + "px";
      dust.style.top = (y + 22 + (step % 2) * 3) + "px";
      dust.style.animationDelay = (i * 38) + "ms";
      document.body.appendChild(dust);
      dust.addEventListener("animationend", () => dust.remove(), { once: true });
    }
  }

  function flashBankPetCollect(cell, point, idx){
    if(cell){
      cell.classList.remove("bank-pet-collected");
      void cell.offsetWidth;
      cell.classList.add("bank-pet-collected");
      setTimeout(() => cell.classList.remove("bank-pet-collected"), 540);
    }
    const pop = document.createElement("span");
    pop.className = "slot-bank-collect-pop";
    pop.textContent = "+$";
    pop.style.left = point.x + "px";
    pop.style.top = point.y + "px";
    pop.style.animationDelay = (idx % 2 ? 35 : 0) + "ms";
    document.body.appendChild(pop);
    pop.addEventListener("animationend", () => pop.remove(), { once: true });
  }

  function showBankReserveTotalPop(target, deltaCents){
    if(!target) return;
    const rect = target.getBoundingClientRect();
    const pop = document.createElement("span");
    pop.className = "slot-bank-total-pop";
    pop.innerHTML = '<small>Reserve add</small><strong>+' + money(deltaCents) + '</strong>';
    pop.style.left = (rect.left + rect.width / 2) + "px";
    pop.style.top = (rect.top + Math.min(46, rect.height / 2)) + "px";
    document.body.appendChild(pop);
    pop.addEventListener("animationend", () => pop.remove(), { once: true });
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
    slotPlay("coins", { cents: deltaCents });
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
    slotPlay("sweep", { cents: deltaCents });
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
    slotPlay("deposit", { cents: deltaCents });
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

  function flyBankLights(cells, target, bursts, gapMs){
    if(!isSlotsPageActive()) return;
    const targetRect = target.getBoundingClientRect();
    const tx = targetRect.left + targetRect.width / 2;
    const ty = targetRect.top + targetRect.height / 2;
    const totalBursts = Math.max(1, bursts || 1);
    const gap = gapMs == null ? 34 : gapMs;
    for(let burst = 0; burst < totalBursts; burst++){
      cells.forEach((cell, idx) => {
        const rect = cell.getBoundingClientRect();
        const light = document.createElement("span");
        light.className = "slot-bank-flow";
        light.style.left = (rect.left + rect.width / 2) + "px";
        light.style.top = (rect.top + rect.height / 2) + "px";
        light.style.setProperty("--slot-flow-x", (tx - rect.left - rect.width / 2) + "px");
        light.style.setProperty("--slot-flow-y", (ty - rect.top - rect.height / 2) + "px");
        light.style.animationDelay = ((burst * gap * 2) + (idx * gap)) + "ms";
        document.body.appendChild(light);
        light.addEventListener("animationend", () => light.remove(), { once: true });
      });
    }
  }

  function wait(ms){
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function rewardSymbol(reward){
    if(!reward || reward.kind === "miss") return "MISS";
    if(reward.kind === "bank_builder") return "BANK";
    if(reward.kind === "sponsor") return "PLEDGE";
    if(reward.kind === "choice") return "PICK";
    if(reward.kind === "reroll") return "REROLL";
    if(isJackpotReward(reward)) return "JACKPOT";
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
      const choice = snap.requires_jackpot_choice ? " Pick a jackpot from the list." : "";
      return "Bank Building paid " + money(bankDelta) + units + ". Funds moved into the Reward Reserve." + cap + choice;
    }
    if(spinRow.status === "miss" || snap.kind === "miss") return "No reward this spin: No prize";
    if(snap.kind === "bank_builder") return "Reward Reserve grew by " + money(spinRow.bank_delta_cents || snap.bank_delta_cents || 0) + ". Confirm it when you get a chance.";
    if(spinRow.status === "pending" && snap.requires_jackpot_choice) return "Jackpot hit. Pick a prize from the list.";
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
    sponsorSplitsDraft = sponsorSplitsForReward(reward);
    checked("slot-form-active", reward ? reward.active : true);
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
    const needsPrice = ["small_paid", "bank_gated", "sponsor"].includes(kind);
    const usesSponsor = kind === "sponsor";
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
    }
    setText("slot-form-subtitle", FORM_SUBTITLES[kind] || "Reward");
    if(!usesSponsor) {
      val("slot-form-sponsor", "self");
      sponsorSplitsDraft = [];
    } else if(sponsor === "__add"){
      addSponsorSplit("", remainingSponsorPercent());
      val("slot-form-sponsor", "self");
    } else if(SPONSOR_PRESETS[sponsor]){
      addSponsorSplit(SPONSOR_PRESETS[sponsor], remainingSponsorPercent());
      val("slot-form-sponsor", "self");
    }
    if(!needsPrice) val("slot-form-value", "");
    renderSponsorSplits();
    updateOddsHint();
  }

  function sponsorSplitsForReward(reward){
    if(!reward) return [];
    if(Array.isArray(reward.sponsor_splits) && reward.sponsor_splits.length){
      return reward.sponsor_splits.map(row => ({
        name: String(row.name || ""),
        percent: Math.max(0, Math.min(100, parseInt(row.percent, 10) || 0))
      })).filter(row => row.name || row.percent > 0);
    }
    if(reward.kind === "sponsor" && reward.sponsor_type && reward.sponsor_type !== "self"){
      return [{ name: SPONSOR_LABELS[reward.sponsor_type] || reward.sponsor_type, percent: 100 }];
    }
    return [];
  }

  function remainingSponsorPercent(){
    const used = sponsorSplitsDraft.reduce((sum, row) => sum + (parseInt(row.percent, 10) || 0), 0);
    return Math.max(0, Math.min(100, 100 - used)) || 100;
  }

  function addSponsorSplit(name, percent){
    sponsorSplitsDraft.push({ name: name || "", percent: Math.max(0, Math.min(100, parseInt(percent, 10) || 0)) });
    renderSponsorSplits();
  }

  function renderSponsorSplits(){
    const list = document.getElementById("slot-sponsor-split-list");
    if(!list) return;
    if(!sponsorSplitsDraft.length){
      list.innerHTML = '<div class="slot-empty">No sponsor coverage yet.</div>';
      return;
    }
    list.innerHTML = sponsorSplitsDraft.map((row, i) =>
      '<div class="slot-sponsor-split-row" data-index="' + i + '">' +
        '<input class="slot-sponsor-name" type="text" placeholder="Person name" value="' + esc(row.name || "") + '">' +
        '<input class="slot-sponsor-percent" type="number" min="0" max="100" step="1" aria-label="Sponsor percent" value="' + esc(row.percent || 0) + '">' +
        '<button class="slot-sponsor-remove" type="button" aria-label="Remove sponsor">x</button>' +
      '</div>'
    ).join("");
    list.querySelectorAll(".slot-sponsor-split-row").forEach(rowEl => {
      const idx = parseInt(rowEl.dataset.index, 10);
      const nameInput = rowEl.querySelector(".slot-sponsor-name");
      const percentInput = rowEl.querySelector(".slot-sponsor-percent");
      const removeBtn = rowEl.querySelector(".slot-sponsor-remove");
      if(nameInput) nameInput.addEventListener("input", () => { if(sponsorSplitsDraft[idx]) sponsorSplitsDraft[idx].name = nameInput.value; });
      if(percentInput) percentInput.addEventListener("input", () => { if(sponsorSplitsDraft[idx]) sponsorSplitsDraft[idx].percent = Math.max(0, Math.min(100, parseInt(percentInput.value, 10) || 0)); });
      if(removeBtn) removeBtn.addEventListener("click", () => { sponsorSplitsDraft.splice(idx, 1); renderSponsorSplits(); });
    });
  }

  function updateOddsHint(){
    const note = document.getElementById("slot-form-weight-note");
    const input = document.getElementById("slot-form-weight");
    if(!note || !input) return;
    const weight = parseInt(input.value, 10) || 0;
    const rewards = (slotState && slotState.rewards) || [];
    const total = rewards
      .filter(r => !editingId || String(r.id) !== String(editingId))
      .filter(r => r.kind !== "miss" && r.active !== false && (r.weight || 0) > 0)
      .reduce((sum, r) => sum + (Number(r.weight) || 0), 0) + weight;
    const pct = total > 0 && weight > 0 ? (weight / total) * 100 : 0;
    const pctText = pct >= 10 ? pct.toFixed(0) : pct >= 1 ? pct.toFixed(1) : pct > 0 ? pct.toFixed(2) : "0";
    note.textContent = weight ? (weight + " shares is about " + pctText + "% of the active pool.") : "0 shares keeps this out of the draw.";
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
    const valueCents = Math.round(valueDollars * 100);
    const sponsorSplits = kind === "sponsor"
      ? sponsorSplitsDraft.map(row => ({
          name: String(row.name || "").trim(),
          percent: Math.max(0, Math.min(100, parseInt(row.percent, 10) || 0))
        })).filter(row => row.name && row.percent > 0)
      : [];
    return {
      title: document.getElementById("slot-form-title").value,
      kind,
      sponsor_type: sponsorSplits.length ? "split" : "self",
      sponsor_splits: sponsorSplits,
      weight: parseInt(document.getElementById("slot-form-weight").value, 10) || 0,
      active: document.getElementById("slot-form-active").checked,
      sponsor_active: true,
      value_cents: valueCents,
      bank_delta_cents: 0,
      requires_confirmation: false,
      cooldown_days: 0,
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

  async function confirmSpin(id){
    try {
      const spinRow = await api("/api/slot/spins/" + id + "/confirm", { method: "POST" });
      const snap = spinRow.reward_snapshot || {};
      slotPlay("confirm");
      setResult("Confirmed: " + (snap.title || "Reward"));
      await loadSlots();
    } catch(e) {
      setResult(e.message);
      slotPlay("error");
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
    const details = document.getElementById("slot-bank-details");
    const sweepBtn = document.getElementById("slot-bank-sweep-btn");
    if(!btn) return;
    setText("slot-bank-balance", money(totalCents));
    setText("slot-bank-ready", money(readyCents));
    setText("slot-bank-pending", money(pendingCents));
    setText("slot-bank-total", money(totalCents));
    setText("slot-bank-month", money(monthCents) + " / " + money(monthlyGoal));
    setText("slot-bank-shortfall", money(shortfall));
    setText("slot-bank-action-label", "Unlocked total - click for details");
    btn.disabled = false;
    btn.classList.toggle("urgent", pendingCents > 0);
    btn.setAttribute("aria-expanded", bankDetailsOpen ? "true" : "false");
    btn.title = "Click to see how much is ready and how much still needs to be swept.";
    if(details) details.hidden = !bankDetailsOpen;
    if(sweepBtn){
      sweepBtn.disabled = pendingCents <= 0;
      sweepBtn.textContent = pendingCents > 0 ? "Confirm " + money(pendingCents) + " reserved" : "No reserve pending";
    }
    if(fill){
      const pct = monthlyGoal <= 0 ? 0 : Math.max(monthCents > 0 ? 8 : 0, Math.min(100, Math.round((monthCents / monthlyGoal) * 100)));
      fill.style.width = pct + "%";
    }
    if(animate && pendingCents > lastPendingBankCents) inflatePendingDeposit(pendingCents - lastPendingBankCents);
    lastPendingBankCents = pendingCents;
  }

  function togglePiggyBankDetails(){
    bankDetailsOpen = !bankDetailsOpen;
    if(bankDetailsOpen) switchSlotSection("rules");
    const details = document.getElementById("slot-bank-details");
    const btn = document.getElementById("slot-pending-deposit");
    if(details) details.hidden = !bankDetailsOpen;
    if(btn) btn.setAttribute("aria-expanded", bankDetailsOpen ? "true" : "false");
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
    if(!confirm("I transferred " + money(cents) + " into the Reward Reserve. Confirm it?")) return;
    const btn = document.getElementById("slot-pending-deposit");
    if(btn) btn.classList.add("pop");
    try {
      const result = await api("/api/slot/bank-builders/confirm", { method: "POST" });
      slotPlay("confirm");
      setResult("Swept " + money(result.confirmed_cents || cents) + " into ready reward savings.");
      lastPendingBankCents = 0;
      setTimeout(async () => {
        if(btn) btn.classList.remove("pop");
        await loadSlots();
      }, 380);
    } catch(e) {
      if(btn) btn.classList.remove("pop");
      setResult(e.message);
      slotPlay("error");
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
    document.querySelectorAll(".slot-section-tab").forEach(btn => {
      btn.addEventListener("click", () => switchSlotSection(btn.dataset.slotSection || "machine"));
    });
    const spinBtn = document.getElementById("slot-spin-btn");
    if(spinBtn) spinBtn.addEventListener("click", spin);
    const helperLever = document.getElementById("slot-helper-lever");
    if(helperLever) helperLever.addEventListener("click", spin);
    const refreshBtn = document.getElementById("slot-refresh-btn");
    if(refreshBtn) refreshBtn.addEventListener("click", loadSlots);
    const soundBtn = document.getElementById("slot-sound-toggle");
    if(soundBtn) soundBtn.addEventListener("click", toggleSlotSound);
    updateSlotSoundButton();
    const saveSettingsBtn = document.getElementById("slot-save-settings-btn");
    if(saveSettingsBtn) saveSettingsBtn.addEventListener("click", saveSettings);
    const pendingBtn = document.getElementById("slot-pending-deposit");
    if(pendingBtn) pendingBtn.addEventListener("click", togglePiggyBankDetails);
    const sweepBtn = document.getElementById("slot-bank-sweep-btn");
    if(sweepBtn) sweepBtn.addEventListener("click", popPendingDeposit);
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
    const addSponsorPersonBtn = document.getElementById("slot-add-sponsor-person");
    if(addSponsorPersonBtn) addSponsorPersonBtn.addEventListener("click", () => addSponsorSplit("", remainingSponsorPercent()));
    const weightInput = document.getElementById("slot-form-weight");
    if(weightInput) weightInput.addEventListener("input", updateOddsHint);
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
    applySlotSection();
    loadSlotPetHome();
    loadSlots();
    flushTaskCreditQueue();
    setTimeout(syncCompletedTaskCredits, 1500);
  }

  window.SlotRewards = { load: loadSlots, earnTaskCredit, queueTaskCredit, flushTaskCreditQueue, reconcileCompletedTaskCredits, syncCompletedTaskCredits, previewBankAnimationScenario, previewRewardAnimationScenario };
  document.addEventListener("slot-changed", loadSlots);
  window.addEventListener("dcc:data-ready", () => {
    setTimeout(syncCompletedTaskCredits, 250);
  });
  document.addEventListener("DOMContentLoaded", init);
})();
