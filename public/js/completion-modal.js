// Shared itinerary, triage and Working Queue completion dialog.
let _dmCallback=null, _dmId=null, _dmEv=null, _dmSessions=[], _dmOptions=null, _dmBusy=false, _dmOpener=null;

function openDoneModal(id, title, onConfirm, ev, options){
  if(_dmBusy)return;
  _dmOptions=options||null;_dmOpener=document.activeElement;
  document.getElementById("done-modal-confirm").textContent="Mark Complete";
  const overlay=document.getElementById('done-modal-overlay');
  if(!overlay.dataset.keyboardBound){
    overlay.dataset.keyboardBound='true';overlay.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeDoneModal();return;}
      if(event.key!=='Tab')return;
      const focusable=Array.from(overlay.querySelectorAll('button,input,select,textarea,[contenteditable=true],[tabindex="0"]')).filter(el=>!el.disabled&&el.getClientRects().length);
      const first=focusable[0],last=focusable.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    });
  }
  document.getElementById("dm-queue-section")?.remove();
  if(options?.body){options.body.id="dm-queue-section";document.querySelector(".done-modal-body").prepend(options.body);}
  _dmId=id; _dmCallback=onConfirm; _dmEv=ev||null;
  document.getElementById("done-modal-title").textContent="Complete: "+title;
  // Pre-populate notes via block editor
  const notes=loadNotes();
  const noteVal=options&&Object.prototype.hasOwnProperty.call(options,'noteValue')?options.noteValue:notes[id];
  const dmNotesContainer=document.getElementById("dm-notes-editor");
  let dmNoteBlocks=typeof noteBlocksForTask === "function" ? noteBlocksForTask(id, noteVal, ev) : null;
  if(window._dmBlockEditor) window._dmBlockEditor.destroy();
  window._dmBlockEditor=createBlockEditor(dmNotesContainer, dmNoteBlocks,window.DCC.TaskSources.editorOptions(dmNotesContainer,ev||{}));
  if(_dmOptions)_dmOptions.noteSnapshot=JSON.stringify(window._dmBlockEditor.getBlocks());
  // Pre-populate action items
  document.getElementById("dm-action-input").style.display="none";
  renderDmActions(id);
  // Time sessions section
  const timeSection=document.getElementById("dm-time-section");
  if(ev && ev.start && ev.end && !options?.authoritativeTime){
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
  overlay.tabIndex=-1;overlay.focus({preventScroll:true});
  setTimeout(()=>{if(_dmId===id&&overlay.classList.contains('open')&&window._dmBlockEditor)window._dmBlockEditor.focus()},80);
}
function closeDoneModal(){
  if(_dmBusy)return;
  document.getElementById("dm-queue-section")?.remove();
  _dmOptions=null;
  if(_dmOpener?.isConnected)_dmOpener.focus();_dmOpener=null;
  document.getElementById("done-modal-overlay").classList.remove("open");
  _dmId=null; _dmCallback=null; _dmEv=null; _dmSessions=[];
  if(typeof _flushDeferredRender==='function')_flushDeferredRender();
}
async function confirmDoneModal(){
  if(!_dmId||_dmBusy)return;
  if(_dmOptions?.awaitConfirmation){
    // The queue owns its atomic command/retry. Do not save notes or infer sessions
    // before that command is acknowledged; cancellation and lost responses stay honest.
    if(document.querySelectorAll('#dm-subtask-section .st-subtask-row').length){
      _dmOptions.body.querySelector('[role=status]').textContent='Resolve unfinished subtasks before completing the parent task.';return;
    }
    const body=document.querySelector('.done-modal-body'),confirm=document.getElementById('done-modal-confirm');
    const editor=window._dmBlockEditor;
    const note={blocks:editor?.getBlocks()||[],html:editor?.toHtml()||'',text:editor?.toMarkdown()||''};
    _dmBusy=true;body.inert=true;confirm.disabled=true;
    try{
      if(!_dmOptions.completionAcknowledged){
        await _dmCallback(note.text);
        _dmOptions.completionAcknowledged=true;
      }
      if(JSON.stringify(note.blocks)!==_dmOptions.noteSnapshot)await _dmOptions.saveNotes(note);
      _dmBusy=false;closeDoneModal();
    }catch(error){
      const completed=_dmOptions.completionAcknowledged;
      _dmOptions.body.querySelector('[role=status]').textContent=(completed?'Task completed; notes were not saved. Retry saves notes only. ':'')+error.message;
      if(completed)confirm.textContent='Save notes';
    }
    finally{_dmBusy=false;body.inert=false;confirm.disabled=false;}
    return;
  }
  // Capture notes from block editor
  const notes=loadNotes();
  if(window._dmBlockEditor && !window._dmBlockEditor.isEmpty()){
    const blocks=window._dmBlockEditor.getBlocks();
    notes[_dmId]=Object.assign({},notes[_dmId],{blocks:blocks, html:window._dmBlockEditor.toHtml(), text:window._dmBlockEditor.toMarkdown()});
  } else { notes[_dmId]=Object.assign({},notes[_dmId],{blocks:[],html:"",text:""}); }
  saveNotes(notes,{taskId:_dmId});
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
