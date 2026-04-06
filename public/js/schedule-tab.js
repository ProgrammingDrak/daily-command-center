// ======== PLAN / ACTUAL TOGGLE ========
document.querySelectorAll(".svt-btn").forEach(btn=>{
  btn.addEventListener("click",()=>{
    schedView=btn.dataset.view;
    document.querySelectorAll(".svt-btn").forEach(b=>b.classList.toggle("active",b.dataset.view===schedView));
    document.getElementById("timeline").style.display=schedView==="plan"?"block":"none";
    document.getElementById("actual-view").style.display=schedView==="actual"?"block":"none";
    if(schedView==="actual")buildActualView();
  });
});
function buildActualView(){
  const wrap=document.getElementById("actual-view");wrap.innerHTML="";
  const workedTasks=Object.entries(pomoState.taskTime);
  const allSessions=loadSessions();
  const hasAnySessions=Object.keys(allSessions).some(k=>allSessions[k]&&allSessions[k].length);
  if(!workedTasks.length&&!pomoState.sessionLog.length&&!hasAnySessions){
    wrap.innerHTML='<div class="actual-empty">No time data yet. Complete a task or start a pomodoro session to see actual time spent here.</div>';return;
  }
  // Build a merged view: for each scheduled item, show planned vs actual
  const div=document.createElement("div");div.className="actual-timeline";
  scheduled.forEach(ev=>{
    const plannedMin=dur(ev);
    const taskSessions=allSessions[ev.id]||[];
    const sessionMin=taskSessions.reduce((sum,s)=>sum+s.durationMin,0);
    const pomoSec=pomoState.taskTime[ev.title]||0;
    const pomoMin=Math.round(pomoSec/60);
    const actualMin=sessionMin>0?sessionMin:pomoMin;
    const hasActual=actualMin>0;
    const c=cfg(ev.type);
    const done=isDone(ev);
    const diffMin=actualMin-plannedMin;
    let diffLabel="",diffClass="match";
    if(hasActual){
      if(diffMin>0){diffLabel="+"+diffMin+"m over";diffClass="over"}
      else if(diffMin<0){diffLabel=Math.abs(diffMin)+"m under";diffClass="under"}
      else{diffLabel="on target";diffClass="match"}
    }
    const item=document.createElement("div");item.className="actual-item";
    item.innerHTML=
      '<div class="act-time">'+f12(ev.start).replace(" ","").toLowerCase()+'</div>'+
      '<div class="act-node" style="border-color:'+c.color+';background:'+(done?"var(--green)":hasActual?c.color:"transparent")+'"></div>'+
      '<div class="actual-card">'+
        '<div class="act-bar" style="background:'+c.color+'"></div>'+
        '<div class="act-body">'+
          '<div class="act-title">'+(done?'<span style="text-decoration:line-through;opacity:0.6">':'')+ev.title+(done?'</span>':'')+'</div>'+
          '<div class="act-meta">'+
            '<span>Planned: '+ms(plannedMin)+'</span>'+
            (hasActual?'<span>Actual: '+ms(actualMin)+'</span>':'')+
            (done&&!hasActual?'<span style="color:var(--green)">Completed</span>':'')+
          '</div>'+
        '</div>'+
        (hasActual?'<div class="act-diff '+diffClass+'">'+diffLabel+'</div>':'')+
      '</div>';
    div.appendChild(item);
  });

  // Show any tasks that were focused on but not in the schedule
  const schedTitles=new Set(scheduled.map(e=>e.title));
  const extras=Object.entries(pomoState.taskTime).filter(([t])=>!schedTitles.has(t));
  if(extras.length){
    const hdr=document.createElement("div");hdr.style.cssText="margin:16px 0 8px 105px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted)";
    hdr.textContent="Unscheduled Work";div.appendChild(hdr);
    extras.forEach(([title,sec])=>{
      const mins=Math.round(sec/60);
      const item=document.createElement("div");item.className="actual-item";
      item.innerHTML=
        '<div class="act-time"></div>'+
        '<div class="act-node" style="border-color:var(--amber);background:var(--amber)"></div>'+
        '<div class="actual-card">'+
          '<div class="act-bar" style="background:var(--amber)"></div>'+
          '<div class="act-body"><div class="act-title">'+title+'</div>'+
          '<div class="act-meta"><span>Actual: '+ms(mins)+'</span></div></div>'+
        '</div>';
      div.appendChild(item);
    });
  }
  wrap.appendChild(div);
}

// ======== SCHEDULE TAB ========
function buildSchedule(){
  const tl=document.getElementById("timeline");tl.innerHTML="";
  // Separate done vs pushed vs active vs deleted vs trivial-flagged
  const trivFlags=loadTrivialFlags();
  const vis=scheduled.filter(ev=>!isDeleted(ev)&&!trivFlags[ev.id]); // Phase 7: hide trivial-flagged from schedule
  const doneItems=vis.filter(isDone);
  const pushedItems=vis.filter(ev=>!isDone(ev)&&isPushed(ev));
  const activeItems=vis.filter(ev=>!isDone(ev)&&!isPushed(ev));

  // Schedule block section headers
  const schedBlocks=((__state&&__state.schedule&&__state.schedule.blocks)||[]).slice().sort((a,b)=>a.start.localeCompare(b.start));
  let blockPtr=0;
  function parseHHMM(t){const[h,m]=t.split(':').map(Number);return h*60+m;}
  function fmtBlk12(hhmm){const[h,m]=hhmm.split(':').map(Number);const a=h>=12?'PM':'AM',h12=h%12||12;return h12+':'+(m<10?'0':'')+m+' '+a;}
  function injectBlockHeaders(beforeMin){
    while(blockPtr<schedBlocks.length&&parseHHMM(schedBlocks[blockPtr].start)<=beforeMin){
      const blk=schedBlocks[blockPtr];
      const dot=blk.blockType==='work'?'var(--accent-light)':blk.blockType==='personal'?'var(--purple,#a78bfa)':'var(--text-muted)';
      const hdr=document.createElement('div');hdr.className='tl-block-header';hdr.dataset.blockId=blk.id||'';
      hdr.innerHTML='<span class="block-hdr-dot" style="background:'+dot+'"></span>'+'<span class="block-hdr-name">'+blk.name+'</span>'+'<span class="block-hdr-time">'+fmtBlk12(blk.start)+' \u2013 '+fmtBlk12(blk.end)+'</span>'+'<button class="block-hdr-edit" onclick="event.stopPropagation();openBlockEditor()" title="Edit time blocks">\u270E</button>';
      tl.appendChild(hdr);blockPtr++;
    }
  }

  const ckSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>';
  const gripSvg='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';

  // Render done items as compact one-liners
  const completionsData = (__state && __state.completions && __state.completions.tasks) || [];
  const reviewedState = loadReviewed();
  doneItems.forEach(ev=>{
    const c=cfg(ev.type);const evSrcTag=srcTag(ev.source);
    // Check if this task was auto-completed and needs review
    const comp = completionsData.find(t => t.task_id === ev.id);
    const needsReview = comp && comp.needs_review && !reviewedState[ev.id];
    const reviewBadgeHtml = needsReview ?
      '<span class="review-badge" data-review-id="'+ev.id+'" data-review-type="task" data-evidence="'+(comp.evidence_summary||'Auto-detected by sweep').replace(/"/g,'&quot;')+'" data-evidence-link="'+(comp.evidence_link||'').replace(/"/g,'&quot;')+'" title="Auto-completed -- click to review">Needs Review</span>' : '';
    const el=document.createElement("div");el.className="tl-compact";el.dataset.id=ev.id;
    el.innerHTML=
      '<div class="tl-time">'+f12(ev.start).replace(/ (AM|PM)/,"")+'</div>'+
      '<div class="tl-node"></div>'+
      '<div class="compact-row">'+
        '<div class="c-check" title="Uncheck">'+ckSvg+'</div>'+
        '<div class="bar" style="background:'+c.color+'"></div>'+
        '<span class="c-title">'+ev.title+'</span>'+
        reviewBadgeHtml+
        evSrcTag+
        '<span class="c-time">'+f12(ev.start)+' - '+f12(ev.end)+'</span>'+
      '</div>';
    el.querySelector(".c-check").addEventListener("click",e=>{e.stopPropagation();toggleDone(ev.id)});
    const rb=el.querySelector(".review-badge");if(rb)rb.addEventListener("click",e=>{e.stopPropagation();openReviewPopover(rb)});
    tl.appendChild(el);
  });

  // Divider between done and active
  if(doneItems.length&&activeItems.length){
    const d=document.createElement("div");d.className="divider";d.innerHTML='<span>Up Next</span>';tl.appendChild(d);
  }

  // Icon maps for edge items
  const eiIcons={task:'<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',doc:'<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',dash:'<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',action:'<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>'};
  const eiBadge={ready:'<span class="ei-badge eib-ready">Ready</span>',todo:'<span class="ei-badge eib-todo">To-do</span>',ref:'<span class="ei-badge eib-ref">Ref</span>',new:'<span class="ei-badge eib-new">New</span>'};
  const chevSm='<svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>';

  // Determine if any task is currently active; if not, find the next upcoming one
  const isToday = __state && __state.date === new Date().toISOString().split("T")[0];
  const _anyActive = activeItems.some(ev => isActive(ev));
  const _nextUpId = !_anyActive ? (activeItems.find(ev => pt(ev.start) >= now()) || {}).id : null;

  // Render active/upcoming items as full cards
  activeItems.forEach(ev=>{
    injectBlockHeaders(pt(ev.start));
    const trueActive=isActive(ev)&&isToday,isNextUp=(!trueActive&&ev.id===_nextUpId&&isToday),active=trueActive||isNextUp,nearEnd=trueActive&&(pt(ev.end)-now()<=5),nc=active?"active":"upcoming";
    const d=dur(ev),od=origDur(ev.id),changed=od&&d!==od,delta=d-od;
    const c=cfg(ev.type);const evSrcTag=srcTag(ev.source);
    const el=document.createElement("div");el.className="tl-item";el.dataset.id=ev.id;
    // Meetings are fixed anchors -- no drag, but still valid drop targets so tasks can be positioned around them
    if(!isMeeting(ev)){el.draggable=true;el.addEventListener("dragstart",e=>dStart(e,ev.id));el.addEventListener("dragend",dEnd);}
    el.addEventListener("dragover",e=>dOver(e,ev.id));el.addEventListener("dragleave",dLeave);el.addEventListener("drop",e=>dDrop(e,ev.id));

    const hasPrep=ev.prep&&ev.prep.length;
    const hasFu=ev.followups&&ev.followups.length;

    // Build detail panel content
    const detailParts=[];
    if(ev.detail)detailParts.push('<div class="detail-summary">'+ev.detail.replace(/\n/g,'<br>')+'</div>');
    const dLinks=[];
    if(ev.notionUrl)dLinks.push('<a href="'+ev.notionUrl+'" target="_blank" onclick="event.stopPropagation()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h6v6H4z"/><path d="M14 4h6v6h-6z"/><path d="M4 14h6v6H4z"/><path d="M14 14h6v6h-6z"/></svg>Open in Notion</a>');
    if(ev.calUrl)dLinks.push('<a href="'+ev.calUrl+'" target="_blank" onclick="event.stopPropagation()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>Open in Calendar</a>');
    if(dLinks.length)detailParts.push('<div class="detail-links">'+dLinks.join('')+'</div>');
    const detailMeta=[];
    if(ev.priority)detailMeta.push('<span class="pri-'+(ev.priority==="High"?"hi":ev.priority==="Medium"?"med":"lo")+'">Priority: '+ev.priority+'</span>');
    if(ev.estTime)detailMeta.push('<span>Est: '+ev.estTime+'</span>');
    detailMeta.push('<span>Duration: '+ms(d)+(changed?' (was '+ms(od)+')':'')+'</span>');
    detailMeta.push('<span>'+f12(ev.start)+' - '+f12(ev.end)+'</span>');
    if(detailMeta.length)detailParts.push('<div class="detail-meta">'+detailMeta.join('')+'</div>');
    // Subtasks and trivial tasks are now in the Add Items modal (openAddModal)
    // Show a summary count in the detail panel if items exist
    if(!isMeeting(ev)){
      const subs=loadSubtasks()[ev.id]||[];
      const linkedTriv=getLinkedTrivialTasks(ev.id);
      if(subs.length||linkedTriv.length){
        let counts=[];
        if(subs.length)counts.push(subs.length+' subtask'+(subs.length>1?'s':''));
        if(linkedTriv.length)counts.push(linkedTriv.length+' trivial task'+(linkedTriv.length>1?'s':''));
        detailParts.push('<div class="detail-meta" style="cursor:pointer" onclick="openAddModal(\''+ev.id.replace(/'/g,"\\'")+'\',\''+ev.title.replace(/'/g,"\\'")+'\')"><span style="color:var(--cyan)">⚡ '+counts.join(', ')+'</span> <span style="font-size:10px;opacity:0.5">click to manage</span></div>');
      }
    }
    const hasDetail=detailParts.length>0;
    const chevron='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transition:transform 0.2s;flex-shrink:0;opacity:0.4"><path d="M6 9l6 6 6-6"/></svg>';

    // Build prep edge items
    let prepHtml='';
    if(hasPrep){
      prepHtml=ev.prep.map(p=>{
        const ic=p.type==="task"?"ei-task":p.type==="dash"?"ei-dash":"ei-doc";
        const isLocal=p.href&&!p.href.startsWith("http");
        const isExternal=p.href&&p.href.startsWith("http");
        if(isLocal){
          return'<div class="ei ei-linkable" data-prep-href="'+p.href.replace(/"/g,'&quot;')+'" data-prep-title="'+p.title.replace(/"/g,'&quot;')+'" onclick="event.stopPropagation();openPrepViewer(this.dataset.prepHref,this.dataset.prepTitle)"><div class="ei-icon '+ic+'">'+(eiIcons[p.type]||eiIcons.doc)+'</div><div class="ei-body"><div class="ei-title">'+p.title+'</div></div>'+(eiBadge[p.status]||'')+'</div>';
        } else {
          const link=isExternal?'<a href="'+p.href+'" target="_blank" onclick="event.stopPropagation()">'+p.title+'</a>':p.title;
          return'<div class="ei"><div class="ei-icon '+ic+'">'+(eiIcons[p.type]||eiIcons.doc)+'</div><div class="ei-body"><div class="ei-title">'+link+'</div></div>'+(eiBadge[p.status]||'')+'</div>';
        }
      }).join('');
    }

    // Build followup edge items
    let fuHtml='';
    if(hasFu){
      fuHtml=ev.followups.map(f=>{
        const fTitle=f.href?'<a href="'+f.href+'" target="_blank" onclick="event.stopPropagation()">'+f.title+'</a>':f.title;
        const fDetail=f.detail?'<div class="ei-detail">'+f.detail+'</div>':'';
        return'<div class="ei"><div class="ei-icon ei-action">'+eiIcons.action+'</div><div class="ei-body"><div class="ei-title">'+fTitle+'</div>'+fDetail+'</div>'+(eiBadge[f.status]||eiBadge.new)+(f.durMin?'<button class="ei-sched" data-fuid="'+f.id+'">+ Schedule ('+ms(f.durMin)+')</button>':'')+'</div>';
      }).join('');
    }

    // Edge tabs HTML
    const prepTab=hasPrep?'<div class="edge-tab edge-prep" data-edge="prep">'+chevSm+' Prep '+ev.prep.length+'</div>':'';
    const fuTab=hasFu?'<div class="edge-tab edge-fu" data-edge="fu">'+ev.followups.length+' Actions '+chevSm+'</div>':'';
    const isTrivialFlagged=!isMeeting(ev)&&!!loadTrivialFlags()[ev.id];
    // Phase 7: removed edge-trivial banner (replaced by link button on card)
    const trivialTab='';

    // Prep-aware time label with hover tooltip
    let timeHtml='<div class="tl-time'+(hasPrep?' has-prep':'')+'">'+f12(ev.start).replace(" ","<br>")+'<span class="et">'+f12(ev.end)+'</span>';
    if(hasPrep){
      timeHtml+='<span class="prep-line"></span>';
    }
    timeHtml+='</div>';

    el.innerHTML=
      timeHtml+
      '<div class="tl-node '+nc+(hasPrep?' has-prep':'')+(nearEnd?' near-end':'')+(isNextUp?' next-up':'')+'">'+(active?'<span class="tl-now-time">'+new Date().toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}).replace(" ","")+'</span>':'')+'</div>'+
      '<div class="card-wrap">'+
        prepTab+fuTab+trivialTab+
        '<div class="card'+(active?' card-active':'')+'">'+
          '<div class="grip" title="Drag to reorder">'+gripSvg+'</div>'+
          '<button class="chk" title="Mark done">'+ckSvg+'</button>'+
          '<div class="chk-col">'+
            '<button class="chk-quick" title="Quick complete (no notes)">&#9889;</button>'+
            (!isMeeting(ev)?'<button class="btn-add-menu" title="Add subtask or trivial task" data-add-id="'+ev.id+'">+</button>':'')+
          '</div>'+
          '<div class="bar" style="background:'+c.color+'"></div>'+
          '<div class="body">'+
            '<div class="title-row"><span class="ttl">'+ev.title+'</span>'+evSrcTag+'<span class="tinline"><span class="start-time'+(ev._pinnedStart?' pinned':'')+'" data-start-id="'+ev.id+'" title="Click to adjust start time">'+f12(ev.start)+'</span> - '+f12(ev.end)+(active?' \u00b7 Now':'')+'</span></div>'+
            '<div class="meta"><span class="tag '+c.cls+'">'+c.tag+'</span>'+colorMeta(ev)+
              (ev.prepStatus==='ready'?'<span class="prep-flag prep-ready" title="Prep briefing ready">&#9679; Prep</span>':ev.prepStatus==='pending'?'<span class="prep-flag prep-pending" title="Prep pending">&#9675; Prep</span>':'')+
              (changed?'<span style="color:var(--amber);font-size:9px">Duration adjusted</span>':'')+
            '</div>'+
          '</div>'+
          notesButton(ev)+
          '<button class="pomo-btn" data-pomo-title="'+ev.title.replace(/"/g,'&quot;')+'" data-pomo-dur="'+d+'" title="Start pomodoro timer">'+pomoSvg+'</button>'+
          (!isMeeting(ev)?'<button class="btn-triv-link'+(isTrivialFlagged?' triv-active':'')+'" data-triv-id="'+ev.id+'" data-tooltip="Mark as trivial — move to triage"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>':'')+
          (!isMeeting(ev)?'<button class="btn-push-tmr" data-push-id="'+ev.id+'" data-tooltip="Move to tomorrow"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>':'')+
          '<button class="btn-del-task" data-del-id="'+ev.id+'" data-tooltip="Remove from schedule"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>'+
          '<div class="dur">'+
            '<button class="dbtn" data-id="'+ev.id+'" data-d="-15">&minus;</button>'+
            '<div><div class="dbadge">'+ms(d)+'</div>'+(changed?'<div class="est-act">was '+ms(od)+' <span class="'+(delta>0?"dover":"dunder")+'">'+( delta>0?"+":"")+delta+'m</span></div>':'')+'</div>'+
            '<button class="dbtn" data-id="'+ev.id+'" data-d="15">+</button>'+
          '</div>'+
          (hasDetail?chevron:'')+
        '</div>'+
        (hasDetail?'<div class="detail-panel"><div class="detail-inner">'+detailParts.join('')+'</div></div>':'')+
        (hasPrep?'<div class="edge-panel edge-panel-prep" data-panel="prep"><div class="edge-panel-inner"><div class="edge-items">'+prepHtml+'</div></div></div>':'')+
        (hasFu?'<div class="edge-panel edge-panel-fu" data-panel="fu"><div class="edge-panel-inner"><div class="edge-items">'+fuHtml+'</div></div></div>':'')+
      '</div>';

    // Event listeners
    el.querySelector(".chk").addEventListener("click",e=>{e.stopPropagation();openDoneModal(ev.id,ev.title,()=>toggleDone(ev.id),ev);});
    el.querySelector(".chk-quick").addEventListener("click",e=>{e.stopPropagation();e.currentTarget.classList.add("flash");toggleDone(ev.id);});
    // + button opens task detail modal directly (no dropdown)
    const addBtn=el.querySelector(".btn-add-menu");
    if(addBtn)addBtn.addEventListener("click",e=>{
      e.stopPropagation();
      if(typeof openAddModal==='function')openAddModal(ev.id,ev.title);
    });
    // Trivial link button
    const trivLink=el.querySelector(".btn-triv-link");
    if(trivLink)trivLink.addEventListener("click",e=>{e.stopPropagation();toggleTrivialFlag(ev.id);});
    el.querySelectorAll(".dbtn").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();adjustDur(b.dataset.id,parseInt(b.dataset.d))}));
    const stSpan=el.querySelector(".start-time");if(stSpan&&!isMeeting(ev)){stSpan.addEventListener("click",e=>{e.stopPropagation();openStartTimePicker(ev.id,stSpan);});}
    const dbadge=el.querySelector(".dbadge");
    if(dbadge){dbadge.addEventListener("click",e=>{
      e.stopPropagation();
      document.querySelectorAll(".dur-popover").forEach(p=>p.remove());
      document.querySelectorAll(".has-dur-popover").forEach(x=>x.classList.remove("has-dur-popover"));
      document.body.classList.remove("dur-open");
      const curMin=dur(ev);
      const pages=[[15,30,45,60,90,120],[150,180,210,240,300,360]];
      let page=pages.findIndex(pg=>pg.includes(curMin));if(page===-1)page=0;
      const pop=document.createElement("div");pop.className="dur-popover";
      function closePop(){
        pop.remove();
        document.querySelectorAll(".has-dur-popover").forEach(x=>x.classList.remove("has-dur-popover"));
        document.body.classList.remove("dur-open");
        document.removeEventListener("click",onOutside,true);
      }
      function renderPage(){
        pop.innerHTML="";
        const grid=document.createElement("div");grid.className="dur-presets";
        pages[page].forEach(m=>{
          const btn=document.createElement("button");
          btn.className="dur-preset"+(m===curMin?" dur-current":"");
          btn.textContent=ms(m);
          btn.addEventListener("click",e2=>{e2.stopPropagation();closePop();setDurAbsolute(ev.id,m);});
          grid.appendChild(btn);
        });
        pop.appendChild(grid);
        const nav=document.createElement("div");nav.className="dur-nav";
        const prev=document.createElement("button");prev.className="dur-nav-btn";prev.innerHTML="&#8592;";prev.disabled=page===0;
        prev.addEventListener("click",e2=>{e2.stopPropagation();if(page>0){page--;renderPage();}});
        const dots=document.createElement("div");dots.className="dur-nav-dots";
        pages.forEach((_,i)=>{const d=document.createElement("span");d.className="dur-nav-dot"+(i===page?" active":"");dots.appendChild(d);});
        const next=document.createElement("button");next.className="dur-nav-btn";next.innerHTML="&#8594;";next.disabled=page===pages.length-1;
        next.addEventListener("click",e2=>{e2.stopPropagation();if(page<pages.length-1){page++;renderPage();}});
        nav.appendChild(prev);nav.appendChild(dots);nav.appendChild(next);
        pop.appendChild(nav);
      }
      renderPage();
      // Position relative to the badge using fixed coords (escapes stacking context)
      const rect=dbadge.getBoundingClientRect();
      pop.style.top=(rect.bottom+6)+"px";
      pop.style.right=(window.innerWidth-rect.right)+"px";
      el.classList.add("has-dur-popover");
      document.body.classList.add("dur-open");
      document.body.appendChild(pop);
      function onOutside(e2){if(!pop.contains(e2.target)&&e2.target!==dbadge){closePop();}}
      setTimeout(()=>document.addEventListener("click",onOutside,true),0);
    });}
    el.querySelector(".pomo-btn").addEventListener("click",e=>{e.stopPropagation();const b=e.currentTarget;openPomodoro(b.dataset.pomoTitle,parseInt(b.dataset.pomoDur))});
    const nb=el.querySelector(".notes-btn");if(nb)nb.addEventListener("click",e=>{e.stopPropagation();if(typeof openAddModal==='function')openAddModal(nb.dataset.notesId,nb.dataset.notesTitle);else openNotesDrawer(nb.dataset.notesId,nb.dataset.notesTitle);});
    const pb=el.querySelector(".btn-push-tmr");if(pb)pb.addEventListener("click",e=>{e.stopPropagation();pushTask(pb.dataset.pushId)});
    const db=el.querySelector(".btn-del-task");if(db)db.addEventListener("click",e=>{e.stopPropagation();openDeleteConfirm(db.dataset.delId)});
    // Phase 7: removed old triv-flag-chk (replaced by btn-triv-link on card face)
    // Subtask and trivial task management moved to Add Items modal (openAddModal)
    el.querySelector(".card").addEventListener("click",e=>{if(e.target.closest(".chk")||e.target.closest(".chk-quick")||e.target.closest(".dbtn")||e.target.closest(".dbadge")||e.target.closest(".dur-popover")||e.target.closest(".grip")||e.target.closest(".pomo-btn")||e.target.closest(".notes-btn")||e.target.closest(".btn-push-tmr")||e.target.closest(".btn-del-task")||e.target.closest(".btn-triv-link")||e.target.closest(".btn-add-menu")||e.target.closest(".add-menu-popup")||e.target.closest(".card-triv-section"))return;const cw=el.querySelector(".card-wrap");toggleDetail(cw);const chev=el.querySelector(".card > svg:last-child");if(chev)chev.style.transform=cw.querySelector(".detail-panel.open")?"rotate(180deg)":""});

    // Edge tab toggle listeners
    el.querySelectorAll(".edge-tab").forEach(tab=>{
      tab.addEventListener("click",e=>{
        e.stopPropagation();
        const edgeType=tab.dataset.edge;
        const panel=el.querySelector('.edge-panel[data-panel="'+edgeType+'"]');
        if(!panel)return;
        tab.classList.toggle("open");panel.classList.toggle("open");
      });
    });

    // Schedule buttons on followup items
    el.querySelectorAll(".ei-sched").forEach(btn=>{
      btn.addEventListener("click",e=>{
        e.stopPropagation();
        const fuId=btn.dataset.fuid;
        const fu=ev.followups.find(f=>f.id===fuId);
        if(!fu)return;
        addFollowupToSchedule(fu,ev.id);
      });
    });

    // Floating prep tooltip on hover
    const tlTime=el.querySelector(".tl-time.has-prep");
    if(tlTime){
      const phIcons={task:'<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',doc:'<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',dash:'<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>'};
      let floatHtml='<div class="prep-hover-label">Prep work</div>';
      ev.prep.forEach(p=>{
        const pCls=p.type==="task"?"phi-task":p.type==="dash"?"phi-dash":"phi-doc";
        const isLocal=p.href&&!p.href.startsWith("http");
        if(isLocal){
          floatHtml+='<div class="prep-hover-item" style="cursor:pointer" onclick="openPrepViewer(\''+p.href.replace(/'/g,"\\'")+'\',\''+p.title.replace(/'/g,"\\'")+'\')"><div class="phi '+pCls+'">'+(phIcons[p.type]||phIcons.doc)+'</div><span>'+p.title+'</span></div>';
        } else {
          floatHtml+='<div class="prep-hover-item"><div class="phi '+pCls+'">'+(phIcons[p.type]||phIcons.doc)+'</div><a href="'+p.href+'" target="_blank">'+p.title+'</a></div>';
        }
      });
      tlTime.addEventListener("mouseenter",()=>{
        const fl=document.getElementById("prep-float");
        fl.innerHTML=floatHtml;
        fl.style.display="block";
        fl.style.pointerEvents="auto";
        const r=tlTime.getBoundingClientRect();
        fl.style.left=r.left+"px";
        fl.style.top=(r.bottom+6)+"px";
      });
      tlTime.addEventListener("mouseleave",()=>{
        const fl=document.getElementById("prep-float");
        fl.style.display="none";
      });
    }

    tl.appendChild(el);
  });

  // Flush any remaining block headers after last active item
  injectBlockHeaders(24*60);

  // Render pushed-to-tomorrow items at the bottom
  if(pushedItems.length){
    const pd=document.createElement("div");pd.className="pushed-divider";pd.innerHTML='<span>Pushed to Tomorrow</span>';tl.appendChild(pd);
    const pushArrowSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
    pushedItems.forEach(ev=>{
      const c=cfg(ev.type);const evSrcTag=srcTag(ev.source);
      const el=document.createElement("div");el.className="tl-compact pushed";el.dataset.id=ev.id;
      el.innerHTML=
        '<div class="tl-time">'+f12(ev.start).replace(/ (AM|PM)/,"")+'</div>'+
        '<div class="tl-node"></div>'+
        '<div class="compact-row">'+
          '<div class="c-check" title="Restore to schedule">'+pushArrowSvg+'</div>'+
          '<div class="bar" style="background:'+c.color+'"></div>'+
          '<span class="c-title">'+ev.title+'</span>'+
          evSrcTag+
          '<span class="c-time">'+f12(ev.start)+' - '+f12(ev.end)+'</span>'+
        '</div>';
      el.querySelector(".c-check").addEventListener("click",e=>{e.stopPropagation();unpushTask(ev.id)});
      tl.appendChild(el);
    });
  }
}

// ======== CONSIDER FOR TODAY TAB ========
function buildConsider(){
  const board=document.getElementById("consider-board");board.innerHTML="";
  const ccBadge=document.getElementById("consider-count");if(ccBadge)ccBadge.textContent=consider.length;
  if(!consider.length){board.innerHTML='<div class="board-empty">Nothing flagged for today. Nice work, or add tasks via Notion.</div>';return}
  const priOrder={High:0,Medium:1,Low:2,undefined:3};
  const sorted=[...consider].sort((a,b)=>(priOrder[a.priority]||3)-(priOrder[b.priority]||3));
  sorted.forEach(t=>{
    const c=cfg(t.type);
    const stageClass=t.stage==="Backlog"?"stage-backlog":t.stage==="Next Sprint"?"stage-next":t.stage==="Tasks for Today"?"stage-today":"stage-scheduled";
    const tSrcTag=srcTag(t.source);
    const dParts=[];
    if(t.detail)dParts.push('<div class="detail-summary">'+t.detail+'</div>');
    const dLinks=[];
    if(t.notionUrl)dLinks.push('<a href="'+t.notionUrl+'" target="_blank" onclick="event.stopPropagation()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h6v6H4z"/><path d="M14 4h6v6h-6z"/><path d="M4 14h6v6H4z"/><path d="M14 14h6v6h-6z"/></svg>Open in Notion</a>');
    if(dLinks.length)dParts.push('<div class="detail-links">'+dLinks.join('')+'</div>');
    const dMeta=[];
    if(t.priority)dMeta.push('<span class="pri-'+(t.priority==="High"?"hi":t.priority==="Medium"?"med":"lo")+'">Priority: '+t.priority+'</span>');
    if(t.stage)dMeta.push('<span>Stage: '+t.stage+'</span>');
    dMeta.push('<span>Est: '+ms(t.durMin)+'</span>');
    if(dMeta.length)dParts.push('<div class="detail-meta">'+dMeta.join('')+'</div>');
    const hasD=dParts.length>0;
    const chev='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transition:transform 0.2s;flex-shrink:0;opacity:0.4"><path d="M6 9l6 6 6-6"/></svg>';

    const el=document.createElement("div");el.className="board-card";el.style.cssText="flex-wrap:wrap;cursor:pointer";
    el.innerHTML=
      '<div class="bar" style="background:'+c.color+'"></div>'+
      '<div class="body">'+
        '<div class="title-row"><span class="ttl">'+t.title+'</span>'+tSrcTag+'</div>'+
        '<div class="meta">'+
          '<span class="tag '+c.cls+'">'+c.tag+'</span>'+
          (t.stage?'<span class="stage-badge '+stageClass+'">'+t.stage+'</span>':'')+
          '<span>'+ms(t.durMin)+'</span>'+
          (t.priority?'<span class="pri-'+(t.priority==="High"?"hi":t.priority==="Medium"?"med":"lo")+'">'+t.priority+'</span>':'')+
        '</div>'+
      '</div>'+
      (hasD?chev:'')+
      notesButton({id: t.id, title: t.title})+
      '<button class="pomo-btn" data-pomo-title="'+t.title.replace(/"/g,'&quot;')+'" data-pomo-dur="'+t.durMin+'" title="Start pomodoro timer">'+pomoSvg+'</button>'+
      '<button class="add-btn" data-id="'+t.id+'"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 5v14M5 12h14"/></svg> Schedule</button>'+
      (hasD?'<div class="detail-panel" style="width:100%;padding-left:14px"><div class="detail-inner">'+dParts.join('')+'</div></div>':'');
    const cnb=el.querySelector(".notes-btn");if(cnb)cnb.addEventListener("click",e=>{e.stopPropagation();openNotesDrawer(cnb.dataset.notesId,cnb.dataset.notesTitle)});
    el.querySelector(".pomo-btn").addEventListener("click",e=>{e.stopPropagation();const b=e.currentTarget;openPomodoro(b.dataset.pomoTitle,parseInt(b.dataset.pomoDur))});
    el.querySelector(".add-btn").addEventListener("click",e=>{e.stopPropagation();addToSchedule(t.id)});
    el.addEventListener("click",e=>{if(e.target.closest(".add-btn")||e.target.closest(".pomo-btn")||e.target.closest(".notes-btn"))return;const panel=el.querySelector(".detail-panel");if(panel){panel.classList.toggle("open");const cv=el.querySelector(":scope > svg");if(cv)cv.style.transform=panel.classList.contains("open")?"rotate(180deg)":""}});
    board.appendChild(el);
  });
}

// ======== BACKLOG TAB ========
function buildBacklog(){
  const board=document.getElementById("backlog-board");board.innerHTML="";
  document.getElementById("backlog-count").textContent=backlog.length;
  if(!backlog.length){board.innerHTML='<div class="board-empty">No backlog items. Add tasks above or check your Notion board.</div>';return}
  // Sort: High > Medium > Low
  const priOrder={High:0,Medium:1,Low:2,undefined:3};
  const sorted=[...backlog].sort((a,b)=>(priOrder[a.priority]||3)-(priOrder[b.priority]||3));
  sorted.forEach(t=>{
    const c=cfg(t.type);
    const stageClass=t.stage==="Backlog"?"stage-backlog":t.stage==="Next Sprint"?"stage-next":t.stage==="Tasks for Today"?"stage-today":"stage-scheduled";
    const tSrcTag=srcTag(t.source);
    // Detail panel for backlog
    const bDetailParts=[];
    if(t.detail)bDetailParts.push('<div class="detail-summary">'+t.detail+'</div>');
    const bLinks=[];
    if(t.notionUrl)bLinks.push('<a href="'+t.notionUrl+'" target="_blank" onclick="event.stopPropagation()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h6v6H4z"/><path d="M14 4h6v6h-6z"/><path d="M4 14h6v6H4z"/><path d="M14 14h6v6h-6z"/></svg>Open in Notion</a>');
    if(bLinks.length)bDetailParts.push('<div class="detail-links">'+bLinks.join('')+'</div>');
    const bMeta=[];
    if(t.priority)bMeta.push('<span class="pri-'+(t.priority==="High"?"hi":t.priority==="Medium"?"med":"lo")+'">Priority: '+t.priority+'</span>');
    if(t.stage)bMeta.push('<span>Stage: '+t.stage+'</span>');
    bMeta.push('<span>Est: '+ms(t.durMin)+'</span>');
    if(bMeta.length)bDetailParts.push('<div class="detail-meta">'+bMeta.join('')+'</div>');
    const bHasDetail=bDetailParts.length>0;
    const bChev='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transition:transform 0.2s;flex-shrink:0;opacity:0.4"><path d="M6 9l6 6 6-6"/></svg>';

    const el=document.createElement("div");el.className="board-card";el.style.cssText="flex-wrap:wrap;cursor:pointer";
    el.innerHTML=
      '<div class="bar" style="background:'+c.color+'"></div>'+
      '<div class="body">'+
        '<div class="title-row"><span class="ttl">'+t.title+'</span>'+tSrcTag+'</div>'+
        '<div class="meta">'+
          '<span class="tag '+c.cls+'">'+c.tag+'</span>'+
          (t.stage?'<span class="stage-badge '+stageClass+'">'+t.stage+'</span>':'')+
          '<span>'+ms(t.durMin)+'</span>'+
          (t.priority?'<span class="pri-'+(t.priority==="High"?"hi":t.priority==="Medium"?"med":"lo")+'">'+t.priority+'</span>':'')+
        '</div>'+
      '</div>'+
      (bHasDetail?bChev:'')+
      notesButton({id: t.id, title: t.title})+
      '<button class="pomo-btn" data-pomo-title="'+t.title.replace(/"/g,'&quot;')+'" data-pomo-dur="'+t.durMin+'" title="Start pomodoro timer">'+pomoSvg+'</button>'+
      '<button class="add-btn" data-id="'+t.id+'"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 5v14M5 12h14"/></svg> Schedule</button>'+
      (bHasDetail?'<div class="detail-panel" style="width:100%;padding-left:14px"><div class="detail-inner">'+bDetailParts.join('')+'</div></div>':'');
    const bnb=el.querySelector(".notes-btn");if(bnb)bnb.addEventListener("click",e=>{e.stopPropagation();openNotesDrawer(bnb.dataset.notesId,bnb.dataset.notesTitle)});
    el.querySelector(".pomo-btn").addEventListener("click",e=>{e.stopPropagation();const b=e.currentTarget;openPomodoro(b.dataset.pomoTitle,parseInt(b.dataset.pomoDur))});
    el.querySelector(".add-btn").addEventListener("click",e=>{e.stopPropagation();addToSchedule(t.id)});
    el.addEventListener("click",e=>{if(e.target.closest(".add-btn")||e.target.closest(".pomo-btn")||e.target.closest(".notes-btn"))return;const panel=el.querySelector(".detail-panel");if(panel){panel.classList.toggle("open");const chev=el.querySelector(":scope > svg");if(chev)chev.style.transform=panel.classList.contains("open")?"rotate(180deg)":""}});
    board.appendChild(el);
  });
}

// ======== PROGRESS ========
function buildProgress(){
  const track=document.getElementById("ptrack"),ds=pt("08:45"),de=pt("17:30"),tot=de-ds;
  track.innerHTML="";let cursor=ds;
  scheduled.forEach(ev=>{
    const s=pt(ev.start),e=pt(ev.end);
    if(s>cursor)addPS(track,cursor,s,"Free","rgba(255,255,255,0.08)",false,tot);
    addPS(track,s,e,ev.title,cfg(ev.type).color,isDone(ev),tot);cursor=e;
  });
  if(cursor<de)addPS(track,cursor,de,"Free","rgba(255,255,255,0.08)",false,tot);
  const dc=scheduled.filter(isDone).length;
  document.getElementById("ppct").textContent=dc+"/"+scheduled.length+" done ("+Math.round(dc/scheduled.length*100)+"%)";
}
function addPS(track,s,e,title,color,done,tot){
  const w=((e-s)/tot)*100,seg=document.createElement("div");seg.className="pseg";
  seg.style.cssText="width:"+w+"%;background:"+color+";opacity:"+(done?0.4:1);
  seg.innerHTML='<div class="tip">'+title+' ('+ms(e-s)+')'+(done?' \u2713':'')+'</div>';track.appendChild(seg);
}

// ======== STATS ========
function _actualMin(ev){
  // Get actual time worked: timer > saved sessions > planned duration
  if(typeof pomoState!=="undefined" && pomoState.taskTime && pomoState.taskTime[ev.title]>0)
    return Math.round(pomoState.taskTime[ev.title]/60);
  try{const s=loadSessions();if(s[ev.id]&&s[ev.id].length)return s[ev.id].reduce((a,x)=>a+x.durationMin,0);}catch(e){}
  return dur(ev);
}
function updateStats(){
  const done=scheduled.filter(isDone), rem=scheduled.filter(ev=>!isDone(ev));
  const remMin=rem.reduce((a,ev)=>a+dur(ev),0);
  const doneMin=done.reduce((a,ev)=>a+_actualMin(ev),0);
  document.getElementById("s-time").textContent=remMin>0?ms(remMin):"0m";
  document.getElementById("s-tasks").textContent=rem.length;
  document.getElementById("s-done").textContent=done.length+" / "+ms(doneMin);
  document.getElementById("s-block").textContent=getCurrentBlockEnd();
}
function getCurrentBlockEnd(){
  const blocks=(__state&&__state.schedule&&__state.schedule.blocks)||[];
  if(!blocks.length){
    if(scheduled.length) return f12(scheduled[scheduled.length-1].end).replace(" ","").toLowerCase();
    return "--";
  }
  const now=new Date();
  const nowMin=now.getHours()*60+now.getMinutes();
  for(const b of blocks){
    const bStart=pt(b.start),bEnd=pt(b.end);
    if(nowMin>=bStart&&nowMin<bEnd) return f12(b.end).replace(" ","").toLowerCase();
  }
  return "Done";
}

// ======== STAT POPOVERS ========
function showStatPopover(statId, event) {
  event.stopPropagation();
  const popover = document.getElementById('stat-popover');
  const wasOpen = popover.dataset.openFor === statId;
  // Close any open card highlight
  document.querySelectorAll('.stat.sp-open').forEach(el => el.classList.remove('sp-open'));
  if (wasOpen) { popover.style.display = 'none'; popover.dataset.openFor = ''; return; }
  let html = '';
  switch(statId) {
    case 's-time': {
      const rem = scheduled.filter(ev => !isDone(ev));
      html = '<div class="sp-title">Time Remaining</div>';
      if (!rem.length) { html += '<div class="sp-empty">All tasks complete!</div>'; break; }
      html += rem.map(ev => '<div class="sp-row"><span class="sp-time">'+f12(ev.start).replace(' ','')+'</span><span class="sp-label">'+ev.title+'</span><span class="sp-dur">'+ms(dur(ev))+'</span></div>').join('');
      const total = rem.reduce((a,ev) => a+dur(ev), 0);
      html += '<div class="sp-note">Total: '+ms(total)+'</div>';
      break;
    }
    case 's-tasks': {
      const rem = scheduled.filter(ev => !isDone(ev));
      html = '<div class="sp-title">Remaining Tasks</div>';
      if (!rem.length) { html += '<div class="sp-empty">Nothing left!</div>'; break; }
      html += rem.map(ev => '<div class="sp-row"><span class="sp-time">'+f12(ev.start).replace(' ','')+'</span><span class="sp-label">'+ev.title+'</span></div>').join('');
      break;
    }
    case 's-done': {
      const done = scheduled.filter(isDone);
      html = '<div class="sp-title">Completed Today</div>';
      if (!done.length) { html += '<div class="sp-empty">Nothing checked off yet.</div>'; break; }
      html += done.map(ev => {
        const t = doneAt[ev.id] ? new Date(doneAt[ev.id]).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}) : '—';
        const actual=_actualMin(ev), planned=dur(ev);
        const diff=actual-planned, diffLabel=diff>0?'+'+ms(diff):diff<0?'-'+ms(-diff):'';
        return '<div class="sp-row"><span class="sp-time">'+t+'</span><span class="sp-label">'+ev.title+'</span><span class="sp-dur">'+ms(actual)+(diffLabel?' <span style="font-size:10px;opacity:0.6">('+diffLabel+')</span>':'')+'</span></div>';
      }).join('');
      const totalActual=done.reduce((a,ev)=>a+_actualMin(ev),0), totalPlanned=done.reduce((a,ev)=>a+dur(ev),0);
      html+='<div class="sp-note">Actual: '+ms(totalActual)+' / Planned: '+ms(totalPlanned)+'</div>';
      break;
    }
    case 's-block': {
      const blocks = (__state&&__state.schedule&&__state.schedule.blocks)||[];
      if (!blocks.length) {
        const last = scheduled.length ? scheduled[scheduled.length-1] : null;
        html = '<div class="sp-title">Day Ends</div>';
        if (!last) { html += '<div class="sp-empty">No tasks scheduled.</div>'; break; }
        html += '<div class="sp-row"><span class="sp-label">'+last.title+'</span><span class="sp-dur">ends '+f12(last.end).replace(' ','')+'</span></div>';
        break;
      }
      html = '<div class="sp-title">Time Blocks</div>';
      const now = new Date();
      const nowMin = now.getHours()*60+now.getMinutes();
      html += blocks.map(b => {
        const bStart=pt(b.start),bEnd=pt(b.end);
        const isCurrent=nowMin>=bStart&&nowMin<bEnd;
        const isPast=nowMin>=bEnd;
        return '<div class="sp-row'+(isCurrent?' sp-active':'')+'" style="opacity:'+(isPast?'0.4':'1')+'">'
          +'<span class="sp-time">'+f12(b.start).replace(' ','')+'–'+f12(b.end).replace(' ','')+'</span>'
          +'<span class="sp-label">'+b.name+'</span>'
          +'<span class="sp-dur">'+(b.blockType||b.type)+(isCurrent?' (now)':'')+'</span></div>';
      }).join('');
      html += '<div class="sp-note" style="display:flex;justify-content:flex-end"><button class="sp-edit-btn" onclick="openBlockEditor()">✎ Edit Blocks</button></div>';
      break;
    }
  }
  popover.innerHTML = html;
  const rect = event.currentTarget.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 328));
  popover.style.top = (rect.bottom + 8) + 'px';
  popover.style.left = left + 'px';
  popover.style.display = 'block';
  popover.dataset.openFor = statId;
  event.currentTarget.classList.add('sp-open');
}
document.addEventListener('click', function(e) {
  const popover = document.getElementById('stat-popover');
  if (!popover) return;
  if (!e.target.closest('.stat') && !e.target.closest('#stat-popover')) {
    popover.style.display = 'none';
    popover.dataset.openFor = '';
    document.querySelectorAll('.stat.sp-open').forEach(el => el.classList.remove('sp-open'));
  }
});

// ======== BLOCK EDITOR ========
let _beBlocks = []; // working copy

function openBlockEditor(){
  // Close popover
  const popover = document.getElementById('stat-popover');
  if(popover){ popover.style.display='none'; popover.dataset.openFor=''; }
  document.querySelectorAll('.stat.sp-open').forEach(el=>el.classList.remove('sp-open'));

  // Deep copy current blocks as working set
  const src = (__state&&__state.schedule&&__state.schedule.blocks)||[];
  _beBlocks = JSON.parse(JSON.stringify(src));
  renderBlockEditor();
  document.getElementById("block-editor-overlay").classList.add("open");
}

function closeBlockEditor(){
  document.getElementById("block-editor-overlay").classList.remove("open");
  _beBlocks = [];
}

function renderBlockEditor(){
  const body = document.getElementById("block-editor-body");
  // Separate top-level and nested
  const topLevel = _beBlocks.filter(b=>!b.parent_id);
  let html = '';
  topLevel.forEach((b,i) => {
    const idx = _beBlocks.indexOf(b);
    html += renderBlockRow(b, idx, false);
    // Render children
    const children = _beBlocks.filter(c=>c.parent_id===b.id);
    children.forEach(c => {
      const cidx = _beBlocks.indexOf(c);
      html += renderBlockRow(c, cidx, true);
    });
    html += '<div class="be-add-sub" style="padding-left:20px"><button class="be-add" onclick="beAddChild('+idx+')">+ Add sub-block</button></div>';
  });
  html += '<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px"><button class="be-add" onclick="beAddBlock()">+ Add Block</button></div>';
  body.innerHTML = html;
}

function renderBlockRow(b, idx, nested){
  const bt = b.blockType||b.type||'work';
  const prot = b.protected ? 'on' : '';
  const warn = b.warnThreshold||0;
  return '<div class="be-row'+(nested?' nested':'')+'" data-idx="'+idx+'">'
    +'<input class="be-input be-name" value="'+esc(b.name||'')+'" placeholder="Name" onchange="beUpdate('+idx+',&apos;name&apos;,this.value)">'
    +'<select class="be-input be-type" onchange="beUpdate('+idx+',&apos;blockType&apos;,this.value)">'
    +'<option value="work"'+(bt==='work'?' selected':'')+'>Work</option>'
    +'<option value="personal"'+(bt==='personal'?' selected':'')+'>Personal</option></select>'
    +'<input type="time" class="be-input be-time" value="'+(b.start||'09:00')+'" onchange="beUpdate('+idx+',&apos;start&apos;,this.value)">'
    +'<input type="time" class="be-input be-time" value="'+(b.end||'17:00')+'" onchange="beUpdate('+idx+',&apos;end&apos;,this.value)">'
    +'<span class="be-toggle '+prot+'" onclick="beToggleProtected('+idx+')" title="Protected boundary">🛡</span>'
    +'<span class="be-warn"><input type="number" class="be-input be-warn-input" value="'+warn+'" min="0" max="60" placeholder="0" title="Warn threshold (minutes)" onchange="beUpdate('+idx+',&apos;warnThreshold&apos;,parseInt(this.value)||0)">m</span>'
    +'<button class="be-del" onclick="beDelete('+idx+')" title="Delete">×</button>'
    +'</div>';
}

function esc(s){ return s.replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

function beUpdate(idx, field, value){
  if(_beBlocks[idx]) _beBlocks[idx][field] = value;
}

function beToggleProtected(idx){
  if(!_beBlocks[idx]) return;
  _beBlocks[idx].protected = !_beBlocks[idx].protected;
  renderBlockEditor();
}

function beDelete(idx){
  const b = _beBlocks[idx];
  if(!b) return;
  // Delete children too
  _beBlocks = _beBlocks.filter(c => c.parent_id !== b.id);
  _beBlocks.splice(_beBlocks.indexOf(b), 1);
  renderBlockEditor();
}

function beAddBlock(){
  _beBlocks.push({
    id: '_new_'+Date.now()+'_'+Math.random().toString(36).substr(2,4),
    parent_id: null, name:'', blockType:'work', start:'09:00', end:'17:00',
    protected:false, warnThreshold:0, sort_order:_beBlocks.length, _isNew:true
  });
  renderBlockEditor();
}

function beAddChild(parentIdx){
  const parent = _beBlocks[parentIdx];
  if(!parent) return;
  _beBlocks.push({
    id: '_new_'+Date.now()+'_'+Math.random().toString(36).substr(2,4),
    parent_id: parent.id, name:'', blockType:parent.blockType||'work',
    start:parent.start, end:parent.end,
    protected:false, warnThreshold:0, sort_order:_beBlocks.length, _isNew:true
  });
  renderBlockEditor();
}

async function saveBlockEditor(){
  // Validate
  for(const b of _beBlocks){
    if(!b.name||!b.name.trim()){ showToast("Block name is required","error"); return; }
    if(!b.start||!b.end){ showToast("Start and end times are required","error"); return; }
    if(b.start>=b.end){ showToast(b.name+": start must be before end","error"); return; }
    // Validate children fit within parent
    if(b.parent_id){
      const parent = _beBlocks.find(p=>p.id===b.parent_id);
      if(parent && (b.start<parent.start||b.end>parent.end)){
        showToast(b.name+" must fit within "+parent.name,"error"); return;
      }
    }
  }

  // Get current blocks from server state to diff
  const current = (__state&&__state.schedule&&__state.schedule.blocks)||[];
  const currentIds = new Set(current.map(b=>b.id));
  const newIds = new Set(_beBlocks.map(b=>b.id));

  // Delete removed blocks
  for(const old of current){
    if(!newIds.has(old.id)){
      await blockStore.deleteBlock(old.id);
    }
  }

  // Create or update
  for(let i=0;i<_beBlocks.length;i++){
    const b = _beBlocks[i];
    const props = { name:b.name.trim(), blockType:b.blockType||'work', start:b.start, end:b.end, protected:!!b.protected, warnThreshold:b.warnThreshold||0 };
    if(b._isNew || b.id.startsWith('_new_')){
      await blockStore.createBlock("schedule_block", props, { parentId:b.parent_id, sortOrder:i });
    } else {
      await blockStore.updateBlock(b.id, props);
    }
  }

  // Refresh state — re-fetch from API
  try {
    const resp = await fetch('/api/state/day');
    const state = await resp.json();
    if(state.schedule) __state.schedule = state.schedule;
  } catch(e){}

  // Recalculate EOD
  const blocks = (__state&&__state.schedule&&__state.schedule.blocks)||[];
  const wb = blocks.filter(b=>(b.blockType||b.type)==='work');
  if(wb.length) EOD = pt(wb[wb.length-1].end);

  updateStats();
  closeBlockEditor();
  showToast("Time blocks saved","success");
}

// Wire editor modal controls
document.getElementById("block-editor-close").addEventListener("click",closeBlockEditor);
document.getElementById("block-editor-cancel").addEventListener("click",closeBlockEditor);
document.getElementById("block-editor-save").addEventListener("click",saveBlockEditor);
document.getElementById("block-editor-overlay").addEventListener("click",e=>{if(e.target===e.currentTarget)closeBlockEditor()});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&document.getElementById("block-editor-overlay").classList.contains("open"))closeBlockEditor()});

