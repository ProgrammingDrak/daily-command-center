let _triageHistoryItems=[];
let _triageHistoryCursor=null;
let _triageHistoryLoaded=false;
let _triageHistoryLoading=false;

function renderTriageHistory(){
  const resEl=document.getElementById("triage-resolved");
  const resCount=document.getElementById("triage-resolved-count");
  const more=document.getElementById("triage-history-more");
  if(resCount)resCount.textContent="("+_triageHistoryItems.length+(_triageHistoryCursor?"+":"")+")";
  if(resEl){
    resEl.innerHTML=_triageHistoryItems.map(row=>{
      const item=row.item_json||{};
      const title=row.title||item.title||row.triage_id||"Resolved item";
      const detail=item.notes||item.resolution||row.resolution||"";
      const at=row.resolved_at?new Date(row.resolved_at).toLocaleString():"";
      return '<div class="tri-resolved-card" data-tri-id="'+DCC.esc(row.triage_id||"")+'">'+
        '<div class="tri-card-header"><div class="tri-title">✅ '+DCC.esc(title)+'</div></div>'+
        '<div class="tri-meta">'+DCC.esc(detail)+(at?' · '+DCC.esc(at):'')+'</div></div>';
    }).join("");
  }
  if(more)more.hidden=!_triageHistoryCursor;
}

async function loadTriageHistory(reset){
  if(_triageHistoryLoading)return;
  _triageHistoryLoading=true;
  try{
    const before=!reset&&_triageHistoryCursor?"&before="+encodeURIComponent(_triageHistoryCursor):"";
    const response=await fetch("/api/triage/history?limit=50"+before);
    if(!response.ok)throw new Error("History request failed");
    const data=await response.json();
    _triageHistoryItems=reset?(data.items||[]):_triageHistoryItems.concat(data.items||[]);
    _triageHistoryCursor=data.nextCursor||null;
    _triageHistoryLoaded=true;
    renderTriageHistory();
  }catch(error){
    const target=document.getElementById("triage-resolved");
    if(target)target.textContent="Could not load resolution history.";
  }finally{_triageHistoryLoading=false;}
}

setTimeout(function(){
  const section=document.getElementById("triage-history-section");
  const more=document.getElementById("triage-history-more");
  if(section)section.addEventListener("toggle",function(){
    if(section.open&&!_triageHistoryLoaded)loadTriageHistory(true);
  });
  if(more)more.addEventListener("click",function(){loadTriageHistory(false);});
},0);

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
    const upcoming=(window.__DCC_UPCOMING__||[]);
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
      '<div class="title-row"><span class="ttl"'+(isDone?' style="text-decoration:line-through"':'')+'>'+DCC.esc(item.title)+'</span></div>'+
      '<div class="meta">'+
        '<span class="'+priCls+'">'+(item.priority||"Medium")+'</span>'+
        (item._sourceLabel?'<span>'+item._sourceLabel+'</span>':'')+
        (age?'<span>'+age+'</span>':'')+
      '</div>'+
    '</div>'+
    '<div class="ai-tab-chk" '+dataAttrs+' style="width:24px;height:24px;border:2px solid var(--border);border-radius:4px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;font-size:12px;'+(isDone?'background:var(--green);border-color:var(--green);color:white':'color:var(--text-muted)')+'">'+(isDone?"\u2713":"")+'</div>'+
    (!isDone?'<button class="add-btn ai-tab-sched-btn" data-ai-title="'+DCC.esc(item.title)+'" '+dataAttrs+'><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 5v14M5 12h14"/></svg> Schedule</button>':'')+
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
  const hasSeedNotes = !hasNotes && typeof seedNoteForTask === "function" && !!seedNoteForTask(ev.id, ev);
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
    stSection.innerHTML=
      '<div class="st-resolve-section blocking">'+
        '<div class="st-resolve-title" id="st-resolve-title">⚠ Resolve '+incomplete.length+' unfinished subtask'+(incomplete.length>1?'s':'')+' before completing</div>'+
        '<div class="st-subtask-list" id="st-subtask-list">'+listHtml+'</div>'+
        '<div class="st-action-row">'+
          '<button class="st-act-btn primary" data-act="complete" title="Mark checked subtasks complete">Mark selected complete</button>'+
          '<button class="st-act-btn" data-act="spinoff" title="Create standalone tasks from checked subtasks">Spin selected into tasks</button>'+
        '</div>'+
        '<div class="st-hint">Unchecked subtasks stay unresolved. Finish this list or cancel parent completion.</div>'+
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
          if(titleEl)titleEl.textContent='⚠ Resolve '+rem+' unfinished subtask'+(rem>1?'s':'')+' before completing';
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
      DCC.TaskModel.selectOpen(scheduled).filter(e => !isMeeting(e) && e.type !== "ooo").map(e =>
        // DCC.esc, matching every other builder in this file. Titles here are not all
        // owner-authored: data.js takes them from the server timeline (calendar summaries,
        // Slack/Notion items, quick-task payloads, guest public-share submissions, which
        // routes/social-todo.js only trims and truncates). Assigning innerHTML on a <select>
        // drops <img>/<svg>, but an <option> start tag IS honoured there, so an unescaped
        // title could inject a live inline handler, and e.id could break out of value="".
        '<option value="' + DCC.esc(String(e.id)) + '"' + (triageParents[id] === e.id ? ' selected' : '') + '>' + DCC.esc(e.title || '') + ' (' + f12(e.start) + ')</option>'
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
  const remainingRows=document.querySelectorAll('#dm-subtask-section .st-subtask-row');
  if(remainingRows.length){
    if(typeof showToast==='function')showToast('Resolve unfinished subtasks before completing the parent task.','error');
    return;
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

// ======== TIME PICKER ========
// Thin wrapper over the shared scroll-wheel picker (time-picker.js). Kept under
// the original name so every existing caller (done-modal sessions, card start
// time, block editor) upgrades to the new wheel with no call-site changes.
// Two modes:
//   openClockPicker("14:30", anchor, cb)  -> external, cb gets "HH:MM"
//   openClockPicker(idx, anchor)          -> done-modal session at _dmSessions[idx]
function openClockPicker(idx,anchor,callback){
  if(typeof openTimeWheel!=='function') return;
  if(callback && typeof idx==='string'){
    openTimeWheel(idx, anchor, callback);
  } else {
    openTimeWheel(_dmSessions[idx].start, anchor, function(timeStr){
      _dmSessions[idx].start=timeStr;
      renderDmSessions();
    });
  }
}

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
const _triageSuppressionInFlight = new Set();
// Advance a Waiting item's check-in cadence by one cycle, through the ONE owner of that
// contract (delegated.js, published on window.DCC.Waiting and already used by
// catch-up.js). This deliberately does not keep a local copy: the stale-key handling is
// subtle -- a naive retry under `expectedCycleKey` completes a cycle the user never saw
// and permanently freezes the cadence -- so a second copy that drifts would silently
// destroy Waiting items. See completeCheckInCycle in delegated.js for the full argument.
async function completeWaitingCycle(waitingItemId, cycleKey, completedAt) {
  const waiting = window.DCC && window.DCC.Waiting;
  if (!waiting || typeof waiting.completeCheckInCycle !== "function") {
    throw new Error("Waiting module unavailable. Reload and try again.");
  }
  const result = await waiting.completeCheckInCycle(waitingItemId, cycleKey, completedAt);
  // A stale result here means the cadence already moved past the cycle this card was
  // rendered from, so there is nothing to advance. Suppressing the stale card is still
  // the right outcome, which is why this resolves instead of throwing.
  return result;
}

async function dismissTriage(triageId, note, trivial) {
  if (_triageSuppressionInFlight.has(triageId)) return false;
  const item=(INIT_TRIAGE||[]).find(i=>i.id===triageId)||{id:triageId,title:"Triage item completed"};
  _triageSuppressionInFlight.add(triageId);
  // Tracked so the failure path can say WHICH half landed. Advancing first is the right
  // order (suppressing first would leave the card hidden while still overdue), but it
  // means a later failure leaves durable cadence movement behind, and mergeTriage will
  // drop the card on the next read anyway. Reporting a flat "could not resolve" there
  // would be a lie, and would invite a re-click that is now a stale submit.
  let cadenceAdvanced = false;
  try {
    const dismissed = loadDismissed();
    const wasDismissed = !!dismissed[triageId];
    const completedAt = new Date().toISOString();
    // A Waiting check-in is one cycle of a recurring reminder. Advance the cadence
    // BEFORE suppressing the card, or the suppression is the only thing holding the
    // item back and the next read re-offers the same overdue cycle forever.
    if (item.waiting_item_id && item.waiting_cycle_key) {
      await completeWaitingCycle(item.waiting_item_id, item.waiting_cycle_key, completedAt);
      cadenceAdvanced = true;
    }
    const saved = await persistTriageSuppression(triageId, item, "done", note || (trivial ? "Dismissed" : ""), trivial);
    dismissed[triageId] = {
      note: note || (trivial ? "Dismissed" : ""),
      dismissed_at: completedAt,
      trivial: !!trivial,
      received_at: item.receivedAt || item.received_at || "",
    };
    saveDismissed(dismissed);
    if (__state && __state.triage && saved && saved.suppression) {
      const list = (__state.triage.suppressed_items || []).filter(s => s.triage_id !== triageId);
      list.push(saved.suppression);
      __state.triage.suppressed_items = list;
    }
    if(!wasDismissed&&window.SlotRewards&&typeof window.SlotRewards.earnTaskCredit==="function"){
      window.SlotRewards.earnTaskCredit(triageTaskPayload(item));
    }
    closeDismissModal();
    if(typeof buildScheduleTriage==="function")buildScheduleTriage();
    buildTriage();
    return true;
  } catch (e) {
    const prefix = cadenceAdvanced
      ? "The check-in cadence advanced, but the Completed record did not save: "
      : "Could not resolve triage item: ";
    if (typeof showToast === "function") showToast(prefix + e.message, "error");
    return false;
  } finally {
    _triageSuppressionInFlight.delete(triageId);
  }
}
// ── Durable triage suppressions ──
//
// Handling a triage item used to be recorded in two places, and neither of them
// held: the day_root block for the date you were looking at (so it expired at
// midnight — clearing 19 items on 2026-08-04 left 2026-08-05 untouched, which is how
// this surfaced on the phone), and `triage.deleted_items` inside a POST of the whole
// client `__state` (which nothing read, and which the next Sweep Suite publish
// overwrote wholesale because `triage` is a full-replace section on that route).
//
// One authority now: dateless suppression rows on the server, applied on the day
// read AND on every ingest. The day_root overlay below is kept as the instant-local
// echo (and the offline fallback) — it just is no longer the thing that has to be
// right tomorrow.
function triageItemKeyFor(item) {
  if (!item) return "";
  const source = item.source || item.type || "unknown";
  return source + "|" + (item.source_id || item.id || item.title || "");
}
async function persistTriageSuppression(triageId, item, reason, note, trivial, opts) {
  opts = opts || {};
  const res = await fetch("/api/triage/suppressions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      triage_id: triageId,
      key: triageItemKeyFor(item),
      title: (item && item.title) || "",
      reason: reason || "done",
      note: note || "",
      trivial: !!trivial,
      conversation_id: item && (item.conversationId || item.conversation_id || item.thread_id || item.threadId) || "",
      received_at: item && (item.receivedAt || item.received_at) || "",
      task_id: opts.taskId || "",
      scheduled_for: opts.scheduledFor || "",
      item: item || null
    })
  });
  if (!res.ok) throw new Error((await res.text()) || ("HTTP " + res.status));
  return res.json();
}
async function removeTriageSuppression(triageId) {
  const date = (__state && __state.date) || "";
  const suffix = date ? ("?date=" + encodeURIComponent(date)) : "";
  const res = await fetch("/api/triage/suppressions/" + encodeURIComponent(triageId) + suffix, {
    method: "DELETE",
    credentials: "same-origin"
  });
  if (!res.ok) throw new Error((await res.text()) || ("HTTP " + res.status));
  return res.json();
}
// Suppressions the server already knows about, keyed by triage id. Read straight off
// the day response so every surface (itinerary strip, tasks drawer, phone) agrees
// without its own fetch.
// Forget the local echo of a server suppression. Two Undo paths need this (the delete
// toast and the Completed row), and the read half next door is already single-sourced;
// a hand-copy is what this feature's server half just finished removing.
function dropLocalSuppressionEcho(triageId) {
  if (!(__state && __state.triage)) return;
  const list = __state.triage.suppressed_items || [];
  __state.triage.suppressed_items = list.filter(s => s.triage_id !== triageId);
}
function serverTriageSuppressions() {
  const list = (__state && __state.triage && __state.triage.suppressed_items) || [];
  const map = {};
  for (const s of list) { if (s && s.triage_id) map[s.triage_id] = s; }
  return map;
}
async function persistTriageDeletion(triageId, item) {
  await persistTriageSuppression(triageId, item, "deleted");
}
async function persistTriageRestore(triageId) {
  return removeTriageSuppression(triageId);
}
async function deleteTriageItem(triageId) {
  if (_triageSuppressionInFlight.has(triageId)) return false;
  const item = (INIT_TRIAGE || []).find(i => i.id === triageId);
  _triageSuppressionInFlight.add(triageId);
  try {
    await persistTriageDeletion(triageId, item);
  } catch (e) {
    if (typeof showToast === "function") showToast("Could not delete triage item: " + e.message, "error");
    _triageSuppressionInFlight.delete(triageId);
    return false;
  }
  _triageSuppressionInFlight.delete(triageId);
  const originalIndex = Math.max(0, (INIT_TRIAGE || []).findIndex(i => i.id === triageId));
  const dismissed = loadDismissed();
  const previousDismissed = dismissed[triageId];
  const scheduledTriage = loadTriageScheduled();
  const previousScheduled = scheduledTriage[triageId];
  INIT_TRIAGE = (INIT_TRIAGE || []).filter(i => i.id !== triageId);
  if (__data && __data.triageItems) __data.triageItems = INIT_TRIAGE;
  if (dismissed[triageId]) { delete dismissed[triageId]; saveDismissed(dismissed); }
  if (scheduledTriage[triageId]) { delete scheduledTriage[triageId]; saveTriageScheduled(scheduledTriage); }
  const deleted = loadDeletedTriage();
  if (!deleted.includes(triageId)) { deleted.push(triageId); saveDeletedTriage(deleted); }
  const triageParents = loadTriageParents();
  const previousParent = triageParents[triageId];
  if (triageParents[triageId]) { delete triageParents[triageId]; saveTriageParents(triageParents); }
  if (typeof showToast === "function") {
    showToast(isWaitingCheckIn(item) ? "Check-in deleted. The delegated task is still open in Waiting" : "Triage item deleted", "success", 8000, {
      label: "Undo",
      onClick: async () => {
        let restoredItem = item;
        try {
          const restored = await persistTriageRestore(triageId);
          if (restored && restored.restored_item) restoredItem = restored.restored_item;
        } catch (e) {
          if (typeof showToast === "function") showToast("Could not restore triage item: " + e.message, "error");
          return;
        }
        if (restoredItem && !(INIT_TRIAGE || []).some(i => i.id === triageId)) {
          INIT_TRIAGE.splice(Math.min(originalIndex, INIT_TRIAGE.length), 0, restoredItem);
        }
        if (__data && __data.triageItems) __data.triageItems = INIT_TRIAGE;
        const nextDismissed = loadDismissed();
        if (previousDismissed) { nextDismissed[triageId] = previousDismissed; saveDismissed(nextDismissed); }
        const nextScheduled = loadTriageScheduled();
        if (previousScheduled) { nextScheduled[triageId] = previousScheduled; saveTriageScheduled(nextScheduled); }
        const nextDeleted = loadDeletedTriage().filter(id => id !== triageId);
        saveDeletedTriage(nextDeleted);
        if (previousParent) {
          const nextParents = loadTriageParents();
          nextParents[triageId] = previousParent;
          saveTriageParents(nextParents);
        }
        // Clear the local echo of the server suppression too. By the time this toast is
        // clickable the delete's own broadcast has usually round-tripped and repopulated
        // __state.triage.suppressed_items, and buildTriage's visibleTriage filter drops
        // any item carrying a "deleted" suppression -- so without this the toast said
        // "restored" and restored nothing.
        dropLocalSuppressionEcho(triageId);
        if (typeof buildScheduleTriage === "function") buildScheduleTriage();
        buildTriage();
        if (typeof buildTaskQueuePanel === "function") buildTaskQueuePanel();
        if (typeof _updateTaskMenusBadge === "function") _updateTaskMenusBadge();
        if (typeof showToast === "function") showToast("Triage item restored", "success", 2200);
      }
    });
  }
  if (typeof buildScheduleTriage === "function") buildScheduleTriage();
  buildTriage();
  if(typeof buildTaskQueuePanel==="function")buildTaskQueuePanel();
  if(typeof _updateTaskMenusBadge==="function")_updateTaskMenusBadge();
  return true;
}

let TRIAGE_DELETED_KEY = "pa-triage-deleted-" + ((__state && __state.date) || "unknown");
function loadDeletedTriage(){
  if (window.USE_BLOCKSTORE && window.blockStore) {
    const v = _bsProp("_triageDeleted", null);
    if (Array.isArray(v)) return v;
  }
  try{return JSON.parse(localStorage.getItem(TRIAGE_DELETED_KEY)||"[]")}catch(e){return[]}
}
function saveDeletedTriage(ids){
  if (_bsSaveProp("_triageDeleted", ids)) return;
  localStorage.setItem(TRIAGE_DELETED_KEY,JSON.stringify(ids)); scheduleIDBSave();
}

// Wire up overflow modal

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
    // Uncheck the task: the row's status, plus any legacy `_done` entry (C5b).
    manualDone.delete(_reviewCurrent.id);
    delete doneAt[_reviewCurrent.id];
    if (typeof _clearRowDone === "function") _clearRowDone(_reviewCurrent.id, { ev: _reviewCurrent });
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
  public_task: {cls:"tri-icon-public", emoji:"+"},
};
function triIcon(type) {
  const t = TRI_ICONS[type] || {cls:"tri-icon-dm", emoji:"\u{2753}"};
  return '<div class="tri-icon '+t.cls+'">'+t.emoji+'</div>';
}
function triEscBadge(esc) {
  const cls = "tri-esc-" + (esc || "normal");
  return '<span class="tri-esc '+cls+'">'+(esc || "normal")+'</span>';
}
function triageReceivedDate(item, nowValue) {
  const raw=item&&(item.receivedAt||item.received_at);
  if(!raw)return null;
  const received=new Date(raw);
  if(isNaN(received.getTime()))return null;
  const now=nowValue?new Date(nowValue):new Date();
  const includeYear=isNaN(now.getTime())||received.getFullYear()!==now.getFullYear();
  const dateText=received.toLocaleDateString("en-US",Object.assign({month:"short",day:"numeric"},includeYear?{year:"numeric"}:{}));
  return {
    label:"Received "+dateText,
    title:"Received "+received.toLocaleString("en-US",{dateStyle:"medium",timeStyle:"short"})
  };
}
function triageReceivedDateHtml(item){
  const received=triageReceivedDate(item);
  return received?'<span title="'+DCC.esc(received.title)+'">'+DCC.esc(received.label)+'</span>':'';
}
// A triage item that came from a Waiting item is a CHECK-IN REMINDER, not the task.
// It carries the shared --waiting hue and a labelled pill (same look as the itinerary
// row, see delegated.js waitingChipHtml) so scheduling, doing, or deleting the
// reminder is never mistaken for closing the delegated task. The pill jumps to the
// Waiting item through the document-level [data-waiting-open] handler.
function isWaitingCheckIn(item){
  return !!(item && (item.waiting_item_id || String(item.source || "").replace(/-/g, "_") === "waiting_checkin"));
}
function waitingCheckInPillHtml(item){
  if(!isWaitingCheckIn(item))return '';
  const who=(item.contact&&(item.contact.name||item.contact.handle))||'';
  const id=item.waiting_item_id||'';
  const tip="Check-in reminder"+(who?" for "+who:"")+
    ": this handles the reminder only. The delegated task stays open in Waiting."+
    (id?" Click to open it.":"");
  const tag=id?"button":"span";
  return '<'+tag+(id?' type="button"':'')+' class="waiting-pill checkin"'+
    (id?' data-waiting-open="'+DCC.esc(id)+'"':'')+
    ' title="'+DCC.esc(tip)+'">&#128276; Check-in</'+tag+'>';
}
function waitingCheckInDeleteTitle(item){
  return isWaitingCheckIn(item)
    ? "Delete this check-in reminder (the delegated task stays open in Waiting)"
    : "Delete triage item";
}
function waitingItemLinkHtml(item, className){
  if(!item||!item.waiting_item_id)return '';
  return '<button type="button" class="'+className+'" data-waiting-item="'+DCC.esc(item.waiting_item_id)+'" title="Open the original Waiting item to schedule, complete, edit, or dismiss the task">Open task</button>';
}
function triageDraftAction(item){
  if(!item)return null;
  const draftHref=window.DCC.safeUrlAttr(item.draft_link||item.draft_url);
  const sourceHref=window.DCC.safeUrlAttr(item.link||item.source_url);
  const hasDraft=!!(item.draft_id||item.draft_preview||draftHref);
  if(!hasDraft)return null;
  if(draftHref)return {kind:"link",href:draftHref,label:"Review and Send"};
  if(sourceHref)return {kind:item.draft_preview?"copy-link":"link",href:sourceHref,label:"Review and Send"};
  if(item.draft_preview)return {kind:"copy",label:"Copy Draft"};
  return {kind:"status",label:"Draft ready"};
}
async function copyTriageDraft(triageId){
  const item=(INIT_TRIAGE||[]).find(entry=>entry.id===triageId);
  const text=item&&item.draft_preview;
  if(!text)return false;
  let copied=false;
  try{
    if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(text);copied=true;}
  }catch(e){}
  if(!copied){
    try{
      const ta=document.createElement("textarea");
      ta.value=text;ta.setAttribute("readonly","");ta.style.position="fixed";ta.style.left="-9999px";
      document.body.appendChild(ta);ta.select();copied=document.execCommand("copy");document.body.removeChild(ta);
    }catch(e){}
  }
  if(typeof showToast==="function")showToast(copied?"Check-in draft copied":"Could not copy draft",copied?"success":"error");
  return copied;
}
async function activateTriageDraftAction(event, element){
  if(event)event.stopPropagation();
  const href=element&&element.getAttribute?window.DCC.safeUrl(element.getAttribute("href")):"";
  if(!href)return copyTriageDraft(element&&element.dataset.copyDraft);
  if(event&&typeof event.preventDefault==="function")event.preventDefault();
  const pending=(typeof window.open==="function")?window.open("about:blank","_blank"):null;
  if(pending)pending.opener=null;
  const copied=await copyTriageDraft(element&&element.dataset.copyDraft);
  if(!copied){
    if(pending&&typeof pending.close==="function")pending.close();
    return false;
  }
  if(pending){pending.location.href=href;return true;}
  const opened=(typeof window.open==="function")?window.open(href,"_blank","noopener"):null;
  if(!opened&&typeof showToast==="function")showToast("Draft copied, but the source could not be opened. Allow popups and try again.","info");
  return !!opened;
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
  const triTypeColors = {unanswered_dm:"#a78bfa",email_needs_response:"#f87171",slack_mention:"#22d3ee"};
  const barColor = isDismissed ? "var(--green)" : (isWaitingCheckIn(item) ? "var(--waiting,#a31c43)" : (triTypeColors[item.type] || "#a78bfa"));
  const priCls = item.priority === "high" ? "pri-hi" : item.priority === "medium" ? "pri-med" : "pri-lo";
  const t = TRI_ICONS[item.type] || {emoji:"\u{2753}"};
  const linkLabel = DCC.esc(item.link_label || item.action_label || "Open");
  const sourceLink = window.DCC.safeUrlAttr(item.link || item.source_url);
  const draftAction = triageDraftAction(item);
  const draftChip = !draftAction ? '' :
    (draftAction.kind === "copy-link"
      ? '<a href="' + draftAction.href + '" target="_blank" rel="noreferrer" class="tri-copy-draft" data-copy-draft="' + DCC.esc(item.id) + '" onclick="event.stopPropagation()" style="background:var(--cyan-bg,rgba(34,211,238,0.1));color:var(--cyan,#22d3ee);padding:1px 6px;border-radius:4px;font-size:9px;font-weight:700;text-decoration:none">Review and Send</a>'
      : draftAction.kind === "link"
        ? '<a href="' + draftAction.href + '" target="_blank" rel="noreferrer" onclick="event.stopPropagation()" style="background:var(--cyan-bg,rgba(34,211,238,0.1));color:var(--cyan,#22d3ee);padding:1px 6px;border-radius:4px;font-size:9px;font-weight:700;text-decoration:none">Review and Send</a>'
        : draftAction.kind === "copy"
          ? '<button type="button" class="tri-copy-draft" data-copy-draft="' + DCC.esc(item.id) + '" style="background:var(--cyan-bg,rgba(34,211,238,0.1));color:var(--cyan,#22d3ee);padding:1px 6px;border:0;border-radius:4px;font-size:9px;font-weight:700;cursor:pointer">Copy Draft</button>'
          : '<span style="background:var(--cyan-bg,rgba(34,211,238,0.1));color:var(--cyan,#22d3ee);padding:1px 6px;border-radius:4px;font-size:9px;font-weight:700">Draft ready</span>');
  return '<div class="board-card' + (isDismissed ? ' board-card-done' : '') + (isWaitingCheckIn(item) ? ' waiting-checkin-card' : '') + '" data-tri-id="' + item.id + '" style="' + (isDismissed ? 'opacity:0.5' : '') + '">' +
    '<div class="bar" style="background:' + barColor + '"></div>' +
    '<div class="body">' +
      '<div class="title-row">' +
        '<span class="ttl">' + t.emoji + ' ' + DCC.esc(item.title) + '</span>' +
        waitingCheckInPillHtml(item) +
        triEscBadge(item.escalation) +
      '</div>' +
      '<div class="meta">' +
        '<span class="' + priCls + '">' + (item.priority || 'medium') + '</span>' +
        (item.queue_label || item.source_label ? '<span>' + DCC.esc(item.queue_label || item.source_label) + '</span>' : '') +
        (sourceLink && !draftAction ? '<a href="' + sourceLink + '" target="_blank" onclick="event.stopPropagation()" style="color:var(--accent-light);text-decoration:none;font-size:10px">' + linkLabel + '</a>' : '') +
        (window.DCC.safeUrlAttr(item.auto_task_url) ? '<a href="' + window.DCC.safeUrlAttr(item.auto_task_url) + '" target="_blank" onclick="event.stopPropagation()" style="background:var(--purple-bg,rgba(168,85,247,0.1));color:var(--purple,#a855f7);padding:1px 6px;border-radius:4px;font-size:9px;font-weight:700;text-decoration:none">TASK</a>' : '') +
        waitingItemLinkHtml(item,'tri-open-waiting') +
        draftChip +
        triageReceivedDateHtml(item) +
        '<span>' + ageParts.join(' \u00b7 ') + '</span>' +
        (isDismissed ? '<span style="color:var(--green)">\u2713 ' + (dismissed[item.id].trivial ? 'Dismissed' : DCC.esc(dismissed[item.id].note || 'Resolved')) + '</span>' : '') +
      '</div>' +
      (item.summary ? '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;line-height:1.4">' + DCC.esc(item.summary) + '</div>' : '') +
    '</div>' +
    notesButton({id: item.id, title: item.title}) +
    '<div class="tri-check' + (isDismissed ? ' dismissed' : '') + '" data-dismiss-id="' + item.id + '" data-dismiss-title="' + (item.title || '').replace(/"/g, '&quot;') + '">\u2713</div>' +
    '<button class="tri-quick" data-dismiss-id="' + item.id + '" title="Quick complete">&#9889;</button>' +
    '<button class="tri-delete-btn" data-delete-tri="' + item.id + '" title="' + DCC.esc(waitingCheckInDeleteTitle(item)) + '" aria-label="Delete triage item">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>' +
    '</button>' +
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

let TRIAGE_SCHEDULED_KEY = "pa-triage-scheduled-" + ((__state && __state.date) || "unknown");
function loadTriageScheduled(){
  if (window.USE_BLOCKSTORE && window.blockStore) {
    const v = _bsProp("_triageScheduled", null);
    if (v) return v;
  }
  try{return JSON.parse(localStorage.getItem(TRIAGE_SCHEDULED_KEY)||"{}")}catch(e){return{}}
}
function saveTriageScheduled(data){
  if (_bsSaveProp("_triageScheduled", data)) return;
  localStorage.setItem(TRIAGE_SCHEDULED_KEY,JSON.stringify(data)); scheduleIDBSave();
}
function triagePriorityLabel(priority){
  const p=String(priority||"medium").toLowerCase();
  if(p==="high"||p==="urgent"||p==="critical")return"High";
  if(p==="low")return"Low";
  return"Medium";
}
// Triage responses are quick by default (a reply, a check) -- default 5 minutes,
// floor 5, and the card carries a picker to bump it up when the case needs more.
function triageDuration(item){
  return Math.max(5,parseInt(item&&(
    item.estimated_minutes||item.estimatedMinutes||item.durMin||item.duration_minutes||item.durationMinutes
  )||5,10)||5);
}
function triageTaskPayload(item){
  const durMin=triageDuration(item);
  return {
    id:"triage-"+(item.id||Date.now()),
    task_id:"triage-"+(item.id||Date.now()),
    title:item.title||"Triage item completed",
    type:"task",
    priority:triagePriorityLabel(item.priority),
    source:"triage",
    tags:["triage"],
    duration_minutes:durMin,
    durMin:durMin,
    urgent:String(item.priority||"").toLowerCase()==="high"
  };
}
function triageCompletionDateKey(value){
  const dt=value instanceof Date?value:new Date(value);
  if(!dt||isNaN(dt))return null;
  return dt.getFullYear()+"-"+String(dt.getMonth()+1).padStart(2,"0")+"-"+String(dt.getDate()).padStart(2,"0");
}
function completedTriageTasksForDate(dateStr){
  const dismissed=typeof loadDismissed==="function"?loadDismissed():{};
  const viewDate=dateStr||((__state&&__state.date)||triageCompletionDateKey(new Date()));
  // The SHARED answer to "what triage got completed on this date": sidebar.js (Done tab
  // + count badge) and schedule-tab.js (Completed Today, and its actual/planned totals)
  // all read it. Deriving it purely from INIT_TRIAGE x the local `dismissed` overlay
  // broke the moment the server started stripping suppressed items out of open_items --
  // the item left INIT_TRIAGE, so this could never emit it and the work disappeared from
  // the Done tab seconds after being marked done. Suppressions fold in HERE rather than
  // at each of the three call sites, so those surfaces cannot drift from the triage panel
  // on what "completed" means.
  const suppressed=serverTriageSuppressions();
  const byId=new Map((INIT_TRIAGE||[]).map(i=>[i.id,i]));
  Object.keys(suppressed).forEach(id=>{
    if(suppressed[id].reason==="done"&&!byId.has(id)){
      byId.set(id,Object.assign({id:id,title:suppressed[id].title||"(handled)",priority:"low"},suppressed[id].item||{}));
    }
  });
  return Array.from(byId.values()).map(item=>{
    const sup=suppressed[item.id];
    const done=dismissed[item.id]||(sup&&sup.reason==="done"?{dismissed_at:sup.at,note:sup.note||"",trivial:!!sup.trivial}:null);
    if(!done||done.trivial)return null;
    const completedAt=done.dismissed_at||done.completed_at||done.at;
    if(triageCompletionDateKey(completedAt)!==viewDate)return null;
    const payload=triageTaskPayload(item);
    return {
      ...payload,
      id:payload.id,
      triageId:item.id,
      title:item.title||payload.title,
      completedAt,
      note:done.note||"",
      receivedAt:item.receivedAt||item.received_at||"",
      source:"triage",
      type:"task",
      durMin:payload.durMin||payload.duration_minutes||30,
      start:(item.start||""),
      end:(item.end||"")
    };
  }).filter(Boolean).sort((a,b)=>new Date(a.completedAt)-new Date(b.completedAt));
}
window.completedTriageTasksForDate=completedTriageTasksForDate;
function triagePointsChip(item){
  const payload=triageTaskPayload(item);
  const scoring=window.TaskPoints&&typeof window.TaskPoints.estimate==="function"
    ? window.TaskPoints.estimate(payload)
    : {eligible:true,awardPoints:(payload.duration_minutes||30),durationMinutes:payload.duration_minutes,effortTier:"medium",attentionTier:"normal",importanceTier:"normal"};
  if(!scoring.eligible||scoring.awardPoints<=0)return"";
  const title="Completing this triage item earns about "+scoring.awardPoints+" points. "+scoring.durationMinutes+"m, "+scoring.effortTier+" effort, "+scoring.attentionTier+" attention, "+(scoring.importanceTier||"normal")+" importance.";
  return '<span class="points-chip'+(scoring.awardPoints>=20?' bonus':'')+'" title="'+title.replace(/"/g,'&quot;')+'">'+scoring.awardPoints+' pts</span>';
}
function currentTriageScheduled(){
  const ledger=__state&&__state.triage&&__state.triage.suppressed_items;
  if(!Array.isArray(ledger))return loadTriageScheduled();
  const links={};
  ledger.forEach(s=>{
    if(s&&s.active!==false&&s.reason==="scheduled"&&s.triage_id){
      links[s.triage_id]={taskId:s.task_id||"",scheduled_at:s.at||"",title:s.title||""};
    }
  });
  return links;
}
function activeTriageItems(){
  const dismissed=loadDismissed();
  // Once the server supplies the durable ledger it is the authority. Keeping the
  // old local scheduled map in the filter forever would hide an item even after
  // its linked task was deleted and the server intentionally released it.
  const scheduledTriage=currentTriageScheduled();
  const deletedTriage=loadDeletedTriage();
  const suppressed=serverTriageSuppressions();
  return (INIT_TRIAGE||[]).filter(i=>!dismissed[i.id]&&!scheduledTriage[i.id]&&!deletedTriage.includes(i.id)&&!suppressed[i.id]);
}
// The task-shaped properties a triage item becomes. Shared by every "put this
// triage item on the schedule" path so the created row is spelled one way.
function triageTaskProps(triageId,item){
  return {
    priority:triagePriorityLabel(item.priority),
    source:"triage",
    source_id:window.DCC.taskSourceUrl(item),
    meta:"Triage item",
    detail:[item.summary,item.notes].filter(Boolean).join("\n\n"),
    tags:["triage"],
    triageId:triageId,
    triageKey:triageItemKeyFor(item),
    triageTitle:item.title||"",
    triageType:item.type||item.source||"",
    triageSourceRef:item.source_ref||item.link||"",
    triageReceivedAt:item.receivedAt||item.received_at||"",
    triageConversationId:item.conversationId||item.conversation_id||item.thread_id||item.threadId||""
  };
}
// Already on the schedule? Two different questions, so two lookups: an exact id
// match, then "is an open, visible triage row already called this". The second
// half is the layer's question.
// dateStr scopes that second lookup: `scheduled` holds only the VIEWED day's rows,
// so a same-titled task sitting on today cannot answer "is this already on
// Thursday". Without the scope, a Tomorrow click reports "already on the schedule"
// and links the item to a task on the wrong day.
function existingTriageTask(triageId,item,dateStr){
  const byId=scheduled.find(ev=>ev.triageId===triageId);
  if(byId)return byId;
  const viewing=(typeof viewDate!=="undefined"&&viewDate)?viewDate:null;
  if(dateStr&&viewing&&dateStr!==viewing)return null;
  return DCC.TaskModel.selectActive(scheduled).find(ev=>ev.source==="triage"&&ev.title===item.title);
}
// Record the triage -> task link and repaint. saveTriageScheduled feeds
// activeTriageItems(), so this is also what makes the item leave the strip.
async function recordTriageScheduled(triageId,item,taskId,toastMsg,opts){
  opts=opts||{};
  try{
    const saved=await persistTriageSuppression(triageId,item,"scheduled","",false,{
      taskId:taskId,
      scheduledFor:opts.scheduledFor||((typeof viewDate!=="undefined"&&viewDate)?viewDate:((__state&&__state.date)||""))
    });
    if(__state&&__state.triage&&saved&&saved.suppression){
      const list=(__state.triage.suppressed_items||[]).filter(s=>s.triage_id!==triageId);
      list.push(saved.suppression);
      __state.triage.suppressed_items=list;
    }
  }catch(e){
    if(typeof showToast==="function")showToast("Task was created, but triage scheduling did not persist: "+e.message,"error",5200);
    return false;
  }
  const st=loadTriageScheduled();
  st[triageId]={taskId:taskId,scheduled_at:new Date().toISOString(),title:item.title};
  saveTriageScheduled(st);
  // Scheduling creates work but does not resolve the inbound message. The local
  // link removes it from this day's strip; only Done, Quick Complete, or Delete
  // writes a durable exact-item resolution.
  if(toastMsg&&typeof showToast==="function")showToast(toastMsg,"success");
  if(opts.deferRepaint||opts.deferRefold)return true;
  buildScheduleTriage();
  buildTriage();
  return true;
}
// Put a triage item on a DATE, no time step. The catch-up modal's Today /
// Tomorrow / calendar-pick all land here: one click, one free slot, done.
// scheduleTaskOnDate (state.js) is the app's canonical create-on-a-target-date —
// same day context and free-slot engine the reschedule compute uses.
// Returns the created (or already-existing) block, or null if nothing was written.
// Returns the block (or the already-linked task) on success and null ONLY when
// nothing was written. Callers treat falsy as "refused, leave the row alone", so a
// path that records the link and then returns null leaves an unclearable row behind
// and a modal that can never auto-close.
async function scheduleTriageOnDate(triageId,dateStr,opts){
  opts=opts||{};
  const item=(INIT_TRIAGE||[]).find(i=>i.id===triageId);
  if(!item||!dateStr)return null;
  const scheduledTriage=currentTriageScheduled();
  if(scheduledTriage[triageId]){
    if(typeof showToast==="function")showToast("Already scheduled","info");
    return scheduledTriage[triageId];   // already handled: the row should go
  }
  const existing=existingTriageTask(triageId,item,dateStr);
  if(existing){
    const linked=await recordTriageScheduled(triageId,item,existing.id,null,Object.assign({},opts,{scheduledFor:dateStr}));
    if(!linked)return null;
    if(typeof showToast==="function")showToast("Already on the schedule","info");
    return existing;                     // the link WAS written
  }
  if(typeof scheduleTaskOnDate!=="function")return null;
  const durMin=triageDuration(item);
  const ev=Object.assign({
    id:"triage-task-"+triageId,
    title:item.title||"Triage item",
    type:"task",
    start:"00:00",
    end:"00:"+String(Math.min(59,durMin)).padStart(2,"0"),
    durMin:durMin
  },triageTaskProps(triageId,item));
  // silent:true so this owns the success copy -- which means it also owns the FAILURE
  // copy. Without the toast below a packed day makes Today look like a dead button:
  // the row's buttons flicker disabled and nothing else happens anywhere.
  const label=(typeof _prettyDateLabel==="function")?_prettyDateLabel(dateStr):dateStr;
  const block=await scheduleTaskOnDate(ev,dateStr,{useExisting:true,silent:true});
  if(!block){
    if(!opts.silent&&typeof showToast==="function")showToast("No free slot on "+label+"'s schedule","error");
    return null;
  }
  const bp=block.properties||{};
  // Landing on the day being VIEWED means the itinerary has to be refolded, or the
  // new row exists on the server and nowhere on screen until a reload. Same four
  // calls delegated.js makes after its scheduleTaskOnDate, for the same reason.
  // deferRefold lets a batch caller ("Move all to today") pay for this once at the
  // end instead of per item, the same contract DCC.Carryover.moveTo already offers.
  const viewing=(typeof viewDate!=="undefined"&&viewDate)?viewDate:((typeof __state!=="undefined"&&__state)?__state.date:null);
  if(dateStr===viewing&&!opts.deferRefold){
    try{ await window.blockStore.loadDay(dateStr); }catch(e){}
    if(typeof reloadPersistedEdits==="function")reloadPersistedEdits();
    if(typeof recalcTimes==="function")recalcTimes();
    if(typeof render==="function")render();
  }
  const at=(bp.start&&typeof f12==="function")?(" at "+f12(bp.start)):"";
  const linked=await recordTriageScheduled(triageId,item,bp.local_id||block.id,opts.silent?null:("Scheduled "+label+at),Object.assign({},opts,{scheduledFor:dateStr}));
  if(!linked)return null;
  return block;
}
async function scheduleTriageItem(triageId){
  const item=(INIT_TRIAGE||[]).find(i=>i.id===triageId);
  if(!item)return;
  const scheduledTriage=currentTriageScheduled();
  if(scheduledTriage[triageId]){
    if(typeof showToast==="function")showToast("Already scheduled","info");
    return;
  }
  const existing=existingTriageTask(triageId,item);
  if(existing){
    if(await recordTriageScheduled(triageId,item,existing.id,null)&&typeof showToast==="function")showToast("Already on the schedule","info");
    return;
  }
  // Reuse the shared task scheduler -- the same day/time + duration picker the
  // tasks below and repeat responsibilities use. Default 5m (triageDuration); the
  // picker's duration buttons bump it up when the case needs more.
  const durMin=triageDuration(item);
  const opts=triageTaskProps(triageId,item);
  const record=async function(taskId){ return recordTriageScheduled(triageId,item,taskId,"Triage item scheduled"); };
  if(typeof openSchedulePicker==="function"){
    openSchedulePicker(item.title,durMin,Object.assign({},opts,{
      onScheduled:async function(info){ await record(info&&(info.localId||info.blockId)); }
    }));
    return;
  }
  // Fallback if the picker markup isn't present: schedule directly.
  const newTask=insertTaskFromDrawer(item.title,durMin,opts);
  await record(newTask&&newTask.id);
}
window.scheduleTriageOnDate=scheduleTriageOnDate;
window.activeTriageItems=activeTriageItems;
function buildScheduleTriageCard(item){
  const pri=triagePriorityLabel(item.priority);
  const priCls=pri==="High"?"pri-hi":pri==="Low"?"pri-lo":"pri-med";
  // A check-in reminder is coloured by WHAT IT IS, not by the priority it inherited
  // from its Waiting item -- that is the whole point of the shared --waiting hue.
  const barColor=isWaitingCheckIn(item)?"var(--waiting,#a31c43)":(pri==="High"?"var(--red)":pri==="Low"?"var(--text-muted)":"var(--amber)");
  const safeTitle=(item.title||"Triage item").replace(/"/g,'&quot;');
  // Scheme-allowlist the draft/source URLs: they come from the sweep, so never
  // let a javascript:/data: URI reach an href.
  // safeUrlAttr, not safeUrl: these land straight in an href, and the scheme check
  // alone does not stop a swept URL from closing the attribute and opening an
  // event handler. Same helper the catch-up modal's row link uses.
  const srcHref=window.DCC.safeUrlAttr(item.link||item.source_url);
  const draftAction=triageDraftAction(item);
  const scheduleDraftAction=!draftAction?'':
    (draftAction.kind==="copy-link"
      ? '<a href="'+draftAction.href+'" target="_blank" rel="noreferrer" class="schedule-triage-copy" data-copy-draft="'+DCC.esc(item.id)+'" onclick="event.stopPropagation()" style="color:var(--green);text-decoration:none;font-weight:600">Review and Send</a>'
      : draftAction.kind==="link"
        ? '<a href="'+draftAction.href+'" target="_blank" rel="noreferrer" onclick="event.stopPropagation()" style="color:var(--green);text-decoration:none;font-weight:600">Review and Send</a>'
        : draftAction.kind==="copy"
          ? '<button type="button" class="schedule-triage-copy" data-copy-draft="'+DCC.esc(item.id)+'" style="border:0;background:transparent;color:var(--green);font:inherit;font-weight:600;cursor:pointer;padding:0">Copy Draft</button>'
          : '<span style="color:var(--green);font-weight:600">Draft ready</span>');
  return '<div class="board-card schedule-triage-card'+(isWaitingCheckIn(item)?' waiting-checkin-card':'')+'" data-schedule-triage-id="'+item.id+'">'+
    '<div class="bar" style="background:'+barColor+'"></div>'+
    '<div class="body">'+
      '<div class="title-row"><span class="ttl" title="'+safeTitle+'">'+DCC.esc(item.title||"Triage item")+'</span>'+waitingCheckInPillHtml(item)+triEscBadge(item.escalation)+'</div>'+
      '<div class="meta"><span class="'+priCls+'">'+pri+'</span>'+triagePointsChip(item)+triageReceivedDateHtml(item)+'<span>'+ms(triageDuration(item))+'</span>'+
        (srcHref&&!draftAction?'<a href="'+srcHref+'" target="_blank" rel="noreferrer" onclick="event.stopPropagation()" style="color:var(--accent-light);text-decoration:none">'+DCC.esc(item.link_label||item.action_label||"Open")+'</a>':'')+
        waitingItemLinkHtml(item,'schedule-triage-open-waiting')+
        scheduleDraftAction+
      '</div>'+
      (item.summary?'<div class="schedule-triage-summary">'+DCC.esc(item.summary)+'</div>':'')+
      (item.draft_preview?'<div class="schedule-triage-summary" style="border-left:2px solid var(--green);padding-left:8px;opacity:.9">'+DCC.esc(item.draft_preview)+'</div>':'')+
    '</div>'+
    '<button class="add-btn schedule-triage-schedule" data-triage-id="'+item.id+'">Schedule</button>'+
    '<button class="add-btn schedule-triage-done" data-triage-id="'+item.id+'" data-triage-title="'+safeTitle+'" style="background:rgba(34,197,94,0.15);color:var(--green)">Done</button>'+
    '<button class="tri-quick schedule-triage-quick" data-triage-id="'+item.id+'" title="Quick complete">&#9889;</button>'+
    '<button class="tri-delete-btn schedule-triage-delete" data-triage-id="'+item.id+'" title="'+DCC.esc(waitingCheckInDeleteTitle(item))+'" aria-label="Delete triage item">'+
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>'+
    '</button>'+
  '</div>';
}
// Virtual card for a due repeat responsibility (see getDueRepeatResponsibilities
// in responsibilities.js). It is NOT a real triage item — it's a live view of a
// responsibility whose cadence is coming due. The "Recurring" chip (and the 🐚
// shell chip) mark it apart from swept triage items.
function buildRecurringTriageCard(r){
  const barColor=(r.overdue||r.score>=85)?"var(--red)":(r.score>=70?"var(--amber)":"var(--accent-light)");
  const safeTitle=DCC.esc(r.title||"Recurring");
  // .tri-esc's pill sizing is CSS-scoped to .tri-card-header, which these cards
  // aren't under — inline the pill shape so they match the escalation-chip look;
  // the tri-esc-* modifier still supplies the (unscoped) background color.
  const chipStyle='font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;padding:2px 7px;border-radius:100px';
  const shellChip=r.isShell?'<span class="tri-esc tri-esc-attention" style="'+chipStyle+'" title="Drops a saved shell of '+r.childCount+' task'+(r.childCount===1?'':'s')+'">&#128026; '+r.childCount+'</span>':'';
  return '<div class="board-card schedule-triage-card recurring-triage-card" data-resp-id="'+r.id+'">'+
    '<div class="bar" style="background:'+barColor+'"></div>'+
    '<div class="body">'+
      '<div class="title-row"><span class="ttl" title="'+safeTitle+'">'+DCC.esc(r.title||"Recurring")+'</span>'+
        '<span class="tri-esc tri-esc-normal" style="'+chipStyle+'" title="Recurring responsibility">&#128260; Recurring</span>'+shellChip+'</div>'+
      '<div class="meta"><span>'+r.cadenceLabel+'</span><span>'+r.dueLabel+'</span><span>'+ms(r.estimatedMinutes)+'</span></div>'+
    '</div>'+
    '<button class="add-btn resp-triage-add" data-resp-id="'+r.id+'">Schedule</button>'+
    '<button class="add-btn resp-triage-done" data-resp-id="'+r.id+'" style="background:rgba(34,197,94,0.15);color:var(--green)">Done</button>'+
    // Skip is deliberately distinct from Done: it hides the item until its next
    // occurrence WITHOUT claiming it was done, so Drake stops having to lie about
    // having finished something to make a card go away. Server-side and
    // cross-device, unlike the browser-local one-day snooze it replaces.
    '<button class="add-btn resp-triage-skip" data-resp-id="'+r.id+'" style="background:rgba(234,179,8,0.15);color:var(--amber)" title="Skip this cycle (not done, just not now)">Skip</button>'+
    '<button class="tri-quick resp-triage-pause" data-resp-id="'+r.id+'" title="Pause this responsibility">&#9208;</button>'+
  '</div>';
}
function buildScheduleTriage(){
  const el=document.getElementById("schedule-triage-section");
  if(!el)return;
  const items=activeTriageItems();
  const recurring=(typeof window.getDueRepeatResponsibilities==="function")?window.getDueRepeatResponsibilities():[];
  if((!items.length&&!recurring.length)||schedView!=="list"){
    el.style.display="none";
    el.innerHTML="";
    return;
  }
  el.style.display="";
  // Swept triage items first (external, genuinely time-sensitive), then the
  // recurring responsibilities coming due — each tagged so the two don't blur.
  el.innerHTML=
    '<div class="schedule-triage-header">'+
      '<div><span class="schedule-triage-kicker">Triage</span><span class="schedule-triage-count">'+(items.length+recurring.length)+'</span></div>'+
      '<span class="schedule-triage-sub">Needs attention before it disappears into the day</span>'+
    '</div>'+
    '<div class="schedule-triage-list">'+items.map(buildScheduleTriageCard).join('')+recurring.map(buildRecurringTriageCard).join('')+'</div>';
  el.querySelectorAll(".resp-triage-add").forEach(btn=>{
    btn.addEventListener("click",e=>{e.stopPropagation();if(typeof window.scheduleRepeatResponsibility==="function")window.scheduleRepeatResponsibility(btn.dataset.respId);});
  });
  el.querySelectorAll(".resp-triage-done").forEach(btn=>{
    btn.addEventListener("click",e=>{e.stopPropagation();if(typeof window.completeRepeatResponsibility==="function")window.completeRepeatResponsibility(btn.dataset.respId);});
  });
  el.querySelectorAll(".resp-triage-skip").forEach(btn=>{
    btn.addEventListener("click",e=>{e.stopPropagation();if(typeof window.skipRepeatResponsibility==="function")window.skipRepeatResponsibility(btn.dataset.respId);});
  });
  el.querySelectorAll(".resp-triage-pause").forEach(btn=>{
    btn.addEventListener("click",e=>{e.stopPropagation();if(typeof window.pauseRepeatResponsibility==="function")window.pauseRepeatResponsibility(btn.dataset.respId,null);});
  });
  el.querySelectorAll(".schedule-triage-schedule").forEach(btn=>{
    btn.addEventListener("click",e=>{e.stopPropagation();scheduleTriageItem(btn.dataset.triageId);});
  });
  el.querySelectorAll(".schedule-triage-done").forEach(btn=>{
    btn.addEventListener("click",e=>{
      e.stopPropagation();
      openDoneModal(btn.dataset.triageId,btn.dataset.triageTitle,(noteText)=>dismissTriage(btn.dataset.triageId,noteText||"",false),null);
    });
  });
  el.querySelectorAll(".schedule-triage-delete").forEach(btn=>{
    btn.addEventListener("click",e=>{e.stopPropagation();deleteTriageItem(btn.dataset.triageId);});
  });
  el.querySelectorAll(".schedule-triage-quick").forEach(btn=>{
    btn.addEventListener("click",e=>{e.stopPropagation();dismissTriage(btn.dataset.triageId,"",false);});
  });
  el.querySelectorAll(".schedule-triage-copy").forEach(btn=>{
    btn.addEventListener("click",e=>{activateTriageDraftAction(e,btn);});
  });
  el.querySelectorAll(".schedule-triage-open-waiting").forEach(btn=>{
    btn.addEventListener("click",e=>{
      e.stopPropagation();
      if(typeof window.openWaitingItem==="function")window.openWaitingItem(btn.dataset.waitingItem);
    });
  });
  // NOTE: .schedule-triage-delete is wired ONCE, above. A second identical pass
  // used to live here, so one click ran deleteTriageItem twice — two day-state
  // POSTs and two independent Undo toasts for one item.
}

function buildScheduled() {
  const el = document.getElementById("scheduled-board");
  if (!el) return;

  const today = __state && __state.date ? __state.date : new Date().toISOString().split("T")[0];
  const todayLabel = new Date(today + "T12:00:00").toLocaleDateString("en-US", {weekday:"long", month:"short", day:"numeric"});
  const nowMins = now();
  const activeAll = DCC.TaskModel.selectNotDeleted(scheduled);
  const active = (typeof taskBankMatches==="function")
    ? activeAll.filter(ev=>taskBankMatches(ev,["title","detail","priority","source","meta"]))
    : activeAll;
  const needsReview = active.filter(ev => pt(ev.start) < nowMins && !isDone(ev));
  const rest = active.filter(ev => pt(ev.start) >= nowMins || isDone(ev));

  let html = "";

  if (needsReview.length) {
    html += '<div style="margin-bottom:16px">';
    html += '<div class="tri-group-label"><span class="tri-dot" style="background:var(--amber)"></span>Needs Review <span style="opacity:0.6;font-weight:400;font-size:10px">(past · incomplete)</span></div>';
    needsReview.forEach(ev => {
      const c = cfg(ev.type);
      const bountyCount = typeof getBountyCountForTask === "function" ? getBountyCountForTask(ev.id) : ((typeof isBountyTask === "function" && isBountyTask(ev.id)) ? 1 : 0);
      const isBounty = bountyCount > 0;
      const bountyMeta = typeof getBountyMetaForTask === "function" ? getBountyMetaForTask(ev.id) : { hasSponsor: false, sponsorName: "" };
      const bountySponsorAttr = bountyMeta.hasSponsor ? ' bounty-chip-sponsor" title="' + ("Bounty from " + (bountyMeta.sponsorName || "a visitor")).replace(/"/g, "&quot;") + '"' : '"';
      const bountyPlaced = typeof hasSelfBounty === "function" ? hasSelfBounty() : !!(typeof getDailyBounty === "function" && getDailyBounty());
      const canEditBounty = typeof viewMode === "undefined" || viewMode !== "archive";
      html +=
        '<div class="board-card" style="margin-bottom:6px">' +
          '<div class="bar" style="background:' + c.color + '"></div>' +
          '<div class="body">' +
            '<div class="title-row"><span class="ttl">' + ev.title + '</span>' + (isBounty ? '<span class="bounty-chip' + bountySponsorAttr + '>Bounty x' + Math.pow(2, bountyCount) + '</span>' : '') + '</div>' +
            '<div class="meta"><span class="tag ' + c.cls + '">' + c.tag + '</span><span>' + f12(ev.start) + ' – ' + f12(ev.end) + '</span><span>' + ms(dur(ev)) + '</span></div>' +
          '</div>' +
          (!isMeeting(ev) && canEditBounty && (!bountyPlaced || isBounty) ? '<button class="add-btn sched-bounty-btn" data-id="' + ev.id + '" style="background:rgba(251,191,36,0.12);color:var(--amber)">Bounty</button>' : '') +
          '<button class="add-btn sched-repeat-btn" data-id="' + ev.id + '" title="Turn into a repeat responsibility">Repeat</button>' +
          '<button class="add-btn sched-done-btn" data-id="' + ev.id + '" style="background:rgba(34,197,94,0.15);color:var(--green)">Done</button>' +
          '<button class="add-btn sched-push-btn" data-id="' + ev.id + '">Priority</button>' +
          '<button class="add-btn sched-backlog-btn" data-id="' + ev.id + '" style="background:rgba(255,255,255,0.06);color:var(--text-muted)">Backlog and Ideas</button>' +
        '</div>';
    });
    html += '</div>';
  }

  if (rest.length) {
    html += '<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:8px">' + todayLabel + '</div>';
    rest.forEach(ev => {
      const c = cfg(ev.type);
      const done = isDone(ev);
      const bountyCount = typeof getBountyCountForTask === "function" ? getBountyCountForTask(ev.id) : ((typeof isBountyTask === "function" && isBountyTask(ev.id)) ? 1 : 0);
      const isBounty = bountyCount > 0;
      const bountyMeta = typeof getBountyMetaForTask === "function" ? getBountyMetaForTask(ev.id) : { hasSponsor: false, sponsorName: "" };
      const bountySponsorTitle = bountyMeta.hasSponsor ? ' title="' + ("Bounty from " + (bountyMeta.sponsorName || "a visitor")).replace(/"/g, "&quot;") + '"' : '';
      html +=
        '<div class="board-card" style="margin-bottom:6px;' + (done ? 'opacity:0.4;' : '') + '">' +
          '<div class="bar" style="background:' + c.color + '"></div>' +
          '<div class="body">' +
            '<div class="title-row"><span class="ttl"' + (done ? ' style="text-decoration:line-through"' : '') + '>' + ev.title + '</span>' + (isBounty ? '<span class="bounty-chip' + (done ? ' done' : '') + (bountyMeta.hasSponsor ? ' bounty-chip-sponsor' : '') + '"' + bountySponsorTitle + '>Bounty x' + Math.pow(2, bountyCount) + '</span>' : '') + '</div>' +
            '<div class="meta"><span class="tag ' + c.cls + '">' + c.tag + '</span><span>' + f12(ev.start) + ' – ' + f12(ev.end) + '</span><span>' + ms(dur(ev)) + '</span></div>' +
          '</div>' +
          '<button class="add-btn sched-repeat-btn" data-id="' + ev.id + '" title="Turn into a repeat responsibility">Repeat</button>' +
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
  el.querySelectorAll(".sched-bounty-btn").forEach(btn => {
    btn.addEventListener("click", () => { if(typeof placeBounty === "function") placeBounty(btn.dataset.id); });
  });
  el.querySelectorAll(".sched-repeat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const ev = scheduled.find(e => e.id === btn.dataset.id);
      if (ev && typeof openRepeatResponsibilityFromTask === "function") openRepeatResponsibilityFromTask(ev);
    });
  });
  el.querySelectorAll(".sched-push-btn").forEach(btn => {
    btn.addEventListener("click", () => { pushTask(btn.dataset.id); });
  });
  // C4: one backlog mechanic. This used to be its own copy of the day → backlog move,
  // and it was the WORSE of the two: it minted a `bl-<timestamp>` row and only added the
  // original to `deletedSet`, never removing it — so the task ended up as TWO live rows,
  // one dateless copy in the drawer and the original still sitting on its day behind a
  // client-side hide. moveTaskToBacklog re-dates the single real row instead.
  el.querySelectorAll(".sched-backlog-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (typeof moveTaskToBacklog === "function") moveTaskToBacklog(btn.dataset.id);
    });
  });

  const badge = document.getElementById("scheduled-count");
  if (badge) { badge.textContent = needsReview.length; badge.style.display = needsReview.length ? "" : "none"; }
}

// The Priority section's badge. Its "Pushed from Schedule" card list is DELETED (C3):
// a pushed task is now simply a task on tomorrow, so there is nothing on this day to
// list and nothing to "Restore to schedule" (the origin day's amber Rescheduled-away
// entry owns that). The Repeat affordance those cards carried is not lost — the row
// radial, the details modal and the backlog all reach openRepeatResponsibilityFromTask.
//
// The count is `consider` alone now. It was `pushed.length + consider.length`, but that
// line sat AFTER an early `return` taken whenever nothing was pushed — so on any normal
// day this badge never updated at all. Counting what the section actually shows is the
// fix, and it is why the number can differ from before.
function buildScheduleSoon() {
  const badge=document.getElementById("soon-count");
  if(!badge)return;
  const soonCount=(typeof consider!=="undefined"&&Array.isArray(consider))?consider.length:0;
  badge.textContent=soonCount;
  badge.style.display=soonCount?"":"none";
}
function buildTriage() {
  const dismissed = loadDismissed();
  const triageParents = loadTriageParents();
  const priColors = {high:"var(--red)", medium:"var(--amber)", low:"var(--text-muted)"};
  const deletedTriage = loadDeletedTriage();

  // Split into active vs completed (dismissed)
  const scheduledTriage = currentTriageScheduled();
  // A server suppression outranks every local overlay: it is the record that survived
  // the day and the sweep. A "deleted" one is gone outright; a "done" one still owes
  // the user a Completed row with an Undo, same as a locally-dismissed item.
  const suppressed = serverTriageSuppressions();
  const visibleTriage = INIT_TRIAGE.filter(i => !deletedTriage.includes(i.id) && !(suppressed[i.id] && suppressed[i.id].reason === "deleted"));
  const active = visibleTriage.filter(i => !dismissed[i.id] && !scheduledTriage[i.id] && !suppressed[i.id]);
  const completed = visibleTriage.filter(i => !!dismissed[i.id] || (suppressed[i.id] && suppressed[i.id].reason === "done"));
  // Items handled in another tab (or earlier today, before a reload) are no longer in
  // INIT_TRIAGE at all -- the server strips them from open_items -- so the Completed
  // list has to be rebuilt from the suppression records themselves or the Undo
  // affordance vanishes with them. `suppressed_items` arrives already scoped to the day
  // being viewed (triage-suppressions.js), which is what keeps this list from growing
  // into every item ever handled.
  const inInit = new Set(INIT_TRIAGE.map(i => i.id));
  const completedRemote = Object.keys(suppressed)
    .filter(id => !inInit.has(id) && suppressed[id].reason === "done")
    .map(id => Object.assign({ id: id, title: suppressed[id].title || "(handled)", priority: "low", _remote: true, _note: suppressed[id].note || "" }, suppressed[id].item || {}));

  const high = active.filter(i => i.priority === "high");
  const med = active.filter(i => i.priority === "medium");
  const low = active.filter(i => i.priority === "low" || (i.priority !== "high" && i.priority !== "medium"));

  const countEl = document.getElementById("triage-count");
  // Count what the section actually renders, remote rows included -- otherwise a day
  // whose completions all came from another device shows a bare active count above a
  // "Completed (7)" block.
  const completedRows = completed.concat(completedRemote);
  if (countEl) countEl.textContent = active.length + (completedRows.length ? " / " + (active.length + completedRows.length) : "");

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
    if (completedRows.length) {
      completedEl.innerHTML = '<div class="tri-completed-section">' +
        '<div class="tri-completed-label">✔ Completed (' + completedRows.length + ')</div>' +
        completedRows.map(item => {
          const d = dismissed[item.id] || {};
          const note = d.note || item._note || (suppressed[item.id] && suppressed[item.id].note) || "";
          const parent = triageParents[item.id];
          const parentTask = parent ? scheduled.find(e => e.id === parent) : null;
          // DCC.esc on every interpolated value, attribute positions included. Triage
          // titles are third-party text (swept Gmail subjects, Slack message bodies),
          // and a suppression now PERSISTS one server-side, so an unescaped title here
          // would re-execute on every device on every load rather than living and dying
          // in the one tab that dismissed it. There is no CSP to fall back on.
          return '<div class="tri-compact-row" data-tri-id="' + DCC.esc(item.id) + '">' +
            '<span class="tri-compact-chk" data-undo-tri="' + DCC.esc(item.id) + '" title="Undo — restore to triage">✓</span>' +
            '<span class="tri-compact-bar" style="background:' + (priColors[item.priority] || "var(--text-muted)") + '"></span>' +
            '<span class="tri-compact-title">' + DCC.esc(item.title) + '</span>' +
            (parentTask ? '<span class="tri-compact-parent">' + DCC.esc(parentTask.title) + '</span>' : '') +
            (note ? '<span class="tri-compact-note">' + DCC.esc(note) + '</span>' : '') +
          '</div>';
        }).join('') +
      '</div>';
      // Wire undo clicks. Undo clears BOTH records or the row is back on the next
      // render: the local overlay is what this tab reads, the server suppression is
      // what every other surface, and tomorrow, reads.
      completedEl.querySelectorAll(".tri-compact-chk").forEach(chk => {
        chk.addEventListener("click", async e => {
          e.stopPropagation();
          const id = chk.dataset.undoTri;
          let restoredItem = null;
          if (suppressed[id]) {
            try {
              const restored = await removeTriageSuppression(id);
              restoredItem = restored && restored.restored_item;
            } catch (err) {
              if (typeof showToast === "function") showToast("Could not restore triage item: " + err.message, "error");
              return;
            }
          }
          delete dismissed[id];
          saveDismissed(dismissed);
          if (restoredItem && !(INIT_TRIAGE || []).some(item => item.id === id)) {
            INIT_TRIAGE.push(restoredItem);
            if (__data) __data.triageItems = INIT_TRIAGE;
          }
          if (suppressed[id]) {
            dropLocalSuppressionEcho(id);
            // The item's own fields return on a fresh day read: raw day state was kept
            // intact while the read-time suppression hid it.
            if (typeof window.refreshDccStateFromServer === "function") window.refreshDccStateFromServer();
          }
          buildTriage();
        });
      });
    } else {
      completedEl.innerHTML = '';
    }
  }

  if (typeof renderTriageHistory === "function") renderTriageHistory();

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
      if (!id) return;
      dismissTriage(id, "", false);
    });
  });

  document.querySelectorAll(".tri-copy-draft").forEach(btn => {
    btn.addEventListener("click", e => {
      activateTriageDraftAction(e, btn);
    });
  });

  document.querySelectorAll(".tri-open-waiting").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      if (typeof window.openWaitingItem === "function") window.openWaitingItem(btn.dataset.waitingItem);
    });
  });

  document.querySelectorAll(".tri-delete-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      deleteTriageItem(btn.dataset.deleteTri || btn.dataset.triageId);
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

  // Notifications with dismiss support.
  //
  // Two defects made the dismiss button a no-op, and they compounded:
  //
  //   1. saveNotifDismissed returned before writing whenever every USE_BLOCKSTORE
  //      flag was true -- and index.html sets all eleven to true. The early return
  //      was a hand-off to a blockstore path that was never built, so the click
  //      wrote no day_root property, no localStorage, nothing. buildTriage() then
  //      re-read an empty list and the row was back before the click finished.
  //      Restore was equally inert.
  //   2. The key written was never the key compared. The write used
  //      `(n.id || n.title || "")`, which is "" for an id-less notification, while
  //      the filter compared `includes(n.id || n.title)`, i.e. undefined. Real
  //      sweep-calendar "[ACTION NEEDED]" payloads carry only `message` -- no id
  //      and no title -- so identity was undefined for exactly the rows that
  //      matter most, and a shared "" would have collapsed them into one anyway.
  //
  // notifKey is now the single derivation both halves call, so they cannot drift, and
  // the record lives on the day_root block with localStorage kept only as the offline
  // fallback. `notifications` is a full-replace section on the ingest route, so the
  // record deliberately does NOT live in day state.
  //
  // Scope, stated honestly: this is cross-DEVICE but still day-SCOPED, because
  // _bsSaveProp writes the day_root of the day being viewed. notifKey itself is
  // deliberately day-independent, so a recurring sweep payload republished tomorrow
  // hashes to the same key and WILL be re-offered on that day. That is the residual
  // half of this bug, and the fix is the dateless decision row that
  // triage-suppressions.js already argues for (kind="triage_suppression" and friends),
  // not another day_root flag. Deferred deliberately rather than half-built here.
  const NOTIF_DISMISS_PROP = "_notifDismissed";
  const NOTIF_DISMISS_KEY = "pa-notif-dismissed-" + ((__state && __state.date) || "unknown");
  // Local on purpose. slots.js has a byte-identical hash, but it seeds an RNG -- that is
  // coincidental implementation, not shared semantics, and core.js's bar is 2+ real
  // consumers of the same MEANING. What matters here is that the derivation feeding the
  // persisted key has exactly ONE definition, and it does: notifKey below is the only
  // place a notification identity is derived anywhere in the app.
  function notifHash(text){
    let hash = 0;
    for(let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    return Math.abs(hash);
  }
  // Stable identity for a notification. Prefers an explicit id, then falls back to a
  // hash over the fields the sweep actually sends, so an id-less row still gets a
  // key that is unique to it and identical on every device and every render.
  function notifKey(n){
    if(!n) return "";
    if(n.id) return String(n.id);
    const parts = [n.source||"", n.timestamp||"", n.title||"", n.message||""].join("|");
    return "nh:" + notifHash(parts);
  }
  function loadNotifDismissed(){
    const durable = (typeof _bsProp === "function") ? _bsProp(NOTIF_DISMISS_PROP, null) : null;
    if(Array.isArray(durable)) return durable.map(String);
    try{return JSON.parse(localStorage.getItem(NOTIF_DISMISS_KEY)||"[]").map(String)}catch(e){return[]}
  }
  function saveNotifDismissed(ids){
    const list = Array.from(new Set((ids||[]).map(String).filter(Boolean)));
    const wrote = (typeof _bsSaveProp === "function") ? _bsSaveProp(NOTIF_DISMISS_PROP, list) : false;
    if(wrote) return;
    try{ localStorage.setItem(NOTIF_DISMISS_KEY,JSON.stringify(list)); }catch(e){}
    if(typeof scheduleIDBSave === "function") scheduleIDBSave();
  }

  const notifEl = document.getElementById("triage-notifications");
  if (notifEl && INIT_NOTIFICATIONS.length) {
    const dismissedIds = loadNotifDismissed();
    const active = INIT_NOTIFICATIONS.filter(n => !dismissedIds.includes(notifKey(n)));
    const dismissed = INIT_NOTIFICATIONS.filter(n => dismissedIds.includes(notifKey(n)));

    let html = active.map(n => {
      // Everything interpolated below is sweep-supplied third-party text (mail subjects,
      // Slack bodies, calendar summaries), so it goes through the canonical escaper and
      // the link is restricted to http(s) to keep a javascript: URI out of the href.
      const nid = DCC.esc(notifKey(n));
      const needsApproval = n.requires_approval;
      const safeLink = /^https?:\/\//i.test(String(n.link || "")) ? DCC.esc(n.link) : "";
      return '<div class="tri-notification' + (needsApproval ? ' requires-approval' : '') + '" data-notif-id="' + nid + '">' +
        '<button class="notif-dismiss" data-notif-dismiss="' + nid + '" title="Dismiss">&times;</button>' +
        '<div class="tri-notif-header">' +
          '<span class="tri-notif-icon">' + (needsApproval ? '\u26a0\ufe0f' : '\u2139\ufe0f') + '</span>' +
          '<span class="tri-notif-title">' + DCC.esc(n.title || n.message || "Notification") + '</span>' +
        '</div>' +
        (n.body || n.detail ? '<div class="tri-notif-body">' + DCC.esc(n.body || n.detail) + '</div>' : '') +
        (safeLink ? '<div class="tri-notif-actions"><a href="' + safeLink + '" target="_blank" rel="noopener noreferrer" class="tri-notif-btn">Review</a>' +
          (needsApproval ? '<button class="tri-notif-btn approve">Approve</button>' : '') +
        '</div>' : '') +
      '</div>';
    }).join('');

    if (dismissed.length) {
      html += '<div class="notif-dismissed-wrap"><details><summary>Dismissed notifications (' + dismissed.length + ')</summary>' +
        dismissed.map(n => {
          const nid = DCC.esc(notifKey(n));
          return '<div class="notif-dismissed-row">' +
            '<span class="ndr-title">' + DCC.esc(n.title || n.message || "Notification") + '</span>' +
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
