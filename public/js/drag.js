// ======== DRAG ========
let dragId=null;
function dStart(e,id){
  dragId=id;
  e.dataTransfer.effectAllowed="move";
  e.dataTransfer.setData("text/plain",id); // required for Firefox
  const el=e.target.closest(".tl-item");if(el)el.classList.add("dragging");
}
function dEnd(){dragId=null;document.querySelectorAll(".tl-item").forEach(el=>el.classList.remove("dragging","drag-over-top","drag-over-bottom"))}
function dOver(e,id){e.preventDefault();if(id===dragId)return;const r=e.currentTarget.getBoundingClientRect(),mid=r.top+r.height/2;e.currentTarget.classList.toggle("drag-over-top",e.clientY<mid);e.currentTarget.classList.toggle("drag-over-bottom",e.clientY>=mid)}
function dLeave(e){e.currentTarget.classList.remove("drag-over-top","drag-over-bottom")}

// ── Scheduling helpers ──

// Build meeting blocks array from INIT_SCHED (used by both cascade variants)
function _meetingBlocks(){
  return INIT_SCHED
    .filter(isMeeting)
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
    if(isMeeting(ev)) return;
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
    if(isMeeting(ev)){
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

  const active=scheduled.filter(ev=>!isDone(ev)&&!isDeleted(ev));
  if(!active.length)return;

  // Pass 1: place pinned/locked tasks at their pinned start and add them to the
  // blockers list alongside meetings. Locked tasks pin to their current start.
  const blockers=_meetingBlocks().slice();
  active.forEach(ev=>{
    if(isMeeting(ev))return;            // already represented in _meetingBlocks()
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
    if(isMeeting(ev)){
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

function dDrop(e,tid){
  e.preventDefault();
  if(!dragId)return;

  // External drag from the Tasks drawer backlog: add to schedule instead of reordering.
  if(window._dragFromBacklog){
    window._dragFromBacklog=false;
    const id=dragId; dragId=null;
    if(typeof addToSchedule==="function") addToSchedule(id);
    return;
  }

  if(dragId===tid)return;
  const old=JSON.stringify(scheduled);

  // Operate only on the active (undone) sublist -- these are the only draggable items
  const active=scheduled.filter(ev=>!isDone(ev));
  const fi=active.findIndex(x=>x.id===dragId);
  if(fi===-1)return;

  // Remove dragged item from active list
  const[moved]=active.splice(fi,1);

  // Find target in the (now shorter) active list and insert before/after
  const after=e.clientY>=e.currentTarget.getBoundingClientRect().top+e.currentTarget.getBoundingClientRect().height/2;
  const ti=active.findIndex(x=>x.id===tid);
  if(ti===-1)return;
  const insertIdx=after?ti+1:ti;
  active.splice(insertIdx,0,moved);

  // Write the reordered active items back into scheduled, preserving done-item slots
  let ai=0;
  for(let i=0;i<scheduled.length;i++){if(!isDone(scheduled[i]))scheduled[i]=active[ai++];}

  // Clear pinned start on the moved task so cascade places it at its new position.
  // Also drop the persisted pin so the drag effect survives reload.
  if(moved._pinnedStart){
    delete moved._pinnedStart;
    if(typeof loadPinnedStarts==="function"&&typeof savePinnedStarts==="function"){
      const pins=loadPinnedStarts();
      if(pins[moved.id]){delete pins[moved.id];savePinnedStarts(pins);}
    }
  }

  // Recascade all times from the first task's anchor
  recalcTimes();

  // If the moved item ended up further in the list than where it was dropped,
  // a meeting blocked it — show a friendly toast so the user knows why
  const sortedActive=scheduled.filter(ev=>!isDone(ev));
  const actualIdx=sortedActive.findIndex(x=>x.id===dragId);
  if(actualIdx>insertIdx){
    if(typeof showToast==='function')showToast("Not enough time allotted for that task — placed after the meeting.","warn",4000);
  }

  saveTaskOrder();
  // Sync blockstore added_task times after drag reorder
  if(typeof syncAddedTaskTimes==='function')syncAddedTaskTimes();

  log("reorder",dragId,old);
  document.querySelectorAll(".tl-item").forEach(el=>el.classList.remove("drag-over-top","drag-over-bottom"));
  render();
}

