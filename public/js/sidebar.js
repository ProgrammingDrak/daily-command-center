// ======== MINI SCHEDULE SIDEBAR ========
function buildMiniSchedule(){
  const list=document.getElementById("pomo-mini-list");if(!list)return;
  const remaining=scheduled.filter(ev=>!isDone(ev));
  const dc=scheduled.filter(isDone).length;
  const ct=document.getElementById("pomo-sidebar-count");
  if(ct)ct.textContent=remaining.length+" remaining";
  list.innerHTML="";
  if(!remaining.length){list.innerHTML='<div class="pomo-side-empty">All done! Check the Done tab.</div>';return}
  remaining.forEach(ev=>{
    const c=cfg(ev.type);
    const active=isActive(ev);
    const durMin=dur(ev);

    // Build detail content
    const detParts=[];
    if(ev.detail)detParts.push('<div style="font-size:10px;color:var(--text-muted);line-height:1.4;margin-bottom:4px">'+ev.detail+'</div>');
    if(ev.meta)detParts.push('<div style="font-size:9px;color:#64748b;margin-bottom:3px">'+ev.meta+'</div>');
    if(ev.prep&&ev.prep.length){
      ev.prep.forEach(p=>{
        const href=p.href||"#";
        const isLocal=href&&!href.startsWith("http");
        if(isLocal){
          detParts.push('<span style="font-size:9px;color:var(--amber);cursor:pointer;display:inline-flex;align-items:center;gap:3px;margin-bottom:2px" onclick="event.stopPropagation();openPrepViewer(\''+href.replace(/'/g,"\\'")+'\',\''+p.title.replace(/'/g,"\\'")+'\')"><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'+p.title+'</span>');
        } else {
          detParts.push('<a href="'+href+'" target="_blank" style="font-size:9px;color:var(--amber);text-decoration:none;display:inline-flex;align-items:center;gap:3px;margin-bottom:2px" onclick="event.stopPropagation()"><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'+p.title+'</a>');
        }
      });
    }
    if(ev.calUrl)detParts.push('<a href="'+ev.calUrl+'" target="_blank" style="font-size:9px;color:var(--accent-light);text-decoration:none;display:inline-flex;align-items:center;gap:2px" onclick="event.stopPropagation()">Open in Calendar</a>');
    if(ev.notionUrl)detParts.push('<a href="'+ev.notionUrl+'" target="_blank" style="font-size:9px;color:var(--purple);text-decoration:none;display:inline-flex;align-items:center;gap:2px;margin-left:6px" onclick="event.stopPropagation()">Open in Notion</a>');
    const hasDetail=detParts.length>0;

    const wrap=document.createElement("div");
    const el=document.createElement("div");
    el.className="pomo-mini-item"+(active?" mini-active":"");
    el.style.cursor=hasDetail?"pointer":"default";
    el.innerHTML=
      '<span class="mini-bar" style="background:'+c.color+'"></span>'+
      '<span class="mini-time">'+f12(ev.start).replace(" ","").toLowerCase()+'</span>'+
      '<span class="mini-title">'+ev.title+'</span>'+
      '<button class="pomo-mini-pomo" data-t="'+ev.title.replace(/"/g,'&quot;')+'" data-d="'+durMin+'" title="Focus on this task"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/></svg></button>';
    el.querySelector(".pomo-mini-pomo").addEventListener("click",e=>{
      e.stopPropagation();
      const b=e.currentTarget;
      openPomodoro(b.dataset.t,parseInt(b.dataset.d));
    });
    wrap.appendChild(el);

    if(hasDetail){
      const detEl=document.createElement("div");
      detEl.style.cssText="max-height:0;overflow:hidden;transition:max-height 0.2s ease;padding:0 12px 0 50px";
      detEl.innerHTML='<div style="padding:4px 0 8px;border-top:1px solid var(--border)">'+detParts.join("")+'</div>';
      wrap.appendChild(detEl);
      el.addEventListener("click",e=>{
        if(e.target.closest(".pomo-mini-pomo"))return;
        const open=detEl.style.maxHeight!=="0px"&&detEl.style.maxHeight!=="";
        detEl.style.maxHeight=open?"0px":"200px";
      });
    }
    list.appendChild(wrap);
  });
}

// ======== SIDEBAR: DONE TAB ========
function buildSideDone(){
  const list=document.getElementById("pomo-done-list");if(!list)return;
  const doneItems=scheduled.filter(isDone);
  const badge=document.getElementById("side-done-count");if(badge)badge.textContent=doneItems.length;
  list.innerHTML="";
  if(!doneItems.length){list.innerHTML='<div class="pomo-side-empty">Nothing completed yet. Check off tasks to see them here.</div>';return}

  // Group by completion time (hour buckets)
  const groups={};
  doneItems.forEach(ev=>{
    const ts=doneAt[ev.id];
    let label="Earlier";
    if(ts){
      const h=ts.getHours(),m=ts.getMinutes();
      const ap=h>=12?"PM":"AM",h12=h>12?h-12:h||12;
      label="Completed at "+h12+":"+String(m).padStart(2,"0")+" "+ap;
    }
    if(!groups[label])groups[label]=[];
    groups[label].push(ev);
  });

  Object.entries(groups).forEach(([label,items])=>{
    const hdr=document.createElement("div");hdr.className="pomo-side-done-group";hdr.textContent=label;
    list.appendChild(hdr);
    items.forEach(ev=>{
      const c=cfg(ev.type);
      const durMin=dur(ev);
      const focusSec=pomoState.taskTime[ev.title]||0;
      const focusMin=Math.round(focusSec/60);
      const el=document.createElement("div");el.className="pomo-side-done-item";
      el.innerHTML=
        '<span class="done-check"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg></span>'+
        '<span class="side-bar" style="background:'+c.color+';opacity:0.5"></span>'+
        '<div class="done-body"><div class="done-title">'+ev.title+'</div>'+
        '<div class="done-meta"><span>'+ms(durMin)+' planned</span>'+(focusMin>0?'<span>'+ms(focusMin)+' focused</span>':'')+'</div></div>';
      list.appendChild(el);
    });
  });
}

// ======== SIDEBAR: CONSIDER & BACKLOG LISTS ========
function buildSideConsider(){
  const list=document.getElementById("pomo-consider-list");if(!list)return;
  const badge=document.getElementById("side-consider-count");if(badge)badge.textContent=consider.length;
  list.innerHTML="";
  if(!consider.length){list.innerHTML='<div class="pomo-side-empty">Nothing flagged for today.</div>';return}
  consider.forEach(t=>{
    const c=cfg(t.type);
    const wrap=document.createElement("div");
    const el=document.createElement("div");el.className="pomo-side-card";
    el.innerHTML=
      '<span class="side-bar" style="background:'+c.color+'"></span>'+
      '<div class="side-body"><div class="side-title">'+t.title+'</div>'+
      '<div class="side-meta"><span>'+c.tag+'</span><span>'+ms(t.durMin)+'</span>'+(t.priority?'<span class="pri-'+(t.priority==="High"?"hi":t.priority==="Medium"?"med":"lo")+'">'+t.priority+'</span>':'')+'</div></div>'+
      '<button class="pomo-mini-pomo" data-t="'+t.title.replace(/"/g,'&quot;')+'" data-d="'+t.durMin+'" title="Focus on this task"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/></svg></button>';
    el.querySelector(".pomo-mini-pomo").addEventListener("click",e=>{
      e.stopPropagation();openPomodoro(e.currentTarget.dataset.t,parseInt(e.currentTarget.dataset.d));
    });
    wrap.appendChild(el);
    // Expandable detail
    if(t.detail||t.notionUrl){
      const det=document.createElement("div");det.style.cssText="max-height:0;overflow:hidden;transition:max-height 0.2s ease;padding:0 12px 0 24px";
      let dhtml='<div style="padding:4px 0 8px;border-top:1px solid var(--border)">';
      if(t.detail)dhtml+='<div style="font-size:10px;color:var(--text-muted);line-height:1.4;margin-bottom:4px">'+t.detail+'</div>';
      if(t.notionUrl)dhtml+='<a href="'+t.notionUrl+'" target="_blank" style="font-size:9px;color:var(--purple);text-decoration:none">Open in Notion</a>';
      dhtml+='</div>';det.innerHTML=dhtml;
      wrap.appendChild(det);
      el.style.cursor="pointer";
      el.addEventListener("click",e=>{if(e.target.closest(".pomo-mini-pomo"))return;det.style.maxHeight=det.style.maxHeight&&det.style.maxHeight!=="0px"?"0px":"200px"});
    }
    list.appendChild(wrap);
  });
}
function buildSideBacklog(){
  const list=document.getElementById("pomo-backlog-list");if(!list)return;
  const badge=document.getElementById("side-backlog-count");if(badge)badge.textContent=backlog.length;
  list.innerHTML="";
  if(!backlog.length){list.innerHTML='<div class="pomo-side-empty">No backlog items.</div>';return}
  backlog.forEach(t=>{
    const c=cfg(t.type);
    const wrap=document.createElement("div");
    const el=document.createElement("div");el.className="pomo-side-card";
    el.innerHTML=
      '<span class="side-bar" style="background:'+c.color+'"></span>'+
      '<div class="side-body"><div class="side-title">'+t.title+'</div>'+
      '<div class="side-meta"><span>'+c.tag+'</span><span>'+ms(t.durMin)+'</span>'+(t.priority?'<span class="pri-'+(t.priority==="High"?"hi":t.priority==="Medium"?"med":"lo")+'">'+t.priority+'</span>':'')+(t.stage?'<span>'+t.stage+'</span>':'')+'</div></div>'+
      '<button class="pomo-mini-pomo" data-t="'+t.title.replace(/"/g,'&quot;')+'" data-d="'+t.durMin+'" title="Focus on this task"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/></svg></button>';
    el.querySelector(".pomo-mini-pomo").addEventListener("click",e=>{
      e.stopPropagation();openPomodoro(e.currentTarget.dataset.t,parseInt(e.currentTarget.dataset.d));
    });
    wrap.appendChild(el);
    if(t.detail||t.notionUrl){
      const det=document.createElement("div");det.style.cssText="max-height:0;overflow:hidden;transition:max-height 0.2s ease;padding:0 12px 0 24px";
      let dhtml='<div style="padding:4px 0 8px;border-top:1px solid var(--border)">';
      if(t.detail)dhtml+='<div style="font-size:10px;color:var(--text-muted);line-height:1.4;margin-bottom:4px">'+t.detail+'</div>';
      if(t.notionUrl)dhtml+='<a href="'+t.notionUrl+'" target="_blank" style="font-size:9px;color:var(--purple);text-decoration:none">Open in Notion</a>';
      dhtml+='</div>';det.innerHTML=dhtml;
      wrap.appendChild(det);
      el.style.cursor="pointer";
      el.addEventListener("click",e=>{if(e.target.closest(".pomo-mini-pomo"))return;det.style.maxHeight=det.style.maxHeight&&det.style.maxHeight!=="0px"?"0px":"200px"});
    }
    list.appendChild(wrap);
  });
}

// Sidebar tab switching
document.querySelectorAll(".pomo-side-tab").forEach(tab=>{
  tab.addEventListener("click",()=>{
    document.querySelectorAll(".pomo-side-tab").forEach(t=>t.classList.remove("active"));
    document.querySelectorAll(".pomo-side-panel").forEach(p=>p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("side-"+tab.dataset.side).classList.add("active");
    if(tab.dataset.side==="consider")buildSideConsider();
    if(tab.dataset.side==="backlog")buildSideBacklog();
    if(tab.dataset.side==="done")buildSideDone();
  });
});

// ======== TASK PICKER ========
function openTaskPicker(){
  const overlay=document.getElementById("pomo-picker-overlay");
  overlay.classList.add("open");
  document.getElementById("pomo-picker-q").value="";
  buildPickerList("");
  setTimeout(()=>document.getElementById("pomo-picker-q").focus(),50);
}
function closeTaskPicker(){
  document.getElementById("pomo-picker-overlay").classList.remove("open");
}
function buildPickerList(query){
  const list=document.getElementById("pomo-picker-list");list.innerHTML="";
  const q=query.toLowerCase();
  // Gather all tasks from schedule, consider, backlog
  const groups=[
    {label:"Schedule",items:scheduled.map(ev=>({title:ev.title,dur:dur(ev),color:cfg(ev.type).color,type:ev.type}))},
    {label:"Consider for Today",items:consider.map(t=>({title:t.title,dur:t.durMin,color:cfg(t.type).color,type:t.type}))},
    {label:"Backlog",items:backlog.map(t=>({title:t.title,dur:t.durMin,color:cfg(t.type).color,type:t.type}))}
  ];
  groups.forEach(g=>{
    const filtered=g.items.filter(i=>!q||i.title.toLowerCase().includes(q));
    if(!filtered.length)return;
    const hdr=document.createElement("div");hdr.className="pomo-picker-group";hdr.textContent=g.label;list.appendChild(hdr);
    filtered.forEach(item=>{
      const el=document.createElement("div");el.className="pomo-picker-item";
      el.innerHTML='<div class="ppi-bar" style="background:'+item.color+'"></div><div class="ppi-body"><div class="ppi-title">'+item.title+'</div><div class="ppi-meta">'+cfg(item.type).tag+' &middot; '+ms(item.dur)+'</div></div><div class="ppi-dur">'+ms(item.dur)+'</div>';
      el.addEventListener("click",()=>{closeTaskPicker();openPomodoro(item.title,item.dur)});
      list.appendChild(el);
    });
  });
}
document.getElementById("pomo-task-card").addEventListener("click",e=>{
  if(e.target.closest("#pomo-task-check"))return;
  openTaskPicker();
});
document.getElementById("pomo-picker-close").addEventListener("click",closeTaskPicker);
document.getElementById("pomo-picker-overlay").addEventListener("click",e=>{if(e.target===e.currentTarget)closeTaskPicker()});
document.getElementById("pomo-picker-q").addEventListener("input",e=>buildPickerList(e.target.value));
document.getElementById("pomo-picker-new-btn").addEventListener("click",()=>{
  const title=document.getElementById("pomo-picker-new-title").value.trim();if(!title)return;
  const durMin=parseInt(document.getElementById("pomo-picker-new-dur").value);
  closeTaskPicker();openPomodoro(title,durMin);
  document.getElementById("pomo-picker-new-title").value="";
});
document.getElementById("pomo-picker-new-title").addEventListener("keydown",e=>{if(e.key==="Enter")document.getElementById("pomo-picker-new-btn").click()});

