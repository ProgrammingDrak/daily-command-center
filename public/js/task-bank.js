// ======== ACCOUNT-SCOPED TASK BANK HELPERS ========
// Task-bank rows persist through BlockStore. The server stamps every block with
// the active workspace_id, so edits/deletes stay account-specific.
(function(){
  const UI_KEY = "pa-task-bank-ui";
  const priorityRank = { High: 0, high: 0, Medium: 1, medium: 1, Low: 2, low: 2 };
  let state = { query: "", sort: "priority" };
  try { state = Object.assign(state, JSON.parse(localStorage.getItem(UI_KEY) || "{}")); } catch(e) {}

  let editingBacklogId = null;
  let editingTrivialId = null;

  function esc(v) { return window.DCC.esc(v); } // delegates to core.js

  function saveUi(){
    try { localStorage.setItem(UI_KEY, JSON.stringify(state)); } catch(e) {}
  }

  function norm(v){ return String(v || "").toLowerCase(); }

  function matchesTaskBankQuery(item, fields){
    const q = norm(state.query).trim();
    if(!q) return true;
    const hay = fields.map(k => norm(item && item[k])).join(" ");
    return hay.includes(q);
  }

  function taskBankSort(items, options){
    const sort = (options && options.sort) || state.sort || "priority";
    const getTitle = t => norm(t.title || t.text);
    const getDur = t => Number(t.durMin || t.duration || 0);
    const getCreated = t => new Date(t.createdAt || t.addedAt || t.added_at || 0).getTime() || 0;
    return [...items].sort((a,b) => {
      if(sort === "title") return getTitle(a).localeCompare(getTitle(b));
      if(sort === "duration") return getDur(a) - getDur(b) || getTitle(a).localeCompare(getTitle(b));
      if(sort === "newest") return getCreated(b) - getCreated(a) || getTitle(a).localeCompare(getTitle(b));
      if(sort === "oldest") return getCreated(a) - getCreated(b) || getTitle(a).localeCompare(getTitle(b));
      const pa = priorityRank[a.priority] ?? 3;
      const pb = priorityRank[b.priority] ?? 3;
      return pa - pb || getTitle(a).localeCompare(getTitle(b));
    });
  }

  function getBacklogBlock(localId){
    if(!window.blockStore) return null;
    return window.blockStore.getByType("block").find(b => {
      const p = b.properties || {};
      return p.kind === "backlog" && (p.local_id === localId || b.id === localId);
    }) || null;
  }

  function getBacklogDeleteBlock(localId){
    if(!window.blockStore) return null;
    return window.blockStore.getByType("block").find(b => {
      const p = b.properties || {};
      return p.kind === "backlog_deleted" && p.local_id === localId;
    }) || null;
  }

  function isBacklogDeleted(localId){
    return !!getBacklogDeleteBlock(localId);
  }

  function persistBacklogUpdate(localId, patch){
    const item = (typeof backlog !== "undefined" ? backlog : []).find(t => t.id === localId);
    if(item) Object.assign(item, patch, { updatedAt: new Date().toISOString() });
    const block = getBacklogBlock(localId);
    if(block && window.blockStore){
      const props = Object.assign({}, block.properties || {}, {
        title: patch.title !== undefined ? patch.title : (item && item.title),
        durMin: patch.durMin !== undefined ? patch.durMin : (item && item.durMin),
        priority: patch.priority !== undefined ? patch.priority : (item && item.priority),
        detail: patch.detail !== undefined ? patch.detail : (item && item.detail),
        stage: patch.stage !== undefined ? patch.stage : (item && item.stage),
        updated_at: new Date().toISOString()
      });
      window.blockStore.updateBlock(block.id, props);
    } else if(item && typeof persistBacklogItem === "function") {
      persistBacklogItem(item);
    }
  }

  function deleteBacklogTask(localId){
    if(typeof backlog !== "undefined") backlog = backlog.filter(t => t.id !== localId);
    const block = getBacklogBlock(localId);
    if(block && window.blockStore) window.blockStore.deleteBlock(block.id);
    else if(window.blockStore && !getBacklogDeleteBlock(localId)) {
      window.blockStore.createBlock("block",{
        kind:"backlog_deleted",
        local_id:localId,
        deleted_at:new Date().toISOString()
      },{date:null});
    }
    if(typeof render === "function") render();
  }

  function renderBacklogEditForm(t){
    if(editingBacklogId !== t.id) return "";
    return '<div class="task-bank-edit" data-bank-edit-id="'+esc(t.id)+'">'+
      '<input class="tbe-title" value="'+esc(t.title)+'" aria-label="Task title">'+
      '<select class="tbe-dur" aria-label="Duration">'+[15,30,45,60,90,120,180].map(m =>
        '<option value="'+m+'"'+((Number(t.durMin)||30)===m?' selected':'')+'>'+m+'m</option>'
      ).join('')+'</select>'+
      '<select class="tbe-priority" aria-label="Priority">'+["High","Medium","Low"].map(p =>
        '<option value="'+p+'"'+((t.priority||"Medium")===p?' selected':'')+'>'+p+'</option>'
      ).join('')+'</select>'+
      '<textarea class="tbe-detail" aria-label="Detail" placeholder="Details">'+esc(t.detail||"")+'</textarea>'+
      '<div class="task-bank-edit-actions">'+
        '<button type="button" class="bc-act tbe-cancel">Cancel</button>'+
        '<button type="button" class="bc-act bc-act-today tbe-save">Save</button>'+
      '</div>'+
    '</div>';
  }

  function bindBacklogEditForm(card, t){
    const form = card.querySelector('[data-bank-edit-id]');
    if(!form) return;
    const save = () => {
      const title = form.querySelector(".tbe-title").value.trim();
      if(!title) return;
      persistBacklogUpdate(t.id, {
        title,
        durMin: parseInt(form.querySelector(".tbe-dur").value, 10) || 30,
        priority: form.querySelector(".tbe-priority").value || "Medium",
        detail: form.querySelector(".tbe-detail").value.trim()
      });
      editingBacklogId = null;
      if(typeof showToast === "function") showToast("Task updated", "success");
      if(typeof render === "function") render();
    };
    form.querySelector(".tbe-save").addEventListener("click", e => { e.stopPropagation(); save(); });
    form.querySelector(".tbe-cancel").addEventListener("click", e => { e.stopPropagation(); editingBacklogId = null; render(); });
    form.querySelector(".tbe-title").addEventListener("keydown", e => {
      if(e.key === "Enter"){ e.preventDefault(); save(); }
      if(e.key === "Escape"){ e.preventDefault(); editingBacklogId = null; render(); }
    });
  }

  function updateTrivialTask(id, patch){
    if(window.USE_BLOCKSTORE && window.USE_BLOCKSTORE.trivialTasks && window.blockStore){
      const block = window.blockStore.get(id);
      if(block) window.blockStore.updateBlock(id, Object.assign({}, block.properties || {}, patch));
      return;
    }
    const tasks = typeof loadTrivialTasks === "function" ? loadTrivialTasks() : [];
    const task = tasks.find(t => t.id === id);
    if(task) Object.assign(task, patch);
    if(typeof saveTrivialTasks === "function") saveTrivialTasks(tasks);
  }

  function renderTrivialTitle(t){
    if(editingTrivialId !== t.id) return '<span class="ttl">'+esc(t.text)+'</span>';
    return '<input class="task-bank-inline-title" value="'+esc(t.text)+'" data-triv-edit-id="'+esc(t.id)+'" aria-label="Side project title">';
  }

  function bindTrivialEdit(card, t){
    const input = card.querySelector("[data-triv-edit-id]");
    if(!input) return;
    const save = () => {
      const next = input.value.trim();
      if(next && next !== t.text) updateTrivialTask(t.id, { text: next, updatedAt: new Date().toISOString() });
      editingTrivialId = null;
      if(typeof buildTrivialTasks === "function") buildTrivialTasks();
    };
    input.addEventListener("click", e => e.stopPropagation());
    input.addEventListener("keydown", e => {
      if(e.key === "Enter"){ e.preventDefault(); save(); }
      if(e.key === "Escape"){ e.preventDefault(); editingTrivialId = null; buildTrivialTasks(); }
    });
    input.addEventListener("blur", save);
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  function initTaskBankTools(){
    const search = document.getElementById("task-bank-search");
    const sort = document.getElementById("task-bank-sort");
    if(search){
      search.value = state.query || "";
      search.addEventListener("input", () => {
        state.query = search.value;
        saveUi();
        if(typeof render === "function") render();
      });
    }
    if(sort){
      sort.value = state.sort || "priority";
      sort.addEventListener("change", () => {
        state.sort = sort.value;
        saveUi();
        if(typeof render === "function") render();
      });
    }
  }

  window.taskBankMatches = matchesTaskBankQuery;
  window.taskBankSort = taskBankSort;
  window.taskBankEsc = esc;
  window.taskBankState = state;
  window.renderTaskBankBacklogEditForm = renderBacklogEditForm;
  window.bindTaskBankBacklogEditForm = bindBacklogEditForm;
  window.startTaskBankBacklogEdit = function(id){ editingBacklogId = id; if(typeof render === "function") render(); };
  window.deleteTaskBankBacklogTask = deleteBacklogTask;
  window.persistTaskBankBacklogUpdate = persistBacklogUpdate;
  window.isTaskBankBacklogDeleted = isBacklogDeleted;
  window.renderTaskBankTrivialTitle = renderTrivialTitle;
  window.bindTaskBankTrivialEdit = bindTrivialEdit;
  window.startTaskBankTrivialEdit = function(id){ editingTrivialId = id; if(typeof buildTrivialTasks === "function") buildTrivialTasks(); };
  window.updateTaskBankTrivialTask = updateTrivialTask;

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", initTaskBankTools);
  else initTaskBankTools();
})();
