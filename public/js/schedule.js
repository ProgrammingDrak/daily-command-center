// ======== OVERFLOW DETECTION ========
let EOD = (function(){
  // Prefer last work-type block end
  if(__state&&__state.schedule&&__state.schedule.blocks){
    const wb=__state.schedule.blocks.filter(b=>(b.blockType||b.type)==='work');
    if(wb.length) return pt(wb[wb.length-1].end);
  }
  if(__state&&__state.schedule&&__state.schedule.end_time){
    const t=__state.schedule.end_time;
    return pt(t.length>5?t.substring(11,16):t);
  }
  return pt("17:30");
})();


// ======== QUICK ADD (inline schedule insertion) ========
let ADDED_KEY = "pa-added-tasks-" + ((__state && __state.date) ? __state.date : "unknown");
function loadAddedTasks(){ try{return JSON.parse(localStorage.getItem(ADDED_KEY)||"[]")}catch(e){return[]} }
function saveAddedTasks(tasks){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.addedTasks&&window.blockStore)return; // blockstore handles it
  localStorage.setItem(ADDED_KEY,JSON.stringify(tasks)); scheduleIDBSave();
}
function persistAddedTask(item,targetDate){
  // dur() is end-start, which is meaningless on an untimed item (no start yet,
  // e.g. a future-day create from the schedule popover) — fall back to durMin.
  const _computedDur=dur(item);
  const _itemDur=(Number.isFinite(_computedDur)&&_computedDur>0)?_computedDur:(item.durMin||30);
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.addedTasks&&window.blockStore){
    // Write to blockstore — will be reloaded via property-based query on refresh
    const date=targetDate||((typeof viewDate!=="undefined"&&viewDate)?viewDate:((__state&&__state.date)?__state.date:null));
    return window.blockStore.createBlock("block",{
      kind:item.kind||undefined,
      local_id:item.id,
      type:item.type||"task",
      title:item.title,
      duration:_itemDur,
      start:item.start,
      end:item.end,
      priority:item.priority||"High",
      meta:item.meta||"",
      detail:item.detail||"",
      notionUrl:item.notionUrl||"",
      calUrl:item.calUrl||"",
      source:item.source||"manual",
      tags:item.tags||[],
      idempotency_key:item.idempotency_key||item.idempotencyKey||null,
      responsibilityId:item.responsibilityId||null,
      responsibilityTitle:item.responsibilityTitle||null,
      capacityBucket:item.capacityBucket||null,
      responsibilityScore:item.responsibilityScore||null,
      alertKey:item.alertKey||null,
      alertType:item.alertType||null,
      triageId:item.triageId||null,
      delegatedItemId:item.delegatedItemId||null,
      linkedBlockId:item.linkedBlockId||null,
      linkedTagId:item.linkedTagId||null,
      ampUrl:item.ampUrl||null,
      hubspotUrl:item.hubspotUrl||null,
      commuteMinutes:item.commuteMinutes||null,
      commuteToMinutes:item.commuteToMinutes||item.commuteMinutes||null,
      commuteBackMinutes:item.commuteBackMinutes||item.commuteReturnMinutes||null,
      publicVisibility:item.publicVisibility||"public",
      wrapId:item.wrapId||null,
      isWrap:!!item.isWrap,
      subtaskOf:item.subtaskOf||null,
      reschedulePlacement:item.reschedulePlacement||null,
      rescheduledFrom:item.rescheduledFrom||null,
      sourceTaskId:item.sourceTaskId||null,
      // C5b: completion travels on the row, so an item that is ALREADY done when it is
      // persisted says so here rather than being marked done afterwards in the day's
      // `_done` overlay. Only prep.js's distraction log uses this today; `undefined`
      // keys drop out of the JSON body, so every other caller is unaffected.
      status:item.status||undefined,
      done:item.done||undefined,
      completedAt:item.completedAt||undefined,
      added_at:new Date().toISOString()
    },{date});
  }
  // Fallback: localStorage
  const key=targetDate?("pa-added-tasks-"+targetDate):ADDED_KEY;
  let added=[];
  try{added=JSON.parse(localStorage.getItem(key)||"[]")}catch(e){added=[]}
  if(!added.find(t=>t.id===item.id)){
    added.push({
      id:item.id,title:item.title,type:item.type||"task",durMin:_itemDur,
      priority:item.priority||"High",source:item.source||"manual",
      meta:item.meta||"",detail:item.detail||"",notionUrl:item.notionUrl||"",
      calUrl:item.calUrl||"",tags:item.tags||[],
      triageId:item.triageId||null,delegatedItemId:item.delegatedItemId||null,
      linkedBlockId:item.linkedBlockId||null,linkedTagId:item.linkedTagId||null,
      ampUrl:item.ampUrl||null,hubspotUrl:item.hubspotUrl||null,
      commuteMinutes:item.commuteMinutes||null,
      commuteToMinutes:item.commuteToMinutes||item.commuteMinutes||null,
      commuteBackMinutes:item.commuteBackMinutes||item.commuteReturnMinutes||null,
      publicVisibility:item.publicVisibility||"public",
      wrapId:item.wrapId||null,isWrap:!!item.isWrap,subtaskOf:item.subtaskOf||null,
      reschedulePlacement:item.reschedulePlacement||null,
      rescheduledFrom:item.rescheduledFrom||null,
      sourceTaskId:item.sourceTaskId||null,
      addedAt:new Date().toISOString()
    });
    localStorage.setItem(key,JSON.stringify(added));scheduleIDBSave();
  }
}

// After recalcTimes changes positions (e.g. drag reorder), sync blockstore added_task blocks
function syncAddedTaskTimes(){
  if(!window.USE_BLOCKSTORE||!window.USE_BLOCKSTORE.addedTasks||!window.blockStore)return;
  // Match the date + foldability filters in reloadPersistedEdits — otherwise we'd
  // rewrite start/end on blocks from other days. Startless blocks (API inserts /
  // untimed rows) are included so a drag out of the Unscheduled section persists
  // its newly assigned time; rows still sitting in that section are skipped below.
  //
  // C4: the row test is TaskModel.foldsIntoItinerary, shared with the fold, because
  // this copy had drifted — it was missing the fold's `isShell` branch, so a shell
  // block rendered in the itinerary and then never persisted its start/end and reset
  // its times on every reload.
  const TM=window.DCC&&window.DCC.TaskModel;
  if(!TM||typeof TM.foldsIntoItinerary!=="function"){
    console.error("[schedule] task-model.js missing or stale — task times cannot persist");
    return;
  }
  const currentDate=window.blockStore.getCurrentDate();
  const addedBlocks=[...window.blockStore.getByType("added_task"),...window.blockStore.getByType("block").filter(b=>{
    if(!TM.foldsIntoItinerary(b))return false;
    return !b.date||b.date===currentDate;
  })];
  const datedLocalIds=new Set(window.blockStore.getByType("block")
    .filter(x=>x.date&&(x.properties||{}).local_id)
    .map(x=>x.properties.local_id));
  addedBlocks.forEach(block=>{
    const p=block.properties||{};
    const ev=scheduled.find(e=>e.id===(p.local_id||block.id));
    if(!ev)return;
    if(ev.untimed)return; // still unscheduled: keep the block startless
    // A dateless row whose local_id has a dated sibling is a suppressed leftover
    // copy; ev here is the SIBLING's task, so never stamp times onto the copy.
    if(!block.date&&p.local_id&&datedLocalIds.has(p.local_id))return;
    if(!block.date){
      // Dragged out of Unscheduled: the task is now scheduled for the viewed day, so
      // the date lands on the block along with its slot. C4 routes this through the
      // shared primitive — this line WAS the reuse target the phase plan named, and
      // it is now one of two callers rather than a third hand-rolled copy. It also
      // gains the kind:"backlog" strip, which is why a dragged-out backlog row stops
      // rendering in the drawer as well as on the day.
      if(typeof scheduleRowOnDay==="function")scheduleRowOnDay(block.id,currentDate,{start:ev.start,end:ev.end});
      else window.blockStore.updateBlock(block.id,{...p,start:ev.start,end:ev.end},{date:currentDate});
    } else if(p.start!==ev.start||p.end!==ev.end){
      window.blockStore.updateBlock(block.id,{...p,start:ev.start,end:ev.end});
    }
  });
}

function insertTaskNow(titleArg, durMinArg, opts){
  opts=opts||{};
  const title=titleArg||(function(){const inp=document.getElementById("qa-title");const v=inp?inp.value.trim():"";if(inp)inp.value="";return v})();
  if(!title)return;
  // A shell has no length of its own — it starts zero-length and derives its
  // span from the children that get added to it (durationFromChildren).
  const durFromKids=window.TaskTypes&&window.TaskTypes.rule(opts.type,"durationFromChildren");
  const durMin=durFromKids?0:(durMinArg||30);
  const id=qaId();

  // Pin start to the next free 15-minute slot from now, stepping past any
  // meeting block. Without a pin, recalcTimes() would cascade from the first
  // undone task -- which on an empty/sparse day collapses the urgent task to
  // 00:00.
  const roundTo15=m=>Math.ceil(m/15)*15;
  const meetings=_meetingBlocks();
  const startMin=_freeStart(roundTo15(now()),durMin,meetings);
  const startStr=fmt(startMin);

  const newItem=Object.assign({id,title,type:opts.type||"task",start:startStr,end:fmt(startMin+durMin),
    // Rollup containers are wraps from birth so drag carries their children.
    isWrap:(window.TaskTypes&&window.TaskTypes.rule(opts.type,"dragMovesSubtree"))||undefined,
    _pinnedStart:startStr},schedulePickerFields(durMin,opts));

  // Calculate insertion position
  const activeIdx=scheduled.findIndex(isActive);
  const insertAt = activeIdx !== -1 ? activeIdx + 1 :
    (()=>{const firstOpen=DCC.TaskModel.selectOpen(scheduled)[0];
      const fi=firstOpen?scheduled.indexOf(firstOpen):-1;
      return fi===-1?scheduled.length:fi;})();

  // Simulate placement: temporarily add, cascade, read the worst end among
  // user-controllable tasks, then remove. Checking only newItem.end would miss
  // cases where the pinned insert bumps a later task past EOD.
  scheduled.splice(insertAt, 0, newItem);
  recalcTimes();
  const simulatedEnd=DCC.TaskModel.selectActive(scheduled)
    .filter(ev=>pointEligible(ev))
    .reduce((max,ev)=>Math.max(max,pt(ev.end)),0);
  scheduled.splice(scheduled.indexOf(newItem), 1);
  recalcTimes(); // restore cascade without the new item

  // Always commit the task. (The old overflow-modal detour that staged a
  // "doesn't fit" task and asked you to push things to tomorrow was removed
  // 2026-07 -- tasks just get added; the day can run long.)
  scheduled.splice(insertAt, 0, newItem);
  recalcTimes();
  const pins=loadPinnedStarts();pins[id]=startStr;savePinnedStarts(pins);
  // The dated block from persistAddedTask is the single record. The old extra
  // savePendingTasks push here minted a dateless kind:"pending_task" twin with
  // the same local_id that nothing ever deleted.
  const persistence=persistAddedTask(newItem);
  log("scheduled",id,"Quick-added at "+startStr+": "+title);
  render();
  checkBlockWarnings(newItem);
  if(typeof opts.onScheduled==="function"){
    try{opts.onScheduled({localId:id,blockId:id,start:startStr,dateStr:(window.blockStore&&window.blockStore.getCurrentDate&&window.blockStore.getCurrentDate())||null,persisted:Promise.resolve(persistence)});}catch(e){}
  }
}

function insertTaskFromDrawer(title, durMin, opts){
  opts=opts||{};
  const id=qaId();
  const newItem={id,title,type:"task",start:"00:00",end:fmt(durMin),
    meta:(opts.meta||"Action item")+" \u00b7 "+ms(durMin),detail:opts.detail||"",source:opts.source||"manual",
    notionUrl:opts.notionUrl||"",priority:opts.priority||"High",
    tags:opts.tags||[],triageId:opts.triageId||null};
  const activeIdx=scheduled.findIndex(isActive);
  const insertAt = activeIdx !== -1 ? activeIdx + 1 :
    (()=>{const firstOpen=DCC.TaskModel.selectOpen(scheduled)[0];
      const fi=firstOpen?scheduled.indexOf(firstOpen):-1;
      return fi===-1?scheduled.length:fi;})();
  scheduled.splice(insertAt, 0, newItem);
  persistAddedTask(newItem);
  recalcTimes();
  
  log("scheduled",id,"Drawer-added: "+title);
  render();
  checkBlockWarnings(newItem);
  return newItem;
}

// ── SHELL TEMPLATE MATERIALIZATION ──
// Rebuild a saved shell template (root + nested children) onto the day using the
// SAME live primitives a hand-built shell uses — addStackedTask for ride-along
// children, addSubtask for timeless subtasks — so every block renders normally
// and its kind is never "responsibility_task" (which the itinerary fold in
// persistence.js rejects). Recurses into nested children. The shell root is
// created by materializeShellTemplate, which then calls this in its onScheduled.
function attachTemplateChildren(parentLocalId,children){
  if(!parentLocalId||!Array.isArray(children))return;
  children.forEach(function(node){
    if(!node||!node.title)return;
    var created=null;
    if(node.edge==="subtask"){
      if(typeof addSubtask==="function")created=addSubtask(parentLocalId,node.title);
    }else{
      var d=Math.max(1,Number(node.durationMin)||30);
      if(typeof addStackedTask==="function")created=addStackedTask(parentLocalId,node.title,d,{priority:node.priority||"Medium",type:node.type||"task",detail:node.detail||""});
    }
    if(created&&created.id&&Array.isArray(node.children)&&node.children.length){
      attachTemplateChildren(created.id,node.children);
    }
  });
}
window.attachTemplateChildren=attachTemplateChildren;

// Idempotency: is a shell for this responsibility already live on the viewed day?
function _shellAlreadyOnDay(responsibilityId){
  if(!responsibilityId||typeof scheduled==="undefined")return false;
  return DCC.TaskModel.selectNotDeleted(scheduled).some(function(e){
    return e.responsibilityId===responsibilityId&&window.TaskTypes&&window.TaskTypes.isRollup(e);
  });
}
window._shellAlreadyOnDay=_shellAlreadyOnDay;

// Drop a whole shell template onto TODAY at the next free slot (no time picker).
// Creates the zero-length shell root via insertTaskNow, then attaches the saved
// children in the onScheduled callback so the sequential-shell reflow sizes it.
// Returns the shell root's local id (or null if deduped / invalid).
function materializeShellTemplate(templateTree,opts){
  opts=opts||{};
  if(!templateTree||!templateTree.root)return null;
  var root=templateTree.root;
  if(opts.responsibilityId&&_shellAlreadyOnDay(opts.responsibilityId)){
    if(typeof showToast==="function")showToast('"'+(root.title||"Shell")+'" is already on today',"info");
    return null;
  }
  var curDate=(window.blockStore&&window.blockStore.getCurrentDate&&window.blockStore.getCurrentDate())||"";
  var rootId=null;
  insertTaskNow(root.title,0,{
    type:root.type||"shell",
    responsibilityId:opts.responsibilityId||null,
    responsibilityTitle:opts.responsibilityTitle||root.title,
    priority:root.priority||"High",
    source:opts.source||"responsibility",
    tags:opts.tags||["responsibility"],
    detail:root.detail||"",
    idempotencyKey:opts.responsibilityId?("resp-shell:"+opts.responsibilityId+":"+curDate):null,
    onScheduled:function(info){
      rootId=info&&info.localId;
      if(rootId)attachTemplateChildren(rootId,root.children||[]);
      if(typeof opts.onScheduled==="function"){try{opts.onScheduled(info);}catch(e){}}
    }
  });
  return rootId;
}
window.materializeShellTemplate=materializeShellTemplate;

// ======== ACTIONS ========
// Day points currently earned (completed, point-eligible tasks). Used to drive
// the count-up animation when a task is checked off. Safe before schedule-tab.js
// loads -- returns 0 if the summary helper isn't available yet.
function _earnedPointsNow(){
  try { return (typeof _dayPointSummary === "function") ? (_dayPointSummary().earned || 0) : 0; }
  catch(e){ return 0; }
}
// Locate the checkbox the user just clicked so confetti can erupt from it.
// Rows carry data-id; the check button is .chk (list) or .c-check (card view).
function _completionAnchorRect(id){
  try {
    var key = (window.CSS && CSS.escape) ? CSS.escape(String(id)) : String(id);
    var row = document.querySelector('[data-id="' + key + '"]');
    var chk = row && (row.querySelector(".chk") || row.querySelector(".c-check"));
    if(chk) return chk.getBoundingClientRect();
  } catch(e){}
  return null;
}
// Snapshot taken at click time, BEFORE the task is marked done and the list
// re-renders: where the checkbox sits (confetti origin) and points earned so far.
function _beginCompletionCelebration(id){
  return { rect: _completionAnchorRect(id), prevEarned: _earnedPointsNow() };
}
// Run AFTER render(): confetti erupts from the just-checked task, whirlwinds
// together, and streams into the points counter -- which then counts up from
// the pre-completion total to the new one as the swarm pours in.
function _finishCompletionCelebration(ctx, id){
  if(!window.Celebrate || !ctx) return;
  var rect = ctx.rect || _completionAnchorRect(id);
  var x = rect ? (rect.left + rect.width / 2) : (window.innerWidth / 2);
  var y = rect ? (rect.top + rect.height / 2) : (window.innerHeight / 3);

  var summary;
  try { summary = (typeof _dayPointSummary === "function") ? _dayPointSummary() : null; }
  catch(e){ summary = null; }
  var newEarned = summary ? (summary.earned || 0) : 0;
  var pointEl = document.getElementById("s-points");
  var gained = !!(pointEl && summary && newEarned > ctx.prevEarned);

  // Target the confetti at the points counter so it flows into it.
  var target = { x: window.innerWidth - 90, y: 90 };
  if(pointEl){
    var pr = pointEl.getBoundingClientRect();
    if(pr && pr.width){ target = { x: pr.left + pr.width / 2, y: pr.top + pr.height / 2 }; }
  }

  // When the swarm reaches the counter, pulse it and tick the points up.
  var onArrive = function(){
    if(!gained) return;
    var schedTxt = summary.scheduledPoints;
    pointEl.classList.remove("points-pop");
    // Reflow so the animation restarts even if it fired moments ago.
    void pointEl.offsetWidth;
    pointEl.classList.add("points-pop");
    Celebrate.countNumber(pointEl, ctx.prevEarned, newEarned, {
      duration: 750,
      format: function(v){ return v + " / " + schedTxt; }
    });
    setTimeout(function(){ pointEl.classList.remove("points-pop"); }, 850);
  };

  Celebrate.confetti({ x: x, y: y, flowTo: target, onArrive: onArrive });
}

// Mark `id` done in a different date's persistence (not the currently-viewed day).
// Used when completing a future/past task and pinning the completion to a specific date.
// Mark `id` done on `dateStr`, which may not be the day being viewed.
//
// `opts.ev` / `opts.awardPoints` exist because the caller may have MOVED the task
// before committing (the "was this done today?" choice → bringToToday). A true move
// drops the row out of `scheduled` (state.js _removeSubtreeFromScheduled), so this
// function's own lookup misses and the credit falls back to a synthetic
// {title:"Task completed", type:"task"} — wrong title in the log, and default
// duration scoring instead of the task's own pie/rollup award. Whoever moves the
// row is the only one who can still see it, so they hand it over.
async function _legacyCommitDoneOnDate(id,dateStr,opts){
  if(!id||!dateStr)return;
  opts=opts||{};
  const nowIso=new Date().toISOString();
  const currentDate=(typeof viewDate!=="undefined"&&viewDate)?viewDate:((__state&&__state.date)||null);
  const ev=scheduled.find(e=>e.id===id)||opts.ev||null;
  if(typeof _applyMeasuredCompletionToEv==="function")_applyMeasuredCompletionToEv(ev,nowIso);
  const award=()=>opts.awardPoints!==undefined?opts.awardPoints:_pointAwardOverride(id);

  // Same-day completion: take the in-memory fast path
  if(currentDate===dateStr){
    const _award=award();
    const _cel=_beginCompletionCelebration(id);
    manualDone.add(id);doneAt[id]=new Date();
    log("checked",id);_persistDone(id,true,{ev:ev,dateStr:dateStr,completedAt:nowIso});
    // ★ THE CASCADE BELONGS HERE TOO, and its absence was the bug on the primary button.
    //
    // The "done on its original date" choice lands in THIS branch, always:
    // `openCompletionDateConfirm(id, currentDate, today)` hands `#cdc-source`
    // `_cdcSourceDate === currentDate`, so `toggleDone(id,{markOnDate:src})` reaches
    // `commitDoneOnDate(id, currentDate)` and `currentDate === dateStr`. Without a cascade the
    // parent's row was marked done and every step stayed `status:"open"`, so
    // `db.getCarryoverPool` (which admits any `subtaskOf`/`wrapId` row with no done marker)
    // re-offered all of them the next morning — verbatim the failure the cross-day walk below
    // was added to fix, on the path a user actually clicks.
    //
    // `_onParentCompleted` rather than the row walk, deliberately: it is the same cascade
    // `toggleDone`'s OTHER same-day paths run, and its semantics are the same-day ones —
    // subtasks complete, unfinished ride-alongs PROMOTE OUT to standalone tasks. The row walk
    // would mark ride-alongs done instead, which is right cross-day (there is no `scheduled`
    // to promote into) and wrong here.
    //
    // `cascade===false` means the caller owns the walk (unfinished-tasks.js complete()).
    if(opts.cascade!==false&&typeof _onParentCompleted==="function")_onParentCompleted(id);
    render();
    _finishCompletionCelebration(_cel,id);
    awardSlotTaskCredit(ev||{id:id,title:"Task completed",type:"task"},{sourceDate:dateStr,completedAt:nowIso,awardPoints:_award});
    _autoCompleteShellAncestors(id,dateStr);
    return;
  }

  // ── Cross-day completion, C5b: write the ROW, and cascade to its children ──
  //
  // This used to patch a single id into the TARGET day's `day_root._done` (plus a
  // `pa-done-<date>` localStorage mirror) with NO subtree walk, which is the whole
  // reason completing an unfinished parent left its children unfinished forever: the
  // carryover collector re-offered every child the next morning. `_done` could not have
  // fixed it either — it is a fact about an id on a day, and the children may sit on
  // different days than the parent.
  //
  // One `/api/blocks?date=` read serves both jobs: resolve the row for `id`, and give
  // the child edges to walk. Both parent spaces are unioned (`subtaskOf` for steps,
  // `wrapId` for ride-alongs) because C3 measured that NEITHER edge space is complete on
  // its own, and both id spaces are matched (`local_id` and row id) because the carryover
  // lane hands us a ROW id via `writeId(ev)` while the itinerary hands us a local one.
  let rows=[];
  try{rows=await fetch("/api/blocks?date="+encodeURIComponent(dateStr)).then(r=>r.ok?r.json():[]);}catch(e){rows=[];}
  if(!Array.isArray(rows))rows=[];
  const _idsOf=b=>{const p=(b&&b.properties)||{};return [p.local_id,b&&b.id].filter(Boolean).map(String);};
  const target=rows.find(b=>b&&b.type!=="day_root"&&!b.deleted_at&&_idsOf(b).includes(String(id)))||null;
  // `opts.cascade===false` means the CALLER already walks the subtree and is calling this
  // once per node. `unfinished-tasks.js complete()` does exactly that, and it has to keep
  // doing it: it credits each node separately, so folding its loop into this cascade would
  // silently change what a carryover completion pays. Without this flag the two walks
  // multiply -- the parent's call writes the whole subtree, then every child's call
  // re-fetches the same day and writes its own subtree again, so a 6-node chain goes from 6
  // queued writes to 21, all of them serialized behind one global chain.
  if(target&&opts.cascade===false){
    if(typeof enqueueRowPropsWrite!=="function")throw new Error("Completion queue unavailable");
    const persisted=await enqueueRowPropsWrite(target.id,p=>_doneRowProps(p,nowIso));
    if(!persisted)throw new Error("Completion did not persist");
  }else if(target){
    const subtree=[target];
    const seen=new Set([String(target.id)]);
    // ALL THREE edge spaces, because C3 measured that no single one is complete: `parent_id`
    // alone strands 40 rows across 26 parents (a duplicated parent local_id leaves
    // `dcc_resolve_local_id` returning NULL, so its children's edges never resolved), and
    // local-id alone misses 7 live rows whose `subtaskOf` holds a ROW id. A child this walk
    // does not reach stays open and the carryover collector re-offers it tomorrow, which is
    // the entire reason the cascade exists — so it matches `lib/reschedule.js
    // collectSubtreeBlockIds`, the canonical row-level walk, rather than a narrower subset.
    // `parent_id` costs nothing extra: `getBlocksByDate` is `SELECT *`.
    //
    // `seen` is keyed on the ROW id, which is single-valued, so a duplicated local_id cannot
    // make this loop forever — the shape C3's round-3 fix turned into a re-mint bug when it
    // keyed on the wrong id. `day_root` is excluded from the frontier, which is the hazard
    // collectSubtreeBlockIds guards with its own `walkRowIds`.
    // ★ THE POOL IS FILTERED TO TASK ROWS, and leaving it unfiltered was a real bug.
    //
    // `collectSubtreeBlockIds` is never handed a raw day: the route feeds it
    // `db.getRescheduleSubtreePool`, whose predicate is
    // `type='block' AND (local_id IS NOT NULL OR kind='task')` — deliberately NOT
    // `dcc_is_task_row`, because db.js records that the looser test admits meeting artifacts
    // (`meeting_prep` / `meeting_summary` / `meeting_transcript` / `proposed_action_item`),
    // which ARE genuine `parent_id` children of a meeting, and "that exclusion is the only
    // thing preventing" a subtree walk from reaching them. Reading `parent_id` without it did
    // exactly that: a meeting row has a check-off in the List view, so completing one on a
    // past day cascaded `status:"done"` onto every artifact hanging off it. That is not
    // cosmetic — `meeting-automation.js approveActions` skips proposals whose status is
    // `"approved"` or `"placed"`, so overwriting `"placed"` with `"done"` puts a PLACED
    // proposal back in the approvable set, which mints a duplicate task and wipes its
    // placedDate/placedStart.
    //
    // `target` is still resolved from the UNFILTERED rows above, because a meeting carries no
    // `local_id` and must stay completable as the target itself — the same split the server
    // route makes by passing the parent in separately from the pool.
    const _walkable=b=>{const p=(b&&b.properties)||{};return !!b&&b.type==="block"&&(!!p.local_id||p.kind==="task");};
    const pool=rows.filter(_walkable);
    const linkIds=new Set(_idsOf(target));
    const rowIds=new Set([String(target.id)]);
    for(let i=0;i<subtree.length;i++){
      pool.forEach(b=>{
        if(!b||b.deleted_at||seen.has(String(b.id)))return;
        const p=b.properties||{};
        const edge=p.subtaskOf||p.wrapId||null;
        const joined=(edge&&linkIds.has(String(edge)))
          ||(b.parent_id&&rowIds.has(String(b.parent_id)))
          ||(p.local_id&&linkIds.has(String(p.local_id)));
        if(!joined)return;
        if(p.local_id)linkIds.add(String(p.local_id));
        rowIds.add(String(b.id));
        seen.add(String(b.id));
        subtree.push(b);
      });
    }
    // Serialized by the shared queue, so these cannot clobber each other's properties.
    subtree.forEach(b=>{if(typeof enqueueRowPropsWrite==="function")enqueueRowPropsWrite(b.id,p=>_doneRowProps(p,nowIso));});
    if(subtree.length>1)log("checked-on",id,"Completed "+(subtree.length-1)+" nested task(s) on "+dateStr);
  }else if(opts.cascade===false){
    // Carryover completion is row-authoritative. A failed day read or a missing
    // target cannot fall back to an absent legacy overlay and still look successful.
    throw new Error("Completion target unavailable");
  }else{
    // No row on that date. The one live shape for this is an archive-day ev projected
    // from `schedule.timeline`; keep the completion rather than dropping it, loudly.
    //
    // Routed through `_patchOverlayDone` with the TARGET day's root, not a hand-rolled
    // PATCH. The first cut duplicated that function's whole read-modify-write here and paid
    // for it twice: unqueued (so it could interleave with any other day_root write and lose
    // it, the exact hazard the queue exists for) and outside `blockStore.apiPatch`, so the
    // PATCH carried no `_clientId` and the SSE self-echo was NOT suppressed for the tab that
    // made it — which `_refreshResponsibilityAfterDone` relies on holding for completion writes.
    console.warn("[done] no row on "+dateStr+" for "+id+" — persisting to that day's legacy _done overlay");
    const dayRoot=rows.find(b=>b&&b.type==="day_root")||null;
    if(dayRoot)_patchOverlayDone(id,true,nowIso,dayRoot.id);
  }
  log("checked-on",id,"Marked done on "+dateStr);
  awardSlotTaskCredit(ev||{id:id,title:"Task completed",type:"task"},{sourceDate:dateStr,completedAt:nowIso,awardPoints:award()});
  _autoCompleteShellAncestors(id,dateStr);
}

// Durable replacement for the historical cross-day writer above. The old body is
// retained temporarily as executable documentation for the many date and scoring
// rules this path accumulated, but no runtime caller reaches it.
async function commitDoneOnDate(id,dateStr,opts){
  if(!id||!dateStr)return false;
  opts=opts||{};
  const currentDate=(typeof viewDate!=="undefined"&&viewDate)?viewDate:((__state&&__state.date)||null);
  const ev=((typeof scheduled!=="undefined"&&scheduled.find(e=>e.id===id))||opts.ev||null);
  const completedAt=new Date();
  const completedIso=completedAt.toISOString();
  const award=opts.awardPoints!==undefined?opts.awardPoints:_pointAwardOverride(id);
  const celebration=currentDate===dateStr?_beginCompletionCelebration(id):null;
  if(currentDate===dateStr){
    manualDone.add(id);doneAt[id]=completedAt;log("checked",id);render();
  }
  try{
    const result=await _persistDone(id,true,{ev:ev,dateStr:dateStr,completedAt:completedIso});
    if(result&&result.pending){
      if(typeof showToast==="function")showToast("Completion queued and will retry","info",3200);
      return result;
    }
    _refreshResponsibilityAfterDone(ev,Promise.resolve(result));
    if(currentDate===dateStr&&opts.cascade!==false)_onParentCompleted(id);
    log("checked-on",id,"Marked done on "+dateStr);
    render();
    if(celebration)_finishCompletionCelebration(celebration,id);
    awardSlotTaskCredit(ev||{id:id,title:"Task completed",type:"task"},{
      sourceDate:dateStr,completedAt:completedIso,awardPoints:award,
      sourceKey:"completion:"+((result&&result.mutationId)||id),silent:!!opts.silent
    });
    _autoCompleteShellAncestors(id,dateStr);
    if(currentDate!==dateStr&&typeof showToast==="function"){
      const label=(typeof _prettyDateLabel==="function")?_prettyDateLabel(dateStr):dateStr;
      showToast("Marked done on "+label,"success");
    }
    return result;
  }catch(error){
    if(currentDate===dateStr){manualDone.delete(id);delete doneAt[id];render();}
    if(typeof showToast==="function")showToast(error.message||"Completion was not saved","error",4200);
    return false;
  }
}

// Completion bonus for a rollup container (shell): bonusPct × the estimated
// value of its whole subtree. Each descendant that isn't a pie subtask
// contributes its own estimate (PointPlan.estimatePool — the points-chip
// number); a descendant that owns a pie contributes its pool instead (which
// already covers its subtasks). Nested rollup containers contribute nothing
// themselves (their own bonus banks when THEY complete) but their subtrees
// count. Client-computed like the PointPlan pie bonus and sent as a
// points_override — the server clamps and ledgers it idempotently.
function _shellBonusPoints(id){
  if(typeof scheduled==="undefined"||!window.TaskTypes||typeof shellRollup!=="function"||typeof shellBonus!=="function")return undefined;
  const ev=scheduled.find(e=>e.id===id);
  if(!ev||!window.TaskTypes.isRollup(ev))return undefined;
  const bonus=shellBonus(shellRollup(id,scheduled).points,Number(window.TaskTypes.rule(ev,"bonusPct"))||0);
  return bonus>0?bonus:undefined;
}

// After any completion, walk the parent chain: a rollup ancestor (shell) whose
// children are now ALL done auto-completes and banks its bonus. Completion is
// applied directly (not via toggleDone) so the manual-complete guard and the
// child cascade are skipped — every child is already done. Idempotent: the
// bonus rides the normal ledger sourceKey (<date>:<shellId>).
function _autoCompleteShellAncestors(id,sourceDate){
  if(typeof scheduled==="undefined"||!window.TaskTypes||typeof parentIdOf!=="function")return;
  const seen=new Set();
  let cur=scheduled.find(e=>e.id===id);
  while(cur){
    const pid=parentIdOf(cur);
    if(!pid||seen.has(pid))return;
    seen.add(pid);
    const parent=scheduled.find(e=>e.id===pid);
    if(!parent)return;
    if(window.TaskTypes.rule(parent,"autoCompleteWhenChildrenDone")&&!isDone(parent)){
      if(DCC.TaskModel.selectOpen(childrenOf(parent.id,scheduled)).length)return; // still open work inside
      const bonus=_shellBonusPoints(parent.id);
      const completedAt=new Date();
      manualDone.add(parent.id);doneAt[parent.id]=completedAt;
      log("checked",parent.id,"Auto-completed: all nested tasks done");
      const write=_persistDone(parent.id,true,{ev:parent,dateStr:sourceDate,completedAt:completedAt});
      render();
      Promise.resolve(write).then(result=>{
        if(result&&result.pending)return;
        awardSlotTaskCredit(parent,{sourceDate:sourceDate,completedAt:completedAt.toISOString(),awardPoints:bonus,sourceKey:"completion:"+((result&&result.mutationId)||parent.id)});
        if(typeof showToast==="function")showToast('"'+(parent.title||"Shell")+'" complete!'+(bonus?" +"+bonus+" pt bonus":""),"success",3200);
      }).catch(error=>{
        manualDone.delete(parent.id);delete doneAt[parent.id];render();
        if(typeof showToast==="function")showToast(error.message||"Shell completion was not saved","error",4200);
      });
    } else if(!isDone(parent)){
      return; // an open non-rollup ancestor blocks everything above it
    }
    cur=parent;
  }
}

// Points override for a completion, when the task participates in a parent's
// point pie or is itself a rollup container. Returns:
//   - a rollup container's completion bonus (covers the manual recheck path;
//     the normal path banks it via _autoCompleteShellAncestors);
//   - a parent's completion award (bonus + still-open subtask slices) when the
//     task has subtasks — MUST be read BEFORE _onParentCompleted cascades them;
//   - a subtask's own slice when it is a subtask of a parent;
//   - undefined for everything else (normal duration-based scoring), including
//     "stacked" (ride-along) tasks, whose points are independent.
function _pointAwardOverride(id){
  if(typeof childrenOf!=="function"||typeof relOf!=="function")return undefined;
  const ev=scheduled.find(e=>e.id===id);
  if(!ev)return undefined;
  if(window.TaskTypes&&window.TaskTypes.isRollup(ev))return _shellBonusPoints(id);
  if(!window.PointPlan)return undefined;
  const hasSubKids=DCC.TaskModel.subtasksOf(id,scheduled).length>0;
  if(hasSubKids)return window.PointPlan.awardForParentCompletion(id);
  if(ev.subtaskOf)return window.PointPlan.shareFor(ev.subtaskOf,id);
  return undefined;
}

function awardSlotTaskCredit(ev,opts){
  if(!ev||!ev.id)return;
  opts=opts||{};
  // An explicit zero slice (e.g. a subtask allocated 0 pts) means "credit
  // nothing" — without this guard a 0 would fall through to normal scoring.
  if(opts.awardPoints!=null&&Number.isFinite(Number(opts.awardPoints))&&Number(opts.awardPoints)<=0)return;
  const fallbackDate=(typeof viewDate!=="undefined"&&viewDate)||((__state&&__state.date)||new Date().toISOString().split("T")[0]);
  const normalizedOpts={...opts,sourceDate:opts.sourceDate||opts.completionDate||fallbackDate,completedAt:opts.completedAt||new Date().toISOString()};
  // A rollup container's bonus must dedupe across calendar dates: the default
  // ledger key is <sourceDate>:<id>, so unchecking a shell and re-completing it
  // under a different completion date would mint a fresh key and double-award.
  // Pin the key to the shell instance itself (ids are unique per instance).
  if(normalizedOpts.sourceKey==null&&window.TaskTypes&&window.TaskTypes.isRollup(ev))normalizedOpts.sourceKey="shell:"+ev.id;
  if(window.PetHome&&typeof window.PetHome.awardTask==="function"){
    window.PetHome.awardTask(ev,normalizedOpts).catch(()=>{});
  }
  // A scheduled reward parked on the itinerary burns when its task is completed.
  // Safe no-op for normal tasks (the endpoint only matches scheduled rewards by
  // block id) and idempotent (redeem is status-guarded).
  if(ev.source==="reward"||(Array.isArray(ev.tags)&&ev.tags.indexOf("reward")>=0)){
    fetch("/api/social/rewards/redeem-by-block",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({blockId:ev.id})})
      .then(r=>r.ok?r.json():null)
      .then(res=>{
        if(res&&res.changed){
          if(!normalizedOpts.silent&&typeof showToast==="function")showToast("Reward enjoyed 🎉","success");
          if(typeof window.loadRewardsQueue==="function")window.loadRewardsQueue();
        }
      }).catch(()=>{});
  }
  if(window.SlotRewards&&typeof window.SlotRewards.earnTaskCredit==="function"){
    window.SlotRewards.earnTaskCredit(ev,normalizedOpts).catch(e=>{
      if(!normalizedOpts.silent&&typeof showToast==="function")showToast("Points queued; retrying in the background","info");
      console.warn("[points] award queued:",e&&e.message?e.message:e);
    });
  } else {
    try {
      const key="pa-slot-award-queue";
      const rows=JSON.parse(localStorage.getItem(key)||"[]");
      if(Array.isArray(rows)){
        const sourceKey=(normalizedOpts.sourceKey||normalizedOpts.source_key||normalizedOpts.sourceDate||"unknown")+":"+ev.id;
        const filtered=rows.filter(row=>{
          const rowTask=row&&row.task;
          const rowOpts=(row&&row.options)||{};
          const rowKey=(rowOpts.sourceKey||rowOpts.source_key||rowOpts.sourceDate||"unknown")+":"+(rowTask&&rowTask.id);
          return rowKey!==sourceKey;
        });
        filtered.push({task:ev,options:normalizedOpts,queuedAt:new Date().toISOString()});
        localStorage.setItem(key,JSON.stringify(filtered.slice(-100)));
        if(!normalizedOpts.silent&&typeof showToast==="function")showToast("Points queued; retrying when rewards load","info");
      }
    } catch(e) {}
  }
}

// When a parent task is completed:
//   - subtasks (its steps) complete too, recursively;
//   - unfinished ride-alongs (independent concurrent work) promote out to standalone tasks.
function _onParentCompleted(id){
  if(typeof scheduled==="undefined")return;
  // 1) Reflect the server's atomic subtask cascade in memory. Persistence belongs to
  // POST /api/tasks/:taskRef/completion, so the browser must not issue one write per
  // child and leave a half-completed tree when any request fails.
  (function completeSubs(pid){
    DCC.TaskModel.subtasksOf(pid,scheduled).forEach(c=>{
      if(!manualDone.has(c.id)){
        const at=new Date();
        manualDone.add(c.id);doneAt[c.id]=at;
      }
      completeSubs(c.id);
    });
  })(id);
  // 2) Promote unfinished ride-alongs to standalone open tasks. Rollup
  // containers (shells) never eject their children — they can only complete
  // when every child is already done, so there is nothing to promote.
  const _parentEv=scheduled.find(e=>e.id===id);
  if(_parentEv&&window.TaskTypes&&window.TaskTypes.isRollup(_parentEv)){
    if(typeof recalcTimes==="function")recalcTimes();
    return;
  }
  let promoted=0;
  DCC.TaskModel.selectOpen(DCC.TaskModel.ridersOf(id,scheduled)).forEach(c=>{
    c.wrapId=null;
    if(typeof _clearPin==="function")_clearPin(c);
    if(typeof _persistEvWrap==="function")_persistEvWrap(c);
    promoted++;
  });
  if(typeof recalcTimes==="function")recalcTimes();
  if(promoted&&typeof showToast==="function")showToast(promoted+" stacked task"+(promoted>1?"s":"")+" moved out of the completed task","info",2600);
}
// ======== ONE WRITER FOR "THIS TASK IS DONE" (C5b) ========
//
// Completion used to be written to TWO places that knew nothing about each other: the
// task row's `properties.status` (server paths only — quick-task, Slack reactions, Day
// in Review's Approve, the MCP tools) and the viewed day's `day_root.properties._done`
// overlay (the browser only). That split is what made a Slack ✅ VANISH a task (C0),
// and it is why completing a carried-over parent left its children unfinished forever:
// `_done` is a fact about an id ON A DAY, so a task that changes days leaves its
// completion behind. The row travels with the task; the overlay never could.
//
// Resolution order, and the order is the point:
//   1. The ROW. Resolved by id (`_findTaskBlockForDate` matches local_id, row id and
//      ev._blockId) and written through C4's `enqueueRowPropsWrite` queue, which is
//      mandatory for any row-properties writer: `db.updateBlock` REPLACES properties
//      wholesale, so two unqueued read-modify-writes both read the pre-write bag and
//      the second PATCH drops the first's field.
//   2. Failing that, the legacy `_done` overlay, PER ID. One ev shape has no row to
//      carry the fact: one projected from `schedule.timeline` on an archive day.
//      Measured on prod 2026-08-04: 11 such entries, none newer than 2026-05-27 (the
//      last day anything wrote a timeline at all). Falling back keeps them persisting
//      rather than silently dropping a completion, and it warns so the population
//      cannot grow unnoticed.
//
// The fallback is per-id and additive, never `saveDoneState`'s full-set overwrite —
// that shape is what permanently un-completed any task `manualDone` had lost track of.
function _applyMeasuredCompletionToEv(ev,completedAt){
  if(!ev||typeof window==="undefined"||!window.MeasuredTaskWindow||typeof window.MeasuredTaskWindow.measuredTaskWindow!=="function")return null;
  const measured=window.MeasuredTaskWindow.measuredTaskWindow(ev.startedAt,completedAt,{timeZone:window.DCC_APP_TIME_ZONE||"America/New_York"});
  if(!measured)return null;
  const minutes=measured.durationMinutes;
  ev.start=measured.start;ev.end=measured.end;
  ev.durMin=minutes;ev.duration=minutes;ev.durationMinutes=minutes;ev.estimatedMinutes=minutes;
  ev.pointsDurationMinutes=minutes;ev._pinnedStart=measured.start;ev.untimed=false;
  if(typeof refreshOpenAddModalDetails==="function")refreshOpenAddModalDetails();
  return measured;
}
function _doneRowProps(props,completedAt){
  const iso=(completedAt instanceof Date)?completedAt.toISOString():(completedAt||new Date().toISOString());
  const next={...props,status:"done",done:true,completedAt:iso};
  if(typeof window!=="undefined"&&window.MeasuredTaskWindow&&typeof window.MeasuredTaskWindow.measuredTaskWindow==="function"){
    const measured=window.MeasuredTaskWindow.measuredTaskWindow(props&&props.startedAt,iso,{timeZone:window.DCC_APP_TIME_ZONE||"America/New_York"});
    if(measured){
      const minutes=measured.durationMinutes;
      next.start=measured.start;next.end=measured.end;
      next.duration=minutes;next.durationMinutes=minutes;next.estimatedMinutes=minutes;
      next.pointsDurationMinutes=minutes;next._pinnedStart=measured.start;
      const explicitOverride=next.pointsOverride!=null||(next.pointsBreakdown&&next.pointsBreakdown.pointsOverride!=null);
      if(!explicitOverride&&window.TaskPoints&&typeof window.TaskPoints.estimate==="function"){
        const scored=window.TaskPoints.estimate({...next,points_duration_minutes:minutes});
        next.points=scored.awardPoints;next.pointsBreakdown=scored;
      }
    }
  }
  return next;
}
// Returns null when the row carries no completion at all, so the queue skips the write.
// C0's version made that check against the CACHED row before deciding; doing it inside the
// merge tests the row the queue itself just read. It matters for the 12 legacy ambiguous
// ids: `manualDone` has them (from the `_done` read) while every candidate row still reads
// `status:'open'`, so un-checking one has real work to do in the overlay and none on the row.
function _openRowProps(props){
  if(!props)return null;
  if(!(props.done===true||props.status==="done"||props.completed||props.completedAt||props.doneAt||props.completedBy))return null;
  const next={...props};
  delete next.done;delete next.completed;delete next.completedAt;delete next.doneAt;
  // `completedBy` is provenance stamped by whichever surface finished the task. C0 left
  // it behind on an un-check deliberately and flagged clearing it to this phase: no
  // done-predicate reads it, but an OPEN row carrying `completedBy:"slack-events"` is a
  // lie to whoever greps for it next.
  delete next.completedBy;
  if(next.status==="done")next.status="open";
  return next;
}
// Add or remove ONE id in the day_root `_done` overlay. The read-modify-write happens
// INSIDE the queue callback, against the row the queue itself just read — computing
// `ids` from the cache out here and handing in a finished object is precisely the stale
// read C4's queue exists to prevent.
//
// `rootId` may be supplied for a day OTHER than the one loaded — the cross-day fallback in
// commitDoneOnDate has the target day's root in hand and passes it. Without that the overlay
// half silently ignored the `dateStr` the caller asked for and always wrote the VIEWED day's
// root, filing another date's completion under today.
function _patchOverlayDone(id,done,completedAt,rootId){
  if(!window.blockStore||typeof enqueueRowPropsWrite!=="function")return;
  rootId=rootId||((typeof window.blockStore.getDayRootId==="function")?window.blockStore.getDayRootId():null);
  if(!rootId)return;
  const iso=(completedAt instanceof Date)?completedAt.toISOString():(completedAt||new Date().toISOString());
  enqueueRowPropsWrite(rootId,p=>{
    const cur=(p&&p._done)||{};
    const ids=Array.isArray(cur.ids)?cur.ids.slice():[];
    const at={...((cur.at&&typeof cur.at==="object")?cur.at:{})};
    const i=ids.indexOf(id);
    // Nothing to remove -> skip the write entirely (the queue honors a null merge). An
    // un-check fires this for every id, and almost none of them are legacy overlay
    // entries; without this every single one PATCHed the day_root for no change.
    if(!done&&i===-1&&!(id in at))return null;
    // `i!==-1` is re-tested, not implied by the guard above: the guard also lets through
    // the id-in-`at`-but-not-in-`ids` case, and `ids.splice(-1,1)` there would silently
    // delete an UNRELATED task's completion off the end of the list.
    if(done){if(i===-1)ids.push(id);at[id]=iso;}
    else{if(i!==-1)ids.splice(i,1);delete at[id];}
    return {...p,_done:{ids:ids,at:at}};
  });
}
// `done=false` clears BOTH halves, always. Clearing only the row lets the legacy
// `_done` read (sync.js) re-hydrate the completion on the next load so the row snaps
// straight back to done — the C0 wart, inverted.
function _persistDone(id,done,opts){
  opts=opts||{};
  if(!id)return Promise.reject(new Error("Completion target unavailable"));
  const dateStr=opts.dateStr||((typeof _viewedDateStr==="function")?_viewedDateStr():null);
  const ev=opts.ev||((typeof scheduled!=="undefined")?scheduled.find(e=>e.id===id):null);
  if(done&&typeof _applyMeasuredCompletionToEv==="function")_applyMeasuredCompletionToEv(ev,opts.completedAt||new Date().toISOString());
  const block=(typeof _findTaskBlockForDate==="function")?_findTaskBlockForDate(id,dateStr,ev):null;
  const priorDate=block&&block.date;
  const taskRef=(block&&block.id)||(ev&&ev._blockId)||id;
  if(!window.blockStore||typeof window.blockStore.setTaskCompletion!=="function"){
    return Promise.reject(new Error("Completion service unavailable"));
  }
  return window.blockStore.setTaskCompletion(taskRef,!!done,{
    block:block||null,
    taskDate:dateStr||((block&&block.date)||null),
    completedAt:done?(opts.completedAt||new Date().toISOString()):null,
    resolveRow:!!((block&&block.id)||(ev&&ev._blockId)),
    sideEffects:{eventId:id,sourceDate:dateStr||null}
  }).then(result=>{
    if(result&&result.pending)return result;
    const persistedTask=result&&result.task;
    if(typeof _syncBacklogProjection==="function"&&block&&persistedTask&&priorDate!==persistedTask.date){
      const TM=window.DCC&&window.DCC.TaskModel;
      const bkKey=(TM&&typeof TM.backlogKey==="function")?TM.backlogKey(block):id;
      return Promise.resolve(_syncBacklogProjection(bkKey,persistedTask.date||null)).then(()=>result);
    }
    return result;
  });
}
// Kept as the un-check spelling every caller already used. Now one line, because the
// row write and the overlay clear are the same primitive read in the other direction.
function _clearRowDone(id,opts){return _persistDone(id,false,opts);}

// D1's belt-and-suspenders client cadence POST is GONE (C5b step 7). It called
// `POST /api/responsibilities/:id/complete`, whose handler is
// `recurrence.applyCompletion(defProps,{completedAt,taskId})` — byte-for-byte the same
// call `db.js propagateResponsibilityDone` makes when a row carrying a
// `responsibilityId` flips to done. D1 kept the client copy precisely BECAUSE the
// itinerary wrote `_done` and never the row, so the server hook could not fire for a
// check-off; `_persistDone` writing the row is what retires it. The un-check direction is
// a genuine gain: the client only ever had the `complete` half, so an accidental check-off
// pushed the cadence a full cycle out and only the derived reconciler walked it back —
// now `_openRowProps` clears `status`/`completedAt` and the same hook runs
// `applyUncompletion`.
//
// What did NOT come out is the local SIDEBAR refresh, and it is chained on the write
// rather than fired beside it. The PATCH's own SSE broadcast is self-echo-suppressed in
// the tab that made it (sse.js handleBlockEvent returns early on a matching clientId), so
// nothing else re-reads responsibilities here; and reading them before the row write lands
// returns the pre-reset cadence, which is the stale value the refresh exists to replace.
function _refreshResponsibilityAfterDone(ev,write){
  if(!ev||!ev.responsibilityId||typeof window.loadResponsibilities!=="function")return;
  Promise.resolve(write).then(()=>window.loadResponsibilities()).catch(()=>{});
}
if(typeof window!=="undefined"&&typeof window.addEventListener==="function"){
  window.addEventListener("task-completion-confirmed",event=>{
    const detail=event&&event.detail;
    const task=detail&&detail.task;
    const meta=detail&&detail.clientMeta;
    if(!detail||!detail.replayed||!task||!task.properties||task.properties.status!=="done")return;
    const eventId=(meta&&meta.eventId)||(task.properties.local_id)||task.id;
    const ev=(typeof scheduled!=="undefined"&&scheduled.find(item=>String(item.id)===String(eventId)))||null;
    if(typeof manualDone!=="undefined")manualDone.add(eventId);
    if(typeof doneAt!=="undefined")doneAt[eventId]=task.properties.completedAt||new Date().toISOString();
    if(typeof render==="function")render();
    awardSlotTaskCredit(ev||{id:eventId,title:task.properties.title||"Task completed",type:"task"},{
      sourceDate:(meta&&meta.sourceDate)||task.date,
      completedAt:task.properties.completedAt||new Date().toISOString(),
      sourceKey:"completion:"+(detail.mutationId||task.properties._completionMutationId||eventId)
    });
    _refreshResponsibilityAfterDone(ev,Promise.resolve(detail));
  });
}
function toggleDone(id,opts){
  opts=opts||{};
  if(manualDone.has(id)){
    manualDone.delete(id);delete doneAt[id];log("unchecked",id);
    // Clears the row AND any legacy `_done` entry for this id — see `_persistDone`.
    // Either half left set re-hydrates the completion on the next load and the row snaps
    // straight back to done.
    //
    // The sidebar refresh is chained on the un-check too, not just on completion. The row
    // write clears `status`/`completedAt`, which fires db.js's propagateResponsibilityDone in
    // its `applyUncompletion` direction — and since the PATCH's own SSE echo is
    // self-suppressed in the acting tab, nothing else re-reads responsibilities, so the
    // sidebar kept showing the pushed-forward cadence the server had just walked back.
    const _uev=(typeof scheduled!=="undefined")?scheduled.find(e=>e.id===id):null;
    const _reopen=_clearRowDone(id,{ev:_uev,dateStr:(typeof _viewedDateStr==="function")?_viewedDateStr():null});
    render();
    Promise.resolve(_reopen).then(result=>{
      if(result&&result.pending){if(typeof showToast==="function")showToast("Reopen queued and will retry","info",3200);return;}
      _refreshResponsibilityAfterDone(_uev,Promise.resolve(result));
    }).catch(error=>{
      manualDone.add(id);doneAt[id]=new Date();render();
      if(typeof showToast==="function")showToast(error.message||"Reopen was not saved","error",4200);
    });
    return;
  }

  // A rollup container (shell) can't be checked while children are open — its
  // bonus depends on ALL children finishing, and it auto-completes when the
  // last one does (that path bypasses this via opts._fromAutoComplete).
  if(!opts._fromAutoComplete&&window.TaskTypes&&typeof childrenOf==="function"){
    const shellEv=scheduled.find(e=>e.id===id);
    if(shellEv&&window.TaskTypes.rule(shellEv,"blockManualCompleteWithOpenChildren")){
      const open=DCC.TaskModel.selectOpen(childrenOf(id,scheduled)).length;
      if(open){
        if(typeof showToast==="function")showToast("Finish its "+open+" remaining task"+(open>1?"s":"")+" first","info",2600);
        return;
      }
    }
  }

  // Caller forced a specific completion date (Done-on-date confirmation flow)
  if(opts.markOnDate){
    if(opts.bringToToday&&typeof rescheduleTaskToDate==="function"){
      // Read the row and its point award BEFORE the move: the move re-dates the row
      // and drops it from `scheduled`, and after that neither the task nor its pie
      // share can be resolved by id. Hand both to the commit. (_pointAwardOverride
      // must also be read before any subtask cascade, which this satisfies.)
      const evBeforeMove=scheduled.find(e=>e.id===id);
      const awardBeforeMove=_pointAwardOverride(id);
      rescheduleTaskToDate(id,opts.markOnDate,{silent:true})
        .then(moved=>{
          // FALSE means the server permanently refused and the task never moved. Committing
          // then would mark it done on a date it is not on: patch that day's _done overlay,
          // write pa-done-<date>, and bank the points, while the row sits unchecked on the
          // day the user was actually looking at. Anything else (a result object, or
          // undefined from a transient failure the WAL will replay) does land, so it commits.
          // Before C3 this could not happen: the clone fallback always produced a row on the
          // target date, so the move never came back as "did not happen".
          if(moved===false){
            // The mover ran with {silent:true} so the completion toast could be the only
            // one, which means its own error toast was suppressed. Skipping the commit is
            // right; skipping it SILENTLY is not — the dialog would just close with the task
            // still unchecked and no explanation. Say it here, where the silence was created.
            if(typeof showToast==="function")showToast("Couldn't move that task to "+_prettyDateLabel(opts.markOnDate)+" — it was not marked done","error",4200);
            return;
          }
          commitDoneOnDate(id,opts.markOnDate,{ev:evBeforeMove,awardPoints:awardBeforeMove});
        });
    } else {
      commitDoneOnDate(id,opts.markOnDate);
    }
    return;
  }

  // Smart completion-date handling for non-today views.
  if(typeof _actualTodayStr==="function"){
    const today=_actualTodayStr();
    const currentDate=(typeof viewDate!=="undefined"&&viewDate)?viewDate:((__state&&__state.date)||null);
    if(currentDate&&currentDate>today){
      // Future-day plans are editable pre-plans. If the user is intentionally
      // viewing that day and checks a task off, persist the completion there.
      return commitDoneOnDate(id,currentDate,{ev:scheduled.find(e=>e.id===id),silent:!!opts.silent});
    }
    if(currentDate&&currentDate<today){
      // Past: ask the user whether they did it today or back on the original date.
      if(typeof openCompletionDateConfirm==="function"){
        openCompletionDateConfirm(id,currentDate,today);
        return;
      }
      // Without the confirm modal available, fall through to default behavior.
    }
  }

  const _today=(typeof viewDate!=="undefined"&&viewDate)?viewDate:((__state&&__state.date)||null);
  return commitDoneOnDate(id,_today,{ev:scheduled.find(e=>e.id===id),silent:!!opts.silent});
}
function adjustDur(id,delta){
  const ev=scheduled.find(e=>e.id===id);if(!ev)return;
  const c=dur(ev),n=Math.max(1,c+delta);if(n===c)return;
  const s=pt(ev.start);ev.end=String(Math.floor((s+n)/60)).padStart(2,"0")+":"+String((s+n)%60).padStart(2,"0");
  if(ev.meta)ev.meta=ev.meta.replace(/·\s*\d+h?\s*\d*m?/,"· "+ms(n));
  durChanges[id]={original:origDur(id)||c,current:n};log("duration",id,c+"->"+n);
  recalcTimes();saveDurChanges();render()
}
function setDurAbsolute(id,newMin){
  const ev=scheduled.find(e=>e.id===id);if(!ev)return;
  const n=Math.max(1,Math.round(newMin));
  const c=dur(ev);if(n===c)return;
  const s=pt(ev.start);ev.end=fmt(s+n);
  if(ev.meta)ev.meta=ev.meta.replace(/·\s*\d+h?\s*\d*m?/,"· "+ms(n));
  durChanges[id]={original:origDur(id)||c,current:n};log("duration",id,c+"->"+n);
  recalcTimes();saveDurChanges();render()
}
// ======== START TIME ADJUSTMENT ========
function openStartTimePicker(id, anchorEl){
  const ev=scheduled.find(e=>e.id===id);if(!ev)return;
  // Use the same clock face picker as the complete modal
  if(typeof openClockPicker==='function'){
    openClockPicker(ev.start, anchorEl, function(timeStr){
      pinStartTime(id, timeStr);
    });
  }
}
// ══════════════════════════ C6b: ONE ORDER AUTHORITY ══════════════════════════
//
// `sort_order` on the row is the only persisted order. It already existed, is already written
// by `blockStore.reorder`, already survives a reschedule, and migration 001 backfilled it on
// every live task row (measured: 0 NULL of 1815). The three `day_root` overlay LISTS it
// replaced -- `_taskOrder`, `_unscheduledOrder`, `_subtaskOrder` -- could not describe a row
// that changed days, mixed two id spaces, and flattened subtasks into their parents' sibling
// order.
//
// ★ WHY THIS NEEDS NO MERGE-THEN-APPLY DANCE, unlike C5a -> 002 -> C5b.
// The reads below are canonical-FIRST with the overlay as an explicit fallback, so a deploy
// that lands before `migrations/003` is applied loses nothing: a row that has the canonical
// value uses it, and anything only the overlay knows still resolves. That is the whole reason
// this is one PR. The overlay keys and these fallbacks are retired by A4, which already owns
// exactly that for `_done`. Every fallback hit is COUNTED (`window.__DCC_C6B_FALLBACK`) so the
// canary can say whether the fallback is load-bearing yet rather than guessing.
window.__DCC_C6B_FALLBACK = window.__DCC_C6B_FALLBACK || {};
function _c6bFallback(key,n){
  if(!n)return;
  window.__DCC_C6B_FALLBACK[key]=(window.__DCC_C6B_FALLBACK[key]||0)+n;
}

// Every task row the blockStore currently holds, in ONE place: three call sites built this
// same union and the third (`saveTaskOrder`) additionally required `local_id && start`, which
// silently excluded 1546 of 1815 live task rows from ever being reordered.
// ★ DATE-SCOPED BY DEFAULT, and both halves of that matter.
//
// `loadGlobals()` GETs every `type=block` row regardless of date and cacheSets them all
// (persistence.js:290 documents this and date-guards its own fold), so an unscoped sweep returns
// OTHER DAYS' rows. Two live rows CAN share one ev id -- schedule.js records `carry-200` doing
// exactly that on the prod restore -- so an unscoped write could stamp a July row from a drag on
// today, losing the drag AND mutating another day. Dateless rows are always in scope: that is the
// Backlog, which is day-agnostic by definition (C4).
//
// `foldsIntoItinerary`, not `isTaskRow`: task-model.js's own comment says `isTaskRow` alone is
// "far too wide -- side_project rows, sticky notes and untitled scaffolding all pass the kind
// exclusions". These lists are keyed by EV ID, so "addressable as an ev" is the question.
function _orderableRows(opts){
  if(!window.blockStore)return [];
  const scope=(opts&&"date" in opts)?opts.date:((typeof __state!=="undefined"&&__state&&__state.date)||null);
  const datedOnly=!!(opts&&opts.datedOnly);
  const rows=[...window.blockStore.getByType("added_task"),...window.blockStore.getByType("block")];
  return rows.filter(b=>b&&!b.deleted_at&&b.properties
    &&(!DCC.TaskModel.foldsIntoItinerary||DCC.TaskModel.foldsIntoItinerary(b))
    &&(datedOnly?b.date===scope:(!scope||b.date===scope||!b.date)));
}
// The ev id a row projects to. Matches the fold (`local_id || block.id`), NOT `backlogKey`,
// because these ids reach `scheduled[]` where a "blk-" prefix would be a visible id change.
function _evIdOfRow(b){return (b.properties&&b.properties.local_id)||b.id;}

// An ev-id list in `sort_order` order. Rows with no sort_order sort last, which is what the
// orderMap fallbacks these lists feed already did with their 9999 sentinel.
// `{datedOnly:true}` for the ORDER axis. `_orderableRows` includes dateless rows on purpose -- the
// Backlog is day-agnostic and the pin/lock readers want it -- but `sort_order` keeps the dateless rows
// in their OWN 1000-spaced partition (both `nextSortOrderForDay` and migration 004 scope on
// `date IS NOT DISTINCT FROM`). Mixing them into one derived list means the day's first row (1000) and
// the first dateless row (1000) tie, and a drag would then renumber Backlog rows into whichever day
// was last viewed. Same reasoning the unscheduled axis was left alone for.
function _orderFromRows(pick,opts){
  return _orderableRows(opts)
    .filter(b=>typeof pick!=="function"||pick(b))
    .slice()
    .sort((a,b)=>{
      const ao=(a.sort_order==null)?Number.MAX_SAFE_INTEGER:a.sort_order;
      const bo=(b.sort_order==null)?Number.MAX_SAFE_INTEGER:b.sort_order;
      // The same `, created_at ASC` tie-break every SQL read here already has. Without it a duplicate
      // sort_order falls through to cache iteration order, which differs after a boot vs a loadDay vs
      // an SSE refresh -- the exact non-determinism this phase exists to remove.
      if(ao!==bo)return ao-bo;
      const ac=String(a.created_at||""),bc=String(b.created_at||"");
      if(ac!==bc)return ac<bc?-1:1;
      return String(a.id)<String(b.id)?-1:1;
    })
    .map(_evIdOfRow);
}

// Stamp `sort_order` in list order. Keyed by EV ID resolved against the row, so a row with no
// `local_id` (an API/Slack insert) and an untimed row are both reorderable -- the two shapes
// the old `local_id && start` filter dropped. 1000-spaced, matching what `saveTaskOrder` and
// migration 001 already wrote, so a partially-migrated day stays monotonic.
function _writeRowOrder(ids){
  if(!window.blockStore||!window.blockStore.reorder||!Array.isArray(ids)||!ids.length)return 0;
  const byEvId=new Map();
  _orderableRows().forEach(b=>{const k=String(_evIdOfRow(b));if(!byEvId.has(k))byEvId.set(k,b);});
  const items=[];
  ids.forEach((id,i)=>{
    const b=byEvId.get(String(id));
    if(!b)return;
    const next=(i+1)*1000;
    if(b.sort_order===next)return;              // already correct: no write
    items.push({id:b.id,sort_order:next});
  });
  if(items.length)window.blockStore.reorder(items).catch(()=>{});
  return items.length;
}

let PINNED_KEY = "pa-pinned-starts-" + ((__state && __state.date) ? __state.date : "unknown");
// C6b: pins live on the row (`properties._pinnedStart`). Creation already wrote it there
// (schedule.js x4, prep.js, dcc-intelligence.js); only the pin/unpin path was overlay-only,
// which is why 120 rows carried it and the overlay carried 178 entries across 64 day_roots.
// Canonical first, overlay as a counted fallback for entries no row carries yet.
function loadPinnedStarts(){
  const out={};
  let rowCount=0;
  _orderableRows().forEach(b=>{
    const v=b.properties._pinnedStart;
    if(v){out[_evIdOfRow(b)]=v;rowCount++;}
  });
  if(window.USE_BLOCKSTORE&&window.blockStore){
    const v=_bsProp("_pinnedStarts",null);
    if(v&&typeof v==="object"){
      let fb=0;
      Object.keys(v).forEach(id=>{if(out[id]===undefined&&v[id]){out[id]=v[id];fb++;}});
      _c6bFallback("pinnedStarts",fb);
    }
    if(rowCount||Object.keys(out).length)return out;
  }
  if(Object.keys(out).length)return out;
  try{return JSON.parse(localStorage.getItem(PINNED_KEY)||"{}")}catch(e){return{}}
}
// Callers hand in the whole map (they load, mutate one key, save), so this diffs against the
// rows and writes only what moved. Every entry is pushed to its row even if it was previously
// overlay-only, so an overlay-only pin HEALS the first time anything on that day is pinned --
// the same "each one heals when touched" pattern C4 used for dated backlog rows.
function savePinnedStarts(data){
  data=data||{};
  if(window.blockStore){
    const rows=_orderableRows();
    let wrote=0;
    rows.forEach(b=>{
      const id=_evIdOfRow(b);
      const want=data[id]||undefined;
      if(b.properties._pinnedStart===want)return;
      // Only count a write that was actually ENQUEUED. persistRowProp returns null when it cannot
      // resolve a row for this ev id on the viewed day, and counting that as written made the
      // return value (and the test asserting on it) unable to tell a write from a refusal.
      // `{row:b}` -- write the row this loop INSPECTED. Re-resolving by ev id would prefer the
      // viewed day's row, so a decision made about a dateless twin landed on the dated one.
      if(persistRowProp(id,"_pinnedStart",want,null,{row:b}))wrote++;else _c6bFallback("pinRefused",1);
    });
    // ★ PRUNE THE OVERLAY. Without this there is no way to express "explicitly unpinned":
    // clearing the row's key is exactly the state the fallback read treats as "the row does not
    // know, ask the overlay", so an unpin came back on the next reload. The old code could not
    // have this bug -- it wrote the whole map, so deleting a key deleted it. Verified live: 64
    // day_roots carry `_pinnedStarts` (178 entries), so this is data, not theory.
    _pruneOverlayMap("_pinnedStarts",id=>!!data[id]);
    if(rows.length)return wrote;
  }
  localStorage.setItem(PINNED_KEY,JSON.stringify(data)); scheduleIDBSave();
  return 0;
}

// Drop entries the caller no longer claims from a retired overlay map/array, so the counted
// fallback read cannot resurrect a value the user just removed. Shared by pins and locks because
// they had the identical hole; skips the write entirely when nothing changed.
// ★ C6c: THE THREE-WRITERS COLLISION, and why every write must be a TOTAL order.
//
// `saveTaskOrder` (open rows of `scheduled`), `saveSubtaskOrder` (one parent's children) and
// `saveUnscheduledOrder` (untimed + carryovers) each called `_writeRowOrder`, which numbers
// `(i+1)*1000` from ITS OWN index over a DIFFERENT subset of the same rows. They collide: dragging
// one parent's steps left a child sharing a `sort_order` with an unrelated top-level row, and the tie
// was then broken by cache iteration order -- which differs after a boot vs a `loadDay` vs an SSE
// refresh. It did not show while the overlay was the read authority; the moment the read flips, it
// does. Measured on the restore before 004: **242 days carried a duplicate `sort_order`.**
//
// So a writer hands in its subset and this splices that subset into the day's CURRENT total order,
// rearranging only the positions the subset already occupies and leaving every other row exactly
// where it is. Same mechanic `_reorderActive` (drag.js) uses over `scheduled[]`.
function _spliceDayOrder(subsetIds){
  const full=_orderFromRows(null,{datedOnly:true});
  if(!full.length)return (subsetIds||[]).map(String);
  const inFull=new Set(full.map(String));
  const subset=(subsetIds||[]).map(String).filter(id=>inFull.has(id));
  if(subset.length<2)return full;                 // nothing to rearrange
  const member=new Set(subset);
  const slots=[];
  full.forEach((id,i)=>{if(member.has(String(id)))slots.push(i);});
  const out=full.slice();
  slots.forEach((slot,k)=>{out[slot]=subset[k];});
  return out;
}

function _pruneOverlayMap(key,keep){
  const ov=_bsProp(key,null);
  if(!ov)return 0;
  if(Array.isArray(ov)){
    const next=ov.filter(id=>keep(String(id)));
    if(next.length===ov.length)return 0;
    _bsSaveProp(key,next);
    return ov.length-next.length;
  }
  if(typeof ov!=="object")return 0;
  const next={};let dropped=0;
  Object.keys(ov).forEach(k=>{if(keep(k))next[k]=ov[k];else dropped++;});
  if(dropped)_bsSaveProp(key,next);
  return dropped;
}

function pinStartTime(id,timeStr){
  const ev=scheduled.find(e=>e.id===id);if(!ev)return;
  const s=pt(timeStr),d=dur(ev);
  ev.start=timeStr;ev.end=fmt(s+d);
  // Meetings hold their slot via fixedTime (isFixedTimeBlock), not the pin map —
  // recording a pin for them is meaningless and would clutter it. Every other
  // task pins so recalcTimes() won't overwrite the chosen start.
  if(!(typeof isFixedTimeBlock==="function"&&isFixedTimeBlock(ev))){
    ev._pinnedStart=timeStr;
    const pins=loadPinnedStarts(); pins[id]=timeStr; savePinnedStarts(pins);
  }
  log("pin-start",id,"Pinned start to "+timeStr);
  recalcTimes();render();
}
function unpinStartTime(id){
  const ev=scheduled.find(e=>e.id===id);if(!ev)return;
  delete ev._pinnedStart;
  const pins=loadPinnedStarts(); delete pins[id]; savePinnedStarts(pins);
  log("unpin-start",id,"Removed start pin");
  recalcTimes();render();
}

// ======== TASK LOCK ========
// Locked tasks behave like meetings: immovable in the cascade and not draggable.
// Unlike _pinnedStart (which a drag clears), _locked is sticky -- the user
// must explicitly unlock to move the task.
let LOCKED_KEY = "pa-locked-tasks-" + ((__state && __state.date) ? __state.date : "unknown");
// C6b: locks live on the row (`properties.locked`). Measured on the prod restore: the
// `_lockedTasks` overlay holds data on ZERO day_roots and migration 001 applied 0 lock
// entries, so this axis has no data to migrate at all -- it is a pure code move, and the
// fallback below exists for symmetry and for a stale localStorage, not for prod rows.
//
// ★ A4: `db.js`'s open-tasks query (~598, ~625) still reads `_lockedTasks` off the day_root,
// and it accepts an object map as well as an array. It is left alone here deliberately:
// `db.js` is your file, it is a PATH trigger for the CI guardrail on its own, and with zero
// lock data both readers answer identically today. It goes with the overlay keys.
function loadLockedSet(){
  const out=[];
  const rows=_orderableRows();
  rows.forEach(b=>{if(b.properties.locked)out.push(_evIdOfRow(b));});
  if(window.USE_BLOCKSTORE&&window.blockStore){
    const v=_bsProp("_lockedTasks",null);
    if(v){
      const ids=Array.isArray(v)?v:Object.keys(v);
      const have=new Set(out.map(String));
      let fb=0;
      ids.forEach(id=>{if(!have.has(String(id))){out.push(id);fb++;}});
      _c6bFallback("lockedTasks",fb);
    }
    if(rows.length)return out;
  }
  if(out.length)return out;
  try{return JSON.parse(localStorage.getItem(LOCKED_KEY)||"[]")}catch(e){return[]}
}
function saveLockedSet(ids){
  const want=new Set((ids||[]).map(String));
  if(window.blockStore){
    const rows=_orderableRows();
    let wrote=0;
    rows.forEach(b=>{
      const id=_evIdOfRow(b);
      const shouldLock=want.has(String(id));
      if(!!b.properties.locked===shouldLock)return;
      if(persistRowProp(id,"locked",shouldLock?true:undefined,null,{row:b}))wrote++;else _c6bFallback("lockRefused",1);
    });
    // Same resurrection hole as pins: the fallback re-supplies a lock for any row without the
    // key, and an unlock IS that state.
    _pruneOverlayMap("_lockedTasks",id=>want.has(String(id)));
    if(rows.length)return wrote;
  }
  localStorage.setItem(LOCKED_KEY,JSON.stringify(ids||[]));scheduleIDBSave();
  return 0;
}
function toggleLock(id){
  const ev=scheduled.find(e=>e.id===id);if(!ev||isMeeting(ev))return;
  const set=new Set(loadLockedSet());
  if(ev._locked){
    delete ev._locked;
    set.delete(id);
    log("unlock",id,"Unlocked: "+ev.title);
  } else {
    ev._locked=true;
    set.add(id);
    log("lock",id,"Locked at "+ev.start+": "+ev.title);
  }
  saveLockedSet([...set]);
  recalcTimes();render();
}
// Apply persisted locks to in-memory schedule items (called on boot + date switch).
function hydrateLockedTasks(){
  const ids=loadLockedSet();
  if(!ids||!ids.length)return;
  const idSet=new Set(ids);
  scheduled.forEach(ev=>{ if(idSet.has(ev.id)) ev._locked=true; });
}

// opts (drag drops): {targetId, after, orderWins} — place the new task at the
// drop position instead of the end, then chain-reflow. Button callers pass nothing.
//
// C4: a backlog item is now SCHEDULED IN PLACE — one `date` UPDATE on the row that
// already exists. It used to deleteBacklogBlock() then persistAddedTask(), i.e.
// tombstone the row and create a second one under a NEW block id, which meant the
// backlog → today → backlog round trip returned a different row every time. Anything
// keyed to the block id (notes, the ledger's `<date>:<row id>` credit key, `parent_id`
// child edges, `subtaskOf` links written as a row id — C3 measured 7 live rows that
// use the row-id form) pointed at a tombstone afterwards. Measured on the prod restore:
// 11 tombstoned backlog rows, and Drake re-added two of them by hand under fresh
// `bl-<timestamp>` ids, which is what the churn looks like from the outside.
//
// The `consider` branch still creates: those items come from INIT_CONSIDER (data.js)
// and have no row to re-date. Only the backlog branch had one all along.
function addToSchedule(blId,opts){
  opts=opts||{};
  let idx=consider.findIndex(b=>b.id===blId),task,fromBacklog=false;
  if(idx!==-1){task=consider.splice(idx,1)[0]}else{idx=backlog.findIndex(b=>b.id===blId);if(idx===-1)return;task=backlog.splice(idx,1)[0];fromBacklog=true}
  let lastEnd="16:00";if(scheduled.length){lastEnd=scheduled[scheduled.length-1].end}
  const s=pt(lastEnd),e=s+task.durMin;
  const newItem={id:task.id,title:task.title,start:String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0"),end:String(Math.floor(e/60)).padStart(2,"0")+":"+String(e%60).padStart(2,"0"),type:task.type,meta:task.meta,detail:task.detail||"",source:task.source||"notion",notionUrl:task.notionUrl||"",priority:task.priority,commuteMinutes:task.commuteMinutes||null,commuteToMinutes:task.commuteToMinutes||task.commuteMinutes||null,commuteBackMinutes:task.commuteBackMinutes||task.commuteReturnMinutes||null};
  // Carry the row id across so the write below re-dates THIS row rather than
  // resolving it again by local_id (two rows can share one — the prod restore has a
  // live `carry-200` twin, and resolving by local_id picks whichever comes first).
  if(fromBacklog&&task._blockId)newItem._blockId=task._blockId;
  scheduled.push(newItem);
  if(opts.targetId&&typeof _reorderActive==="function")_reorderActive(newItem.id,opts.targetId,opts.after);
  // Reflow BEFORE persisting: recalcTimes can move this row's slot (and does, when
  // opts.orderWins), so writing first would store times the very next line changes
  // and leave the row's stored slot one reflow behind until syncAddedTaskTimes ran.
  recalcTimes(opts.orderWins?{orderWins:true}:undefined);
  if(fromBacklog){
    if(newItem._blockId&&typeof scheduleRowOnDay==="function"){
      const day=window.blockStore?window.blockStore.getCurrentDate():null;
      // Fire-and-forget on purpose: the in-memory plan and the render above are already
      // correct, and blockStore buffers the write into its WAL on a transient failure.
      // Any real rejection surfaces through the store's own pending-edits banner.
      if(day)scheduleRowOnDay(newItem._blockId,day,{start:newItem.start,end:newItem.end});
    }else if(typeof persistAddedTask==="function"){
      // No row id: a backlog item that was added in this session and never round-tripped
      // through hydrateBacklogFromBlocks. Creating one is correct here — there is
      // nothing to re-date — and persistBacklogItem's row, if any, is dateless and gets
      // suppressed by the fold's dated-sibling rule rather than rendering twice.
      persistAddedTask(newItem);
    }
  }else if(typeof persistAddedTask==="function")persistAddedTask(newItem);
  log("scheduled",task.id,"Added: "+task.title);render()
}
function addFollowupToSchedule(fu,parentId){
  let lastEnd="16:00";if(scheduled.length){lastEnd=scheduled[scheduled.length-1].end}
  const s=pt(lastEnd),e=s+(fu.durMin||30);
  const newItem={id:fu.id||"fu-"+(nextId++),title:fu.title,start:String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0"),end:String(Math.floor(e/60)).padStart(2,"0")+":"+String(e%60).padStart(2,"0"),type:"task",meta:(fu.durMin||30)+"min \u00b7 Action item from "+parentId,detail:fu.detail||"",source:fu.source||"notion",notionUrl:fu.href||"",priority:fu.priority||"Medium"};
  scheduled.push(newItem);
  // Remove from parent followups
  const parent=scheduled.find(x=>x.id===parentId);
  if(parent&&parent.followups){parent.followups=parent.followups.filter(f=>f.id!==fu.id)}
  // Persist so the followup-as-scheduled-task survives reload (parity with insertTaskNow / addToSchedule).
  if(typeof persistAddedTask==="function")persistAddedTask(newItem);
  recalcTimes();log("scheduled",fu.id,"Action item: "+fu.title);render()
}
// ======== BACKLOG PERSISTENCE ========
// Backlog items live in window.blockStore as type="block" with kind="backlog".
// Hydrated on boot via hydrateBacklogFromBlocks() (called from persistence.js).
function persistBacklogItem(item){
  if(!window.blockStore)return;
  try{
    window.blockStore.createBlock("block",{
      local_id:item.id,
      kind:"backlog",
      title:item.title,
      durMin:item.durMin,
      type:item.type||"task",
      meta:item.meta||"",
      detail:item.detail||"",
      source:item.source||"manual",
      notionUrl:item.notionUrl||"",
      priority:item.priority||"",
      stage:item.stage||"",
      commuteMinutes:item.commuteMinutes||null,
      commuteToMinutes:item.commuteToMinutes||item.commuteMinutes||null,
      commuteBackMinutes:item.commuteBackMinutes||item.commuteReturnMinutes||null,
      added_at:new Date().toISOString()
    },{date:null});
  }catch(e){console.warn("[backlog] persist failed:",e)}
}
// deleteBacklogBlock DELETED (C4). Its only caller was addToSchedule, which now
// re-dates the row in place instead of tombstoning it and creating a replacement.
// Nothing else should want it: taking a task OUT of the backlog is `scheduleRowOnDay`
// (it gets a date) and removing it entirely is the normal delete path, which keeps the
// undo affordance B1/B2 built. A helper whose whole job was "destroy the row so we can
// make another one" has no honest caller left.

// The Backlog is a PROJECTION over the unscheduled rows, not a parallel store (C4).
// It used to be its own filter over every cached block, which is how the Backlog drawer
// and the itinerary's Unscheduled section came to disagree: both read the same dateless
// rows through two different predicates, so one row rendered in two places with two
// badges that could not be reconciled. Measured on the prod restore, viewing today:
// backlog[] held 12 items, the fold admitted 11 rows, and 5 were the SAME rows in both.
// On 2026-07-27 it was 11 of 17.
//
// `date IS NULL` is the definition and TaskModel.selectUnscheduled is the predicate.
// The legacy dated-backlog inclusion is explained there; in short, 8 live rows carry
// kind:"backlog" AND a date because the dcc-task-ops API stamps the request date, and
// this drawer has always been the only place they render.
function hydrateBacklogFromBlocks(){
  if(!window.blockStore)return;
  const TM=window.DCC&&window.DCC.TaskModel;
  if(!TM||typeof TM.selectUnscheduled!=="function"){
    // Same loud-failure rule as the fold (persistence.js): a stale cached index.html
    // would otherwise hand back an empty backlog with nothing in the console.
    console.error("[backlog] task-model.js missing or stale — the backlog cannot be projected");
    return 0;
  }
  let added=0;
  TM.selectUnscheduled(window.blockStore.getByType("block"),{includeLegacyDatedBacklog:true}).forEach(b=>{
    const p=b.properties||{};
    const localId=TM.backlogKey(b);
    // Dedupe by ev id, matching the fold (persistence.js keys on local_id||row id).
    // Two live rows CAN share one local_id — `carry-200` does on the prod restore —
    // and in that case the drawer shows one while both rows exist. That is the
    // pre-existing behavior, kept deliberately rather than "fixed" by rendering a
    // twin nobody asked for; the pair is flagged to Track A for the migration.
    if(backlog.find(x=>x.id===localId))return;
    backlog.push({
      id:localId,
      title:p.title,
      type:p.type||"task",
      durMin:p.durMin||30,
      meta:p.meta||("Custom task \u00b7 "+ms(p.durMin||30)),
      detail:p.detail||"",
      source:p.source||"manual",
      notionUrl:p.notionUrl||"",
      priority:p.priority||"",
      stage:p.stage||"",
      commuteMinutes:p.commuteMinutes||null,
      commuteToMinutes:p.commuteToMinutes||p.commuteMinutes||null,
      commuteBackMinutes:p.commuteBackMinutes||p.commuteReturnMinutes||null,
      createdAt:b.created_at||p.added_at||"",
      updatedAt:b.updated_at||p.updated_at||"",
      _blockId:b.id,
      sortOrder:b.sort_order
    });
    added++;
  });
  return added;
}

function addNewTask(titleArg, durMinArg){
  const title=titleArg||(function(){const inp=document.getElementById("new-title");const v=inp?inp.value.trim():"";if(inp)inp.value="";return v})();
  if(!title)return;
  const durMin=durMinArg||30;
  const item={id:"custom-"+(nextId++),title,type:"task",durMin,meta:"Custom task \u00b7 "+ms(durMin),detail:"",source:"manual",notionUrl:""};
  backlog.push(item);
  persistBacklogItem(item);
  log("created","custom","New backlog: "+title);render()
}
// ======== UNIVERSAL TASK ADD BAR ========
function addTaskUniversal(barEl){
  const inp=barEl.querySelector(".tab-title");
  const title=inp.value.trim();
  if(!title){_flashBlankTitle(barEl,()=>addTaskUniversal(barEl));return}
  const durMin=parseInt(barEl.querySelector(".tab-dur").value)||30;
  const dest=barEl.querySelector(".tab-dest").value;
  // "Schedule…" defers the clear to commit time so dismissing the popover
  // doesn't eat the typed title; every other destination commits right here.
  if(dest!=="schedule")inp.value="";
  // Snap the type back to Urgent so successive adds always default to Urgent
  // rather than sticking on whatever the user last picked.
  const destSel=barEl.querySelector(".tab-dest");
  if(destSel)destSel.value="urgent";
  switch(dest){
    case"schedule":
      openSchedulePopover({mode:"create",title,durMin,
        anchorEl:barEl.querySelector(".tab-add")||barEl,
        options:{sourceBar:barEl},
        onCommitted:()=>{const i=barEl.querySelector(".tab-title");if(i&&i.value.trim()===title)i.value="";}});
      break;
    case"backlog":addNewTask(title,durMin);break;
    case"urgent":insertTaskNow(title,durMin);break;
    // Retro-logging: the task already happened — create it and check it off in
    // one gesture so points/streaks/persistence flow through the normal path.
    case"done":insertTaskNow(title,durMin,{onScheduled:r=>{if(r&&r.localId&&typeof toggleDone==="function")toggleDone(r.localId);}});break;
    case"shell":insertTaskNow(title,durMin,{type:"shell"});break;
    // Wrap: a container that earns its own points (a long focus block); children
    // ride along. insertTaskNow flags it isWrap from birth (dragMovesSubtree).
    case"wrap":insertTaskNow(title,durMin,{type:"wrap"});break;
    // Habit: recurring earn; the row grows a streak chip from prior completions.
    case"habit":insertTaskNow(title,durMin,{type:"habit"});break;
    // Manually-added meeting: no source_id, so the calendar materializer never
    // touches it. Fixed-time (reflow-exempt) but user-movable, like a synced one.
    case"meeting":insertTaskNow(title,durMin,{type:"meeting"});break;
    case"side_project":{
      if(typeof addSideProjectTask==="function")addSideProjectTask(title,durMin);
      break;
    }
    case"repeat_responsibility":{
      if(typeof openRepeatResponsibilityFromTask==="function")openRepeatResponsibilityFromTask({title,type:"task",durMin,source:"manual"});
      else if(typeof showToast==="function")showToast("Repeat responsibilities are still loading. Try again in a moment.","info");
      break;
    }
    case"delegated":{
      if(typeof openDelegatedFromTask==="function")openDelegatedFromTask({title,durMin});
      else if(typeof showToast==="function")showToast("Delegated / Blocked is still loading. Try again in a moment.","info");
      break;
    }
    case"trivial":{
      if(typeof addSideProjectTask==="function")addSideProjectTask(title,durMin);
      break;
    }
  }
}

// ======== SCHEDULE-AT PICKER (2-step) ========
// Step 1 picks a day (Today / Tomorrow / a date). Step 2 ("After…") offers the
// user's default time presets plus every task already on that day, so a new
// task can be dropped right after an existing one ends. Whatever anchor is
// chosen resolves to a concrete HH:MM start time; if that day is the one being
// viewed the task is inserted live with a pinned start, otherwise it's
// persisted to the blockstore under that date. Default time presets are
// customizable from Settings → "Schedule default times".

const SCHED_TIME_PRESETS_KEY="dcc-sched-time-presets";
const SCHED_TIME_PRESETS_DEFAULT=["08:00","12:00","17:00"];
function loadSchedTimePresets(){
  try{
    const raw=JSON.parse(localStorage.getItem(SCHED_TIME_PRESETS_KEY)||"null");
    if(Array.isArray(raw)){
      const clean=raw.filter(t=>/^\d{2}:\d{2}$/.test(t));
      if(clean.length)return clean;
    }
  }catch(e){}
  return SCHED_TIME_PRESETS_DEFAULT.slice();
}
function saveSchedTimePresets(arr){
  const clean=(arr||[]).filter(t=>/^\d{2}:\d{2}$/.test(t));
  const uniq=[...new Set(clean)].sort();
  try{localStorage.setItem(SCHED_TIME_PRESETS_KEY,JSON.stringify(uniq))}catch(e){}
  return uniq;
}
// 12-hour label for an HH:MM string (e.g. "08:00" -> "8 AM", "17:30" -> "5:30 PM")
function _schedTimeLabel(hhmm){
  const m=pt(hhmm);if(isNaN(m))return hhmm;
  let h=Math.floor(m/60);const min=m%60;const ap=h>=12?"PM":"AM";
  h=h%12;if(h===0)h=12;
  return h+(min?":"+String(min).padStart(2,"0"):"")+" "+ap;
}

let _schedPickerTitle="",_schedPickerDur=30,_schedPickerOptions={},_schedPickerDate="";
let _schedPickerOnPlace=null,_schedPickerVerb="";
function _schedSetHeader(verb){
  const overlay=document.getElementById("sched-picker-overlay");
  const hdr=overlay&&overlay.querySelector(".sched-picker-hdr h3");
  if(hdr)hdr.textContent=(verb||"Schedule")+" task";
}
function openSchedulePicker(title,durMin,options){
  _schedPickerTitle=title;
  _schedPickerDur=durMin||30;
  _schedPickerOptions=options||{};
  _schedPickerDate="";
  _schedPickerOnPlace=null;_schedPickerVerb="";
  const overlay=document.getElementById("sched-picker-overlay");
  if(!overlay){
    // Fallback if modal markup isn't present: schedule after current.
    insertTaskNow(title,durMin);
    return;
  }
  _schedSetHeader("Schedule");
  const titleEl=document.getElementById("sched-picker-title");
  if(titleEl)titleEl.value=title;
  _schedShowStep("day");
  const dateInput=document.getElementById("sched-date-input");
  if(dateInput){dateInput.style.display="none";dateInput.value="";}
  overlay.classList.add("open");
}
// Placement mode: the SAME 2-step day → "After…" UI, generalized so any mover
// (reschedule popover, move menu, drag) resolves a day + concrete start time
// through one flow. cfg: {title, durMin, verb, day, onPlace(dateStr, timeStr)}.
// timeStr null means "earliest free slot" (the old auto-slot behavior).
// Passing cfg.day skips step 1 and lands on the placement step for that day;
// Back still returns to the day step so the user can change days.
function openPlacementPicker(cfg){
  cfg=cfg||{};
  const onPlace=typeof cfg.onPlace==="function"?cfg.onPlace:null;
  const overlay=document.getElementById("sched-picker-overlay");
  if(!overlay){if(onPlace)onPlace(cfg.day||_resolvedTodayDate(),null);return}
  _schedPickerTitle=cfg.title||"";
  _schedPickerDur=cfg.durMin||30;
  _schedPickerOptions={};
  _schedPickerDate="";
  _schedPickerOnPlace=onPlace;
  _schedPickerVerb=cfg.verb||"Move";
  _schedSetHeader(_schedPickerVerb);
  const titleEl=document.getElementById("sched-picker-title");
  if(titleEl)titleEl.value=_schedPickerTitle;
  const dateInput=document.getElementById("sched-date-input");
  if(dateInput){dateInput.style.display="none";dateInput.value="";}
  if(cfg.day)_schedPickDay(cfg.day);
  else _schedShowStep("day");
  overlay.classList.add("open");
}
function closeSchedulePicker(){
  const overlay=document.getElementById("sched-picker-overlay");
  if(overlay)overlay.classList.remove("open");
  _schedPickerTitle="";_schedPickerDur=30;_schedPickerOptions={};_schedPickerDate="";
  _schedPickerOnPlace=null;_schedPickerVerb="";
}
function _schedShowStep(step){
  const dayEl=document.getElementById("sched-step-day");
  const afterEl=document.getElementById("sched-step-after");
  if(dayEl)dayEl.style.display=step==="day"?"flex":"none";
  if(afterEl)afterEl.style.display=step==="after"?"flex":"none";
}
// Lock in a day and advance to the "After…" step.
function _schedPickDay(dateStr){
  if(!dateStr)return;
  _schedPickerDate=dateStr;
  _schedShowStep("after");
  _renderSchedAfterStep(dateStr);
}
async function _renderSchedAfterStep(dateStr){
  const label=document.getElementById("sched-after-daylabel");
  if(label)label.textContent=" "+(typeof _prettyDateLabel==="function"?_prettyDateLabel(dateStr):dateStr);
  // Default time-preset chips
  const chipWrap=document.getElementById("sched-after-chips");
  if(chipWrap){
    chipWrap.innerHTML="";
    // Placement mode gets an "Earliest free" chip: the one-tap auto-slot the
    // old quick buttons did, for when the exact time doesn't matter.
    if(_schedPickerOnPlace){
      const b=document.createElement("button");
      b.type="button";b.className="sched-chip sched-chip-earliest";b.textContent="⚡ Earliest free";
      b.addEventListener("click",()=>_schedCommit(dateStr,null));
      chipWrap.appendChild(b);
    }
    loadSchedTimePresets().forEach(t=>{
      const b=document.createElement("button");
      b.type="button";b.className="sched-chip";b.textContent=_schedTimeLabel(t);
      b.addEventListener("click",()=>_schedCommit(dateStr,t));
      chipWrap.appendChild(b);
    });
  }
  // Every task already on that day, "After <title> · ends <end>"
  const taskWrap=document.getElementById("sched-after-tasks");
  if(taskWrap){
    taskWrap.innerHTML='<div class="sched-after-empty">Loading day&hellip;</div>';
    let items=[];
    try{items=await _schedDayTasks(dateStr)}catch(e){items=[]}
    // Guard against a stale render if the user navigated away meanwhile.
    if(_schedPickerDate!==dateStr)return;
    taskWrap.innerHTML="";
    if(!items.length){
      taskWrap.innerHTML='<div class="sched-after-empty">No tasks scheduled that day yet.</div>';
    }else{
      items.forEach(it=>{
        const b=document.createElement("button");
        b.type="button";b.className="sched-after-task";
        const t=document.createElement("span");t.className="sat-title";t.textContent="After "+it.title;
        const e=document.createElement("span");e.className="sat-end";e.textContent="ends "+_schedTimeLabel(it.end);
        b.appendChild(t);b.appendChild(e);
        b.addEventListener("click",()=>_schedCommit(dateStr,it.end));
        taskWrap.appendChild(b);
      });
    }
  }
}
// Collect {title,end} for tasks already on a date, sorted by end time. Uses the
// live in-memory schedule for the day currently being viewed, otherwise reads
// the day's state + persisted blocks from the API.
async function _schedDayTasks(dateStr){
  const out=[];
  const viewing=(typeof viewDate!=="undefined"&&viewDate)?viewDate:((typeof __state!=="undefined"&&__state&&__state.date)?__state.date:null);
  const toHHMM=(typeof _toHHMM==="function")?_toHHMM:(s=>s);
  if(dateStr===viewing&&typeof scheduled!=="undefined"&&Array.isArray(scheduled)){
    scheduled.forEach(ev=>{if(ev&&ev.title&&ev.end)out.push({title:ev.title,end:toHHMM(ev.end)})});
  }else{
    // One shared day fetch: the same {state,blocks} the earliest-free slot math
    // reads, so the "After…" anchors and the landed slot can't diverge.
    const ctx=await window.DCC.getDayContext(dateStr);
    const timeline=(ctx&&ctx.state&&ctx.state.schedule&&ctx.state.schedule.timeline)||[];
    timeline.forEach(e=>{if(e&&e.title&&e.end&&e.type!=="break"&&e.type!=="ooo")out.push({title:e.title,end:toHHMM(e.end)})});
    // Tasks persisted directly to that date (added/scheduled blocks)
    ((ctx&&ctx.blocks)||[]).forEach(b=>{
      const p=(b&&(b.properties||b.props))||{};
      if(b&&!b.deleted_at&&p.title&&p.end)out.push({title:p.title,end:toHHMM(p.end)});
    });
  }
  // Dedup by title+end, drop entries with an unparseable end, sort by end time.
  const seen=new Set();const uniq=[];
  out.forEach(it=>{
    if(isNaN(pt(it.end)))return;
    const k=it.title+"@"+it.end;
    if(!seen.has(k)){seen.add(k);uniq.push(it)}
  });
  uniq.sort((a,b)=>pt(a.end)-pt(b.end));
  return uniq;
}
// Resolve the chosen day+time: hand it to the placement callback (movers) or
// create the scheduled task (the original create flow), then close.
function _schedCommit(dateStr,timeStr){
  // The title is editable in the modal; whatever it says at commit time wins.
  const title=(_schedPickerTitle||"").trim()||"Untitled task";
  const durMin=_schedPickerDur,options=_schedPickerOptions;
  const onPlace=_schedPickerOnPlace;
  const bar=options&&options.sourceBar;
  closeSchedulePicker();
  if(onPlace){onPlace(dateStr,timeStr,title);return}
  commitScheduledTask(title,durMin,dateStr,timeStr,options);
  if(bar){const inp=bar.querySelector(".tab-title");if(inp){inp.value="";inp.classList.remove("tab-error");}}
}
function schedulePickerFields(durMin,options){
  options=options||{};
  // Shared value fields come from the one serializer (meta keeps its picker
  // default); responsibility metadata is picker-specific and layered on top.
  // IMPORTANT: this bag is merged as the SOURCE over a base that already holds
  // the positional title (Object.assign({id,title,...}, schedulePickerFields()))
  // so it must NOT carry a title key, or it would clobber the real title with
  // taskCommonProps's "" default. Drop it, matching the original behavior.
  const common=window.DCC.taskCommonProps(options,{meta:options.meta||("Custom task · "+ms(durMin))});
  delete common.title;
  return Object.assign(common,{
    responsibilityId:options.responsibilityId||null,
    responsibilityTitle:options.responsibilityTitle||null,
    capacityBucket:options.capacityBucket||null,
    idempotency_key:options.idempotencyKey||options.idempotency_key||null
  });
}
// Resolve a chosen day (dateStr) + time (HH:MM) into a real task. If that day is
// the one currently being viewed, insert it live with a pinned start; otherwise
// persist it to the blockstore (or a per-date localStorage bucket) for that day.
function commitScheduledTask(title,durMin,dateStr,timeStr,options){
  options=options||{};
  if(!title||!dateStr||!timeStr)return;
  const currentDate=(typeof viewDate!=="undefined"&&viewDate)
    ?viewDate:((typeof __state!=="undefined"&&__state&&__state.date)?__state.date:null);
  if(dateStr===currentDate){
    // Same day: insert into schedule and pin the start time to the chosen time
    const id=qaId();
    const s=pt(timeStr);
    const _type=options.type||"task";
    const newItem=Object.assign({id,title,type:_type,start:timeStr,end:fmt(s+durMin),
      // Rollup containers are wraps from birth so drag carries their children.
      isWrap:(window.TaskTypes&&window.TaskTypes.rule(_type,"dragMovesSubtree"))||undefined,
      _pinnedStart:timeStr},schedulePickerFields(durMin,options));
    // Insert in chronological order based on pinned start
    let insertAt=scheduled.findIndex(ev=>pt(ev.start)>=s);
    if(insertAt===-1)insertAt=scheduled.length;
    scheduled.splice(insertAt,0,newItem);
    const pins=loadPinnedStarts();pins[id]=timeStr;savePinnedStarts(pins);
    recalcTimes();
    // Single record: persistAddedTask's dated block. (A savePendingTasks push
    // here used to mint an orphaned dateless pending_task twin.)
    const persistence=persistAddedTask(newItem);
    log("scheduled",id,"Scheduled at "+timeStr+": "+title);
    render();
    checkBlockWarnings(newItem);
    if(typeof options.onScheduled==="function"){
      try{options.onScheduled({localId:id,blockId:id,start:timeStr,dateStr,persisted:Promise.resolve(persistence)});}catch(e){}
    }
  } else {
    // Different day: persist to blockstore for that target date
    const id=qaId();
    const _type=options.type||"task";
    const newItem=Object.assign({id,title,type:_type,start:timeStr,end:fmt(pt(timeStr)+durMin),
      isWrap:(window.TaskTypes&&window.TaskTypes.rule(_type,"dragMovesSubtree"))||undefined},
      schedulePickerFields(durMin,options));
    let persistence=null;
    if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.addedTasks&&window.blockStore){
      const bprops=Object.assign(
        window.DCC.taskBlockProps(newItem,{local_id:id,duration:durMin,start:timeStr,end:newItem.end}),
        {_pinnedStart:timeStr,added_at:new Date().toISOString()}
      );
      persistence=window.blockStore.createBlock("block",bprops,{date:dateStr});
      log("scheduled",id,"Scheduled for "+dateStr+" "+timeStr+": "+title);
      render();
    } else {
      // Fallback: store in a per-date localStorage bucket so it's not lost
      const key="pa-added-tasks-"+dateStr;
      let arr=[];try{arr=JSON.parse(localStorage.getItem(key)||"[]")}catch(e){arr=[]}
      arr.push(Object.assign(
        window.DCC.taskCommonProps(newItem),
        {id,durMin,start:timeStr,end:newItem.end,_pinnedStart:timeStr,addedAt:new Date().toISOString()}
      ));
      localStorage.setItem(key,JSON.stringify(arr));
      log("scheduled",id,"Scheduled for "+dateStr+" "+timeStr+": "+title);
    }
    if(typeof options.onScheduled==="function"){
      try{options.onScheduled({localId:id,blockId:id,start:timeStr,dateStr,persisted:Promise.resolve(persistence)});}catch(e){}
    }
  }
}

// Wire up the 2-step schedule picker.
(function(){
  const overlay=document.getElementById("sched-picker-overlay");
  if(!overlay)return;
  // The title is a live input in both modes: edits flow into the commit
  // (create) or into a rename that precedes the move (placement).
  const titleEl=document.getElementById("sched-picker-title");
  if(titleEl)titleEl.addEventListener("input",()=>{_schedPickerTitle=titleEl.value});
  const closeBtn=document.getElementById("sched-picker-close");
  if(closeBtn)closeBtn.addEventListener("click",closeSchedulePicker);
  overlay.addEventListener("click",e=>{if(e.target===overlay)closeSchedulePicker()});
  // Step 1: Today / Tomorrow
  overlay.querySelectorAll("[data-sched-day]").forEach(btn=>{
    btn.addEventListener("click",()=>{
      const tok=btn.getAttribute("data-sched-day");
      const d=tok==="today"?_resolvedTodayDate():tok==="tomorrow"?_resolvedTomorrowDate():null;
      if(d)_schedPickDay(d);
    });
  });
  // Step 1: pick an arbitrary date
  const pickDateBtn=document.getElementById("sched-pick-date-btn");
  const dateInput=document.getElementById("sched-date-input");
  if(pickDateBtn&&dateInput){
    // The shared picker (time-picker.js) auto-enhances #sched-date-input into a
    // hidden field; this button is its external trigger and opens the calendar.
    pickDateBtn.addEventListener("click",()=>{
      if(typeof dateInput.__twOpen==="function")dateInput.__twOpen(pickDateBtn);
      else{try{dateInput.showPicker?dateInput.showPicker():dateInput.focus()}catch(e){dateInput.focus()}}
    });
    dateInput.addEventListener("change",()=>{if(dateInput.value)_schedPickDay(dateInput.value)});
  }
  // Step 2: back + custom time
  const backBtn=document.getElementById("sched-after-back");
  if(backBtn)backBtn.addEventListener("click",()=>_schedShowStep("day"));
  const customGo=document.getElementById("sched-custom-go");
  const customTime=document.getElementById("sched-custom-time");
  const commitCustom=()=>{if(customTime&&customTime.value&&_schedPickerDate)_schedCommit(_schedPickerDate,customTime.value)};
  if(customGo)customGo.addEventListener("click",commitCustom);
  if(customTime)customTime.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();commitCustom()}});
  document.addEventListener("keydown",e=>{if(e.key==="Escape"&&overlay.classList.contains("open"))closeSchedulePicker()});
})();

// Settings → "Schedule default times": customize the After-step time presets.
function _renderSchedDefaultsList(){
  const wrap=document.getElementById("sched-defaults-list");
  if(!wrap)return;
  wrap.innerHTML="";
  const presets=loadSchedTimePresets();
  if(!presets.length){wrap.innerHTML='<div class="sched-after-empty">No times yet — add one below.</div>';return}
  presets.forEach(t=>{
    const chip=document.createElement("span");chip.className="sched-default-chip";
    const lbl=document.createElement("span");lbl.textContent=_schedTimeLabel(t);
    const rm=document.createElement("button");rm.type="button";rm.textContent="×";rm.title="Remove";
    rm.addEventListener("click",()=>{saveSchedTimePresets(presets.filter(x=>x!==t));_renderSchedDefaultsList()});
    chip.appendChild(lbl);chip.appendChild(rm);wrap.appendChild(chip);
  });
}
function openSchedDefaults(){
  const ov=document.getElementById("sched-defaults-overlay");
  if(!ov)return;_renderSchedDefaultsList();ov.classList.add("open");
}
function closeSchedDefaults(){const ov=document.getElementById("sched-defaults-overlay");if(ov)ov.classList.remove("open")}
(function(){
  const menuItem=document.getElementById("dcc-schedule-defaults");
  if(menuItem)menuItem.addEventListener("click",()=>{
    const wrap=document.getElementById("dcc-settings-wrap");if(wrap)wrap.classList.remove("open");
    openSchedDefaults();
  });
  const ov=document.getElementById("sched-defaults-overlay");
  if(!ov)return;
  const closeBtn=document.getElementById("sched-defaults-close");
  if(closeBtn)closeBtn.addEventListener("click",closeSchedDefaults);
  ov.addEventListener("click",e=>{if(e.target===ov)closeSchedDefaults()});
  const addBtn=document.getElementById("sched-defaults-add");
  const addTime=document.getElementById("sched-defaults-add-time");
  const doAdd=()=>{if(!addTime||!addTime.value)return;const cur=loadSchedTimePresets();cur.push(addTime.value);saveSchedTimePresets(cur);addTime.value="";if(typeof addTime.__twRender==="function")addTime.__twRender();_renderSchedDefaultsList()};
  if(addBtn)addBtn.addEventListener("click",doAdd);
  if(addTime)addTime.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();doAdd()}});
  const resetBtn=document.getElementById("sched-defaults-reset");
  if(resetBtn)resetBtn.addEventListener("click",()=>{saveSchedTimePresets(SCHED_TIME_PRESETS_DEFAULT.slice());_renderSchedDefaultsList()});
  const saveBtn=document.getElementById("sched-defaults-save");
  if(saveBtn)saveBtn.addEventListener("click",closeSchedDefaults);
  document.addEventListener("keydown",e=>{if(e.key==="Escape"&&ov.classList.contains("open"))closeSchedDefaults()});
})();
// ======== TASK DESTINATIONS (shared registry + radial menu) ========
// One list drives every task-add bar, so new destinations (like Shell) show up
// everywhere at once instead of drifting per-bar. The old <select> stays in
// the DOM (hidden) as the value store addTaskUniversal reads; the radial menu
// just sets it.
const TASK_DESTINATIONS=[
  {value:"urgent",  icon:"⚡", label:"Urgent"},
  {value:"done",    icon:"✅", label:"Completed"},
  {value:"schedule",icon:"📅", label:"Schedule…"},
  {value:"backlog", icon:"💡", label:"Backlog / Idea"},
  {value:"shell",   icon:"🐚", label:"Shell"},
  {value:"wrap",    icon:"🎁", label:"Wrap"},
  {value:"habit",   icon:"🔁", label:"Habit"},
  {value:"meeting", icon:"👥", label:"Meeting"}
];
function _destMeta(value){return TASK_DESTINATIONS.find(d=>d.value===value)||TASK_DESTINATIONS[0]}
// Blank title isn't a silent dead end: flash the input AND offer, via a toast
// action, to proceed as an untitled task. onProceed resumes whatever the user
// was doing (opening the radial, or committing an already-picked destination).
function _flashBlankTitle(barEl,onProceed){
  const inp=barEl.querySelector(".tab-title");
  if(inp){inp.classList.add("tab-error");setTimeout(()=>inp.classList.remove("tab-error"),400);inp.focus();}
  if(typeof showToast==="function"){
    showToast("Task title is blank","error",6000,{
      label:"Create untitled task",
      onClick:()=>{
        if(inp)inp.value="Untitled task";
        if(typeof onProceed==="function")onProceed();
      }
    });
  }
}
// The fan itself lives in radial-menu.js (generic engine); these wrappers keep
// the destination semantics — map TASK_DESTINATIONS to items whose default
// pick commits the add through the hidden select + addTaskUniversal.
function _destItems(bar,sel,opts){
  return TASK_DESTINATIONS.map(d=>({icon:d.icon,label:d.label,
    onPick:()=>{
      if(opts&&typeof opts.onPick==="function"){opts.onPick(d);return}
      sel.value=d.value;
      addTaskUniversal(bar);
    }}));
}
function _closeDestRadial(){closeRadialMenu()}
function initDestRadial(bar){
  const sel=bar.querySelector(".tab-dest");
  if(!sel)return;
  // Every bar offers the full destination set, even where markup predates one.
  TASK_DESTINATIONS.forEach(d=>{
    if(!sel.querySelector('option[value="'+d.value+'"]')){
      const o=document.createElement("option");o.value=d.value;o.textContent=d.label;sel.appendChild(o);
    }
  });
  sel.style.display="none";
  // "+ Add" is the ONE button: click fans out the destinations, and picking a
  // destination commits the add in the same gesture (no separate submit).
  const addBtn=bar.querySelector(".tab-add");
  const inp=bar.querySelector(".tab-title");
  if(!addBtn)return;
  const openOrFlash=()=>{
    _hideDestPreview();
    if(document.querySelector(".dest-radial-backdrop")){_closeDestRadial();return}
    // Armed bar (FAB flow: type was chosen FIRST): + Add commits straight to
    // the armed destination, no second radial.
    const armed=bar.dataset.armedDest;
    if(armed){
      sel.value=armed;
      addTaskUniversal(bar);
      return;
    }
    const title=inp?inp.value.trim():"";
    if(!title){
      _flashBlankTitle(bar,()=>_openDestRadial(bar,sel,addBtn));
      return;
    }
    _openDestRadial(bar,sel,addBtn);
  };
  addBtn.addEventListener("click",e=>{e.stopPropagation();openOrFlash()});
  if(inp)inp.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();openOrFlash()}});
  // Hover teaser: a small radial "toast" previewing exactly what will fan out
  // on click. Hovering ONTO the teaser promotes it to the full interactive
  // radial, so both paths (click, or hover-then-hover) reach a pick.
  // Armed bars skip the teaser — + Add commits directly there.
  let hoverTimer=null;
  addBtn.addEventListener("mouseenter",()=>{
    clearTimeout(_destPreviewHideTimer);
    if(bar.dataset.armedDest)return;
    if(document.querySelector(".dest-radial-backdrop"))return;
    hoverTimer=setTimeout(()=>_showDestPreview(bar,sel,addBtn),220);
  });
  addBtn.addEventListener("mouseleave",()=>{
    clearTimeout(hoverTimer);
    // Grace window: the pointer needs time to cross the gap from the button
    // to a teaser dot without the preview vanishing underneath it.
    clearTimeout(_destPreviewHideTimer);
    _destPreviewHideTimer=setTimeout(_hideDestPreview,320);
  });
}
// The mini preview: engine-rendered dots; entering one expands to the real
// radial anchored on the same button. The grace timer lives here (shared with
// the initDestRadial mouseleave handlers).
let _destPreviewHideTimer=null;
function _showDestPreview(bar,sel,anchorBtn){
  showRadialMenuPreview(anchorBtn,_destItems(bar,sel),{
    onExpand:()=>{clearTimeout(_destPreviewHideTimer);_openDestRadial(bar,sel,anchorBtn)},
    onDotLeave:()=>{clearTimeout(_destPreviewHideTimer);_destPreviewHideTimer=setTimeout(_hideDestPreview,320)}
  });
}
function _hideDestPreview(){hideRadialMenuPreview()}
function _openDestRadial(bar,sel,trig,opts){
  opts=opts||{};
  // Picking a destination IS the submit — one gesture, committed — unless the
  // caller intercepts (e.g. the FAB arms the compose bar via opts.onPick).
  openRadialMenu(trig,_destItems(bar,sel,opts),{a0:opts.a0,a1:opts.a1});
}
// ── Armed compose (FAB choose-type-first flow) ──
// The launcher FAB fans out the destinations BEFORE the compose bar opens;
// the pick "arms" the bar: a chip shows the chosen type, and + Add / Enter
// commits straight to it. Clicking the chip re-opens the fan to switch type.
function _setDestArm(bar,destValue){
  bar.dataset.armedDest=destValue;
  const sel=bar.querySelector(".tab-dest");
  if(sel)sel.value=destValue;
  let chip=bar.querySelector(".dest-armed-chip");
  if(!chip){
    chip=document.createElement("button");
    chip.type="button";chip.className="dest-armed-chip";chip.title="Change task type";
    const inp=bar.querySelector(".tab-title");
    bar.insertBefore(chip,inp||bar.firstChild);
    chip.addEventListener("click",e=>{
      e.stopPropagation();
      _openDestRadial(bar,sel,chip,{onPick:d=>_setDestArm(bar,d.value)});
    });
  }
  const m=_destMeta(destValue);
  chip.innerHTML='<span class="dac-icon">'+m.icon+'</span><span class="dac-label">'+m.label+'</span>';
}
function _clearDestArm(bar){
  if(!bar)return;
  delete bar.dataset.armedDest;
  const chip=bar.querySelector(".dest-armed-chip");
  if(chip)chip.remove();
}
// Called by launcher.js on a quick FAB tap: destinations fan out from the FAB
// (up-left arc, it lives in the corner); the pick arms the bar then opens
// the compose. Dismissing the fan opens nothing.
function openDestRadialForLauncher(anchorBtn,onOpenCompose){
  const bar=document.getElementById("task-add-launcher");
  const sel=bar&&bar.querySelector(".tab-dest");
  if(!bar||!sel){if(typeof onOpenCompose==="function")onOpenCompose();return}
  _openDestRadial(bar,sel,anchorBtn,{a0:185,a1:268,onPick:d=>{
    _setDestArm(bar,d.value);
    if(typeof onOpenCompose==="function")onOpenCompose();
  }});
}
window.openDestRadialForLauncher=openDestRadialForLauncher;
window._clearDestArm=_clearDestArm;

// Wire up all task-add bars ("+ Add" opens the radial; Enter in the title too)
document.querySelectorAll(".task-add-bar").forEach(bar=>initDestRadial(bar));

// ======== UNIFIED BLOCK QUERY HELPERS ========
// All user data is type='block'. These helpers filter by property presence.
function _allBlocks(){
  if(!window.blockStore)return[];
  // Get from both caches — unified blocks may be in either
  const byType=window.blockStore.getByType("block");
  // Also include legacy types during migration transition
  const legacyTypes=["added_task","schedule_item","trivial_task","action_item","pending_task",
    "sticky_note","life_capture","engram","mood_entry","pomo_session","schedule_block","tag","note"];
  const legacy=legacyTypes.flatMap(t=>{try{return window.blockStore.getByType(t)}catch(e){return[]}});
  // Dedupe by id
  const seen=new Set();const result=[];
  [...byType,...legacy].forEach(b=>{if(!seen.has(b.id)){seen.add(b.id);result.push(b)}});
  return result;
}

function getScheduledBlocks(date){
  return _allBlocks().filter(b=>{
    const p=b.properties||{};
    // Unified: check scheduled_dates
    if(p.scheduled_dates&&p.scheduled_dates[date])return true;
    // Legacy: added_task/schedule_item blocks have start/end + date on the block itself
    if(b.date===date&&p.start&&p.end)return true;
    return false;
  });
}

function getBacklogBlocks(){
  return _allBlocks().filter(b=>{
    const p=b.properties||{};
    if(!p.title)return false;
    if(p.status==="archived"||p.status==="done")return false;
    // No scheduled_dates means backlog material
    if(p.scheduled_dates&&Object.keys(p.scheduled_dates).length>0)return false;
    // Legacy added_task/schedule_item blocks with start/end are scheduled, not backlog
    if(p.start&&p.end)return false;
    // Must not be trivial, action-item, pinned, or other special blocks
    const tags=p.tags||[];
    if(tags.includes("trivial")||tags.includes("side-project")||tags.includes("action-item")||tags.includes("pinned"))return false;
    // Must not be non-task blocks (notes, engrams, etc.)
    if(p.html&&!p.title)return false; // notes
    if(p.mood!==undefined&&!p.title)return false; // mood-only
    if(p.tag&&p.name&&!p.title)return false; // engram without title
    return true;
  });
}

function getBlocksByTag(tag){
  return _allBlocks().filter(b=>{
    const tags=(b.properties||{}).tags||[];
    return tags.includes(tag);
  });
}

function findBlockByTitle(title){
  if(!title)return null;
  const lower=title.toLowerCase().trim();
  return _allBlocks().find(b=>{
    const t=(b.properties||{}).title;
    return t&&t.toLowerCase().trim()===lower&&(b.properties||{}).status!=="archived";
  })||null;
}

function scheduleBlockOnDate(id, date, start, end){
  if(!window.blockStore)return;
  const block=window.blockStore.get(id);
  if(!block)return;
  const p={...(block.properties||{})};
  if(!p.scheduled_dates)p.scheduled_dates={};
  p.scheduled_dates[date]={start,end,done:false,pinned:false};
  window.blockStore.updateBlock(id,p);
}

function unscheduleBlockFromDate(id, date){
  if(!window.blockStore)return;
  const block=window.blockStore.get(id);
  if(!block)return;
  const p={...(block.properties||{})};
  if(p.scheduled_dates){
    delete p.scheduled_dates[date];
    if(Object.keys(p.scheduled_dates).length===0)delete p.scheduled_dates;
  }
  window.blockStore.updateBlock(id,p);
}

function markDoneOnDate(id, date){
  if(!window.blockStore)return;
  const block=window.blockStore.get(id);
  if(!block)return;
  const p={...(block.properties||{})};
  if(p.scheduled_dates&&p.scheduled_dates[date]){
    p.scheduled_dates[date]={...p.scheduled_dates[date],done:true,done_at:new Date().toISOString()};
    window.blockStore.updateBlock(id,p);
  }
}

// undoLast() and resetAll() removed Phase 6 -- both broken; see features.js.
// actionLog still populated by log() because updateSync() renders the header
// activity summary ("N done · N adj") from it (sync.js) -- that path is alive.
// (The Copy-for-Claude button that also read actionLog was removed 2026-07.)

// ======== TASK ORDER PERSISTENCE ========
let ORDER_KEY = "pa-task-order-" + ((__state && __state.date) ? __state.date : "unknown");
// C6c: `sort_order` IS the order now. C6b stopped short of this because the column was three
// numbering schemes sharing one field -- 231 rows 1000-spaced from a drag, 1005 minutes-of-day from
// `db.js createItineraryTask`, 289 zeros from `createBlock`'s default, and 63 of 113 days holding a
// mix. C6c fixed all four producers and `migrations/004` renumbered every live task row into one
// 1000-spaced space per (date, workspace). Verified across 118 days on a prod restore: **the order
// the user SEES is byte-identical before and after.**
//
// ★ 004 IS A HARD PREREQUISITE FOR THIS DEPLOY, and the first cut of this comment claimed otherwise.
// The overlay fallback below is only reachable when the day has ZERO orderable rows -- i.e. when there
// is nothing to order -- so it does NOT cover an un-migrated day. On the 40 day_roots carrying
// `_taskOrder`, deploying first would read the mixed column, and the first drag would then splice into
// that nonsense AND prune the overlay, destroying the only record of the real order.
//
// The ordering is safe in the other direction and needs no code: the OLD client reads the overlay for
// order and merely dual-writes `sort_order`, so 004 renumbering underneath it is invisible. **Apply
// 004, verify, then deploy.** The fallback stays as belt-and-braces for a workspace with no rows yet.
// A4 removes the overlay keys and it together.
function loadTaskOrder(){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.reorder&&window.blockStore){
    const derived=_orderFromRows(null,{datedOnly:true});
    if(derived.length)return derived;
    const v=_bsProp("_taskOrder",null);
    if(v&&v.length){_c6bFallback("taskOrder",v.length);return v;}
  }
  try{return JSON.parse(localStorage.getItem(ORDER_KEY)||"[]")}catch(e){return[]}
}
// C6c: a TOTAL order for the day (see `_spliceDayOrder`), and the overlay is PRUNED rather than
// written -- the read is canonical now, so a surviving overlay entry could only resurrect an old
// position through the fallback. C6b's fix stays: `_writeRowOrder` keys on the EV ID, so the 1546 of
// 1815 live task rows with no `local_id` and the 37 untimed ones are reorderable at all.
function saveTaskOrder(){
  const order=DCC.TaskModel.selectOpen(scheduled).map(ev=>ev.id);
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.reorder&&window.blockStore){
    _writeRowOrder(_spliceDayOrder(order));
    _pruneOverlayMap("_taskOrder",()=>false);   // the row is the authority; drop the whole list
    return;
  }
  localStorage.setItem(ORDER_KEY,JSON.stringify(order)); scheduleIDBSave();
}

// ======== UNSCHEDULED ORDER PERSISTENCE ========
// The Unscheduled section is drag-reorderable. It mixes two id spaces — untimed
// today tasks (in scheduled[]) and past-day carryovers (not in scheduled[]) —
// and its items hold no clock time, so their order can't ride the time cascade
// (recalcTimes skips untimed items). Persist an explicit unified id-list on the
// day_root (mirrors _subtaskOrder / _taskOrder) so a manual drag order survives
// reflows and reloads. Rendered by _orderUnscheduled (schedule-tab.js) in manual mode.
// ★ THE UNSCHEDULED AXIS STAYS ON ITS OVERLAY, and this is a conceptual limit, not a deferral.
// The section deliberately mixes today's untimed rows with PAST-DAY carryovers, and `sort_order` is
// scoped per (date, workspace) by definition -- so a cross-day section's manual order has no per-day
// column to live in. Numbering a carryover into today's space would lie about which day owns it;
// numbering it in its own day's space says nothing about where it sits in today's list. A genuine
// cross-day order axis would be NEW persisted state, not a collapse of existing state, so it is out
// of scope for a phase whose job is removing duplicate authorities.
//
// Measured on prod: **0 day_roots carry `_unscheduledOrder`**, so nothing is lost by leaving it.
// Second, independent blocker if anyone tries: a carryover row lives in `blockStore._rangeCache`,
// which `getByType` does not read (`unfinished-tasks.js` documents the split), so `_orderableRows`
// cannot see most of the rows this section is about.
function loadUnscheduledOrder(){
  if(window.USE_BLOCKSTORE&&window.blockStore){
    const v=_bsProp("_unscheduledOrder",null);
    if(Array.isArray(v))return v;
  }
  try{return JSON.parse(localStorage.getItem("pa-unsched-order-"+((__state&&__state.date)||"unknown"))||"[]")}catch(e){return[]}
}
// ids: explicit unified display order (untimed + carryover ids), passed by the
// drag handler. Omitted: fall back to the untimed-only scheduled[] order.
function saveUnscheduledOrder(ids){
  let order=ids;
  if(!Array.isArray(order)){
    if(typeof scheduled==="undefined"||!Array.isArray(scheduled))return;
    order=DCC.TaskModel.selectActive(scheduled)
      .filter(ev=>ev.untimed)
      .map(ev=>ev.id);
  }
  // The overlay stays the authority (see loadUnscheduledOrder) AND sort_order is kept current for
  // the rows that are reachable, so C6c inherits a column that is not drifting.
  if(window.blockStore)_writeRowOrder(order);
  if(!_bsSaveProp("_unscheduledOrder",order)){
    try{localStorage.setItem("pa-unsched-order-"+((__state&&__state.date)||"unknown"),JSON.stringify(order))}catch(e){}
  }
}

// ======== BLOCK BOUNDARY WARNINGS ========
function checkBlockWarnings(task){
  const blocks=(__state&&__state.schedule&&__state.schedule.blocks)||[];
  if(!blocks.length||!task) return;
  const taskStart=pt(task.start), taskEnd=pt(task.end);
  for(const b of blocks){
    const bStart=pt(b.start), bEnd=pt(b.end);
    const bt=b.blockType||b.type;
    // Protected boundary: warn if task overlaps a protected block
    if(b.protected && taskStart<bEnd && taskEnd>bStart && bt==='personal'){
      showToast("⚠ \""+task.title+"\" overlaps protected block \""+b.name+"\"","error",8000);
    }
    // Threshold warning: warn if remaining time in current block is low
    if(b.warnThreshold && b.warnThreshold>0){
      const now=new Date();
      const nowMin=now.getHours()*60+now.getMinutes();
      if(nowMin>=bStart && nowMin<bEnd){
        const remaining=bEnd-nowMin;
        if(remaining<=b.warnThreshold){
          showToast("⏱ Only "+remaining+"m left in \""+b.name+"\"","error",6000);
        }
      }
    }
  }
}
