// ======== DRAG ========
let dragId=null;
function dStart(e,id){
  dragId=id;
  e.dataTransfer.effectAllowed="move";
  e.dataTransfer.setData("text/plain",id); // required for Firefox
  const el=e.target.closest(".tl-item");if(el)el.classList.add("dragging");
  const listEl=e.target.closest(".it-list-item");if(listEl)listEl.classList.add("dragging");
}
function dEnd(){dragId=null;window._dragNowPill=false;document.querySelectorAll(".tl-item,.it-list-item").forEach(el=>el.classList.remove("dragging","drag-over-top","drag-over-bottom","drag-over-nest","drag-over-nest-sub","pin-drop-target"))}
function dOver(e,id){
  e.preventDefault();
  // Dragging the live now-pill: highlight the hovered card as the pin target
  // instead of showing reorder (top/bottom/nest) feedback.
  if(window._dragNowPill){
    const t=e.currentTarget;
    document.querySelectorAll(".pin-drop-target").forEach(x=>{if(x!==t)x.classList.remove("pin-drop-target");});
    t.classList.add("pin-drop-target");
    return;
  }
  if(id===dragId)return;
  const tgt=e.currentTarget,r=tgt.getBoundingClientRect();
  const y=e.clientY-r.top,h=r.height;
  tgt.classList.remove("drag-over-top","drag-over-bottom","drag-over-nest","drag-over-nest-sub");
  const targetEv=(typeof scheduled!=="undefined")?scheduled.find(x=>x.id===id):null;
  // Drop on the body of a task = nest inside it; drop near the top/bottom edge = reorder to that slot.
  // Plain body-drop = ride-along (own time/points); hold Shift = subtask (shares the parent's pie).
  const canNest=targetEv&&typeof isMeeting==="function"&&!isMeeting(targetEv)&&!(typeof _isAncestor==="function"&&_isAncestor(dragId,id));
  if(canNest&&y>h*0.25&&y<h*0.75){
    tgt.classList.add("drag-over-nest");
    tgt.classList.toggle("drag-over-nest-sub",!!e.shiftKey);
    return;
  }
  tgt.classList.toggle("drag-over-top",y<h/2);
  tgt.classList.toggle("drag-over-bottom",y>=h/2);
}
function dLeave(e){e.currentTarget.classList.remove("drag-over-top","drag-over-bottom","drag-over-nest","drag-over-nest-sub","pin-drop-target")}

// ── Scheduling helpers ──

function isFixedTimeBlock(ev){
  return isMeeting(ev)||ev.type==="ooo"||ev.type==="break";
}

// Build fixed blocker array from INIT_SCHED (used by both cascade variants)
function _meetingBlocks(){
  return INIT_SCHED
    .filter(isFixedTimeBlock)
    .map(ev=>({s:pt(ev.start),e:pt(ev.end)}))
    .sort((a,b)=>a.s-b.s);
}

// Return the earliest start >= cursor where duration d fits without overlapping any meeting
function _freeStart(cursor, d, meetingBlocks){
  let s=cursor, changed=true;
  while(changed){
    changed=false;
    for(const b of meetingBlocks){
      if(s<b.e&&s+d>b.s){s=b.e;changed=true;}
    }
  }
  return s;
}

// Tag-aware helpers (used by recalcTimesTagAware)
function getTagAncestors(tagId){
  return (window.__TAGS__ && window.__TAGS__.getAncestors) ? window.__TAGS__.getAncestors(tagId) : [tagId];
}

function taskMatchesBlock(task, block){
  const accepted = block.acceptedTags || [];
  if(accepted.length === 0) return true;           // general block: accepts all
  const taskTags = task.tags || [];
  if(taskTags.length === 0) return false;           // untagged task: only general blocks
  const taskSet = new Set(taskTags.flatMap(tid => getTagAncestors(tid)));
  return accepted.some(id => taskSet.has(id));
}

// Tag-aware cascade: tasks are placed into the earliest matching schedule block.
// Falls back to sequential placement when no block matches or block is full.
function recalcTimesTagAware(schedBlocks){
  const active = scheduled.filter(ev => !isDone(ev) && !isDeleted(ev));
  if(!active.length) return;

  const firstOrig = INIT_SCHED.find(ev => !isDone(ev) && !isDeleted(ev));
  const tagAnchorCandidates = active.map(ev => pt(ev.start));
  if(firstOrig) tagAnchorCandidates.push(pt(firstOrig.start));
  let fallbackCursor = Math.min.apply(null, tagAnchorCandidates);
  if(typeof viewMode !== "undefined" && viewMode === "today" && typeof now === "function"){
    fallbackCursor = Math.min(fallbackCursor, now());
  }

  // Pass 1: place pinned/locked tasks and collect them as blockers alongside meetings.
  const blockers = _meetingBlocks().slice();
  active.forEach(ev => {
    if(isNested(ev)) return; // nested (ride-along/subtask): lives under its parent, never a blocker
    if(isFixedTimeBlock(ev)) return;
    if(ev._pinnedStart || ev._locked){
      const d = dur(ev);
      const ps = pt(ev._pinnedStart || ev.start);
      ev.start = fmt(ps); ev.end = fmt(ps + d);
      blockers.push({s: ps, e: ps + d});
    }
  });
  blockers.sort((a, b) => a.s - b.s);

  // Per-block free-slot cursor (starts at block's start time)
  const nextFree = {};
  schedBlocks.forEach(b => { nextFree[b.id] = pt(b.start); });

  active.forEach(ev => {
    if(isNested(ev)) return; // nested (ride-along/subtask): doesn't consume the cascade cursor
    if(isFixedTimeBlock(ev)){
      fallbackCursor = Math.max(fallbackCursor, pt(ev.end));
      return;
    }
    if(ev._pinnedStart || ev._locked){
      fallbackCursor = Math.max(fallbackCursor, pt(ev.end));
      return;
    }
    const d = dur(ev);

    // Find the matching block with the earliest available slot that fits
    let bestBlock = null, bestStart = Infinity;
    for(const b of schedBlocks){
      if(!taskMatchesBlock(ev, b)) continue;
      const slotStart = _freeStart(nextFree[b.id] || pt(b.start), d, blockers);
      const slotEnd = slotStart + d;
      // Must fit within the block's time window
      if(slotStart >= pt(b.start) && slotEnd <= pt(b.end)){
        if(slotStart < bestStart){
          bestStart = slotStart;
          bestBlock = b;
        }
      }
    }

    if(bestBlock){
      ev.start = fmt(bestStart); ev.end = fmt(bestStart + d);
      nextFree[bestBlock.id] = bestStart + d;
      fallbackCursor = Math.max(fallbackCursor, bestStart + d);
    } else {
      // No block matched or had room — use fallback sequential cascade
      const s = _freeStart(fallbackCursor, d, blockers);
      ev.start = fmt(s); ev.end = fmt(s + d);
      fallbackCursor = s + d;
    }
  });

  scheduled.sort((a, b) => pt(a.start) - pt(b.start));
}

// Recascade start/end times for all undone tasks, treating meetings and any
// pinned (or locked) task as immovable. Unpinned tasks flow around all of
// them so inserting an Urgent task at a fixed time bumps later tasks
// forward.
// When any schedule block has acceptedTags, delegates to recalcTimesTagAware.
function recalcTimes(){
  // Tag-aware mode: delegate when any block has accepted tags configured
  const schedBlocks = (__state && __state.schedule && __state.schedule.blocks) || [];
  if(schedBlocks.some(b => (b.acceptedTags || []).length > 0)){
    recalcTimesTagAware(schedBlocks);
    return;
  }

  // Untimed tasks (no start; e.g. Slack-bookmark inserts) are excluded from the
  // cascade -- they live in the Unscheduled section, not the timeline, so they
  // must not consume a time slot or shift real tasks.
  const active=scheduled.filter(ev=>!isDone(ev)&&!isDeleted(ev)&&!ev.untimed);
  if(!active.length)return;

  // Pass 1: place pinned/locked tasks at their pinned start and add them to the
  // blockers list alongside meetings. Locked tasks pin to their current start.
  const blockers=_meetingBlocks().slice();
  active.forEach(ev=>{
    if(isNested(ev))return;          // nested (ride-along/subtask): lives under its parent, never a blocker
    if(isFixedTimeBlock(ev))return;     // already represented in _meetingBlocks()
    if(ev._pinnedStart||ev._locked){
      const d=dur(ev);
      const ps=pt(ev._pinnedStart||ev.start);
      ev.start=fmt(ps);ev.end=fmt(ps+d);
      blockers.push({s:ps,e:ps+d});
    }
  });
  blockers.sort((a,b)=>a.s-b.s);

  // Anchor: earliest known start across original schedule + active items, so
  // unpinned tasks fill morning slots even when INIT_SCHED's first item is a
  // late event (e.g. an evening "Personal" block) and the user has only
  // user-added tasks earlier in the day.
  const firstOrig=INIT_SCHED.find(ev=>!isDone(ev)&&!isDeleted(ev));
  const anchorCandidates=active.map(ev=>pt(ev.start));
  if(firstOrig)anchorCandidates.push(pt(firstOrig.start));
  let cursor=Math.min.apply(null,anchorCandidates);

  // On today's view: if the anchor is in the future (e.g. the only non-done item is an
  // evening meeting and it's still afternoon), pull cursor back to now so that newly added
  // tasks fill available time before the meeting rather than piling up after it.
  if(typeof viewMode!=="undefined"&&viewMode==="today"&&typeof now==="function"){
    cursor=Math.min(cursor,now());
  }

  // Pass 2: cascade non-pinned, non-locked, non-meeting tasks around all blockers.
  active.forEach(ev=>{
    if(isNested(ev))return;          // nested (ride-along/subtask): doesn't consume the cascade cursor
    if(isFixedTimeBlock(ev)){
      cursor=Math.max(cursor,pt(ev.end));
      return;
    }
    if(ev._pinnedStart||ev._locked){
      cursor=Math.max(cursor,pt(ev.end));
      return;
    }
    const d=dur(ev);
    const s=_freeStart(cursor,d,blockers);
    ev.start=fmt(s);ev.end=fmt(s+d);
    cursor=s+d;
  });

  // Re-sort scheduled by time so list order always matches clock order.
  // Tasks pushed past meetings will automatically appear after them in the list.
  scheduled.sort((a,b)=>pt(a.start)-pt(b.start));
}

// ── WRAP/NEST DRAG HELPERS (v2) ──
// Persist an item's parent membership (wrapId/subtaskOf) + times to the
// blockstore. updateBlock() updates the cache synchronously, so a later
// syncAddedTaskTimes() won't clobber the membership we just wrote.
function _persistEvWrap(ev){
  if(!window.blockStore||!ev)return;
  let bid=ev._blockId;
  if(!bid){const b=window.blockStore.getByType("block").find(b=>(b.properties||{}).local_id===ev.id);bid=b&&b.id;}
  if(!bid)return;
  const blk=window.blockStore.get?window.blockStore.get(bid):null;
  const props={...((blk&&blk.properties)||{})};
  props.wrapId=ev.wrapId||null;
  props.subtaskOf=ev.subtaskOf||null;
  props.isWrap=!!ev.isWrap;
  props.start=ev.start;props.end=ev.end;
  try{window.blockStore.updateBlock(bid,props);}catch(e){}
}
// True if ancestorId is somewhere above nodeId in the parent chain (guards against
// nesting a task into one of its own descendants).
function _isAncestor(ancestorId,nodeId){
  let cur=scheduled.find(e=>e.id===nodeId),guard=0;
  while(cur&&guard++<50){
    const pid=parentIdOf(cur);
    if(!pid)return false;
    if(pid===ancestorId)return true;
    cur=scheduled.find(e=>e.id===pid);
  }
  return false;
}
// First free slot inside a wrap's [start,end] window for a ride-along.
function _placeInWrapWindow(moved,wrapEv){
  const ws=pt(wrapEv.start),we=pt(wrapEv.end),d=dur(moved)||15;
  const blockers=scheduled.filter(c=>c.wrapId===wrapEv.id&&c.id!==moved.id)
    .map(c=>({s:pt(c.start),e:pt(c.end)})).sort((a,b)=>a.s-b.s);
  let s=_freeStart(ws,d,blockers);
  if(s+d>we)s=ws; // window full: stack at start (over-capacity; bandwidth chip shows it)
  moved.start=fmt(s);moved.end=fmt(s+d);
}
function _reorderActive(movedId,targetId,after){
  const active=scheduled.filter(ev=>!isDone(ev)&&!isPushed(ev));
  const fi=active.findIndex(x=>x.id===movedId);if(fi===-1)return;
  const[m]=active.splice(fi,1);
  const ti=active.findIndex(x=>x.id===targetId);
  const idx=ti===-1?active.length:(after?ti+1:ti);
  active.splice(idx,0,m);
  let ai=0;for(let i=0;i<scheduled.length;i++){if(!isDone(scheduled[i])&&!isPushed(scheduled[i]))scheduled[i]=active[ai++];}
}
function _clearPin(ev){
  if(ev&&ev._pinnedStart){
    delete ev._pinnedStart;
    if(typeof loadPinnedStarts==="function"&&typeof savePinnedStarts==="function"){
      const pins=loadPinnedStarts();if(pins[ev.id]){delete pins[ev.id];savePinnedStarts(pins);}
    }
  }
}
function _finishDrag(old){
  if(typeof saveTaskOrder==="function")saveTaskOrder();
  if(typeof syncAddedTaskTimes==="function")syncAddedTaskTimes();
  if(typeof log==="function")log("reorder",dragId,old);
  dragId=null;
  document.querySelectorAll(".tl-item,.it-list-item").forEach(el=>el.classList.remove("drag-over-top","drag-over-bottom","drag-over-nest","drag-over-nest-sub"));
  render();
}

function dDrop(e,tid){
  e.preventDefault();
  // Dropping the live now-pill onto a card pins that task as "active" instead of
  // reordering anything. _dragNowPill is set by the pill's dragstart (schedule-tab.js).
  if(window._dragNowPill){
    window._dragNowPill=false;
    document.querySelectorAll(".pin-drop-target").forEach(x=>x.classList.remove("pin-drop-target"));
    if(typeof setPinnedActiveId==="function"){
      setPinnedActiveId(tid);
      if(typeof log==="function")log("pin-active",tid,"Pinned via drag");
      if(typeof render==="function")render();
    }
    return;
  }
  const clearCls=()=>document.querySelectorAll(".tl-item,.it-list-item").forEach(el=>el.classList.remove("drag-over-top","drag-over-bottom","drag-over-nest","pin-drop-target"));
  // External drag of a preset task group card: add the whole group to the day.
  if(window._dragFromTaskGroup){
    const gid=window._dragFromTaskGroup; window._dragFromTaskGroup=null;
    clearCls();
    if(typeof window.addTaskGroupToDay==="function")window.addTaskGroupToDay(gid);
    return;
  }
  if(!dragId){clearCls();return;}

  // External drag from the Tasks drawer backlog: add to schedule instead of reordering.
  if(window._dragFromBacklog){
    window._dragFromBacklog=false;
    const id=dragId; dragId=null;
    if(typeof addToSchedule==="function") addToSchedule(id);
    clearCls();return;
  }
  if(dragId===tid){clearCls();return;}

  const moved=scheduled.find(x=>x.id===dragId);
  const target=scheduled.find(x=>x.id===tid);
  if(!moved||!target){dragId=null;clearCls();return;}
  const old=JSON.stringify(scheduled);

  // Dragging a row out of the Unscheduled section onto a timed row schedules it:
  // once untimed is cleared it joins the normal cascade (recalcTimes skips
  // untimed items) and its assigned time persists via syncAddedTaskTimes in
  // _finishDrag. Seed its start from the drop target first — untimed rows carry
  // start "00:00", and an active 00:00 would become recalcTimes' Math.min
  // anchor, cascading the whole day's unpinned tasks from midnight. A drop onto
  // another Unscheduled row is just a reorder within the section: stays untimed.
  if(moved.untimed&&!target.untimed){
    moved.untimed=false;
    const _d=dur(moved)||30;
    const _s=pt(target.start)||(typeof now==="function"?Math.ceil(now()/15)*15:8*60);
    moved.start=fmt(_s);moved.end=fmt(_s+_d);
  }

  // Drop zone from cursor position over the target row.
  const r=e.currentTarget.getBoundingClientRect();
  const y=e.clientY-r.top,h=r.height;
  const nest=(typeof isMeeting==="function"&&!isMeeting(target)&&y>h*0.25&&y<h*0.75&&!_isAncestor(moved.id,target.id));
  const after=y>=h/2;

  // ---- Case A: dragging a WRAP -> move it; its ride-alongs follow by the same delta ----
  if(typeof isWrap==="function"&&isWrap(moved)){
    const oldStart=pt(moved.start);
    _clearPin(moved);
    _reorderActive(moved.id,target.id,after);
    recalcTimes();
    const delta=pt(moved.start)-oldStart;
    if(delta){
      scheduled.filter(c=>c.wrapId===moved.id).forEach(c=>{
        c.start=fmt(pt(c.start)+delta);c.end=fmt(pt(c.end)+delta);_persistEvWrap(c);
      });
    }
    _finishDrag(old);return;
  }

  // ---- Decide nesting: dropping on a task's body wraps the moved item inside it ----
  const newWrapId=nest?target.id:null;

  if(newWrapId&&e.shiftKey){
    // ---- Case B': NEST as a SUBTASK (umbrella; shares the parent's point pie and
    // travels with it). Shift held during the drop selects this over a ride-along. ----
    if(typeof reparentAsSubtask==="function")reparentAsSubtask(moved.id,newWrapId);
    _finishDrag(old);return;
  }
  if(newWrapId){
    // ---- Case B: NEST as a ride-along (concurrent, inside the wrap window). The
    // target becomes a wrap if it wasn't one. ----
    const wrapEv=scheduled.find(x=>x.id===newWrapId);
    moved.wrapId=newWrapId;moved.subtaskOf=null;
    _clearPin(moved);
    if(wrapEv){
      if(!isWrap(wrapEv)){wrapEv.isWrap=true;_persistEvWrap(wrapEv);} // target is now a wrap
      _placeInWrapWindow(moved,wrapEv);
    }
    _persistEvWrap(moved);
    recalcTimes();
    if(typeof showToast==="function"&&wrapEv)showToast('Wrapped inside "'+wrapEv.title+'"',"success",2200);
  }else{
    // ---- Case C: TOP-LEVEL drop -> promote out of any parent, then sequential reorder ----
    const wasNested=!!parentIdOf(moved);
    moved.wrapId=null;moved.subtaskOf=null;
    _clearPin(moved);
    _reorderActive(moved.id,target.id,after);
    recalcTimes();
    if(wasNested){_persistEvWrap(moved);if(typeof showToast==="function")showToast("Promoted to its own task","success",2200);}
  }
  _finishDrag(old);
}

