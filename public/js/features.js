// ======== SIDE PROJECTS ========
const TRIV_KEY = "pa-trivial-tasks";
let TRIV_FLAGS_KEY = "pa-trivial-flags-" + ((__state && __state.date) ? __state.date : "unknown");

function smallTaskKind(t){
  const tags=(t&&t.tags)||[];
  if(t&&(t.kind==="side_project"||t.category==="side_project"||tags.includes("side-project")))return"side_project";
  return"trivial";
}
function smallTaskTag(kind){return kind==="side_project"?"side-project":"trivial";}

function loadTrivialTasks(){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.trivialTasks&&window.blockStore){
    return (window.blockStore.getByType("trivial_task")||[])
      .concat(window.blockStore.getByType("block").filter(b=>{
        const tags=(b.properties||{}).tags||[];
        return tags.includes("trivial")||tags.includes("side-project");
      }))
      .map(b=>{
        const p=b.properties||{};
        const tags=p.tags||[];
        return {
          id:b.id, text:p.text, done:!!p.done,
          kind:p.kind||(tags.includes("side-project")?"side_project":"trivial"),
          durMin:p.durMin||p.duration||null,
          tags,
          createdAt:b.created_at, doneAt:p.doneAt||null,
          updatedAt:b.updated_at, linkedTo:p.linkedTo||null, _blockId:b.id
        };
      });
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

function addTrivialTask(text, kind, durMin){
  if(!text.trim())return;
  kind=kind||"side_project";
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.trivialTasks&&window.blockStore){
    const props={text:text.trim(),done:false,kind,tags:[smallTaskTag(kind)]};
    if(durMin)props.durMin=durMin;
    window.blockStore.createBlock("block",props,{date:null}).then(()=>buildTrivialTasks());
    return;
  }
  const tasks=loadTrivialTasks();
  tasks.push({id:(kind==="side_project"?"sideproj-":"triv-")+Date.now(),text:text.trim(),kind,done:false,durMin:durMin||null,createdAt:new Date().toISOString()});
  saveTrivialTasks(tasks);
  buildTrivialTasks();
}
function addSideProjectTask(text,durMin){addTrivialTask(text,"side_project",durMin);}
function toggleTrivialTask(id){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.trivialTasks&&window.blockStore){
    const block=window.blockStore.get(id);
    if(block){
      const newDone=!block.properties.done;
      window.blockStore.updateBlock(id,{...block.properties,done:newDone,doneAt:newDone?new Date().toISOString():null}).then(()=>{
        buildTrivialTasks();
        if(typeof buildSchedule==='function')buildSchedule();
      });
    }
    return;
  }
  const tasks=loadTrivialTasks();
  const t=tasks.find(x=>x.id===id);
  if(t){t.done=!t.done;t.doneAt=t.done?new Date().toISOString():null;}
  saveTrivialTasks(tasks);
  buildTrivialTasks();
  if(typeof buildSchedule==='function')buildSchedule();
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
  // Rebuild schedule (hides/shows side-project items) and side-project reminders.
  if(typeof buildSchedule==='function')buildSchedule();
  if(typeof buildTrivialTasks==='function')buildTrivialTasks();
  if(typeof updateStats==='function')updateStats();
}

// Link/unlink small side tasks to schedule items. Internal names stay legacy-compatible.
function getLinkedTrivialTasks(scheduleId){
  const tasks=loadTrivialTasks();
  return tasks.filter(t=>smallTaskKind(t)==="trivial"&&t.linkedTo===scheduleId);
}

function addLinkedTrivialTask(scheduleId, text){
  if(!text.trim())return;
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.trivialTasks&&window.blockStore){
    window.blockStore.createBlock("block",{text:text.trim(),done:false,kind:"trivial",linkedTo:scheduleId,tags:["trivial"]},{date:null}).then(()=>{
      if(typeof buildSchedule==='function')buildSchedule();
      if(typeof buildTrivialTasks==='function')buildTrivialTasks();
    });
    return;
  }
  const tasks=loadTrivialTasks();
  tasks.push({id:"triv-"+Date.now(),text:text.trim(),kind:"trivial",done:false,linkedTo:scheduleId,createdAt:new Date().toISOString()});
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

// Side project picker dropdown for schedule details.
function openTrivialPicker(scheduleId, anchorEl){
  document.querySelectorAll(".triv-picker-popup").forEach(p=>p.remove());
  const tasks=loadTrivialTasks().filter(t=>smallTaskKind(t)==="trivial"&&!t.done&&!t.linkedTo);
  if(!tasks.length){
    const pop=document.createElement("div");pop.className="triv-picker-popup";
    pop.innerHTML='<div style="padding:8px;font-size:11px;color:var(--text-muted)">No unlinked side projects. Add one first.</div>';
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

// ======== TASK DETAIL MODAL (Notes + Subtasks + Side Projects + Action Items) ========
let _addModalTaskId = null;

function taskForRepeatResponsibility(taskId, fallbackTitle) {
  const scheduledTask = (typeof scheduled !== 'undefined' ? scheduled : []).find(function(ev) { return ev.id === taskId; });
  if (scheduledTask) return scheduledTask;
  const backlogTask = (typeof backlog !== 'undefined' ? backlog : []).find(function(t) { return t.id === taskId; });
  if (backlogTask) return backlogTask;
  const priorityTask = (typeof consider !== 'undefined' ? consider : []).find(function(t) { return t.id === taskId; });
  if (priorityTask) return priorityTask;
  return { id: taskId, title: fallbackTitle || document.getElementById('add-modal-title')?.textContent || '', type: 'task', durMin: 30 };
}

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

// Read-only detail line for the Task Details modal (description itself seeds the
// Notes editor via seedNoteForTask, so this shows only the meta — no duplication).
function _amBuildDetails(ev){
  if(!ev) return '';
  var meta=[];
  if(ev.priority) meta.push('<span class="pri-'+(ev.priority==="High"?"hi":ev.priority==="Medium"?"med":"lo")+'">'+ev.priority+' priority</span>');
  if(typeof dur==='function') meta.push('<span>'+(typeof ms==='function'?ms(dur(ev)):dur(ev)+'m')+'</span>');
  if(ev.start&&ev.end&&typeof f12==='function') meta.push('<span>'+f12(ev.start)+' - '+f12(ev.end)+'</span>');
  if(ev.source&&typeof srcTag==='function') meta.push('<span class="am-det-src">Source:</span>'+srcTag(ev.source));
  if(ev.notionUrl) meta.push('<a href="'+ev.notionUrl+'" target="_blank" onclick="event.stopPropagation()">Open in Notion</a>');
  return meta.join('');
}

function openAddModal(taskId, taskTitle) {
  _addModalTaskId = taskId;
  document.getElementById('add-modal-title').textContent = taskTitle || 'Task Details';
  var taskEntry = (typeof scheduled !== 'undefined') ? scheduled.find(function(ev) { return ev.id === taskId; }) : null;

  // Read-only details (priority / duration / time / source / link)
  var detEl = document.getElementById('am-details-section');
  if (detEl) {
    var detHtml = _amBuildDetails(taskEntry);
    detEl.innerHTML = detHtml;
    detEl.style.display = detHtml ? '' : 'none';
  }

  // Initialize tag picker
  var tagContainer = document.getElementById('am-tag-picker');
  if (tagContainer && typeof createTagPicker === 'function') {
    var currentTags = (taskEntry && taskEntry.tags) ? taskEntry.tags : [];
    createTagPicker(tagContainer, currentTags, function(newIds) {
      if (taskEntry) taskEntry.tags = newIds;
      _persistTaskTags(taskId, newIds);
    });
  }

  var commuteToInput = document.getElementById('am-commute-to-input');
  var commuteBackInput = document.getElementById('am-commute-back-input');
  var commuteHint = document.getElementById('am-commute-hint');
  if (commuteToInput || commuteBackInput) {
    var pair = (typeof commutePairForTask === 'function') ? commutePairForTask(taskEntry) : { to: taskEntry ? (taskEntry.commuteMinutes || 0) : 0, back: taskEntry ? (taskEntry.commuteBackMinutes || 0) : 0 };
    if (commuteToInput) commuteToInput.value = pair.to ? String(pair.to) : '';
    if (commuteBackInput) commuteBackInput.value = pair.back ? String(pair.back) : '';
    updateAddModalCommuteHint();
  } else if (commuteHint) {
    commuteHint.textContent = 'No leave window';
  }

  // Load notes into block editor
  var notes = loadNotes();
  var noteVal = notes[taskId];
  var initialBlocks=typeof noteBlocksForTask === 'function' ? noteBlocksForTask(taskId, noteVal, taskEntry) : null;
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
  persistAddModalCommute();
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
  if (typeof render === 'function') render();
}

function renderModalItems(taskId) {
  var list = document.getElementById('am-items-list');
  if (!list) return;

  // Collect all items with their types and timestamps
  var items = [];

  // Subtasks (real tasks in the unified tree: subtaskOf === taskId)
  var subs = (typeof scheduled !== 'undefined' ? scheduled.filter(function(t){return t.subtaskOf===taskId;}) : [])
    .map(function(t){return { id:t.id, text:t.title, done:(typeof isDone==='function'&&isDone(t)), created:'2000-01-01' };});
  subs.forEach(function(st) {
    items.push({ type: 'subtask', id: st.id, text: st.text, done: !!st.done, created: st.created || '2000-01-01' });
  });

  // Linked side project items
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
    list.innerHTML = '<div class="am-empty">No items yet. Add subtasks or action items below.</div>';
    return;
  }

  // Subtask point allocation ("the pie"): pool, completion bonus, per-subtask
  // slices. Only present when this task has subtasks.
  var plan = (window.PointPlan && typeof window.PointPlan.compute === 'function') ? window.PointPlan.compute(taskId) : null;

  // Render in order added (by creation time)
  var tagColors = { subtask: 'var(--text-muted)', trivial: 'var(--cyan)', action: 'var(--amber)' };
  var tagLabels = { subtask: 'Sub', trivial: 'Side', action: 'Action' };

  var pieHtml = '';
  if (plan) {
    var dWord = plan.discrepancy < 0 ? 'over' : 'under';
    var dHtml = plan.discrepancy === 0
      ? '<span class="am-pie-ok">balanced</span>'
      : '<span class="am-pie-warn">' + Math.abs(plan.discrepancy) + ' pts ' + dWord + '</span>';
    pieHtml =
      '<div class="am-pie">' +
        '<div class="am-pie-row">' +
          '<label>Pool <input type="number" min="1" class="am-pie-pool" value="' + plan.pool + '"></label>' +
          '<label title="Awarded only when you check the whole task done">Completion bonus <input type="number" min="0" class="am-pie-bonus" value="' + plan.bonus + '"></label>' +
          dHtml +
        '</div>' +
      '</div>';
  }

  list.innerHTML = pieHtml + items.map(function(item) {
    var shareHtml = '';
    if (item.type === 'subtask' && plan && plan.shares[item.id]) {
      var locked = plan.shares[item.id].locked;
      shareHtml = '<input type="number" min="0" class="am-share' + (locked ? ' locked' : '') + '" data-id="' + item.id + '" value="' + plan.shares[item.id].pts + '" title="' + (locked ? 'Manually set — others rebalance around it' : 'Auto-split; edit to lock') + '"><span class="am-share-unit">pts</span>';
    }
    return '<div class="am-item" data-type="' + item.type + '" data-id="' + item.id + '">' +
      '<div class="am-check' + (item.done ? ' done' : '') + '">' + (item.done ? '✓' : '') + '</div>' +
      '<span class="am-text' + (item.done ? ' done' : '') + '">' + item.text + '</span>' +
      shareHtml +
      '<span class="am-tag" style="color:' + tagColors[item.type] + '">' + tagLabels[item.type] + '</span>' +
      (item.priority ? '<span class="am-pri" style="color:' + (item.priority === 'High' ? 'var(--red)' : item.priority === 'Medium' ? 'var(--amber)' : 'var(--text-muted)') + '">' + item.priority + '</span>' : '') +
      '<button class="am-del">✕</button>' +
    '</div>';
  }).join('');

  // Pie editing: pool / bonus / per-subtask slice. After each change, rebalance
  // and toast if the allocation no longer sums to the pool.
  function _pieToast(p) {
    if (!p || p.discrepancy === 0 || typeof showToast !== 'function') return;
    showToast(Math.abs(p.discrepancy) + ' points ' + (p.discrepancy < 0 ? 'over' : 'under'), p.discrepancy < 0 ? 'error' : 'info', 2200);
  }
  var poolInput = list.querySelector('.am-pie-pool');
  if (poolInput) poolInput.addEventListener('change', function() {
    var p = window.PointPlan.setPool(taskId, this.value); _pieToast(p);
    renderModalItems(taskId); if (typeof render === 'function') render();
  });
  var bonusInput = list.querySelector('.am-pie-bonus');
  if (bonusInput) bonusInput.addEventListener('change', function() {
    var p = window.PointPlan.setBonus(taskId, this.value); _pieToast(p);
    renderModalItems(taskId); if (typeof render === 'function') render();
  });
  list.querySelectorAll('.am-share').forEach(function(inp) {
    inp.addEventListener('change', function(e) {
      e.stopPropagation();
      var p = window.PointPlan.setShare(taskId, this.dataset.id, this.value); _pieToast(p);
      renderModalItems(taskId); if (typeof render === 'function') render();
    });
    inp.addEventListener('click', function(e) { e.stopPropagation(); });
  });

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
  var repeatBtn = document.getElementById('add-modal-repeat');
  if (repeatBtn) repeatBtn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!_addModalTaskId || typeof openRepeatResponsibilityFromTask !== 'function') return;
    var task = taskForRepeatResponsibility(_addModalTaskId);
    closeAddModal();
    setTimeout(function() { openRepeatResponsibilityFromTask(task); }, 0);
  });
  var delegatedBtn = document.getElementById('add-modal-delegated');
  if (delegatedBtn) delegatedBtn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!_addModalTaskId || typeof openDelegatedFromTask !== 'function') return;
    var task = taskForRepeatResponsibility(_addModalTaskId);
    closeAddModal();
    setTimeout(function() { openDelegatedFromTask({ title: (task && (task.title || task.text)) || '', durMin: (task && task.durMin) || 30 }); }, 0);
  });
  document.getElementById('add-modal-overlay').addEventListener('click', function(e) {
    if (e.target === e.currentTarget) closeAddModal();
  });
  ['am-commute-to-input','am-commute-back-input'].forEach(function(id) {
    var commuteInput = document.getElementById(id);
    if (!commuteInput) return;
    commuteInput.addEventListener('input', updateAddModalCommuteHint);
    commuteInput.addEventListener('change', function() {
      persistAddModalCommute();
      updateAddModalCommuteHint();
      if (typeof render === 'function') render();
    });
  });

  // Add item (subtask, side project, or action -- based on type dropdown)
  function addModalItem() {
    var inp = document.getElementById('am-item-input');
    var typeSelect = document.getElementById('am-item-type');
    var text = inp.value.trim();
    if (!text || !_addModalTaskId) return;
    var type = typeSelect.value;

    if (type === 'subtask') {
      addSubtask(_addModalTaskId, text);
    } else if (type === 'stacked') {
      if (typeof addStackedTask === 'function') addStackedTask(_addModalTaskId, text);
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

  // Legacy linked side-items may still exist, but new side projects live in the Side Projects lane.
  var pickExistingSideItem = document.getElementById('am-trivial-pick');
  if (pickExistingSideItem) pickExistingSideItem.addEventListener('click', function() {
    var picker = document.getElementById('am-trivial-picker');
    var tasks = loadTrivialTasks().filter(function(t) { return !t.done && !t.linkedTo; });
    if (!tasks.length) {
      picker.innerHTML = '<div class="am-empty">No unlinked side items available.</div>';
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

function _setSmallTaskBadge(id,count){
  const badge=document.getElementById(id);
  if(!badge)return;
  badge.textContent=count>99?"99+":String(count);
  badge.style.display=count?"":"none";
}

function _renderSmallTaskSection(opts){
  const el=document.getElementById(opts.containerId);if(!el)return 0;
  const label=opts.label;
  const kind=opts.kind;
  const accent=opts.accent;
  const extras=opts.extras||[];
  const tasks=opts.tasks||[];
  const activeRaw=tasks.filter(t=>!t.done&&!t.linkedTo);
  const doneRaw=tasks.filter(t=>t.done);
  const active=(typeof taskBankSort==="function"?taskBankSort(activeRaw.map(t=>({priority:"Low",...t}))):activeRaw)
    .filter(t=>typeof taskBankMatches==="function"?taskBankMatches(t,["text"]):true);
  const done=(typeof taskBankSort==="function"?taskBankSort(doneRaw.map(t=>({priority:"Low",...t}))):doneRaw)
    .filter(t=>typeof taskBankMatches==="function"?taskBankMatches(t,["text"]):true);
  const totalCount=extras.length+active.length;

  el.innerHTML="";
  if(!totalCount&&!done.length){
    const hasSearch=window.taskBankState&&window.taskBankState.query;
    const rawCount=extras.length+activeRaw.length+doneRaw.length;
    el.innerHTML='<div class="board-empty">'+(hasSearch&&rawCount?'No '+label.toLowerCase()+' tasks match that search.':'No '+label.toLowerCase()+' tasks. Use the task bar above to add one.')+'</div>';
    return totalCount;
  }

  extras.forEach(ev=>{
    const c=typeof cfg==='function'?cfg(ev.type):{color:'var(--text-muted)',tag:ev.type,cls:''};
    const card=document.createElement("div");card.className="board-card small-task-card small-task-flagged";
    card.innerHTML='<div class="small-task-accent" style="background:'+c.color+'"></div>'+
      '<div class="small-task-main">'+
        '<div class="small-task-title-row"><span class="ttl">'+ev.title+'</span>'+(typeof srcTag==='function'?srcTag(ev.source):'')+'</div>'+
        '<div class="small-task-meta"><span class="tag '+(c.cls||'')+'">'+c.tag+'</span><span>'+ms(dur(ev))+'</span></div>'+
        '<div class="small-task-actions">'+
          '<button class="add-btn small-task-action triv-restore-btn" data-tid="'+ev.id+'">Restore</button>'+
          '<button class="add-btn small-task-action small-task-done triv-flagged-done-btn" data-tid="'+ev.id+'">Done</button>'+
        '</div>'+
      '</div>';
    card.querySelector(".triv-restore-btn").addEventListener("click",e=>{e.stopPropagation();toggleTrivialFlag(ev.id)});
    card.querySelector(".triv-flagged-done-btn").addEventListener("click",e=>{e.stopPropagation();toggleDone(ev.id)});
    el.appendChild(card);
  });

  active.forEach(t=>{
    const duration=t.durMin?'<span>'+ms(t.durMin)+'</span>':'';
    const scheduleBtn=kind==="side_project" ? '<button class="add-btn small-task-action small-task-primary small-task-schedule-btn" data-tid="'+t.id+'">Schedule</button>' : '';
    const card=document.createElement("div");card.className="board-card small-task-card small-task-"+kind;
    card.innerHTML='<div class="small-task-accent" style="background:'+accent+'"></div>'+
      '<div class="small-task-main">'+
        '<div class="small-task-title-row">'+(typeof renderTaskBankTrivialTitle==="function"?renderTaskBankTrivialTitle(t):'<span class="ttl">'+t.text+'</span>')+'</div>'+
        '<div class="small-task-meta">'+duration+'<span>'+label+'</span></div>'+
        '<div class="small-task-actions">'+
          scheduleBtn+
          '<button class="add-btn small-task-action small-task-icon small-task-repeat-btn" data-tid="'+t.id+'" title="Turn into a repeat responsibility" aria-label="Turn into a repeat responsibility"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg></button>'+
          '<button class="add-btn small-task-action small-task-icon small-task-delegated-btn" data-tid="'+t.id+'" title="Delegated / Blocked" aria-label="Delegated / Blocked"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M16 11l2 2 4-4"/></svg></button>'+
          '<button class="add-btn small-task-action small-task-done triv-check-btn" data-tid="'+t.id+'">Done</button>'+
          '<span class="small-task-actions-spacer"></span>'+
          '<button class="task-bank-icon-btn triv-edit-btn" data-tid="'+t.id+'" title="Edit" aria-label="Edit"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg></button>'+
          '<button class="task-bank-icon-btn danger triv-del-btn" data-tid="'+t.id+'" title="Delete" aria-label="Delete"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M18 6L6 18M6 6l12 12"/></svg></button>'+
        '</div>'+
      '</div>';
    card.querySelector(".triv-check-btn").addEventListener("click",e=>{e.stopPropagation();toggleTrivialTask(t.id)});
    const repeat=card.querySelector(".small-task-repeat-btn");
    if(repeat)repeat.addEventListener("click",e=>{e.stopPropagation();if(typeof openRepeatResponsibilityFromTask==="function")openRepeatResponsibilityFromTask({id:t.id,title:t.text,type:kind,durMin:t.durMin||30,detail:t.detail||""})});
    const delegated=card.querySelector(".small-task-delegated-btn");
    if(delegated)delegated.addEventListener("click",e=>{e.stopPropagation();if(typeof openDelegatedFromTask==="function")openDelegatedFromTask({title:t.text,durMin:t.durMin||30})});
    const schedule=card.querySelector(".small-task-schedule-btn");
    if(schedule) schedule.addEventListener("click",e=>{e.stopPropagation();if(typeof openSchedulePicker==="function")openSchedulePicker(t.text,t.durMin||30)});
    const editBtn=card.querySelector(".triv-edit-btn");
    if(editBtn)editBtn.addEventListener("click",e=>{e.stopPropagation();if(typeof startTaskBankTrivialEdit==="function")startTaskBankTrivialEdit(t.id)});
    card.querySelector(".triv-del-btn").addEventListener("click",e=>{e.stopPropagation();deleteTrivialTask(t.id)});
    if(typeof bindTaskBankTrivialEdit==="function")bindTaskBankTrivialEdit(card,t);
    el.appendChild(card);
  });

  if(done.length){
    const doneWrap=document.createElement("details");doneWrap.style.cssText="margin-top:12px";
    doneWrap.innerHTML='<summary style="font-size:11px;font-weight:600;color:var(--text-muted);cursor:pointer;padding:6px 0">Done ('+done.length+')</summary>';
    const doneList=document.createElement("div");
    done.forEach(t=>{
      const card=document.createElement("div");card.className="board-card small-task-card small-task-done-card";card.style.opacity="0.62";
      card.innerHTML='<div class="small-task-accent" style="background:var(--green)"></div>'+
        '<div class="small-task-main">'+
          '<div class="small-task-title-row"><span class="ttl" style="text-decoration:line-through">'+t.text+'</span></div>'+
          '<div class="small-task-actions small-task-actions-compact">'+
            '<span class="small-task-meta">Completed</span>'+
            '<span class="small-task-actions-spacer"></span>'+
            '<button class="task-bank-icon-btn danger triv-del-btn" data-tid="'+t.id+'" title="Delete" aria-label="Delete"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M18 6L6 18M6 6l12 12"/></svg></button>'+
          '</div>'+
        '</div>';
      card.querySelector(".triv-del-btn").addEventListener("click",e=>{e.stopPropagation();deleteTrivialTask(t.id)});
      doneList.appendChild(card);
    });
    doneWrap.appendChild(doneList);
    el.appendChild(doneWrap);
  }
  return totalCount;
}

function buildTrivialTasks(){
  const tasks=loadTrivialTasks();
  const sideProjectTasks=tasks.filter(t=>smallTaskKind(t)==="side_project"&&!t.linkedTo);
  const sideProjectsCount=_renderSmallTaskSection({
    containerId:"triage-side-projects",
    label:"Side Project",
    kind:"side_project",
    accent:"var(--cyan,#22d3ee)",
    tasks:sideProjectTasks
  });
  _setSmallTaskBadge("trivial-count",0);
  _setSmallTaskBadge("trivial-tab-count",0);
  _setSmallTaskBadge("side-projects-section-count",sideProjectsCount);
  _setSmallTaskBadge("side-projects-count",sideProjectsCount);
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
function _focusBannerOpenTimerPanel(){
  if(typeof pomoState!=="undefined")pomoState.collapsedView="mini";
  if(typeof ftSetView==="function")ftSetView("panel");
}
function persistAddModalCommute() {
  if (!_addModalTaskId) return;
  var toInput = document.getElementById('am-commute-to-input');
  var backInput = document.getElementById('am-commute-back-input');
  if ((!toInput && !backInput) || typeof setTaskCommuteTimes !== 'function') return;
  setTaskCommuteTimes(_addModalTaskId, {
    to: toInput ? toInput.value : 0,
    back: backInput ? backInput.value : 0
  });
}

function updateAddModalCommuteHint() {
  var toInput = document.getElementById('am-commute-to-input');
  var backInput = document.getElementById('am-commute-back-input');
  var hint = document.getElementById('am-commute-hint');
  if ((!toInput && !backInput) || !hint) return;
  var taskEntry = (typeof scheduled !== 'undefined' && _addModalTaskId) ? scheduled.find(function(ev) { return ev.id === _addModalTaskId; }) : null;
  var to = typeof normalizeCommuteMinutes === 'function' ? normalizeCommuteMinutes(toInput ? toInput.value : 0) : (parseInt(toInput && toInput.value, 10) || 0);
  var back = typeof normalizeCommuteMinutes === 'function' ? normalizeCommuteMinutes(backInput ? backInput.value : 0) : (parseInt(backInput && backInput.value, 10) || 0);
  var pts = Math.round((to + back) * 0.1);
  var pointsText = (to || back) ? ((pts > 0 ? '+' + pts : '<1') + ' pts') : '';
  if (!taskEntry || !to || typeof commuteLeaveWindow !== 'function') {
    hint.textContent = pointsText || 'No leave window';
    return;
  }
  var preview = Object.assign({}, taskEntry, { commuteMinutes: to, commuteToMinutes: to, commuteBackMinutes: back });
  var win = commuteLeaveWindow(preview);
  hint.textContent = win ? (win.label + (pointsText ? ' · ' + pointsText : '')) : (pointsText || 'No leave window');
}
function _focusBannerNextItem(){
  if(typeof scheduled==="undefined"||!Array.isArray(scheduled))return null;
  const items=scheduled.filter(ev=>{
    if(!ev||ev.nested)return false;
    if(typeof isDone==="function"&&isDone(ev))return false;
    if(typeof isDeleted==="function"&&isDeleted(ev))return false;
    if(typeof isPushed==="function"&&isPushed(ev))return false;
    return !["break","ooo","free_time"].includes(ev.type);
  });
  if(!items.length)return null;
  const pinnedId=(typeof getPinnedActiveId==="function")?getPinnedActiveId():null;
  if(pinnedId){
    const pinned=items.find(ev=>String(ev.id)===String(pinnedId));
    if(pinned)return pinned;
  }
  const active=(typeof isActive==="function")?items.find(isActive):null;
  if(active)return active;
  if(typeof pt==="function"&&typeof now==="function"){
    const upcoming=items.find(ev=>pt(ev.start)>=now());
    if(upcoming)return upcoming;
  }
  return items[0];
}
function _focusBannerStartNext(){
  const next=_focusBannerNextItem();
  if(!next)return false;
  if(typeof openPomodoro==="function"){
    openPomodoro(next.title,typeof dur==="function"?dur(next):(next.durMin||25),{id:next.id,source:"schedule",title:next.title});
    return true;
  }
  return false;
}
function _focusBannerWireButton(){
  const btn=document.getElementById("fb-open-timer");
  if(!btn||btn.dataset.wired)return;
  btn.dataset.wired="1";
  btn.addEventListener("click",()=>{
    const hasTitle=typeof pomoState!=="undefined"&&pomoState.title&&pomoState.title!=="--";
    if(!hasTitle&&_focusBannerStartNext())return;
    _focusBannerOpenTimerPanel();
  });
}
function updateFocusBanner(){
  const banner=document.getElementById("focus-banner");
  if(!banner)return;
  _focusBannerWireButton();
  const title=(typeof pomoState!=="undefined"&&pomoState.title&&pomoState.title!=="--")?pomoState.title:null;
  const fbLabel=banner.querySelector(".fb-label");
  const fbTitle=document.getElementById("fb-title");
  const fbStatus=document.getElementById("fb-status");
  const fbBtn=document.getElementById("fb-open-timer");
  if(!title){
    const next=_focusBannerNextItem();
    if(!next){banner.style.display="none";return;}
    banner.style.display="flex";
    banner.classList.remove("running");
    banner.classList.add("ready");
    if(fbLabel)fbLabel.textContent="Want to start to focus?";
    if(fbTitle)fbTitle.textContent=next.title;
    if(fbStatus){
      const d=typeof dur==="function"?dur(next):(next.durMin||0);
      const dLabel=(typeof ms==="function")?ms(d):d+"m";
      fbStatus.textContent=d?"· "+dLabel+" ready":"· Ready";
    }
    if(fbBtn)fbBtn.title="Start timer for next item";
    return;
  }
  banner.style.display="flex";
  const running=(typeof pomoState!=="undefined"&&pomoState.running);
  banner.classList.remove("ready");
  banner.classList.toggle("running",running);
  if(fbLabel)fbLabel.textContent="Now Focusing";
  if(fbTitle)fbTitle.textContent=title;
  if(fbStatus){
    if(running){
      const rem=(typeof pomoFmt==="function")?pomoFmt(pomoState.remaining):"";
      fbStatus.textContent=rem?" · "+rem+" left":"";
    }else{
      fbStatus.textContent="· Paused";
    }
  }
  if(fbBtn)fbBtn.title="Open timer panel";
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
  const deletedTriage=(typeof loadDeletedTriage==="function")?loadDeletedTriage():[];
  const priColors={high:"var(--red)",medium:"var(--amber)",low:"var(--text-muted)"};
  const activeTriage=(typeof INIT_TRIAGE!=="undefined")?INIT_TRIAGE.filter(i=>!dismissed[i.id]&&!deletedTriage.includes(i.id)):[];
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
        '<span class="tqp-tri-meta">'+[item.priority||"", item.queue_label||item.source_label||""].filter(Boolean).join(" · ")+'</span>'+
        '<button class="tqp-delete-btn" data-tqp-delete-tri="'+item.id+'" title="Delete triage item" aria-label="Delete triage item">'+
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>'+
        '</button>'+
      '</div>';
    }).join('');
    triagePanel.querySelectorAll('.tqp-delete-btn').forEach(btn=>{
      btn.addEventListener('click',e=>{
        e.stopPropagation();
        if(typeof deleteTriageItem==='function')deleteTriageItem(btn.dataset.tqpDeleteTri);
      });
    });
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
    backlogPanel.innerHTML='<div class="tqp-empty">Backlog and Ideas is empty.</div>';
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
    var taskSource = t._pomoSource || (t.start && t.end ? 'schedule' : '');
    return '<div class="completion-item clickable" data-task-id="' + (t.id||'').replace(/"/g,'&quot;') + '" data-task-source="' + taskSource.replace(/"/g,'&quot;') + '" data-task-title="' + (t.title||'').replace(/"/g,'&quot;') + '">' +
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
  var overlays = document.querySelectorAll('.done-modal-overlay.open, .add-modal-overlay.open, .del-confirm-overlay.open, .sn-overlay.open, .notes-drawer-overlay.open, .delegated-modal-overlay.open');
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
function _doRender(){_renderPending=false;buildSchedule();buildConsider();buildBacklog();buildTriage();buildActionItemsTab();buildTrivialTasks();if(typeof buildScheduled==='function')buildScheduled();if(typeof buildScheduleSoon==='function')buildScheduleSoon();if(typeof buildGlymphaticBrief==='function')buildGlymphaticBrief();buildUpcoming();buildProgress();updateStats();updateSync();updateSnBadge();_updateTaskMenusBadge();if(schedView==="actual")buildActualView();else if(schedView==="list"&&typeof buildListView==='function')buildListView();if(typeof paintPivotTasks==='function')paintPivotTasks();updateFocusBanner();}
function _updateTaskMenusBadge(){
  const badge=document.getElementById("tasks-count");if(!badge)return;
  // Sum up counts from sub-tab badges
  const tc=parseInt(document.getElementById("triage-count")?.textContent||"0")||0;
  const sc=parseInt(document.getElementById("soon-count")?.textContent||"0")||0;
  const bc=parseInt(document.getElementById("backlog-count")?.textContent||"0")||0;
  const schedc=parseInt(document.getElementById("scheduled-count")?.textContent||"0")||0;
  const trivc=parseInt(document.getElementById("trivial-count")?.textContent||"0")||0;
  const sidec=parseInt(document.getElementById("side-projects-section-count")?.textContent||"0")||0;
  const repeatc=parseInt(document.getElementById("repeat-responsibilities-section-count")?.textContent||"0")||0;
  const groupc=parseInt(document.getElementById("task-groups-section-count")?.textContent||"0")||0;
  const total=tc+sc+bc+schedc+trivc+sidec+repeatc+groupc;
  badge.textContent=total;badge.style.display=total?"":"none";
  if(typeof refreshSidecarTabs==="function")refreshSidecarTabs();
}

// ======== BUTTONS ========
// Copy-for-Claude button removed 2026-07 (obsolete). btn-copy + buildClip gone.
// btn-undo and btn-reset removed Phase 6 -- both were broken-but-wired:
// undoLast() handled only 3 of 8 actionLog types; resetAll() wiped `scheduled`
// without touching BlockStore / pushedSet / deletedSet, leaving inconsistent UI.
// A real undo stack is a feature project, not tech debt; ship that separately.
// Old add-task-btn, ai-tab-add-btn, new-title wiring removed — handled by universal task-add bar


// ======== PREP FILES (loaded from API) ========
window.__PREP_FILES__ = {};
