// ======== POMODORO TIMER ========
const pomoSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3L2 6"/><path d="M22 6l-3-3"/></svg>';
// Dashed ring: circumference of r=54 is ~339.29. We use stroke-dasharray for tick marks.
const POMO_C=2*Math.PI*54;
// Each tick segment = 5.65 on, 2.83 gap. Total ticks ~ 40.
const POMO_SEG=5.65,POMO_GAP=2.83,POMO_UNIT=POMO_SEG+POMO_GAP;
let pomoState={title:"",workMin:25,mode:"work",total:25*60,remaining:25*60,running:false,iv:null,sessions:0,soundOn:true,sessionLog:[],taskTime:{},startedAt:null,taskDone:false,stackedSessions:{}};

function pomoBeep(){
  if(!pomoState.soundOn)return;
  try{const ac=new(window.AudioContext||window.webkitAudioContext)(),o=ac.createOscillator(),g=ac.createGain();
  o.connect(g);g.connect(ac.destination);o.frequency.value=pomoState.mode==="work"?880:660;g.gain.value=0.3;o.start();o.stop(ac.currentTime+0.15);
  setTimeout(()=>{const o2=ac.createOscillator(),g2=ac.createGain();o2.connect(g2);g2.connect(ac.destination);o2.frequency.value=pomoState.mode==="work"?1046:784;g2.gain.value=0.3;o2.start();o2.stop(ac.currentTime+0.2)},200)}catch(e){}
}
function pomoFmt(s){const m=Math.floor(s/60),sec=s%60;return String(m).padStart(2,"0")+":"+String(sec).padStart(2,"0")}
function pomoPaint(){
  const arc=document.getElementById("pomo-arc"),disp=document.getElementById("pomo-display");
  if(!arc||!disp)return;
  const pct=pomoState.remaining/pomoState.total;
  arc.style.strokeDasharray=POMO_SEG+" "+POMO_GAP;
  arc.style.strokeDashoffset=POMO_C*(1-pct);
  arc.style.stroke=pomoState.mode==="work"?"rgba(255,255,255,0.7)":pomoState.mode==="short"?"var(--green)":"var(--purple)";
  disp.textContent=pomoFmt(pomoState.remaining);
  // Also paint mini bar
  const miniArc=document.getElementById("ft-mini-arc");
  const miniTime=document.getElementById("ft-mini-time");
  const miniTask=document.getElementById("ft-mini-task");
  if(miniArc){const mc=2*Math.PI*16;miniArc.style.strokeDashoffset=mc*(1-pct);miniArc.style.stroke=arc.style.stroke}
  if(miniTime)miniTime.textContent=pomoFmt(pomoState.remaining);
  if(miniTask)miniTask.textContent=pomoState.title||"--";
}
function pomoUpdateStartBtn(){
  const btn=document.getElementById("pomo-start");if(!btn)return;
  if(pomoState.running){
    btn.className="pomo-start-big pause";
    btn.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause';
  }else if(pomoState.remaining<pomoState.total&&pomoState.remaining>0){
    btn.className="pomo-start-big go";
    btn.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg> Resume';
  }else{
    btn.className="pomo-start-big go";
    btn.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg> Start to Focus';
  }
}
function pomoSetMode(m){
  pomoState.mode=m;
  const durations={work:pomoState.workMin*60,short:5*60,long:15*60};
  pomoState.total=durations[m];pomoState.remaining=durations[m];
  pomoState.running=false;clearInterval(pomoState.iv);pomoState.startedAt=null;
  pomoUpdateStartBtn();
  const ph=document.getElementById("pomo-phase");
  if(ph)ph.textContent=m==="work"?"Focus":m==="short"?"Short Break":"Long Break";
  document.querySelectorAll(".pomo-mode").forEach(b=>b.classList.toggle("active",b.dataset.pm===m));
  pomoPaint();savePomoState();
}
function pomoLogSession(title,durSec,type){
  const now=new Date();
  const entry={title,durSec,type,time:now.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"})};
  pomoState.sessionLog.unshift(entry);
  if(type==="work") pomoState.taskTime[title]=(pomoState.taskTime[title]||0)+durSec;
  pomoRenderReport();savePomoState();
}
function pomoRenderReport(){
  // Session count indicator on focus tab
  const sc=document.getElementById("pomo-session-count");
  const workSessions=pomoState.sessionLog.filter(e=>e.type==="work"&&e.title===pomoState.title).length;
  if(sc)sc.innerHTML=workSessions>0?'<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2" stroke="white" stroke-width="2" fill="none"/></svg> '+workSessions:'';

  // Stats
  const totalFocusSec=pomoState.sessionLog.filter(e=>e.type==="work").reduce((s,e)=>s+e.durSec,0);
  const totalSessions=pomoState.sessionLog.filter(e=>e.type==="work").length;
  const tasksWorked=Object.keys(pomoState.taskTime).length;
  const totalMin=Math.round(totalFocusSec/60);
  const hrs=Math.floor(totalMin/60),mins=totalMin%60;

  const elEl=document.getElementById("ps-elapsed");if(elEl)elEl.textContent=pomoFmt(totalFocusSec);
  const seEl=document.getElementById("ps-sessions");if(seEl)seEl.textContent=totalSessions;
  const twEl=document.getElementById("ps-tasks");if(twEl)twEl.textContent=tasksWorked;
  const ftEl=document.getElementById("pomo-focus-total");if(ftEl)ftEl.textContent="Total focus time "+(hrs>0?hrs+"h "+mins+"m":mins+"m");
  const ttEl=document.getElementById("pomo-total-time");if(ttEl)ttEl.textContent=hrs>0?hrs+"h "+mins+"m focused today":mins+"m focused today";

  // Task bars
  const barsEl=document.getElementById("pomo-task-bars"),barsEmpty=document.getElementById("pomo-bars-empty");
  if(barsEl){
    const entries=Object.entries(pomoState.taskTime).sort((a,b)=>b[1]-a[1]);
    if(!entries.length){barsEl.innerHTML="";if(barsEmpty)barsEmpty.style.display="block";}
    else{
      if(barsEmpty)barsEmpty.style.display="none";
      const maxSec=entries[0][1];
      barsEl.innerHTML=entries.map(([name,sec])=>{
        const m=Math.round(sec/60),pct=Math.max(2,Math.round((sec/maxSec)*100));
        const mStr=m>=60?Math.floor(m/60)+"h "+(m%60)+"m":m+"m";
        return '<div class="pomo-task-bar"><div style="display:flex;justify-content:space-between;align-items:baseline"><span class="ptb-name">'+name+'</span><span class="ptb-time">'+mStr+'</span></div><div class="ptb-track"><div class="ptb-fill" style="width:'+pct+'%"></div></div></div>';
      }).join('');
    }
  }

  // Session log
  const logEntries=document.getElementById("pomo-log-entries"),logEmpty=document.getElementById("pomo-log-empty");
  if(logEntries){
    if(!pomoState.sessionLog.length){logEntries.innerHTML="";if(logEmpty)logEmpty.style.display="block";}
    else{
      if(logEmpty)logEmpty.style.display="none";
      logEntries.innerHTML=pomoState.sessionLog.map((e,idx)=>{
        const durMin=Math.round(e.durSec/60);
        const dotColor=e.type==="work"?"var(--accent)":e.type==="short"?"var(--green)":"var(--purple)";
        let entryHtml='<div class="pomo-log-entry"><span class="ple-dot" style="background:'+dotColor+'"></span><span class="ple-time">'+e.time+'</span><span class="ple-task">'+e.title+'</span><span class="ple-dur">'+durMin+'m</span></div>';

        // If this entry has a stacked-on field, show it as indented/nested
        if(e.stackedOn){
          entryHtml+='<div class="stacked-session">Stacked with: '+e.stackedOn+'</div>';
        }

        return entryHtml;
      }).join('');
    }
  }
}
function pomoTick(){
  if(pomoState.remaining<=0){
    clearInterval(pomoState.iv);pomoState.running=false;
    const elapsed=pomoState.total;

    // Check if title is empty/untasked
    if(!pomoState.title||pomoState.title===""||pomoState.title==="--"||pomoState.title==="Untitled"){
      openUntaskedModal(elapsed,pomoState.mode);
    }else{
      pomoLogSession(pomoState.title,elapsed,pomoState.mode);
    }
    pomoBeep();updateTimerBadge();pomoUpdateStartBtn();
    if(pomoState.mode==="work"){
      pomoState.sessions++;
      for(let i=0;i<4;i++){const d=document.getElementById("pd"+i);if(d)d.className=i<pomoState.sessions?"pomo-dot filled":"pomo-dot"}
      if(pomoState.sessions>=4){pomoSetMode("long");pomoState.sessions=0;document.querySelectorAll(".pomo-dot").forEach(d=>d.className="pomo-dot")}
      else pomoSetMode("short");
    }else pomoSetMode("work");
    pomoState.startedAt=null;
    return;
  }
  pomoState.remaining--;pomoPaint();savePomoState();
}
function updateTimerBadge(){
  // Update FAB badge
  const fabBadge=document.getElementById("ft-fab-badge");
  if(fabBadge) fabBadge.style.display=pomoState.running?"":"none";
  // Show/hide mini bar vs FAB based on running state when panel is closed
  const panel=document.getElementById("ft-panel");
  const panelVisible=panel&&panel.style.display!=="none";
  if(!panelVisible){
    const mini=document.getElementById("ft-mini");
    const fab=document.getElementById("ft-fab");
    if(pomoState.running){
      if(mini)mini.style.display="flex";
      if(fab)fab.style.display="none";
    }else{
      if(mini)mini.style.display="none";
      if(fab)fab.style.display="flex";
    }
  }
}

// ======== TASK COMPLETION MODAL ========
let currentCompletionData={taskTitle:null,selectedTimeBlock:null,selectedPomodoro:null,sessionIndex:null};

function openTaskCompletionModal(taskTitle){
  currentCompletionData={taskTitle,selectedTimeBlock:null,selectedPomodoro:null,sessionIndex:null};
  const overlay=document.getElementById("task-completion-modal-overlay");
  const titleEl=document.getElementById("completion-modal-title");
  const bodyEl=document.getElementById("completion-modal-body");
  const actionsEl=document.getElementById("completion-actions");

  titleEl.textContent="Complete: "+taskTitle;

  // Build time blocks section
  let html='<div class="completion-section"><div class="completion-section-title">Today\'s Schedule</div>';
  const scheduleItems=scheduled.filter(s=>!s.nested);
  scheduleItems.forEach(s=>{
    const c=cfg(s.type);
    const timeStr=f12(s.start)+" - "+f12(s.end);
    const isDoneItem=isDone(s);
    html+='<div class="completion-item clickable" data-block-id="'+s.id+'"><span class="ci-bar" style="background:'+c.color+'"></span><div class="ci-body"><div class="ci-title">'+s.title+'</div>'+(s.detail?'<div class="ci-detail">'+s.detail+'</div>':'')+'<div class="ci-meta"><span>'+timeStr+'</span></div></div></div>';
  });
  html+='</div>';

  // Build session log section
  html+='<div class="completion-section"><div class="completion-section-title">Recorded Pomodoros</div>';
  if(pomoState.sessionLog.length===0){
    html+='<div style="font-size:11px;color:var(--text-muted);padding:8px">No recorded sessions yet.</div>';
  }else{
    pomoState.sessionLog.forEach((entry,idx)=>{
      const durMin=Math.round(entry.durSec/60);
      html+='<div class="completion-item clickable" data-pomo-idx="'+idx+'"><span class="ci-bar" style="background:var(--accent);opacity:0.7"></span><div class="ci-body"><div class="ci-title">'+(entry.title||'(unassigned)')+'</div><div class="ci-meta"><span>'+entry.time+'</span><span>'+durMin+'m</span></div></div></div>';
    });
  }
  html+='</div>';

  bodyEl.innerHTML=html;

  // Wire up item selection
  bodyEl.querySelectorAll(".completion-item.clickable").forEach(el=>{
    el.addEventListener("click",(e)=>{
      const blockId=el.dataset.blockId;
      const pomoIdx=el.dataset.pomoIdx;

      if(blockId){
        currentCompletionData.selectedTimeBlock=blockId;
        const block=scheduled.find(s=>s.id===blockId);
        if(block.title!==taskTitle){
          showConflictPrompt(taskTitle,block,bodyEl);
        }else{
          proceedWithCompletion();
        }
      }else if(pomoIdx!==undefined){
        currentCompletionData.sessionIndex=parseInt(pomoIdx);
        const pomo=pomoState.sessionLog[currentCompletionData.sessionIndex];
        if(pomo.title&&pomo.title!==taskTitle){
          showConflictPrompt(taskTitle,{title:pomo.title},bodyEl);
        }else{
          proceedWithCompletion();
        }
      }
    });
  });

  actionsEl.innerHTML='<button class="secondary" id="comp-cancel">Cancel</button>';
  document.getElementById("comp-cancel").addEventListener("click",()=>closeCompletionModal());

  overlay.classList.add("open");
}

function showConflictPrompt(newTask,existingBlock,container){
  const conflictHtml='<div class="conflict-prompt"><div class="conflict-prompt-text">This block already has "<strong>'+existingBlock.title+'</strong>". What would you like to do?</div><div class="conflict-prompt-btns"><button class="conflict-btn primary" id="conflict-replace">Replace</button><button class="conflict-btn" id="conflict-stack">Stack</button></div></div>';
  const tempDiv=document.createElement("div");
  tempDiv.innerHTML=conflictHtml;
  container.insertBefore(tempDiv,container.firstChild);

  document.getElementById("conflict-replace").addEventListener("click",()=>{
    proceedWithCompletion();
  });
  document.getElementById("conflict-stack").addEventListener("click",()=>{
    currentCompletionData.stackedTask=true;
    proceedWithCompletion();
  });
}

function proceedWithCompletion(){
  const overlay=document.getElementById("task-completion-modal-overlay");
  const bodyEl=document.getElementById("completion-modal-body");
  const actionsEl=document.getElementById("completion-actions");

  bodyEl.innerHTML='<div style="text-align:center;padding:20px;color:var(--text-muted)"><div style="font-size:12px;margin-bottom:12px">Did you complete this task, or should it stay on your list?</div></div>';

  actionsEl.innerHTML='<button class="secondary" id="comp-keep">Keep on List</button><button class="primary" id="comp-done">Completed</button>';

  document.getElementById("comp-keep").addEventListener("click",()=>{
    attributeTimeAndClose(false);
  });
  document.getElementById("comp-done").addEventListener("click",()=>{
    attributeTimeAndClose(true);
  });
}

function attributeTimeAndClose(isCompleted){
  const taskTitle=currentCompletionData.taskTitle;

  if(currentCompletionData.sessionIndex!==null){
    const entry=pomoState.sessionLog[currentCompletionData.sessionIndex];
    if(!entry.title||entry.title==="--"||entry.title==="Untitled"){
      entry.title=taskTitle;
      if(entry.type==="work"){
        pomoState.taskTime[taskTitle]=(pomoState.taskTime[taskTitle]||0)+entry.durSec;
      }
    }else if(currentCompletionData.stackedTask){
      entry.stackedOn=taskTitle;
    }
  }else if(currentCompletionData.selectedTimeBlock){
    const block=scheduled.find(s=>s.id===currentCompletionData.selectedTimeBlock);
    if(block){
      const blockDurSec=(dur(block)*60);
      pomoState.taskTime[taskTitle]=(pomoState.taskTime[taskTitle]||0)+blockDurSec;
    }
  }

  if(isCompleted){
    toggleDone(currentCompletionData.selectedTimeBlock||scheduled.find(s=>s.title===taskTitle)?.id);
  }

  pomoRenderReport();savePomoState();
  closeCompletionModal();
}

function closeCompletionModal(){
  document.getElementById("task-completion-modal-overlay").classList.remove("open");
  currentCompletionData={taskTitle:null,selectedTimeBlock:null,selectedPomodoro:null,sessionIndex:null};
}

// ======== UNTASKED TIMER COMPLETION MODAL ========
let untaskedSessionData={durSec:null,type:null};

function openUntaskedModal(durSec,type){
  untaskedSessionData={durSec,type};
  const overlay=document.getElementById("untasked-modal-overlay");
  const bodyEl=document.getElementById("untasked-modal-body");
  const actionsEl=document.getElementById("untasked-actions");

  let html='<div class="completion-section"><div class="completion-section-title">Current Tasks</div>';
  const allTasks=[...scheduled.filter(s=>!isDone(s)&&!s.nested),...consider,...backlog];

  if(allTasks.length===0){
    html+='<div style="font-size:11px;color:var(--text-muted);padding:8px">No tasks available.</div>';
  }else{
    allTasks.forEach(t=>{
      const c=cfg(t.type);
      html+='<div class="completion-item clickable" data-task-title="'+t.title.replace(/"/g,'&quot;')+'"><span class="ci-bar" style="background:'+c.color+'"></span><div class="ci-body"><div class="ci-title">'+t.title+'</div><div class="ci-meta"><span>'+c.tag+'</span></div></div></div>';
    });
  }
  html+='</div>';

  // Custom input
  html+='<div class="completion-section"><div class="completion-section-title">Or Create New</div><input type="text" id="untasked-custom-input" placeholder="Enter custom task name..." style="width:100%;background:var(--card);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text);font-size:12px;outline:none;box-sizing:border-box"></div>';

  bodyEl.innerHTML=html;

  bodyEl.querySelectorAll(".completion-item.clickable").forEach(el=>{
    el.addEventListener("click",(e)=>{
      const taskTitle=el.dataset.taskTitle;
      showUntaskedCompletionPrompt(taskTitle);
    });
  });

  actionsEl.innerHTML='<button class="secondary" id="untasked-cancel">Cancel</button><button class="primary" id="untasked-custom-add">Use Custom Name</button>';
  document.getElementById("untasked-cancel").addEventListener("click",()=>closeUntaskedModal());
  document.getElementById("untasked-custom-add").addEventListener("click",()=>{
    const customTitle=document.getElementById("untasked-custom-input").value.trim();
    if(customTitle){
      showUntaskedCompletionPrompt(customTitle);
    }
  });

  overlay.classList.add("open");
}

function showUntaskedCompletionPrompt(taskTitle){
  const bodyEl=document.getElementById("untasked-modal-body");
  const actionsEl=document.getElementById("untasked-actions");

  bodyEl.innerHTML='<div style="text-align:center;padding:20px;color:var(--text-muted)"><div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px">'+taskTitle+'</div><div style="font-size:12px;margin-bottom:12px">Did you complete this task, or should it stay on your list?</div></div>';

  actionsEl.innerHTML='<button class="secondary" id="untasked-keep">Keep on List</button><button class="primary" id="untasked-done">Completed</button>';

  document.getElementById("untasked-keep").addEventListener("click",()=>{
    attributeUntaskedTime(taskTitle,false);
  });
  document.getElementById("untasked-done").addEventListener("click",()=>{
    attributeUntaskedTime(taskTitle,true);
  });
}

function attributeUntaskedTime(taskTitle,isCompleted){
  if(untaskedSessionData.durSec){
    pomoState.taskTime[taskTitle]=(pomoState.taskTime[taskTitle]||0)+untaskedSessionData.durSec;
    const entry={title:taskTitle,durSec:untaskedSessionData.durSec,type:untaskedSessionData.type,time:new Date().toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"})};
    pomoState.sessionLog.unshift(entry);
  }

  if(isCompleted){
    const schedItem=scheduled.find(s=>s.title===taskTitle);
    if(schedItem)toggleDone(schedItem.id);
  }

  pomoRenderReport();savePomoState();
  closeUntaskedModal();
}

function closeUntaskedModal(){
  document.getElementById("untasked-modal-overlay").classList.remove("open");
  untaskedSessionData={durSec:null,type:null};
}

function openDistractionModal(){
  const elapsedMin = pomoState.startedAt
    ? Math.max(1, Math.round((Date.now()-pomoState.startedAt)/60000))
    : 5;
  document.getElementById("distraction-mins").value=elapsedMin;
  document.getElementById("distraction-note").value="";
  document.getElementById("distraction-modal-overlay").classList.add("open");
}

// ======== DRAGGABLE FLOAT TIMER ========
(function(){
  const el=document.getElementById("float-timer");
  if(!el)return;

  // Restore saved position
  try{
    const saved=localStorage.getItem("ft-pos");
    if(saved){const {bottom,right}=JSON.parse(saved);el.style.bottom=bottom+"px";el.style.right=right+"px";}
  }catch(e){}

  let dragging=false,hasDragged=false,startX,startY,startRight,startBottom;

  el.addEventListener("mousedown",e=>{
    const panel=document.getElementById("ft-panel");
    if(panel&&panel.style.display!=="none")return; // Don't drag when panel is open
    dragging=true;hasDragged=false;
    startX=e.clientX;startY=e.clientY;
    startRight=parseInt(getComputedStyle(el).right)||30;
    startBottom=parseInt(getComputedStyle(el).bottom)||30;
  });

  document.addEventListener("mousemove",e=>{
    if(!dragging)return;
    const dx=e.clientX-startX,dy=e.clientY-startY;
    if(!hasDragged&&Math.abs(dx)<5&&Math.abs(dy)<5)return;
    hasDragged=true;
    el.style.right=Math.max(0,startRight-dx)+"px";
    el.style.bottom=Math.max(0,startBottom-dy)+"px";
  });

  document.addEventListener("mouseup",()=>{
    if(!dragging)return;
    dragging=false;
    if(hasDragged){
      localStorage.setItem("ft-pos",JSON.stringify({
        bottom:parseInt(el.style.bottom),
        right:parseInt(el.style.right)
      }));
    }
  });

  // Suppress click when user actually dragged
  el.addEventListener("click",e=>{
    if(hasDragged){e.stopPropagation();hasDragged=false;}
  },true);
})();

