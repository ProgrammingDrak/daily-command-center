// ======== ACTION ITEMS TAB ========
function getAllActionItems(){
  // Collect from 3 sources:
  // 1. Pending tasks (queued for later via "Later" button)
  const pending=loadPendingTasks().map(t=>({...t,_source:"pending",_sourceLabel:"Queued for later"}));
  // 2. Action items from schedule task notes (undone ones only)
  const actions=loadActions();
  const fromNotes=[];
  Object.entries(actions).forEach(([taskId,items])=>{
    const parentEv=scheduled.find(e=>e.id===taskId);
    const parentTitle=parentEv?parentEv.title:taskId;
    items.forEach((item,idx)=>{
      if(item._scheduled)return; // already on today's schedule
      fromNotes.push({
        id:"action-"+taskId+"-"+idx,
        title:item.text,
        priority:item.priority||"Medium",
        source_task:parentTitle,
        source_task_id:taskId,
        created_at:item.created||"",
        status:item.done?"done":"open",
        done:!!item.done,
        _source:"notes",
        _sourceLabel:parentTitle,
        _taskId:taskId,
        _idx:idx
      });
    });
  });
  // 3. Action items from upcoming meeting notes
  const upActions=loadUpActions();
  const fromUpcoming=[];
  Object.entries(upActions).forEach(([mtgId,items])=>{
    const upcoming=(window.__PA_UPCOMING__||[]);
    const mtg=upcoming.find(m=>m.id===mtgId);
    const mtgTitle=mtg?mtg.title:mtgId;
    items.forEach((item,idx)=>{
      fromUpcoming.push({
        id:"up-action-"+mtgId+"-"+idx,
        title:item.text,
        priority:item.priority||"Medium",
        source_task:mtgTitle,
        source_task_id:mtgId,
        created_at:item.created||"",
        status:item.done?"done":"open",
        done:!!item.done,
        _source:"upcoming",
        _sourceLabel:mtgTitle,
        _taskId:mtgId,
        _idx:idx
      });
    });
  });
  return [...pending,...fromNotes,...fromUpcoming];
}

function buildActionItemsTab(){
  const list=document.getElementById("ai-tab-list");
  if(!list)return;
  const all=getAllActionItems();
  const open=all.filter(i=>!i.done&&i.status!=="done");
  const done=all.filter(i=>i.done||i.status==="done");

  // Update badge
  const badge=document.getElementById("actions-count");
  if(badge)badge.textContent=open.length;

  if(!all.length){
    list.innerHTML='<div class="ai-tab-empty">No action items yet. They\'ll appear here when you add follow-ups from meetings, triage, or the notes drawer.</div>';
    return;
  }

  let html='';
  if(open.length){
    html+='<div class="ai-tab-group"><div class="ai-tab-group-label">Open ('+open.length+')</div>';
    html+=open.map(item=>buildAITabCard(item)).join('');
    html+='</div>';
  }
  if(done.length){
    html+='<div class="ai-tab-group"><div class="ai-tab-group-label">Completed ('+done.length+')</div>';
    html+=done.map(item=>buildAITabCard(item)).join('');
    html+='</div>';
  }
  list.innerHTML=html;

  // Wire event handlers
  list.querySelectorAll(".ai-tab-chk").forEach(el=>{
    el.addEventListener("click",e=>{
      e.stopPropagation();
      toggleAITabItem(el.dataset.aiId,el.dataset.aiSource,el.dataset.aiTaskId,parseInt(el.dataset.aiIdx));
    });
  });
  list.querySelectorAll(".ai-tab-sched-btn").forEach(el=>{
    el.addEventListener("click",e=>{
      e.stopPropagation();
      scheduleAITabItem(el.dataset.aiTitle,el.dataset.aiId,el.dataset.aiSource,el.dataset.aiTaskId,parseInt(el.dataset.aiIdx));
    });
  });
  list.querySelectorAll(".ai-tab-del-btn").forEach(el=>{
    el.addEventListener("click",e=>{
      e.stopPropagation();
      deleteAITabItem(el.dataset.aiId,el.dataset.aiSource,el.dataset.aiTaskId,parseInt(el.dataset.aiIdx));
    });
  });
}

function buildAITabCard(item){
  const isDone=item.done||item.status==="done";
  const age=item.created_at?timeAgo(item.created_at):"";
  return '<div class="ai-tab-card'+(isDone?" done":"")+'" data-ai-id="'+item.id+'">'+
    '<div class="ai-tab-chk" data-ai-id="'+item.id+'" data-ai-source="'+(item._source||"")+'" data-ai-task-id="'+(item._taskId||"")+'" data-ai-idx="'+(item._idx!=null?item._idx:"")+'">'+(isDone?"\u2713":"")+'</div>'+
    '<div class="ai-tab-body">'+
      '<div class="ai-tab-title">'+item.title+'</div>'+
      '<div class="ai-tab-meta">'+
        '<span class="ai-tab-pri ai-tab-pri-'+(item.priority||"Medium")+'">'+(item.priority||"Medium")+'</span>'+
        (item._sourceLabel?'<span class="ai-tab-source">'+item._sourceLabel+'</span>':'')+
        (age?'<span>'+age+'</span>':'')+
      '</div>'+
    '</div>'+
    '<div class="ai-tab-actions">'+
      (!isDone?'<button class="ai-tab-btn sched ai-tab-sched-btn" data-ai-title="'+item.title.replace(/"/g,'&quot;')+'" data-ai-id="'+item.id+'" data-ai-source="'+(item._source||"")+'" data-ai-task-id="'+(item._taskId||"")+'" data-ai-idx="'+(item._idx!=null?item._idx:"")+'">+ Today</button>':'')+
      '<button class="ai-tab-btn del ai-tab-del-btn" data-ai-id="'+item.id+'" data-ai-source="'+(item._source||"")+'" data-ai-task-id="'+(item._taskId||"")+'" data-ai-idx="'+(item._idx!=null?item._idx:"")+'">&times;</button>'+
    '</div>'+
  '</div>';
}

function timeAgo(iso){
  try{
    const ms=Date.now()-new Date(iso).getTime();
    const m=Math.floor(ms/60000),h=Math.floor(m/60),d=Math.floor(h/24);
    if(d>0)return d+"d ago";if(h>0)return h+"h ago";if(m>0)return m+"m ago";return"just now";
  }catch(e){return"";}
}

function toggleAITabItem(id,source,taskId,idx){
  if(source==="notes"&&taskId){
    const actions=loadActions();
    if(actions[taskId]&&actions[taskId][idx]!=null){
      actions[taskId][idx].done=!actions[taskId][idx].done;
      saveActions(actions);
    }
  } else if(source==="upcoming"&&taskId){
    const actions=loadUpActions();
    if(actions[taskId]&&actions[taskId][idx]!=null){
      actions[taskId][idx].done=!actions[taskId][idx].done;
      saveUpActions(actions);
    }
  } else if(source==="pending"){
    const pending=loadPendingTasks();
    const item=pending.find(t=>t.id===id);
    if(item)item.status=item.status==="done"?"queued":"done";
    savePendingTasks(pending);
  }
  buildActionItemsTab();
}

function scheduleAITabItem(title,id,source,taskId,idx){
  insertTaskFromDrawer(title,30);
  // Mark as scheduled in source
  if(source==="notes"&&taskId){
    const actions=loadActions();
    if(actions[taskId]&&actions[taskId][idx]!=null){
      actions[taskId][idx]._scheduled=true;
      actions[taskId][idx]._scheduledAt=new Date().toISOString();
      saveActions(actions);
    }
  } else if(source==="upcoming"&&taskId){
    const actions=loadUpActions();
    if(actions[taskId]&&actions[taskId][idx]!=null){
      actions[taskId][idx]._scheduled=true;
      saveUpActions(actions);
    }
  } else if(source==="pending"){
    const pending=loadPendingTasks();
    const item=pending.find(t=>t.id===id);
    if(item){item.status="scheduled";item._scheduled=true;}
    savePendingTasks(pending);
  }
  buildActionItemsTab();
}

function deleteAITabItem(id,source,taskId,idx){
  if(source==="notes"&&taskId){
    const actions=loadActions();
    if(actions[taskId]){actions[taskId].splice(idx,1);saveActions(actions);}
  } else if(source==="upcoming"&&taskId){
    const actions=loadUpActions();
    if(actions[taskId]){actions[taskId].splice(idx,1);saveUpActions(actions);}
  } else if(source==="pending"){
    const pending=loadPendingTasks().filter(t=>t.id!==id);
    savePendingTasks(pending);
  }
  buildActionItemsTab();
}

function addAITabItem(){
  const inp=document.getElementById("ai-tab-text");
  const title=inp.value.trim();
  if(!title)return;
  const priority=document.getElementById("ai-tab-priority").value;
  const pending=loadPendingTasks();
  pending.push({
    id:"pending-"+(Date.now()),
    title:title,
    priority:priority,
    source_task:"Manual entry",
    source_task_id:"manual",
    created_at:new Date().toISOString(),
    status:"queued"
  });
  savePendingTasks(pending);
  inp.value="";
  buildActionItemsTab();
}

// Notes button builder for timeline cards
function notesButton(ev) {
  const notes = loadNotes();
  const actions = loadActions();
  const n = notes[ev.id];
  const hasNotes = n && (typeof n === "string" ? n.trim() : (n.text && n.text.trim()));
  const actionItems = actions[ev.id] || [];
  const hasActions = actionItems.length > 0;
  const openCount = actionItems.filter(a => !a.done).length;
  let cls = "notes-btn";
  if (hasActions) cls += " has-actions";
  else if (hasNotes) cls += " has-notes";
  let badge = hasActions ? '<span class="action-badge">' + actionSvg + ' ' + openCount + '</span>' : '';
  return '<button class="' + cls + '" data-notes-id="' + ev.id + '" data-notes-title="' + (ev.title || "").replace(/"/g, '&quot;') + '" title="Notes & Action Items">' + notesSvg + '</button>' + badge;
}

// ======== TRIAGE DISMISS ========
let currentDismissId = null;
// ======== UNIFIED DONE MODAL ========
let _dmCallback=null, _dmId=null, _dmEv=null, _dmSessions=[];

function openDoneModal(id, title, onConfirm, ev){
  _dmId=id; _dmCallback=onConfirm; _dmEv=ev||null;
  document.getElementById("done-modal-title").textContent="Complete: "+title;
  // Pre-populate notes (any notes saved for this item)
  const notes=loadNotes();
  document.getElementById("dm-notes").value=notes[id]||"";
  // Pre-populate action items
  document.getElementById("dm-action-input").style.display="none";
  renderDmActions(id);
  // Time sessions section
  const timeSection=document.getElementById("dm-time-section");
  if(ev && ev.start && ev.end){
    timeSection.style.display="";
    const sessions=loadSessions();
    if(sessions[id] && sessions[id].length){
      _dmSessions=sessions[id].map(s=>({...s}));
    } else {
      _dmSessions=[{start:ev.start, durationMin:dur(ev), isPlanned:true}];
    }
    renderDmSessions();
  } else {
    timeSection.style.display="none";
    _dmSessions=[];
  }
  const incomplete=getIncompleteSubtasks(id);
  const stSection=document.getElementById("dm-subtask-section");
  if(incomplete.length){
    let opts=['<div class="st-resolve-section">',
      '<div class="st-resolve-title">⚠ '+incomplete.length+' subtask'+(incomplete.length>1?'s':'')+' not completed — what should happen to them?</div>',
      '<div class="st-resolve-opts">',
        '<button class="st-resolve-opt selected" data-res="discard"><div><div class="st-resolve-opt-title">Discard</div><div class="st-resolve-opt-desc">Remove subtasks — task is done as-is</div></div></button>',
        '<button class="st-resolve-opt" data-res="individual"><div><div class="st-resolve-opt-title">Create individual tasks</div><div class="st-resolve-opt-desc">Add one scheduled task per subtask</div></div></button>',
        '<button class="st-resolve-opt" data-res="grouped"><div><div class="st-resolve-opt-title">Create grouped task</div><div class="st-resolve-opt-desc">Add one task containing all remaining subtasks</div></div></button>',
      '</div></div>'].join('');
    stSection.innerHTML=opts;
    stSection.style.display="";
    stSection.querySelectorAll(".st-resolve-opt").forEach(btn=>{
      btn.addEventListener("click",()=>{
        stSection.querySelectorAll(".st-resolve-opt").forEach(b=>b.classList.remove("selected"));
        btn.classList.add("selected");
      });
    });
  } else {
    stSection.innerHTML="";stSection.style.display="none";
  }
  // Parent task linking (for triage items — no ev means this is a triage completion)
  const parentSection = document.getElementById("dm-parent-section");
  if (!ev) {
    parentSection.style.display = "";
    const sel = document.getElementById("dm-parent-select");
    const triageParents = loadTriageParents();
    sel.innerHTML = '<option value="">No link \u2014 standalone item</option>' +
      scheduled.filter(e => !isMeeting(e) && !isDone(e) && e.type !== "ooo").map(e =>
        '<option value="' + e.id + '"' + (triageParents[id] === e.id ? ' selected' : '') + '>' + e.title + ' (' + f12(e.start) + ')</option>'
      ).join('');
  } else {
    parentSection.style.display = "none";
  }
  document.getElementById("done-modal-overlay").classList.add("open");
  setTimeout(()=>document.getElementById("dm-notes").focus(),80);
}
function closeDoneModal(){
  document.getElementById("done-modal-overlay").classList.remove("open");
  _dmId=null; _dmCallback=null; _dmEv=null; _dmSessions=[];
}
function confirmDoneModal(){
  if(!_dmId)return;
  // Capture notes before any DOM changes
  const text=document.getElementById("dm-notes").value;
  const notes=loadNotes();
  if(text.trim())notes[_dmId]=text; else delete notes[_dmId];
  saveNotes(notes);
  // Save time sessions
  if(_dmSessions.length){
    const sessions=loadSessions();
    sessions[_dmId]=_dmSessions;
    saveSessions(sessions);
  }
  // Save parent task link (triage items only)
  const parentSel=document.getElementById("dm-parent-select");
  if(parentSel && document.getElementById("dm-parent-section").style.display !== "none"){
    const parentId=parentSel.value;
    const triageParents=loadTriageParents();
    if(parentId){triageParents[_dmId]=parentId;}else{delete triageParents[_dmId];}
    saveTriageParents(triageParents);
  }
  // Pass captured text to callback so it doesn't need to re-read the DOM
  const selRes=document.querySelector("#dm-subtask-section .st-resolve-opt.selected");
  if(selRes) executeSubtaskResolution(_dmId, selRes.dataset.res);
  if(_dmCallback)_dmCallback(text);
  closeDoneModal();
}
function renderDmSessions(){
  const list=document.getElementById("dm-sessions-list");
  if(!_dmSessions.length){list.innerHTML='<div style="font-size:11px;color:var(--text-muted);padding:4px 0">No sessions.</div>';return}
  const totalMin=_dmSessions.reduce((a,s)=>a+s.durationMin,0);
  const rows=_dmSessions.map((s,i)=>{
    const endMins=pt(s.start)+s.durationMin;
    const endStr=f12(fmt(endMins%1440));
    const startStr=f12(s.start);
    const planned=s.isPlanned?' is-planned':'';
    const badge=s.isPlanned?'<span class="dm-sess-badge">Planned</span>':'';
    const sh=parseInt(s.start.split(':')[0]),sm=parseInt(s.start.split(':')[1]);
    const sap=sh>=12?'PM':'AM',sh12=sh>12?sh-12:sh||12;
    return '<div class="dm-session-row'+planned+'" data-idx="'+i+'">'+
      badge+
      '<div class="dm-sess-time-wrap" data-idx="'+i+'">'+
        '<div class="dm-sess-time-col">'+
          '<button class="dm-sess-time-arr" data-idx="'+i+'" data-f="h" data-d="1">\u25B2</button>'+
          '<span class="dm-sess-time-val dm-tv-h" data-idx="'+i+'">'+sh12+'</span>'+
          '<button class="dm-sess-time-arr" data-idx="'+i+'" data-f="h" data-d="-1">\u25BC</button>'+
        '</div>'+
        '<span class="dm-sess-time-sep">:</span>'+
        '<div class="dm-sess-time-col">'+
          '<button class="dm-sess-time-arr" data-idx="'+i+'" data-f="m" data-d="5">\u25B2</button>'+
          '<span class="dm-sess-time-val dm-tv-m" data-idx="'+i+'">'+String(sm).padStart(2,'0')+'</span>'+
          '<button class="dm-sess-time-arr" data-idx="'+i+'" data-f="m" data-d="-5">\u25BC</button>'+
        '</div>'+
        '<div class="dm-sess-time-col ampm">'+
          '<button class="dm-sess-time-arr" data-idx="'+i+'" data-f="ap" data-d="1">\u25B2</button>'+
          '<span class="dm-sess-time-val dm-tv-ap" data-idx="'+i+'">'+sap+'</span>'+
          '<button class="dm-sess-time-arr" data-idx="'+i+'" data-f="ap" data-d="-1">\u25BC</button>'+
        '</div>'+
      '</div>'+
      '<div class="dm-sess-dur-wrap">'+
        '<button class="dm-sess-dur-btn" data-idx="'+i+'" data-d="-15">\u2212</button>'+
        '<span class="dm-sess-dur-val">'+ms(s.durationMin)+'</span>'+
        '<button class="dm-sess-dur-btn" data-idx="'+i+'" data-d="15">+</button>'+
      '</div>'+
      '<span class="dm-sess-arrow">\u2192</span>'+
      '<span class="dm-sess-end">'+endStr+'</span>'+
      '<span class="dm-sess-spacer"></span>'+
      '<button class="dm-sess-del" data-idx="'+i+'">&times;</button>'+
    '</div>';
  }).join('');
  const totalLabel=_dmSessions.length>1?'<div class="dm-sess-total"><span>Total across '+_dmSessions.length+' sessions</span><span class="dm-sess-total-val">'+ms(totalMin)+'</span></div>':'';
  list.innerHTML='<div class="dm-sessions-wrap">'+rows+'</div>'+totalLabel;
  // Wire time stepper arrows
  list.querySelectorAll('.dm-sess-time-arr').forEach(btn=>{
    btn.addEventListener('click',function(e){
      e.stopPropagation();
      const idx=parseInt(this.dataset.idx),f=this.dataset.f,d=parseInt(this.dataset.d);
      const parts=_dmSessions[idx].start.split(':').map(Number);
      let h=parts[0],m=parts[1];
      if(f==='h'){h=(h+d+24)%24}
      else if(f==='m'){m=m+d;if(m>=60){m=0;h=(h+1)%24}else if(m<0){m=55;h=(h-1+24)%24}}
      else if(f==='ap'){h=(h+12)%24}
      _dmSessions[idx].start=String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
      renderDmSessions();
    });
  });
  // Wire clock face on time value click
  list.querySelectorAll('.dm-sess-time-val').forEach(el=>{
    el.addEventListener('click',function(e){
      e.stopPropagation();
      const idx=parseInt(this.dataset.idx);
      const wrap=this.closest('.dm-sess-time-wrap');
      openClockPicker(idx,wrap);
    });
  });
  list.querySelectorAll('.dm-sess-dur-btn').forEach(btn=>{
    btn.addEventListener('click',function(){
      const idx=parseInt(this.dataset.idx),d=parseInt(this.dataset.d);
      _dmSessions[idx].durationMin=Math.max(5,_dmSessions[idx].durationMin+d);
      renderDmSessions();
    });
  });
  list.querySelectorAll('.dm-sess-del').forEach(btn=>{
    btn.addEventListener('click',function(){
      const idx=parseInt(this.dataset.idx);
      _dmSessions.splice(idx,1);
      renderDmSessions();
    });
  });
}
function addDmSession(){
  const n=new Date();
  const nowStr=String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0');
  _dmSessions.push({start:nowStr,durationMin:30});
  renderDmSessions();
}
function removeDmSession(idx){_dmSessions.splice(idx,1);renderDmSessions()}

// ======== CLOCK FACE PICKER ========
let _clockIdx=null,_clockH=12,_clockM=0,_clockMode='hour';
function openClockPicker(idx,anchor){
  _clockIdx=idx;
  const parts=_dmSessions[idx].start.split(':').map(Number);
  _clockH=parts[0];_clockM=parts[1];_clockMode='hour';
  const overlay=document.getElementById('dm-clock-overlay');
  const popup=document.getElementById('dm-clock-popup');
  // Position near the anchor
  const r=anchor.getBoundingClientRect();
  popup.style.left=Math.max(10,r.left-80)+'px';
  popup.style.top=Math.max(10,r.bottom+8)+'px';
  overlay.classList.add('open');
  renderClockFace();
}
function closeClockPicker(){
  document.getElementById('dm-clock-overlay').classList.remove('open');
  _clockIdx=null;
}
function confirmClockPicker(){
  if(_clockIdx===null)return;
  _dmSessions[_clockIdx].start=String(_clockH).padStart(2,'0')+':'+String(_clockM).padStart(2,'0');
  closeClockPicker();
  renderDmSessions();
}
function renderClockFace(){
  const nums=document.getElementById('dm-clock-nums');
  const hand=document.getElementById('dm-clock-hand');
  nums.innerHTML='';
  const cx=110,cy=110;
  if(_clockMode==='hour'){
    // Hours 1-12 on inner ring
    for(let i=1;i<=12;i++){
      const angle=(i*30-90)*Math.PI/180;
      const r=70;
      const x=cx+r*Math.cos(angle)-12;
      const y=cy+r*Math.sin(angle)-12;
      const h24=_clockH>=12?(i===12?12:i+12):(i===12?0:i);
      const sel=(_clockH%12===i%12)?'sel':'';
      const el=document.createElement('div');
      el.className='dm-clock-num '+sel;
      el.style.left=x+'px';el.style.top=y+'px';
      el.textContent=i;
      el.addEventListener('click',function(){
        const isPM=_clockH>=12;
        _clockH=isPM?(i===12?12:i+12):(i===12?0:i);
        _clockMode='minute';
        renderClockFace();
      });
      nums.appendChild(el);
    }
    // AM/PM indicator
    const lbl=document.createElement('div');
    lbl.className='dm-clock-ring-label';
    lbl.style.left=(cx-10)+'px';lbl.style.top=(cy-6)+'px';
    lbl.textContent=_clockH>=12?'PM':'AM';
    lbl.style.fontSize='11px';lbl.style.cursor='pointer';lbl.style.color='var(--accent)';
    lbl.addEventListener('click',function(){_clockH=(_clockH+12)%24;renderClockFace()});
    nums.appendChild(lbl);
    // Hand
    const hAngle=(_clockH%12)*30-90;
    hand.style.height='60px';hand.style.transform='rotate('+hAngle+'deg)';hand.style.marginTop='-60px';hand.style.display='block';
  } else {
    // Minutes: 00,15,30,45 on outer ring; 05,10,20,25,35,40,50,55 on inner
    const outerMins=[0,15,30,45];
    const innerMins=[5,10,20,25,35,40,50,55];
    outerMins.forEach(m=>{
      const angle=(m*6-90)*Math.PI/180;
      const r=82;
      const x=cx+r*Math.cos(angle)-14;
      const y=cy+r*Math.sin(angle)-14;
      const sel=_clockM===m?'sel':'';
      const el=document.createElement('div');
      el.className='dm-clock-num outer '+sel;
      el.style.left=x+'px';el.style.top=y+'px';
      el.textContent=String(m).padStart(2,'0');
      el.addEventListener('click',function(){_clockM=m;renderClockFace()});
      nums.appendChild(el);
    });
    innerMins.forEach(m=>{
      const angle=(m*6-90)*Math.PI/180;
      const r=55;
      const x=cx+r*Math.cos(angle)-12;
      const y=cy+r*Math.sin(angle)-12;
      const sel=_clockM===m?'sel':'';
      const el=document.createElement('div');
      el.className='dm-clock-num '+sel;
      el.style.left=x+'px';el.style.top=y+'px';
      el.textContent=String(m).padStart(2,'0');
      el.addEventListener('click',function(){_clockM=m;renderClockFace()});
      nums.appendChild(el);
    });
    // Center label showing selected time
    const lbl=document.createElement('div');
    lbl.className='dm-clock-ring-label';
    lbl.style.left=(cx-16)+'px';lbl.style.top=(cy-6)+'px';
    const lh=_clockH>12?_clockH-12:_clockH||12;
    lbl.textContent=lh+':'+String(_clockM).padStart(2,'0');
    lbl.style.fontSize='11px';lbl.style.color='var(--text)';
    nums.appendChild(lbl);
    // Hand
    const mAngle=_clockM*6-90;
    hand.style.height='72px';hand.style.transform='rotate('+mAngle+'deg)';hand.style.marginTop='-72px';hand.style.display='block';
  }
}
document.getElementById('dm-clock-ok').addEventListener('click',function(e){e.stopPropagation();e.preventDefault();confirmClockPicker()});
document.getElementById('dm-clock-cancel').addEventListener('click',function(e){e.stopPropagation();e.preventDefault();closeClockPicker()});
document.getElementById('dm-clock-overlay').addEventListener('click',function(e){e.stopPropagation();e.preventDefault();if(e.target===this)closeClockPicker()});
document.getElementById('dm-clock-popup').addEventListener('click',function(e){e.stopPropagation()});

function renderDmActions(id){
  const actions=loadActions(), items=(actions[id]||[]);
  document.getElementById("dm-ai-count").textContent="("+items.length+")";
  const list=document.getElementById("dm-ai-list");
  if(!items.length){list.innerHTML='<div style="font-size:11px;color:var(--text-muted);padding:4px 0">No action items yet.</div>';return;}
  list.innerHTML=items.map((item,idx)=>
    '<div class="notes-ai-item">'+
      '<div class="ai-check'+(item.done?" done":"")+'" onclick="toggleDmAction(\''+id+'\','+idx+')">\u2713</div>'+
      '<span class="ai-text"'+(item.done?' style="text-decoration:line-through;opacity:0.5"':'')+'>'+item.text+'</span>'+
      '<span class="ai-pri ai-pri-'+item.priority+'">'+item.priority+'</span>'+
      (item._scheduled?'<span class="ai-sched-btn queued">Scheduled</span>':
        '<span class="ai-sched-btn" onclick="event.stopPropagation();scheduleActionToday(\''+id+'\','+idx+')" title="Add to today\'s schedule">Today</span>')+
      (item._notionQueued?'<span class="ai-sched-btn later queued">Queued</span>':
        '<span class="ai-sched-btn later" onclick="event.stopPropagation();queueActionForLater(\''+id+'\','+idx+')" title="Create as Notion task for later">Later</span>')+
      '<span class="ai-del" onclick="deleteDmAction(\''+id+'\','+idx+')">&times;</span>'+
    '</div>'
  ).join('');
}
function showDmActionInput(){
  document.getElementById("dm-action-input").style.display="flex";
  document.getElementById("dm-action-text").focus();
}
function addDmAction(){
  const text=document.getElementById("dm-action-text").value.trim();
  if(!text||!_dmId)return;
  const priority=document.getElementById("dm-action-priority").value;
  const actions=loadActions();
  if(!actions[_dmId])actions[_dmId]=[];
  actions[_dmId].push({text,priority,done:false,created:new Date().toISOString()});
  saveActions(actions);
  document.getElementById("dm-action-text").value="";
  document.getElementById("dm-action-input").style.display="none";
  renderDmActions(_dmId);
  buildActionItemsTab();
}
function toggleDmAction(id,idx){
  const actions=loadActions();
  if(actions[id]&&actions[id][idx]){actions[id][idx].done=!actions[id][idx].done;saveActions(actions);renderDmActions(id);}
}
function deleteDmAction(id,idx){
  const actions=loadActions();
  if(actions[id]){actions[id].splice(idx,1);saveActions(actions);renderDmActions(id);}
}

function openDismissModal(triageId, title) {
  currentDismissId = triageId;
  document.getElementById("tri-dismiss-title").textContent = "Resolve: " + (title || "Item");
  document.getElementById("tri-dismiss-note").value = "";
  document.getElementById("tri-dismiss-overlay").classList.add("open");
}
function closeDismissModal() {
  document.getElementById("tri-dismiss-overlay").classList.remove("open");
  currentDismissId = null;
}
function dismissTriage(triageId, note, trivial) {
  const dismissed = loadDismissed();
  dismissed[triageId] = { note: note || (trivial ? "Trivial -- dismissed" : ""), dismissed_at: new Date().toISOString(), trivial: !!trivial };
  saveDismissed(dismissed);
  closeDismissModal();
  buildTriage();
}

// Wire up quick-add bar
document.getElementById("qa-add").addEventListener("click", insertTaskNow);
document.getElementById("qa-title").addEventListener("keydown", e=>{ if(e.key==="Enter") insertTaskNow(); });

// Wire up overflow modal
document.getElementById("overflow-modal-close").addEventListener("click", closeOverflowModal);
document.getElementById("overflow-work-late").addEventListener("click", workLateOverflow);
document.getElementById("overflow-push-btn").addEventListener("click", pushSelectedToTomorrow);
document.getElementById("overflow-modal-overlay").addEventListener("click", e=>{ if(e.target===e.currentTarget) closeOverflowModal(); });

// Wire up unified done modal
document.getElementById("done-modal-close").addEventListener("click", closeDoneModal);
document.getElementById("done-modal-cancel").addEventListener("click", closeDoneModal);
document.getElementById("done-modal-confirm").addEventListener("click", confirmDoneModal);
document.getElementById("done-modal-overlay").addEventListener("click", e=>{if(e.target===e.currentTarget)closeDoneModal();});
document.getElementById("dm-action-text").addEventListener("keydown", e=>{if(e.key==="Enter")addDmAction();});

// Wire up dismiss modal buttons
document.getElementById("tri-dismiss-close").addEventListener("click", closeDismissModal);
document.getElementById("tri-dismiss-overlay").addEventListener("click", e => { if (e.target === e.currentTarget) closeDismissModal(); });
document.getElementById("tri-dismiss-trivial").addEventListener("click", () => { if (currentDismissId) dismissTriage(currentDismissId, "", true); });
document.getElementById("tri-dismiss-save").addEventListener("click", () => {
  if (currentDismissId) dismissTriage(currentDismissId, document.getElementById("tri-dismiss-note").value, false);
});

// Wire up notes drawer
document.getElementById("notes-drawer-close").addEventListener("click", closeNotesDrawer);
document.getElementById("notes-drawer-overlay").addEventListener("click", e => { if (e.target === e.currentTarget) closeNotesDrawer(); });
document.getElementById("notes-add-action").addEventListener("click", () => {
  document.getElementById("notes-action-input").style.display = "flex";
  document.getElementById("notes-action-text").focus();
});
document.getElementById("notes-action-cancel").addEventListener("click", () => {
  document.getElementById("notes-action-input").style.display = "none";
  const todayBtn = document.getElementById("notes-action-today");
  todayBtn && todayBtn.classList.remove("active");
  const durSel = document.getElementById("notes-action-dur");
  if (durSel) durSel.style.display = "none";
});
document.getElementById("notes-action-today").addEventListener("click", () => {
  const btn = document.getElementById("notes-action-today");
  const durSel = document.getElementById("notes-action-dur");
  btn.classList.toggle("active");
  if (durSel) durSel.style.display = btn.classList.contains("active") ? "block" : "none";
});
document.getElementById("notes-action-save").addEventListener("click", () => { if (currentNotesTaskId) addActionItem(currentNotesTaskId); });
document.getElementById("notes-action-text").addEventListener("keydown", e => { if (e.key === "Enter" && currentNotesTaskId) addActionItem(currentNotesTaskId); });

// ======== REVIEW BADGE & POPOVER ========
let REVIEWED_KEY = "pa-reviewed-" + (__state ? __state.date : "unknown");
function loadReviewed() { try { return JSON.parse(localStorage.getItem(REVIEWED_KEY) || "{}"); } catch(e) { return {}; } }
function saveReviewed(data) { localStorage.setItem(REVIEWED_KEY, JSON.stringify(data)); scheduleIDBSave(); }

let _reviewCurrent = null;
function openReviewPopover(badge) {
  const pop = document.getElementById("review-popover");
  const id = badge.dataset.reviewId;
  const type = badge.dataset.reviewType; // "task" or "triage"
  const evidence = badge.dataset.evidence || "Auto-detected by sweep";
  const evidenceLink = badge.dataset.evidenceLink || "";

  _reviewCurrent = { id, type, badge };
  document.getElementById("rp-title").textContent = type === "task" ? "Auto-Completed Task" : "Auto-Resolved Triage Item";
  document.getElementById("rp-evidence").textContent = evidence;
  const linkEl = document.getElementById("rp-link");
  if (evidenceLink) { linkEl.href = evidenceLink; linkEl.style.display = "block"; linkEl.textContent = "View evidence \u2192"; }
  else { linkEl.style.display = "none"; }

  const rect = badge.getBoundingClientRect();
  pop.style.top = (rect.bottom + 8) + "px";
  pop.style.left = Math.max(8, Math.min(rect.left - 100, window.innerWidth - 340)) + "px";
  pop.style.display = "block";
}
function closeReviewPopover() {
  document.getElementById("review-popover").style.display = "none";
  _reviewCurrent = null;
}
document.getElementById("rp-confirm").addEventListener("click", function() {
  if (!_reviewCurrent) return;
  const reviewed = loadReviewed();
  reviewed[_reviewCurrent.id] = { confirmed: true, at: new Date().toISOString() };
  saveReviewed(reviewed);
  if (_reviewCurrent.badge) _reviewCurrent.badge.remove();
  closeReviewPopover();
});
document.getElementById("rp-restore").addEventListener("click", function() {
  if (!_reviewCurrent) return;
  const reviewed = loadReviewed();
  reviewed[_reviewCurrent.id] = { confirmed: false, restored: true, at: new Date().toISOString() };
  saveReviewed(reviewed);
  if (_reviewCurrent.type === "task") {
    // Uncheck the task
    manualDone.delete(_reviewCurrent.id);
    delete doneAt[_reviewCurrent.id];
    saveDoneState();
    log("unchecked", _reviewCurrent.id, "Restored from auto-complete");
  }
  closeReviewPopover();
  render();
});
document.addEventListener("click", function(e) {
  if (!e.target.closest(".review-popover") && !e.target.closest(".review-badge")) {
    closeReviewPopover();
  }
});

// ======== TRIAGE RENDERING ========
const TRI_ICONS = {
  unanswered_dm: {cls:"tri-icon-dm", emoji:"\u{1F4AC}"},
  email_needs_response: {cls:"tri-icon-email", emoji:"\u{1F4E7}"},
  slack_mention: {cls:"tri-icon-mention", emoji:"\u{1F514}"},
  calendar_event: {cls:"tri-icon-cal", emoji:"\u{1F4C5}"}
};
function triIcon(type) {
  const t = TRI_ICONS[type] || {cls:"tri-icon-dm", emoji:"\u{2753}"};
  return '<div class="tri-icon '+t.cls+'">'+t.emoji+'</div>';
}
function triEscBadge(esc) {
  const cls = "tri-esc-" + (esc || "normal");
  return '<span class="tri-esc '+cls+'">'+(esc || "normal")+'</span>';
}
function buildTriageCard(item) {
  const dismissed = loadDismissed();
  const isDismissed = !!dismissed[item.id];
  const ageParts = [];
  if (item.cycleCount > 1) ageParts.push("Cycle " + item.cycleCount);
  if (item.firstSeen) {
    const hrs = Math.round((Date.now() - new Date(item.firstSeen).getTime()) / 3600000);
    ageParts.push(hrs > 0 ? hrs + "h ago" : "just now");
  }
  return '<div class="tri-card' + (isDismissed ? ' dismissed' : '') + '" data-tri-id="' + item.id + '">' +
    '<div class="tri-card-header">' +
      '<div class="tri-check' + (isDismissed ? ' dismissed' : '') + '" data-dismiss-id="' + item.id + '" data-dismiss-title="' + (item.title || '').replace(/"/g, '&quot;') + '">\u2713</div>' +
      '<button class="tri-quick" data-dismiss-id="' + item.id + '" title="Quick complete (no notes)">&#9889;</button>' +
      triIcon(item.type) +
      '<span class="tri-title">' + item.title + '</span>' +
      triEscBadge(item.escalation) +
      notesButton({id: item.id, title: item.title}) +
    '</div>' +
    (item.summary ? '<div class="tri-summary">' + item.summary + '</div>' : '') +
    '<div class="tri-meta">' +
      (item.link ? '<a href="' + item.link + '" target="_blank">Open in source</a>' : '') +
      (item.auto_task_url ? '<a href="' + item.auto_task_url + '" target="_blank" style="background:var(--purple-bg);color:var(--purple);padding:1px 6px;border-radius:4px;font-size:9px;font-weight:700;text-decoration:none">TASK</a>' : '') +
      (item.draft_id ? '<span style="background:var(--cyan-bg);color:var(--cyan);padding:1px 6px;border-radius:4px;font-size:9px;font-weight:700">' + (item.draft_type === 'gmail' ? 'DRAFT EMAIL' : 'DRAFT MSG') + '</span>' : '') +
      '<span>' + ageParts.join(' \u00b7 ') + '</span>' +
      (item.notes ? '<span>' + item.notes + '</span>' : '') +
      (isDismissed ? '<span style="color:var(--green)">\u2713 ' + (dismissed[item.id].trivial ? 'Dismissed' : dismissed[item.id].note || 'Resolved') + '</span>' : '') +
    '</div>' +
  '</div>';
}
// Triage parent linking
let TRIAGE_PARENTS_KEY = "pa-triage-parents-" + ((__state && __state.date) || "unknown");
function loadTriageParents(){ try{return JSON.parse(localStorage.getItem(TRIAGE_PARENTS_KEY)||"{}")}catch(e){return{}} }
function saveTriageParents(data){ localStorage.setItem(TRIAGE_PARENTS_KEY,JSON.stringify(data)); scheduleIDBSave(); }

function buildTriage() {
  const dismissed = loadDismissed();
  const triageParents = loadTriageParents();
  const priColors = {high:"var(--red)", medium:"var(--amber)", low:"var(--text-muted)"};

  // Split into active vs completed (dismissed)
  const active = INIT_TRIAGE.filter(i => !dismissed[i.id]);
  const completed = INIT_TRIAGE.filter(i => !!dismissed[i.id]);

  const high = active.filter(i => i.priority === "high");
  const med = active.filter(i => i.priority === "medium");
  const low = active.filter(i => i.priority === "low" || (i.priority !== "high" && i.priority !== "medium"));

  const countEl = document.getElementById("triage-count");
  if (countEl) countEl.textContent = active.length + (completed.length ? " / " + (active.length + completed.length) : "");

  const highEl = document.getElementById("triage-high");
  if (highEl) {
    highEl.innerHTML = high.length ?
      '<div class="tri-group-label"><span class="tri-dot" style="background:var(--red)"></span>High Priority (' + high.length + ')</div>' +
      high.map(buildTriageCard).join('') : '';
  }
  const medEl = document.getElementById("triage-medium");
  if (medEl) {
    medEl.innerHTML = med.length ?
      '<div class="tri-group-label"><span class="tri-dot" style="background:var(--amber)"></span>Medium (' + med.length + ')</div>' +
      med.map(buildTriageCard).join('') : '';
  }
  const lowEl = document.getElementById("triage-low");
  if (lowEl) {
    lowEl.innerHTML = low.length ?
      '<div class="tri-group-label"><span class="tri-dot" style="background:var(--text-muted)"></span>Low / FYI (' + low.length + ')</div>' +
      low.map(buildTriageCard).join('') : '';
  }

  // Completed triage compact rows (between priority groups and resolved)
  let completedEl = document.getElementById("triage-completed");
  if (!completedEl) {
    // Create it if not in DOM yet (insert before resolved section)
    const resEl = document.getElementById("triage-resolved");
    if (resEl) {
      completedEl = document.createElement("div");
      completedEl.id = "triage-completed";
      resEl.parentNode.insertBefore(completedEl, resEl);
    }
  }
  if (completedEl) {
    if (completed.length) {
      completedEl.innerHTML = '<div class="tri-completed-section">' +
        '<div class="tri-completed-label">\u2714 Completed (' + completed.length + ')</div>' +
        completed.map(item => {
          const d = dismissed[item.id] || {};
          const parent = triageParents[item.id];
          const parentTask = parent ? scheduled.find(e => e.id === parent) : null;
          return '<div class="tri-compact-row" data-tri-id="' + item.id + '">' +
            '<span class="tri-compact-chk" data-undo-tri="' + item.id + '" title="Undo — restore to triage">\u2713</span>' +
            '<span class="tri-compact-bar" style="background:' + (priColors[item.priority] || "var(--text-muted)") + '"></span>' +
            '<span class="tri-compact-title">' + item.title + '</span>' +
            (parentTask ? '<span class="tri-compact-parent">' + parentTask.title + '</span>' : '') +
            (d.note ? '<span class="tri-compact-note">' + d.note + '</span>' : '') +
          '</div>';
        }).join('') +
      '</div>';
      // Wire undo clicks
      completedEl.querySelectorAll(".tri-compact-chk").forEach(chk => {
        chk.addEventListener("click", e => {
          e.stopPropagation();
          const id = chk.dataset.undoTri;
          delete dismissed[id];
          saveDismissed(dismissed);
          buildTriage();
        });
      });
    } else {
      completedEl.innerHTML = '';
    }
  }

  // Resolved items
  const resolved = (__state && __state.triage && __state.triage.resolved_items) || [];
  const resEl = document.getElementById("triage-resolved");
  const resCount = document.getElementById("triage-resolved-count");
  if (resCount) resCount.textContent = "(" + resolved.length + ")";
  if (resEl) {
    resEl.innerHTML = resolved.map(r =>
      '<div class="tri-resolved-card" data-tri-id="' + r.id + '">' +
        '<div class="tri-card-header" style="display:flex;align-items:center;gap:8px">' +
          '<div class="tri-title">\u2705 ' + (r.title || r.id || "Resolved item") + '</div>' +
          notesButton({id: r.id, title: r.title || r.id}) +
          (r.needs_review ? '<span class="review-badge" data-review-id="' + r.id + '" data-review-type="triage" data-evidence="' + (r.evidence_summary || '').replace(/"/g, '&quot;') + '" data-evidence-link="' + (r.evidence_link || '').replace(/"/g, '&quot;') + '" title="Auto-resolved -- click to review">Needs Review</span>' : '') +
        '</div>' +
        '<div class="tri-meta">' + (r.notes || r.resolution || "") +
          (r.evidence_summary ? ' <span style="color:var(--text-muted);font-size:10px">\u00b7 ' + r.evidence_summary + '</span>' : '') +
        '</div>' +
      '</div>'
    ).join('');
  }

  // Wire checkmark click handlers (event delegation)
  document.querySelectorAll(".tri-check").forEach(chk => {
    chk.addEventListener("click", e => {
      e.stopPropagation();
      const id = chk.dataset.dismissId;
      const title = chk.dataset.dismissTitle;
      const dismissed = loadDismissed();
      if (dismissed[id]) {
        // Already dismissed -- undismiss
        delete dismissed[id];
        saveDismissed(dismissed);
        buildTriage();
      } else {
        // Open unified completion modal
        openDoneModal(id, title, (noteText)=>{
          dismissTriage(id, noteText||"", false);
        }, null);
      }
    });
  });

  // Wire lightning bolt quick-complete for triage
  document.querySelectorAll(".tri-quick").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const id = btn.dataset.dismissId;
      dismissTriage(id, "", false);
    });
  });

  // Wire notes buttons in triage (event delegation -- triage is rebuilt dynamically)
  document.querySelectorAll("#tab-triage .notes-btn").forEach(nb => {
    nb.addEventListener("click", e => {
      e.stopPropagation();
      openNotesDrawer(nb.dataset.notesId, nb.dataset.notesTitle);
    });
  });

  // Wire review badges in triage
  document.querySelectorAll("#tab-triage .review-badge").forEach(badge => {
    badge.addEventListener("click", e => {
      e.stopPropagation();
      openReviewPopover(badge);
    });
  });

  // Notifications with dismiss support
  const NOTIF_DISMISS_KEY = "pa-notif-dismissed-" + ((__state && __state.date) || "unknown");
  function loadNotifDismissed(){ try{return JSON.parse(localStorage.getItem(NOTIF_DISMISS_KEY)||"[]")}catch(e){return[]} }
  function saveNotifDismissed(ids){ localStorage.setItem(NOTIF_DISMISS_KEY,JSON.stringify(ids)); scheduleIDBSave(); }

  const notifEl = document.getElementById("triage-notifications");
  if (notifEl && INIT_NOTIFICATIONS.length) {
    const dismissedIds = loadNotifDismissed();
    const active = INIT_NOTIFICATIONS.filter(n => !dismissedIds.includes(n.id || n.title));
    const dismissed = INIT_NOTIFICATIONS.filter(n => dismissedIds.includes(n.id || n.title));

    let html = active.map(n => {
      const nid = (n.id || n.title || "").replace(/"/g, '&quot;');
      const needsApproval = n.requires_approval;
      return '<div class="tri-notification' + (needsApproval ? ' requires-approval' : '') + '" data-notif-id="' + nid + '">' +
        '<button class="notif-dismiss" data-notif-dismiss="' + nid + '" title="Dismiss">&times;</button>' +
        '<div class="tri-notif-header">' +
          '<span class="tri-notif-icon">' + (needsApproval ? '\u26a0\ufe0f' : '\u2139\ufe0f') + '</span>' +
          '<span class="tri-notif-title">' + (n.title || n.message || "Notification") + '</span>' +
        '</div>' +
        (n.body || n.detail ? '<div class="tri-notif-body">' + (n.body || n.detail) + '</div>' : '') +
        (n.link ? '<div class="tri-notif-actions"><a href="' + n.link + '" target="_blank" class="tri-notif-btn">Review</a>' +
          (needsApproval ? '<button class="tri-notif-btn approve">Approve</button>' : '') +
        '</div>' : '') +
      '</div>';
    }).join('');

    if (dismissed.length) {
      html += '<div class="notif-dismissed-wrap"><details><summary>Dismissed notifications (' + dismissed.length + ')</summary>' +
        dismissed.map(n => {
          const nid = (n.id || n.title || "").replace(/"/g, '&quot;');
          return '<div class="notif-dismissed-row">' +
            '<span class="ndr-title">' + (n.title || n.message || "Notification") + '</span>' +
            '<button class="ndr-restore" data-notif-restore="' + nid + '">Restore</button>' +
          '</div>';
        }).join('') +
      '</details></div>';
    }

    notifEl.innerHTML = html;

    // Wire dismiss buttons
    notifEl.querySelectorAll(".notif-dismiss").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const ids = loadNotifDismissed();
        ids.push(btn.dataset.notifDismiss);
        saveNotifDismissed(ids);
        buildTriage();
      });
    });
    // Wire restore buttons
    notifEl.querySelectorAll(".ndr-restore").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const ids = loadNotifDismissed().filter(id => id !== btn.dataset.notifRestore);
        saveNotifDismissed(ids);
        buildTriage();
      });
    });
  }
}

