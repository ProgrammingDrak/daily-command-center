// ======== TABS ========
document.querySelectorAll(".tab").forEach(tab=>{
  tab.addEventListener("click",()=>{
    document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c=>c.classList.remove("active"));
    tab.classList.add("active");document.getElementById("tab-"+tab.dataset.tab).classList.add("active");
    if(tab.dataset.tab==="calendar"&&typeof buildCalendar==="function"){buildCalendar();}
  });
});

// ======== TASK MENUS ACCORDION ========
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

function showToast(msg) {
  let t = document.getElementById("pa-toast");
  if (!t) { t = document.createElement("div"); t.id = "pa-toast"; t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3000);
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
  const upcoming = window.__PA_UPCOMING__ || [];
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
          (hasDoc ? '<button class="btn-push-doc' + (isPushed ? ' pushed' : '') + '" data-mtg-id="' + mtg.id + '" data-mtg-title="' + mtg.title.replace(/"/g, '&quot;') + '" data-doc-url="' + (mtg.linkedDocUrl || '').replace(/"/g, '&quot;') + '" data-doc-title="' + (mtg.linkedDocTitle || '').replace(/"/g, '&quot;') + '" data-mtg-date="' + dayLabel + '">' + (isPushed ? '\u2713 Pushed' : '\u2197 Push to Doc') + '</button>' : '<a href="' + (mtg.calUrl || '#') + '" target="_blank" style="font-size:10px;color:var(--text-muted);text-decoration:none" title="No linked doc -- open event to add one">\u{1F4C5}</a>') +
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

function addSubtask(taskId, text){
  if(!text.trim())return;
  const all=loadSubtasks();
  if(!all[taskId])all[taskId]=[];
  all[taskId].push({id:"st-"+Date.now(),text:text.trim(),done:false,created:new Date().toISOString()});
  saveSubtasks(all);
  render(); // Global guard in render() handles modal-open deferral
}
function toggleSubtask(taskId, stId){
  const all=loadSubtasks();
  if(!all[taskId])return;
  const st=all[taskId].find(s=>s.id===stId);
  if(st)st.done=!st.done;
  saveSubtasks(all);
  render();
}
function deleteSubtask(taskId, stId){
  const all=loadSubtasks();
  if(!all[taskId])return;
  all[taskId]=all[taskId].filter(s=>s.id!==stId);
  saveSubtasks(all);
  render();
}
function getIncompleteSubtasks(taskId){
  const all=loadSubtasks();
  return(all[taskId]||[]).filter(s=>!s.done);
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
  if(resolution==="individual"){
    toProcess.forEach(st=>{
      const id="st-sched-"+Date.now()+"-"+Math.random().toString(36).slice(2,6);
      let lastEnd="17:00";if(scheduled.length)lastEnd=scheduled[scheduled.length-1].end;
      const s=pt(lastEnd),d=30,e=s+d;
      scheduled.push({id,title:st.text,start:fmt(s),end:fmt(e),type:"task",meta:"30min · From: "+parentTitle,detail:"",source:"manual",priority:"Medium"});
    });
    saveScheduleOrder();recalcTimes();checkOverflow();
  } else if(resolution==="grouped"){
    const id="st-grp-"+Date.now();
    const title=toProcess.map(s=>s.text).join(", ");
    let lastEnd="17:00";if(scheduled.length)lastEnd=scheduled[scheduled.length-1].end;
    const s=pt(lastEnd),d=toProcess.length*15,e=s+d;
    scheduled.push({id,title:"Remaining: "+title,start:fmt(s),end:fmt(e),type:"task",meta:ms(d)+" · Grouped from: "+parentTitle,detail:"",source:"manual",priority:"Medium"});
    saveScheduleOrder();recalcTimes();checkOverflow();
  } else if(resolution==="move"&&moveTargetId){
    if(!all[moveTargetId])all[moveTargetId]=[];
    toProcess.forEach(st=>{
      all[moveTargetId].push({id:"st-"+Date.now()+"-"+Math.random().toString(36).slice(2),text:st.text,done:false,created:new Date().toISOString()});
    });
  }
  // Remove only the processed subtasks from source — leave others untouched
  all[taskId]=taskSubs.filter(s=>!toProcess.some(p=>p.id===s.id));
  saveSubtasks(all);
}

