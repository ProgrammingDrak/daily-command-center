let _pomoCompleteHook = null; // { prevTitle, capturedStart } — set by ✓, consumed by openPomodoro

// ======== PREP VIEWER ========
// Embedded prep content registry -- keyed by filename
const PREP_REGISTRY={};
function registerPrep(key,htmlContent){PREP_REGISTRY[key]=htmlContent}
// Bridge injected prep files into the registry (keyed by filename AND by meeting-prep/filename path)
if(window.__PREP_FILES__){Object.entries(window.__PREP_FILES__).forEach(([k,v])=>{PREP_REGISTRY[k]=v;PREP_REGISTRY["meeting-prep/"+k]=v})}
function openPrepViewer(href,title){
  const body=document.getElementById("prep-viewer-body");
  const titleEl=document.getElementById("prep-viewer-title");
  titleEl.textContent=title||'Document';
  console.log("[PrepViewer] Looking up:",JSON.stringify(href));
  console.log("[PrepViewer] Registry keys:",Object.keys(PREP_REGISTRY));
  console.log("[PrepViewer] Match?",!!PREP_REGISTRY[href]);
  const content=PREP_REGISTRY[href];
  if(content){body.innerHTML=content}else{body.innerHTML='<div style="text-align:center;padding:60px;color:var(--text-muted)">No embedded content found for: '+href+'<br><br><small>Registry has '+Object.keys(PREP_REGISTRY).length+' entries: '+Object.keys(PREP_REGISTRY).join(", ")+'</small></div>'}
  document.getElementById("prep-viewer-overlay").classList.add("open");
  document.getElementById("prep-float").style.display="none";
}
function closePrepViewer(){
  document.getElementById("prep-viewer-overlay").classList.remove("open");
  document.getElementById("prep-viewer-body").innerHTML="";
}
document.getElementById("prep-viewer-close").addEventListener("click",closePrepViewer);
document.getElementById("prep-viewer-overlay").addEventListener("click",e=>{if(e.target===e.currentTarget)closePrepViewer()});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&document.getElementById("prep-viewer-overlay").classList.contains("open"))closePrepViewer()});

// Modal close handlers
document.getElementById("completion-modal-close").addEventListener("click",closeCompletionModal);
document.getElementById("task-completion-modal-overlay").addEventListener("click",e=>{if(e.target===e.currentTarget)closeCompletionModal()});
document.getElementById("untasked-modal-close").addEventListener("click",closeUntaskedModal);
document.getElementById("untasked-modal-overlay").addEventListener("click",e=>{if(e.target===e.currentTarget)closeUntaskedModal()});
document.addEventListener("keydown",e=>{
  if(e.key==="Escape"){
    if(document.getElementById("task-completion-modal-overlay").classList.contains("open"))closeCompletionModal();
    if(document.getElementById("untasked-modal-overlay").classList.contains("open"))closeUntaskedModal();
  }
});

function openPomodoro(title,durMin,taskRef){
  const requestedRef=taskRef||{title:title,source:"custom"};
  const resolved=resolvePomoTaskRef(requestedRef,{allowCustom:true,defaultDurMin:durMin||25});
  if(resolved){
    title=resolved.title;
    durMin=durMin||resolved.durMin;
    taskRef=resolved.ref;
  }else{
    taskRef={id:"",source:"custom",title:title};
  }
  // Capture previous session state for mid-switch logging and time carry-over
  const prevTitle = pomoState.title;
  const prevStartedAt = pomoState.startedAt;
  const prevRemaining = pomoState.remaining;
  const prevTotal = pomoState.total;
  const prevMode = pomoState.mode;
  const wasRunning = pomoState.running;
  const isSwitch = wasRunning && prevTitle && prevTitle !== title && prevMode === "work";

  if(_pomoCompleteHook){
    const {prevTitle: hookPrev, capturedStart} = _pomoCompleteHook;
    _pomoCompleteHook = null;
    if(capturedStart && hookPrev && hookPrev !== title){
      const elapsed = Math.round((Date.now() - capturedStart) / 1000);
      if(elapsed >= 60) pomoLogSession(hookPrev, elapsed, pomoState.mode);
    }
  } else if(isSwitch && prevStartedAt){
    // Direct task switch mid-timer: log elapsed time on previous task
    const elapsed = Math.round((Date.now() - prevStartedAt) / 1000);
    if(elapsed >= 60) pomoLogSession(prevTitle, elapsed, prevMode);
  }
  clearInterval(pomoState.iv);
  pomoState.title=title;pomoState.currentTaskRef=taskRef;pomoState.workMin=Math.min(durMin||25,120);pomoState.sessions=0;pomoState.taskDone=false;
  document.querySelectorAll(".pomo-dot").forEach(d=>d.className="pomo-dot");
  document.getElementById("pomo-empty").style.display="none";
  document.getElementById("pomo-active").style.display="block";
  document.getElementById("pomo-title").textContent=title;
  // Reset task check
  const chk=document.getElementById("pomo-task-check");if(chk)chk.classList.remove("on");
  // Update mode button labels
  const modeWork=document.querySelector('.pomo-mode[data-pm="work"]');
  if(modeWork)modeWork.textContent="Focus ("+pomoState.workMin+"m)";
  pomoSetMode("work");
  // Carry over remaining time from previous task switch (continue the focus block)
  if(isSwitch && prevRemaining > 0){
    pomoState.remaining = prevRemaining;
    pomoState.total = prevTotal;
    pomoPaint();
  }
  // Open floating timer panel (minimizing later defaults back to the live pill)
  pomoState.collapsedView="mini";
  ftSetView("panel");
  pomoRenderReport();
  if(typeof paintPivotTasks==='function')paintPivotTasks();
  if(typeof updateFocusBanner==='function')updateFocusBanner();
  // Auto-start the timer
  pomoState.iv=setInterval(pomoTick,1000);
  pomoState.running=true;
  pomoState.startedAt=Date.now();
  pomoUpdateStartBtn();
  updateTimerBadge();
  savePomoState();
}

// Wire up timer controls
document.getElementById("pomo-start").addEventListener("click",()=>{
  if(pomoState.running){
    clearInterval(pomoState.iv);pomoState.running=false;
    if(pomoState.startedAt&&pomoState.mode==="work"){
      const elapsed=Math.round((Date.now()-pomoState.startedAt)/1000);
      if(elapsed>=60)pomoLogSession(pomoState.title,elapsed,pomoState.mode);
    }
    pomoState.startedAt=null;
  }else{
    pomoState.iv=setInterval(pomoTick,1000);pomoState.running=true;pomoState.startedAt=Date.now();
  }
  pomoUpdateStartBtn();updateTimerBadge();savePomoState();
});
document.getElementById("pomo-stop").addEventListener("click",()=>{
  // Log elapsed focus time before resetting
  if(pomoState.startedAt && pomoState.mode==="work"){
    const elapsed=Math.round((Date.now()-pomoState.startedAt)/1000);
    if(elapsed>=60) pomoLogSession(pomoState.title,elapsed,pomoState.mode);
  }
  clearInterval(pomoState.iv); pomoState.running=false; pomoState.startedAt=null;
  pomoSetMode(pomoState.mode); updateTimerBadge(); savePomoState();
  document.getElementById("pomo-stop-q").textContent='Done with "'+pomoState.title+'"?';
  document.getElementById("pomo-secondary").style.display="none";
  document.getElementById("pomo-stop-confirm").style.display="block";
});
document.getElementById("pomo-stop-yes").addEventListener("click",()=>{
  const current=getCurrentPomoTask();
  const task=current&&current.source==="schedule"?current.task:scheduled.find(s=>s.title===pomoState.title && !s.nested);
  if(task) toggleDone(task.id);
  showToast("✓ "+pomoState.title+" completed");
  document.getElementById("pomo-stop-confirm").style.display="none";
  document.getElementById("pomo-secondary").style.display="flex";
});
document.getElementById("pomo-stop-no").addEventListener("click",()=>{
  document.getElementById("pomo-stop-confirm").style.display="none";
  document.getElementById("pomo-secondary").style.display="flex";
});
// "I got distracted" button + modal handlers (timer keeps running)
document.getElementById("pomo-distracted").addEventListener("click",()=>{
  openDistractionModal(pomoState.startedAt);
});

function closeDistractionModal(){ document.getElementById("distraction-modal-overlay").classList.remove("open"); }
function addDistractionToItinerary(title,mins,classify){
  if(!title||!mins)return null;
  const scheduleType=classify==="focus"?"focus":"break";
  const endMin=(typeof now==="function"?now():(new Date().getHours()*60+new Date().getMinutes()));
  const startMin=Math.max(0,endMin-mins);
  const id="distraction-"+Date.now()+"-"+Math.random().toString(36).slice(2,6);
  const label=scheduleType==="break"?"Break":"Focus";
  const item={
    id,
    title,
    type:scheduleType,
    start:fmt(startMin),
    end:fmt(endMin),
    meta:"Logged "+label.toLowerCase()+" · "+ms(mins),
    detail:"Captured from I got distracted.",
    source:"timer-log",
    priority:"Low",
    tags:[],
    _pinnedStart:fmt(startMin)
  };
  if(typeof scheduled!=="undefined"&&Array.isArray(scheduled)){
    const insertAt=scheduled.findIndex(ev=>pt(ev.start)>startMin);
    if(insertAt===-1)scheduled.push(item);
    else scheduled.splice(insertAt,0,item);
  }
  if(typeof persistAddedTask==="function")persistAddedTask(item);
  if(typeof manualDone!=="undefined"&&manualDone&&typeof manualDone.add==="function"){
    manualDone.add(id);
    doneAt[id]=new Date();
    if(typeof saveDoneState==="function")saveDoneState();
  }
  if(typeof log==="function")log("distraction-log",id,label+": "+title);
  if(typeof render==="function")render();
  return item;
}
function logDistraction(){
  // 1. Log the focused work time accumulated so far (timer is still running)
  if(pomoState.startedAt && pomoState.mode==="work"){
    const focusSec = Math.round((Date.now()-pomoState.startedAt)/1000);
    if(focusSec >= 60) pomoLogSession(pomoState.title, focusSec, "work");
    pomoState.startedAt = Date.now(); // reset so timer continues fresh
  }
  _distractionCapturedStart = null;
  // 2. Log the distraction itself
  const noteInput = document.getElementById("distraction-note").value.trim();
  const selectedTask = document.querySelector(".distraction-task-item.selected");
  const title = selectedTask
    ? selectedTask.dataset.title
    : (noteInput || "Distraction");
  const mins = parseInt(document.getElementById("distraction-mins").value) || 5;
  const classify = document.querySelector(".distraction-classify-btn.active")?.dataset.classify || "break";
  const type = classify === "focus" ? "work" : "distraction";
  const prefix = type === "work" ? "" : "[Distracted] ";
  addDistractionToItinerary(title,mins,classify);
  pomoState.sessionLog.unshift({
    title: prefix + title,
    durSec: mins * 60,
    type: type,
    time: new Date().toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"})
  });
  if(type === "work"){
    pomoState.taskTime[title] = (pomoState.taskTime[title]||0) + (mins*60);
  }
  pomoRenderReport(); savePomoState();
}

document.getElementById("distraction-modal-close").addEventListener("click",closeDistractionModal);
document.getElementById("distraction-cancel").addEventListener("click",closeDistractionModal);
document.getElementById("distraction-log-resume").addEventListener("click",()=>{
  logDistraction(); closeDistractionModal();
  // Timer is still running — just save state
  savePomoState();
});
document.getElementById("distraction-log-stop").addEventListener("click",()=>{
  logDistraction();
  // NOW stop the timer
  clearInterval(pomoState.iv); pomoState.running=false; pomoState.startedAt=null;
  pomoUpdateStartBtn(); updateTimerBadge(); savePomoState();
  closeDistractionModal();
});
// Classify toggle
document.querySelectorAll(".distraction-classify-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".distraction-classify-btn").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
  });
});
// Clear task selection when typing in note
document.getElementById("distraction-note").addEventListener("input", () => {
  document.querySelectorAll(".distraction-task-item.selected").forEach(e=>e.classList.remove("selected"));
});
document.getElementById("pomo-skip").addEventListener("click",()=>{
  clearInterval(pomoState.iv);pomoState.running=false;pomoState.remaining=0;pomoState.startedAt=null;pomoTick();updateTimerBadge();savePomoState();
});
document.querySelectorAll(".pomo-mode").forEach(b=>b.addEventListener("click",()=>pomoSetMode(b.dataset.pm)));
document.getElementById("pomo-sound").addEventListener("click",()=>{
  pomoState.soundOn=!pomoState.soundOn;
  document.getElementById("pomo-sound").textContent="Sound: "+(pomoState.soundOn?"On":"Off");
  savePomoState();
});
// Task check — opens completion modal, then picker on confirm
document.getElementById("pomo-task-check").addEventListener("click",(e)=>{
  e.stopPropagation();
  const capturedTitle = pomoState.title;
  const capturedStart = pomoState.startedAt;
  _completionModalCallback = (result) => {
    if(result && result.completed === true && result.startNext === true){
      _pomoCompleteHook = { prevTitle: capturedTitle, capturedStart: capturedStart };
      openTaskPicker(capturedTitle);
    }
  };
  openTaskCompletionModal(capturedTitle);
});
// ⚡ Lightning complete — instant done, no forced task switch
document.getElementById("pomo-task-lightning").addEventListener("click",(e)=>{
  e.stopPropagation();
  const current=getCurrentPomoTask();
  const task=current&&current.source==="schedule"?current.task:scheduled.find(s=>s.title===pomoState.title && !s.nested);
  if(task) toggleDone(task.id);
  showToast("✓ "+pomoState.title+" completed");
});
// Note: Focus/Report sub-tabs removed — report is now a collapsible <details> in the floating panel

// +1 minute button
document.getElementById("pomo-add-min").addEventListener("click",()=>{
  pomoState.remaining+=60;pomoState.total+=60;pomoPaint();
});

// Reset button — log elapsed work, then restart full duration for the current task
document.getElementById("pomo-reset").addEventListener("click",()=>{
  if(pomoState.startedAt && pomoState.mode==="work"){
    const elapsed=Math.round((Date.now()-pomoState.startedAt)/1000);
    if(elapsed>=60) pomoLogSession(pomoState.title,elapsed,pomoState.mode);
  }
  const durations={work:pomoState.workMin*60,short:5*60,long:15*60};
  pomoState.total=durations[pomoState.mode]||pomoState.workMin*60;
  pomoState.remaining=pomoState.total;
  if(pomoState.running) pomoState.startedAt=Date.now();
  pomoPaint();savePomoState();
});

// ======== FLOATING TIMER CONTROLS ========
// (The old #ft-fab resting button is gone; the bottom-right "+" launcher opens the
// panel via window.dccOpenTimer. See launcher.js + timer.js.)
// Minimize (–): collapse to the live pill, which stays put while running OR paused.
document.getElementById("ft-panel-min").addEventListener("click",()=>{
  pomoState.collapsedView="mini";
  ftSetView(pomoHasTask()?"mini":"hidden");
  savePomoState();
});
// Close (×): stash the timer fully away. collapsedView stays "fab" as the
// "don't auto-promote to the pill" flag; the resolved view is now "hidden".
document.getElementById("ft-panel-close").addEventListener("click",()=>{
  pomoState.collapsedView="fab";
  ftSetView("hidden");
  savePomoState();
});
document.getElementById("ft-mini").addEventListener("click",()=>{
  pomoState.collapsedView="mini";
  ftSetView("panel");
});
document.getElementById("ft-mini-pause").addEventListener("click",(e)=>{
  e.stopPropagation(); // don't open panel
  document.getElementById("pomo-start").click(); // reuse existing start/pause logic
});
// Task card click opens picker
document.getElementById("pomo-task-card").addEventListener("click",(e)=>{
  if(e.target.closest("#pomo-task-check,#pomo-task-lightning,button,a,input,select,textarea"))return;
  openTaskPicker();
});

