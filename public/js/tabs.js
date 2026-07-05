// ======== TABS ========
// Render registry: each tab names the function to run when it activates, in one
// table instead of an if-ladder. A tab file can also self-register at load with
// DCC.tabs.register("name", fn) -- both are consulted. Entries whose function
// isn't defined are simply skipped (some tabs render statically).
window.DCC = window.DCC || {};
DCC.tabs = DCC.tabs || (function () {
  const registry = {};
  return {
    register(name, fn) { registry[name] = fn; },
    run(name) {
      const fn = registry[name];
      if (typeof fn === "function") { try { fn(); } catch (e) { console.error("[tab:" + name + "]", e); } }
    },
  };
})();

// Built-in renderers, resolved lazily by name (functions live in their own
// files, loaded after this one). No entry = static tab, nothing to render.
DCC.tabs.register("glymphatic", () => typeof buildGlymphaticBrief === "function" && buildGlymphaticBrief());
DCC.tabs.register("pet-home", () => window.PetHome && typeof PetHome.render === "function" && PetHome.render());
DCC.tabs.register("budget", () => typeof renderBudget === "function" && renderBudget());
DCC.tabs.register("tasks", () => {
  // PIN 9: mount the mini-month sidebar into the Task Menu split view. Cheap
  // (string concat); picks up the current _gcalSidebarState each time.
  if (typeof renderCalendarSidebar !== "function") return;
  const m = document.getElementById("tm-cal-mount");
  if (m) m.innerHTML = renderCalendarSidebar();
});
// These two had no top-bar button when the registry landed, so their entries
// never fire today -- kept (harmless) rather than dropped, so re-adding a
// button later Just Works.
DCC.tabs.register("calendar", () => typeof buildCalendar === "function" && buildCalendar());
DCC.tabs.register("responsibilities", () => typeof renderResponsibilities === "function" && renderResponsibilities());

document.querySelectorAll(".tab").forEach(tab=>{
  tab.addEventListener("click",()=>{
    if(tab.dataset.tab !== "slots" && typeof window.clearSlotCoinEffects === "function"){
      window.clearSlotCoinEffects();
    }
    document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c=>c.classList.remove("active"));
    tab.classList.add("active");document.getElementById("tab-"+tab.dataset.tab).classList.add("active");
    DCC.tabs.run(tab.dataset.tab);
  });
});

// ======== TASK MENU ACCORDION ========
const TM_ACCORDION_KEY="pa-tm-accordion-state";
function _loadAccordionState(){try{return JSON.parse(localStorage.getItem(TM_ACCORDION_KEY)||"{}")}catch(e){return{}}}
function _saveAccordionState(){
  const state={};
  document.querySelectorAll(".tm-section").forEach(d=>{state[d.id]=d.open});
  localStorage.setItem(TM_ACCORDION_KEY,JSON.stringify(state));
}
// Restore saved open/closed state on load
(function(){
  const saved=_loadAccordionState();
  document.querySelectorAll(".tm-section").forEach(d=>{
    if(saved[d.id]!==undefined)d.open=saved[d.id];
  });
})();
// Persist on toggle
document.querySelectorAll(".tm-section").forEach(d=>{
  d.addEventListener("toggle",_saveAccordionState);
});

// ======== RENDER ========
// ======== UPCOMING MEETINGS TAB ========
const UPCOMING_NOTES_KEY = "pa-upcoming-notes";
const UPCOMING_ACTIONS_KEY = "pa-upcoming-actions";
const PUSHED_DOCS_KEY = "pa-pushed-docs";

// Debounced save of non-block globals to server (upcoming notes/actions, pushed docs)
let _globalsPartialTimer = null;
function _scheduleGlobalsPartialSave() {
  clearTimeout(_globalsPartialTimer);
  _globalsPartialTimer = setTimeout(() => {
    const data = {
      upcomingNotes: (() => { try { return JSON.parse(localStorage.getItem(UPCOMING_NOTES_KEY)||"{}"); } catch(e) { return {}; } })(),
      upcomingActions: (() => { try { return JSON.parse(localStorage.getItem(UPCOMING_ACTIONS_KEY)||"{}"); } catch(e) { return {}; } })(),
      pushedDocs: (() => { try { return JSON.parse(localStorage.getItem(PUSHED_DOCS_KEY)||"{}"); } catch(e) { return {}; } })(),
    };
    fetch("/api/save-globals", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify(data), keepalive: true
    }).catch(() => {});
    // Update in-memory server globals so same-session reads are consistent
    if (window.__SECOND_BRAIN_GLOBALS__) Object.assign(window.__SECOND_BRAIN_GLOBALS__, data);
  }, 2000);
}

function loadUpNotes(){
  const local = localStorage.getItem(UPCOMING_NOTES_KEY);
  if (local) try { return JSON.parse(local); } catch(e) {}
  // Cross-device: use server-loaded globals
  const sg = window.__SECOND_BRAIN_GLOBALS__;
  if (sg && sg.upcomingNotes) {
    localStorage.setItem(UPCOMING_NOTES_KEY, JSON.stringify(sg.upcomingNotes));
    return sg.upcomingNotes;
  }
  return {};
}
function saveUpNotes(d){
  localStorage.setItem(UPCOMING_NOTES_KEY, JSON.stringify(d));
  _scheduleGlobalsPartialSave();
}
function loadUpActions(){
  const local = localStorage.getItem(UPCOMING_ACTIONS_KEY);
  if (local) try { return JSON.parse(local); } catch(e) {}
  const sg = window.__SECOND_BRAIN_GLOBALS__;
  if (sg && sg.upcomingActions) {
    localStorage.setItem(UPCOMING_ACTIONS_KEY, JSON.stringify(sg.upcomingActions));
    return sg.upcomingActions;
  }
  return {};
}
function saveUpActions(d){
  localStorage.setItem(UPCOMING_ACTIONS_KEY, JSON.stringify(d));
  _scheduleGlobalsPartialSave();
}
function loadPushedDocs(){
  const local = localStorage.getItem(PUSHED_DOCS_KEY);
  if (local) try { return JSON.parse(local); } catch(e) {}
  const sg = window.__SECOND_BRAIN_GLOBALS__;
  if (sg && sg.pushedDocs) {
    localStorage.setItem(PUSHED_DOCS_KEY, JSON.stringify(sg.pushedDocs));
    return sg.pushedDocs;
  }
  return {};
}
function savePushedDocs(d){
  localStorage.setItem(PUSHED_DOCS_KEY, JSON.stringify(d));
  _scheduleGlobalsPartialSave();
}

// Notes button for upcoming meetings (uses its own localStorage keys)
function upNotesButton(mtg) {
  const notes = loadUpNotes();
  const actions = loadUpActions();
  const hasNotes = notes[mtg.id] && notes[mtg.id].trim();
  const actionItems = actions[mtg.id] || [];
  const hasActions = actionItems.length > 0;
  const openCount = actionItems.filter(a => !a.done).length;
  let cls = "notes-btn";
  if (hasActions) cls += " has-actions";
  else if (hasNotes) cls += " has-notes";
  let badge = hasActions ? '<span class="action-badge">' + actionSvg + ' ' + openCount + '</span>' : '';
  return '<button class="' + cls + '" data-notes-id="' + mtg.id + '" data-notes-title="' + (mtg.title || "").replace(/"/g, '&quot;') + '" data-notes-store="upcoming" title="Notes & Action Items">' + notesSvg + '</button>' + badge;
}

function openUpcomingNotesDrawer(id, title) {
  // Reuse the existing notes drawer but point it at upcoming localStorage
  currentNotesTaskId = id;
  document.getElementById("notes-drawer-task-title").textContent = title || "Meeting Notes";
  const notes = loadUpNotes();
  const val = notes[id];
  const container = document.getElementById("notes-block-editor");

  // Determine initial blocks
  let initialBlocks=null;
  if(val && typeof val==="object" && val.blocks && val.blocks.length){
    initialBlocks=val.blocks;
  } else if(val && typeof val==="object" && val.html){
    initialBlocks=migrateHtmlToBlocks(val.html);
  } else if(typeof val==="string" && val){
    initialBlocks=migrateHtmlToBlocks(val);
  }

  if(window._notesBlockEditor) window._notesBlockEditor.destroy();
  window._notesBlockEditor=createBlockEditor(container, initialBlocks);

  // Render action items from upcoming store
  const actions = loadUpActions();
  const items = actions[id] || [];
  document.getElementById("notes-ai-count").textContent = "(" + items.length + ")";
  const list = document.getElementById("notes-ai-list");
  if (!items.length) { list.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:4px 0">No action items yet.</div>'; }
  else {
    list.innerHTML = items.map((item, idx) =>
      '<div class="notes-ai-item">' +
        '<div class="ai-check' + (item.done ? " done" : "") + '" onclick="toggleUpAction(\'' + id + '\',' + idx + ')">\u2713</div>' +
        '<span class="ai-text"' + (item.done ? ' style="text-decoration:line-through;opacity:0.5"' : '') + '>' + item.text + '</span>' +
        '<span class="ai-pri ai-pri-' + item.priority + '">' + item.priority + '</span>' +
        '<span class="ai-del" onclick="deleteUpAction(\'' + id + '\',' + idx + ')">&times;</span>' +
      '</div>'
    ).join('');
  }
  document.getElementById("notes-action-input").style.display = "none";
  const taskBar = document.getElementById("task-add-notes");
  if (taskBar) {
    taskBar.style.display = "none";
    const t = taskBar.querySelector(".tab-title");
    if (t) { t.value = ""; t.classList.remove("tab-error"); }
  }
  // Override save/add handlers for upcoming store
  window._upcomingNotesMode = true;
  window._upcomingNotesId = id;
  document.getElementById("notes-drawer-overlay").classList.add("open");
  window._notesBlockEditor.focus();
}
function toggleUpAction(id, idx) {
  const actions = loadUpActions();
  if (actions[id] && actions[id][idx]) { actions[id][idx].done = !actions[id][idx].done; saveUpActions(actions); openUpcomingNotesDrawer(id, document.getElementById("notes-drawer-task-title").textContent); }
}
function deleteUpAction(id, idx) {
  const actions = loadUpActions();
  if (actions[id]) { actions[id].splice(idx, 1); saveUpActions(actions); openUpcomingNotesDrawer(id, document.getElementById("notes-drawer-task-title").textContent); }
}

if (typeof window.showToast !== "function") {
  window.showToast = function(msg) {
    let t = document.getElementById("pa-toast");
    if (!t) { t = document.createElement("div"); t.id = "pa-toast"; t.className = "toast"; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 3000);
  };
}

function pushToDoc(mtgId, mtgTitle, docUrl, docTitle, mtgDate) {
  const notes = loadUpNotes();
  const actions = loadUpActions();
  const noteText = notes[mtgId] || "";
  const actionItems = actions[mtgId] || [];
  if (!noteText && !actionItems.length) { showToast("Nothing to push -- add notes or action items first."); return; }
  // Build content to push
  let content = "## " + mtgDate + " -- " + mtgTitle + "\n\n";
  if (noteText) content += noteText + "\n\n";
  if (actionItems.length) {
    content += "### Action Items\n";
    actionItems.forEach(a => { content += "- [" + (a.done ? "x" : " ") + "] " + a.text + " (" + a.priority + ")\n"; });
    content += "\n";
  }
  // Copy to clipboard as fallback and mark as pushed
  navigator.clipboard.writeText(content).then(() => {
    const pushed = loadPushedDocs();
    pushed[mtgId] = { at: new Date().toISOString(), docUrl };
    savePushedDocs(pushed);
    showToast("Notes copied to clipboard. Paste into " + (docTitle || "the linked doc") + ".");
    buildUpcoming();
  }).catch(() => {
    showToast("Could not copy -- check clipboard permissions.");
  });
}

function buildUpcoming() {
  const board = document.getElementById("upcoming-board");
  if (!board) return;
  board.innerHTML = "";
  const upcoming = window.__DCC_UPCOMING__ || [];
  const countEl = document.getElementById("upcoming-count");
  if (countEl) countEl.textContent = upcoming.length;
  if (!upcoming.length) {
    board.innerHTML = '<div class="board-empty">No upcoming meetings loaded. Meetings are populated when the command center is rendered by the PA.</div>';
    return;
  }
  // Group by date
  const groups = {};
  upcoming.forEach(mtg => {
    const d = new Date(mtg.start);
    const key = d.toISOString().split("T")[0];
    if (!groups[key]) groups[key] = [];
    groups[key].push(mtg);
  });
  const pushed = loadPushedDocs();
  Object.keys(groups).sort().forEach(dateKey => {
    const d = new Date(dateKey + "T12:00:00");
    const dayLabel = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const isToday = dateKey === new Date().toISOString().split("T")[0];
    const groupEl = document.createElement("div");
    groupEl.className = "upcoming-date-group";
    groupEl.innerHTML = '<div class="upcoming-date-label"><span class="udl-day">' + dayLabel + '</span>' + (isToday ? ' <span style="color:var(--accent);font-size:10px;margin-left:6px">TODAY</span>' : '') + '</div>';
    groups[dateKey].forEach(mtg => {
      const startTime = new Date(mtg.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      const endTime = new Date(mtg.end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      const attendeeList = (mtg.attendees || []).filter(a => !a.includes("drake")).join(", ");
      const isPushed = !!pushed[mtg.id];
      const hasDoc = !!mtg.linkedDocUrl;
      const card = document.createElement("div");
      card.className = "upcoming-card";
      card.innerHTML =
        '<div class="uc-time">' + startTime + ' - ' + endTime + '</div>' +
        '<div class="uc-body">' +
          '<div class="uc-title">' + mtg.title + '</div>' +
          (attendeeList ? '<div class="uc-attendees">' + attendeeList + '</div>' : '') +
        '</div>' +
        '<div class="uc-actions">' +
          upNotesButton(mtg) +
          (hasDoc ? '<button class="btn-push-doc' + (isPushed ? ' pushed' : '') + '" data-mtg-id="' + mtg.id + '" data-mtg-title="' + mtg.title.replace(/"/g, '&quot;') + '" data-doc-url="' + (mtg.linkedDocUrl || '').replace(/"/g, '&quot;') + '" data-doc-title="' + (mtg.linkedDocTitle || '').replace(/"/g, '&quot;') + '" data-mtg-date="' + dayLabel + '">' + (isPushed ? '\u2713 Pushed' : '\u2197 Push to Doc') + '</button>' : '') +
        '</div>';
      // Wire notes button
      const nb = card.querySelector(".notes-btn");
      if (nb) nb.addEventListener("click", e => { e.stopPropagation(); openUpcomingNotesDrawer(nb.dataset.notesId, nb.dataset.notesTitle); });
      // Wire push-to-doc
      const pb = card.querySelector(".btn-push-doc");
      if (pb) pb.addEventListener("click", e => { e.stopPropagation(); pushToDoc(pb.dataset.mtgId, pb.dataset.mtgTitle, pb.dataset.docUrl, pb.dataset.docTitle, pb.dataset.mtgDate); });
      groupEl.appendChild(card);
    });
    board.appendChild(groupEl);
  });
}

// Override the notes drawer close to save to the right store
const _origCloseNotesDrawer = closeNotesDrawer;
closeNotesDrawer = function() {
  if (window._upcomingNotesMode && window._upcomingNotesId) {
    const notes = loadUpNotes();
    if(window._notesBlockEditor && !window._notesBlockEditor.isEmpty()){
      const blocks=window._notesBlockEditor.getBlocks();
      notes[window._upcomingNotesId]={blocks:blocks, html:window._notesBlockEditor.toHtml(), text:window._notesBlockEditor.toMarkdown()};
    } else { delete notes[window._upcomingNotesId]; }
    saveUpNotes(notes);
    window._upcomingNotesMode = false;
    window._upcomingNotesId = null;
    document.getElementById("notes-drawer-overlay").classList.remove("open");
    currentNotesTaskId = null;
    render();
    return;
  }
  _origCloseNotesDrawer();
};

// Override add action item to support upcoming store
const _origAddActionItem = addActionItem;
addActionItem = function(taskId) {
  if (window._upcomingNotesMode && window._upcomingNotesId) {
    const text = document.getElementById("notes-action-text").value.trim();
    if (!text) return;
    const priority = document.getElementById("notes-action-priority").value;
    const actions = loadUpActions();
    if (!actions[window._upcomingNotesId]) actions[window._upcomingNotesId] = [];
    actions[window._upcomingNotesId].push({ text, priority, done: false, created: new Date().toISOString() });
    saveUpActions(actions);
    document.getElementById("notes-action-text").value = "";
    document.getElementById("notes-action-input").style.display = "none";
    openUpcomingNotesDrawer(window._upcomingNotesId, document.getElementById("notes-drawer-task-title").textContent);
    buildActionItemsTab();
    return;
  }
  _origAddActionItem(taskId);
};

// ======== SUBTASKS ========
let SUBTASK_KEY = "pa-subtasks-" + ((__state && __state.date) ? __state.date : "unknown");
function loadSubtasks(){try{return JSON.parse(localStorage.getItem(SUBTASK_KEY)||"{}")}catch(e){return{}}}
function saveSubtasks(data){
  // Always persist subtasks — store on day_root like other per-day state
  if(window.USE_BLOCKSTORE&&Object.values(window.USE_BLOCKSTORE).every(v=>v)&&window.blockStore){
    var dayRootId=window.blockStore.getDayRootId();
    var root=window.blockStore.get(dayRootId);
    if(root){window.blockStore.updateBlock(dayRootId,Object.assign({},root.properties,{_subtasks:data}));}
    return;
  }
  try{localStorage.setItem(SUBTASK_KEY,JSON.stringify(data));scheduleIDBSave()}catch(e){}
}
// Also fix loadSubtasks to read from BlockStore
var _origLoadSubtasks=loadSubtasks;
loadSubtasks=function(){
  if(window.USE_BLOCKSTORE&&Object.values(window.USE_BLOCKSTORE).every(v=>v)&&window.blockStore){
    var dayRootId=window.blockStore.getDayRootId();
    var root=window.blockStore.get(dayRootId);
    return(root&&root.properties._subtasks)||{};
  }
  return _origLoadSubtasks();
};

// Subtasks are now real tasks in the unified tree (subtaskOf = parent id), so
// they render inline, nest infinitely, intermix with wraps, and share
// completion/points with regular tasks. The legacy loadSubtasks/saveSubtasks
// map is retained only for migration of pre-existing data.
function addSubtask(taskId, text){
  if(!text||!text.trim())return;
  text=text.trim();
  const id="st-"+Date.now();
  const parent=(typeof scheduled!=="undefined")?scheduled.find(e=>e.id===taskId):null;
  const startStr=(parent&&parent.start)||"00:00";
  const task={id:id,title:text,type:"task",subtaskOf:taskId,source:"manual",
    start:startStr,end:startStr,priority:"Medium",tags:[],meta:""};
  if(typeof scheduled!=="undefined")scheduled.push(task);
  if(window.blockStore&&window.blockStore.createBlock){
    const date=(typeof viewDate!=="undefined"&&viewDate)?viewDate:((typeof __state!=="undefined"&&__state)?__state.date:null);
    window.blockStore.createBlock("block",{local_id:id,title:text,type:"task",subtaskOf:taskId,source:"manual",
      start:startStr,end:startStr,duration:0,priority:"Medium",tags:[],added_at:new Date().toISOString()},{date:date});
  }
  // Snapshot/rebalance the parent's point pie now that it has (one more) subtask.
  if(window.PointPlan&&typeof window.PointPlan.ensure==="function")window.PointPlan.ensure(taskId);
  render();
}
// A "stacked" task ("stacked time"): independent concurrent work done in the
// gaps / partial focus of a larger task. Reuses the ride-along edge (wrapId), so
// it gets its OWN time window and its OWN duration-based points — unlike a
// subtask, it does not draw from the parent's pie.
function addStackedTask(taskId, text){
  if(!text||!text.trim())return;
  text=text.trim();
  const id="sk-"+Date.now();
  const parent=(typeof scheduled!=="undefined")?scheduled.find(e=>e.id===taskId):null;
  const startStr=(parent&&parent.start)||"00:00";
  const durMin=30;
  const endStr=(typeof fmt==="function")?fmt((typeof pt==="function"?pt(startStr):0)+durMin):startStr;
  const task={id:id,title:text,type:"task",wrapId:taskId,source:"manual",
    start:startStr,end:endStr,priority:"Medium",tags:[],meta:(typeof ms==="function"?("Stacked · "+ms(durMin)):"Stacked")};
  if(typeof scheduled!=="undefined")scheduled.push(task);
  if(window.blockStore&&window.blockStore.createBlock){
    const date=(typeof viewDate!=="undefined"&&viewDate)?viewDate:((typeof __state!=="undefined"&&__state)?__state.date:null);
    window.blockStore.createBlock("block",{local_id:id,title:text,type:"task",wrapId:taskId,source:"manual",
      start:startStr,end:endStr,duration:durMin,priority:"Medium",tags:[],added_at:new Date().toISOString()},{date:date});
  }
  if(typeof recalcTimes==="function")recalcTimes();
  render();
}
// Re-parent an EXISTING task so it becomes a SUBTASK of another (umbrella). Unlike
// a ride-along (wrapId) — which keeps its own time and duration-based points — a
// subtask shares the parent's point pie, travels with it, and renders as the small
// subtask row. The task itself is unchanged (no copy/alias): it simply moves under
// the new parent and can be pulled back out later (drag to an edge clears the edge).
// Mirrors the drag "Case B" re-parent in drag.js but targets subtaskOf, and is
// shared by the "Make subtask of…" menu and the Shift-drag-to-nest drop zone.
function reparentAsSubtask(childId, parentId){
  if(!childId||!parentId||childId===parentId)return false;
  if(typeof scheduled==="undefined")return false;
  const child=scheduled.find(e=>e.id===childId);
  const parent=scheduled.find(e=>e.id===parentId);
  if(!child||!parent)return false;
  // Guard against cycles: never nest a task under one of its own descendants.
  if(typeof _isAncestor==="function"&&_isAncestor(childId,parentId)){
    if(typeof showToast==="function")showToast("Can't nest a task under its own subtask","error",2600);
    return false;
  }
  if(child.subtaskOf===parentId)return false; // already a subtask of this parent
  const prevParent=(typeof parentIdOf==="function")?parentIdOf(child):(child.subtaskOf||child.wrapId||null);
  child.subtaskOf=parentId;
  child.wrapId=null;
  if(typeof _clearPin==="function")_clearPin(child);
  // A subtask has no independent time; align it to the parent's start (like addSubtask).
  child.start=parent.start||child.start;child.end=child.start;
  if(typeof _persistEvWrap==="function")_persistEvWrap(child);
  // Fold the child into the new parent's pie; rebalance the old parent's, if any.
  if(window.PointPlan){
    if(typeof window.PointPlan.ensure==="function")window.PointPlan.ensure(parentId);
    if(prevParent&&prevParent!==parentId&&typeof window.PointPlan.reconcile==="function")window.PointPlan.reconcile(prevParent);
  }
  if(typeof recalcTimes==="function")recalcTimes();
  render();
  if(typeof showToast==="function")showToast('Made a subtask of "'+(parent.title||"task")+'"',"success",2200);
  return true;
}
// Popover anchored at the click that lists candidate parent tasks; choosing one
// re-parents the task as a subtask via reparentAsSubtask(). Reuses the dur-popover
// shell/positioning from openSubtaskAdd.
function openMakeSubtaskOf(childId, anchorEl){
  document.querySelectorAll(".subtask-add-pop,.resched-popover,.dur-popover,.make-subtask-pop").forEach(p=>p.remove());
  if(typeof scheduled==="undefined")return;
  const esc=(typeof escHtml==="function")?escHtml:(s=>String(s==null?"":s));
  const meeting=(typeof isMeeting==="function")?isMeeting:(()=>false);
  const done=(typeof isDone==="function")?isDone:(()=>false);
  const candidates=scheduled.filter(e=>
    e&&e.id!==childId&&
    !meeting(e)&&e.type!=="break"&&e.type!=="ooo"&&
    !done(e)&&
    e.subtaskOf!==childId&&
    !(typeof _isAncestor==="function"&&_isAncestor(childId,e.id))&&
    !(typeof parentIdOf==="function"&&parentIdOf(scheduled.find(x=>x.id===childId)||{})===e.id)
  );
  const pop=document.createElement("div");
  pop.className="dur-popover make-subtask-pop";
  if(!candidates.length){
    pop.innerHTML='<div class="make-subtask-empty">No other open tasks to nest under.</div>';
  }else{
    pop.innerHTML='<div class="make-subtask-label">Make subtask of…</div>'+
      '<div class="make-subtask-list">'+
        candidates.map(e=>'<button type="button" class="make-subtask-opt" data-parent-id="'+esc(e.id)+'">'+esc(e.title||"(untitled)")+'</button>').join("")+
      '</div>';
  }
  function close(){pop.remove();document.removeEventListener("click",onOut,true);document.removeEventListener("keydown",onKey,true);}
  function onOut(ev){if(!pop.contains(ev.target)&&ev.target!==anchorEl)close();}
  function onKey(ev){if(ev.key==="Escape")close();}
  pop.querySelectorAll(".make-subtask-opt").forEach(btn=>{
    btn.addEventListener("click",ev=>{ev.stopPropagation();const pid=btn.dataset.parentId;close();if(typeof reparentAsSubtask==="function")reparentAsSubtask(childId,pid);});
  });
  pop.style.position="fixed";pop.style.visibility="hidden";document.body.appendChild(pop);
  const rect=anchorEl.getBoundingClientRect(),m=8,pw=pop.offsetWidth||220,ph=pop.offsetHeight||0;
  let left=Math.max(m,Math.min(rect.left,window.innerWidth-pw-m));
  let top=rect.bottom+6;
  if(top+ph>window.innerHeight-m){const above=rect.top-ph-6;if(above>=m)top=above;}
  top=Math.max(m,Math.min(top,window.innerHeight-ph-m));
  pop.style.left=left+"px";pop.style.top=top+"px";pop.style.visibility="";
  setTimeout(()=>{document.addEventListener("click",onOut,true);document.addEventListener("keydown",onKey,true);},0);
}
function toggleSubtask(taskId, stId){
  if(typeof manualDone==="undefined")return;
  if(manualDone.has(stId)){manualDone.delete(stId);if(typeof doneAt!=="undefined")delete doneAt[stId];}
  else{manualDone.add(stId);if(typeof doneAt!=="undefined")doneAt[stId]=new Date();}
  if(typeof saveDoneState==="function")saveDoneState();
  render();
}
function deleteSubtask(taskId, stId){
  if(typeof openDeleteConfirm==="function"){openDeleteConfirm(stId);return;}
  if(typeof scheduled!=="undefined"){const i=scheduled.findIndex(e=>e.id===stId);if(i>=0)scheduled.splice(i,1);}
  // Rebalance the parent's remaining slices after a subtask is removed.
  if(taskId&&window.PointPlan&&typeof window.PointPlan.reconcile==="function")window.PointPlan.reconcile(taskId);
  render();
}
function getIncompleteSubtasks(taskId){
  const all=loadSubtasks();
  return(all[taskId]||[]).filter(s=>!s.done);
}
// Small fast popover anchored at the click to add a subtask. Stays open for
// rapid multi-add (Enter); Escape / outside-click closes. "More" opens the full
// Add Items modal for side projects / action items.
function openSubtaskAdd(parentId, anchorEl){
  document.querySelectorAll(".subtask-add-pop,.resched-popover,.dur-popover").forEach(p=>p.remove());
  const pop=document.createElement("div");
  pop.className="dur-popover subtask-add-pop";
  pop.innerHTML=
    '<input type="text" class="sub-add-input" placeholder="Add subtask…" />'+
    '<button class="sub-add-go">Add</button>'+
    '<button class="sub-add-more" title="More options (side project, action)">⋯</button>';
  function close(){pop.remove();document.removeEventListener("click",onOut,true);document.removeEventListener("keydown",onKey,true);}
  function onOut(e){if(!pop.contains(e.target)&&e.target!==anchorEl)close();}
  function onKey(e){if(e.key==="Escape")close();}
  const input=pop.querySelector(".sub-add-input");
  function add(){const v=input.value.trim();if(!v)return;if(typeof addSubtask==="function")addSubtask(parentId,v);input.value="";setTimeout(()=>input.focus(),0);}
  pop.querySelector(".sub-add-go").addEventListener("click",e=>{e.stopPropagation();add();});
  pop.querySelector(".sub-add-more").addEventListener("click",e=>{e.stopPropagation();close();if(typeof openAddModal==="function")openAddModal(parentId,"");});
  input.addEventListener("keydown",e=>{e.stopPropagation();if(e.key==="Enter"){e.preventDefault();add();}});
  pop.style.position="fixed";pop.style.visibility="hidden";document.body.appendChild(pop);
  const rect=anchorEl.getBoundingClientRect(),m=8,pw=pop.offsetWidth||250,ph=pop.offsetHeight||0;
  let left=Math.max(m,Math.min(rect.left,window.innerWidth-pw-m));
  let top=rect.bottom+6;
  if(top+ph>window.innerHeight-m){const above=rect.top-ph-6;if(above>=m)top=above;}
  top=Math.max(m,Math.min(top,window.innerHeight-ph-m));
  pop.style.left=left+"px";pop.style.top=top+"px";pop.style.visibility="";
  input.focus();
  setTimeout(()=>{document.addEventListener("click",onOut,true);document.addEventListener("keydown",onKey,true);},0);
}
// One-time-per-day migration of legacy modal subtasks (the {text,done} map) into
// real subtask tasks in the unified tree. Idempotent + guarded per day.
function migrateLegacySubtasks(){
  try{
    if(typeof scheduled==="undefined"||typeof loadSubtasks!=="function")return;
    const date=(typeof viewDate!=="undefined"&&viewDate)?viewDate:((typeof __state!=="undefined"&&__state)?__state.date:"unknown");
    const flag="pa-subtasks-migrated-"+date;
    if(localStorage.getItem(flag))return;
    const map=loadSubtasks()||{};
    let migrated=0;
    Object.keys(map).forEach(parentId=>{
      (map[parentId]||[]).forEach(st=>{
        if(!st||!st.text)return;
        if(scheduled.find(e=>e.id===st.id))return; // already a real task
        const parent=scheduled.find(e=>e.id===parentId);
        const startStr=(parent&&parent.start)||"00:00";
        scheduled.push({id:st.id,title:st.text,type:"task",subtaskOf:parentId,source:"manual",start:startStr,end:startStr,priority:"Medium",tags:[],meta:""});
        if(st.done&&typeof manualDone!=="undefined")manualDone.add(st.id);
        if(window.blockStore&&window.blockStore.createBlock){
          window.blockStore.createBlock("block",{local_id:st.id,title:st.text,type:"task",subtaskOf:parentId,source:"manual",start:startStr,end:startStr,duration:0,priority:"Medium",tags:[],added_at:(st.created||new Date().toISOString())},{date:date});
        }
        migrated++;
      });
    });
    if(migrated){
      if(typeof saveSubtasks==="function")saveSubtasks({}); // retire the legacy store for this day
      if(typeof saveDoneState==="function")saveDoneState();
    }
    localStorage.setItem(flag,"1");
  }catch(e){}
}
function executeSubtaskResolution(taskId, resolution, subIds, moveTargetId){
  const all=loadSubtasks();
  const taskSubs=all[taskId]||[];
  // If specific IDs provided, only process those; otherwise process all incomplete
  const toProcess=subIds
    ?taskSubs.filter(s=>!s.done&&subIds.includes(s.id))
    :taskSubs.filter(s=>!s.done);
  if(!toProcess.length)return;
  const ev=scheduled.find(e=>e.id===taskId);
  const parentTitle=ev?ev.title:"task";
  if(resolution==="complete"){
    toProcess.forEach(st=>{st.done=true;});
  } else if(resolution==="individual"||resolution==="spinoff"){
    toProcess.forEach(st=>{
      const id="st-sched-"+Date.now()+"-"+Math.random().toString(36).slice(2,6);
      let lastEnd="17:00";if(scheduled.length)lastEnd=scheduled[scheduled.length-1].end;
      const s=pt(lastEnd),d=30,e=s+d;
      const newItem={id,title:st.text,start:fmt(s),end:fmt(e),type:"task",meta:"30min · From: "+parentTitle,detail:"",source:"manual",priority:"Medium"};
      scheduled.push(newItem);
      if(typeof persistAddedTask==="function")persistAddedTask(newItem);
    });
    saveScheduleOrder();recalcTimes();checkOverflow();
  } else if(resolution==="grouped"){
    const id="st-grp-"+Date.now();
    const title=toProcess.map(s=>s.text).join(", ");
    let lastEnd="17:00";if(scheduled.length)lastEnd=scheduled[scheduled.length-1].end;
    const s=pt(lastEnd),d=toProcess.length*15,e=s+d;
    const newItem={id,title:"Remaining: "+title,start:fmt(s),end:fmt(e),type:"task",meta:ms(d)+" · Grouped from: "+parentTitle,detail:"",source:"manual",priority:"Medium"};
    scheduled.push(newItem);
    if(typeof persistAddedTask==="function")persistAddedTask(newItem);
    saveScheduleOrder();recalcTimes();checkOverflow();
  } else if(resolution==="move"&&moveTargetId){
    if(!all[moveTargetId])all[moveTargetId]=[];
    toProcess.forEach(st=>{
      all[moveTargetId].push({id:"st-"+Date.now()+"-"+Math.random().toString(36).slice(2),text:st.text,done:false,created:new Date().toISOString()});
    });
  }
  if(resolution==="complete"){
    all[taskId]=taskSubs;
  } else {
    // Remove only the processed subtasks from source — leave others untouched
    all[taskId]=taskSubs.filter(s=>!toProcess.some(p=>p.id===s.id));
  }
  saveSubtasks(all);
}
