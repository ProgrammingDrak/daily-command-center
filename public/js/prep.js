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
  // Switch to Timer tab, Focus sub-tab
  document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach(c=>c.classList.remove("active"));
  document.getElementById("timer-tab-btn").classList.add("active");
  document.getElementById("tab-timer").classList.add("active");
  document.querySelectorAll(".pomo-sub-tab").forEach(t=>t.classList.toggle("active",t.dataset.psub==="focus"));
  document.querySelectorAll(".pomo-sub-content").forEach(c=>c.classList.remove("active"));
  document.getElementById("psub-focus").classList.add("active");
  pomoRenderReport();buildMiniSchedule();buildSideConsider();buildSideBacklog();buildSideDone();
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
document.getElementById("pomo-reset").addEventListener("click",()=>{
  clearInterval(pomoState.iv);pomoState.running=false;pomoState.startedAt=null;
  pomoSetMode(pomoState.mode);updateTimerBadge();savePomoState();
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
// Task check on focus tab
document.getElementById("pomo-task-check").addEventListener("click",()=>{
  openTaskCompletionModal(pomoState.title);
});
// Sub-tab switching
document.querySelectorAll(".pomo-sub-tab").forEach(tab=>{
  tab.addEventListener("click",()=>{
    document.querySelectorAll(".pomo-sub-tab").forEach(t=>t.classList.remove("active"));
    document.querySelectorAll(".pomo-sub-content").forEach(c=>c.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("psub-"+tab.dataset.psub).classList.add("active");
    if(tab.dataset.psub==="report")pomoRenderReport();
  });
});

// +1 minute button
document.getElementById("pomo-add-min").addEventListener("click",()=>{
  pomoState.remaining+=60;pomoState.total+=60;pomoPaint();
});

