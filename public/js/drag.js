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

// Recascade start/end times for all undone tasks, treating meetings as immovable blockers.
// Tasks flow around meetings -- if a task would overlap a meeting it gets pushed to after it.
// If a task finishes early (slot freed up), subsequent tasks pull earlier.
function recalcTimes(){
  const active=scheduled.filter(ev=>!isDone(ev));
  if(!active.length)return;

  // Anchor: first undone item's ORIGINAL start time -- stable regardless of drag order
  const firstOrig=INIT_SCHED.find(ev=>!isDone(ev));
  let cursor=firstOrig?pt(firstOrig.start):pt(active[0].start);

  // Use INIT_SCHED for meeting blocks so times are always their original fixed values
  const blocks=INIT_SCHED
    .filter(isMeeting)
    .map(ev=>({s:pt(ev.start),e:pt(ev.end)}))
    .sort((a,b)=>a.s-b.s);

  // Return the earliest start >= cursor where duration d fits without overlapping any meeting
  function freeStart(cursor,d){
    let s=cursor,changed=true;
    while(changed){
      changed=false;
      for(const b of blocks){
        if(s<b.e&&s+d>b.s){s=b.e;changed=true;}
      }
    }
    return s;
  }

  active.forEach(ev=>{
    if(isMeeting(ev)){
      cursor=Math.max(cursor,pt(ev.end));
      return;
    }
    const d=dur(ev);
    // Respect pinned start times
    if(ev._pinnedStart){
      const ps=pt(ev._pinnedStart);
      ev.start=ev._pinnedStart;ev.end=fmt(ps+d);
      cursor=Math.max(cursor,ps+d);
      return;
    }
    const s=freeStart(cursor,d);
    ev.start=fmt(s);ev.end=fmt(s+d);
    cursor=s+d;
  });

  // Re-sort scheduled by time so list order always matches clock order.
  // Tasks pushed past meetings will automatically appear after them in the list.
  scheduled.sort((a,b)=>pt(a.start)-pt(b.start));
}

function dDrop(e,tid){
  e.preventDefault();
  if(!dragId||dragId===tid)return;
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
  active.splice(after?ti+1:ti,0,moved);

  // Write the reordered active items back into scheduled, preserving done-item slots
  let ai=0;
  for(let i=0;i<scheduled.length;i++){if(!isDone(scheduled[i]))scheduled[i]=active[ai++];}

  // Recascade all times from the first task's anchor
  recalcTimes();
  saveTaskOrder();

  log("reorder",dragId,old);
  document.querySelectorAll(".tl-item").forEach(el=>el.classList.remove("drag-over-top","drag-over-bottom"));
  render();
}

