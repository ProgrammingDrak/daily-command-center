// whenever.js — the header pill's doors for work with no time on it, in three kinds.
// They share one capsule with Loose Ends (catch-up.js) and Waiting (delegated.js), in
// triage order: Triage, Loose Ends, Waiting, Whenever.
//
//   Triage       open, unscheduled tasks created by automated sweeps.
//                Source identities stay attached. This is the itinerary's "Triage"
//                group, moved here; like Unscheduled, the itinerary still owns the
//                rows (schedule-tab.js renderTriageInto) and this file hosts them.
//   Off the Clock: work assigned to the viewed day without a start time.
//                  The itinerary renders the rows. This module runs the shared refresh.
//   Whenever     no set time at all. Laundry, grabbing the mail, anything you knock
//                out whenever a free minute shows up. Everything below is about this
//                half unless it says otherwise.
//
// NOT Anytime (anytime-store.js). Anytime is a target COUNT inside a repeating
// window ("water, 3 times today"). A Whenever task is one-off work with no window
// at all. It sits in a pool until you pull it into your day.
//
// THE MODEL IS AN EXISTING FIELD. A Whenever task is an ordinary dateless Task
// Library row (kind:"backlog") whose `stage` is "Whenever". `stage` is the field that
// already routes a backlog row to the Priority drawer (buildConsider), so this adds a
// value, not a column: no migration, no new row kind, and every backlog path (edit,
// delete, the Task Library, the schedule round trip) keeps working on these rows.
//
// This file owns NO mover. Every action routes through the canonical one:
//   add        addWheneverTask (schedule.js) -> persistBacklogItem
//   Do it now  addToSchedule re-dates the row IN PLACE onto today, then
//              rescheduleTaskToDate's same-day arm puts it at the next free slot
//              after whatever you are doing now (the "Move to Today" placement)
//   Done       Do it now, then toggleDone, so points, streaks and the completion
//              row all flow through the normal check-off
//   Not this   persistRowProp(stage:"Backlog") (state.js), back to the Library
//   in         moveTaskToWhenever (state.js), from Change task... on any row
//
// Browser: loaded right after task-model.js (schedule.js reads LABEL at load for the
// add-bar destination). Node: require()d by whenever.test.js for the pure half.
(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports
    ? require("./task-model.js")
    : root && root.DCC && root.DCC.TaskModel, typeof module === "object" && module.exports ? require("./task-queues.js") : root.DCC.TaskQueues);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    const DCC = (root.DCC = root.DCC || {});
    DCC.Whenever = api;
  }
})(typeof self !== "undefined" ? self : this, function (TaskModel, Queues) {
  "use strict";

  // The stored value. Rows carry it, so it never changes with the label below. It is
  // defined in task-model.js, beside the fold rule that keeps these rows off the day.
  const STAGE = (TaskModel && TaskModel.WHENEVER_STAGE) || "Whenever";

  // ── the design knobs ── display only, safe to swap without touching data.
  // LABEL names the Whenever half everywhere: pill segment, drawer half, add-bar
  // type and the Change task item.
  //   "Whenever" | "Free Time" | "Background" | "Odd Jobs" | "Side Quests"
  // "Whenever" won: it is the word you use for these ("whenever I have a minute"),
  // and it cannot be confused with the Anytime dock's "anytime".
  const LABEL = "Whenever";
  // UNSCHEDULED_LABEL names the other half the same way.
  //   "Unscheduled" | "Needs a time" | "To schedule" | "Unplanned"
  const UNSCHEDULED_LABEL = "Off the Clock";
  // TRIAGE_LABEL names the Triage door and drawer half.
  //   "Triage" | "Inbox" | "Incoming" | "To sort"
  // "Triage" kept: it is the word the rest of the app (and the old group) uses.
  const TRIAGE_LABEL = "Triage";
  // Color themes, one per half. Each half (its pill segment and its drawer half)
  // wears `queue-theme--<style>`; dashboard.css defines one var set per value.
  //   "sage" | "teal" | "amber"
  // Sage for Whenever: calm, and green reads "free". Amber for Unscheduled: it is
  // the half that wants action. Both stay clear of Loose Ends blue and Waiting violet.
  const PILL_STYLE = "sage";
  const UNSCHEDULED_STYLE = "amber";
  // Triage's theme. It sits first, beside Loose Ends blue.
  //   "crimson" | "red" | "slate"
  // Crimson, Drake's call (2026-10-05): Triage is the red door, and it took the
  // maroon Waiting wore before Waiting went violet. "red" is the louder option.
  const TRIAGE_STYLE = "crimson";

  // ── pure half (node-testable) ──

  function isWhenever(item) { return !!item && item.stage === STAGE; }

  function durationOf(item) { return Queues.durationOf(item); }



  // The pool, in pick order. Quick wins first, because a free minute is usually a
  // small one. Equal lengths go oldest first, so nothing sinks to the bottom forever.
  function selectWhenever(items) { return Queues.selectWhenever(items); }

  // "Surprise me" never picks the same row twice in a row when there is a choice.
  function pickIndex(count, lastIndex, rand) {
    if (!(count > 0)) return -1;
    if (count === 1) return 0;
    const r = typeof rand === "function" ? rand() : Math.random();
    let i = Math.floor(r * count) % count;
    if (i === lastIndex) i = (i + 1) % count;
    return i;
  }

  // ── browser half ──

  const busy = new Set();
  let lastPicked = -1;

  function esc(value) {
    const DCC = typeof window !== "undefined" && window.DCC;
    if (DCC && typeof DCC.esc === "function") return DCC.esc(value);
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }
  function toast(message, type, duration, action) {
    if (typeof showToast === "function") showToast(message, type || "success", duration, action);
  }
  function fmtDur(mins) { return typeof ms === "function" ? ms(mins) : mins + "m"; }
  function pool() { return typeof backlog !== "undefined" && Array.isArray(backlog) ? backlog : []; }
  function treeItems(){
    return TaskModel?TaskModel.selectNotDeleted(pool(),{isDeleted:ev=>typeof deletedSet!=='undefined'&&deletedSet.has(ev.id)}):pool();
  }
  function glassesTasks(){
    const items=selectWhenever(treeItems());
    return TaskModel?TaskModel.selectTree(items,{isCollapsed:()=>false}).map(node=>node.ev):items;
  }
  function rootItem(id){return TaskModel?TaskModel.hierarchyRoot(id,treeItems()):findItem(id);}
  const collapsed=new Set();
  function findItem(id) { return pool().find(t => t.id === id && isWhenever(t)) || null; }

  // The row behind a pool item. A row added this session has no _blockId until the
  // next hydrate, and without one addToSchedule CREATES a dated copy while the
  // dateless original stays in the pool, so it would come back on reload. The
  // optimistic cache already holds the row (createBlock mints the id up front), so
  // resolve it by local_id the way task-bank.js getBacklogBlock does.
  function rowFor(item) {
    if (!item || !window.blockStore) return null;
    const rows = window.blockStore.getByType("block");
    let row = item._blockId ? rows.find(b => b && b.id === item._blockId && !b.deleted_at) : null;
    if (!row) row = rows.find(b => {
      const p = b && b.properties;
      return p && !b.deleted_at && !b.date && p.kind === "backlog" && (p.local_id === item.id || b.id === item.id);
    });
    if (row) item._blockId = row.id;
    return row || null;
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value);
  }

  function syncCounts(triage, unscheduled, whenever) {
    setText("triage-pill-nav-count", triage);
    setText("triage-queue-count", triage);
    setText("unscheduled-count", unscheduled);
    setText("whenever-pill-nav-count", whenever);
    setText("whenever-count", whenever);
    const sum = triage + whenever;
    const total = document.getElementById("untimed-count");
    if (total) { total.textContent = String(sum); total.style.display = sum ? "" : "none"; }
    const t = document.getElementById("triage-pill-nav");
    if (t) t.setAttribute("aria-label", "Open " + TRIAGE_LABEL + " tasks, " + triage + " to decide");
    const w = document.getElementById("whenever-pill-nav");
    if (w) w.setAttribute("aria-label", "Open " + LABEL + " tasks, " + whenever + " open");
    const pick = document.getElementById("whenever-pick");
    if (pick) pick.disabled = whenever < 1;
  }

  // Rebuilding a list under the cursor would drop keyboard focus mid-tab. Remember
  // the focused control by its row id and first class, and land back on its twin.
  function keepFocus(list, rebuild) {
    const active = document.activeElement;
    const inside = active && list.contains(active);
    const rowEl = inside ? active.closest("[data-id],[data-whenever-id]") : null;
    const rowId = rowEl ? (rowEl.dataset.id || rowEl.dataset.wheneverId) : null;
    const cls = inside && active.classList.length ? active.classList[0] : null;
    rebuild();
    if (!rowId || !cls) return;
    const sel = '[data-id="' + CSS.escape(rowId) + '"] .' + CSS.escape(cls) + ', [data-whenever-id="' + CSS.escape(rowId) + '"].' + CSS.escape(cls);
    const again = list.querySelector(sel);
    if (again) again.focus({ preventScroll: true });
  }

  // The Unscheduled half: the itinerary renders its own rows into our list.
  function buildUnscheduled(model) {
    const list = document.getElementById("unscheduled-list");
    if (!list || typeof window.renderUnscheduledInto !== "function") return 0;
    let counts = { open: 0, total: 0 };
    keepFocus(list, () => { counts = window.renderUnscheduledInto(list, model) || counts; });
    if (!counts.total) list.innerHTML = '<div class="delegated-empty">Nothing waiting for a time slot.</div>';
    syncOffClockDisclosure(model);
    const mode = typeof _sectionSort === "function" ? _sectionSort("unscheduled") : "manual";
    document.querySelectorAll("[data-unscheduled-sort]").forEach(b => {
      const on = b.dataset.unscheduledSort === (mode === "alpha" || mode === "created" ? mode : "manual");
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    return counts.open;
  }

  function offClockKey(model) {
    return DCC.TimeBlocks.collapseKey(model.viewDate, DCC.TimeBlocks.UNPLANNED_BLOCK);
  }

  function syncOffClockDisclosure(model) {
    const toggle = document.getElementById("off-the-clock-toggle");
    if (!toggle || !model) return;
    const collapsed = isCollapsed(offClockKey(model));
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.querySelector(".time-block-chevron").textContent = collapsed ? "▸" : "▾";
    document.getElementById("off-the-clock-content").hidden = collapsed;
    document.getElementById("unscheduled-sort").hidden = collapsed;
  }

  // The Triage half, the same way: the itinerary renders its own rows, plus the
  // loader's status (Loading, or Retry after a failure) above them.
  function buildTriageQueue(model) {
    const list = document.getElementById("triage-queue-list");
    if (!list || typeof window.renderTriageInto !== "function") return 0;
    let counts = { open: 0, total: 0, status: false };
    keepFocus(list, () => { counts = window.renderTriageInto(list, model) || counts; });
    if (!counts.total && !counts.status) list.innerHTML = '<div class="delegated-empty">Nothing to triage.</div>';
    return counts.open;
  }

  // Production uses the same task-row component as normal tasks and subtasks.
  function sharedRow(t,node,index){
    const id=t.id,title=esc(t.title||'Task'),pending=busy.has((TaskModel.hierarchyRoot(id,null,index)||t).id);
    const source=window.DCC&&window.DCC.taskSourceUrl?window.DCC.taskSourceUrl(t):'';
    const safeSource=window.DCC&&window.DCC.TaskSources?window.DCC.TaskSources.safeUrl(source):'';
    const meta='<span class="it-list-context">'+(node.rel==='subtask'?'Subtask':node.depth?'Nested task':'Whenever')+'</span>'+
      (typeof taskTagsChipHtml==='function'?taskTagsChipHtml(t):'')+
      (safeSource?'<a class="detail-action-link" href="'+esc(safeSource)+'" target="_blank" rel="noopener noreferrer">Open source ↗</a>':'');
    const el=window.renderItineraryListRow(t,{
      extraClass:'whenever-row'+(pending?' is-busy':''),dataset:{wheneverId:id,wheneverDepth:node.depth},depth:Math.min(node.depth,6),
      barColor:'var(--queue-accent)',metaHtml:meta,
      completionTitle:'Complete this task; its tree moves to today',
      collapseHtml:node.hasKids?'<button class="wrap-collapse" aria-label="'+(node.collapsed?'Expand':'Collapse')+' '+title+'" aria-expanded="'+(!node.collapsed)+'">'+(node.collapsed?'▸':'▾')+'</button>':'',
      durationLabel:fmtDur(durationOf(t)),onDuration:!t.subtaskOf&&typeof openDurPopover==='function'?button=>openDurPopover(t,button):null,
      onComplete:()=>markDone(id),onCompleteWithNotes:()=>typeof openAddModal==='function'&&openAddModal(id,t.title),
      onSchedule:button=>schedulePicker(id,button),onAdd:button=>typeof openTaskAdd==='function'&&openTaskAdd(id,button),
      onOpen:()=>typeof openAddModal==='function'&&openAddModal(id,t.title),
      onDelete:()=>typeof openDeleteConfirm==='function'&&openDeleteConfirm(id),deleteLabel:'Delete task',deleteTitle:'Delete task and its subtasks',
      onCollapse:()=>{if(collapsed.has(id))collapsed.delete(id);else collapsed.add(id);build();},
      onRadial:button=>window.openTaskRadial(t,button),
      draggable:!pending,gripTitle:'Drag onto another Whenever task to nest it; Shift makes a subtask',
      onDragStart:e=>{e.dataTransfer.setData('text/dcc-whenever',id);e.dataTransfer.effectAllowed='move';},
      onDragOver:e=>{if(Array.from(e.dataTransfer.types||[]).includes('text/dcc-whenever'))e.preventDefault();},
      onDrop:e=>{const child=e.dataTransfer.getData('text/dcc-whenever');if(child&&child!==id){e.preventDefault();e.stopPropagation();if(typeof reparentAsSubtask==='function')reparentAsSubtask(child,id,{childEdge:e.shiftKey?'subtask':'wrap'});}}
    });
    if(pending)el.querySelectorAll('button').forEach(button=>button.disabled=true);
    const plus=el.querySelector('.btn-add-menu');if(plus)plus.setAttribute('aria-label','Add subtask or nested task to '+(t.title||'task'));
    return el;
  }
  function schedulePicker(id,button){
    if(typeof openSchedulePopover!=='function')return doNow(id);
    openSchedulePopover({mode:'pick',anchorEl:button,header:'Schedule task and its subtasks',allowTime:true,onPick:async(date,time)=>{
      try{await scheduleTree(id,{targetDate:date,start:time});refresh();}catch(error){toast(error.message,'error');}
    }});
  }

  function build() {
    if (typeof document === "undefined") return;
    // One itinerary derivation per build, shared by both halves: this runs on every
    // render, on every tab.
    const D = window.DCC;
    const model = typeof window.itineraryListModel === "function" && D && D.TaskModel && D.TimeBlocks
      ? window.itineraryListModel() : undefined;
    const triage = buildTriageQueue(model);
    const unscheduled = buildUnscheduled(model);
    const items = selectWhenever(treeItems());
    const nodes=TaskModel?TaskModel.selectTree(items,{isCollapsed:id=>collapsed.has(id)}):items.map(ev=>({ev,depth:0}));
    const rootCount=nodes.filter(node=>node.depth===0).length;
    syncCounts(triage, unscheduled, rootCount);
    const list = document.getElementById("whenever-list");
    if (!list) return;
    keepFocus(list, () => {
      if(items.length){
        const index=new Map(items.map(item=>[item.id,item]));
        list.replaceChildren(...nodes.map(node=>sharedRow(node.ev,node,index)));
      }else{
        list.innerHTML = '<div class="delegated-empty whenever-empty">Nothing here. Add the chores with no set time, like laundry or the mail.</div>';
      }
    });
  }

  function refresh() {
    build();
    if (typeof render === "function") render();
  }

  function add(title, durMin) {
    title = String(title || "").trim();
    if (!title) return null;
    if (typeof addWheneverTask !== "function") {
      toast("Tasks are still loading. Try again in a moment.", "info");
      return null;
    }
    const item = addWheneverTask(title, durMin);
    build();
    return item;
  }

  // Pull a Whenever task onto TODAY at the next free slot. Returns today's ev, or null.
  async function doNow(id, opts) {
    opts = opts || {};
    const requestedId=id;
    const root=rootItem(id);
    if(root)id=root.id;
    if (busy.has(id)) return null;
    busy.add(id);
    build();
    try {
      const today = typeof _resolvedTodayDate === "function" ? _resolvedTodayDate() : null;
      if (!today || typeof addToSchedule !== "function" || typeof rescheduleTaskToDate !== "function") {
        toast("Scheduling is still loading. Try again in a moment.", "info");
        return null;
      }
      // addToSchedule writes to the VIEWED day, and "now" only means something on today.
      if (typeof viewDate !== "undefined" && viewDate !== today && typeof switchToDate === "function") {
        await switchToDate(today);
      }
      const item = findItem(id);
      if (!item) { toast("That task already left " + LABEL, "info"); return null; }
      const selected=pool().find(task=>task.id===requestedId);
      const selectedRow=rowFor(selected);
      rowFor(item);
      // AWAIT the date write before placing. The placement pins the start through
      // savePinnedStarts, which only writes rows already on the viewed day; run it
      // first and the pin is refused, the end-of-day slot persists, and the task
      // jumps back there on reload. Same-row writes queue in order after this.
      await Promise.resolve(addToSchedule(item.id));
      // The atomic pool mover already selects the canonical free slot.
      // Legacy embeds still need the original in-day placement step.
      if(!window.blockStore||typeof window.blockStore.rescheduleBlock!=='function')await rescheduleTaskToDate(item.id, today, { silent: true });
      const ev = typeof scheduled !== "undefined" ? scheduled.find(e => e.id===requestedId||!!(selectedRow&&(e._blockId===selectedRow.id||e.id===selectedRow.id))) : null;
      if (!ev) return null;
      if (!opts.silent) {
        const at = typeof f12 === "function" && ev.start ? " at " + f12(ev.start) : "";
        toast("Up next: " + (ev.title || item.title) + at, "success");
      }
      return ev;
    } catch(error){
      toast(error.message,'error');return null;
    } finally {
      busy.delete(id);
      refresh();
    }
  }

  // Called by the canonical addToSchedule path. One transaction moves the entire tree.
  async function scheduleTree(id,options){
    options=options||{};
    const item=rootItem(id),row=rowFor(item);
    if(!item||!row||!window.blockStore||typeof window.blockStore.rescheduleBlock!=='function')throw new Error('Task storage is unavailable');
    const today=options.targetDate||(typeof _resolvedTodayDate==='function'?_resolvedTodayDate():null);
    const duration=durationOf(item);
    const f=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
    const placementTask=Object.assign({},item,{duration,start:'00:00',end:f(duration)});
    const minute=options.start&&/^([01]\d|2[0-3]):[0-5]\d$/.test(options.start)?Number(options.start.slice(0,2))*60+Number(options.start.slice(3)):null;
    const slot=minute!==null?{start:options.start,end:f(Math.min(1439,minute+duration))}:(typeof _computeRescheduleSlot==='function'?await _computeRescheduleSlot(placementTask,today):null);
    if(!slot)throw new Error('No free slot is available. Choose a time in the schedule.');
    const result=await window.blockStore.rescheduleBlock(row.id,today,{placement:{kind:'pool_schedule'},parentStart:slot.start,parentEnd:slot.end});
    if(typeof refoldTaskStateFromBlockCache==='function')refoldTaskStateFromBlockCache();
    if(typeof recalcTimes==='function')recalcTimes();
    return result;
  }

  // Completion already supports undated rows and stamps today atomically. Moving
  // the whole root to a timed slot first delayed feedback and could complete the
  // wrong node when the selected task was a child.
  async function markDone(id) {
    const ev=pool().find(task=>task.id===id);
    const today=typeof _resolvedTodayDate==='function'?_resolvedTodayDate():null;
    if(!ev||!today||typeof commitDoneOnDate!=='function')return false;
    const result=await commitDoneOnDate(ev.id,today,{ev});
    refresh();return result!==false;
  }

  // Through state.js persistRowProp, the canonical one-field writer: it queues a
  // read-modify-write on the row, so a stage flip cannot clobber an edit in flight.
  // (task-bank.js has a backlog updater too, but index.html does not load it.)
  function setStage(id, stage) {
    const item = pool().find(t => t.id === id);
    const row = rowFor(item);
    if (!item || !row || typeof persistRowProp !== "function") {
      toast("Could not update that task. Try again in a moment.", "error");
      return false;
    }
    if(typeof window.blockStore.rescheduleBlock==='function'){
      return Promise.resolve(window.blockStore.rescheduleBlock(row.id,null,{placement:{kind:'whenever',stage}})).then(()=>{
        if(typeof refoldTaskStateFromBlockCache==='function')refoldTaskStateFromBlockCache();refresh();return true;
      }).catch(error=>{toast(error.message,'error');return false;});
    }
    item.stage = stage;
    // Refold once the write lands. Leaving the pool puts the row in the Unscheduled
    // half and returning takes it out (TaskModel.isWheneverPoolRow); the
    // fold reads the block cache, so refolding before the queued write would not see it.
    Promise.resolve(persistRowProp(item.id, "stage", stage, null, { row })).then(() => {
      if (typeof refoldTaskStateFromBlockCache === "function") refoldTaskStateFromBlockCache();
      refresh();
    }).catch(() => {});
    return true;
  }

  function release(id) {
    const item = findItem(id);
    if (!item) return;
    const result=setStage(id, "Backlog");
    function notify(ok){
      if(!ok)return;
      build();
      toast("Moved to Someday", "success", 5000, {
        label: "Undo",
        onClick: () => { if (setStage(id, STAGE)) build(); }
      });
    }
    if(result&&typeof result.then==='function')result.then(notify);else notify(result);
  }

  function surprise() {
    const list = document.getElementById("whenever-list");
    const rows = list ? Array.from(list.querySelectorAll(".whenever-row")).filter(row=>!row.dataset.wheneverDepth||row.dataset.wheneverDepth==="0") : [];
    const i = pickIndex(rows.length, lastPicked);
    if (i < 0) return;
    lastPicked = i;
    rows.forEach(r => r.classList.remove("is-picked"));
    const row = rows[i];
    row.classList.add("is-picked");
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const now = row.querySelector(".whenever-now");
    if (now) now.focus({ preventScroll: true });
  }

  // Each pill opens only its own queue, preserving the existing row handlers.
  function open(half) {
    half = half === "triage" ? half : "whenever";
    build();
    if (typeof window.openTaskQueue === "function") window.openTaskQueue(half);
  }

  function setTheme(el, style) {
    if (!el) return;
    Array.from(el.classList).filter(c => c.indexOf("queue-theme--") === 0).forEach(c => el.classList.remove(c));
    el.classList.add("queue-theme--" + style);
  }

  function applyDesign() {
    document.querySelectorAll("[data-whenever-label]").forEach(el => { el.textContent = LABEL; });
    document.querySelectorAll("[data-triage-label]").forEach(el => { el.textContent = TRIAGE_LABEL; });
    const both = [TRIAGE_LABEL, LABEL].join(" \u00b7 ");
    document.querySelectorAll("[data-untimed-label]").forEach(el => { el.textContent = both; });
    // Each half's pill segment and drawer half wear one theme, so they swap together.
    setTheme(document.getElementById("whenever-pill-nav"), PILL_STYLE);
    setTheme(document.getElementById("whenever-sub"), PILL_STYLE);
    setTheme(document.getElementById("unscheduled-sub"), UNSCHEDULED_STYLE);
    setTheme(document.getElementById("triage-pill-nav"), TRIAGE_STYLE);
    setTheme(document.getElementById("triage-sub"), TRIAGE_STYLE);
    const section = document.getElementById("tm-whenever-section");
    if (section) section.dataset.sidecarLabel = both;
    // Label-bearing aria text and tooltips follow the knobs too, so a swap never
    // leaves the old word behind for screen readers or on hover.
    const attr = (sel, name, value) => document.querySelectorAll(sel).forEach(el => el.setAttribute(name, value));
    attr("#triage-sub .untimed-tip", "aria-label", "What goes in " + TRIAGE_LABEL + "?");
    attr("#whenever-sub .untimed-tip", "aria-label", "What goes in " + LABEL + "?");
    attr("#unscheduled-sort", "aria-label", "Sort " + UNSCHEDULED_LABEL);
    attr("#whenever-pill-nav", "title", LABEL + ": no set time. Knock one out when you have a free minute.");
    attr("#triage-pill-nav", "title", TRIAGE_LABEL + ": open, unscheduled tasks created by automated sweeps.");
  }

  // The "i" tooltips. Hover and keyboard focus show them through CSS; a tap toggles
  // aria-expanded, because a phone has neither.
  function closeTips(except) {
    document.querySelectorAll(".untimed-tip[aria-expanded='true']").forEach(b => {
      if (b !== except) b.setAttribute("aria-expanded", "false");
    });
  }
  function wireTips() {
    document.querySelectorAll(".untimed-tip").forEach(btn => btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      const next = btn.getAttribute("aria-expanded") !== "true";
      closeTips(btn);
      btn.setAttribute("aria-expanded", next ? "true" : "false");
    }));
    document.addEventListener("click", e => { if (!e.target.closest(".untimed-tip-wrap")) closeTips(null); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeTips(null); });
  }

  // The Unscheduled segment is the drop target the itinerary's Unplanned zone used to
  // be: drop a timed task on it and moveTaskToUnplanned takes its time off. The zone's
  // own handlers (drag.js) do the work, reading data-placement="unplanned" off the pill.
  function wireDrop(seg) {
    if (!seg || typeof dBlockOver !== "function" || typeof dBlockDrop !== "function") return;
    seg.addEventListener("dragover", dBlockOver);
    seg.addEventListener("dragleave", () => seg.classList.remove("drag-over-block"));
    seg.addEventListener("drop", e => { seg.classList.remove("drag-over-block"); return dBlockDrop(e); });
  }

  function init() {
    applyDesign();
    const wheneverSeg = document.getElementById("whenever-pill-nav");
    if (wheneverSeg) wheneverSeg.addEventListener("click", () => open("whenever"));
    const offClockToggle = document.getElementById("off-the-clock-toggle");
    offClockToggle?.addEventListener("click", () => {
      const model = window.itineraryListModel();
      toggleCollapsed(offClockKey(model));
      syncOffClockDisclosure(model);
    });
    const triageSeg = document.getElementById("triage-pill-nav");
    if (triageSeg) triageSeg.addEventListener("click", () => open("triage"));
    wireDrop(offClockToggle?.closest("[data-placement]"));
    wireTips();

    // Same three orders the old Unplanned header offered, same persisted setting.
    document.querySelectorAll("[data-unscheduled-sort]").forEach(btn => btn.addEventListener("click", () => {
      if (typeof _setSectionSort === "function") _setSectionSort("unscheduled", btn.dataset.unscheduledSort);
      build();
    }));

    const form = document.getElementById("whenever-add");
    if (form) form.addEventListener("submit", e => {
      e.preventDefault();
      const input = document.getElementById("whenever-add-title");
      const dur = document.getElementById("whenever-add-dur");
      const created = add(input && input.value, dur ? parseInt(dur.value, 10) || 15 : 15);
      if (created && input) { input.value = ""; input.focus(); }
      else if (input && !input.value.trim()) input.focus();
    });

    const pick = document.getElementById("whenever-pick");
    if (pick) pick.addEventListener("click", surprise);

    const list = document.getElementById("whenever-list");
    if (list) list.addEventListener("click", e => {
      const btn = e.target.closest("[data-whenever-action]");
      if (!btn || btn.disabled) return;
      e.stopPropagation();
      const id = btn.dataset.wheneverId;
      const action = btn.dataset.wheneverAction;
      if (action === "now") doNow(id);
      else if (action === "done") markDone(id);
      else if (action === "release") release(id);
      else if (action === "details" && typeof openAddModal==='function')openAddModal(id,(findItem(id)||{}).title);
      else if (action === "add-child" && typeof openTaskAdd==='function')openTaskAdd(id,btn);
      else if (action === "delete" && typeof openDeleteConfirm==='function')openDeleteConfirm(id);
      else if (action === "collapse"){if(collapsed.has(id))collapsed.delete(id);else collapsed.add(id);build();}
    });

    build();
  }

  if (typeof document !== "undefined" && typeof window !== "undefined") {
    // features.js SURFACES calls this every render: it owns the always-visible pill
    // counts, and the Unscheduled half re-renders the itinerary's rows with it.
    window.buildWhenever = build;
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  }

  return {
    STAGE, LABEL, PILL_STYLE, UNSCHEDULED_LABEL, UNSCHEDULED_STYLE, TRIAGE_LABEL, TRIAGE_STYLE,
    isWhenever, durationOf, selectWhenever, pickIndex, glassesTasks,
    build, add, doNow, scheduleTree, markDone, release, open
  };
});
