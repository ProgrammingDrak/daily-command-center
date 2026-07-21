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


  // ── Clean prep reading view (modal) ───────────────────────────────────────
  // The inline .ma-* panel is built to live in a card's detail area; in a bare
  // modal it reads as an unstyled form. openPrepModal renders a focused,
  // token-styled prep brief instead -- used when the Prep chip / radial spoke
  // opens prep in the list view (which has no inline panel). Reuses the
  // automation cache + endpoint.
  function fmtClock(iso){ try{ return new Date(iso).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}).replace(" ",""); }catch(_){ return ""; } }

  // Minimal markdown -> HTML for prep briefs (headings, bullets, bold, links,
  // paragraphs). Server-generated preps already carry .html; this covers the
  // template/manual prep (markdown only) and is escape-first for safety.
  function mdToHtml(md){
    if(!md) return "";
    const inline = s => esc(s)
      .replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
    const out=[]; let inList=false;
    const closeList=()=>{ if(inList){out.push("</ul>");inList=false;} };
    String(md).replace(/\r\n/g,"\n").split("\n").forEach(raw=>{
      const line=raw.trim();
      if(!line){ closeList(); return; }
      let m;
      if(m=line.match(/^(#{1,6})\s+(.*)$/)){ closeList(); const lvl=Math.min(m[1].length,4); out.push("<h"+lvl+">"+inline(m[2])+"</h"+lvl+">"); }
      else if(m=line.match(/^[-*]\s+(.*)$/)){ if(!inList){out.push("<ul>");inList=true;} out.push("<li>"+inline(m[1])+"</li>"); }
      else { closeList(); out.push("<p>"+inline(line)+"</p>"); }
    });
    closeList();
    return out.join("");
  }

  function prepDocHtml(data){
    const prep=data&&data.prep;
    const actions=((data&&data.proposedActions)||[]).filter(a=>a.status!=="approved");
    let html="";
    if(prep&&(prep.html||prep.markdown)){
      // Prefer rendering the raw markdown with our own converter: the server's
      // markdownToHtml is lossy (wraps blocks in <h4>, drops bullets/bold), so
      // prep.html reads flat. Fall back to it only when markdown is absent.
      html+='<div class="prep-doc">'+(prep.markdown?mdToHtml(prep.markdown):(prep.html||""))+'</div>';
      if(prep.sources&&prep.sources.length)html+=artifactSources(prep.sources);
    }else{
      html+='<div class="prep-view-empty"><span>No prep has been generated for this meeting yet.</span>'+
        '<button class="prep-gen-btn" type="button">Generate prep</button></div>';
    }
    if(actions.length){
      html+='<div class="prep-view-actions"><div class="prep-view-kicker">Proposed actions</div><ul>'+
        actions.map(a=>'<li>'+esc(a.text||a.title||"")+(a.priority?'<em>'+esc(a.priority)+'</em>':'')+'</li>').join('')+'</ul></div>';
    }
    return html;
  }

  function openPrepModal(ev){
    if(!(window.DCC&&typeof DCC.modal==="function"))return;
    const id=ev.meetingBlockId||ev.id;
    const timeStr=(ev.start&&ev.end)?fmtClock(ev.start)+" – "+fmtClock(ev.end):"";
    const modal=DCC.modal({
      title:ev.title||"Meeting prep",
      body:'<div class="prep-view">'+
        '<div class="prep-view-meta">Meeting prep'+(timeStr?' · '+esc(timeStr):'')+'</div>'+
        '<div class="prep-view-doc"><div class="prep-view-loading">Loading prep…</div></div>'+
      '</div>'
    });
    if(modal&&modal.el)modal.el.classList.add("prep-modal");
    const docEl=modal.el.querySelector(".prep-view-doc");
    async function load(force){
      let data=(!force&&cache.get(id))||null;
      if(!data){
        try{ const res=await fetch('/api/meetings/'+encodeURIComponent(id)+'/automation'); data=await res.json(); if(!res.ok)throw new Error(data.error||"load failed"); cache.set(id,data); }
        catch(e){ if(docEl)docEl.innerHTML='<div class="prep-view-empty">Could not load prep.</div>'; return; }
      }
      if(!docEl)return;
      docEl.innerHTML=prepDocHtml(data);
      const gen=docEl.querySelector(".prep-gen-btn");
      if(gen)gen.addEventListener("click",async()=>{
        gen.disabled=true;gen.textContent="Generating…";
        try{ await postJson('/api/meetings/'+encodeURIComponent(id)+'/prep',{}); load(true); if(typeof refreshMeetingAutomationPanels==="function")refreshMeetingAutomationPanels(id); }
        catch(err){ gen.disabled=false;gen.textContent="Generate prep"; toast(err.message||"Prep failed","error"); }
      });
    }
    load(false);
  }

  window.meetingAutomationPanelHtml=meetingAutomationPanelHtml;
  window.refreshMeetingAutomationPanels=refreshMeetingAutomationPanels;
  window.openPrepModal=openPrepModal;
})();
