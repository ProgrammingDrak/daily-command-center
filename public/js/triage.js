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
    list.innerHTML='<div class="board-empty">No action items yet. They\'ll appear here when you add follow-ups from meetings, triage, or the task bar.</div>';
    return;
  }

  let html='';
  if(open.length){
    html+='<div style="margin-bottom:12px"><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:6px">Open ('+open.length+')</div>';
    html+=open.map(item=>buildAITabCard(item)).join('');
    html+='</div>';
  }
  if(done.length){
    html+='<div><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:6px">Completed ('+done.length+')</div>';
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
  const priCls=item.priority==="High"?"pri-hi":item.priority==="Low"?"pri-lo":"pri-med";
  const barColor=isDone?"var(--green)":item.priority==="High"?"#ef4444":item.priority==="Low"?"#64748b":"#a78bfa";
  const dataAttrs='data-ai-id="'+item.id+'" data-ai-source="'+(item._source||"")+'" data-ai-task-id="'+(item._taskId||"")+'" data-ai-idx="'+(item._idx!=null?item._idx:"")+'"';
  return '<div class="board-card'+(isDone?" board-card-done":"")+'" style="'+(isDone?"opacity:0.5":"")+'" data-ai-id="'+item.id+'">'+
    '<div class="bar" style="background:'+barColor+'"></div>'+
    '<div class="body">'+
      '<div class="title-row"><span class="ttl"'+(isDone?' style="text-decoration:line-through"':'')+'>'+item.title+'</span></div>'+
      '<div class="meta">'+
        '<span class="'+priCls+'">'+(item.priority||"Medium")+'</span>'+
        (item._sourceLabel?'<span>'+item._sourceLabel+'</span>':'')+
        (age?'<span>'+age+'</span>':'')+
      '</div>'+
    '</div>'+
    '<div class="ai-tab-chk" '+dataAttrs+' style="width:24px;height:24px;border:2px solid var(--border);border-radius:4px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;font-size:12px;'+(isDone?'background:var(--green);border-color:var(--green);color:white':'color:var(--text-muted)')+'">'+(isDone?"\u2713":"")+'</div>'+
    (!isDone?'<button class="add-btn ai-tab-sched-btn" data-ai-title="'+item.title.replace(/"/g,'&quot;')+'" '+dataAttrs+'><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 5v14M5 12h14"/></svg> Schedule</button>':'')+
    '<button class="btn-del-task ai-tab-del-btn" '+dataAttrs+' title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>'+
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

function addAITabItem(titleArg, priorityArg){
  const title=titleArg||"";
  if(!title)return;
  const priority=priorityArg||"High";
  const pending=loadPendingTasks();
  pending.push({
    id:"pending-"+(Date.now()),
    title:title,
    priority:priority,
    source_task:"Task bar",
    source_task_id:"taskbar",
    created_at:new Date().toISOString(),
    status:"queued"
  });
  savePendingTasks(pending);
  buildActionItemsTab();
}

// Notes button builder for timeline cards
function notesButton(ev) {
  const notes = loadNotes();
  const actions = loadActions();
  const n = notes[ev.id];
  const hasNotes = n && (typeof n === "string" ? n.trim() : (n.text && n.text.trim()));
  const hasSeedNotes = !hasNotes && typeof calendarSeedNoteForTask === "function" && !!calendarSeedNoteForTask(ev.id, ev);
  const actionItems = actions[ev.id] || [];
  const hasActions = actionItems.length > 0;
  const openCount = actionItems.filter(a => !a.done).length;
  let cls = "notes-btn";
  if (hasActions) cls += " has-actions";
  else if (hasNotes || hasSeedNotes) cls += " has-notes";
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
  // Pre-populate notes via block editor
  const notes=loadNotes();
  const noteVal=notes[id];
  const dmNotesContainer=document.getElementById("dm-notes-editor");
  let dmNoteBlocks=typeof noteBlocksForTask === "function" ? noteBlocksForTask(id, noteVal, ev) : null;
  if(window._dmBlockEditor) window._dmBlockEditor.destroy();
  window._dmBlockEditor=createBlockEditor(dmNotesContainer, dmNoteBlocks);
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
    } else if(typeof pomoState!=="undefined" && pomoState.taskTime && pomoState.taskTime[title] > 0){
      const pomoSec=pomoState.taskTime[title];
      const pomoMin=Math.max(1,Math.round(pomoSec/60));
      _dmSessions=[{start:ev.start, durationMin:pomoMin, isPlanned:false, isFromTimer:true}];
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
    const listHtml=incomplete.map((st,i)=>{
      const sid=st.id||('sub-'+i);
      return '<label class="st-subtask-row" data-sub-id="'+sid+'">'+
        '<input type="checkbox" class="st-subtask-chk" data-sub-id="'+sid+'" checked>'+
        '<span class="st-subtask-text">'+st.text+'</span>'+
      '</label>';
    }).join('');
    const moveOpts=scheduled
      .filter(e=>!isMeeting(e)&&!isDone(e)&&e.id!==id)
      .map(e=>'<option value="'+e.id+'">'+e.title+' ('+f12(e.start)+')</option>')
      .join('');
    stSection.innerHTML=
      '<div class="st-resolve-section">'+
        '<div class="st-resolve-title" id="st-resolve-title">⚠ '+incomplete.length+' subtask'+(incomplete.length>1?'s':'')+' not completed</div>'+
        '<div class="st-subtask-list" id="st-subtask-list">'+listHtml+'</div>'+
        '<div class="st-action-row">'+
          '<button class="st-act-btn" data-act="discard" title="Remove checked subtasks">Discard</button>'+
          '<button class="st-act-btn" data-act="individual" title="Schedule each as its own task">Schedule each</button>'+
          '<button class="st-act-btn" data-act="grouped" title="Create one task from all checked">Group into task</button>'+
          '<button class="st-act-btn" data-act="move" title="Add as subtasks of another task">Move to task ›</button>'+
        '</div>'+
        '<div class="st-move-row" id="st-move-row" style="display:none">'+
          '<select class="st-move-select" id="st-move-select">'+
            '<option value="">Pick a task…</option>'+
            moveOpts+
          '</select>'+
          '<button class="st-move-confirm-btn" id="st-move-confirm">Move</button>'+
        '</div>'+
        '<div class="st-hint">Unchecked subtasks are discarded when you mark complete.</div>'+
      '</div>';
    stSection.style.display="";

    function getCheckedIds(){
      return [...stSection.querySelectorAll('.st-subtask-chk:checked')].map(el=>el.dataset.subId);
    }
    function removeRows(subIds){
      subIds.forEach(sid=>{
        const row=stSection.querySelector('.st-subtask-row[data-sub-id="'+sid+'"]');
        if(row)row.remove();
      });
      const rem=stSection.querySelectorAll('.st-subtask-chk').length;
      if(!rem){stSection.innerHTML='';stSection.style.display='none';}
      else{
        const titleEl=document.getElementById('st-resolve-title');
        if(titleEl)titleEl.textContent='⚠ '+rem+' subtask'+(rem>1?'s':'')+' not completed';
      }
    }
    stSection.querySelectorAll('.st-act-btn').forEach(btn=>{
      btn.addEventListener('click',()=>{
        const act=btn.dataset.act;
        if(act==='move'){
          const mr=document.getElementById('st-move-row');
          if(mr)mr.style.display=mr.style.display==='none'?'':'none';
          return;
        }
        const ids=getCheckedIds();
        if(!ids.length){if(typeof showToast==='function')showToast('Check at least one subtask first.');return;}
        executeSubtaskResolution(id,act,ids);
        removeRows(ids);
      });
    });
    const moveBtn=document.getElementById('st-move-confirm');
    if(moveBtn){
      moveBtn.addEventListener('click',()=>{
        const targetId=document.getElementById('st-move-select').value;
        if(!targetId){if(typeof showToast==='function')showToast('Pick a target task first.');return;}
        const ids=getCheckedIds();
        if(!ids.length){if(typeof showToast==='function')showToast('Check at least one subtask first.');return;}
        executeSubtaskResolution(id,'move',ids,targetId);
        removeRows(ids);
        const mr=document.getElementById('st-move-row');
        if(mr)mr.style.display='none';
      });
    }
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
  setTimeout(()=>{if(window._dmBlockEditor)window._dmBlockEditor.focus()},80);
}
function closeDoneModal(){
  document.getElementById("done-modal-overlay").classList.remove("open");
  _dmId=null; _dmCallback=null; _dmEv=null; _dmSessions=[];
  if(typeof _flushDeferredRender==='function')_flushDeferredRender();
}
function confirmDoneModal(){
  if(!_dmId)return;
  // Capture notes from block editor
  const notes=loadNotes();
  if(window._dmBlockEditor && !window._dmBlockEditor.isEmpty()){
    const blocks=window._dmBlockEditor.getBlocks();
    notes[_dmId]={blocks:blocks, html:window._dmBlockEditor.toHtml(), text:window._dmBlockEditor.toMarkdown()};
  } else { delete notes[_dmId]; }
  saveNotes(notes);
  const text=notes[_dmId]?notes[_dmId].text:"";
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
  // Discard any subtasks still shown in the list (unhandled ones are implicitly discarded on completion)
  const remainingRows=document.querySelectorAll('#dm-subtask-section .st-subtask-row');
  if(remainingRows.length){
    const allSubs=loadSubtasks();
    if(allSubs[_dmId]){allSubs[_dmId]=allSubs[_dmId].map(s=>({...s,done:true}));saveSubtasks(allSubs);}
  }
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
    const planned=s.isPlanned?' is-planned':s.isFromTimer?' is-timer':'';
    const badge=s.isPlanned?'<span class="dm-sess-badge">Planned</span>':s.isFromTimer?'<span class="dm-sess-badge" style="background:var(--green);color:#000">Timer</span>':'';
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
let _clockIdx=null,_clockH=12,_clockM=0,_clockMode='hour',_clockCallback=null;
function openClockPicker(idx,anchor,callback){
  _clockIdx=idx;
  _clockCallback=callback||null;
  // Support both done-modal sessions (idx into _dmSessions) and external callers (callback with initial time)
  if(_clockCallback && typeof idx==='string'){
    // External mode: idx is a time string like "14:30"
    const parts=idx.split(':').map(Number);
    _clockH=parts[0];_clockM=parts[1];
  } else {
    const parts=_dmSessions[idx].start.split(':').map(Number);
    _clockH=parts[0];_clockM=parts[1];
  }
  _clockMode='hour';
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
  _clockIdx=null;_clockCallback=null;
}
function confirmClockPicker(){
  if(_clockIdx===null)return;
  const timeStr=String(_clockH).padStart(2,'0')+':'+String(_clockM).padStart(2,'0');
  if(_clockCallback){
    // External caller (e.g. card start time picker)
    _clockCallback(timeStr);
    closeClockPicker();
  } else {
    // Done-modal session mode
    _dmSessions[_clockIdx].start=timeStr;
    closeClockPicker();
    renderDmSessions();
  }
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
    // AM/PM toggle: both options visible side-by-side, active one in accent.
    const ampm=document.createElement('div');
    ampm.className='dm-clock-ampm';
    ampm.style.left=(cx-26)+'px';
    ampm.style.top=(cy-9)+'px';
    const isPM=_clockH>=12;
    const am=document.createElement('span');
    am.className='dm-clock-ampm-opt'+(isPM?'':' active');
    am.textContent='AM';
    am.addEventListener('click',function(e){e.stopPropagation();if(_clockH>=12){_clockH-=12;renderClockFace();}});
    const pm=document.createElement('span');
    pm.className='dm-clock-ampm-opt'+(isPM?' active':'');
    pm.textContent='PM';
    pm.addEventListener('click',function(e){e.stopPropagation();if(_clockH<12){_clockH+=12;renderClockFace();}});
    ampm.appendChild(am);
    ampm.appendChild(pm);
    nums.appendChild(ampm);
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
      el.addEventListener('click',function(){_clockM=m;confirmClockPicker()});
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
      el.addEventListener('click',function(){_clockM=m;confirmClockPicker()});
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
        '<span class="ai-sched-btn" onclick="event.stopPropagation();scheduleActionToday(\''+id+'\','+idx+')" title="Add to today\'s schedule">Urgent</span>')+
      (item._notionQueued?'<span class="ai-sched-btn later queued">Queued</span>':
        '<span class="ai-sched-btn later" onclick="event.stopPropagation();queueActionForLater(\''+id+'\','+idx+')" title="Queue for Priority review">Schedule</span>')+
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
  const wasDismissed = !!dismissed[triageId];
  dismissed[triageId] = { note: note || (trivial ? "Trivial -- dismissed" : ""), dismissed_at: new Date().toISOString(), trivial: !!trivial };
  saveDismissed(dismissed);
  if(!wasDismissed&&window.SlotRewards&&typeof window.SlotRewards.earnTaskCredit==="function"){
    const item=(INIT_TRIAGE||[]).find(i=>i.id===triageId)||{id:triageId,title:"Triage item completed"};
    window.SlotRewards.earnTaskCredit({id:"triage-"+triageId,title:item.title||"Triage item completed"});
  }
  closeDismissModal();
  buildTriage();
}

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
  const taskBar = document.getElementById("task-add-notes");
  if (taskBar) taskBar.style.display = "none";
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

// Create-task bar inside the notes drawer. The .task-add-bar markup is
// auto-wired to addTaskUniversal at script load (schedule.js); here we just
// toggle visibility and collapse the bar after a successful add.
(function wireNotesCreateTask(){
  const bar = document.getElementById("task-add-notes");
  const btn = document.getElementById("notes-create-task");
  if (!bar || !btn) return;
  const titleInp = bar.querySelector(".tab-title");
  const addBtn = bar.querySelector(".tab-add");
  btn.addEventListener("click", () => {
    const visible = bar.style.display !== "none";
    if (visible) { bar.style.display = "none"; return; }
    bar.style.display = "flex";
    document.getElementById("notes-action-input").style.display = "none";
    titleInp && titleInp.focus();
  });
  // addTaskUniversal clears .tab-title on success and adds .tab-error on
  // empty input. Run after it (microtask) and collapse the bar if the input
  // was cleared.
  const collapseIfAdded = () => {
    Promise.resolve().then(() => {
      if (titleInp && !titleInp.value && !titleInp.classList.contains("tab-error")) {
        bar.style.display = "none";
      }
    });
  };
  addBtn && addBtn.addEventListener("click", collapseIfAdded);
  titleInp && titleInp.addEventListener("keydown", e => { if (e.key === "Enter") collapseIfAdded(); });
})();

// ======== REVIEW BADGE & POPOVER ========
let REVIEWED_KEY = "pa-reviewed-" + (__state ? __state.date : "unknown");
function loadReviewed() {
  if (window.USE_BLOCKSTORE && window.blockStore) {
    const v = _bsProp("_reviewed", null);
    if (v) return v;
  }
  try { return JSON.parse(localStorage.getItem(REVIEWED_KEY) || "{}"); } catch(e) { return {}; }
}
function saveReviewed(data) {
  if (_bsSaveProp("_reviewed", data)) return;
  localStorage.setItem(REVIEWED_KEY, JSON.stringify(data)); scheduleIDBSave();
}

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
  const triTypeColors = {unanswered_dm:"#a78bfa",email_needs_response:"#f87171",slack_mention:"#22d3ee",calendar_event:"#f97316"};
  const barColor = isDismissed ? "var(--green)" : (triTypeColors[item.type] || "#a78bfa");
  const priCls = item.priority === "high" ? "pri-hi" : item.priority === "medium" ? "pri-med" : "pri-lo";
  const t = TRI_ICONS[item.type] || {emoji:"\u{2753}"};
  return '<div class="board-card' + (isDismissed ? ' board-card-done' : '') + '" data-tri-id="' + item.id + '" style="' + (isDismissed ? 'opacity:0.5' : '') + '">' +
    '<div class="bar" style="background:' + barColor + '"></div>' +
    '<div class="body">' +
      '<div class="title-row">' +
        '<span class="ttl">' + t.emoji + ' ' + item.title + '</span>' +
        triEscBadge(item.escalation) +
      '</div>' +
      '<div class="meta">' +
        '<span class="' + priCls + '">' + (item.priority || 'medium') + '</span>' +
        (item.link ? '<a href="' + item.link + '" target="_blank" onclick="event.stopPropagation()" style="color:var(--accent-light);text-decoration:none;font-size:10px">Open</a>' : '') +
        (item.auto_task_url ? '<a href="' + item.auto_task_url + '" target="_blank" onclick="event.stopPropagation()" style="background:var(--purple-bg,rgba(168,85,247,0.1));color:var(--purple,#a855f7);padding:1px 6px;border-radius:4px;font-size:9px;font-weight:700;text-decoration:none">TASK</a>' : '') +
        (item.draft_id ? '<span style="background:var(--cyan-bg,rgba(34,211,238,0.1));color:var(--cyan,#22d3ee);padding:1px 6px;border-radius:4px;font-size:9px;font-weight:700">' + (item.draft_type === 'gmail' ? 'DRAFT' : 'MSG') + '</span>' : '') +
        '<span>' + ageParts.join(' \u00b7 ') + '</span>' +
        (isDismissed ? '<span style="color:var(--green)">\u2713 ' + (dismissed[item.id].trivial ? 'Dismissed' : dismissed[item.id].note || 'Resolved') + '</span>' : '') +
      '</div>' +
      (item.summary ? '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;line-height:1.4">' + item.summary + '</div>' : '') +
    '</div>' +
    notesButton({id: item.id, title: item.title}) +
    '<div class="tri-check' + (isDismissed ? ' dismissed' : '') + '" data-dismiss-id="' + item.id + '" data-dismiss-title="' + (item.title || '').replace(/"/g, '&quot;') + '">\u2713</div>' +
    '<button class="tri-quick" data-dismiss-id="' + item.id + '" title="Quick complete">&#9889;</button>' +
  '</div>';
}
// Triage parent linking
let TRIAGE_PARENTS_KEY = "pa-triage-parents-" + ((__state && __state.date) || "unknown");
function loadTriageParents(){
  if (window.USE_BLOCKSTORE && window.blockStore) {
    const v = _bsProp("_triageParents", null);
    if (v) return v;
  }
  try{return JSON.parse(localStorage.getItem(TRIAGE_PARENTS_KEY)||"{}")}catch(e){return{}}
}
function saveTriageParents(data){
  if (_bsSaveProp("_triageParents", data)) return;
  localStorage.setItem(TRIAGE_PARENTS_KEY,JSON.stringify(data)); scheduleIDBSave();
}

function buildScheduled() {
  const el = document.getElementById("scheduled-board");
  if (!el) return;

  const today = __state && __state.date ? __state.date : new Date().toISOString().split("T")[0];
  const todayLabel = new Date(today + "T12:00:00").toLocaleDateString("en-US", {weekday:"long", month:"short", day:"numeric"});
  const nowMins = now();
  const active = scheduled.filter(ev => !isDeleted(ev) && !isPushed(ev));
  const needsReview = active.filter(ev => pt(ev.start) < nowMins && !isDone(ev));
  const rest = active.filter(ev => pt(ev.start) >= nowMins || isDone(ev));

  let html = "";

  if (needsReview.length) {
    html += '<div style="margin-bottom:16px">';
    html += '<div class="tri-group-label"><span class="tri-dot" style="background:var(--amber)"></span>Needs Review <span style="opacity:0.6;font-weight:400;font-size:10px">(past · incomplete)</span></div>';
    needsReview.forEach(ev => {
      const c = cfg(ev.type);
      html +=
        '<div class="board-card" style="margin-bottom:6px">' +
          '<div class="bar" style="background:' + c.color + '"></div>' +
          '<div class="body">' +
            '<div class="title-row"><span class="ttl">' + ev.title + '</span></div>' +
            '<div class="meta"><span class="tag ' + c.cls + '">' + c.tag + '</span><span>' + f12(ev.start) + ' – ' + f12(ev.end) + '</span><span>' + ms(dur(ev)) + '</span></div>' +
          '</div>' +
          '<button class="add-btn sched-done-btn" data-id="' + ev.id + '" style="background:rgba(34,197,94,0.15);color:var(--green)">Done</button>' +
          '<button class="add-btn sched-push-btn" data-id="' + ev.id + '">Priority</button>' +
          '<button class="add-btn sched-backlog-btn" data-id="' + ev.id + '" style="background:rgba(255,255,255,0.06);color:var(--text-muted)">Backlog</button>' +
        '</div>';
    });
    html += '</div>';
  }

  if (rest.length) {
    html += '<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:8px">' + todayLabel + '</div>';
    rest.forEach(ev => {
      const c = cfg(ev.type);
      const done = isDone(ev);
      html +=
        '<div class="board-card" style="margin-bottom:6px;' + (done ? 'opacity:0.4;' : '') + '">' +
          '<div class="bar" style="background:' + c.color + '"></div>' +
          '<div class="body">' +
            '<div class="title-row"><span class="ttl"' + (done ? ' style="text-decoration:line-through"' : '') + '>' + ev.title + '</span></div>' +
            '<div class="meta"><span class="tag ' + c.cls + '">' + c.tag + '</span><span>' + f12(ev.start) + ' – ' + f12(ev.end) + '</span><span>' + ms(dur(ev)) + '</span></div>' +
          '</div>' +
        '</div>';
    });
  }

  if (!needsReview.length && !rest.length) {
    html = '<div class="board-empty">Nothing on today\'s schedule yet.</div>';
  }

  el.innerHTML = html;

  el.querySelectorAll(".sched-done-btn").forEach(btn => {
    btn.addEventListener("click", () => { toggleDone(btn.dataset.id); render(); });
  });
  el.querySelectorAll(".sched-push-btn").forEach(btn => {
    btn.addEventListener("click", () => { pushTask(btn.dataset.id); });
  });
  el.querySelectorAll(".sched-backlog-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const ev = scheduled.find(e => e.id === id);
      if (!ev) return;
      const entry={id:"bl-"+Date.now(),title:ev.title,type:ev.type||"task",durMin:dur(ev),
        meta:ms(dur(ev))+" · from schedule",detail:ev.detail||"",source:ev.source||"manual",
        notionUrl:ev.notionUrl||"",priority:ev.priority||"Low",stage:"Backlog"};
      backlog.push(entry);
      if(typeof persistBacklogItem==="function")persistBacklogItem(entry);
      deletedSet.add(id);saveDeletedState();render();
    });
  });

  const badge = document.getElementById("scheduled-count");
  if (badge) { badge.textContent = needsReview.length; badge.style.display = needsReview.length ? "" : "none"; }
}

function buildScheduleSoon() {
  const list=document.getElementById("soon-pushed-list");
  if(!list)return;
  const pushed=scheduled.filter(ev=>isPushed(ev));
  if(!pushed.length){list.innerHTML='';return}
  list.innerHTML='<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:8px">Pushed from Schedule</div>'+
    pushed.map(ev=>{
      const c=cfg(ev.type);
      return '<div class="board-card" style="margin-bottom:6px">'+
        '<div class="bar" style="background:'+c.color+'"></div>'+
        '<div class="body">'+
          '<div class="title-row"><span class="ttl">'+ev.title+'</span></div>'+
          '<div class="meta"><span class="tag '+c.cls+'">'+c.tag+'</span><span>'+ms(dur(ev))+'</span><span>pushed from schedule</span></div>'+
        '</div>'+
        '<button class="add-btn" onclick="unpushTask(\''+ev.id+'\');render()" title="Restore to schedule" style="background:rgba(34,197,94,0.15);color:var(--green)">Restore</button>'+
      '</div>';
    }).join('');
  // Update badge
  const soonCount=pushed.length+consider.length;
  const badge=document.getElementById("soon-count");
  if(badge){badge.textContent=soonCount;badge.style.display=soonCount?"":"none"}
}
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
  document.querySelectorAll("#tm-triage .notes-btn").forEach(nb => {
    nb.addEventListener("click", e => {
      e.stopPropagation();
      openNotesDrawer(nb.dataset.notesId, nb.dataset.notesTitle);
    });
  });

  // Wire review badges in triage
  document.querySelectorAll("#tm-triage .review-badge").forEach(badge => {
    badge.addEventListener("click", e => {
      e.stopPropagation();
      openReviewPopover(badge);
    });
  });

  // Notifications with dismiss support
  const NOTIF_DISMISS_KEY = "pa-notif-dismissed-" + ((__state && __state.date) || "unknown");
  function loadNotifDismissed(){ try{return JSON.parse(localStorage.getItem(NOTIF_DISMISS_KEY)||"[]")}catch(e){return[]} }
  function saveNotifDismissed(ids){ if(window.USE_BLOCKSTORE&&Object.values(window.USE_BLOCKSTORE).every(v=>v))return; localStorage.setItem(NOTIF_DISMISS_KEY,JSON.stringify(ids)); scheduleIDBSave(); }

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

