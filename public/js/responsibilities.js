// ======== RESPONSIBILITIES TAB ========
// Responsibilities are durable obligations. They become scheduled tasks only
// when their cadence/score or a trigger makes them actionable.
(function(){
  let _items = [];
  let _filter = "active";

  function esc(s){
    if(s==null)return "";
    return (typeof escHtml==="function"?escHtml(String(s)):String(s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"));
  }

  function scoreClass(score){
    if(score >= 85) return "high";
    if(score >= 50) return "med";
    return "low";
  }

  function daysAgo(iso){
    if(!iso)return "never completed";
    const d=new Date(iso);
    if(isNaN(d.getTime()))return "never completed";
    const days=Math.floor((Date.now()-d.getTime())/86400000);
    if(days<=0)return "completed today";
    if(days===1)return "completed 1d ago";
    return "completed "+days+"d ago";
  }

  function getResponsibilities(){
    return _items.filter(i=>(i.properties||{}).kind==="responsibility_item");
  }

  function applyFilter(items){
    if(_filter==="all")return items;
    if(_filter==="due")return items.filter(i=>Number((i.properties||{}).importanceScore||0)>=70 && (i.properties||{}).status!=="archived");
    return items.filter(i=>((i.properties||{}).status||"active")===_filter);
  }

  async function loadResponsibilities(){
    try{
      const res=await fetch("/api/responsibilities");
      if(!res.ok)throw new Error(res.statusText);
      const data=await res.json();
      _items=data.items||[];
      renderResponsibilities();
      return _items;
    }catch(e){
      if(typeof showToast==="function")showToast("Could not load responsibilities: "+(e.message||e),"error");
      return [];
    }
  }

  function renderResponsibilities(){
    const mount=document.getElementById("responsibilities-list");
    if(!mount)return;
    const all=getResponsibilities().sort((a,b)=>Number((b.properties||{}).importanceScore||0)-Number((a.properties||{}).importanceScore||0));
    const visible=applyFilter(all);
    const badge=document.getElementById("responsibilities-count");
    if(badge){
      const due=all.filter(i=>Number((i.properties||{}).importanceScore||0)>=70 && (i.properties||{}).status!=="archived").length;
      badge.textContent=due;
      badge.style.display=due?"":"none";
    }
    if(!visible.length){
      mount.innerHTML='<div class="delegated-empty">No responsibilities match this view.</div>';
      return;
    }
    mount.innerHTML=visible.map(item=>{
      const p=item.properties||{};
      const score=Number(p.importanceScore||0);
      const subtasks=Array.isArray(p.defaultSubtasks)?p.defaultSubtasks:[];
      return '<div class="resp-card" data-id="'+esc(item.id)+'">'+
        '<div class="resp-score '+scoreClass(score)+'">'+score+'</div>'+
        '<div class="resp-body">'+
          '<div class="resp-title-row">'+
            '<div class="resp-title">'+esc(p.title||"(untitled)")+'</div>'+
            '<span class="resp-chip domain">'+esc(p.domain||"other")+'</span>'+
            '<span class="resp-chip">'+esc(p.status||"active")+'</span>'+
          '</div>'+
          '<div class="resp-meta">'+
            '<span>'+esc(p.area||"general")+'</span>'+
            '<span>'+esc(p.capacityBucket||"work_admin")+'</span>'+
            '<span>Every '+esc(p.cadenceDays||7)+'d</span>'+
            '<span>'+esc(p.estimatedMinutes||30)+'m</span>'+
            '<span>'+esc(daysAgo(p.lastCompletedAt))+'</span>'+
          '</div>'+
          (subtasks.length?'<div class="resp-subtasks">'+esc(subtasks.slice(0,3).join(" · "))+(subtasks.length>3?" · ...":"")+'</div>':'')+
        '</div>'+
        '<div class="resp-card-actions">'+
          '<button data-act="schedule">Schedule</button>'+
          '<button data-act="complete">Complete</button>'+
          '<button data-act="edit">Edit</button>'+
          '<button class="danger" data-act="'+(p.status==="archived"?"activate":"archive")+'">'+(p.status==="archived"?"Activate":"Archive")+'</button>'+
        '</div>'+
      '</div>';
    }).join("");
    mount.querySelectorAll(".resp-card-actions button").forEach(btn=>{
      btn.addEventListener("click",()=>handleCardAction(btn.closest(".resp-card").dataset.id,btn.dataset.act));
    });
  }

  async function handleCardAction(id,act){
    const item=_items.find(i=>i.id===id);
    if(!item)return;
    try{
      if(act==="schedule"){
        const res=await fetch("/api/responsibilities/"+encodeURIComponent(id)+"/schedule",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({})});
        if(!res.ok)throw new Error((await res.json()).error||res.statusText);
        if(typeof showToast==="function")showToast("Responsibility scheduled","success");
        location.reload();
      }else if(act==="complete"){
        const res=await fetch("/api/responsibilities/"+encodeURIComponent(id)+"/complete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({completedAt:new Date().toISOString()})});
        if(!res.ok)throw new Error((await res.json()).error||res.statusText);
        await loadResponsibilities();
      }else if(act==="archive"||act==="activate"){
        await patchResponsibility(id,{status:act==="archive"?"archived":"active"});
        await loadResponsibilities();
      }else if(act==="edit"){
        openResponsibilityModal(id);
      }
    }catch(e){
      if(typeof showToast==="function")showToast("Responsibility action failed: "+(e.message||e),"error");
    }
  }

  function openResponsibilityModal(id){
    const item=id?_items.find(i=>i.id===id):null;
    const p=item?(item.properties||{}):{};
    document.getElementById("resp-id").value=id||"";
    document.getElementById("resp-title").value=p.title||"";
    document.getElementById("resp-domain").value=p.domain||"professional";
    document.getElementById("resp-area").value=p.area||"general";
    document.getElementById("resp-cadence-days").value=p.cadenceDays||7;
    document.getElementById("resp-estimated-minutes").value=p.estimatedMinutes||30;
    document.getElementById("resp-capacity-bucket").value=p.capacityBucket||"work_admin";
    document.getElementById("resp-default-subtasks").value=Array.isArray(p.defaultSubtasks)?p.defaultSubtasks.join("\n"):"";
    document.getElementById("resp-modal-title").textContent=id?"Edit responsibility":"New responsibility";
    document.getElementById("responsibility-modal-overlay").classList.add("open");
    setTimeout(()=>document.getElementById("resp-title").focus(),20);
  }

  function closeResponsibilityModal(){
    const overlay=document.getElementById("responsibility-modal-overlay");
    if(overlay)overlay.classList.remove("open");
  }

  function formProps(){
    return {
      title:document.getElementById("resp-title").value.trim(),
      domain:document.getElementById("resp-domain").value,
      area:document.getElementById("resp-area").value.trim()||"general",
      cadenceDays:Math.max(1,parseInt(document.getElementById("resp-cadence-days").value,10)||7),
      estimatedMinutes:Math.max(1,parseInt(document.getElementById("resp-estimated-minutes").value,10)||30),
      capacityBucket:document.getElementById("resp-capacity-bucket").value,
      defaultSubtasks:document.getElementById("resp-default-subtasks").value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),
      status:"active"
    };
  }

  async function patchResponsibility(id,props){
    const res=await fetch("/api/responsibilities/"+encodeURIComponent(id),{
      method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({properties:props})
    });
    if(!res.ok)throw new Error((await res.json()).error||res.statusText);
    return res.json();
  }

  async function saveResponsibility(){
    const id=document.getElementById("resp-id").value||null;
    const props=formProps();
    if(!props.title){if(typeof showToast==="function")showToast("Title is required","error");return;}
    try{
      const res=await fetch(id?"/api/responsibilities/"+encodeURIComponent(id):"/api/responsibilities",{
        method:id?"PATCH":"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({properties:props})
      });
      if(!res.ok)throw new Error((await res.json()).error||res.statusText);
      closeResponsibilityModal();
      await loadResponsibilities();
      if(typeof showToast==="function")showToast("Responsibility saved","success");
    }catch(e){
      if(typeof showToast==="function")showToast("Save failed: "+(e.message||e),"error");
    }
  }

  async function captureResponsibility(){
    const el=document.getElementById("resp-capture-text");
    const text=el?el.value.trim():"";
    if(!text){if(typeof showToast==="function")showToast("Paste something to capture first","error");return;}
    try{
      const res=await fetch("/api/responsibilities/capture",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text})});
      if(!res.ok)throw new Error((await res.json()).error||res.statusText);
      const data=await res.json();
      if(el)el.value="";
      await loadResponsibilities();
      if(data.task&&data.task.properties&&data.task.properties.local_id){
        if(typeof showToast==="function")showToast(data.duplicate?"Alert already captured":"Alert captured and scheduled","success");
        location.reload();
      }else if(typeof showToast==="function")showToast("Responsibility captured","success");
    }catch(e){
      if(typeof showToast==="function")showToast("Capture failed: "+(e.message||e),"error");
    }
  }

  async function autoScheduleDue(){
    try{
      const res=await fetch("/api/responsibilities/auto-schedule",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({threshold:70,limit:3})});
      if(!res.ok)throw new Error((await res.json()).error||res.statusText);
      const data=await res.json();
      const count=(data.scheduled||[]).filter(x=>x.created).length;
      if(typeof showToast==="function")showToast(count?("Scheduled "+count+" due responsibilities"):"No new due responsibilities to schedule",count?"success":"info");
      if(count)location.reload();
    }catch(e){
      if(typeof showToast==="function")showToast("Auto-schedule failed: "+(e.message||e),"error");
    }
  }

  async function markResponsibilityTaskCompleted(ev){
    if(!ev||!ev.responsibilityId)return;
    try{
      await fetch("/api/responsibilities/"+encodeURIComponent(ev.responsibilityId)+"/complete",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({taskId:ev.id,completedAt:new Date().toISOString()})
      });
      await loadResponsibilities();
    }catch(e){console.warn("[responsibilities] completion sync failed",e);}
  }

  function bindResponsibilities(){
    document.querySelectorAll(".resp-filter-btn").forEach(btn=>{
      btn.addEventListener("click",()=>{
        document.querySelectorAll(".resp-filter-btn").forEach(b=>b.classList.remove("active"));
        btn.classList.add("active");
        _filter=btn.dataset.filter||"active";
        renderResponsibilities();
      });
    });
    const newBtn=document.getElementById("resp-new-btn");
    if(newBtn)newBtn.addEventListener("click",()=>openResponsibilityModal(null));
    const cancel=document.getElementById("resp-cancel");
    if(cancel)cancel.addEventListener("click",closeResponsibilityModal);
    const save=document.getElementById("resp-save");
    if(save)save.addEventListener("click",saveResponsibility);
    const overlay=document.getElementById("responsibility-modal-overlay");
    if(overlay)overlay.addEventListener("click",e=>{if(e.target===overlay)closeResponsibilityModal();});
    const capture=document.getElementById("resp-capture-btn");
    if(capture)capture.addEventListener("click",captureResponsibility);
    const auto=document.getElementById("resp-auto-schedule-btn");
    if(auto)auto.addEventListener("click",autoScheduleDue);
  }

  document.addEventListener("DOMContentLoaded",bindResponsibilities);
  window.loadResponsibilities=loadResponsibilities;
  window.renderResponsibilities=renderResponsibilities;
  window.markResponsibilityTaskCompleted=markResponsibilityTaskCompleted;
})();
