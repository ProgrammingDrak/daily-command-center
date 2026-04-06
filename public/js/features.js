// ======== TRIVIAL TASKS ========
const TRIV_KEY = "pa-trivial-tasks";
let TRIV_FLAGS_KEY = "pa-trivial-flags-" + ((__state && __state.date) ? __state.date : "unknown");

function loadTrivialTasks(){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.trivialTasks&&window.blockStore){
    return window.blockStore.getByType("trivial_task").map(b=>({
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
    window.blockStore.createBlock("trivial_task",{text:text.trim(),done:false}).then(()=>buildTrivialTasks());
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
    window.blockStore.createBlock("trivial_task",{text:text.trim(),done:false,linkedTo:scheduleId}).then(()=>{
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
    // Check added_task blocks
    var addedBlocks = window.blockStore.getByType('added_task');
    var block = addedBlocks.find(function(b) { return (b.properties||{}).local_id === taskId; });
    if (block) {
      window.blockStore.updateBlock(block.id, Object.assign({}, block.properties, {tags: tagIds}));
      return;
    }
    // Check schedule_item blocks
    var schedBlocks = window.blockStore.getByType('schedule_item');
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

  // Phase 7b: Get flagged schedule items
  const flaggedScheduleItems=(typeof scheduled!=='undefined'?scheduled:[]).filter(ev=>flags[ev.id]);

  // Split tasks: unlinked active, linked (shown on cards), done
  const unlinked=tasks.filter(t=>!t.done&&!t.linkedTo);
  const active=unlinked; // unlinked active tasks show in triage
  const done=tasks.filter(t=>t.done);

  const totalCount=flaggedScheduleItems.length+active.length;
  const trivBadge=document.getElementById("trivial-count");
  if(trivBadge){trivBadge.textContent=totalCount;trivBadge.style.display=totalCount?"":"none"}
  let html='<div class="triv-section">'+
    '<div class="triv-header">'+
      '<div class="triv-title">⚡ Trivial Tasks <span style="opacity:0.6;font-weight:400;font-size:10px">('+totalCount+')</span></div>'+
      '<button class="triv-add-btn" id="triv-add-btn">+ Add</button>'+
    '</div>'+
    '<div class="triv-desc">Quick things to remember — stack with larger tasks when possible.</div>'+
    '<div id="triv-input-row" class="triv-input-row" style="display:none">'+
      '<input class="triv-input" id="triv-input" type="text" placeholder="Add a trivial task...">'+
      '<button class="triv-input-ok" id="triv-input-ok">Add</button>'+
    '</div>';

  // Phase 7b: Show flagged schedule items first
  if(flaggedScheduleItems.length){
    html+='<div class="triv-subheader">From Schedule</div>';
    flaggedScheduleItems.forEach(ev=>{
      const c=typeof cfg==='function'?cfg(ev.type):{color:'var(--text-muted)',tag:ev.type};
      html+='<div class="triv-flagged-item" data-tid="'+ev.id+'">'+
        '<div class="triv-flagged-bar" style="background:'+c.color+'"></div>'+
        '<div class="triv-flagged-body">'+
          '<span class="triv-flagged-title">'+ev.title+'</span>'+
          '<span class="triv-flagged-meta">'+ms(dur(ev))+' · '+(typeof srcTag==='function'?srcTag(ev.source):'')+'</span>'+
        '</div>'+
        '<button class="triv-restore-btn" data-tid="'+ev.id+'" title="Restore to schedule">Restore</button>'+
        '<button class="triv-flagged-done-btn" data-tid="'+ev.id+'" title="Mark done">✓</button>'+
      '</div>';
    });
  }

  if(active.length||flaggedScheduleItems.length){
    if(flaggedScheduleItems.length&&active.length)html+='<div class="triv-subheader">Quick Tasks</div>';
    active.forEach(t=>{
      html+='<div class="triv-item" data-tid="'+t.id+'">'+
        '<div class="triv-check" data-tid="'+t.id+'"></div>'+
        '<span class="triv-text">'+t.text+'</span>'+
        '<button class="triv-del" data-tid="'+t.id+'">✕</button>'+
      '</div>';
    });
  }
  if(!totalCount){
    html+='<div style="font-size:11px;color:var(--text-muted);padding:4px 0">No trivial tasks.</div>';
  }

  if(done.length){
    html+='<div class="triv-done-section">'+
      '<button class="triv-done-toggle" id="triv-done-toggle">▸ Done ('+done.length+')</button>'+
      '<div id="triv-done-list" style="display:none">';
    done.forEach(t=>{
      html+='<div class="triv-item" data-tid="'+t.id+'">'+
        '<div class="triv-check done" data-tid="'+t.id+'">✓</div>'+
        '<span class="triv-text done">'+t.text+'</span>'+
        '<button class="triv-del" data-tid="'+t.id+'">✕</button>'+
      '</div>';
    });
    html+='</div></div>';
  }

  html+='</div>';
  el.innerHTML=html;

  el.querySelector("#triv-add-btn").addEventListener("click",()=>{
    const row=el.querySelector("#triv-input-row");
    row.style.display="flex";
    el.querySelector("#triv-input").focus();
  });
  el.querySelector("#triv-input-ok").addEventListener("click",()=>{
    const inp=el.querySelector("#triv-input");
    addTrivialTask(inp.value);
    inp.value="";
  });
  el.querySelector("#triv-input").addEventListener("keydown",e=>{
    if(e.key==="Enter"){const inp=e.currentTarget;addTrivialTask(inp.value);inp.value="";}
    if(e.key==="Escape"){el.querySelector("#triv-input-row").style.display="none";}
  });
  el.querySelectorAll(".triv-check").forEach(c=>c.addEventListener("click",()=>toggleTrivialTask(c.dataset.tid)));
  el.querySelectorAll(".triv-del").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();deleteTrivialTask(b.dataset.tid);}));
  // Phase 7b: Restore and done buttons for flagged schedule items
  el.querySelectorAll(".triv-restore-btn").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();toggleTrivialFlag(b.dataset.tid);}));
  el.querySelectorAll(".triv-flagged-done-btn").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();toggleDone(b.dataset.tid);}));
  const doneToggle=el.querySelector("#triv-done-toggle");
  if(doneToggle)doneToggle.addEventListener("click",()=>{
    const dl=el.querySelector("#triv-done-list");
    const open=dl.style.display==="block";
    dl.style.display=open?"none":"block";
    doneToggle.textContent=(open?"▸":"▾")+" Done ("+done.length+")";
  });
}

// ======== STICKY NOTES ========
const SN_KEY = "pa-sticky-notes";
let snEditingId = null;

function loadStickyNotes(){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.stickyNotes&&window.blockStore){
    return window.blockStore.getByType("sticky_note").map(b=>({
      id:b.id, html:b.properties.html, text:b.properties.text,
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

function renderStickyNotesList(){
  const list=document.getElementById("sn-list");if(!list)return;
  const notes=loadStickyNotes();
  if(!notes.length){list.innerHTML='<div class="sn-empty">No notes yet. Hit "+ New Note" to add one.</div>';return;}
  const now=Date.now();
  list.innerHTML="";
  notes.forEach(n=>{
    const ageMs=now-new Date(n.createdAt).getTime();
    const stale=ageMs>10*24*60*60*1000;
    const ageDays=Math.floor(ageMs/(24*60*60*1000));
    const card=document.createElement("div");
    card.className="sn-card"+(stale?" sn-card-stale":"");
    card.innerHTML=
      (stale?'<div class="sn-stale-banner">⚠ This note is '+ageDays+' days old — keep or delete?</div>':'')+
      '<div class="sn-card-body">'+n.html+'</div>'+
      '<div class="sn-card-meta">'+
        '<span class="sn-card-ts">'+(n.updatedAt!==n.createdAt?"edited ":"")+snRelTime(n.updatedAt||n.createdAt)+'</span>'+
        '<div class="sn-card-btns">'+
          '<button class="sn-edit-btn" data-snid="'+n.id+'">Edit</button>'+
          '<button class="sn-del-btn" data-snid="'+n.id+'">Delete</button>'+
        '</div>'+
      '</div>';
    card.querySelector(".sn-edit-btn").addEventListener("click",()=>openStickyEditor(n.id));
    card.querySelector(".sn-del-btn").addEventListener("click",()=>deleteStickyNote(n.id));
    list.appendChild(card);
  });
}

function openStickyNotes(){
  document.getElementById("sn-overlay").classList.add("open");
  renderStickyNotesList();
}
function closeStickyNotes(){
  document.getElementById("sn-overlay").classList.remove("open");
  closeStickyEditor();
  if(typeof _flushDeferredRender==='function')_flushDeferredRender();
}

function openStickyEditor(id){
  snEditingId=id;
  const wrap=document.getElementById("sn-editor-wrap");
  const ed=document.getElementById("sn-editable");
  wrap.classList.add("open");
  if(id){
    const notes=loadStickyNotes();
    const n=notes.find(x=>x.id===id);
    if(n)ed.innerHTML=n.html;
  } else {
    ed.innerHTML="";
  }
  ed.focus();
}
function closeStickyEditor(){
  snEditingId=null;
  const wrap=document.getElementById("sn-editor-wrap");
  if(wrap)wrap.classList.remove("open");
  const ed=document.getElementById("sn-editable");
  if(ed)ed.innerHTML="";
}

function snCmd(cmd){document.execCommand(cmd,false,null);document.getElementById("sn-editable").focus();}

function saveStickyNote(){
  const ed=document.getElementById("sn-editable");
  const html=ed.innerHTML.trim();
  const text=ed.innerText.trim();
  if(!text){closeStickyEditor();return;}

  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.stickyNotes&&window.blockStore){
    // BlockStore path: create or update block directly
    if(snEditingId){
      // Find the block and update it
      const existing=window.blockStore.get(snEditingId);
      if(existing){
        window.blockStore.updateBlock(snEditingId,{html,text}).then(()=>{
          closeStickyEditor();
          renderStickyNotesList();
          updateSnBadge();
        });
      }
    } else {
      // Create new sticky note block
      window.blockStore.createBlock("sticky_note",{html,text}).then(()=>{
        closeStickyEditor();
        renderStickyNotesList();
        updateSnBadge();
      });
    }
    return;
  }

  // localStorage path (fallback)
  const notes=loadStickyNotes();
  const now=new Date().toISOString();
  if(snEditingId){
    const idx=notes.findIndex(n=>n.id===snEditingId);
    if(idx!==-1){notes[idx].html=html;notes[idx].text=text;notes[idx].updatedAt=now;}
  } else {
    notes.unshift({id:"sn-"+Date.now(),html,text,createdAt:now,updatedAt:now});
  }
  saveStickyNotes(notes);
  closeStickyEditor();
  renderStickyNotesList();
  updateSnBadge();
}

function deleteStickyNote(id){
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
function _doRender(){_renderPending=false;buildSchedule();buildConsider();buildBacklog();buildTriage();buildActionItemsTab();buildTrivialTasks();if(typeof buildScheduled==='function')buildScheduled();if(typeof buildScheduleSoon==='function')buildScheduleSoon();buildUpcoming();buildProgress();updateStats();updateSync();buildLife();updateSnBadge();_updateTaskMenusBadge();if(schedView==="actual")buildActualView()}
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
document.getElementById("add-task-btn").addEventListener("click",addNewTask);
document.getElementById("ai-tab-add-btn").addEventListener("click",addAITabItem);
document.getElementById("ai-tab-text").addEventListener("keydown",e=>{if(e.key==="Enter")addAITabItem();});
document.getElementById("new-title").addEventListener("keydown",e=>{if(e.key==="Enter")addNewTask()});


// ======== PREP FILES (loaded from API) ========
window.__PREP_FILES__ = {};


