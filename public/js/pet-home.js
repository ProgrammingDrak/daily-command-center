(function(){
  let state=null;
  let shareUrl=null;
  let loading=false;

  function esc(value){
    return String(value==null?"":value).replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]));
  }
  function pct(value){ return Math.max(0,Math.min(100,Number(value)||0)); }
  function api(path,opts){
    return fetch(path,opts).then(async res=>{
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(data.error||"Pet Home request failed");
      return data;
    });
  }
  function toast(message,type,duration){
    if(typeof showToast==="function")showToast(message,type||"success",duration||2400);
  }
  function petGlyph(base){
    return {sprout:"S",mossling:"M",moonpup:"P",pufflet:"F"}[base]||"S";
  }
  function accessoryGlyph(accessory){
    return {bandana:"◇",hat:"^",necklace:"o",flower:"*"}[accessory]||"";
  }
  function currentTasks(){
    try{
      return (scheduled||[]).filter(ev=>ev&&!isDeleted(ev)&&!isPushed(ev)&&!isMeeting(ev)&&ev.type!=="break"&&ev.type!=="ooo").slice(0,8);
    }catch(e){return[];}
  }
  function taskVisibility(ev){
    return (ev&&ev.publicVisibility)==="private"?"private":"public";
  }
  function findTaskBlock(ev){
    if(!ev||!window.blockStore)return null;
    if(ev._blockId){
      const direct=window.blockStore.get(ev._blockId);
      if(direct)return direct;
    }
    const blocks=window.blockStore.getByType("block");
    return blocks.find(b=>{
      const p=b.properties||{};
      return p.local_id===ev.id||b.id===ev.id;
    })||null;
  }
  async function ensureTaskBlock(ev,nextVisibility){
    const existing=findTaskBlock(ev);
    if(existing)return existing;
    if(!window.blockStore)throw new Error("BlockStore unavailable");
    const date=(typeof viewDate!=="undefined"&&viewDate)||window.blockStore.getCurrentDate()||((window.__DCC_STATE__||{}).date);
    const props={
      local_id:ev.id,
      kind:"task",
      title:ev.title,
      duration:typeof dur==="function"?dur(ev):(ev.durMin||30),
      start:ev.start||"00:00",
      end:ev.end||"",
      priority:ev.priority||"Medium",
      source:ev.source||"manual",
      detail:ev.detail||"",
      publicVisibility:nextVisibility||"public"
    };
    const created=await window.blockStore.createBlock("block",props,{date});
    ev._blockId=created.id;
    return created;
  }
  async function toggleTaskPrivacy(ev){
    if(!ev||!ev.id)return;
    const next=taskVisibility(ev)==="private"?"public":"private";
    try{
      const block=await ensureTaskBlock(ev,next);
      const props={...(block.properties||{}),publicVisibility:next};
      await window.blockStore.updateBlock(block.id,props);
      ev.publicVisibility=next;
      toast(next==="private"?"Hidden from Pet Home share":"Visible on Pet Home share","success",2200);
      if(typeof render==="function")render();
      renderPetHome();
    }catch(e){
      toast("Privacy update failed: "+e.message,"error");
    }
  }
  function privacyChip(ev){
    const visibility=taskVisibility(ev);
    const label=visibility==="private"?"Private":"Public";
    return '<button class="pet-privacy-toggle '+visibility+'" type="button" data-pet-privacy-id="'+esc(ev.id)+'" title="Toggle Pet Home sharing">'+label+'</button>';
  }
  async function load(){
    if(loading)return state;
    loading=true;
    try{
      const data=await api("/api/pet-home/state");
      state=data;
      shareUrl=data.shareUrl||null;
      updateBadge();
      return state;
    }finally{loading=false;}
  }
  function updateBadge(){
    const badge=document.getElementById("pet-home-badge");
    if(!badge||!state)return;
    const pending=(state.suggestions||[]).filter(s=>s.status==="pending").length;
    badge.textContent=String(pending);
    badge.style.display=pending?"inline-block":"none";
  }
  function syncInputs(home){
    const h=home||state&&state.home;if(!h)return;
    const pet=h.pet||{};
    const set=(id,val)=>{const el=document.getElementById(id);if(el)el.value=val||"";};
    set("pet-name-input",pet.name);
    set("pet-base-select",pet.base);
    set("pet-color-input",pet.color||"#f2b56b");
    set("pet-accessory-select",pet.accessory||"none");
  }
  function renderAvatar(home){
    const avatar=document.getElementById("pet-avatar");
    if(!avatar||!home)return;
    const pet=home.pet||{};
    avatar.style.setProperty("--pet-color",pet.color||"#f2b56b");
    avatar.dataset.base=pet.base||"sprout";
    avatar.innerHTML='<span class="pet-ears"></span><strong>'+petGlyph(pet.base)+'</strong><span class="pet-face"></span><em>'+accessoryGlyph(pet.accessory)+'</em>';
  }
  function renderBoard(){
    const list=document.getElementById("pet-board-list");
    if(!list)return;
    const tasks=currentTasks().filter(ev=>taskVisibility(ev)!=="private");
    if(!tasks.length){list.innerHTML='<div class="pet-empty">No public tasks on the board.</div>';return;}
    list.innerHTML=tasks.map(ev=>'<div class="pet-board-task '+(typeof isDone==="function"&&isDone(ev)?"done":"")+'"><span></span>'+esc(ev.title)+'</div>').join("");
  }
  function renderDecor(home){
    const list=document.getElementById("pet-decor-list");
    if(!list||!home)return;
    const unlocked=new Set((home.home&&home.home.unlockedDecor)||[]);
    const equipped=new Set((home.home&&home.home.equippedDecor)||[]);
    const currency=home.decorCurrency||0;
    list.innerHTML=(home.decorCatalog||[]).map(item=>{
      const isUnlocked=unlocked.has(item.id)||item.cost===0;
      const isEquipped=equipped.has(item.id);
      const canUnlock=!isUnlocked&&currency>=item.cost;
      return '<div class="pet-decor-row '+(isEquipped?"equipped":"")+'">'+
        '<div><strong>'+esc(item.name)+'</strong><span>'+esc(item.zone)+' · '+item.cost+' treats</span></div>'+
        (isUnlocked?'<button class="pet-mini" data-decor-equip="'+esc(item.id)+'">'+(isEquipped?"Equipped":"Equip")+'</button>':'<button class="pet-mini" '+(canUnlock?'data-decor-unlock="'+esc(item.id)+'"':"disabled")+'>Unlock</button>')+
      '</div>';
    }).join("");
  }
  function renderSuggestions(){
    const wrap=document.getElementById("pet-suggestions");
    const count=document.getElementById("pet-suggestion-count");
    if(!wrap||!state)return;
    const pending=(state.suggestions||[]).filter(s=>s.status==="pending");
    if(count)count.textContent=pending.length+" pending";
    if(!pending.length){wrap.innerHTML='<div class="pet-empty">No visitor suggestions waiting.</div>';return;}
    wrap.innerHTML=pending.map(s=>
      '<div class="pet-suggestion">'+
        '<div><strong>'+esc(s.title)+'</strong><span>from '+esc(s.visitor_name||s.visitorName||"Guest")+'</span>'+(s.note?'<p>'+esc(s.note)+'</p>':"")+'</div>'+
        '<div class="pet-suggestion-actions"><button class="pet-mini primary" data-suggestion-approve="'+s.id+'">Approve</button><button class="pet-mini" data-suggestion-dismiss="'+s.id+'">Dismiss</button></div>'+
      '</div>'
    ).join("");
  }
  function renderEvents(){
    const wrap=document.getElementById("pet-events");
    if(!wrap||!state)return;
    const events=state.events||[];
    if(!events.length){wrap.innerHTML='<div class="pet-empty">Encouragement and pet moments will appear here.</div>';return;}
    wrap.innerHTML=events.slice(0,12).map(ev=>{
      const actor=ev.actor_name?esc(ev.actor_name)+" · ":"";
      const label=ev.event_type==="encouragement"?"Cheer":ev.event_type==="task_feed"?"Fed":"Update";
      return '<div class="pet-event"><span>'+label+'</span><strong>'+actor+esc(ev.message||"Pet home updated")+'</strong></div>';
    }).join("");
  }
  function renderCare(home){
    if(!home)return;
    const food=pct(home.foodLevel),mood=pct(home.moodLevel);
    const foodFill=document.getElementById("pet-food-fill"),moodFill=document.getElementById("pet-mood-fill");
    if(foodFill)foodFill.style.width=food+"%";
    if(moodFill)moodFill.style.width=mood+"%";
    const foodLabel=document.getElementById("pet-food-label"),moodLabel=document.getElementById("pet-mood-label"),cur=document.getElementById("pet-decor-currency");
    if(foodLabel)foodLabel.textContent=food+"%";
    if(moodLabel)moodLabel.textContent=mood+"%";
    if(cur)cur.textContent=String(home.decorCurrency||0);
  }
  function renderZones(home){
    const equipped=new Set(((home||{}).home||{}).equippedDecor||[]);
    const garden=document.getElementById("pet-garden-zone"),special=document.getElementById("pet-special-zone");
    if(garden)garden.textContent=equipped.has("tiny-fountain")?"Fountain garden":equipped.has("flower-box")?"Flower garden":equipped.has("garden-pot")?"Tiny garden":"";
    if(special)special.textContent=equipped.has("slot-corner")?"Slot corner":"";
  }
  async function renderPetHome(){
    if(!state)await load();
    if(!state)return;
    const home=state.home;
    syncInputs(home);
    renderAvatar(home);
    renderCare(home);
    renderBoard();
    renderDecor(home);
    renderZones(home);
    renderSuggestions();
    renderEvents();
    updateBadge();
  }
  async function saveCustomize(){
    const pet={
      name:document.getElementById("pet-name-input")?.value||"Mochi",
      base:document.getElementById("pet-base-select")?.value||"sprout",
      color:document.getElementById("pet-color-input")?.value||"#f2b56b",
      accessory:document.getElementById("pet-accessory-select")?.value||"none"
    };
    state=await api("/api/pet-home/state",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({pet})});
    shareUrl=state.shareUrl||shareUrl;
    toast("Pet home saved","success",2200);
    renderPetHome();
  }
  async function enableShare(){
    const data=await api("/api/pet-home/share",{method:"POST"});
    shareUrl=data.shareUrl;
    await load();
    toast("Pet Home share link enabled","success",2400);
  }
  async function rotateShare(){
    const data=await api("/api/pet-home/share/rotate",{method:"POST"});
    shareUrl=data.shareUrl;
    await load();
    toast("Pet Home link rotated","success",2400);
  }
  async function copyShare(){
    if(!shareUrl)await enableShare();
    if(navigator.clipboard&&shareUrl)await navigator.clipboard.writeText(shareUrl);
    toast("Pet Home link copied","success",2200);
  }
  async function awardTask(ev,opts){
    if(!ev||!ev.id)return;
    const payload=window.TaskPoints&&typeof window.TaskPoints.buildPayload==="function"?window.TaskPoints.buildPayload(ev,{}):{task_id:ev.id,title:ev.title,duration_minutes:30};
    const scoring=window.TaskPoints&&typeof window.TaskPoints.estimate==="function"?window.TaskPoints.estimate(payload):{awardPoints:8};
    // Explicit override (subtask slice / parent completion bonus) wins over the
    // duration-based estimate; the server clamps it (1–80).
    const _ov=opts&&opts.awardPoints;
    const award=(_ov!=null&&Number.isFinite(Number(_ov))&&Number(_ov)>0)?Math.round(Number(_ov)):(scoring.awardPoints||8);
    const result=await api("/api/pet-home/feed-task",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({...payload,task_id:ev.id,title:ev.title,sourceDate:opts&&opts.sourceDate,completedAt:opts&&opts.completedAt,awardPoints:award})
    }).catch(()=>null);
    if(result&&result.home){
      if(state)state.home=result.home;
      renderPetHome();
    }
  }
  async function approveSuggestion(id){
    await api("/api/pet-home/suggestions/"+id+"/approve",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({})});
    state=await api("/api/pet-home/state");
    toast("Suggestion added as a task","success",2400);
    renderPetHome();
    if(typeof reloadPersistedEdits==="function")reloadPersistedEdits();
    if(typeof render==="function")render();
  }
  async function dismissSuggestion(id){
    await api("/api/pet-home/suggestions/"+id+"/dismiss",{method:"POST"});
    state=await api("/api/pet-home/state");
    renderPetHome();
  }
  async function unlockDecor(id){
    if(!state||!state.home)return;
    const catalog=state.home.decorCatalog||[];
    const item=catalog.find(d=>d.id===id);
    if(!item)return;
    const home=state.home.home||{};
    const unlocked=new Set(home.unlockedDecor||[]);
    if(unlocked.has(id))return;
    const currency=Number(state.home.decorCurrency)||0;
    if(currency<item.cost){toast("Not enough decor treats yet","error");return;}
    unlocked.add(id);
    const equipped=new Set(home.equippedDecor||[]);
    equipped.add(id);
    state=await api("/api/pet-home/state",{
      method:"PATCH",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({home:{...home,unlockedDecor:[...unlocked],equippedDecor:[...equipped]},decorCurrency:currency-item.cost})
    });
    toast(item.name+" unlocked","success");
    renderPetHome();
  }
  async function equipDecor(id){
    if(!state||!state.home)return;
    const home=state.home.home||{};
    const equipped=new Set(home.equippedDecor||[]);
    if(equipped.has(id))equipped.delete(id);else equipped.add(id);
    state=await api("/api/pet-home/state",{
      method:"PATCH",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({home:{...home,equippedDecor:[...equipped]}})
    });
    renderPetHome();
  }
  function bind(){
    document.getElementById("pet-save-customize")?.addEventListener("click",()=>saveCustomize().catch(e=>toast(e.message,"error")));
    document.getElementById("pet-share-enable")?.addEventListener("click",()=>enableShare().catch(e=>toast(e.message,"error")));
    document.getElementById("pet-share-copy")?.addEventListener("click",()=>copyShare().catch(e=>toast(e.message,"error")));
    document.getElementById("pet-share-rotate")?.addEventListener("click",()=>rotateShare().catch(e=>toast(e.message,"error")));
    document.addEventListener("click",e=>{
      const privacy=e.target.closest("[data-pet-privacy-id]");
      if(privacy){
        e.stopPropagation();
        const id=privacy.dataset.petPrivacyId;
        const ev=(scheduled||[]).find(t=>t.id===id);
        toggleTaskPrivacy(ev);
        return;
      }
      const approve=e.target.closest("[data-suggestion-approve]");
      if(approve){approveSuggestion(approve.dataset.suggestionApprove).catch(err=>toast(err.message,"error"));return;}
      const dismiss=e.target.closest("[data-suggestion-dismiss]");
      if(dismiss){dismissSuggestion(dismiss.dataset.suggestionDismiss).catch(err=>toast(err.message,"error"));return;}
      const unlock=e.target.closest("[data-decor-unlock]");
      if(unlock){unlockDecor(unlock.dataset.decorUnlock).catch(err=>toast(err.message,"error"));return;}
      const equip=e.target.closest("[data-decor-equip]");
      if(equip){equipDecor(equip.dataset.decorEquip).catch(err=>toast(err.message,"error"));return;}
    });
  }
  bind();
  load().then(renderPetHome).catch(()=>{});
  window.PetHome={render:renderPetHome,awardTask,toggleTaskPrivacy,privacyChip};
})();
