// ======== PRESET TASK GROUPS + MENUS ========
// Preset task groups are reusable batches of tasks that drop onto a day in one
// move. A group item is either a fixed task or a PLACEHOLDER that draws from one
// or more user-defined "menus". Menus are named pools; a Repeat Responsibility
// records membership via properties.menus[] (menu block ids). When a group is
// added to a day, each placeholder lands as a placeholder_task block; clicking
// it on the itinerary opens a swap menu of matching responsibilities.
// Mirrors public/js/responsibilities.js conventions.
(function(){
  let _groups = [];
  let _menus = [];
  let _editItems = [];          // working item list inside the group modal
  let _editGroupId = null;
  let _expanded = new Set();
  let _swapBlockId = null;

  function esc(s){
    if(s==null)return "";
    return (typeof escHtml==="function")?escHtml(String(s)):String(s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function uid(prefix){ return prefix+"-"+Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4); }
  async function errMsg(res){
    try{ const d=await res.clone().json(); return d.error||d.message||res.statusText; }catch(e){}
    try{ return (await res.text())||res.statusText; }catch(e){ return res.statusText; }
  }
  async function api(method,url,body){
    const res=await fetch(url,{method,headers:{"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined});
    if(!res.ok)throw new Error(await errMsg(res));
    return res.status===204?null:res.json();
  }
  function toast(msg,kind){ if(typeof showToast==="function")showToast(msg,kind||"success"); }
  function viewDateStr(){
    if(typeof viewDate!=="undefined"&&viewDate)return viewDate;
    return (window.__DCC_STATE__&&window.__DCC_STATE__.date)||null;
  }
  async function refreshSchedule(){
    if(typeof window.refreshScheduleAfterResponsibilityChange==="function"){
      await window.refreshScheduleAfterResponsibilityChange();
    }
  }

  // ──────────── Menus ────────────
  async function loadTaskMenus(){
    try{
      const data=await api("GET","/api/task-menus");
      _menus=(data&&data.items)||[];
    }catch(e){ console.warn("[task-groups] loadTaskMenus failed",e); _menus=[]; }
    renderMenuManager();
    refreshRespMenuField();
    return _menus;
  }
  function getTaskMenus(){ return _menus.map(m=>({id:m.id,title:(m.properties||{}).title||"(untitled)"})); }
  function menuTitle(id){ const m=_menus.find(x=>x.id===id); return m?((m.properties||{}).title||"(untitled)"):"(deleted menu)"; }

  function renderMenuManager(){
    const mount=document.getElementById("task-menu-list");
    if(!mount)return;
    if(!_menus.length){ mount.innerHTML='<div class="delegated-empty">No menus yet. Create one below.</div>'; return; }
    mount.innerHTML=_menus.map(m=>{
      const p=m.properties||{};
      return '<div class="tg-menu-manage-row" data-id="'+esc(m.id)+'">'+
        '<input type="text" class="delegated-modal-input tg-menu-rename" value="'+esc(p.title||"")+'" maxlength="80" />'+
        '<button type="button" class="secondary" data-menu-act="rename">Rename</button>'+
        '<button type="button" class="danger" data-menu-act="delete">Delete</button>'+
      '</div>';
    }).join("");
    mount.querySelectorAll("[data-menu-act]").forEach(btn=>{
      btn.addEventListener("click",async()=>{
        const row=btn.closest(".tg-menu-manage-row"); const id=row&&row.dataset.id; if(!id)return;
        try{
          if(btn.dataset.menuAct==="rename"){
            const title=(row.querySelector(".tg-menu-rename").value||"").trim();
            if(!title)return;
            await api("PATCH","/api/task-menus/"+encodeURIComponent(id),{properties:{title}});
            await loadTaskMenus(); renderGroupItems(); toast("Menu renamed");
          }else if(btn.dataset.menuAct==="delete"){
            if(!window.confirm('Delete menu "'+menuTitle(id)+'"? It will be removed from all tasks and placeholders.'))return;
            await api("DELETE","/api/task-menus/"+encodeURIComponent(id));
            await loadTaskMenus(); await loadTaskGroups();
            if(typeof window.loadResponsibilities==="function")window.loadResponsibilities();
            renderGroupItems(); toast("Menu deleted");
          }
        }catch(e){ toast("Menu action failed: "+(e.message||e),"error"); }
      });
    });
  }
  async function createMenu(title){
    const t=String(title||"").trim(); if(!t)return null;
    const created=await api("POST","/api/task-menus",{properties:{title:t}});
    await loadTaskMenus();
    return created;
  }
  function openMenuManager(){ const o=document.getElementById("task-menu-modal-overlay"); if(o){renderMenuManager();o.classList.add("open");} }
  function closeMenuManager(){ const o=document.getElementById("task-menu-modal-overlay"); if(o)o.classList.remove("open"); }

  // Checkbox group used both in the placeholder editor and the responsibility modal.
  function menuCheckboxesHtml(selectedIds){
    const sel=new Set(selectedIds||[]);
    if(!_menus.length)return '<div class="tg-menu-empty">No menus yet. Use "Manage menus" to create one.</div>';
    return _menus.map(m=>{
      const id=m.id, p=m.properties||{};
      return '<label class="tg-menu-chip"><input type="checkbox" value="'+esc(id)+'"'+(sel.has(id)?" checked":"")+">"+
        "<span>"+esc(p.title||"(untitled)")+"</span></label>";
    }).join("");
  }

  // ──────────── Groups: sidebar ────────────
  async function loadTaskGroups(){
    try{
      const data=await api("GET","/api/task-groups");
      _groups=(data&&data.items)||[];
    }catch(e){ console.warn("[task-groups] loadTaskGroups failed",e); _groups=[]; }
    renderTaskGroupsSidebar();
    return _groups;
  }
  function activeGroups(){ return _groups.filter(g=>(g.properties||{}).status!=="archived"); }

  function renderTaskGroupsSidebar(){
    const mount=document.getElementById("task-groups-list");
    const groups=activeGroups();
    const badge=document.getElementById("task-groups-section-count");
    if(badge){ badge.textContent=groups.length; badge.style.display=groups.length?"":"none"; }
    if(typeof _updateTaskMenusBadge==="function")_updateTaskMenusBadge();
    if(!mount)return;
    if(!groups.length){ mount.innerHTML='<div class="delegated-empty">No preset groups yet. Create one with + New.</div>'; return; }
    mount.innerHTML=groups.map(g=>{
      const p=g.properties||{};
      const items=Array.isArray(p.items)?p.items:[];
      const ph=items.filter(i=>i&&i.isPlaceholder).length;
      const expanded=_expanded.has(g.id);
      return '<div class="repeat-resp-card task-group-card'+(expanded?' expanded':'')+'" draggable="true" data-id="'+esc(g.id)+'">'+
        '<div class="repeat-resp-main" role="button" tabindex="0" data-act="toggle" aria-expanded="'+(expanded?"true":"false")+'">'+
          '<div class="repeat-resp-title-row"><div class="repeat-resp-title">'+esc(p.title||"(untitled)")+'</div></div>'+
          '<div class="repeat-resp-meta"><span>'+items.length+' task'+(items.length===1?"":"s")+'</span>'+(ph?'<span>'+ph+' placeholder'+(ph===1?"":"s")+'</span>':"")+'</div>'+
          (expanded?'<div class="repeat-resp-subtasks">'+items.slice(0,8).map(it=>'<span>'+esc(it.isPlaceholder?("◇ "+(it.label||"Placeholder")):it.title)+'</span>').join("")+(items.length>8?'<span>+'+(items.length-8)+'</span>':"")+'</div>':"")+
        '</div>'+
        '<div class="repeat-resp-actions">'+
          '<button type="button" data-act="add">Add to day</button>'+
          (expanded?'<button type="button" data-act="edit">Edit</button><button type="button" class="danger" data-act="remove">Remove</button>':"")+
        '</div>'+
      '</div>';
    }).join("");
    mount.querySelectorAll(".task-group-card").forEach(card=>{
      const id=card.dataset.id;
      card.addEventListener("dragstart",e=>{ window._dragFromTaskGroup=id; if(e.dataTransfer){e.dataTransfer.effectAllowed="copy";e.dataTransfer.setData("text/plain","task-group:"+id);} });
      card.addEventListener("dragend",()=>{ window._dragFromTaskGroup=null; });
    });
    mount.querySelectorAll(".task-group-card [data-act]").forEach(btn=>{
      btn.addEventListener("click",e=>{
        e.stopPropagation();
        const card=btn.closest(".task-group-card"); const id=card&&card.dataset.id; if(!id)return;
        if(btn.dataset.act==="toggle"){ _expanded.has(id)?_expanded.delete(id):_expanded.add(id); renderTaskGroupsSidebar(); return; }
        handleGroupAction(id,btn.dataset.act);
      });
      if(btn.dataset.act==="toggle")btn.addEventListener("keydown",e=>{ if(e.key==="Enter"||e.key===" "){e.preventDefault();btn.click();} });
    });
  }

  async function handleGroupAction(id,act){
    const group=_groups.find(g=>g.id===id); if(!group)return;
    try{
      if(act==="add"){
        await addGroupToDay(id);
      }else if(act==="edit"){
        openTaskGroupModal(id);
      }else if(act==="remove"){
        const title=(group.properties&&group.properties.title)||"this group";
        if(!window.confirm('Remove preset group "'+title+'"? Tasks already added to a day stay on that day.'))return;
        await api("DELETE","/api/task-groups/"+encodeURIComponent(id));
        _groups=_groups.filter(g=>g.id!==id); renderTaskGroupsSidebar(); toast("Preset group removed");
      }
    }catch(e){ toast("Group action failed: "+(e.message||e),"error"); }
  }

  async function addGroupToDay(id){
    const date=viewDateStr();
    const data=await api("POST","/api/task-groups/"+encodeURIComponent(id)+"/schedule",date?{date}:{});
    const n=(data&&data.created&&data.created.length)||0;
    await refreshSchedule();
    toast(n?("Added "+n+" task"+(n===1?"":"s")+" to your day"):"Group had no tasks");
  }

  // ──────────── Group modal ────────────
  function openTaskGroupModal(id){
    const group=id?_groups.find(g=>g.id===id):null;
    const p=group?(group.properties||{}):{};
    _editGroupId=id||null;
    _editItems=Array.isArray(p.items)?p.items.map(it=>({...it})):[];
    document.getElementById("tg-id").value=id||"";
    document.getElementById("tg-title").value=p.title||"";
    const titleEl=document.getElementById("task-group-modal-title");
    if(titleEl)titleEl.textContent=id?"Edit preset group":"New preset group";
    resetAddRows();
    renderGroupItems();
    const o=document.getElementById("task-group-modal-overlay"); if(o)o.classList.add("open");
    setTimeout(()=>{const t=document.getElementById("tg-title");if(t)t.focus();},20);
  }
  function closeTaskGroupModal(){ const o=document.getElementById("task-group-modal-overlay"); if(o)o.classList.remove("open"); }
  function resetAddRows(){
    ["tg-add-fixed-title","tg-add-ph-label"].forEach(idv=>{const el=document.getElementById(idv);if(el)el.value="";});
    const phMenus=document.getElementById("tg-add-ph-menus");
    if(phMenus)phMenus.innerHTML=menuCheckboxesHtml([]);
  }
  function renderGroupItems(){
    const mount=document.getElementById("task-group-items-list");
    if(!mount)return;
    if(!_editItems.length){ mount.innerHTML='<div class="delegated-empty">No items yet. Add fixed tasks or a placeholder below.</div>'; }
    else mount.innerHTML=_editItems.map((it,idx)=>{
      const label=it.isPlaceholder
        ? '◇ '+esc(it.label||"Placeholder")+' <span class="tg-item-sub">'+esc((it.placeholderMenus||[]).map(menuTitle).join(", ")||"no menus")+'</span>'
        : esc(it.title||"(untitled)");
      return '<div class="tg-item-row'+(it.isPlaceholder?" tg-item-ph":"")+'" data-idx="'+idx+'">'+
        '<span class="tg-item-label">'+label+'</span>'+
        '<span class="tg-item-dur">'+esc(it.duration||30)+'m</span>'+
        '<button type="button" data-item-act="up" title="Move up">↑</button>'+
        '<button type="button" data-item-act="down" title="Move down">↓</button>'+
        '<button type="button" class="danger" data-item-act="remove" title="Remove">×</button>'+
      '</div>';
    }).join("");
    mount.querySelectorAll("[data-item-act]").forEach(btn=>{
      btn.addEventListener("click",()=>{
        const idx=Number(btn.closest(".tg-item-row").dataset.idx);
        if(btn.dataset.itemAct==="remove")_editItems.splice(idx,1);
        else if(btn.dataset.itemAct==="up"&&idx>0){ [_editItems[idx-1],_editItems[idx]]=[_editItems[idx],_editItems[idx-1]]; }
        else if(btn.dataset.itemAct==="down"&&idx<_editItems.length-1){ [_editItems[idx+1],_editItems[idx]]=[_editItems[idx],_editItems[idx+1]]; }
        renderGroupItems();
      });
    });
  }
  function addFixedItem(){
    const title=(document.getElementById("tg-add-fixed-title").value||"").trim();
    if(!title){ toast("Task title required","error"); return; }
    const duration=Math.max(1,parseInt(document.getElementById("tg-add-fixed-dur").value,10)||30);
    const priority=document.getElementById("tg-add-fixed-pri").value||"Medium";
    _editItems.push({local_id:uid("tgi"),isPlaceholder:false,title,duration,priority,detail:""});
    document.getElementById("tg-add-fixed-title").value="";
    renderGroupItems();
  }
  function addPlaceholderItem(){
    const menus=Array.from(document.querySelectorAll("#tg-add-ph-menus input[type=checkbox]:checked")).map(c=>c.value);
    if(!menus.length){ toast("Pick at least one menu for the placeholder","error"); return; }
    const label=(document.getElementById("tg-add-ph-label").value||"").trim()||menus.map(menuTitle).join(" / ");
    const duration=Math.max(1,parseInt(document.getElementById("tg-add-ph-dur").value,10)||30);
    _editItems.push({local_id:uid("tgi"),isPlaceholder:true,placeholderMenus:menus,label,duration,priority:"Medium"});
    resetAddRows();
    renderGroupItems();
  }
  async function saveTaskGroup(){
    const title=(document.getElementById("tg-title").value||"").trim();
    if(!title){ toast("Group title required","error"); return; }
    if(!_editItems.length){ toast("Add at least one item","error"); return; }
    const id=document.getElementById("tg-id").value||null;
    try{
      const body={properties:{title,items:_editItems}};
      if(id)await api("PATCH","/api/task-groups/"+encodeURIComponent(id),body);
      else await api("POST","/api/task-groups",body);
      closeTaskGroupModal();
      await loadTaskGroups();
      toast(id?"Preset group updated":"Preset group created");
    }catch(e){ toast("Save failed: "+(e.message||e),"error"); }
  }

  // ──────────── Placeholder swap (click a placeholder on the itinerary) ────────────
  async function openPlaceholderSwap(ev){
    const menus=(ev&&ev.placeholderMenus)||[];
    _swapBlockId=(ev&&ev._blockId)||null;
    const o=document.getElementById("placeholder-swap-overlay");
    const list=document.getElementById("placeholder-swap-list");
    const titleEl=document.getElementById("placeholder-swap-title");
    if(!o||!list)return;
    const menuNames=menus.map(menuTitle).join(", ")||"any menu";
    if(titleEl)titleEl.textContent="Swap placeholder · "+menuNames;
    if(!_swapBlockId){ toast("This placeholder has no saved block id","error"); return; }
    list.innerHTML='<div class="delegated-empty">Loading…</div>';
    o.classList.add("open");
    try{
      const data=await api("GET","/api/responsibilities");
      const all=(data&&data.items)||[];
      const want=new Set(menus);
      const matches=all.filter(r=>{
        const rp=r.properties||{};
        if(rp.status==="archived")return false;
        const rm=Array.isArray(rp.menus)?rp.menus:[];
        return rm.some(m=>want.has(m));
      });
      // de-dupe by id (a responsibility in two of the placeholder's menus appears once)
      const seen=new Set(); const uniq=[];
      matches.forEach(r=>{ if(!seen.has(r.id)){seen.add(r.id);uniq.push(r);} });
      if(!uniq.length){
        list.innerHTML='<div class="delegated-empty">No tasks in '+esc(menuNames)+'.</div>'+
          '<button type="button" class="primary" id="placeholder-swap-create">Create a responsibility in '+esc(menuNames)+'</button>';
        const createBtn=document.getElementById("placeholder-swap-create");
        if(createBtn)createBtn.addEventListener("click",()=>{
          closePlaceholderSwap();
          if(typeof window.openResponsibilityModalWithMenus==="function")window.openResponsibilityModalWithMenus(menus);
        });
        return;
      }
      list.innerHTML=uniq.map(r=>{
        const rp=r.properties||{};
        return '<button type="button" class="placeholder-swap-item" data-id="'+esc(r.id)+'">'+
          '<span class="ps-title">'+esc(rp.title||"(untitled)")+'</span>'+
          '<span class="ps-meta">'+esc(rp.estimatedMinutes||30)+'m · '+esc((rp.menus||[]).map(menuTitle).join(", "))+'</span>'+
        '</button>';
      }).join("");
      list.querySelectorAll(".placeholder-swap-item").forEach(btn=>{
        btn.addEventListener("click",()=>resolvePlaceholder(btn.dataset.id));
      });
    }catch(e){
      list.innerHTML='<div class="delegated-empty">Failed to load tasks: '+esc(e.message||e)+'</div>';
    }
  }
  function closePlaceholderSwap(){ const o=document.getElementById("placeholder-swap-overlay"); if(o)o.classList.remove("open"); _swapBlockId=null; }
  async function resolvePlaceholder(responsibilityId){
    if(!_swapBlockId)return;
    try{
      await api("POST","/api/task-groups/resolve-placeholder",{placeholderBlockId:_swapBlockId,responsibilityId,date:viewDateStr()});
      closePlaceholderSwap();
      await refreshSchedule();
      toast("Task swapped in");
    }catch(e){ toast("Swap failed: "+(e.message||e),"error"); }
  }

  // ──────────── Responsibility-modal menus field (rendered into responsibilities.js's modal) ────────────
  function refreshRespMenuField(){
    const mount=document.getElementById("resp-menus-list");
    if(!mount)return;
    const selected=mount.dataset.selected?mount.dataset.selected.split(","):[];
    mount.innerHTML=menuCheckboxesHtml(selected);
  }

  function bind(){
    const newBtn=document.getElementById("task-groups-new");
    if(newBtn)newBtn.addEventListener("click",()=>openTaskGroupModal(null));
    const manageBtn=document.getElementById("task-groups-manage-menus");
    if(manageBtn)manageBtn.addEventListener("click",openMenuManager);
    const save=document.getElementById("tg-save"); if(save)save.addEventListener("click",saveTaskGroup);
    const cancel=document.getElementById("tg-cancel"); if(cancel)cancel.addEventListener("click",closeTaskGroupModal);
    const addFixed=document.getElementById("tg-add-fixed-btn"); if(addFixed)addFixed.addEventListener("click",addFixedItem);
    const addPh=document.getElementById("tg-add-ph-btn"); if(addPh)addPh.addEventListener("click",addPlaceholderItem);
    const fixedTitle=document.getElementById("tg-add-fixed-title");
    if(fixedTitle)fixedTitle.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();addFixedItem();}});
    const tgOverlay=document.getElementById("task-group-modal-overlay");
    if(tgOverlay)tgOverlay.addEventListener("click",e=>{if(e.target===tgOverlay)closeTaskGroupModal();});
    const tgNewMenu=document.getElementById("tg-new-menu-link");
    if(tgNewMenu)tgNewMenu.addEventListener("click",openMenuManager);
    const menuClose=document.getElementById("task-menu-close"); if(menuClose)menuClose.addEventListener("click",closeMenuManager);
    const menuOverlay=document.getElementById("task-menu-modal-overlay");
    if(menuOverlay)menuOverlay.addEventListener("click",e=>{if(e.target===menuOverlay)closeMenuManager();});
    const menuNewBtn=document.getElementById("task-menu-new-btn");
    const menuNewInput=document.getElementById("task-menu-new-input");
    async function doCreateMenu(){
      const v=(menuNewInput&&menuNewInput.value||"").trim(); if(!v)return;
      try{ await createMenu(v); if(menuNewInput)menuNewInput.value=""; renderGroupItems(); refreshRespMenuField(); toast("Menu created"); }
      catch(e){ toast("Create menu failed: "+(e.message||e),"error"); }
    }
    if(menuNewBtn)menuNewBtn.addEventListener("click",doCreateMenu);
    if(menuNewInput)menuNewInput.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();doCreateMenu();}});
    const swapClose=document.getElementById("placeholder-swap-close"); if(swapClose)swapClose.addEventListener("click",closePlaceholderSwap);
    const swapOverlay=document.getElementById("placeholder-swap-overlay");
    if(swapOverlay)swapOverlay.addEventListener("click",e=>{if(e.target===swapOverlay)closePlaceholderSwap();});
  }

  document.addEventListener("DOMContentLoaded",bind);
  window.loadTaskGroups=loadTaskGroups;
  window.addTaskGroupToDay=addGroupToDay;
  window.loadTaskMenus=loadTaskMenus;
  window.getTaskMenus=getTaskMenus;
  window.renderTaskGroupsSidebar=renderTaskGroupsSidebar;
  window.renderRespMenuField=refreshRespMenuField;
  window.openPlaceholderSwap=openPlaceholderSwap;
})();
