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
  let slotPetHome = null;
  let slotPetReactionTimer = null;
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
        (pending && !bankBuilderPending ? '<button class="slot-mini primary slot-confirm" data-id="' + s.id + '">Confirm</button>' : '<span class="slot-status ' + (miss ? 'miss' : '') + '">' + esc(bankBuilderPending ? "reserve pending" : (miss ? "no prize" : s.status)) + '</span>') +
      '</div>';
    }).join("");
    el.querySelectorAll(".slot-confirm").forEach(btn => btn.addEventListener("click", () => confirmSpin(btn.dataset.id)));
  }

  function findReward(id){
    return (slotState && slotState.rewards || []).find(r => String(r.id) === String(id));
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
      if((spinRow.bank_delta_cents || 0) > 0) {
        await animateBankPayout(spinRow, snap, spinRow.bank_delta_cents || 0);
        if(hasLoadedSpin(spinRow.id)) inflatePendingDeposit(spinRow.bank_delta_cents || 0);
        else addPendingDeposit(spinRow.bank_delta_cents || 0);
      }
      highlightWinningCells(spinRow, snap);
      setResult(resultText(spinRow, snap));
      if((spinRow.bank_delta_cents || 0) > 0) {
        slotPlay("win");
        slotPetReact("happy", "Bank hit!", 2400);
      } else if(spinRow.status === "miss" || snap.kind === "miss") {
        slotPlay("miss");
        slotPetReact("sad", "Almost.", 2100);
      } else if(spinRow.status === "pending") {
        slotPlay("pending");
        slotPetReact("happy", "Prize waiting.", 2300);
      } else {
        slotPlay("win");
        slotPetReact("happy", "Nice pull.", 2300);
      }
      isSpinning = false;
      await loadSlots();
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
    slotPlay("bankLine");
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
      return "Bank Building paid " + money(bankDelta) + units + ". Funds moved into the Reward Reserve." + cap;
    }
    if(spinRow.status === "miss" || snap.kind === "miss") return "No reward this spin: No prize";
    if(snap.kind === "bank_builder") return "Reward Reserve grew by " + money(spinRow.bank_delta_cents || snap.bank_delta_cents || 0) + ". Confirm it when you get a chance.";
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

  window.SlotRewards = { load: loadSlots, earnTaskCredit, queueTaskCredit, flushTaskCreditQueue, reconcileCompletedTaskCredits, syncCompletedTaskCredits };
  document.addEventListener("slot-changed", loadSlots);
  window.addEventListener("dcc:data-ready", () => {
    setTimeout(syncCompletedTaskCredits, 250);
  });
  document.addEventListener("DOMContentLoaded", init);
})();
