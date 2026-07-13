// ======== SHARED ITINERARY CARD RENDERER ========
// Single source of truth for the owner itinerary's full task card markup, so the
// guest "shared to-do" view (/todo/:token) is a one-to-one visual mirror instead
// of a re-forked card. Loaded by BOTH index.html (owner) and public-todo.html
// (guest), immediately before the code that uses it.
//
// renderItineraryCard(ev, opts) builds and returns the card DOM element WITH its
// markup. It attaches NO event listeners: the owner wires its existing listener
// block on the returned element (full edit affordances); the guest relies on
// delegated handlers for the social layer (reactions / comments / bounty-reward).
//
// opts (all optional unless noted):
//   guest            true on the guest page -> omits all edit chrome + detail panel
//   node             {depth,hasKids,collapsed} schedule node (owner). Defaults flat.
//   active,isPinnedActive,pinnedStyle,isToday   timeline state flags
//   pinnedStyle      {bg,fg,pulse} from getPinnedOverdueStyle, or null
//   canEditBounty    owner passes (viewMode !== 'archive'); guest unused
//   bw               wrapBandwidth(ev) result (owner); guest null
//   bountyCount,bountyMeta   override the bounty store (guest passes from sponsorships)
//   footerHtml       guest-only HTML appended under the card body (reward/comment UI)
//   helper overrides cfg,srcTag,colorMeta,taskTagColor,taskTagChipsHtml,f12,ms,dur,
//                    origDur,isMeeting,isWrap,isRideAlong,escHtml,notesButton,
//                    pointsChip,petPrivacyChip,reactionChipsHtml  (guest supplies shims;
//                    owner omits them and the window globals are used unchanged)
(function(){
  "use strict";

  // SVG / icon constants (were local consts inside buildSchedule).
  var ckSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>';
  var gripSvg='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';
  var bountySvg='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';
  var eiIcons={task:'<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',doc:'<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',dash:'<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',action:'<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>'};
  var eiBadge={ready:'<span class="ei-badge eib-ready">Ready</span>',todo:'<span class="ei-badge eib-todo">To-do</span>',ref:'<span class="ei-badge eib-ref">Ref</span>',new:'<span class="ei-badge eib-new">New</span>'};
  var chevSm='<svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>';

  function W(name){ return (typeof window !== "undefined") ? window[name] : undefined; }
  function defEsc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(ch){ return ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" })[ch]; }); }

  // Inline style for the pinned "how far behind" pill. ps comes from
  // getPinnedOverdueStyle (state.js): {bg, fg, pulse}. When pulsing we leave the
  // ring to the aging-flash keyframe (CSS); otherwise we tint the pinned ring to
  // match the current gradient color.
  function nodeOverdueStyle(ps, isPinnedActive){
    if(!ps) return "";
    var ring = (isPinnedActive && !ps.pulse) ? ";box-shadow:0 0 0 2px var(--bg),0 0 0 4px "+ps.bg : "";
    return ' style="background:'+ps.bg+';border-color:'+ps.bg+';color:'+ps.fg+ring+'"';
  }

  function renderItineraryCard(ev, opts){
    opts = opts || {};
    var guest = !!opts.guest;

    // Resolve un-guarded helpers: opts override -> window global -> safe default.
    // Owner passes none, so these are exactly the current globals (byte-identical
    // output). Guest supplies shims; window globals are absent on that page.
    var cfg              = opts.cfg              || W("cfg")              || function(){ return {tag:"Task",cls:"tag-task",color:"#a78bfa"}; };
    var srcTag           = opts.srcTag           || W("srcTag")           || function(){ return ""; };
    var colorMeta        = opts.colorMeta        || W("colorMeta")        || function(){ return ""; };
    var taskTagColor     = opts.taskTagColor     || W("taskTagColor")     || function(){ return null; };
    var taskTagChipsHtml = opts.taskTagChipsHtml || W("taskTagChipsHtml") || function(){ return ""; };
    var f12              = opts.f12              || W("f12")              || function(s){ return s; };
    var ms               = opts.ms               || W("ms")               || function(m){ return m + "m"; };
    var dur              = opts.dur              || W("dur")              || function(e){ return (e&&e.durationMinutes)||0; };
    var origDur          = opts.origDur          || W("origDur")          || function(){ return 0; };
    var isMeeting        = opts.isMeeting        || W("isMeeting")        || function(e){ return e&&(e.type==="meeting"||e.type==="oneone"); };
    var isFixed          = opts.isFixed          || W("isFixed")          || function(e){ return !!e&&(isMeeting(e)||e.type==="ooo"||e.type==="break"); };
    var pointEligible    = opts.pointEligible    || W("pointEligible")    || function(e){ return !isFixed(e); };
    var habitStreakChip  = opts.habitStreakChip  || W("habitStreakChip")  || function(){ return ""; };
    var isWrap           = opts.isWrap           || W("isWrap")           || function(){ return false; };
    var isRideAlong      = opts.isRideAlong      || W("isRideAlong")      || function(){ return false; };
    var escHtml          = opts.escHtml          || W("escHtml")          || defEsc;
    var notesButton      = opts.notesButton      || W("notesButton")      || function(){ return ""; };
    var reactionChipsHtml= opts.reactionChipsHtml|| W("todoShareReactionChipsHtml") || function(){ return ""; };
    var _pomoSvg         = opts.pomoSvg          || (typeof pomoSvg!=="undefined" ? pomoSvg : "");

    // pointsChip / petPrivacyChip were local closures in buildSchedule; moved here
    // verbatim. Owner uses these; guest overrides via opts (points from payload).
    var petPrivacyChip = opts.petPrivacyChip || function(ev){
      if(!ev||isFixed(ev))return "";
      var visibility=ev.publicVisibility==="private"?"private":"public";
      var label=visibility==="private"?"Private":"Public";
      return '<button class="pet-privacy-toggle '+visibility+'" type="button" data-pet-privacy-id="'+String(ev.id).replace(/"/g,'&quot;')+'" title="Toggle Pet Home sharing">'+label+'</button>';
    };
    var pointsChip = opts.pointsChip || function(ev){
      var bountyCount=typeof getBountyCountForTask==="function"?getBountyCountForTask(ev.id):((typeof isBountyTask==="function"&&isBountyTask(ev.id))?1:0);
      var bounty=bountyCount>0;
      var payload=window.TaskPoints&&typeof window.TaskPoints.buildPayload==="function"
        ? window.TaskPoints.buildPayload(ev,{bounty:bounty,bounty_count:bountyCount,partner_bounty:bountyCount>1})
        : {type:ev.type,duration_minutes:typeof dur==="function"?dur(ev):(ev.durMin||30),priority:ev.priority,bounty:bounty,bounty_count:bountyCount,partner_bounty:bountyCount>1};
      var scoring=window.TaskPoints&&typeof window.TaskPoints.estimate==="function"
        ? window.TaskPoints.estimate(payload)
        : {eligible:pointEligible(ev),awardPoints:bounty?28:14,durationMinutes:60,effortTier:"medium",attentionTier:"normal"};
      if(!scoring.eligible||scoring.awardPoints<=0)return "";
      var pts=scoring.awardPoints;
      var title="Completing this task earns about "+pts+" points. "+scoring.durationMinutes+"m, "+scoring.effortTier+" effort, "+scoring.attentionTier+" attention"+(bounty?", bounty x"+Math.pow(2,bountyCount):"")+".";
      return '<span class="points-chip'+(bounty||pts>=20?' bonus':'')+'" title="'+title.replace(/"/g,'&quot;')+'">'+pts+' pts</span>';
    };

    var node = opts.node || {depth:0,hasKids:false,collapsed:false};
    var active = !!opts.active, isPinnedActive = !!opts.isPinnedActive;
    var pinnedStyle = opts.pinnedStyle || null;
    var nc = active ? "active" : "upcoming";

    var d=dur(ev),od=origDur(ev.id),changed=od&&d!==od,delta=d-od;
    var c=cfg(ev.type);var evSrcTag=srcTag(ev.source);
    var bountyCount=(opts.bountyCount!=null)?opts.bountyCount:(typeof getBountyCountForTask==="function"?getBountyCountForTask(ev.id):((typeof isBountyTask==="function"&&isBountyTask(ev.id))?1:0));
    var isBounty=bountyCount>0;
    var bountyMeta=opts.bountyMeta||(typeof getBountyMetaForTask==="function"?getBountyMetaForTask(ev.id):{count:bountyCount,hasSponsor:false,sponsorName:""});
    var bountySponsorTitle=bountyMeta.hasSponsor?("Bounty from "+(bountyMeta.sponsorName||"a visitor")).replace(/"/g,'&quot;'):"";
    var bountyPlaced=typeof hasSelfBounty==="function"?hasSelfBounty():!!(typeof getDailyBounty==="function"&&getDailyBounty());
    var canEditBounty=opts.canEditBounty!==undefined?opts.canEditBounty:true;
    var _bw=opts.bw||null;

    var el=document.createElement("div");
    el.className="tl-item"+(isRideAlong(ev)?" ride-along":"")+(isWrap(ev)?" wrap-parent":"");
    el.dataset.id=ev.id;
    if(node.depth)el.style.marginLeft=(node.depth*22)+"px";
    if(isBounty)el.classList.add("bounty");
    if(ev._locked)el.classList.add("locked");

    var hasPrep=ev.prep&&ev.prep.length;
    var hasFu=ev.followups&&ev.followups.length;

    // Build detail panel content — owner only. Guests never see notes/links/subtasks.
    var detailParts=[];
    if(!guest){
      if(ev.detail)detailParts.push('<div class="detail-summary">'+ev.detail.replace(/\n/g,'<br>')+'</div>');
      var dLinks=[];
      if(ev.notionUrl)dLinks.push('<a href="'+ev.notionUrl+'" target="_blank" onclick="event.stopPropagation()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h6v6H4z"/><path d="M14 4h6v6h-6z"/><path d="M4 14h6v6H4z"/><path d="M14 14h6v6h-6z"/></svg>Open in Notion</a>');
      if(ev.delegatedItemId&&typeof openDelegatedModal==="function")dLinks.push('<button type="button" class="detail-action-link" onclick="event.stopPropagation();openDelegatedModal(\''+String(ev.delegatedItemId).replace(/'/g,"\\'")+'\')">Edit delegated item</button>');
      if(dLinks.length)detailParts.push('<div class="detail-links">'+dLinks.join('')+'</div>');
      var detailMeta=[];
      if(ev.priority)detailMeta.push('<span class="pri-'+(ev.priority==="High"?"hi":ev.priority==="Medium"?"med":"lo")+'">Priority: '+ev.priority+'</span>');
      if(ev.estTime)detailMeta.push('<span>Est: '+ev.estTime+'</span>');
      var commuteWin=typeof commuteLeaveWindow==="function"?commuteLeaveWindow(ev):null;
      if(commuteWin)detailMeta.push('<span>'+commuteWin.label+'</span>');
      detailMeta.push('<span>Duration: '+ms(d)+(changed?' (was '+ms(od)+')':'')+'</span>');
      detailMeta.push('<span>'+f12(ev.start)+' - '+f12(ev.end)+'</span>');
      if(evSrcTag)detailMeta.push('<span class="detail-src">Source:</span>'+evSrcTag);
      if(detailMeta.length)detailParts.push('<div class="detail-meta">'+detailMeta.join('')+'</div>');
      if(isMeeting(ev)&&typeof meetingAutomationPanelHtml==="function"){
        detailParts.push(meetingAutomationPanelHtml(ev));
      }
      // Subtask / side-project counts — shown for meetings too; they can carry
      // subtasks like any task (managed via the card-click Add Items modal).
      {
        var subs=loadSubtasks()[ev.id]||[];
        var linkedTriv=getLinkedTrivialTasks(ev.id);
        if(subs.length||linkedTriv.length){
          var counts=[];
          if(subs.length)counts.push(subs.length+' subtask'+(subs.length>1?'s':''));
          if(linkedTriv.length)counts.push(linkedTriv.length+' side project'+(linkedTriv.length>1?'s':''));
          detailParts.push('<div class="detail-meta" style="cursor:pointer" onclick="openAddModal(\''+ev.id.replace(/'/g,"\\'")+'\',\''+ev.title.replace(/'/g,"\\'")+'\')"><span style="color:var(--cyan)">⚡ '+counts.join(', ')+'</span> <span style="font-size:10px;opacity:0.5">click to manage</span></div>');
        }
      }
    }
    var hasDetail=detailParts.length>0;
    var chevron='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transition:transform 0.2s;flex-shrink:0;opacity:0.4"><path d="M6 9l6 6 6-6"/></svg>';

    // Build prep edge items (owner; guest payload carries none)
    var prepHtml='';
    if(hasPrep){
      prepHtml=ev.prep.map(function(p){
        var ic=p.type==="task"?"ei-task":p.type==="dash"?"ei-dash":"ei-doc";
        var isLocal=p.href&&!p.href.startsWith("http");
        var isExternal=p.href&&p.href.startsWith("http");
        if(isLocal){
          return'<div class="ei ei-linkable" data-prep-href="'+p.href.replace(/"/g,'&quot;')+'" data-prep-title="'+p.title.replace(/"/g,'&quot;')+'" onclick="event.stopPropagation();openPrepViewer(this.dataset.prepHref,this.dataset.prepTitle)"><div class="ei-icon '+ic+'">'+(eiIcons[p.type]||eiIcons.doc)+'</div><div class="ei-body"><div class="ei-title">'+p.title+'</div></div>'+(eiBadge[p.status]||'')+'</div>';
        } else {
          var link=isExternal?'<a href="'+p.href+'" target="_blank" onclick="event.stopPropagation()">'+p.title+'</a>':p.title;
          return'<div class="ei"><div class="ei-icon '+ic+'">'+(eiIcons[p.type]||eiIcons.doc)+'</div><div class="ei-body"><div class="ei-title">'+link+'</div></div>'+(eiBadge[p.status]||'')+'</div>';
        }
      }).join('');
    }

    // Build followup edge items
    var fuHtml='';
    if(hasFu){
      fuHtml=ev.followups.map(function(f){
        var fTitle=f.href?'<a href="'+f.href+'" target="_blank" onclick="event.stopPropagation()">'+f.title+'</a>':f.title;
        var fDetail=f.detail?'<div class="ei-detail">'+f.detail+'</div>':'';
        return'<div class="ei"><div class="ei-icon ei-action">'+eiIcons.action+'</div><div class="ei-body"><div class="ei-title">'+fTitle+'</div>'+fDetail+'</div>'+(eiBadge[f.status]||eiBadge.new)+(f.durMin?'<button class="ei-sched" data-fuid="'+f.id+'">+ Schedule ('+ms(f.durMin)+')</button>':'')+'</div>';
      }).join('');
    }

    var prepTab=hasPrep?'<div class="edge-tab edge-prep" data-edge="prep">'+chevSm+' Prep '+ev.prep.length+'</div>':'';
    var fuTab=hasFu?'<div class="edge-tab edge-fu" data-edge="fu">'+ev.followups.length+' Actions '+chevSm+'</div>':'';
    var trivialTab='';

    var timeHtml='<div class="tl-time'+(hasPrep?' has-prep':'')+'">'+f12(ev.start).replace(" ","<br>")+'<span class="et">'+f12(ev.end)+'</span>';
    if(hasPrep){timeHtml+='<span class="prep-line"></span>';}
    timeHtml+='</div>';
    var bountyMultiplier=Math.pow(2,Math.max(1,bountyCount||1));
    // Bounty is a row-level button (not a radial spoke): visible on every
    // eligible card until the day's bounty is placed, then it disappears and
    // the chosen task carries the golden glow (.card-bounty).
    var bountyControl=(!guest&&!isMeeting(ev)&&canEditBounty&&!bountyPlaced)
      ? '<button class="btn-bounty" data-bounty-id="'+ev.id+'" data-tooltip="Set bounty - 2x points" aria-label="Set bounty">'+bountySvg+'</button>'
      : '';
    var reactionHtml=reactionChipsHtml(ev)||"";
    var footerHtml=(guest&&opts.footerHtml)?opts.footerHtml:'';

    // Subtask point pie: a linear progress bar (earned / pool) on the parent.
    // When present it replaces the duration-based points chip — the pool IS the
    // task's points, split among its subtasks + completion bonus.
    var pplan=(!guest&&window.PointPlan&&typeof window.PointPlan.compute==="function")?window.PointPlan.compute(ev.id):null;
    var pieBarHtml='';
    if(pplan){
      var piePct=pplan.pool>0?Math.max(0,Math.min(100,Math.round(pplan.earned/pplan.pool*100))):0;
      var pieTitle=(pplan.earned+' of '+pplan.pool+' pts earned · '+pplan.doneCount+'/'+pplan.total+' subtasks done'+(pplan.bonus?' · '+pplan.bonus+' pt completion bonus':'')).replace(/"/g,'&quot;');
      pieBarHtml='<span class="pie-bar" title="'+pieTitle+'"><span class="pie-bar-fill" style="width:'+piePct+'%"></span></span><span class="pie-bar-lbl">'+pplan.earned+'/'+pplan.pool+' pts</span>';
    }
    // "Stacked" badge marks a ride-along: independent concurrent work whose time
    // and points are separate from the parent.
    var stackedBadge=isRideAlong(ev)?'<span class="stacked-badge" title="Stacked time — independent points & schedule">Stacked</span>':'';

    // Rollup container (shell): registry-driven bar color + card class, points
    // chip replaced by the children rollup, checkbox display-only while open.
    var tt=window.TaskTypes?window.TaskTypes.get(ev):null;
    var shellChip=(tt&&tt.rollupMode&&typeof shellRollupChip==="function")?shellRollupChip(ev):'';
    var chkBlocked=(typeof shellCompleteBlocked==="function")&&shellCompleteBlocked(ev);

    el.innerHTML=
      timeHtml+
      '<div class="tl-node '+nc+(hasPrep?' has-prep':'')+(isPinnedActive?' pinned':'')+(pinnedStyle&&pinnedStyle.pulse?' aging-pulse':'')+'"'+nodeOverdueStyle(pinnedStyle,isPinnedActive)+' data-node-id="'+ev.id+'">'+(active?'<span class="tl-now-time">'+new Date().toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}).replace(" ","")+'</span>':'')+'</div>'+
      '<div class="card-wrap">'+
        prepTab+fuTab+trivialTab+
        '<div class="card'+(active?' card-active':'')+(isBounty?' card-bounty':'')+(bountyMeta.hasSponsor?' card-bounty-sponsor':'')+(tt&&tt.cardClass?' '+tt.cardClass:'')+'"'+(bountyMeta.hasSponsor?' title="'+bountySponsorTitle+'"':'')+'>'+
          reactionHtml+
          (guest?'':'<div class="grip" title="Drag to reorder">'+gripSvg+'</div>')+
          (guest?'':'<button class="chk'+(chkBlocked?' chk-blocked':'')+'" title="'+(chkBlocked?'Completes automatically when all nested tasks are done':'Mark done')+'">'+ckSvg+'</button>')+
          (guest?'':'<div class="chk-col">'+
            (!(tt&&tt.rollupMode)?'<button class="chk-quick" title="Quick complete (no notes)">&#9889;</button>':'')+
          '</div>')+
          '<div class="bar" style="background:'+((tt&&tt.barColor)||taskTagColor(ev)||c.color)+'"></div>'+
          '<div class="body">'+
            '<div class="title-row">'+(node.hasKids?'<button class="wrap-collapse'+(node.collapsed?' collapsed':'')+'" title="Collapse / expand">'+(node.collapsed?'▸':'▾')+'</button>':'')+'<span class="ttl" title="'+escHtml(ev.title)+'">'+ev.title+'</span>'+(isBounty?'<span class="bounty-chip'+(bountyMeta.hasSponsor?' bounty-chip-sponsor':'')+'"'+(bountyMeta.hasSponsor?' title="'+bountySponsorTitle+'"':'')+'>Bounty x'+bountyMultiplier+'</span>':'')+'<span class="tinline">'+(ev._locked||isMeeting(ev)?'<span class="lock-ind" title="'+(isMeeting(ev)?'Calendar time — holds during reflow; drag or click the time to move it':'Locked — holds its time when tasks reflow')+'"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>':'')+'<span class="start-time'+(ev._pinnedStart?' pinned':'')+'" data-start-id="'+ev.id+'" title="Click to adjust start time">'+f12(ev.start)+'</span> - '+f12(ev.end)+(active?' · Now':'')+'</span>'+(guest||isMeeting(ev)?'':'<button class="btn-add-menu row-add-menu" data-add-id="'+ev.id+'" title="Add a task before / after / inside">+</button>')+'</div>'+
            '<div class="meta">'+(typeof commuteLeaveChipHtml==="function"?commuteLeaveChipHtml(ev):'')+'<span class="tag '+c.cls+'">'+c.tag+'</span>'+stackedBadge+(shellChip?shellChip:(pplan?pieBarHtml:pointsChip(ev)))+habitStreakChip(ev)+(/^Custom task/.test(ev.meta||'')?'':colorMeta(ev))+(_bw?'<span class="wrap-bw">'+_bw.count+' ride-along'+(_bw.count>1?'s':'')+' · ~'+ms(_bw.mins)+' inside</span>':'')+
              petPrivacyChip(ev)+
              (ev.prepStatus==='ready'?'<span class="prep-flag prep-ready" title="Prep briefing ready">&#9679; Prep</span>':ev.prepStatus==='pending'?'<span class="prep-flag prep-pending" title="Prep pending">&#9675; Prep</span>':'')+
              (changed?'<span style="color:var(--amber);font-size:9px">Duration adjusted</span>':'')+
              taskTagChipsHtml(ev)+
            '</div>'+
          '</div>'+
          (guest?'':notesButton(ev))+
          // Meetings keep their direct pomodoro button; task cards start one
          // from the radial. Row keeps only notes / radial / delete / done.
          (guest?'':(isMeeting(ev)?'<button class="pomo-btn" data-pomo-id="'+ev.id+'" data-pomo-source="schedule" data-pomo-title="'+ev.title.replace(/"/g,'&quot;')+'" data-pomo-dur="'+d+'" title="Start pomodoro timer">'+_pomoSvg+'</button>':''))+
          // Radial on every row now, meetings included: it carries the Prep/Recap
          // spoke that opens the meeting-automation panel (schedule-tab.js). This
          // retires the old dead .btn-meeting-auto gear, which had no click handler.
          (guest?'':'<button class="btn-task-radial" data-radial-id="'+ev.id+'" data-tooltip="'+(isMeeting(ev)?'Meeting prep and actions…':'Task actions…')+'"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>')+
          bountyControl+
          (guest?'':'<button class="btn-del-task" data-del-id="'+ev.id+'" data-tooltip="Remove from schedule"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>')+
          (guest?'':'<div class="dur">'+
            // Task cards: read-only badge (adjust via the radial's Duration…);
            // meetings keep the ±15 stepper and the tappable badge.
            (isMeeting(ev)?'<button class="dbtn" data-id="'+ev.id+'" data-d="-15">&minus;</button>':'')+
            '<div><div class="dbadge'+(isMeeting(ev)?'':' dbadge-readonly')+'">'+ms(d)+'</div>'+(changed?'<div class="est-act">was '+ms(od)+' <span class="'+(delta>0?"dover":"dunder")+'">'+( delta>0?"+":"")+delta+'m</span></div>':'')+'</div>'+
            (isMeeting(ev)?'<button class="dbtn" data-id="'+ev.id+'" data-d="15">+</button>':'')+
          '</div>')+
          (hasDetail?chevron:'')+
        '</div>'+
        footerHtml+
        (hasDetail?'<div class="detail-panel"><div class="detail-inner">'+detailParts.join('')+'</div></div>':'')+
        (hasPrep?'<div class="edge-panel edge-panel-prep" data-panel="prep"><div class="edge-panel-inner"><div class="edge-items">'+prepHtml+'</div></div></div>':'')+
        (hasFu?'<div class="edge-panel edge-panel-fu" data-panel="fu"><div class="edge-panel-inner"><div class="edge-items">'+fuHtml+'</div></div></div>':'')+
      '</div>';

    return el;
  }

  // ======== SHARED COMPACT ROW ========
  // One skeleton for every ".tl-compact" one-liner in the timeline: done tasks,
  // completed triage, completed side-projects, pushed-to-tomorrow, and
  // rescheduled-away. They differ only in check icon/title, bar color, the middle
  // chip cluster, the time strings, and the check handler — so callers pass just
  // those. Converges the five hand-forked builders that used to skew apart.
  //   o.extraClass    extra class on the wrapper ("" | "pushed")
  //   o.dataset       {key:value} pairs set as data-* on the wrapper
  //   o.timeStr       left rail ".tl-time" content (AM/PM already stripped by caller)
  //   o.checkIcon     SVG inside ".c-check" (defaults to the checkmark)
  //   o.checkTitle    ".c-check" title attribute
  //   o.barColor      ".bar" background
  //   o.title         ".c-title" content (caller decides escaping — matches forks)
  //   o.chipsHtml     chip cluster between title and time (bounty/tag/src/privacy…)
  //   o.timeRange     ".c-time" content
  //   o.trailingHtml  extra HTML after ".c-time" (e.g. todo-share feedback)
  //   o.onCheck       click handler for ".c-check" (omit for display-only rows)
  //   o.afterRender   fn(el) for any extra wiring (e.g. a review badge)
  function renderCompactRow(o){
    o = o || {};
    var el = document.createElement("div");
    el.className = "tl-compact" + (o.extraClass ? " " + o.extraClass : "");
    if(o.dataset){ for(var k in o.dataset){ if(o.dataset[k] != null) el.dataset[k] = o.dataset[k]; } }
    el.innerHTML =
      '<div class="tl-time">'+(o.timeStr||"")+'</div>'+
      '<div class="tl-node"></div>'+
      '<div class="compact-row">'+
        '<div class="c-check" title="'+(o.checkTitle||"")+'">'+(o.checkIcon||ckSvg)+'</div>'+
        '<div class="bar" style="background:'+(o.barColor||"")+'"></div>'+
        '<span class="c-title">'+(o.title||"")+'</span>'+
        (o.chipsHtml||"")+
        '<span class="c-time">'+(o.timeRange||"")+'</span>'+
        (o.trailingHtml||"")+
      '</div>';
    if(typeof o.onCheck==="function"){
      el.querySelector(".c-check").addEventListener("click",function(e){ e.stopPropagation(); o.onCheck(e); });
    }
    if(typeof o.afterRender==="function") o.afterRender(el);
    return el;
  }

  // ======== SHARED SUB ROW ========
  // One builder for the compact subtask one-liner, in both the list view
  // (".it-list-item subtask-row") and the timeline (".tl-item tl-sub"). Markup is
  // shared; the two views differed only in wrapper class, the active/movable list
  // flags, the timeline's point-pie "slice" chip, and whether the collapse chevron
  // is wired inline (list) or via the timeline's delegated listener.
  //   node        {depth,hasKids,collapsed} — schedule flatten node
  //   opts.compact  true  -> timeline tl-sub (pie slice, delegated collapse)
  //                 false -> list subtask-row (active/movable classes, inline collapse)
  //   opts.mode     "done" forces the done state (list passes its section mode)
  // References schedule-tab/state/drag globals (toggleDone, bindSubtaskActions,
  // dStart…); all present on the owner render path where this is called. Never
  // invoked on the guest todo page, so the bare refs are safe to define here.
  function renderSubRow(ev, node, opts){
    opts = opts || {};
    var compact = !!opts.compact;
    var esc = (typeof escHtml==="function") ? escHtml : defEsc;
    var doneRow = (opts.mode==="done") || isDone(ev);
    // List preserved its userMovable() gate; the timeline sub never had one. Keep
    // both exactly so drag affordances don't shift between views.
    var movable = compact ? (!ev._locked && !doneRow) : (userMovable(ev) && !ev._locked && !doneRow);
    var sched = (typeof scheduled!=="undefined") ? scheduled : undefined;
    var prog = (typeof subtaskProgress==="function") ? subtaskProgress(ev.id, sched) : null;
    // Point-pie slice: timeline only (the list row never showed it).
    var slice = (compact && ev.subtaskOf && window.PointPlan && typeof window.PointPlan.shareFor==="function")
      ? window.PointPlan.shareFor(ev.subtaskOf, ev.id) : null;
    node = node || {depth:0,hasKids:false,collapsed:false};

    var el = document.createElement("div");
    el.className = compact
      ? ("tl-item tl-sub"+(doneRow?" done":""))
      : ("it-list-item subtask-row"+(doneRow?" done":"")+(isActive(ev)?" active":"")+(movable?" movable":""));
    if(node.depth) el.style.marginLeft = (node.depth*22)+"px";
    el.dataset.id = ev.id;
    if(movable){ el.draggable=true; el.addEventListener("dragstart",function(e){ dStart(e,ev.id); }); el.addEventListener("dragend",dEnd); }
    el.addEventListener("dragover",function(e){ dOver(e,ev.id); }); el.addEventListener("dragleave",dLeave); el.addEventListener("drop",function(e){ dDrop(e,ev.id); });
    el.innerHTML =
      (node.hasKids?'<button class="wrap-collapse'+(node.collapsed?' collapsed':'')+'" title="Collapse / expand">'+(node.collapsed?'▸':'▾')+'</button>':'<span class="wrap-collapse-spacer"></span>')+
      '<button class="chk sub-check'+(doneRow?' on':'')+'" title="'+(doneRow?'Uncheck':'Mark done')+'">'+ckSvg+'</button>'+
      '<span class="sub-ttl" title="'+esc(ev.title)+'">'+ev.title+'</span>'+
      (slice!=null?'<span class="sub-share'+(doneRow?' earned':'')+'" title="'+(doneRow?'Earned ':'Worth ')+slice+' pts of the parent’s pie">'+slice+' pts</span>':'')+
      (prog?'<span class="subtask-prog">'+prog.done+'/'+prog.total+'</span>':'')+
      subtaskActionsHtml(ev);
    el.querySelector(".sub-check").addEventListener("click",function(e){ e.stopPropagation(); toggleDone(ev.id); });
    // List wires each collapse chevron; the timeline uses one delegated listener
    // (tl._collapseWired) so wiring here too would double-toggle.
    if(!compact){
      var cc = el.querySelector(".wrap-collapse");
      if(cc) cc.addEventListener("click",function(e){ e.stopPropagation(); if(typeof toggleCollapsed==="function"){ toggleCollapsed(ev.id); render(); } });
    }
    bindSubtaskActions(el, ev);
    return el;
  }

  window.renderItineraryCard = renderItineraryCard;
  window.renderCompactRow = renderCompactRow;
  window.renderSubRow = renderSubRow;
})();
