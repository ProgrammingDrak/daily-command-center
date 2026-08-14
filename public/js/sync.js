// ======== SYNC BAR ========
function updateSync(){
  const section=document.getElementById("sync-section"),sum=document.getElementById("sync-sum");
  if(!section)return;
  if(!actionLog.length){section.style.display="none";return}
  section.style.display="block";
  const checks=actionLog.filter(a=>a.type==="checked").length,durs=Object.keys(durChanges).length;
  const reorders=actionLog.filter(a=>a.type==="reorder").length,adds=actionLog.filter(a=>a.type==="scheduled"||a.type==="created").length;
  let p=[];
  if(checks)p.push("<strong>"+checks+" done</strong>");if(durs)p.push('<span class="ch">'+durs+" adj</span>");
  if(reorders)p.push('<span class="ch">reorder</span>');if(adds)p.push('<span class="ch">'+adds+" added</span>");
  sum.innerHTML=p.join(" &middot; ");
}

// ======== NOTES & ACTION ITEMS ========
// Dual-mode: checks USE_BLOCKSTORE flags, falls back to localStorage
let NOTES_KEY = "pa-notes-" + (__state ? __state.date : "unknown");
let ACTIONS_KEY = "pa-actions-" + (__state ? __state.date : "unknown");
let DISMISS_KEY = "pa-dismissed-" + (__state ? __state.date : "unknown");

function loadNotes() {
  if (window.USE_BLOCKSTORE && window.USE_BLOCKSTORE.notes && window.blockStore) {
    const noteBlocks = [...window.blockStore.getByType("note"),...window.blockStore.getByType("block").filter(b=>(b.properties||{}).html&&(b.properties||{}).text&&b.parent_id)];
    const result = {};
    noteBlocks.forEach(b => {
      const taskId = b.properties._sourceTaskId || b.parent_id;
      result[taskId] = { html: b.properties.html, text: b.properties.text, _blockId: b.id };
    });
    return result;
  }
  try { return JSON.parse(localStorage.getItem(NOTES_KEY) || "{}"); } catch(e) { return {}; }
}
function saveNotes(data) {
  if (window.USE_BLOCKSTORE && window.USE_BLOCKSTORE.notes && window.blockStore) {
    // Save each changed note as a block
    for (const [taskId, val] of Object.entries(data)) {
      if (!val) continue;
      const html = typeof val === "string" ? val : (val.html || "");
      const text = typeof val === "string" ? val : (val.text || "");
      if (val._blockId) {
        window.blockStore.updateBlockDebounced(val._blockId, { html, text, _sourceTaskId: taskId });
      } else {
        // Create new note block
        window.blockStore.createBlock("block", { html, text, _sourceTaskId: taskId }, {
          parentId: window.blockStore.getDayRootId(),
          date: window.blockStore.getCurrentDate()
        }).then(block => { val._blockId = block.id; });
      }
    }
    return;
  }
  localStorage.setItem(NOTES_KEY, JSON.stringify(data)); scheduleIDBSave();
}

function seedNoteForTask(taskId, ev) {
  const pools = [];
  if (ev) pools.push([ev]);
  if (typeof scheduled !== "undefined" && Array.isArray(scheduled)) pools.push(scheduled);
  if (typeof INIT_SCHED !== "undefined" && Array.isArray(INIT_SCHED)) pools.push(INIT_SCHED);
  for (const pool of pools) {
    const item = pool.find(e => e && e.id === taskId);
    if (!item) continue;
    const seed = item.notes || item.detail || item.description || "";
    if (typeof seed === "string" && seed.trim()) return seed;
  }
  return "";
}

function noteBlocksForTask(taskId, noteVal, ev) {
  if(noteVal && typeof noteVal==="object" && noteVal.blocks && noteVal.blocks.length){
    return noteVal.blocks;
  } else if(noteVal && typeof noteVal==="object" && noteVal.html){
    return migrateHtmlToBlocks(noteVal.html);
  } else if(typeof noteVal==="string" && noteVal){
    return migrateHtmlToBlocks(noteVal);
  }
  const seed = seedNoteForTask(taskId, ev);
  return seed ? migrateHtmlToBlocks(seed) : null;
}

function loadActions() {
  if (window.USE_BLOCKSTORE && window.USE_BLOCKSTORE.actions && window.blockStore) {
    const actionBlocks = [...window.blockStore.getByType("action_item"),...window.blockStore.getByType("block").filter(b=>((b.properties||{}).tags||[]).includes("action-item"))];
    const result = {};
    actionBlocks.forEach(b => {
      const taskId = b.properties._sourceTaskId || b.parent_id;
      if (!result[taskId]) result[taskId] = [];
      result[taskId].push({ ...b.properties, _blockId: b.id });
    });
    return result;
  }
  try { return JSON.parse(localStorage.getItem(ACTIONS_KEY) || "{}"); } catch(e) { return {}; }
}
function saveActions(data) {
  if (window.USE_BLOCKSTORE && window.USE_BLOCKSTORE.actions && window.blockStore) {
    for (const [taskId, items] of Object.entries(data)) {
      if (!Array.isArray(items)) continue;
      items.forEach((item, i) => {
        if (item._blockId) {
          const metadata = {
            text: item.text, priority: item.priority,
            _sourceTaskId: taskId,
            ...(item._scheduled ? { scheduled: item._scheduled, scheduledAt: item._scheduledAt } : {}),
            ...(item._notionQueued ? { _notionQueued: true, _notionQueuedAt: item._notionQueuedAt } : {})
          };
          window.blockStore.updateBlock(item._blockId, metadata).then(() =>
            window.blockStore.setTaskCompletion(item._blockId,!!item.done,{
              taskDate:window.blockStore.getCurrentDate(),completedAt:item.done?(item.doneAt||new Date().toISOString()):null
            })
          ).catch(e=>console.warn("[actions] completion failed:",e));
        } else {
          window.blockStore.createBlock("block", {
            text: item.text, priority: item.priority || "Medium", done: !!item.done,
            _sourceTaskId: taskId, created: item.created || new Date().toISOString(),
            tags:["action-item"]
          }, {
            parentId: window.blockStore.getDayRootId(),
            date: window.blockStore.getCurrentDate(),
            sortOrder: (i + 1) * 1000        // C6c: 1000-spaced; a 0 would have meant "unset"
          }).then(block => { item._blockId = block.id; });
        }
      });
    }
    return;
  }
  localStorage.setItem(ACTIONS_KEY, JSON.stringify(data)); scheduleIDBSave();
}

function loadDismissed() {
  if (window.USE_BLOCKSTORE && window.blockStore) {
    const v = _bsProp("_dismissed", null);
    if (v) return v;
  }
  try { return JSON.parse(localStorage.getItem(DISMISS_KEY) || "{}"); } catch(e) { return {}; }
}
function saveDismissed(data) {
  if (_bsSaveProp("_dismissed", data)) return;
  localStorage.setItem(DISMISS_KEY, JSON.stringify(data)); scheduleIDBSave();
}

// C5b: `saveDoneState` IS GONE. Completion is written to the task ROW
// (`properties.status`), not to this day's `_done` overlay — see `_persistDone` in
// schedule.js, which is the one writer now.
//
// What it did and why it had to go: it rewrote `_done` WHOLESALE from the in-memory
// `manualDone` set on every check-off, so any window where `manualDone` was narrower
// than what was persisted silently un-completed the difference — permanently, because
// `collectUnfinished` then put every one of them back on today. A read-merge-union
// would have been the wrong fix (it makes un-checking impossible). Writing the fact to
// the row it belongs to is the right one: a completion travels with the task across
// days instead of being a per-day fact about an id.
//
// `DONE_KEY` and `loadDoneState` SURVIVE, deliberately, as READS only. `_done` is now
// legacy data that nothing adds to, in exactly the shape C3 left legacy `_pushed` in:
// still load-bearing for pre-migration days. Measured on prod 2026-08-04 before
// deciding (the counts are in phase-C5b-complete.md): of the 401 overlay entries, 23
// are still the ONLY representation of a real completion — 12 whose local_id is shared
// by 2+ rows, so migration 002's resolver refused to guess and left every candidate
// row reading `status:'open'`, and 11 that render from `schedule.timeline` on an
// archive day with no row at all. Dropping the read flips those 23 finished tasks back
// to open on Drake's real days. A4 removes the keys; this phase removes the WRITES.
let DONE_KEY = "pa-done-" + (__state ? __state.date : "unknown");
function loadDoneState() {
  if (window.USE_BLOCKSTORE && window.blockStore) {
    const v = _bsProp("_done", null);
    if (v) return { ids: v.ids || [], at: v.at || {} };
  }
  try { const d = JSON.parse(localStorage.getItem(DONE_KEY) || "{}"); return { ids: d.ids || [], at: d.at || {} }; } catch(e) { return { ids: [], at: {} }; }
}

let SESSIONS_KEY = "pa-sessions-" + (__state ? __state.date : "unknown");
function loadSessions() {
  if (window.USE_BLOCKSTORE && window.blockStore) {
    const v = _bsProp("_sessions", null);
    if (v) return v;
  }
  try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || "{}"); } catch(e) { return {}; }
}
function saveSessions(data) {
  if (_bsSaveProp("_sessions", data)) return;
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(data)); scheduleIDBSave();
}

// Restore checked state from localStorage (survives re-renders)
(function() {
  const saved = loadDoneState();
  saved.ids.forEach(id => manualDone.add(id));
  Object.assign(doneAt, saved.at);
})();

let currentNotesTaskId = null;
const notesSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const actionSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';

// Legacy stubs (toolbar removed, block editor handles formatting)
function notesCmd(cmd){}
function notesInsertCheckbox(){}
function notesCheckboxChanged(){}

// Block editor instance for notes drawer (window-scoped so tabs.js can share it)
window._notesBlockEditor=null;

function openNotesDrawer(taskId, taskTitle) {
  currentNotesTaskId = taskId;
  document.getElementById("notes-drawer-task-title").textContent = taskTitle || "Notes";
  const notes = loadNotes();
  const val = notes[taskId];
  const container = document.getElementById("notes-block-editor");

  const initialBlocks=noteBlocksForTask(taskId, val);

  // Create or re-initialize block editor
  if(window._notesBlockEditor) window._notesBlockEditor.destroy();
  window._notesBlockEditor=createBlockEditor(container, initialBlocks);

  renderActionItems(taskId);
  document.getElementById("notes-action-input").style.display = "none";
  const taskBar = document.getElementById("task-add-notes");
  if (taskBar) {
    taskBar.style.display = "none";
    const t = taskBar.querySelector(".tab-title");
    if (t) { t.value = ""; t.classList.remove("tab-error"); }
  }
  document.getElementById("notes-drawer-overlay").classList.add("open");
  window._notesBlockEditor.focus();
}
function closeNotesDrawer() {
  if (currentNotesTaskId && window._notesBlockEditor) {
    const notes = loadNotes();
    const blocks=window._notesBlockEditor.getBlocks();
    notes[currentNotesTaskId] = {
      blocks: blocks,
      html: window._notesBlockEditor.toHtml(),
      text: window._notesBlockEditor.toMarkdown()
    };
    saveNotes(notes);
  }
  document.getElementById("notes-drawer-overlay").classList.remove("open");
  currentNotesTaskId = null;
  if(typeof _flushDeferredRender==='function')_flushDeferredRender();
  else render();
}
function renderActionItems(taskId) {
  const actions = loadActions();
  const items = actions[taskId] || [];
  document.getElementById("notes-ai-count").textContent = "(" + items.length + ")";
  const list = document.getElementById("notes-ai-list");
  if (!items.length) { list.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:4px 0">No action items yet.</div>'; return; }
  list.innerHTML = items.map((item, idx) => {
    const scheduled = item._scheduled ? ' queued' : '';
    const queued = item._notionQueued ? ' queued' : '';
    return '<div class="notes-ai-item">' +
      '<div class="ai-check' + (item.done ? " done" : "") + '" onclick="toggleActionDone(\'' + taskId + '\',' + idx + ')">\u2713</div>' +
      '<span class="ai-text"' + (item.done ? ' style="text-decoration:line-through;opacity:0.5"' : '') + '>' + item.text + '</span>' +
      '<span class="ai-pri ai-pri-' + item.priority + '">' + item.priority + '</span>' +
      (item._scheduled ? '<span class="ai-sched-btn queued">Scheduled</span>' :
        '<span class="ai-sched-btn" onclick="event.stopPropagation();scheduleActionToday(\'' + taskId + '\',' + idx + ')" title="Add to today\'s schedule">Today</span>') +
      (item._notionQueued ? '<span class="ai-sched-btn later queued">Queued</span>' :
        '<span class="ai-sched-btn later" onclick="event.stopPropagation();queueActionForLater(\'' + taskId + '\',' + idx + ')" title="Create as Notion task for later">Later</span>') +
      '<span class="ai-del" onclick="deleteAction(\'' + taskId + '\',' + idx + ')">&times;</span>' +
    '</div>';
  }).join('');
}
function addActionItem(taskId) {
  const text = document.getElementById("notes-action-text").value.trim();
  if (!text) return;
  const priority = document.getElementById("notes-action-priority").value;
  const actions = loadActions();
  if (!actions[taskId]) actions[taskId] = [];
  actions[taskId].push({ text, priority, done: false, created: new Date().toISOString() });
  saveActions(actions);
  const todayBtn = document.getElementById("notes-action-today");
  if (todayBtn && todayBtn.classList.contains("active")) {
    const durMin = parseInt(document.getElementById("notes-action-dur").value) || 30;
    insertTaskFromDrawer(text, durMin);
  }
  document.getElementById("notes-action-text").value = "";
  todayBtn && todayBtn.classList.remove("active");
  const durSel = document.getElementById("notes-action-dur");
  if (durSel) durSel.style.display = "none";
  document.getElementById("notes-action-input").style.display = "none";
  renderActionItems(taskId);
  buildActionItemsTab();
}
function toggleActionDone(taskId, idx) {
  const actions = loadActions();
  if (actions[taskId] && actions[taskId][idx]) {
    actions[taskId][idx].done = !actions[taskId][idx].done;
    saveActions(actions);
    renderActionItems(taskId);
  }
}
function deleteAction(taskId, idx) {
  const actions = loadActions();
  if (actions[taskId]) { actions[taskId].splice(idx, 1); saveActions(actions); renderActionItems(taskId); }
}

// ======== ACTION ITEM SCHEDULING ========
const PENDING_TASKS_KEY = "pa-pending-tasks";
function _pendingTaskBlocks(){
  if(!window.USE_BLOCKSTORE||!window.USE_BLOCKSTORE.pendingTasks||!window.blockStore)return[];
  const legacy=window.blockStore.getByType("pending_task")||[];
  const unified=window.blockStore.getByType("block").filter(b=>(b.properties||{}).kind==="pending_task");
  const seen=new Set();
  return legacy.concat(unified).filter(b=>{if(seen.has(b.id))return false;seen.add(b.id);return true});
}
function loadPendingTasks(){
  const blocks=_pendingTaskBlocks();
  if(blocks.length){
    return blocks.map(b=>{
      const p=b.properties||{};
      return {...p,id:p.local_id||p.id||b.id,_blockId:b.id};
    }).filter(t=>t.status!=="deleted"&&t.status!=="archived");
  }
  try{return JSON.parse(localStorage.getItem(PENDING_TASKS_KEY)||"[]")}catch(e){return[]}
}
function savePendingTasks(tasks){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.pendingTasks&&window.blockStore){
    const desired=Array.isArray(tasks)?tasks:[];
    const blocks=_pendingTaskBlocks();
    const byLocal=new Map(blocks.map(b=>[(b.properties||{}).local_id||b.id,b]));
    const keep=new Set();
    desired.forEach((task,idx)=>{
      const localId=task.id||("pending-"+Date.now()+"-"+idx);
      keep.add(localId);
      const props={...task,kind:"pending_task",local_id:localId,id:localId,updatedAt:new Date().toISOString()};
      const existing=task._blockId?window.blockStore.get(task._blockId):byLocal.get(localId);
      if(existing)window.blockStore.updateBlock(existing.id,{...(existing.properties||{}),...props});
      else window.blockStore.createBlock("block",props,{date:null,sortOrder: (idx + 1) * 1000});
    });
    blocks.forEach(block=>{
      const localId=(block.properties||{}).local_id||block.id;
      if(!keep.has(localId))window.blockStore.deleteBlock(block.id);
    });
    exportPendingTasks();
    return;
  }
  localStorage.setItem(PENDING_TASKS_KEY,JSON.stringify(tasks)); scheduleIDBSave(); exportPendingTasks();
}

function scheduleActionToday(taskId, idx){
  const actions=loadActions();
  if(!actions[taskId]||!actions[taskId][idx])return;
  const item=actions[taskId][idx];
  if(item._scheduled)return;
  // Duplicate check: bail if a non-done task with the same title already exists
  if(typeof scheduled!=="undefined"&&DCC.TaskModel.selectOpen(scheduled).some(s=>s.title===item.text)){
    if(typeof showToast==="function")showToast("Already in today's schedule","info");
    return;
  }
  insertTaskFromDrawer(item.text, 30);
  item._scheduled=true;
  item._scheduledAt=new Date().toISOString();
  saveActions(actions);
  if(typeof showToast==="function")showToast("Added to today's schedule","success");
  // Re-render whichever list is showing
  if(document.getElementById("done-modal-overlay").classList.contains("open")) renderDmActions(taskId);
  else renderActionItems(taskId);
}

function queueActionForLater(taskId, idx){
  const actions=loadActions();
  if(!actions[taskId]||!actions[taskId][idx])return;
  const item=actions[taskId][idx];
  if(item._notionQueued)return;
  // Find the parent task/event title for context
  const parentEv=scheduled.find(e=>e.id===taskId);
  const parentTitle=parentEv?parentEv.title:taskId;
  // Queue for Notion task creation
  const pending=loadPendingTasks();
  pending.push({
    id:"pending-"+(Date.now()),
    title: item.text,
    priority: item.priority || "Medium",
    source_task: parentTitle,
    source_task_id: taskId,
    created_at: new Date().toISOString(),
    status: "queued"
  });
  savePendingTasks(pending);
  // Mark item as queued
  item._notionQueued=true;
  item._notionQueuedAt=new Date().toISOString();
  saveActions(actions);
  if(typeof showToast==="function")showToast("Queued for Priority review","success");
  if(document.getElementById("done-modal-overlay").classList.contains("open")) renderDmActions(taskId);
  else renderActionItems(taskId);
}

// Export pending tasks to a DOM element the render script / PA can read
function exportPendingTasks(){
  let el=document.getElementById("pending-tasks-export");
  if(!el){el=document.createElement("script");el.id="pending-tasks-export";el.type="application/json";document.body.appendChild(el);}
  el.textContent=JSON.stringify(loadPendingTasks());
}
