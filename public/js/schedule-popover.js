// ======== SCHEDULE POPOVER (shared) ========
// ONE anchored popover for every "put this task on a day" surface, so create
// and reschedule stay the same code from here on out:
//   mode "reschedule" — an existing scheduled task: day picks advance to the
//     shared placement step (moveTaskViaPlacement), duration ±15 applies
//     immediately, time pins the start on the current day.
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
function _positionPopoverNear(anchorEl,pop){
  pop.style.minWidth="220px";
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

function _schedPopEsc(s){
  return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");
}

function openSchedulePopover(cfg){
  cfg=cfg||{};
  const mode=cfg.mode||"reschedule";
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
    mode==="reschedule"?('Move "'+_schedPopEsc(ev.title)+'" to…'):
    mode==="create"?('Schedule "'+_schedPopEsc(cfg.title)+'" for…'):
    _schedPopEsc(cfg.header||"Schedule for…");
  const goLabel=
    mode==="reschedule"?"Move":
    mode==="create"?"Schedule":
    _schedPopEsc(cfg.actionLabel||"Go");

  const pop=document.createElement("div");
  pop.className="dur-popover resched-popover";
  // Both quick buttons stay enabled. When the task is already on the day you're
  // viewing, the placement step re-slots it instead of no-opping, so the button
  // is never a dead end. (A disabled button reads as "broken".)
  pop.innerHTML=
    '<div class="resched-header">'+header+'</div>'+
    '<div class="resched-quick">'+
      '<button class="resched-btn" data-target="today">Today</button>'+
      '<button class="resched-btn" data-target="tomorrow">Tomorrow</button>'+
    '</div>'+
    '<div class="resched-custom">'+
      '<input type="date" class="resched-date-input" />'+
      '<button class="resched-go">'+goLabel+'</button>'+
    '</div>'+
    (mode==="pick"?'':(
    '<div class="resched-adjust">'+
      '<div class="resched-dur">'+
        '<button class="resched-dur-btn" type="button" data-d="-15" title="15 min shorter">&minus;</button>'+
        '<span class="resched-dur-label"></span>'+
        '<button class="resched-dur-btn" type="button" data-d="15" title="15 min longer">+</button>'+
      '</div>'+
      '<div class="resched-time">'+
        '<input type="time" class="resched-time-input" />'+
        (mode==="reschedule"?'<button class="resched-time-go" type="button">Set time</button>':'')+
      '</div>'+
    '</div>'));

  function closePop(){
    pop.remove();
    document.removeEventListener("click",onOutside,true);
    document.removeEventListener("keydown",onKey,true);
  }
  function onOutside(e){if(!pop.contains(e.target)&&e.target!==anchorEl)closePop()}
  function onKey(e){if(e.key==="Escape")closePop()}

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
      pop.querySelectorAll("button").forEach(b=>{b.disabled=true;});
      try{
        if(typeof cfg.onPick==="function")await cfg.onPick(dateStr);
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

  // Custom date
  const dateInput=pop.querySelector(".resched-date-input");
  // Default to two days out (or tomorrow's tomorrow) so it differs from the quick buttons
  const seed=new Date();seed.setDate(seed.getDate()+2);
  const pad=n=>String(n).padStart(2,"0");
  dateInput.value=seed.getFullYear()+"-"+pad(seed.getMonth()+1)+"-"+pad(seed.getDate());
  pop.querySelector(".resched-go").addEventListener("click",e=>{
    e.stopPropagation();
    const v=dateInput.value;
    if(!v||!/^\d{4}-\d{2}-\d{2}$/.test(v)){if(typeof showToast==="function")showToast("Pick a valid date","error");return}
    pickDay(v);
  });
  dateInput.addEventListener("keydown",e=>{
    if(e.key==="Enter"){e.preventDefault();pop.querySelector(".resched-go").click()}
  });

  if(mode!=="pick"){
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
          stagedDur=Math.max(15,stagedDur+d);
        }
        refreshDurLabel();
      });
    });
    if(mode==="reschedule"){
      // Time: pin the start to a chosen time on the current day (no date change).
      if(timeInput)timeInput.value=ev.start||"";
      pop.querySelector(".resched-time-go").addEventListener("click",e=>{
        e.stopPropagation();
        const v=timeInput?timeInput.value:"";
        if(!v||!/^\d{2}:\d{2}$/.test(v)){if(typeof showToast==="function")showToast("Pick a valid time","error");return}
        closePop();
        if(typeof pinStartTime==="function")pinStartTime(cfg.id,v);
        if(typeof syncAddedTaskTimes==="function")syncAddedTaskTimes();
        if(typeof showToast==="function")showToast("Start pinned to "+(typeof f12==="function"?f12(v):v),"success");
      });
      timeInput&&timeInput.addEventListener("keydown",e=>{
        if(e.key==="Enter"){e.preventDefault();pop.querySelector(".resched-time-go").click()}
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
// one (e.g. delegated follow-ups). opts: {header, actionLabel, onPick(dateStr)}.
function openDatePickPopover(anchorEl,opts){
  opts=opts||{};
  openSchedulePopover({mode:"pick",anchorEl,header:opts.header,actionLabel:opts.actionLabel,onPick:opts.onPick});
}

window.openSchedulePopover=openSchedulePopover;
window.openReschedulePopover=openReschedulePopover;
window.openDatePickPopover=openDatePickPopover;
