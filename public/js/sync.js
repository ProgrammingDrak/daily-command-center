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
function buildClip(){
  if(!actionLog.length)return"";
  let t="Daily Command Center Sync -- "+new Date().toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:true})+"\n\n";
  const checked=scheduled.filter(ev=>manualDone.has(ev.id));
  if(checked.length){t+="COMPLETED:\n";checked.forEach(ev=>{t+="- "+ev.title+" ("+f12(ev.start)+" - "+f12(ev.end)+")"+(ev.notionUrl?" [Notion: "+ev.notionUrl+"]":"")+"\n"});t+="\n"}
  const dk=Object.keys(durChanges);
  if(dk.length){t+="DURATION CHANGES:\n";dk.forEach(id=>{const ev=scheduled.find(e=>e.id===id)||{title:id};const dc=durChanges[id];t+="- "+ev.title+": "+dc.original+"min -> "+dc.current+"min\n"});t+="\n"}
  const orig=INIT_SCHED.map(e=>e.id).join(","),cur=scheduled.map(e=>e.id).join(",");
  if(orig!==cur){t+="REORDERED SCHEDULE:\n";scheduled.forEach((ev,i)=>{t+=(i+1)+". "+ev.title+" ("+f12(ev.start)+" - "+f12(ev.end)+")\n"});t+="\n"}
  const added=scheduled.filter(ev=>!INIT_SCHED.find(o=>o.id===ev.id));
  if(added.length){t+="NEWLY SCHEDULED:\n";added.forEach(ev=>{t+="- "+ev.title+" ("+dur(ev)+"min)"+(ev.notionUrl?" [Notion: "+ev.notionUrl+"]":"")+"\n"});t+="\n"}
  const allFu=scheduled.flatMap(ev=>(ev.followups||[]).map(f=>({...f,from:ev.title})));
  if(allFu.length){t+="UNSCHEDULED ACTION ITEMS:\n";allFu.forEach(f=>{t+="- "+f.title+" (from: "+f.from+")"+(f.href?" [Notion: "+f.href+"]":"")+"\n"});t+="\n"}
  if(consider.length){t+="CONSIDER FOR TODAY (not yet scheduled):\n";consider.forEach(b=>{t+="- "+b.title+" ("+b.durMin+"min, "+b.priority+" priority)"+(b.notionUrl?" [Notion: "+b.notionUrl+"]":"")+"\n"});t+="\n"}
  if(backlog.length){t+="STILL IN BACKLOG:\n";backlog.forEach(b=>{t+="- "+b.title+" ("+b.durMin+"min, "+b.stage+")"+(b.notionUrl?" [Notion: "+b.notionUrl+"]":"")+"\n"});t+="\n"}
  // Include action items from triage, consider, and backlog cards
  const allActions=loadActions();
  const triageActionIds=INIT_TRIAGE.map(i=>i.id).filter(id=>allActions[id]&&allActions[id].length);
  const otherActionIds=[...consider.map(c=>c.id),...backlog.map(b=>b.id)].filter(id=>allActions[id]&&allActions[id].length);
  const allItemActionIds=[...triageActionIds,...otherActionIds];
  if(allItemActionIds.length){
    t+="ACTION ITEMS FROM TRIAGE/BOARD:\n";
    allItemActionIds.forEach(id=>{
      const items=allActions[id].filter(a=>!a.done);
      if(items.length){
        const source=INIT_TRIAGE.find(i=>i.id===id)||consider.find(c=>c.id===id)||backlog.find(b=>b.id===id)||{title:id};
        t+="  "+source.title+":\n";
        items.forEach(a=>{t+="    - ["+a.priority+"] "+a.text+"\n"});
      }
    });
    t+="\n";
  }
  // Include items needing review
  const reviewed=loadReviewed();
  const completionsData=(__state&&__state.completions&&__state.completions.tasks)||[];
  const unreviewed=completionsData.filter(c=>c.needs_review&&!reviewed[c.task_id]);
  if(unreviewed.length){
    t+="NEEDS REVIEW (auto-completed):\n";
    unreviewed.forEach(c=>{t+="- "+c.title+" -- "+c.evidence_summary+"\n"});
    t+="\n";
  }
  t+="Please update Notion (close completed tasks, note duration changes) and adjust my calendar if anything was reordered.";
  return t;
}

// ======== NOTES & ACTION ITEMS (localStorage) ========
let NOTES_KEY = "pa-notes-" + (__state ? __state.date : "unknown");
let ACTIONS_KEY = "pa-actions-" + (__state ? __state.date : "unknown");
let DISMISS_KEY = "pa-dismissed-" + (__state ? __state.date : "unknown");

function loadNotes() { try { return JSON.parse(localStorage.getItem(NOTES_KEY) || "{}"); } catch(e) { return {}; } }
function saveNotes(data) { localStorage.setItem(NOTES_KEY, JSON.stringify(data)); scheduleIDBSave(); }
function loadActions() { try { return JSON.parse(localStorage.getItem(ACTIONS_KEY) || "{}"); } catch(e) { return {}; } }
function saveActions(data) { localStorage.setItem(ACTIONS_KEY, JSON.stringify(data)); scheduleIDBSave(); }
function loadDismissed() { try { return JSON.parse(localStorage.getItem(DISMISS_KEY) || "{}"); } catch(e) { return {}; } }
function saveDismissed(data) { localStorage.setItem(DISMISS_KEY, JSON.stringify(data)); scheduleIDBSave(); }

let DONE_KEY = "pa-done-" + (__state ? __state.date : "unknown");
function loadDoneState() { try { const d = JSON.parse(localStorage.getItem(DONE_KEY) || "{}"); return { ids: d.ids || [], at: d.at || {} }; } catch(e) { return { ids: [], at: {} }; } }
function saveDoneState() { localStorage.setItem(DONE_KEY, JSON.stringify({ ids: [...manualDone], at: doneAt })); scheduleIDBSave(); }
let SESSIONS_KEY = "pa-sessions-" + (__state ? __state.date : "unknown");
function loadSessions() { try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || "{}"); } catch(e) { return {}; } }
function saveSessions(data) { localStorage.setItem(SESSIONS_KEY, JSON.stringify(data)); scheduleIDBSave(); }

// ======== POMODORO STATE PERSISTENCE (localStorage) ========
let POMO_STATE_KEY = "pa-pomo-state-" + (__state ? __state.date : "unknown");
function savePomoState() {
  const data = {
    title: pomoState.title, workMin: pomoState.workMin, mode: pomoState.mode,
    total: pomoState.total, remaining: pomoState.remaining, running: pomoState.running,
    sessions: pomoState.sessions, soundOn: pomoState.soundOn, sessionLog: pomoState.sessionLog,
    taskTime: pomoState.taskTime, taskDone: pomoState.taskDone, stackedSessions: pomoState.stackedSessions,
    savedAt: Date.now()
  };
  try { localStorage.setItem(POMO_STATE_KEY, JSON.stringify(data)); scheduleIDBSave(); } catch(e) {}
}
function loadPomoState() {
  try { const raw = localStorage.getItem(POMO_STATE_KEY); return raw ? JSON.parse(raw) : null; } catch(e) { return null; }
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

function notesCmd(cmd){ document.execCommand(cmd,false,null); document.getElementById("notes-editable").focus(); }
function notesInsertCheckbox(){
  const cb='<label style="cursor:pointer"><input type="checkbox" class="note-checkbox" onchange="notesCheckboxChanged()"> </label>';
  document.execCommand('insertHTML',false,cb);
  document.getElementById("notes-editable").focus();
}
function notesCheckboxChanged(){ if(currentNotesTaskId){ const notes=loadNotes(); const ed=document.getElementById("notes-editable"); notes[currentNotesTaskId]={html:ed.innerHTML,text:ed.innerText.trim()}; saveNotes(notes); } }

function openNotesDrawer(taskId, taskTitle) {
  currentNotesTaskId = taskId;
  document.getElementById("notes-drawer-task-title").textContent = taskTitle || "Notes";
  const notes = loadNotes();
  const val = notes[taskId];
  const ed = document.getElementById("notes-editable");
  if (val && typeof val === "object" && val.html) { ed.innerHTML = val.html; }
  else if (typeof val === "string" && val) { ed.innerText = val; }
  else { ed.innerHTML = ""; }
  renderActionItems(taskId);
  document.getElementById("notes-action-input").style.display = "none";
  document.getElementById("notes-drawer-overlay").classList.add("open");
  ed.focus();
}
function closeNotesDrawer() {
  if (currentNotesTaskId) {
    const notes = loadNotes();
    const ed = document.getElementById("notes-editable");
    notes[currentNotesTaskId] = { html: ed.innerHTML, text: ed.innerText.trim() };
    saveNotes(notes);
  }
  document.getElementById("notes-drawer-overlay").classList.remove("open");
  currentNotesTaskId = null;
  render();
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
function loadPendingTasks(){ try{return JSON.parse(localStorage.getItem(PENDING_TASKS_KEY)||"[]")}catch(e){return[]} }
function savePendingTasks(tasks){ localStorage.setItem(PENDING_TASKS_KEY,JSON.stringify(tasks)); scheduleIDBSave(); exportPendingTasks(); }

function scheduleActionToday(taskId, idx){
  const actions=loadActions();
  if(!actions[taskId]||!actions[taskId][idx])return;
  const item=actions[taskId][idx];
  if(item._scheduled)return;
  insertTaskFromDrawer(item.text, 30);
  item._scheduled=true;
  item._scheduledAt=new Date().toISOString();
  saveActions(actions);
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
  if(document.getElementById("done-modal-overlay").classList.contains("open")) renderDmActions(taskId);
  else renderActionItems(taskId);
}

// Export pending tasks to a DOM element the render script / PA can read
function exportPendingTasks(){
  let el=document.getElementById("pending-tasks-export");
  if(!el){el=document.createElement("script");el.id="pending-tasks-export";el.type="application/json";document.body.appendChild(el);}
  el.textContent=JSON.stringify(loadPendingTasks());
}

