(function(){
  const cache = new Map();
  const loading = new Set();

  function esc(s) { return window.DCC.esc(s); } // delegates to core.js

  function toast(msg,type) { return window.DCC.toast(msg,type); } // delegates to core.js

  function cssId(id){
    if(window.CSS&&typeof CSS.escape==="function")return CSS.escape(id);
    return String(id||"").replace(/["\\]/g,"\\$&");
  }

  function meetingAutomationPanelHtml(ev){
    const id=ev.meetingBlockId||ev.id;
    return '<div class="meeting-auto-panel" data-meeting-auto-id="'+esc(id)+'">'+
      '<div class="ma-head">'+
        '<span>Meeting automation</span>'+
        '<button class="ma-mini-btn ma-prep-btn" data-meeting-id="'+esc(id)+'" type="button">Generate prep</button>'+
      '</div>'+
      '<div class="ma-body" data-ma-body="'+esc(id)+'">'+
        '<div class="ma-empty">Prep, transcripts, summaries, and proposed actions will appear here.</div>'+
      '</div>'+
    '</div>';
  }

  function sourceHtml(s){
    if(!s)return "";
    const label=s.title||s.type||"Source";
    if(s.url)return '<a href="'+esc(s.url)+'" target="_blank" onclick="event.stopPropagation()">'+esc(label)+'</a>';
    if(s.query)return '<span title="'+esc(s.query)+'">'+esc(label)+'</span>';
    return '<span>'+esc(label)+'</span>';
  }

  function artifactSources(sources){
    if(!sources||!sources.length)return "";
    return '<div class="ma-sources">'+sources.map(sourceHtml).join('')+'</div>';
  }

  function renderPanel(id,data){
    document.querySelectorAll('.meeting-auto-panel[data-meeting-auto-id="'+cssId(id)+'"]').forEach(panel=>{
      const body=panel.querySelector(".ma-body");
      if(!body)return;
      const prep=data&&data.prep;
      const summary=data&&data.summary;
      const transcript=data&&data.transcript;
      const proposed=(data&&data.proposedActions||[]).filter(a=>a.status!=="approved");
      const approved=(data&&data.proposedActions||[]).filter(a=>a.status==="approved");
      let html="";
      html+='<div class="ma-section">'+
        '<div class="ma-label">Prep brief</div>'+
        (prep?'<div class="ma-doc">'+(prep.html||('<p>'+esc(prep.markdown||"")+'</p>'))+'</div>'+artifactSources(prep.sources):'<div class="ma-empty">No prep generated yet.</div>')+
      '</div>';
      html+='<div class="ma-section">'+
        '<div class="ma-label">Transcript intake</div>'+
        (summary?'<div class="ma-doc">'+(summary.html||('<p>'+esc(summary.markdown||"")+'</p>'))+'</div>':(transcript?'<div class="ma-empty">Transcript saved. Summary pending.</div>':'<div class="ma-empty">Paste transcript text when available, or use evidence discovered from Calendar/Gmail review.</div>'))+
        '<textarea class="ma-transcript" data-meeting-id="'+esc(id)+'" placeholder="Paste transcript or notes here..."></textarea>'+
        '<button class="ma-mini-btn ma-ingest-btn" data-meeting-id="'+esc(id)+'" type="button">Summarize transcript</button>'+
      '</div>';
      html+='<div class="ma-section">'+
        '<div class="ma-label">Proposed actions</div>';
      if(proposed.length){
        html+='<div class="ma-actions">'+proposed.map(a=>
          '<label class="ma-action"><input type="checkbox" checked value="'+esc(a.id)+'"><span>'+esc(a.text||a.title)+'</span><em>'+esc(a.priority||"Medium")+'</em></label>'
        ).join('')+'</div>'+
        '<button class="ma-approve-btn" data-meeting-id="'+esc(id)+'" type="button">Approve selected</button>';
      }else{
        html+='<div class="ma-empty">No proposed actions waiting for review.</div>';
      }
      if(approved.length)html+='<div class="ma-approved">'+approved.length+' approved action'+(approved.length===1?'':'s')+' added to this meeting.</div>';
      html+='</div>';
      body.innerHTML=html;
    });
  }

  async function fetchAutomation(id,force){
    if(!force&&cache.has(id)){const data=cache.get(id);renderPanel(id,data);return data;}
    if(loading.has(id))return cache.get(id)||null;
    loading.add(id);
    try{
      const res=await fetch('/api/meetings/'+encodeURIComponent(id)+'/automation');
      const data=await res.json();
      if(!res.ok)throw new Error(data.error||"Could not load meeting automation");
      cache.set(id,data);
      renderPanel(id,data);
      return data;
    }catch(e){
      document.querySelectorAll('.meeting-auto-panel[data-meeting-auto-id="'+cssId(id)+'"] .ma-body').forEach(body=>{
        body.innerHTML='<div class="ma-empty ma-error">'+esc(e.message||"Could not load automation")+'</div>';
      });
      return null;
    }finally{
      loading.delete(id);
    }
  }

  function refreshMeetingAutomationPanels(singleId){
    const panels=[...document.querySelectorAll(".meeting-auto-panel")];
    const ids=[...new Set(panels.map(p=>p.dataset.meetingAutoId).filter(Boolean))];
    ids.filter(id=>!singleId||id===singleId).forEach(id=>fetchAutomation(id,false));
  }

  async function postJson(url,body){
    const res=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||"Request failed");
    return data;
  }

  // After actions are approved they live under the meeting; offer to place them on
  // a day in one batch. Picking a day promotes every approved action to a standalone
  // task on it (server detaches the parent); closing the popover leaves them under
  // the meeting exactly as before. Anchors to the live panel — the approve button
  // was just re-rendered away.
  function offerPlacement(meetingId,blocks){
    const list=(blocks||[]).filter(b=>b&&b.id);
    if(!list.length||typeof openDatePickPopover!=="function")return;
    const anchor=document.querySelector('.meeting-auto-panel[data-meeting-auto-id="'+cssId(meetingId)+'"]');
    if(!anchor)return;
    const n=list.length;
    // Reuse the shared pick-a-day wrapper (schedule-popover.js) rather than
    // inlining openSchedulePopover({mode:"pick"}) — same wrapper the delegated
    // follow-ups use, so pick-mode defaults stay single-sourced.
    openDatePickPopover(anchor,{
      header:"Place "+n+" action"+(n===1?"":"s")+" on a day?",
      actionLabel:"Place",
      onPick:async(dateStr)=>{
        let ok=0;
        for(const b of list){
          try{await postJson('/api/meetings/'+encodeURIComponent(meetingId)+'/actions/'+encodeURIComponent(b.id)+'/place',{date:dateStr});ok++;}
          catch(e){}
        }
        toast(ok?("Placed "+ok+" action"+(ok===1?"":"s")+" on "+dateStr):"Could not place actions",ok?undefined:"error");
        fetchAutomation(meetingId,true);
        if(typeof buildActionItemsTab==="function")buildActionItemsTab();
      }
    });
  }

  document.addEventListener("click",async e=>{
    const prep=e.target.closest(".ma-prep-btn");
    const ingest=e.target.closest(".ma-ingest-btn");
    const approve=e.target.closest(".ma-approve-btn");
    if(prep){
      e.stopPropagation();
      const id=prep.dataset.meetingId;
      prep.disabled=true;prep.textContent="Generating...";
      try{
        const data=await postJson('/api/meetings/'+encodeURIComponent(id)+'/prep',{});
        cache.set(id,data);renderPanel(id,data);toast("Prep generated");
      }catch(err){toast(err.message||"Prep failed","error")}
      finally{prep.disabled=false;prep.textContent="Refresh prep";}
    }
    if(ingest){
      e.stopPropagation();
      const id=ingest.dataset.meetingId;
      const ta=document.querySelector('.ma-transcript[data-meeting-id="'+cssId(id)+'"]');
      const text=ta?ta.value.trim():"";
      if(!text){toast("Paste transcript text first","error");return;}
      ingest.disabled=true;ingest.textContent="Summarizing...";
      try{
        const data=await postJson('/api/meetings/'+encodeURIComponent(id)+'/transcript/ingest',{transcriptText:text,sources:[{type:"manual_transcript",title:"Pasted transcript",capturedAt:new Date().toISOString()}]});
        cache.set(id,data);renderPanel(id,data);toast("Transcript summarized");
      }catch(err){toast(err.message||"Transcript ingest failed","error")}
      finally{ingest.disabled=false;ingest.textContent="Summarize transcript";}
    }
    if(approve){
      e.stopPropagation();
      const id=approve.dataset.meetingId;
      const checks=[...document.querySelectorAll('.meeting-auto-panel[data-meeting-auto-id="'+cssId(id)+'"] .ma-action input:checked')];
      const actionIds=checks.map(c=>c.value);
      if(!actionIds.length){toast("Select at least one action","error");return;}
      approve.disabled=true;approve.textContent="Approving...";
      try{
        const data=await postJson('/api/meetings/'+encodeURIComponent(id)+'/actions/approve',{actionIds});
        cache.set(id,data);renderPanel(id,data);
        if(typeof buildActionItemsTab==="function")buildActionItemsTab();
        toast("Actions added");
        offerPlacement(id,data.approvedBlocks);
      }catch(err){toast(err.message||"Approval failed","error")}
      finally{approve.disabled=false;approve.textContent="Approve selected";}
    }
  },true);


  window.meetingAutomationPanelHtml=meetingAutomationPanelHtml;
  window.refreshMeetingAutomationPanels=refreshMeetingAutomationPanels;
})();
