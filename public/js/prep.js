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

function openPomodoro(title,durMin){
  if(_pomoCompleteHook){
    const {prevTitle, capturedStart} = _pomoCompleteHook;
    _pomoCompleteHook = null;
    if(capturedStart && prevTitle && prevTitle !== title){
      const elapsed = Math.round((Date.now() - capturedStart) / 1000);
      if(elapsed >= 60) pomoLogSession(prevTitle, elapsed, pomoState.mode);
    }
  }
  clearInterval(pomoState.iv);
  pomoState.title=title;pomoState.workMin=Math.min(durMin||25,120);pomoState.sessions=0;pomoState.taskDone=false;
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
  // Open floating timer panel
  document.getElementById("ft-panel").style.display="flex";
  document.getElementById("ft-fab").style.display="none";
  document.getElementById("ft-mini").style.display="none";
  pomoRenderReport();
  if(typeof paintPivotTasks==='function')paintPivotTasks();
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
  const task=scheduled.find(s=>s.title===pomoState.title && !s.nested);
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
    if(result === true){
      _pomoCompleteHook = { prevTitle: capturedTitle, capturedStart: capturedStart };
      openTaskPicker(capturedTitle);
    }
  };
  openTaskCompletionModal(capturedTitle);
});
// ⚡ Lightning complete — instant done + open picker
document.getElementById("pomo-task-lightning").addEventListener("click",(e)=>{
  e.stopPropagation();
  const task=scheduled.find(s=>s.title===pomoState.title && !s.nested);
  if(task) toggleDone(task.id);
  showToast("✓ "+pomoState.title+" completed");
  _pomoCompleteHook = { prevTitle: pomoState.title, capturedStart: pomoState.startedAt };
  openTaskPicker(pomoState.title);
});
// Note: Focus/Report sub-tabs removed — report is now a collapsible <details> in the floating panel

// +1 minute button
document.getElementById("pomo-add-min").addEventListener("click",()=>{
  pomoState.remaining+=60;pomoState.total+=60;pomoPaint();
});

// ======== FLOATING TIMER CONTROLS ========
document.getElementById("ft-fab").addEventListener("click",()=>{
  document.getElementById("ft-panel").style.display="flex";
  document.getElementById("ft-fab").style.display="none";
  document.getElementById("ft-mini").style.display="none";
});
document.getElementById("ft-panel-close").addEventListener("click",()=>{
  document.getElementById("ft-panel").style.display="none";
  if(pomoState.running){
    document.getElementById("ft-mini").style.display="flex";
    document.getElementById("ft-fab").style.display="none";
    pomoPaint(); // update mini bar
  } else {
    document.getElementById("ft-mini").style.display="none";
    document.getElementById("ft-fab").style.display="flex";
  }
});
document.getElementById("ft-mini").addEventListener("click",()=>{
  document.getElementById("ft-panel").style.display="flex";
  document.getElementById("ft-mini").style.display="none";
  document.getElementById("ft-fab").style.display="none";
});
document.getElementById("ft-mini-pause").addEventListener("click",(e)=>{
  e.stopPropagation(); // don't open panel
  document.getElementById("pomo-start").click(); // reuse existing start/pause logic
});
// Task card click opens picker
document.getElementById("pomo-task-card").addEventListener("click",()=>{
  openTaskPicker();
});

