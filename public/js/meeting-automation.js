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
      // "dismissed" belongs in this list: a dismissed proposal is terminal, and without
      // it the panel renders one as a PRE-CHECKED row under "Approve selected". The
      // server's allowlist means clicking that mints nothing, so this is a display lie
      // rather than a resurrection — but it is the surface a dropped item shows up on.
      const proposed=(data&&data.proposedActions||[]).filter(a=>a.status!=="approved"&&a.status!=="placed"&&a.status!=="dismissed");
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

  async function patchJson(url,body){
    const res=await fetch(url,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})});
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
  // Format a meeting time exactly like the itinerary row does. ev.start/end are
  // DCC's local "HH:MM" strings (parsed by f12/pt in state.js), NOT ISO -- using
  // new Date() on them yields "Invalid Date". Prefer the shared f12; return ""
  // on anything unparseable so the meta line never shows a garbage time.
  function fmtClock(t){
    if(t==null||t==="")return "";
    if(typeof f12==="function"){ const s=f12(t); if(s&&!/NaN/.test(s))return s; }
    const d=new Date(t); return isNaN(d.getTime())?"":d.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"});
  }

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

  // Recap tab: render the meeting's action items INLINE under the summary, each
  // schedulable in one click. Rendered read-model comes straight from the shared
  // /automation bundle (data.proposedActions). owner:"other" items are shown but
  // not scheduled onto Drake's day. `placed` is the in-modal session map so a
  // just-scheduled item shows "Scheduled ✓" instantly; the durable signal is the
  // proposal's own status:"placed"/placedDate (stamped by placeApprovedAction), so
  // it survives a reopen too.
  function recapTime(seconds){
    seconds=Math.max(0,Math.round(Number(seconds)||0));
    const h=Math.floor(seconds/3600),m=Math.floor((seconds%3600)/60),s=seconds%60;
    return (h?String(h).padStart(2,"0")+":":"")+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0");
  }

  function recapAttachmentHtml(data,id){
    const meeting=data&&data.meeting||{};
    if(!meeting.dashboardRef&&!meeting.recordingSource)return "";
    let links="";
    if(meeting.dashboardRef)links+='<a class="recap-recording-link" href="/meetings/'+encodeURIComponent(id)+'/dashboard" target="_blank" rel="noopener">▶ Full recording &amp; transcript</a>';
    if(meeting.recordingSource&&meeting.recordingSource.url)links+='<a class="recap-recording-link cold" href="'+esc(meeting.recordingSource.url)+'" target="_blank" rel="noopener">Cold-storage source</a>';
    return '<div class="recap-recording-attachment"><div class="prep-view-kicker">Meeting record</div>'+links+'</div>';
  }

  function recapActionsHtml(actions,placed,id,dashboardRef){
    if(!actions.length){
      return '<div class="prep-view-actions recap-actions"><div class="prep-view-empty recap-empty"><span>No action items captured for this meeting.</span></div></div>';
    }
    const group=(title,items)=>{
      if(!items.length)return '';
      return '<div class="recap-action-group"><div class="prep-view-kicker">'+esc(title)+'</div>'+items.map(a=>{
      // Dropped is resolved FIRST, ahead of `pl`. That session map records "scheduled
      // during this page session", so schedule here -> drop it in Loose Ends -> reopen
      // this modal without a reload would otherwise still claim "Scheduled ✓" off a
      // stale in-memory entry. Server truth outranks the optimistic map.
      const isDropped=a.status==="dismissed"&&a.dismissedReason==="task-dropped";
      const pl=!isDropped&&placed&&placed.get(a.id);
      const isPlaced=!isDropped&&(!!pl||a.status==="placed"||!!a.placedDate);
      const when=(pl&&pl.date)||a.placedDate||"";
      const ownerOther=(a.owner==="other"||a.owner==="others");
      const meta=(a.priority?'<em>'+esc(a.priority)+'</em>':'')+(ownerOther?'<em class="recap-owner">delegated</em>':'');
      const citation=a.citation&&typeof a.citation==="object"?a.citation:{};
      const offset=citation.startOffset!==undefined?citation.startOffset:a.start;
      const quote=citation.quote!==undefined?citation.quote:a.quote;
      const hasStart=dashboardRef&&offset!==null&&offset!==undefined&&isFinite(Number(offset));
      const source=hasStart?'<a class="recap-action-source" href="/meetings/'+encodeURIComponent(id)+'/dashboard?t='+encodeURIComponent(offset)+'" target="_blank" rel="noopener" title="'+esc(quote||"Open cited transcript moment")+'">▶ '+recapTime(offset)+'</a>':'';
      let ctrl;
      // Inert on purpose — no button, nothing to click. The task is gone; re-offering a
      // Schedule control here is how dropped work would climb back onto the day.
      if(isDropped)ctrl='<span class="recap-sched-dropped">Dropped</span>';
      else if(isPlaced)ctrl='<span class="recap-sched-done">Scheduled'+(when?' '+esc(typeof _prettyDateLabel==="function"?_prettyDateLabel(when):when):'')+' &#10003;</span>';
      else if(ownerOther)ctrl='<span class="recap-owner-note">Owner: other</span>';
      else ctrl='<button class="recap-sched-btn" type="button" data-action-id="'+esc(a.id)+'">Schedule</button>';
      return '<div class="recap-action'+(isPlaced||isDropped?' is-scheduled':'')+(isDropped?' is-dropped':'')+'" data-row-id="'+esc(a.id)+'">'+
        '<span class="recap-action-text">'+esc(a.text||a.title||"")+meta+source+'</span>'+ctrl+'</div>';
      }).join('')+'</div>';
    };
    const signaled=actions.filter(a=>a.origin==="signaled");
    const automated=actions.filter(a=>a.origin!=="signaled");
    return '<div class="prep-view-actions recap-actions">'+
      group("Signaled Action Items from Meetings",signaled)+
      group("Automated Action Items from Meetings",automated)+
      '</div>';
  }

  // One-click schedule of a recap action. Reuses the shared pick-a-day popover
  // (schedule-popover.js — same mechanic offerPlacement/delegated follow-ups use),
  // then approve-if-needed + place through the meeting endpoints so the task stays
  // linked to the meeting (provenance/dedup) instead of minting an unlinked copy.
  // Never commitScheduledTask. Approve is implicit so the whole thing is one click.
  function scheduleRecapAction(id,action,anchorEl,placed,reload){
    if(typeof openDatePickPopover!=="function"){toast("Scheduler unavailable","error");return;}
    openDatePickPopover(anchorEl,{
      header:"Schedule this action",
      actionLabel:"Schedule",
      allowTime:true,
      onPick:async(dateStr,timeStr)=>{
        try{
          let approvedBlockId=action.approvedBlockId||null;
          // Approve only if it's still a bare proposal; approve returns the full
          // bundle with the proposal now carrying approvedBlockId.
          if(action.status!=="approved"||!approvedBlockId){
            const ad=await postJson('/api/meetings/'+encodeURIComponent(id)+'/actions/approve',{actionIds:[action.id]});
            cache.set(id,ad);
            const fresh=(ad.proposedActions||[]).find(x=>x.id===action.id);
            approvedBlockId=(fresh&&fresh.approvedBlockId)||
              ((ad.approvedBlocks||[]).find(b=>((b.properties||{}).meetingAutomation||{}).proposedActionId===action.id)||{}).id||null;
          }
          if(!approvedBlockId)throw new Error("Could not resolve the task to place");
          const body={date:dateStr}; if(timeStr)body.start=timeStr;
          await postJson('/api/meetings/'+encodeURIComponent(id)+'/actions/'+encodeURIComponent(approvedBlockId)+'/place',body);
          placed.set(action.id,{date:dateStr,start:timeStr||null});
          toast("Scheduled for "+(typeof _prettyDateLabel==="function"?_prettyDateLabel(dateStr):dateStr)+(timeStr&&typeof f12==="function"?" "+f12(timeStr):""));
          if(typeof buildActionItemsTab==="function")buildActionItemsTab();
          await reload(true); // re-render: item flips to "Scheduled ✓"
        }catch(err){ toast(err.message||"Could not schedule","error"); }
      }
    });
  }

  // The prep modal is the surface the prep/recap chips + Prep/Recap radial open
  // (schedule-tab.js openMeetingPanel -> openPrepModal). It has two tabs: Prep (the
  // prep brief) and Recap (the summary + inline schedulable action items). Prep brief
  // and Summary are each an editable block editor -- the SAME shared createBlockEditor
  // used by task notes / sticky notes -- so copy/paste/formatting/slash-menu behave
  // identically. Both editors stay mounted; the tabs just show/hide their panels, so
  // autosave (debounced input + capture-phase blur) and flush-on-close cover both.
  // Persists to PATCH /api/meetings/:id/artifact. The modal is a detached overlay, so
  // render()/refreshMeetingAutomationPanels never touch it -- no mount-lifecycle
  // fight. clientId echo suppresses the origin's own SSE.
  function openPrepModal(ev,opts){
    opts=opts||{};
    if(!(window.DCC&&typeof DCC.modal==="function"))return;
    const id=ev.meetingBlockId||ev.id;
    const _a=fmtClock(ev.start),_b=fmtClock(ev.end);
    const timeStr=(_a&&_b)?_a+" – "+_b:(_a||_b||"");
    const clientId=(window.blockStore&&window.blockStore.CLIENT_ID)||null;

    // Per-modal editor state — no global registry needed (one modal at a time).
    const editors={};    // kind -> block editor
    const saveTimers={}; // kind -> debounce timer
    const lastSig={};    // kind -> last-saved html signature (skip no-op saves)
    const placed=new Map(); // proposalId -> {date,start} scheduled this session
    let activeTab=(opts.defaultTab==="recap")?"recap":"prep";
    let lastData=null;

    const modal=DCC.modal({
      title:ev.title||"Meeting prep",
      body:'<div class="prep-view">'+
        '<div class="prep-view-meta">Prep &amp; recap'+(timeStr?' · '+esc(timeStr):'')+'</div>'+
        '<div class="prep-tabs" role="tablist">'+
          '<button class="prep-tab" role="tab" data-tab="prep" type="button">Prep</button>'+
          '<button class="prep-tab" role="tab" data-tab="recap" type="button">Recap</button>'+
        '</div>'+
        '<div class="prep-edit-genbar">'+
          '<span class="prep-edit-status" data-prep-status></span>'+
          '<button class="prep-gen-btn" type="button" data-prep-gen>Generate prep</button>'+
        '</div>'+
        '<div class="prep-view-doc"><div class="prep-view-loading">Loading…</div></div>'+
      '</div>',
      onClose:()=>{ flush("meeting_prep"); flush("meeting_summary"); }
    });
    if(modal&&modal.el)modal.el.classList.add("prep-modal");
    const docEl=modal.el.querySelector(".prep-view-doc");
    const statusEl=modal.el.querySelector("[data-prep-status]");
    const genBtn=modal.el.querySelector("[data-prep-gen]");

    // Seed order: faithful editor blocks first; else the client's (non-lossy)
    // mdToHtml of the markdown; else stored html; else a blank paragraph.
    function seedBlocks(art){
      if(art&&Array.isArray(art.blocks)&&art.blocks.length)return art.blocks;
      if(art&&art.markdown&&art.markdown.trim())return migrateHtmlToBlocks(mdToHtml(art.markdown));
      if(art&&art.html)return migrateHtmlToBlocks(art.html);
      return null; // createBlockEditor supplies an empty paragraph
    }

    function setStatus(txt){
      if(!statusEl)return;
      statusEl.textContent=txt||"";
      statusEl.classList.toggle("show",!!txt);
    }

    async function persist(kind){
      const ed=editors[kind];
      if(!ed)return;
      const html=ed.toHtml(),blocks=ed.getBlocks(),markdown=ed.toMarkdown();
      if(lastSig[kind]===html)return; // no change
      setStatus("Saving…");
      try{
        const data=await patchJson('/api/meetings/'+encodeURIComponent(id)+'/artifact',{kind,html,blocks,markdown,_clientId:clientId});
        // Mark saved ONLY after the PATCH succeeds — otherwise a failed save would
        // poison lastSig and the blur/close retry would no-op, silently dropping the edit.
        lastSig[kind]=html;
        cache.set(id,data);
        setStatus("Saved");
        setTimeout(()=>{ if(statusEl&&statusEl.textContent==="Saved")setStatus(""); },1400);
      }catch(err){ setStatus("Save failed"); toast(err.message||"Save failed","error"); }
    }

    function flush(kind){
      if(saveTimers[kind]){clearTimeout(saveTimers[kind]);delete saveTimers[kind];}
      if(editors[kind])return persist(kind);
    }

    function mountEditor(kind,host,art){
      if(!host)return;
      const ed=createBlockEditor(host,seedBlocks(art));
      editors[kind]=ed;
      lastSig[kind]=ed.toHtml();
      host.addEventListener('input',()=>{
        if(saveTimers[kind])clearTimeout(saveTimers[kind]);
        saveTimers[kind]=setTimeout(()=>{ delete saveTimers[kind]; persist(kind); },350);
      });
      // Capture phase: focus leaves an inner .nb-content child, so a bubbling
      // blur on the host would miss it (same as sticky notes).
      host.addEventListener('blur',()=>{ flush(kind); },true);
    }

    const prepHasContent=d=>!!(d&&d.prep&&(d.prep.html||d.prep.markdown||(d.prep.blocks&&d.prep.blocks.length)));
    const recapHasContent=d=>!!(d&&((d.summary&&(d.summary.markdown||d.summary.html))||((d.proposedActions||[]).length)||(d.meeting&&d.meeting.dashboardRef)))||placed.size>0;

    function applyActiveTab(){
      // Deep-linked to Recap but nothing's landed yet? Fall back to Prep if there's
      // a brief to show; otherwise stay on the (empty, still-editable) Recap tab.
      if(activeTab==="recap"&&!recapHasContent(lastData)&&prepHasContent(lastData))activeTab="prep";
      modal.el.querySelectorAll(".prep-tab").forEach(b=>{
        const on=b.dataset.tab===activeTab; b.classList.toggle("active",on); b.setAttribute("aria-selected",on?"true":"false");
      });
      docEl.querySelectorAll(".prep-tab-panel").forEach(p=>{ p.style.display=(p.dataset.panel===activeTab)?"":"none"; });
      if(genBtn)genBtn.style.display=(activeTab==="prep")?"":"none"; // Generate prep is prep-only
    }

    function render(data){
      lastData=data;
      const prep=data&&data.prep, summary=data&&data.summary;
      // A hand-dismissed proposal still disappears from the recap, as it always has. A
      // dismissal the SYSTEM made on Drake's behalf (dismissedReason, currently only
      // "task-dropped") stays visible instead: he dropped the task somewhere else and
      // this card is the only place that can tell him the meeting's copy is settled.
      // Silently vanishing would read as "the follow-up was never captured".
      const actions=((data&&data.proposedActions)||[]).filter(a=>a.status!=="dismissed"||!!a.dismissedReason);
      // Tear down prior editors before we wipe the doc HTML (open + each regenerate).
      Object.keys(editors).forEach(k=>{ try{editors[k].destroy()}catch(e){} delete editors[k]; });
      let html='';
      html+='<div class="prep-tab-panel" data-panel="prep">';
      html+='<div class="prep-edit-section"><div class="prep-edit-label">Prep brief</div>'+
        '<div class="prep-edit-host" data-edit-host="meeting_prep"></div>';
      if(prep&&prep.sources&&prep.sources.length)html+=artifactSources(prep.sources);
      html+='</div></div>';
      html+='<div class="prep-tab-panel" data-panel="recap">';
      html+=recapAttachmentHtml(data,id);
      html+='<div class="prep-edit-section"><div class="prep-edit-label">Summary</div>'+
        '<div class="prep-edit-host" data-edit-host="meeting_summary"></div></div>';
      html+=recapActionsHtml(actions,placed,id,data&&data.meeting&&data.meeting.dashboardRef);
      html+='</div>';
      docEl.innerHTML=html;
      mountEditor("meeting_prep",docEl.querySelector('[data-edit-host="meeting_prep"]'),prep);
      mountEditor("meeting_summary",docEl.querySelector('[data-edit-host="meeting_summary"]'),summary);
      if(genBtn)genBtn.textContent=prepHasContent(data)?"Refresh prep":"Generate prep";
      applyActiveTab();
    }

    async function load(force){
      let data=(!force&&cache.get(id))||null;
      if(!data){
        try{ const res=await fetch('/api/meetings/'+encodeURIComponent(id)+'/automation'); data=await res.json(); if(!res.ok)throw new Error(data.error||"load failed"); cache.set(id,data); }
        catch(e){ if(docEl)docEl.innerHTML='<div class="prep-view-empty">Could not load this meeting.</div>'; return; }
      }
      if(!docEl)return;
      render(data);
    }

    // Tab strip + schedule buttons: both live outside prep-view-doc / survive every
    // render (tabs) or are delegated (schedule), so wire once here.
    modal.el.querySelectorAll(".prep-tab").forEach(b=>{
      b.addEventListener("click",()=>{ activeTab=b.dataset.tab; applyActiveTab(); });
    });
    docEl.addEventListener("click",e=>{
      const sb=e.target.closest(".recap-sched-btn"); if(!sb)return;
      const action=((lastData&&lastData.proposedActions)||[]).find(x=>x.id===sb.dataset.actionId);
      if(action)scheduleRecapAction(id,action,sb,placed,load);
    });

    if(genBtn)genBtn.addEventListener("click",async()=>{
      genBtn.disabled=true;genBtn.textContent="Generating…";
      try{
        await flush("meeting_prep"); // save pending edits so the server preserves them
        await postJson('/api/meetings/'+encodeURIComponent(id)+'/prep',{_clientId:clientId});
        await load(true); // re-seed: fresh template + prior edits under "User Notes"
        toast("Prep generated");
      }catch(err){ toast(err.message||"Prep failed","error"); genBtn.disabled=false; }
      finally{ genBtn.disabled=false; if(genBtn.textContent==="Generating…")genBtn.textContent="Refresh prep"; }
    });

    // Forced, not cache-first. `cache` is module-level with no TTL and no eviction, and
    // nothing invalidates it when a task is deleted somewhere else in the app -- so after
    // a Loose Ends Drop, reopening this modal in the same page session would re-render the
    // stale bundle and still show "Scheduled <date>" for work that is gone. The SSE path
    // cannot cover it either: handleBlockEvent returns early on our OWN clientId echo,
    // which is exactly the tab that did the dropping. Opening this modal is a deliberate
    // user action on one meeting, so paying one fetch for guaranteed-fresh data is the
    // cheap fix. The inline itinerary panels stay cache-first: their filter excludes
    // "placed" and "dismissed" alike, so a stale bundle renders identically there.
    load(true);
  }

  window.meetingAutomationPanelHtml=meetingAutomationPanelHtml;
  window.refreshMeetingAutomationPanels=refreshMeetingAutomationPanels;
  window.openPrepModal=openPrepModal;
})();
