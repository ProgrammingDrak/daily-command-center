// ======== POMODORO TIMER ========
const pomoSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3L2 6"/><path d="M22 6l-3-3"/></svg>';
// Dashed ring: circumference of r=54 is ~339.29. We use stroke-dasharray for tick marks.
const POMO_C=2*Math.PI*54;
// Each tick segment = 5.65 on, 2.83 gap. Total ticks ~ 40.
const POMO_SEG=5.65,POMO_GAP=2.83,POMO_UNIT=POMO_SEG+POMO_GAP;
let pomoState={title:"",currentTaskRef:null,workMin:25,mode:"work",total:25*60,remaining:25*60,running:false,iv:null,sessions:0,soundOn:true,sessionLog:[],taskTime:{},startedAt:null,taskDone:false,stackedSessions:{},pivotTasks:[]};

// Timer-facing task references resolve against the live itinerary pools. Persist
// ids; keep titles only as a legacy/custom fallback.
function _pomoTaskPools(){
  return [
    {source:"schedule",items:(typeof scheduled!=="undefined"&&Array.isArray(scheduled))?scheduled:[]},
    {source:"consider",items:(typeof consider!=="undefined"&&Array.isArray(consider))?consider:[]},
    {source:"backlog",items:(typeof backlog!=="undefined"&&Array.isArray(backlog))?backlog:[]}
  ];
}
function _pomoTaskAvailable(task,source){
  if(!task)return false;
  if(source==="schedule"){
    if(task.nested)return false;
    if(typeof isDone==="function"&&isDone(task))return false;
    if(typeof isDeleted==="function"&&isDeleted(task))return false;
    if(typeof isPushed==="function"&&isPushed(task))return false;
  }
  return true;
}
function makePomoTaskRef(task,source,titleFallback){
  if(!task&&titleFallback)return {id:"",source:"custom",title:titleFallback};
  return {id:(task&&task.id)||"",source:source||"custom",title:(task&&task.title)||titleFallback||""};
}
function resolvePomoTaskRef(ref,opts){
  opts=opts||{};
  if(!ref)return null;
  if(typeof ref==="string")ref={title:ref};
  const refId=ref.id?String(ref.id):"";
  const refSource=ref.source||"";
  const refTitle=(ref.title||"").trim();
  const pools=_pomoTaskPools();
  function usable(task,source){return !opts.availableOnly||_pomoTaskAvailable(task,source)}
  if(refId){
    const ordered=refSource?pools.filter(p=>p.source===refSource).concat(pools.filter(p=>p.source!==refSource)):pools;
    for(const pool of ordered){
      const task=pool.items.find(t=>String(t.id)===refId);
      if(task&&usable(task,pool.source))return {task,source:pool.source,ref:makePomoTaskRef(task,pool.source),title:task.title,durMin:pool.source==="schedule"?(typeof dur==="function"?dur(task):25):(task.durMin||25)};
    }
  }
  if(refTitle){
    for(const pool of pools){
      const task=pool.items.find(t=>(t.title||"").trim()===refTitle&&usable(t,pool.source));
      if(task)return {task,source:pool.source,ref:makePomoTaskRef(task,pool.source),title:task.title,durMin:pool.source==="schedule"?(typeof dur==="function"?dur(task):25):(task.durMin||25)};
    }
    if(refSource==="custom"||opts.allowCustom)return {task:null,source:"custom",ref:{id:"",source:"custom",title:refTitle},title:refTitle,durMin:opts.defaultDurMin||25,isCustom:true};
  }
  return null;
}
function getCurrentPomoTask(){
  const ref=pomoState.currentTaskRef||{title:pomoState.title,source:"custom"};
  return resolvePomoTaskRef(ref,{allowCustom:true,defaultDurMin:pomoState.workMin||25});
}
function syncCurrentPomoTitle(){
  const resolved=getCurrentPomoTask();
  if(!resolved)return null;
  pomoState.title=resolved.title;
  if(resolved.ref)pomoState.currentTaskRef=resolved.ref;
  const titleEl=document.getElementById("pomo-title");if(titleEl)titleEl.textContent=pomoState.title;
  const miniTask=document.getElementById("ft-mini-task");if(miniTask)miniTask.textContent=pomoState.title||"--";
  return resolved;
}
function normalizePomoStateRefs(){
  if(!pomoState.currentTaskRef&&pomoState.title){
    const resolved=resolvePomoTaskRef({title:pomoState.title},{allowCustom:true,defaultDurMin:pomoState.workMin||25});
    pomoState.currentTaskRef=resolved?resolved.ref:{id:"",source:"custom",title:pomoState.title};
  }
  if(!Array.isArray(pomoState.pivotTasks))pomoState.pivotTasks=[];
  if(!_pomoTaskPools().some(pool=>pool.items.length)){
    syncCurrentPomoTitle();
    return false;
  }
  const cleaned=[];
  const seen=new Set();
  pomoState.pivotTasks.forEach(p=>{
    const resolved=resolvePomoTaskRef(p,{availableOnly:true});
    if(!resolved)return;
    const key=resolved.ref.source+":"+resolved.ref.id;
    if(!resolved.ref.id||seen.has(key))return;
    seen.add(key);
    cleaned.push(resolved.ref);
  });
  const changed=JSON.stringify(cleaned)!==JSON.stringify(pomoState.pivotTasks);
  pomoState.pivotTasks=cleaned;
  syncCurrentPomoTitle();
  return changed;
}

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
  if(typeof updateFocusBanner==="function")updateFocusBanner();
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
        const dotColor=e.type==="work"?"var(--accent)":e.type==="short"?"var(--green)":e.type==="distraction"?"var(--red)":"var(--purple)";
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
  pomoState.remaining--;pomoPaint();savePomoState(true);
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
let _completionModalCallback = null;
let _completionModalResult = null; // {completed,startNext} or null=dismissed
let currentCompletionData={taskTitle:null,selectedTimeBlock:null,selectedPomodoro:null,sessionIndex:null,stackedTask:false,startNext:false};

function openTaskCompletionModal(taskTitle){
  currentCompletionData={taskTitle,selectedTimeBlock:null,selectedPomodoro:null,sessionIndex:null,stackedTask:false,startNext:false};
  const overlay=document.getElementById("task-completion-modal-overlay");
  const titleEl=document.getElementById("completion-modal-title");
  const bodyEl=document.getElementById("completion-modal-body");
  const actionsEl=document.getElementById("completion-actions");

  titleEl.textContent="Complete: "+taskTitle;

  let html='<div style="font-size:12px;color:var(--text-muted);line-height:1.4;margin-bottom:14px">Complete now, or optionally pick a schedule block / recorded session to attribute time first.</div>';

  // Build time blocks section
  html+='<div class="completion-section"><div class="completion-section-title">Today\'s Schedule</div>';
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
          selectCompletionItem(el);
        }
      }else if(pomoIdx!==undefined){
        currentCompletionData.sessionIndex=parseInt(pomoIdx);
        const pomo=pomoState.sessionLog[currentCompletionData.sessionIndex];
        if(pomo.title&&pomo.title!==taskTitle){
          showConflictPrompt(taskTitle,{title:pomo.title},bodyEl);
        }else{
          selectCompletionItem(el);
        }
      }
    });
  });

  actionsEl.innerHTML='<button class="secondary" id="comp-cancel">Cancel</button><button class="secondary" id="comp-done-next">Complete + Switch</button><button class="primary" id="comp-done">Complete</button>';
  document.getElementById("comp-cancel").addEventListener("click",()=>closeCompletionModal());
  document.getElementById("comp-done").addEventListener("click",()=>attributeTimeAndClose(true,false));
  document.getElementById("comp-done-next").addEventListener("click",()=>attributeTimeAndClose(true,true));

  overlay.classList.add("open");
}

function selectCompletionItem(el){
  el.closest(".completion-modal-body")?.querySelectorAll(".completion-item.selected").forEach(item=>item.classList.remove("selected"));
  el.classList.add("selected");
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

  actionsEl.innerHTML='<button class="secondary" id="comp-keep">Keep on List</button><button class="secondary" id="comp-done-next">Complete + Switch</button><button class="primary" id="comp-done">Complete</button>';

  document.getElementById("comp-keep").addEventListener("click",()=>{
    attributeTimeAndClose(false);
  });
  document.getElementById("comp-done").addEventListener("click",()=>{
    attributeTimeAndClose(true,false);
  });
  document.getElementById("comp-done-next").addEventListener("click",()=>{
    attributeTimeAndClose(true,true);
  });
}

function attributeTimeAndClose(isCompleted,startNext){
  const taskTitle=currentCompletionData.taskTitle;
  const currentTask=getCurrentPomoTask();
  currentCompletionData.startNext=!!startNext;

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
    const scheduleId=currentCompletionData.selectedTimeBlock||(currentTask&&currentTask.source==="schedule"&&currentTask.task?currentTask.task.id:null)||scheduled.find(s=>s.title===taskTitle)?.id;
    if(scheduleId)toggleDone(scheduleId);
  }

  pomoRenderReport();savePomoState();
  _completionModalResult = { completed: isCompleted, startNext: !!startNext };
  closeCompletionModal();
}

function closeCompletionModal(){
  document.getElementById("task-completion-modal-overlay").classList.remove("open");
  currentCompletionData={taskTitle:null,selectedTimeBlock:null,selectedPomodoro:null,sessionIndex:null,stackedTask:false,startNext:false};
  if(_completionModalCallback){
    const cb=_completionModalCallback, result=_completionModalResult;
    _completionModalCallback=null; _completionModalResult=null;
    cb(result);
  }
}

// ======== UNTASKED TIMER COMPLETION MODAL ========
let untaskedSessionData={durSec:null,type:null};

function openUntaskedModal(durSec,type){
  untaskedSessionData={durSec,type};
  const overlay=document.getElementById("untasked-modal-overlay");
  const bodyEl=document.getElementById("untasked-modal-body");
  const actionsEl=document.getElementById("untasked-actions");

  const allTasks=[...scheduled.filter(s=>!isDone(s)&&!s.nested),...consider,...backlog];
  let html='<div class="completion-section"><div class="completion-section-title">Current Tasks</div>';
  html+=buildTaskListHtml(allTasks);
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

let _distractionCapturedStart = null;

function openDistractionModal(capturedStart){
  _distractionCapturedStart = capturedStart;
  const elapsedMin = capturedStart
    ? Math.max(1, Math.round((Date.now()-capturedStart)/60000))
    : 0;
  document.getElementById("distraction-mins").value = elapsedMin || 5;
  document.getElementById("distraction-note").value = "";
  // Show focused time info
  const focusInfo = document.getElementById("distraction-focus-info");
  if(focusInfo){
    if(capturedStart){
      const focusSec = Math.round((Date.now()-capturedStart)/1000);
      const focusMin = Math.round(focusSec/60);
      focusInfo.textContent = focusMin + "m focused on \"" + pomoState.title + "\" (timer still running)";
      focusInfo.style.display = "block";
    } else {
      focusInfo.style.display = "none";
    }
  }
  // Reset classify toggle to "break" default
  document.querySelectorAll(".distraction-classify-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.classify === "break");
  });
  // Build task attribution list
  buildDistractionTaskList();
  document.getElementById("distraction-modal-overlay").classList.add("open");
}

function buildDistractionTaskList(){
  const list = document.getElementById("distraction-task-list");
  if(!list) return;
  const tasks = [...scheduled.filter(s=>!s.nested), ...consider, ...backlog];
  if(!tasks.length){ list.innerHTML=""; return; }
  list.innerHTML = tasks.slice(0,6).map(t => {
    const c = cfg(t.type);
    return '<div class="distraction-task-item" data-title="'+t.title.replace(/"/g,'&quot;')+'">'
      +'<span class="dti-bar" style="background:'+c.color+'"></span>'
      +'<span class="dti-title">'+t.title+'</span></div>';
  }).join('');
  list.querySelectorAll(".distraction-task-item").forEach(el => {
    el.addEventListener("click", () => {
      list.querySelectorAll(".distraction-task-item").forEach(e=>e.classList.remove("selected"));
      el.classList.toggle("selected");
      document.getElementById("distraction-note").value = "";
    });
  });
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
    const panelOpen=panel&&panel.style.display!=="none";
    const isPanelDrag=panelOpen&&e.target.closest(".ft-panel-bar")&&!e.target.closest("button,a,input,select,textarea,.ft-resize-grip");
    const isClosedDrag=!panelOpen&&e.target.closest(".ft-fab,.ft-mini");
    if(!isPanelDrag&&!isClosedDrag)return;
    e.preventDefault();
    dragging=true;hasDragged=false;
    startX=e.clientX;startY=e.clientY;
    startRight=parseInt(getComputedStyle(el).right)||30;
    startBottom=parseInt(getComputedStyle(el).bottom)||30;
    document.body.style.userSelect="none";
  });

  document.addEventListener("mousemove",e=>{
    if(!dragging)return;
    const dx=e.clientX-startX,dy=e.clientY-startY;
    if(!hasDragged&&Math.abs(dx)<5&&Math.abs(dy)<5)return;
    hasDragged=true;
    const r=el.getBoundingClientRect();
    const maxRight=Math.max(0,window.innerWidth-r.width);
    const maxBottom=Math.max(0,window.innerHeight-r.height);
    el.style.right=Math.min(maxRight,Math.max(0,startRight-dx))+"px";
    el.style.bottom=Math.min(maxBottom,Math.max(0,startBottom-dy))+"px";
  });

  document.addEventListener("mouseup",()=>{
    if(!dragging)return;
    dragging=false;
    document.body.style.userSelect="";
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

// ======== RESIZABLE FLOAT-TIMER PANEL ========
(function(){
  const panel=document.getElementById("ft-panel");
  const grip=document.getElementById("ft-resize-grip");
  if(!panel||!grip)return;

  // Restore saved size
  try{
    const saved=localStorage.getItem("ft-panel-size");
    if(saved){
      const {width,height}=JSON.parse(saved);
      if(width)panel.style.width=width+"px";
      if(height)panel.style.height=height+"px";
    }
  }catch(e){}

  let resizing=false,startX,startY,startW,startH;

  grip.addEventListener("mousedown",e=>{
    e.preventDefault();e.stopPropagation();
    resizing=true;
    startX=e.clientX;startY=e.clientY;
    const r=panel.getBoundingClientRect();
    startW=r.width;startH=r.height;
    document.body.style.userSelect="none";
  });

  document.addEventListener("mousemove",e=>{
    if(!resizing)return;
    // Top-left grip: drag up-left grows the panel (subtract deltas)
    const dx=e.clientX-startX,dy=e.clientY-startY;
    const minW=300,minH=360;
    const maxW=window.innerWidth-40,maxH=window.innerHeight-40;
    panel.style.width=Math.max(minW,Math.min(maxW,startW-dx))+"px";
    panel.style.height=Math.max(minH,Math.min(maxH,startH-dy))+"px";
  });

  document.addEventListener("mouseup",()=>{
    if(!resizing)return;
    resizing=false;
    document.body.style.userSelect="";
    try{
      localStorage.setItem("ft-panel-size",JSON.stringify({
        width:parseInt(panel.style.width),
        height:parseInt(panel.style.height)
      }));
    }catch(e){}
  });
})();

// ======== WHEN BLOCKED — PIVOT TASKS ========
function paintPivotTasks(){
  const list=document.getElementById("pivot-tasks-list");
  if(!list)return;
  const changed=normalizePomoStateRefs();
  if(changed&&typeof savePomoState==="function")savePomoState();
  if(!_pomoTaskPools().some(pool=>pool.items.length)){
    list.innerHTML=pomoState.pivotTasks.map((t,i)=>
      '<div class="pivot-card">'+
        '<button class="pivot-swap" data-pivot-idx="'+i+'" title="Make this my focus">\u21c4</button>'+
        '<span class="pivot-title">'+(t.title||"Untitled")+'</span>'+
        '<button class="pivot-remove" data-pivot-idx="'+i+'" title="Remove">&times;</button>'+
      '</div>'
    ).join('');
    return;
  }
  const rows=pomoState.pivotTasks.map((t,i)=>({resolved:resolvePomoTaskRef(t,{availableOnly:true}),i})).filter(row=>row.resolved);
  list.innerHTML=rows.map(row=>
    '<div class="pivot-card">'+
      '<button class="pivot-swap" data-pivot-idx="'+row.i+'" title="Make this my focus">\u21c4</button>'+
      '<span class="pivot-title">'+row.resolved.title+'</span>'+
      '<button class="pivot-remove" data-pivot-idx="'+row.i+'" title="Remove">&times;</button>'+
    '</div>'
  ).join('');
  list.querySelectorAll('.pivot-swap').forEach(btn=>btn.addEventListener('click',e=>{
    e.stopPropagation();swapWithPivot(parseInt(btn.dataset.pivotIdx));
  }));
  list.querySelectorAll('.pivot-remove').forEach(btn=>btn.addEventListener('click',e=>{
    e.stopPropagation();removePivotTask(parseInt(btn.dataset.pivotIdx));
  }));
}

function swapWithPivot(idx){
  if(idx<0||idx>=pomoState.pivotTasks.length)return;
  const oldPrimary=getCurrentPomoTask();
  const pivot=resolvePomoTaskRef(pomoState.pivotTasks[idx],{availableOnly:true});
  if(!pivot){
    pomoState.pivotTasks.splice(idx,1);
    savePomoState();
    paintPivotTasks();
    return;
  }
  pomoState.currentTaskRef=pivot.ref;
  pomoState.title=pivot.title;
  if(oldPrimary&&oldPrimary.ref&&oldPrimary.ref.id)pomoState.pivotTasks[idx]=oldPrimary.ref;
  else pomoState.pivotTasks.splice(idx,1);
  syncCurrentPomoTitle();
  if(typeof showToast==="function")showToast("Swapped to: "+pomoState.title,"success");
  savePomoState();
  paintPivotTasks();
}

function removePivotTask(idx){
  pomoState.pivotTasks.splice(idx,1);
  savePomoState();
  paintPivotTasks();
}

function openPivotPicker(){
  const overlay=document.getElementById("pivot-picker-overlay");
  const body=document.getElementById("pivot-picker-body");
  if(!overlay||!body)return;
  normalizePomoStateRefs();
  const current=getCurrentPomoTask();
  const taken=new Set();
  if(current&&current.ref&&current.ref.id)taken.add(current.ref.source+":"+current.ref.id);
  pomoState.pivotTasks.forEach(t=>{
    const resolved=resolvePomoTaskRef(t,{availableOnly:true});
    if(resolved&&resolved.ref.id)taken.add(resolved.ref.source+":"+resolved.ref.id);
  });
  const available=[
    ...(typeof scheduled!=="undefined"?scheduled.filter(s=>_pomoTaskAvailable(s,"schedule")&&!taken.has("schedule:"+s.id)).map(s=>Object.assign({_pomoSource:"schedule"},s)):[]),
    ...(typeof consider!=="undefined"?consider.filter(t=>!taken.has("consider:"+t.id)).map(t=>Object.assign({_pomoSource:"consider"},t)):[]),
    ...(typeof backlog!=="undefined"?backlog.filter(t=>!taken.has("backlog:"+t.id)).map(t=>Object.assign({_pomoSource:"backlog"},t)):[])
  ];
  body.innerHTML=(typeof buildTaskListHtml==="function")
    ?buildTaskListHtml(available)
    :'<div style="font-size:11px;color:var(--text-muted);padding:8px">No tasks available.</div>';
  body.querySelectorAll('.completion-item.clickable').forEach(el=>{
    el.addEventListener('click',()=>{
      if(pomoState.pivotTasks.length>=3){
        if(typeof showToast==="function")showToast("Max 3 pivot tasks","info");
        return;
      }
      pomoState.pivotTasks.push({id:el.dataset.taskId||"",source:el.dataset.taskSource||"",title:el.dataset.taskTitle||""});
      savePomoState();
      paintPivotTasks();
      closePivotPicker();
    });
  });
  overlay.style.display='';
}

function closePivotPicker(){
  const overlay=document.getElementById("pivot-picker-overlay");
  if(overlay)overlay.style.display='none';
}

document.addEventListener('DOMContentLoaded',function(){
  const addBtn=document.getElementById("pivot-add-btn");
  if(addBtn)addBtn.addEventListener('click',function(e){
    e.stopPropagation();
    const overlay=document.getElementById("pivot-picker-overlay");
    if(overlay&&overlay.style.display!=='none'){closePivotPicker();}else{openPivotPicker();}
  });
  const cancelBtn=document.getElementById("pivot-picker-cancel");
  if(cancelBtn)cancelBtn.addEventListener('click',function(e){e.stopPropagation();closePivotPicker();});
});

