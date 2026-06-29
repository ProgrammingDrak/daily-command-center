// ======== BUDGET TANK ========
// A vertical "fill the tank" budget visualizer. Income pours in from the bottom
// and rises; necessities at the base get funded first, then discretionary
// categories above the waterline progressively "unlock" as the level climbs.
//
// Phase 0 (this file): purely client-side, seeded sample data, persisted to
// localStorage. Phase 1+ (later): swap loadConfig/saveConfig for the real
// banking-feed / BlockStore source. Keep all money in CENTS to match fmtMoney().
(function(){
  const KEY = "pa-budget-config";

  // ---- seeded sample budget (cents) -------------------------------------
  const DEFAULT_CONFIG = {
    income: 310000,
    necessities: [
      { id:"rent",      name:"Rent / Housing",   amount:150000, color:"#22c55e" },
      { id:"groceries", name:"Groceries",        amount:50000,  color:"#10b981" },
      { id:"utils",     name:"Utilities & Phone",amount:30000,  color:"#14b8a6" },
      { id:"transport", name:"Transportation",   amount:25000,  color:"#06b6d4" },
      { id:"insurance", name:"Insurance",         amount:20000,  color:"#0ea5e9" }
    ],
    discretionary: [
      { id:"savings",  name:"Emergency Savings", amount:40000, color:"#6366f1" },
      { id:"dining",   name:"Restaurants",       amount:25000, color:"#f59e0b" },
      { id:"fun",      name:"Entertainment",     amount:20000, color:"#a78bfa" },
      { id:"shopping", name:"Shopping",          amount:20000, color:"#ec4899" },
      { id:"gifts",    name:"Gifts",             amount:10000, color:"#f43f5e" }
    ]
  };

  let config = null;
  let editMode = false;
  let saveTimer = null;

  // ---- persistence ------------------------------------------------------
  function loadConfig(){
    try{
      const raw = JSON.parse(localStorage.getItem(KEY) || "null");
      if(raw && Array.isArray(raw.necessities) && Array.isArray(raw.discretionary)) return raw;
    }catch(e){}
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  function saveConfig(){
    clearTimeout(saveTimer);
    saveTimer = setTimeout(()=>{
      try{ localStorage.setItem(KEY, JSON.stringify(config)); }catch(e){}
    }, 250);
  }

  // ---- helpers ----------------------------------------------------------
  function esc(s){
    return String(s==null?"":s).replace(/[&<>"']/g, c=>({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }
  function bands(){ return config.necessities.concat(config.discretionary); }
  function total(){ return bands().reduce((s,b)=>s + (b.amount||0), 0); }
  function necessitiesTotal(){ return config.necessities.reduce((s,b)=>s+(b.amount||0),0); }

  // Funded amount that lands in a band given its [start,end] position in the
  // bottom-up fill order and the current income level.
  function fundedIn(start, amount, income){
    return Math.max(0, Math.min(income - start, amount));
  }

  // ---- markup -----------------------------------------------------------
  function zoneMarkup(){
    // Rendered top -> bottom, so the highest-priority necessity sits at the
    // bottom of the tank. column-reverse in CSS flips fill order to visual order.
    const list = bands();
    return list.map((b, i)=>{
      const group = i < config.necessities.length ? "nec" : "disc";
      return '<div class="bt-zone bt-zone--'+group+'" data-id="'+esc(b.id)+'" '+
               'style="flex-grow:'+b.amount+';--zc:'+esc(b.color)+'">'+
               '<div class="bt-zone-bar"></div>'+
               '<div class="bt-zone-label">'+
                 '<span class="bt-zone-name">'+esc(b.name)+'</span>'+
                 '<span class="bt-zone-status" data-role="status"></span>'+
               '</div>'+
             '</div>';
    }).join("");
  }

  function legendRow(b, group){
    return '<div class="bt-row" data-id="'+esc(b.id)+'" data-group="'+group+'">'+
             '<span class="bt-row-dot" style="background:'+esc(b.color)+'"></span>'+
             '<span class="bt-row-name">'+esc(b.name)+'</span>'+
             '<span class="bt-row-amt" data-role="amt" title="Click to edit">'+fmtMoney(b.amount)+'</span>'+
             '<span class="bt-row-fund" data-role="fund"></span>'+
             (editMode ? '<button class="bt-row-del" data-act="del" title="Remove">&times;</button>' : '')+
           '</div>';
  }

  function legendGroup(title, key, sub){
    const rows = config[key].map(b=>legendRow(b, key)).join("");
    return '<div class="bt-group">'+
             '<div class="bt-group-head"><span class="bt-group-title">'+esc(title)+'</span>'+
               '<span class="bt-group-sub">'+esc(sub)+'</span></div>'+
             rows+
             (editMode ? '<button class="bt-add" data-act="add" data-group="'+key+'">+ add category</button>' : '')+
           '</div>';
  }

  function render(){
    const root = document.getElementById("budget-root");
    if(!root) return;
    if(!config) config = loadConfig();
    const t = total();
    const maxIncome = Math.max(Math.round(t * 1.4), t + 50000);

    root.innerHTML =
      '<div class="bt-wrap">'+
        '<div class="bt-head">'+
          '<h2 class="bt-title">Budget Tank</h2>'+
          '<p class="bt-sub">Money pours in from the bottom. Necessities fill first — '+
            'discretionary categories unlock as the level rises.</p>'+
        '</div>'+

        '<div class="bt-controls">'+
          '<div class="bt-income">'+
            '<label class="bt-income-label">Money coming in</label>'+
            '<div class="bt-income-val" data-role="income">'+fmtMoney(config.income)+'</div>'+
            '<input type="range" class="bt-income-range" min="0" max="'+maxIncome+'" '+
                   'step="1000" value="'+config.income+'">'+
          '</div>'+
          '<div class="bt-chips" data-role="chips"></div>'+
          '<button class="bt-edit-btn" data-act="toggle-edit">'+(editMode?"Done":"Edit")+'</button>'+
        '</div>'+

        '<div class="bt-main">'+
          '<div class="bt-tank-col">'+
            '<div class="bt-tank">'+
              '<div class="bt-zones">'+zoneMarkup()+'</div>'+
              '<div class="bt-divider" data-role="divider"><span>essentials covered ↑ discretionary</span></div>'+
              '<div class="bt-mask" data-role="mask"></div>'+
              '<div class="bt-waterline" data-role="waterline"><span class="bt-water-amt" data-role="water-amt"></span></div>'+
              '<div class="bt-surplus" data-role="surplus"></div>'+
            '</div>'+
          '</div>'+
          '<div class="bt-breakdown">'+
            legendGroup("Necessities", "necessities", "funded first, bottom up")+
            legendGroup("Discretionary", "discretionary", "unlocks in priority order")+
          '</div>'+
        '</div>'+
      '</div>';

    update();
  }

  // ---- dynamic update (cheap; runs on every income tick) ----------------
  function update(){
    const root = document.getElementById("budget-root");
    if(!root) return;
    const t = total() || 1;
    const income = config.income;
    const fillPct = Math.min(income / t, 1) * 100;
    const necTop = necessitiesTotal();

    // waterline + mask (the rising liquid surface)
    const mask = root.querySelector('[data-role="mask"]');
    const water = root.querySelector('[data-role="waterline"]');
    if(mask) mask.style.height = (100 - fillPct) + "%";
    if(water) water.style.bottom = fillPct + "%";
    const waterAmt = root.querySelector('[data-role="water-amt"]');
    if(waterAmt) waterAmt.textContent = fmtMoney(income);

    // divider line at the necessities/discretionary boundary
    const divider = root.querySelector('[data-role="divider"]');
    if(divider) divider.style.bottom = (necTop / t * 100) + "%";

    // per-band status (compute in fill order)
    let start = 0;
    let discUnlocked = 0;
    const allBands = bands();
    allBands.forEach((b, i)=>{
      const funded = fundedIn(start, b.amount, income);
      const frac = b.amount > 0 ? funded / b.amount : 1;
      const isDisc = i >= config.necessities.length;
      let cls, label;
      if(frac >= 1){ cls="bt--funded"; label="funded"; if(isDisc) discUnlocked++; }
      else if(frac > 0){ cls="bt--filling"; label=Math.round(frac*100)+"% · "+fmtMoney(funded); if(isDisc) discUnlocked++; }
      else { cls="bt--locked"; label="locked · needs "+fmtMoney(start - income); }

      const zone = root.querySelector('.bt-zone[data-id="'+CSS.escape(b.id)+'"]');
      if(zone){
        zone.classList.remove("bt--funded","bt--filling","bt--locked");
        zone.classList.add(cls);
        const st = zone.querySelector('[data-role="status"]');
        if(st) st.textContent = frac>=1 ? "✓" : (frac>0 ? Math.round(frac*100)+"%" : "");
      }
      const row = root.querySelector('.bt-row[data-id="'+CSS.escape(b.id)+'"]');
      if(row){
        row.classList.remove("bt--funded","bt--filling","bt--locked");
        row.classList.add(cls);
        const fund = row.querySelector('[data-role="fund"]');
        if(fund) fund.textContent = label;
      }
      start += b.amount;
    });

    // summary chips
    const necFunded = Math.min(income, necTop);
    const necCovered = income >= necTop;
    const surplus = Math.max(0, income - t);
    const chips = root.querySelector('[data-role="chips"]');
    if(chips){
      chips.innerHTML =
        chip(necCovered ? "ok" : "warn",
             necCovered ? "Essentials covered" : "Essentials short " + fmtMoney(necTop - necFunded))+
        chip("info", "Discretionary " + discUnlocked + " / " + config.discretionary.length + " unlocked")+
        (surplus > 0 ? chip("ok", "Surplus " + fmtMoney(surplus)) : "");
    }
    const surplusEl = root.querySelector('[data-role="surplus"]');
    if(surplusEl){
      surplusEl.textContent = surplus > 0 ? "+" + fmtMoney(surplus) + " surplus" : "";
      surplusEl.style.opacity = surplus > 0 ? "1" : "0";
    }
  }

  function chip(kind, text){
    return '<span class="bt-chip bt-chip--'+kind+'">'+esc(text)+'</span>';
  }

  // ---- editing ----------------------------------------------------------
  function findBand(id){
    return config.necessities.find(b=>b.id===id) || config.discretionary.find(b=>b.id===id);
  }
  function editAmount(id, cell){
    const b = findBand(id);
    if(!b) return;
    const cur = (b.amount/100).toFixed(2);
    const next = prompt("Monthly amount for “"+b.name+"” ($):", cur);
    if(next == null) return;
    const cents = Math.round(parseFloat(next.replace(/[^0-9.]/g,"")) * 100);
    if(isFinite(cents) && cents >= 0){ b.amount = cents; saveConfig(); render(); }
  }
  function addCategory(group){
    const name = prompt("New "+(group==="necessities"?"necessity":"discretionary")+" category name:");
    if(!name) return;
    const amt = prompt("Monthly amount ($):", "100");
    const cents = Math.round(parseFloat((amt||"0").replace(/[^0-9.]/g,"")) * 100) || 0;
    const palette = group==="necessities"
      ? ["#22c55e","#10b981","#14b8a6","#06b6d4","#0ea5e9","#0284c7"]
      : ["#6366f1","#f59e0b","#a78bfa","#ec4899","#f43f5e","#fb923c"];
    const color = palette[config[group].length % palette.length];
    config[group].push({ id: group+"-"+Date.now().toString(36), name: name.trim(), amount: cents, color });
    saveConfig(); render();
  }
  function delCategory(id){
    ["necessities","discretionary"].forEach(k=>{
      config[k] = config[k].filter(b=>b.id!==id);
    });
    saveConfig(); render();
  }

  // ---- event wiring (delegated on root, bound once) ---------------------
  function bind(){
    const root = document.getElementById("budget-root");
    if(!root || root.dataset.bound) return;
    root.dataset.bound = "1";

    root.addEventListener("input", e=>{
      if(e.target.classList.contains("bt-income-range")){
        config.income = parseInt(e.target.value, 10) || 0;
        const v = root.querySelector('[data-role="income"]');
        if(v) v.textContent = fmtMoney(config.income);
        update();
        saveConfig();
      }
    });

    root.addEventListener("click", e=>{
      const act = e.target.dataset.act;
      if(act === "toggle-edit"){ editMode = !editMode; render(); return; }
      if(act === "add"){ addCategory(e.target.dataset.group); return; }
      if(act === "del"){
        const row = e.target.closest(".bt-row");
        if(row) delCategory(row.dataset.id);
        return;
      }
      if(e.target.dataset.role === "amt"){
        const row = e.target.closest(".bt-row");
        if(row) editAmount(row.dataset.id, e.target);
      }
    });
  }

  // ---- public entry -----------------------------------------------------
  function renderBudget(){
    if(!config) config = loadConfig();
    render();
    bind();
  }

  window.renderBudget = renderBudget;
  window.Budget = { render: renderBudget, reset: function(){ localStorage.removeItem(KEY); config = loadConfig(); render(); } };
})();
