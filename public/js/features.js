// ======== TRIVIAL TASKS ========
const TRIV_KEY = "pa-trivial-tasks";
let TRIV_FLAGS_KEY = "pa-trivial-flags-" + ((__state && __state.date) ? __state.date : "unknown");

function loadTrivialTasks(){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.trivialTasks&&window.blockStore){
    return (window.blockStore.getByType("trivial_task")||[]).concat(window.blockStore.getByType("block").filter(b=>(b.properties||{}).tags&&b.properties.tags.includes("trivial"))).map(b=>({
      id:b.id, text:b.properties.text, done:!!b.properties.done,
      createdAt:b.created_at, doneAt:b.properties.doneAt||null,
      linkedTo:b.properties.linkedTo||null, _blockId:b.id
    }));
  }
  try{return JSON.parse(localStorage.getItem(TRIV_KEY)||"[]")}catch(e){return[]}
}
function saveTrivialTasks(t){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.trivialTasks&&window.blockStore)return; // BlockStore handles saves directly
  try{localStorage.setItem(TRIV_KEY,JSON.stringify(t));scheduleIDBSave()}catch(e){}
}
function loadTrivialFlags(){
  if(window.USE_BLOCKSTORE&&Object.values(window.USE_BLOCKSTORE).every(v=>v)&&window.blockStore){
    const dayRoot=window.blockStore.get(window.blockStore.getDayRootId());
    return (dayRoot&&dayRoot.properties._trivialFlags)||{};
  }
  try{return JSON.parse(localStorage.getItem(TRIV_FLAGS_KEY)||"{}")}catch(e){return{}}
}
function saveTrivialFlags(f){
  if(window.USE_BLOCKSTORE&&Object.values(window.USE_BLOCKSTORE).every(v=>v)&&window.blockStore){
    const dayRootId=window.blockStore.getDayRootId();
    const root=window.blockStore.get(dayRootId);
    if(root){window.blockStore.updateBlock(dayRootId,{...root.properties,_trivialFlags:f});}
    return;
  }
  try{localStorage.setItem(TRIV_FLAGS_KEY,JSON.stringify(f));scheduleIDBSave()}catch(e){}
}

function addTrivialTask(text){
  if(!text.trim())return;
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.trivialTasks&&window.blockStore){
    window.blockStore.createBlock("block",{text:text.trim(),done:false,tags:["trivial"]}).then(()=>buildTrivialTasks());
    return;
  }
  const tasks=loadTrivialTasks();
  tasks.push({id:"triv-"+Date.now(),text:text.trim(),done:false,createdAt:new Date().toISOString()});
  saveTrivialTasks(tasks);
  buildTrivialTasks();
}
function toggleTrivialTask(id){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.trivialTasks&&window.blockStore){
    const block=window.blockStore.get(id);
    if(block){
      const newDone=!block.properties.done;
      window.blockStore.updateBlock(id,{...block.properties,done:newDone,doneAt:newDone?new Date().toISOString():null}).then(()=>buildTrivialTasks());
    }
    return;
  }
  const tasks=loadTrivialTasks();
  const t=tasks.find(x=>x.id===id);
  if(t){t.done=!t.done;t.doneAt=t.done?new Date().toISOString():null;}
  saveTrivialTasks(tasks);
  buildTrivialTasks();
}
function deleteTrivialTask(id){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.trivialTasks&&window.blockStore){
    window.blockStore.deleteBlock(id).then(()=>buildTrivialTasks());
    return;
  }
  saveTrivialTasks(loadTrivialTasks().filter(x=>x.id!==id));
  buildTrivialTasks();
}
function toggleTrivialFlag(evId){
  const flags=loadTrivialFlags();
  if(flags[evId])delete flags[evId];else flags[evId]=true;
  saveTrivialFlags(flags);
  // Phase 7: rebuild schedule (hides/shows flagged items) and triage (shows flagged items)
  if(typeof buildSchedule==='function')buildSchedule();
  if(typeof buildTrivialTasks==='function')buildTrivialTasks();
  if(typeof updateStats==='function')updateStats();
}

// Phase 7c: Link/unlink trivial tasks to schedule items
function getLinkedTrivialTasks(scheduleId){
  const tasks=loadTrivialTasks();
  return tasks.filter(t=>t.linkedTo===scheduleId);
}

function addLinkedTrivialTask(scheduleId, text){
  if(!text.trim())return;
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.trivialTasks&&window.blockStore){
    window.blockStore.createBlock("block",{text:text.trim(),done:false,linkedTo:scheduleId,tags:["trivial"]}).then(()=>{
      if(typeof buildSchedule==='function')buildSchedule();
      if(typeof buildTrivialTasks==='function')buildTrivialTasks();
    });
    return;
  }
  const tasks=loadTrivialTasks();
  tasks.push({id:"triv-"+Date.now(),text:text.trim(),done:false,linkedTo:scheduleId,createdAt:new Date().toISOString()});
  saveTrivialTasks(tasks);
}

function linkTrivialToSchedule(trivialId, scheduleId){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.trivialTasks&&window.blockStore){
    const block=window.blockStore.get(trivialId);
    if(block){
      window.blockStore.updateBlock(trivialId,{...block.properties,linkedTo:scheduleId}).then(()=>{
        if(typeof buildSchedule==='function')buildSchedule();
        if(typeof buildTrivialTasks==='function')buildTrivialTasks();
      });
    }
    return;
  }
  const tasks=loadTrivialTasks();
  const t=tasks.find(x=>x.id===trivialId);
  if(t){t.linkedTo=scheduleId;saveTrivialTasks(tasks);}
}

function unlinkTrivialFromSchedule(trivialId){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.trivialTasks&&window.blockStore){
    const block=window.blockStore.get(trivialId);
    if(block){
      const props={...block.properties};delete props.linkedTo;
      window.blockStore.updateBlock(trivialId,props).then(()=>{
        if(typeof buildTrivialTasks==='function')buildTrivialTasks();
      });
    }
    return;
  }
  const tasks=loadTrivialTasks();
  const t=tasks.find(x=>x.id===trivialId);
  if(t){delete t.linkedTo;saveTrivialTasks(tasks);}
}

// Phase 7d: Trivial task picker dropdown
function openTrivialPicker(scheduleId, anchorEl){
  document.querySelectorAll(".triv-picker-popup").forEach(p=>p.remove());
  const tasks=loadTrivialTasks().filter(t=>!t.done&&!t.linkedTo);
  if(!tasks.length){
    const pop=document.createElement("div");pop.className="triv-picker-popup";
    pop.innerHTML='<div style="padding:8px;font-size:11px;color:var(--text-muted)">No unlinked trivial tasks. Add one first.</div>';
    anchorEl.parentElement.appendChild(pop);
    setTimeout(()=>document.addEventListener("click",()=>pop.remove(),{once:true}),10);
    return;
  }
  const pop=document.createElement("div");pop.className="triv-picker-popup";
  tasks.forEach(t=>{
    const opt=document.createElement("div");opt.className="triv-picker-opt";
    opt.textContent=t.text;
    opt.addEventListener("click",e=>{
      e.stopPropagation();pop.remove();
      linkTrivialToSchedule(t.id,scheduleId);
    });
    pop.appendChild(opt);
  });
  anchorEl.parentElement.appendChild(pop);
  setTimeout(()=>document.addEventListener("click",()=>pop.remove(),{once:true}),10);
}

// ======== TASK DETAIL MODAL (Notes + Subtasks + Trivial + Action Items) ========
let _addModalTaskId = null;

function _persistTaskTags(taskId, tagIds) {
  if (window.USE_BLOCKSTORE && window.USE_BLOCKSTORE.addedTasks && window.blockStore) {
    // Check added_task blocks (legacy + new "block" type with scheduled_dates)
    var addedBlocks = (window.blockStore.getByType('added_task')||[]).concat(window.blockStore.getByType('block').filter(function(b){return (b.properties||{}).scheduled_dates;}));
    var block = addedBlocks.find(function(b) { return (b.properties||{}).local_id === taskId; });
    if (block) {
      window.blockStore.updateBlock(block.id, Object.assign({}, block.properties, {tags: tagIds}));
      return;
    }
    // Check schedule_item blocks (legacy + new "block" type)
    var schedBlocks = (window.blockStore.getByType('schedule_item')||[]).concat(window.blockStore.getByType('block').filter(function(b){return (b.properties||{}).start||(b.properties||{}).end;}));
    var sBlock = schedBlocks.find(function(b) { return (b.properties||{}).local_id === taskId || b.id === taskId; });
    if (sBlock) {
      window.blockStore.updateBlock(sBlock.id, Object.assign({}, sBlock.properties, {tags: tagIds}));
      return;
    }
  }
  // Fallback: IDB save
  if (typeof scheduleIDBSave === 'function') scheduleIDBSave();
}

function openAddModal(taskId, taskTitle) {
  _addModalTaskId = taskId;
  document.getElementById('add-modal-title').textContent = taskTitle || 'Task Details';

  // Initialize tag picker
  var tagContainer = document.getElementById('am-tag-picker');
  if (tagContainer && typeof createTagPicker === 'function') {
    var taskEntry = (typeof scheduled !== 'undefined') ? scheduled.find(function(ev) { return ev.id === taskId; }) : null;
    var currentTags = (taskEntry && taskEntry.tags) ? taskEntry.tags : [];
    createTagPicker(tagContainer, currentTags, function(newIds) {
      if (taskEntry) taskEntry.tags = newIds;
      _persistTaskTags(taskId, newIds);
    });
  }

  // Load notes into block editor
  var notes = loadNotes();
  var noteVal = notes[taskId];
  var initialBlocks=null;
  if(noteVal && typeof noteVal==="object" && noteVal.blocks && noteVal.blocks.length){
    initialBlocks=noteVal.blocks;
  } else if(noteVal && typeof noteVal==="object" && noteVal.html){
    initialBlocks=migrateHtmlToBlocks(noteVal.html);
  } else if(typeof noteVal==="string" && noteVal){
    initialBlocks=migrateHtmlToBlocks(noteVal);
  }
  if(window._amBlockEditor) window._amBlockEditor.destroy();
  window._amBlockEditor=createBlockEditor(document.getElementById('am-notes-block-editor'), initialBlocks);

  // Render combined items list
  renderModalItems(taskId);

  // Reset add input
  document.getElementById('am-item-input').value = '';
  document.getElementById('am-trivial-picker').style.display = 'none';

  document.getElementById('add-modal-overlay').classList.add('open');
  setTimeout(function() { if(window._amBlockEditor) window._amBlockEditor.focus(); }, 80);
}

function closeAddModal() {
  // Save notes from block editor on close
  if (_addModalTaskId && window._amBlockEditor) {
    var notes = loadNotes();
    if(!window._amBlockEditor.isEmpty()){
      var blocks=window._amBlockEditor.getBlocks();
      notes[_addModalTaskId]={blocks:blocks, html:window._amBlockEditor.toHtml(), text:window._amBlockEditor.toMarkdown()};
    } else { delete notes[_addModalTaskId]; }
    saveNotes(notes);
  }
  document.getElementById('add-modal-overlay').classList.remove('open');
  _addModalTaskId = null;
  // Flush any deferred renders now that modal is closed
  _flushDeferredRender();
}

function renderModalItems(taskId) {
  var list = document.getElementById('am-items-list');
  if (!list) return;

  // Collect all items with their types and timestamps
  var items = [];

  // Subtasks
  var subs = (typeof loadSubtasks === 'function' ? loadSubtasks() : {})[taskId] || [];
  subs.forEach(function(st) {
    items.push({ type: 'subtask', id: st.id, text: st.text, done: !!st.done, created: st.created || '2000-01-01' });
  });

  // Linked trivial tasks
  var linked = getLinkedTrivialTasks(taskId);
  linked.forEach(function(t) {
    items.push({ type: 'trivial', id: t.id, text: t.text, done: !!t.done, created: t.createdAt || '2000-01-01' });
  });

  // Action items
  var actions = loadActions();
  var taskActions = actions[taskId] || [];
  taskActions.forEach(function(a, i) {
    items.push({ type: 'action', id: 'action-' + i, idx: i, text: a.text, done: !!a.done, priority: a.priority, created: a.created || '2000-01-01' });
  });

  // Update count
  document.getElementById('am-items-count').textContent = '(' + items.length + ')';

  if (!items.length) {
    list.innerHTML = '<div class="am-empty">No items yet. Add subtasks, trivial tasks, or action items below.</div>';
    return;
  }

  // Render in order added (by creation time)
  var tagColors = { subtask: 'var(--text-muted)', trivial: 'var(--cyan)', action: 'var(--amber)' };
  var tagLabels = { subtask: 'Sub', trivial: '⚡ Triv', action: 'Action' };

  list.innerHTML = items.map(function(item) {
    return '<div class="am-item" data-type="' + item.type + '" data-id="' + item.id + '">' +
      '<div class="am-check' + (item.done ? ' done' : '') + '">' + (item.done ? '✓' : '') + '</div>' +
      '<span class="am-text' + (item.done ? ' done' : '') + '">' + item.text + '</span>' +
      '<span class="am-tag" style="color:' + tagColors[item.type] + '">' + tagLabels[item.type] + '</span>' +
      (item.priority ? '<span class="am-pri" style="color:' + (item.priority === 'High' ? 'var(--red)' : item.priority === 'Medium' ? 'var(--amber)' : 'var(--text-muted)') + '">' + item.priority + '</span>' : '') +
      '<button class="am-del">✕</button>' +
    '</div>';
  }).join('');

  // Wire up event listeners
  list.querySelectorAll('.am-item').forEach(function(el) {
    var type = el.dataset.type;
    var id = el.dataset.id;
    el.querySelector('.am-check').addEventListener('click', function(e) {
      e.stopPropagation();
      if (type === 'subtask') { toggleSubtask(taskId, id); }
      else if (type === 'trivial') { toggleTrivialTask(id); }
      else if (type === 'action') {
        var idx = parseInt(id.replace('action-', ''));
        var acts = loadActions();
        if (acts[taskId] && acts[taskId][idx]) { acts[taskId][idx].done = !acts[taskId][idx].done; saveActions(acts); }
      }
      renderModalItems(taskId);
    });
    el.querySelector('.am-del').addEventListener('click', function(e) {
      e.stopPropagation();
      if (type === 'subtask') { deleteSubtask(taskId, id); }
      else if (type === 'trivial') { unlinkTrivialFromSchedule(id); }
      else if (type === 'action') {
        var idx = parseInt(id.replace('action-', ''));
        var acts = loadActions();
        if (acts[taskId]) { acts[taskId].splice(idx, 1); saveActions(acts); }
      }
      renderModalItems(taskId);
    });
  });
}

// Wire up modal events after DOM loads
document.addEventListener('DOMContentLoaded', function() {
  // Close
  document.getElementById('add-modal-close').addEventListener('click', closeAddModal);
  document.getElementById('add-modal-done').addEventListener('click', closeAddModal);
  document.getElementById('add-modal-overlay').addEventListener('click', function(e) {
    if (e.target === e.currentTarget) closeAddModal();
  });

  // Add item (subtask, trivial, or action — based on type dropdown)
  function addModalItem() {
    var inp = document.getElementById('am-item-input');
    var typeSelect = document.getElementById('am-item-type');
    var text = inp.value.trim();
    if (!text || !_addModalTaskId) return;
    var type = typeSelect.value;

    if (type === 'subtask') {
      addSubtask(_addModalTaskId, text);
    } else if (type === 'trivial') {
      addLinkedTrivialTask(_addModalTaskId, text);
      // Longer delay for async BlockStore write
      setTimeout(function() { renderModalItems(_addModalTaskId); }, 300);
    } else if (type === 'action') {
      var acts = loadActions();
      if (!acts[_addModalTaskId]) acts[_addModalTaskId] = [];
      acts[_addModalTaskId].push({ text: text, priority: 'Medium', done: false, created: new Date().toISOString() });
      saveActions(acts);
    }

    inp.value = '';
    // Small delay for async BlockStore writes to complete
    setTimeout(function() { renderModalItems(_addModalTaskId); }, 50);
  }

  document.getElementById('am-item-add').addEventListener('click', addModalItem);
  document.getElementById('am-item-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') addModalItem();
  });

  // Pick existing trivial task
  document.getElementById('am-trivial-pick').addEventListener('click', function() {
    var picker = document.getElementById('am-trivial-picker');
    var tasks = loadTrivialTasks().filter(function(t) { return !t.done && !t.linkedTo; });
    if (!tasks.length) {
      picker.innerHTML = '<div class="am-empty">No unlinked trivial tasks available.</div>';
      picker.style.display = '';
      return;
    }
    picker.innerHTML = tasks.map(function(t) {
      return '<div class="am-pick-opt" data-tid="' + t.id + '">' + t.text + '</div>';
    }).join('');
    picker.style.display = '';
    picker.querySelectorAll('.am-pick-opt').forEach(function(opt) {
      opt.addEventListener('click', function() {
        linkTrivialToSchedule(opt.dataset.tid, _addModalTaskId);
        picker.style.display = 'none';
        setTimeout(function() { renderModalItems(_addModalTaskId); }, 100);
      });
    });
  });
});

function buildTrivialTasks(){
  const el=document.getElementById("triage-trivial");if(!el)return;
  const tasks=loadTrivialTasks();
  const flags=loadTrivialFlags();
  const flaggedScheduleItems=(typeof scheduled!=='undefined'?scheduled:[]).filter(ev=>flags[ev.id]);
  const active=tasks.filter(t=>!t.done&&!t.linkedTo);
  const done=tasks.filter(t=>t.done);
  const totalCount=flaggedScheduleItems.length+active.length;
  const trivBadge=document.getElementById("trivial-count");
  if(trivBadge){trivBadge.textContent=totalCount;trivBadge.style.display=totalCount?"":"none"}
  // Floating purple Trivial bubble: at-a-glance count, hidden when zero
  const trivFab=document.getElementById("float-trivial");
  if(trivFab){
    const lbl=document.getElementById("float-trivial-count");
    if(lbl)lbl.textContent=totalCount>99?"99+":String(totalCount);
    trivFab.dataset.overflow=totalCount>99?"true":"false";
    trivFab.style.display=totalCount>0?"":"none";
  }

  el.innerHTML="";
  if(!totalCount&&!done.length){el.innerHTML='<div class="board-empty">No trivial tasks. Use the task bar above to add one.</div>';return}

  // Flagged schedule items
  flaggedScheduleItems.forEach(ev=>{
    const c=typeof cfg==='function'?cfg(ev.type):{color:'var(--text-muted)',tag:ev.type};
    const card=document.createElement("div");card.className="board-card";
    card.innerHTML='<div class="bar" style="background:'+c.color+'"></div>'+
      '<div class="body"><div class="title-row"><span class="ttl">'+ev.title+'</span>'+(typeof srcTag==='function'?srcTag(ev.source):'')+'</div>'+
      '<div class="meta"><span class="tag '+c.cls+'">'+c.tag+'</span><span>'+ms(dur(ev))+'</span></div></div>'+
      '<button class="add-btn triv-restore-btn" data-tid="'+ev.id+'">Restore</button>'+
      '<button class="add-btn triv-flagged-done-btn" data-tid="'+ev.id+'" style="background:var(--green)">Done</button>';
    card.querySelector(".triv-restore-btn").addEventListener("click",e=>{e.stopPropagation();toggleTrivialFlag(ev.id)});
    card.querySelector(".triv-flagged-done-btn").addEventListener("click",e=>{e.stopPropagation();toggleDone(ev.id)});
    el.appendChild(card);
  });

  // Active trivial tasks
  active.forEach(t=>{
    const card=document.createElement("div");card.className="board-card";
    card.innerHTML='<div class="bar" style="background:var(--purple,#a78bfa)"></div>'+
      '<div class="body"><div class="title-row"><span class="ttl">'+t.text+'</span></div>'+
      '<div class="meta"><span class="tag tag-task">Trivial</span></div></div>'+
      '<button class="add-btn triv-check-btn" data-tid="'+t.id+'" style="background:var(--green)">Done</button>'+
      '<button class="btn-del-task triv-del-btn" data-tid="'+t.id+'" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>';
    card.querySelector(".triv-check-btn").addEventListener("click",e=>{e.stopPropagation();toggleTrivialTask(t.id)});
    card.querySelector(".triv-del-btn").addEventListener("click",e=>{e.stopPropagation();deleteTrivialTask(t.id)});
    el.appendChild(card);
  });

  // Done section
  if(done.length){
    const doneWrap=document.createElement("details");doneWrap.style.cssText="margin-top:12px";
    doneWrap.innerHTML='<summary style="font-size:11px;font-weight:600;color:var(--text-muted);cursor:pointer;padding:6px 0">Done ('+done.length+')</summary>';
    const doneList=document.createElement("div");
    done.forEach(t=>{
      const card=document.createElement("div");card.className="board-card";card.style.opacity="0.5";
      card.innerHTML='<div class="bar" style="background:var(--green)"></div>'+
        '<div class="body"><div class="title-row"><span class="ttl" style="text-decoration:line-through">'+t.text+'</span></div></div>'+
        '<button class="btn-del-task triv-del-btn" data-tid="'+t.id+'" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>';
      card.querySelector(".triv-del-btn").addEventListener("click",e=>{e.stopPropagation();deleteTrivialTask(t.id)});
      doneList.appendChild(card);
    });
    doneWrap.appendChild(doneList);
    el.appendChild(doneWrap);
  }
}

// ======== STICKY NOTES ========
const SN_KEY = "pa-sticky-notes";

// Per-card editor instances: id → BlockEditor. Reused so we don't tear down
// editors during incremental re-renders unless they're truly stale.
const _snEditors = new Map();
// Tracks pending autosave timers per note id.
const _snSaveTimers = new Map();
// Last-saved signature per note (so we don't re-render an editor whose
// content already matches the persisted state, which would steal focus).
const _snLastSig = new Map();

function loadStickyNotes(){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.stickyNotes&&window.blockStore){
    return [...window.blockStore.getByType("sticky_note"),...window.blockStore.getByType("block").filter(b=>((b.properties||{}).tags||[]).includes("pinned")&&(b.properties||{}).html!==undefined)].map(b=>({
      id:b.id, html:b.properties.html||"", text:b.properties.text||"", blocks:b.properties.blocks||null,
      createdAt:b.created_at, updatedAt:b.updated_at, _blockId:b.id
    })).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)); // newest first
  }
  try{return JSON.parse(localStorage.getItem(SN_KEY)||"[]")}catch(e){return[]}
}
function saveStickyNotes(notes){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.stickyNotes&&window.blockStore)return; // BlockStore handles saves directly
  try{localStorage.setItem(SN_KEY,JSON.stringify(notes));scheduleIDBSave()}catch(e){}
}

function snRelTime(iso){
  const diff=Date.now()-new Date(iso).getTime();
  const m=Math.floor(diff/60000),h=Math.floor(m/60),d=Math.floor(h/24);
  if(d>0)return d+"d ago";if(h>0)return h+"h ago";if(m>0)return m+"m ago";return"just now";
}

function updateSnBadge(){
  const notes=loadStickyNotes();
  const badge=document.getElementById("sn-badge");
  if(!badge)return;
  if(notes.length){badge.textContent=notes.length;badge.style.display="";}
  else{badge.style.display="none";}
}

function _snInitialBlocks(n){
  if(n.blocks && n.blocks.length) return n.blocks;
  if(n.html) return migrateHtmlToBlocks(n.html);
  return null;
}

function _snEditorIsEmpty(editor){
  if(!editor) return true;
  if(editor.isEmpty()) return true;
  return !editor.toMarkdown().trim();
}

function _snFlushSave(id){
  if(_snSaveTimers.has(id)){
    clearTimeout(_snSaveTimers.get(id));
    _snSaveTimers.delete(id);
  }
  const editor=_snEditors.get(id);
  if(editor) _snPersist(id, editor);
}

function _snFlushAll(){
  for(const id of [..._snSaveTimers.keys()]) _snFlushSave(id);
}

function _snPersist(id, editor){
  if(!editor) return;
  const blocks=editor.getBlocks();
  const html=editor.toHtml();
  const text=editor.toMarkdown();
  const sig=html;
  if(_snLastSig.get(id)===sig) return; // no change
  _snLastSig.set(id, sig);

  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.stickyNotes&&window.blockStore){
    const existing=window.blockStore.get(id);
    if(existing){
      const mergedProps={...(existing.properties||{}), html, text, blocks};
      // updateBlockDebounced bumps the cache immediately and persists after a
      // small delay; safe to call for every keystroke.
      window.blockStore.updateBlockDebounced(id, mergedProps, 200);
    }
    updateSnBadge();
    return;
  }

  // localStorage path
  const notes=loadStickyNotes();
  const idx=notes.findIndex(n=>n.id===id);
  if(idx===-1) return;
  notes[idx].html=html;
  notes[idx].text=text;
  notes[idx].blocks=blocks;
  notes[idx].updatedAt=new Date().toISOString();
  saveStickyNotes(notes);
  updateSnBadge();
}

function renderStickyNotesList(){
  const list=document.getElementById("sn-list");if(!list)return;
  // Flush any pending edits before tearing down editors so nothing is lost
  // on re-render (e.g., when "+ New Note" or Delete triggers a refresh).
  _snFlushAll();
  const notes=loadStickyNotes();

  // We're about to wipe the list DOM, which orphans every existing editor
  // (and leaks their document-level listeners — see block-editor.js). Destroy
  // them all first; we'll recreate fresh editors below.
  for(const [id, ed] of [..._snEditors]){
    try{ed.destroy()}catch(e){}
    _snEditors.delete(id);
    _snLastSig.delete(id);
  }

  if(!notes.length){list.innerHTML='<div class="sn-empty">No notes yet. Hit "+ New Note" to add one.</div>';return;}

  const now=Date.now();
  list.innerHTML="";
  notes.forEach(n=>{
    const ageMs=now-new Date(n.createdAt).getTime();
    const stale=ageMs>10*24*60*60*1000;
    const ageDays=Math.floor(ageMs/(24*60*60*1000));
    const card=document.createElement("div");
    card.className="sn-card"+(stale?" sn-card-stale":"");
    card.dataset.snid=n.id;
    card.innerHTML=
      (stale?'<div class="sn-stale-banner">⚠ This note is '+ageDays+' days old — keep or delete?</div>':'')+
      '<div class="sn-card-body" data-sn-mount></div>'+
      '<div class="sn-card-meta">'+
        '<span class="sn-card-ts">'+(n.updatedAt!==n.createdAt?"edited ":"")+snRelTime(n.updatedAt||n.createdAt)+'</span>'+
        '<div class="sn-card-btns">'+
          '<button class="sn-del-btn" data-snid="'+n.id+'">Delete</button>'+
        '</div>'+
      '</div>';
    list.appendChild(card);

    // Mount the shared block editor inside the card body so each card behaves
    // exactly like the notes editor in the done modal / notes drawer / add modal.
    const mount=card.querySelector('[data-sn-mount]');
    const editor=createBlockEditor(mount, _snInitialBlocks(n));
    _snEditors.set(n.id, editor);
    _snLastSig.set(n.id, editor.toHtml());

    // Auto-save: debounced on input, immediate on blur — same persistence
    // pattern as updateBlockDebounced uses elsewhere.
    mount.addEventListener('input', ()=>{
      if(_snSaveTimers.has(n.id)) clearTimeout(_snSaveTimers.get(n.id));
      _snSaveTimers.set(n.id, setTimeout(()=>{
        _snSaveTimers.delete(n.id);
        _snPersist(n.id, editor);
      }, 350));
    });
    // Capture-phase blur catches focus leaving any inner contenteditable.
    mount.addEventListener('blur', ()=>{ _snFlushSave(n.id); }, true);

    card.querySelector(".sn-del-btn").addEventListener("click",()=>deleteStickyNote(n.id));
  });
}

function openStickyNotes(){
  document.getElementById("sn-overlay").classList.add("open");
  // Reset the create-task bar so it doesn't carry stale state from a prior session.
  const taskBar=document.getElementById("task-add-sticky");
  if(taskBar){
    taskBar.style.display="none";
    const t=taskBar.querySelector(".tab-title");
    if(t){ t.value=""; t.classList.remove("tab-error"); }
  }
  renderStickyNotesList();
}
function closeStickyNotes(){
  // Flush any pending edits before closing so nothing is lost.
  _snFlushAll();
  // Drop any sticky notes that were created but left empty — saves the user
  // from accumulating empty cards after clicking "+ New Note" by accident.
  _snPruneEmpty().then(()=>{
    document.getElementById("sn-overlay").classList.remove("open");
    if(typeof _flushDeferredRender==='function')_flushDeferredRender();
  });
}

async function _snPruneEmpty(){
  const notes=loadStickyNotes();
  const empties=notes.filter(n=>{
    const ed=_snEditors.get(n.id);
    if(ed) return _snEditorIsEmpty(ed);
    return !((n.text||"").trim()) && !((n.html||"").replace(/<[^>]+>/g,'').trim());
  });
  if(!empties.length) return;
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.stickyNotes&&window.blockStore){
    for(const n of empties){
      try{ await window.blockStore.deleteBlock(n.id); }catch(e){}
    }
  } else {
    const remaining=loadStickyNotes().filter(n=>!empties.find(e=>e.id===n.id));
    saveStickyNotes(remaining);
  }
  // Tear down their editors
  empties.forEach(n=>{
    const ed=_snEditors.get(n.id);
    if(ed){ try{ed.destroy()}catch(e){} _snEditors.delete(n.id); }
    _snLastSig.delete(n.id);
  });
  updateSnBadge();
}

function newStickyNote(){
  const now=new Date().toISOString();
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.stickyNotes&&window.blockStore){
    window.blockStore.createBlock("block",{html:"",text:"",blocks:[],tags:["pinned"]}).then(block=>{
      renderStickyNotesList();
      updateSnBadge();
      const newId=block && block.id;
      const ed=newId?_snEditors.get(newId):null;
      if(ed) ed.focus();
    });
    return;
  }
  // localStorage fallback
  const notes=loadStickyNotes();
  const id="sn-"+Date.now();
  notes.unshift({id,html:"",text:"",blocks:[],createdAt:now,updatedAt:now});
  saveStickyNotes(notes);
  renderStickyNotesList();
  updateSnBadge();
  const ed=_snEditors.get(id);
  if(ed) ed.focus();
}

function deleteStickyNote(id){
  // Cancel any pending save and forget the editor before deleting.
  if(_snSaveTimers.has(id)){ clearTimeout(_snSaveTimers.get(id)); _snSaveTimers.delete(id); }
  const ed=_snEditors.get(id);
  if(ed){ try{ed.destroy()}catch(e){} _snEditors.delete(id); }
  _snLastSig.delete(id);

  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.stickyNotes&&window.blockStore){
    window.blockStore.deleteBlock(id).then(()=>{
      renderStickyNotesList();
      updateSnBadge();
    });
    return;
  }
  const notes=loadStickyNotes().filter(n=>n.id!==id);
  saveStickyNotes(notes);
  renderStickyNotesList();
  updateSnBadge();
}

// Create-task bar inside the sticky notes panel. Mirrors the notes-drawer
// pattern: the .task-add-bar markup is auto-wired to addTaskUniversal at
// script load (schedule.js); here we just toggle visibility and collapse
// the bar after a successful add.
function toggleSnCreateTask(){
  const bar=document.getElementById("task-add-sticky");
  if(!bar) return;
  const visible=bar.style.display!=="none";
  if(visible){ bar.style.display="none"; return; }
  bar.style.display="flex";
  const inp=bar.querySelector(".tab-title");
  if(inp) inp.focus();
}
(function wireSnCreateTask(){
  const bar=document.getElementById("task-add-sticky");
  if(!bar) return;
  const titleInp=bar.querySelector(".tab-title");
  const addBtn=bar.querySelector(".tab-add");
  // addTaskUniversal clears .tab-title on success and adds .tab-error on
  // empty input. Run after it (microtask) and collapse the bar if the input
  // was cleared.
  const collapseIfAdded=()=>{
    Promise.resolve().then(()=>{
      if(titleInp && !titleInp.value && !titleInp.classList.contains("tab-error")){
        bar.style.display="none";
      }
    });
  };
  addBtn && addBtn.addEventListener("click", collapseIfAdded);
  titleInp && titleInp.addEventListener("keydown", e=>{ if(e.key==="Enter") collapseIfAdded(); });
})();

// ======== FOCUS BANNER ========
function updateFocusBanner(){
  const banner=document.getElementById("focus-banner");
  if(!banner)return;
  const title=(typeof pomoState!=="undefined"&&pomoState.title&&pomoState.title!=="--")?pomoState.title:null;
  if(!title){banner.style.display="none";return;}
  banner.style.display="flex";
  const running=(typeof pomoState!=="undefined"&&pomoState.running);
  banner.classList.toggle("running",running);
  const fbTitle=document.getElementById("fb-title");
  if(fbTitle)fbTitle.textContent=title;
  const fbStatus=document.getElementById("fb-status");
  if(fbStatus){
    if(running){
      const rem=(typeof pomoFmt==="function")?pomoFmt(pomoState.remaining):"";
      fbStatus.textContent=rem?" · "+rem+" left":"";
    }else{
      fbStatus.textContent="· Paused";
    }
  }
}

// ======== TASK QUEUE PANEL ========
function buildTaskQueuePanel(){
  const triagePanel=document.getElementById("tqp-panel-triage");
  const priorityPanel=document.getElementById("tqp-panel-priority");
  const backlogPanel=document.getElementById("tqp-panel-backlog");
  const counts=document.getElementById("tqp-counts");
  if(!triagePanel||!priorityPanel||!backlogPanel)return;

  // ---- Triage ----
  const dismissed=(typeof loadDismissed==="function")?loadDismissed():{};
  const priColors={high:"var(--red)",medium:"var(--amber)",low:"var(--text-muted)"};
  const activeTriage=(typeof INIT_TRIAGE!=="undefined")?INIT_TRIAGE.filter(i=>!dismissed[i.id]):[];
  const tqpTriageBadge=document.getElementById("tqp-triage-count");
  if(tqpTriageBadge)tqpTriageBadge.textContent=activeTriage.length;
  if(!activeTriage.length){
    triagePanel.innerHTML='<div class="tqp-empty">No triage items \u2014 you\'re clear.</div>';
  }else{
    triagePanel.innerHTML=activeTriage.map(item=>{
      const dotColor=priColors[item.priority]||"var(--text-muted)";
      return '<div class="tqp-triage-card">'+
        '<span class="tqp-tri-dot" style="background:'+dotColor+'"></span>'+
        '<span class="tqp-tri-title">'+item.title+'</span>'+
        '<span class="tqp-tri-meta">'+(item.priority||"")+'</span>'+
      '</div>';
    }).join('');
  }

  // ---- Priority (consider) ----
  const priorityTasks=(typeof consider!=="undefined")?consider:[];
  const tqpPrioBadge=document.getElementById("tqp-priority-count");
  if(tqpPrioBadge){tqpPrioBadge.textContent=priorityTasks.length;tqpPrioBadge.style.display=priorityTasks.length?"":"none";}
  if(!priorityTasks.length){
    priorityPanel.innerHTML='<div class="tqp-empty">No priority tasks.</div>';
  }else{
    const priOrder={High:0,Medium:1,Low:2};
    const sorted=[...priorityTasks].sort((a,b)=>(priOrder[a.priority]||3)-(priOrder[b.priority]||3));
    priorityPanel.innerHTML=sorted.map(t=>{
      const c=(typeof cfg==="function")?cfg(t.type):{color:"var(--text-muted)",tag:t.type||""};
      const durStr=(typeof ms==="function")?ms(t.durMin):t.durMin+"m";
      return '<div class="tqp-task-card">'+
        '<div class="tqp-task-bar" style="background:'+c.color+'"></div>'+
        '<span class="tqp-task-title">'+t.title+'</span>'+
        '<span class="tqp-task-meta">'+durStr+'</span>'+
        '<button class="tqp-sched-btn" data-tqp-add-id="'+t.id+'" title="Add to schedule">+ Schedule</button>'+
      '</div>';
    }).join('');
    priorityPanel.querySelectorAll('.tqp-sched-btn').forEach(btn=>{
      btn.addEventListener('click',e=>{
        e.stopPropagation();
        if(typeof addToSchedule==='function')addToSchedule(btn.dataset.tqpAddId);
      });
    });
  }

  // ---- Backlog ----
  const backlogTasks=(typeof backlog!=="undefined")?backlog:[];
  const tqpBacklogBadge=document.getElementById("tqp-backlog-count");
  if(tqpBacklogBadge)tqpBacklogBadge.textContent=backlogTasks.length;
  if(!backlogTasks.length){
    backlogPanel.innerHTML='<div class="tqp-empty">Backlog is empty.</div>';
  }else{
    const priOrder={High:0,Medium:1,Low:2};
    const sorted=[...backlogTasks].sort((a,b)=>(priOrder[a.priority]||3)-(priOrder[b.priority]||3));
    backlogPanel.innerHTML=sorted.map(t=>{
      const c=(typeof cfg==="function")?cfg(t.type):{color:"var(--text-muted)",tag:t.type||""};
      const durStr=(typeof ms==="function")?ms(t.durMin):t.durMin+"m";
      return '<div class="tqp-task-card">'+
        '<div class="tqp-task-bar" style="background:'+c.color+'"></div>'+
        '<span class="tqp-task-title">'+t.title+'</span>'+
        '<span class="tqp-task-meta">'+durStr+'</span>'+
        '<button class="tqp-sched-btn" data-tqp-add-id="'+t.id+'" title="Add to schedule">+ Schedule</button>'+
      '</div>';
    }).join('');
    backlogPanel.querySelectorAll('.tqp-sched-btn').forEach(btn=>{
      btn.addEventListener('click',e=>{
        e.stopPropagation();
        if(typeof addToSchedule==='function')addToSchedule(btn.dataset.tqpAddId);
      });
    });
  }

  // Summary counts in header
  if(counts)counts.textContent=
    (activeTriage.length?""+activeTriage.length+" triage":"")+(activeTriage.length&&priorityTasks.length?" · ":"")+
    (priorityTasks.length?priorityTasks.length+" priority":"")+
    ((activeTriage.length||priorityTasks.length)&&backlogTasks.length?" · ":"")+
    (backlogTasks.length?backlogTasks.length+" backlog":"");
}

// Wire TQP collapse toggle + accordion expand/collapse-all (runs once after DOM load)
document.addEventListener('DOMContentLoaded',function(){
  // PIN 4: expand/collapse-all controls for both accordions.
  // The Task Queue panel and Task Menus tab each have an .acc-controls strip
  // with two buttons. data-acc-scope points at a container selector; the
  // handler iterates its descendant .tm-section <details> elements and sets
  // .open accordingly. One synthetic 'toggle' dispatch kicks the tabs.js
  // persistence listener so the new state is saved to pa-tm-accordion-state.
  document.querySelectorAll('.acc-btn').forEach(function(btn){
    btn.addEventListener('click',function(e){
      e.stopPropagation();
      var scope=document.querySelector(btn.dataset.accScope);
      if(!scope)return;
      var wantOpen=btn.dataset.accAction==='expand';
      scope.querySelectorAll('details.tm-section').forEach(function(d){
        d.open=wantOpen;
      });
      var anyDetails=scope.querySelector('details.tm-section');
      if(anyDetails)anyDetails.dispatchEvent(new Event('toggle',{bubbles:false}));
    });
  });
  // Collapse toggle
  var hdr=document.getElementById('tqp-header');
  if(hdr)hdr.addEventListener('click',function(e){
    if(e.target.closest('.tqp-tab'))return;
    var panel=document.querySelector('.task-queue-panel');
    if(panel){
      panel.classList.toggle('collapsed');
      var collapsed=panel.classList.contains('collapsed');
      try{localStorage.setItem('tqp-collapsed',collapsed?'1':'0');}catch(ex){}
    }
  });
  // Restore collapse state
  try{if(localStorage.getItem('tqp-collapsed')==='1'){var p=document.querySelector('.task-queue-panel');if(p)p.classList.add('collapsed');}}catch(ex){}
});

// ======== SHARED TASK LIST RENDERER ========
// Builds consistent .completion-item.clickable HTML for a list of tasks.
// Used by openUntaskedModal, and available for Phase 4 pivot task picker.
function buildTaskListHtml(tasks) {
  if (!tasks || !tasks.length) {
    return '<div style="font-size:11px;color:var(--text-muted);padding:8px">No tasks available.</div>';
  }
  return tasks.map(function(t) {
    var c = (typeof cfg === 'function') ? cfg(t.type) : {color:'var(--text-muted)',tag:t.type||''};
    var timeStr = (t.start && t.end) ? ('<span>' + (typeof f12==='function'?f12(t.start):t.start) + ' \u2013 ' + (typeof f12==='function'?f12(t.end):t.end) + '</span>') : '';
    return '<div class="completion-item clickable" data-task-id="' + (t.id||'').replace(/"/g,'&quot;') + '" data-task-title="' + (t.title||'').replace(/"/g,'&quot;') + '">' +
      '<span class="ci-bar" style="background:' + c.color + '"></span>' +
      '<div class="ci-body">' +
        '<div class="ci-title">' + (t.title||'') + '</div>' +
        '<div class="ci-meta"><span>' + (c.tag||'') + '</span>' + timeStr + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// Persist a title change for a scheduled task across blockStore / localStorage.
function _persistTaskTitle(taskId, newTitle) {
  if (window.USE_BLOCKSTORE && window.blockStore) {
    var allBlocks = [].concat(window.blockStore.getByType('added_task'),window.blockStore.getByType('schedule_item'),window.blockStore.getByType('block'));
    var block = allBlocks.find(function(b) { return (b.properties||{}).local_id === taskId; });
    if (block) {
      window.blockStore.updateBlock(block.id, Object.assign({}, block.properties, {title: newTitle}));
      return;
    }
    var sBlock = allBlocks.find(function(b) { return b.id === taskId; });
    if (sBlock) {
      window.blockStore.updateBlock(sBlock.id, Object.assign({}, sBlock.properties, {title: newTitle}));
      return;
    }
  }
  if (typeof scheduleIDBSave === 'function') scheduleIDBSave();
}

// Check if any modal/overlay is currently open
function _anyModalOpen() {
  var overlays = document.querySelectorAll('.done-modal-overlay.open, .add-modal-overlay.open, .del-confirm-overlay.open, .sn-overlay.open, .notes-drawer-overlay.open, .overflow-modal-overlay.open, .jm-overlay.open');
  return overlays.length > 0;
}

// rAF-throttled render — collapses multiple rapid calls into one frame
// Defers render while any modal is open to prevent DOM clobbering
let _renderPending = false;
let _renderDeferred = false;
function render() {
  if (_anyModalOpen()) {
    _renderDeferred = true; // will run when modal closes
    return;
  }
  if (_renderPending) return;
  _renderPending = true;
  requestAnimationFrame(_doRender);
}

// Call this when any modal closes to flush deferred render
function _flushDeferredRender() {
  if (_renderDeferred) {
    _renderDeferred = false;
    render();
  }
}
function _doRender(){_renderPending=false;buildSchedule();buildConsider();buildBacklog();buildTriage();buildActionItemsTab();buildTrivialTasks();if(typeof buildScheduled==='function')buildScheduled();if(typeof buildScheduleSoon==='function')buildScheduleSoon();buildUpcoming();buildProgress();updateStats();updateSync();buildLife();updateSnBadge();_updateTaskMenusBadge();if(schedView==="actual")buildActualView();updateFocusBanner();}
function _updateTaskMenusBadge(){
  const badge=document.getElementById("tasks-count");if(!badge)return;
  // Sum up counts from sub-tab badges
  const tc=parseInt(document.getElementById("triage-count")?.textContent||"0")||0;
  const sc=parseInt(document.getElementById("soon-count")?.textContent||"0")||0;
  const bc=parseInt(document.getElementById("backlog-count")?.textContent||"0")||0;
  const schedc=parseInt(document.getElementById("scheduled-count")?.textContent||"0")||0;
  const total=tc+sc+bc+schedc;
  badge.textContent=total;badge.style.display=total?"":"none";
}

// ======== BUTTONS ========
document.getElementById("btn-copy").addEventListener("click",function(){
  const t=buildClip();if(!t)return;
  navigator.clipboard.writeText(t).then(()=>{
    const b=document.getElementById("btn-copy");b.classList.add("copied");b.textContent="Copied!";
    setTimeout(()=>{b.classList.remove("copied");b.innerHTML='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg> Copy for Claude'},2000)
  });
});
document.getElementById("btn-undo").addEventListener("click",undoLast);
document.getElementById("btn-reset").addEventListener("click",resetAll);
// Old add-task-btn, ai-tab-add-btn, new-title wiring removed — handled by universal task-add bar


// ======== PREP FILES (loaded from API) ========
window.__PREP_FILES__ = {};


