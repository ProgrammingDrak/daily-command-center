// ======== SCHEDULE POPOVER (shared) ========
// ONE anchored popover for every "put this task on a day" surface, so create
// and reschedule stay the same code from here on out:
//   mode "reschedule" — an existing scheduled task: day picks advance to the
//     shared placement step (moveTaskViaPlacement), duration ±15 applies
//     immediately, time pins the start on the current day.
//   Every day and time pick COMMITS on the pick itself -- the quick buttons,
//     the 📅 chip and the time wheel all behave the same way. There is no
//     separate confirm button; cfg.actionLabel is accepted for back-compat but
//     no longer renders anything.
//   mode "create"     — a task that doesn't exist yet (quick-add "Schedule…"
//     destination): duration and time are STAGED; picking a day commits —
//     with a time via commitScheduledTask, today-without-time via
//     insertTaskNow, a future day without a time as an untimed block that
//     lands in that day's Unscheduled section.
//   mode "pick"       — date-only contract for callers that resolve the pick
//     themselves (e.g. delegated follow-ups): onPick(dateStr) is awaited with
//     the buttons disabled.
// Task-level tools (delegate / repeat / subtask / backlog…) are NOT here —
// they live on the task-row radial menu (radial-menu.js consumers).

// Shared positioning for anchor-attached fixed popovers. Append hidden first so
// we can measure the real size, then clamp fully on-screen. A naive right-align
// (right = innerWidth - rect.right) pushed the popover -- and its left-most
// "Today" button -- off the left edge on narrow / mobile viewports, making those
// buttons unclickable.
function _positionPopoverNear(anchorEl,pop,opts){
  opts=opts||{};
  pop.style.minWidth=(opts.minWidth!=null?opts.minWidth:220)+"px";
  pop.style.visibility="hidden";
  document.body.appendChild(pop);
  const rect=anchorEl.getBoundingClientRect();
  const margin=8;
  const popW=pop.offsetWidth||220;
  const popH=pop.offsetHeight||0;
  let left=rect.right-popW; // prefer right-aligned to the button
  left=Math.max(margin,Math.min(left,window.innerWidth-popW-margin));
  let top=rect.bottom+6;
  if(top+popH>window.innerHeight-margin){
    // No room below -- prefer flipping above the anchor.
    const above=rect.top-popH-6;
    if(above>=margin)top=above;
  }
  // Final clamp so the popover is always fully within the viewport, even if the
  // anchor is partially scrolled off-screen.
  top=Math.max(margin,Math.min(top,window.innerHeight-popH-margin));
  pop.style.left=left+"px";
  pop.style.top=top+"px";
  pop.style.right="auto";
  pop.style.visibility="";
}

function openSchedulePopover(cfg){
  cfg=cfg||{};
  const mode=cfg.mode||"reschedule";
  // view splits the reschedule popover into two triggers: the calendar icon
  // opens "date" (quick days + date picker), clicking the time opens "time"
  // (duration + start-time). "both" keeps the combined popover for other callers.
  const view=cfg.view||"both";
  const showDate=view!=="time";
  const showTime=view!=="date";
  const anchorEl=cfg.anchorEl;
  if(!anchorEl)return;

  let ev=null;
  if(mode==="reschedule"){
    ev=scheduled.find(e=>e.id===cfg.id);
    if(!ev)return;
  }

  // Close any existing popovers
  document.querySelectorAll(".resched-popover,.dur-popover").forEach(p=>p.remove());
  document.querySelectorAll(".has-dur-popover").forEach(x=>x.classList.remove("has-dur-popover"));
  document.body.classList.remove("dur-open");

  const today=(typeof _actualTodayStr==="function")?_actualTodayStr():null;
  const options=cfg.options||{};
  // Create mode stages duration + time; commits read them.
  let stagedDur=cfg.durMin||30;

  const header=
    view==="time"?('Set the time for "'+escHtml(ev.title)+'"'):
    mode==="reschedule"?('Move "'+escHtml(ev.title)+'" to…'):
    mode==="create"?('Schedule "'+escHtml(cfg.title)+'" for…'):
    escHtml(cfg.header||"Schedule for…");
  const pop=document.createElement("div");
  pop.className="dur-popover resched-popover";
  // Both quick buttons stay enabled. When the task is already on the day you're
  // viewing, the placement step re-slots it instead of no-opping, so the button
  // is never a dead end. (A disabled button reads as "broken".)
  pop.innerHTML=
    '<div class="resched-header">'+header+'</div>'+
    (showDate?(
    '<div class="resched-quick">'+
      '<button class="resched-btn" data-target="today">Today</button>'+
      '<button class="resched-btn" data-target="tomorrow">Tomorrow</button>'+
    '</div>'+
    // time-picker.js auto-enhances this input into the 📅 chip (the input
    // itself goes type="hidden" and keeps the value). Picking a day COMMITS --
    // same as Today / Tomorrow -- so there is no second confirm button to hunt
    // for. The chip's own label is the picker's "Pick a date" placeholder,
    // matching the placement modal's chip (index.html #sched-pick-date-btn).
    '<div class="resched-custom">'+
      '<input type="date" class="resched-date-input" />'+
    '</div>'):'')+
    ((showTime&&mode!=="pick")?(
    '<div class="resched-adjust">'+
      '<div class="resched-dur">'+
        '<button class="resched-dur-btn" type="button" data-d="-15" title="Shorter" aria-label="Decrease duration">&minus;</button>'+
        '<span class="resched-dur-label" role="status" aria-live="polite"></span>'+
        '<button class="resched-dur-btn" type="button" data-d="15" title="Longer" aria-label="Increase duration">+</button>'+
      '</div>'+
      '<div class="resched-time">'+
        '<input type="time" class="resched-time-input" />'+
      '</div>'+
    '</div>'):'')+
    // Pick mode normally hides time; allowTime opts a bare time input in (no dur
    // stepper) so callers like the recap action scheduler can pin an optional start.
    ((mode==="pick"&&cfg.allowTime)?(
    '<div class="resched-adjust resched-time-only">'+
      '<div class="resched-time"><input type="time" class="resched-time-input" /></div>'+
    '</div>'):'');

  function closePop(){
    pop.remove();
    document.removeEventListener("click",onOutside,true);
    document.removeEventListener("keydown",onKey,true);
  }
  // The date / time chips open time-picker.js's overlay, which lives in <body>
  // -- a SIBLING of this popover. Both listeners below are capture-phase on
  // document, so they fire BEFORE the calendar's own day-cell handler: without
  // the guard, clicking a day removed this popover first and the pick then
  // landed on a detached input (calendar closed, nothing moved). The shared
  // controller owns the rule: DCC.overlay.eventInLayerAbove (core-ui.js).
  function _inPickerLayer(e){
    return !!(window.DCC&&window.DCC.overlay&&typeof window.DCC.overlay.eventInLayerAbove==="function"
      &&window.DCC.overlay.eventInLayerAbove(e));
  }
  function _pickerLayerOpen(){
    return !!(window.DCC&&window.DCC.overlay&&typeof window.DCC.overlay.layerAboveOpen==="function"
      &&window.DCC.overlay.layerAboveOpen());
  }
  function onOutside(e){
    if(pop.contains(e.target)||e.target===anchorEl)return;
    if(_inPickerLayer(e))return;
    closePop();
  }
  // Escape belongs to the topmost layer: the first one closes the calendar (the
  // picker's own handler), a second one closes this popover.
  function onKey(e){if(e.key==="Escape"&&!_pickerLayerOpen())closePop()}

  const timeInput=pop.querySelector(".resched-time-input");

  // Resolve a picked day per mode. Reschedule advances to the shared placement
  // step; create commits the new task; pick hands the date to the caller.
  async function pickDay(dateStr){
    if(mode==="reschedule"){
      closePop();
      moveTaskViaPlacement(cfg.id,dateStr);
      return;
    }
    if(mode==="pick"){
      const pickTime=(cfg.allowTime&&timeInput&&/^\d{2}:\d{2}$/.test(timeInput.value))?timeInput.value:null;
      pop.querySelectorAll("button").forEach(b=>{b.disabled=true;});
      try{
        if(typeof cfg.onPick==="function")await cfg.onPick(dateStr,pickTime);
      }finally{
        closePop();
      }
      return;
    }
    // create
    const timeStr=(timeInput&&/^\d{2}:\d{2}$/.test(timeInput.value))?timeInput.value:null;
    closePop();
    const currentDate=(typeof viewDate!=="undefined"&&viewDate)?viewDate:((typeof __state!=="undefined"&&__state&&__state.date)?__state.date:null);
    if(timeStr){
      commitScheduledTask(cfg.title,stagedDur,dateStr,timeStr,options);
    }else if(dateStr===currentDate){
      insertTaskNow(cfg.title,stagedDur,options);
    }else{
      // No time on another day: an untimed block that surfaces in that day's
      // Unscheduled section and gets a slot when the day is planned.
      const item=Object.assign({id:qaId(),title:cfg.title,type:"task",durMin:stagedDur},
        schedulePickerFields(stagedDur,options));
      persistAddedTask(item,dateStr);
      log("scheduled",item.id,"Scheduled for "+dateStr+" (unscheduled): "+cfg.title);
      if(typeof showToast==="function")showToast("Added to "+(typeof _prettyDateLabel==="function"?_prettyDateLabel(dateStr):dateStr)+" (unscheduled)","success");
      if(typeof options.onScheduled==="function"){
        try{options.onScheduled({localId:item.id,blockId:item.id,start:null,dateStr});}catch(e){}
      }
    }
    if(typeof cfg.onCommitted==="function"){try{cfg.onCommitted()}catch(e){}}
  }

  pop.querySelectorAll(".resched-btn").forEach(btn=>{
    btn.addEventListener("click",e=>{
      e.stopPropagation();
      const target=btn.dataset.target;
      const dateStr=target==="today"
        ?(mode==="reschedule"?today:(typeof _resolvedTodayDate==="function"?_resolvedTodayDate():today))
        :(mode==="reschedule"?__tomorrowDate:(typeof _resolvedTomorrowDate==="function"?_resolvedTomorrowDate():__tomorrowDate));
      if(!dateStr){if(typeof showToast==="function")showToast("No date available","error");return}
      if(mode==="pick")btn.textContent="Scheduling...";
      pickDay(dateStr);
    });
  });

  // Custom date (present only when the date section is shown). No value seed:
  // the chip reads "Pick a date" instead of showing a day nobody chose.
  //
  // One listener, both worlds: the enhanced chip writes the day and fires
  // `change` (time-picker.js), and a bare <input type="date"> fires the same
  // event if time-picker.js is ever absent. Same wiring the placement modal
  // already uses for its own date step (schedule.js #sched-date-input).
  const dateInput=pop.querySelector(".resched-date-input");
  if(dateInput){
    dateInput.addEventListener("change",()=>{
      const v=dateInput.value;
      if(!v||!/^\d{4}-\d{2}-\d{2}$/.test(v)){if(typeof showToast==="function")showToast("Pick a valid date","error");return}
      // Pick mode owns the write and can be slow; say so on the chip, exactly
      // like the quick buttons do.
      if(mode==="pick"){const chip=pop.querySelector(".tw-field-date");if(chip)chip.textContent="Scheduling...";}
      pickDay(v);
    });
  }

  if(showTime&&mode!=="pick"){
    // Duration: same ±15 stepper as the card's -/+ buttons, label updates in
    // place. Reschedule applies immediately; create stages the value.
    const durLabel=pop.querySelector(".resched-dur-label");
    const refreshDurLabel=()=>{
      if(!durLabel)return;
      if(mode==="reschedule"){
        const cur=scheduled.find(e=>e.id===cfg.id);
        if(cur)durLabel.textContent=ms(dur(cur));
      }else{
        durLabel.textContent=ms(stagedDur);
      }
    };
    refreshDurLabel();
    pop.querySelectorAll(".resched-dur-btn").forEach(btn=>{
      btn.addEventListener("click",e=>{
        e.stopPropagation();
        const d=parseInt(btn.dataset.d,10);
        if(mode==="reschedule"){
          if(typeof adjustDur==="function")adjustDur(cfg.id,d);
        }else{
          stagedDur=stepDuration(stagedDur,d,{min:15});
        }
        refreshDurLabel();
      });
    });
    if(mode==="reschedule"&&timeInput){
      // Time: pin the start to a chosen time on the current day (no date
      // change). The wheel already has its own Set button, so a second one here
      // was one click too many -- and the same nested-layer bug meant the pick
      // never reached it. Seeding the value first is safe: a programmatic
      // assignment does not fire `change`.
      timeInput.value=ev.start||"";
      timeInput.addEventListener("change",()=>{
        const v=timeInput.value;
        if(!v||!/^\d{2}:\d{2}$/.test(v)){if(typeof showToast==="function")showToast("Pick a valid time","error");return}
        closePop();
        if(typeof pinStartTime==="function")pinStartTime(cfg.id,v);
        if(typeof syncAddedTaskTimes==="function")syncAddedTaskTimes();
        if(typeof showToast==="function")showToast("Start pinned to "+(typeof f12==="function"?f12(v):v),"success");
      });
    }
    // Create mode: the time input is read at day-pick time — no button, staging
    // silently saves a click.
  }

  _positionPopoverNear(anchorEl,pop);
  setTimeout(()=>document.addEventListener("click",onOutside,true),0);
  document.addEventListener("keydown",onKey,true);
}

// Thin same-signature wrappers so existing callers keep working.
// Click the per-card actions trigger → "Schedule…" spoke to open this.
function openReschedulePopover(id,anchorEl){
  openSchedulePopover({mode:"reschedule",id,anchorEl});
}
// Generic "pick a day" popover for callers that create a task rather than move
// one (e.g. delegated follow-ups). opts: {header, actionLabel, allowTime,
// onPick(dateStr, timeStr)}. With allowTime, a bare time input is shown and its
// HH:MM (or null) is passed as the second onPick arg. The day pick itself
// commits, so actionLabel is inert (kept so existing callers need no edit).
function openDatePickPopover(anchorEl,opts){
  opts=opts||{};
  openSchedulePopover({mode:"pick",anchorEl,header:opts.header,actionLabel:opts.actionLabel,allowTime:opts.allowTime,onPick:opts.onPick});
}

window.openSchedulePopover=openSchedulePopover;
window.openReschedulePopover=openReschedulePopover;
window.openDatePickPopover=openDatePickPopover;
