// ======== TRIVIAL TASKS ========
const TRIV_KEY = "pa-trivial-tasks";
let TRIV_FLAGS_KEY = "pa-trivial-flags-" + ((__state && __state.date) ? __state.date : "unknown");

function loadTrivialTasks(){try{return JSON.parse(localStorage.getItem(TRIV_KEY)||"[]")}catch(e){return[]}}
function saveTrivialTasks(t){try{localStorage.setItem(TRIV_KEY,JSON.stringify(t));scheduleIDBSave()}catch(e){}}
function loadTrivialFlags(){try{return JSON.parse(localStorage.getItem(TRIV_FLAGS_KEY)||"{}")}catch(e){return{}}}
function saveTrivialFlags(f){try{localStorage.setItem(TRIV_FLAGS_KEY,JSON.stringify(f));scheduleIDBSave()}catch(e){}}

function addTrivialTask(text){
  if(!text.trim())return;
  const tasks=loadTrivialTasks();
  tasks.push({id:"triv-"+Date.now(),text:text.trim(),done:false,createdAt:new Date().toISOString()});
  saveTrivialTasks(tasks);
  buildTrivialTasks();
}
function toggleTrivialTask(id){
  const tasks=loadTrivialTasks();
  const t=tasks.find(x=>x.id===id);
  if(t){t.done=!t.done;t.doneAt=t.done?new Date().toISOString():null;}
  saveTrivialTasks(tasks);
  buildTrivialTasks();
}
function deleteTrivialTask(id){
  saveTrivialTasks(loadTrivialTasks().filter(x=>x.id!==id));
  buildTrivialTasks();
}
function toggleTrivialFlag(evId){
  const flags=loadTrivialFlags();
  if(flags[evId])delete flags[evId];else flags[evId]=true;
  saveTrivialFlags(flags);
  render();
}

function buildTrivialTasks(){
  const el=document.getElementById("triage-trivial");if(!el)return;
  const tasks=loadTrivialTasks();
  const active=tasks.filter(t=>!t.done);
  const done=tasks.filter(t=>t.done);

  let html='<div class="triv-section">'+
    '<div class="triv-header">'+
      '<div class="triv-title">⚡ Trivial Tasks <span style="opacity:0.6;font-weight:400;font-size:10px">('+active.length+')</span></div>'+
      '<button class="triv-add-btn" id="triv-add-btn">+ Add</button>'+
    '</div>'+
    '<div class="triv-desc">Quick things to remember — stack with larger tasks when possible.</div>'+
    '<div id="triv-input-row" class="triv-input-row" style="display:none">'+
      '<input class="triv-input" id="triv-input" type="text" placeholder="Add a trivial task...">'+
      '<button class="triv-input-ok" id="triv-input-ok">Add</button>'+
    '</div>';

  if(active.length){
    active.forEach(t=>{
      html+='<div class="triv-item" data-tid="'+t.id+'">'+
        '<div class="triv-check" data-tid="'+t.id+'"></div>'+
        '<span class="triv-text">'+t.text+'</span>'+
        '<button class="triv-del" data-tid="'+t.id+'">✕</button>'+
      '</div>';
    });
  } else {
    html+='<div style="font-size:11px;color:var(--text-muted);padding:4px 0">No trivial tasks.</div>';
  }

  if(done.length){
    html+='<div class="triv-done-section">'+
      '<button class="triv-done-toggle" id="triv-done-toggle">▸ Done ('+done.length+')</button>'+
      '<div id="triv-done-list" style="display:none">';
    done.forEach(t=>{
      html+='<div class="triv-item" data-tid="'+t.id+'">'+
        '<div class="triv-check done" data-tid="'+t.id+'">✓</div>'+
        '<span class="triv-text done">'+t.text+'</span>'+
        '<button class="triv-del" data-tid="'+t.id+'">✕</button>'+
      '</div>';
    });
    html+='</div></div>';
  }

  html+='</div>';
  el.innerHTML=html;

  el.querySelector("#triv-add-btn").addEventListener("click",()=>{
    const row=el.querySelector("#triv-input-row");
    row.style.display="flex";
    el.querySelector("#triv-input").focus();
  });
  el.querySelector("#triv-input-ok").addEventListener("click",()=>{
    const inp=el.querySelector("#triv-input");
    addTrivialTask(inp.value);
    inp.value="";
  });
  el.querySelector("#triv-input").addEventListener("keydown",e=>{
    if(e.key==="Enter"){const inp=e.currentTarget;addTrivialTask(inp.value);inp.value="";}
    if(e.key==="Escape"){el.querySelector("#triv-input-row").style.display="none";}
  });
  el.querySelectorAll(".triv-check").forEach(c=>c.addEventListener("click",()=>toggleTrivialTask(c.dataset.tid)));
  el.querySelectorAll(".triv-del").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();deleteTrivialTask(b.dataset.tid);}));
  const doneToggle=el.querySelector("#triv-done-toggle");
  if(doneToggle)doneToggle.addEventListener("click",()=>{
    const dl=el.querySelector("#triv-done-list");
    const open=dl.style.display==="block";
    dl.style.display=open?"none":"block";
    doneToggle.textContent=(open?"▸":"▾")+" Done ("+done.length+")";
  });
}

// ======== STICKY NOTES ========
const SN_KEY = "pa-sticky-notes";
let snEditingId = null;

function loadStickyNotes(){try{return JSON.parse(localStorage.getItem(SN_KEY)||"[]")}catch(e){return[]}}
function saveStickyNotes(notes){try{localStorage.setItem(SN_KEY,JSON.stringify(notes));scheduleIDBSave()}catch(e){}}

function snRelTime(iso){
  const diff=Date.now()-new Date(iso).getTime();
  const m=Math.floor(diff/60000),h=Math.floor(m/60),d=Math.floor(h/24);
  if(d>0)return d+"d ago";if(h>0)return h+"h ago";if(m>0)return m+"m ago";return"just now";
}

function updateSnBadge(){
  const notes=loadStickyNotes();
  const badge=document.getElementById("sn-badge");
  if(!badge)return;
  if(notes.length){badge.textContent=notes.length;badge.style.display="";}
  else{badge.style.display="none";}
}

function renderStickyNotesList(){
  const list=document.getElementById("sn-list");if(!list)return;
  const notes=loadStickyNotes();
  if(!notes.length){list.innerHTML='<div class="sn-empty">No notes yet. Hit "+ New Note" to add one.</div>';return;}
  const now=Date.now();
  list.innerHTML="";
  notes.forEach(n=>{
    const ageMs=now-new Date(n.createdAt).getTime();
    const stale=ageMs>10*24*60*60*1000;
    const ageDays=Math.floor(ageMs/(24*60*60*1000));
    const card=document.createElement("div");
    card.className="sn-card"+(stale?" sn-card-stale":"");
    card.innerHTML=
      (stale?'<div class="sn-stale-banner">⚠ This note is '+ageDays+' days old — keep or delete?</div>':'')+
      '<div class="sn-card-body">'+n.html+'</div>'+
      '<div class="sn-card-meta">'+
        '<span class="sn-card-ts">'+(n.updatedAt!==n.createdAt?"edited ":"")+snRelTime(n.updatedAt||n.createdAt)+'</span>'+
        '<div class="sn-card-btns">'+
          '<button class="sn-edit-btn" data-snid="'+n.id+'">Edit</button>'+
          '<button class="sn-del-btn" data-snid="'+n.id+'">Delete</button>'+
        '</div>'+
      '</div>';
    card.querySelector(".sn-edit-btn").addEventListener("click",()=>openStickyEditor(n.id));
    card.querySelector(".sn-del-btn").addEventListener("click",()=>deleteStickyNote(n.id));
    list.appendChild(card);
  });
}

function openStickyNotes(){
  document.getElementById("sn-overlay").classList.add("open");
  renderStickyNotesList();
}
function closeStickyNotes(){
  document.getElementById("sn-overlay").classList.remove("open");
  closeStickyEditor();
}

function openStickyEditor(id){
  snEditingId=id;
  const wrap=document.getElementById("sn-editor-wrap");
  const ed=document.getElementById("sn-editable");
  wrap.classList.add("open");
  if(id){
    const notes=loadStickyNotes();
    const n=notes.find(x=>x.id===id);
    if(n)ed.innerHTML=n.html;
  } else {
    ed.innerHTML="";
  }
  ed.focus();
}
function closeStickyEditor(){
  snEditingId=null;
  const wrap=document.getElementById("sn-editor-wrap");
  if(wrap)wrap.classList.remove("open");
  const ed=document.getElementById("sn-editable");
  if(ed)ed.innerHTML="";
}

function snCmd(cmd){document.execCommand(cmd,false,null);document.getElementById("sn-editable").focus();}

function saveStickyNote(){
  const ed=document.getElementById("sn-editable");
  const html=ed.innerHTML.trim();
  const text=ed.innerText.trim();
  if(!text){closeStickyEditor();return;}
  const notes=loadStickyNotes();
  const now=new Date().toISOString();
  if(snEditingId){
    const idx=notes.findIndex(n=>n.id===snEditingId);
    if(idx!==-1){notes[idx].html=html;notes[idx].text=text;notes[idx].updatedAt=now;}
  } else {
    notes.unshift({id:"sn-"+Date.now(),html,text,createdAt:now,updatedAt:now});
  }
  saveStickyNotes(notes);
  closeStickyEditor();
  renderStickyNotesList();
  updateSnBadge();
}

function deleteStickyNote(id){
  const notes=loadStickyNotes().filter(n=>n.id!==id);
  saveStickyNotes(notes);
  renderStickyNotesList();
  updateSnBadge();
}

function render(){buildSchedule();buildConsider();buildBacklog();buildTriage();buildActionItemsTab();buildTrivialTasks();buildUpcoming();buildProgress();updateStats();updateSync();buildLife();updateSnBadge();if(document.getElementById("tab-timer").classList.contains("active")){buildMiniSchedule();buildSideConsider();buildSideBacklog();buildSideDone()}if(schedView==="actual")buildActualView()}

// ======== BUTTONS ========
document.getElementById("btn-copy").addEventListener("click",function(){
  const t=buildClip();if(!t)return;
  navigator.clipboard.writeText(t).then(()=>{
    const b=document.getElementById("btn-copy");b.classList.add("copied");b.textContent="Copied!";
    setTimeout(()=>{b.classList.remove("copied");b.innerHTML='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg> Copy for Claude'},2000)
  });
});
document.getElementById("btn-undo").addEventListener("click",undoLast);
document.getElementById("btn-reset").addEventListener("click",resetAll);
document.getElementById("add-task-btn").addEventListener("click",addNewTask);
document.getElementById("ai-tab-add-btn").addEventListener("click",addAITabItem);
document.getElementById("ai-tab-text").addEventListener("keydown",e=>{if(e.key==="Enter")addAITabItem();});
document.getElementById("new-title").addEventListener("keydown",e=>{if(e.key==="Enter")addNewTask()});


// ======== PREP FILES (loaded from API) ========
window.__PREP_FILES__ = {};


