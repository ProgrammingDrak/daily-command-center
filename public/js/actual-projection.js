/* DCC actual-time projection shared by the List and Calendar Actual toggle.
   Pure: no DOM, no writes. Evidence comes only from time_entry rows and the
   legacy _sessions fallback Day Review already reads. A position is plotted only
   when the entry carries a readable, non-estimated clock start; everything else
   stays as minutes. Queue background elapsed time is never an input. */
(function(root,factory){
  const api=factory(root);
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root){root.DCC=root.DCC||{};root.DCC.ActualProjection=api;}
})(typeof window!=="undefined"?window:null,function(root){
  "use strict";

  // Day Review owns the entry-to-task matching rule; reuse it rather than fork it.
  function matcher(){
    if(root&&root.DCCDayReviewModel&&root.DCCDayReviewModel.entryMatchesEvent)return root.DCCDayReviewModel.entryMatchesEvent;
    if(typeof require==="function"){try{return require("./day-review.js").entryMatchesEvent;}catch(_e){}}
    return null;
  }

  // One application time zone for every Actual clock, List and Calendar alike.
  // Same resolution the rest of the client uses; never the device zone.
  const DEFAULT_TIME_ZONE="America/New_York";
  function appTimeZone(opts){
    return (opts&&opts.timeZone)||(root&&root.DCC_APP_TIME_ZONE)||DEFAULT_TIME_ZONE;
  }

  function finiteSeconds(value){const n=Number(value);return Number.isFinite(n)&&n>0?Math.round(n):0;}

  function localParts(ms,timeZone){
    const d=new Date(ms);
    if(Number.isNaN(d.getTime()))return null;
    try{
      const parts=new Intl.DateTimeFormat("en-US",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(d);
      const get=type=>(parts.find(p=>p.type===type)||{}).value||"0";
      let hour=Number(get("hour"));if(hour===24)hour=0;
      return {date:get("year")+"-"+get("month")+"-"+get("day"),minute:hour*60+Number(get("minute"))};
    }catch(_e){return null;}
  }

  // Where an entry sits on the given date's clock, or why it cannot be placed.
  // Length always comes from durSec, the one field every writer agrees on.
  function entryPosition(props,date,opts){
    const p=props||{};
    const durMin=finiteSeconds(p.durSec)/60;
    const out={startMin:null,durMin,positioned:false,reason:null};
    if(!(durMin>0)){out.reason="no-length";return out;}
    if(p.estimated===true||p.inferred===true){out.reason="estimated";return out;}
    let placed=null;
    const zone=appTimeZone(opts);
    const startedMs=Date.parse(p.startedAt||"");
    const raw=String(p.start||"");
    if(Number.isFinite(startedMs))placed=localParts(startedMs,zone);
    else if(/^\d{1,2}:\d{2}$/.test(raw)){const [h,m]=raw.split(":").map(Number);if(h<24&&m<60)placed={date:date||null,minute:h*60+m};}
    else if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw)){placed={date:raw.slice(0,10),minute:Number(raw.slice(11,13))*60+Number(raw.slice(14,16))};}
    else if(raw&&Number.isFinite(Date.parse(raw)))placed=localParts(Date.parse(raw),zone);
    if(!placed){out.reason="no-start";return out;}
    if(date&&placed.date&&placed.date!==date){out.reason="other-day";return out;}
    out.startMin=placed.minute;out.positioned=true;return out;
  }

  function matchesEvent(match,props,ev){
    if(!match||!ev)return false;
    if(match(props,ev))return true;
    // Work-session entries name the row id; plan rows are often keyed by local id.
    return !!(ev._blockId&&ev._blockId!==ev.id&&match(props,Object.assign({},ev,{id:ev._blockId})));
  }
  // Identity first: an entry that names its task (blockId or calendar event)
  // is matched on that identity alone, with the title removed, so a same-title
  // task earlier in the plan cannot claim it. A stale identity stays unmatched.
  // Only an entry with no identity falls back to Day Review's title rule.
  function hasIdentity(props){return !!(props.blockId||props.calendarEventId);}
  function findTask(match,props,list){
    if(hasIdentity(props)){
      const idOnly=Object.assign({},props,{taskTitle:""});
      return list.find(candidate=>matchesEvent(match,idOnly,candidate))||null;
    }
    return list.find(candidate=>matchesEvent(match,props,candidate))||null;
  }

  function emptyTask(){return {status:"none",knownMin:0,positioned:[],unpositioned:[],positionedMin:0,unpositionedMin:0};}

  // events: [{id,_blockId,title,meetingBlockId,source_id,gcal_event_id,actualTimeUnknown,actualMinutesFrom}]
  // entries: time_entry blocks for ONE date. sessions: legacy map {id:[{start,durationMin}]}.
  function projectDay(events,entries,opts){
    const o=opts||{};
    const match=o.match||matcher();
    const date=o.date||null;
    const byId=new Map();
    const list=(events||[]).filter(Boolean);
    list.forEach(ev=>byId.set(ev.id,emptyTask()));
    const extras={unknownMin:0,unmatched:[]};
    const unmatched=new Map();
    (entries||[]).forEach(entry=>{
      if(!entry||entry.deleted_at)return;
      const props=entry.properties||{};
      const pos=entryPosition(props,date,o);
      if(!(pos.durMin>0))return;
      if(props.allocationKind==="unknown"){extras.unknownMin+=pos.durMin;return;}
      // One task per entry, so nothing is counted twice.
      const ev=findTask(match,props,list);
      if(!ev){
        const key=props.calendarEventId||props.blockId||String(props.taskTitle||"").trim().toLowerCase()||entry.id;
        const row=unmatched.get(key)||{key,title:props.taskTitle||"Untracked activity",min:0,blockId:props.blockId||null};
        row.min+=pos.durMin;unmatched.set(key,row);return;
      }
      const task=byId.get(ev.id);
      const seg={durMin:pos.durMin,source:props.source||"manual",entryId:entry.id||null,entry};
      if(pos.positioned){task.positioned.push(Object.assign(seg,{startMin:pos.startMin,endMin:pos.startMin+pos.durMin}));task.positionedMin+=pos.durMin;}
      else{task.unpositioned.push(Object.assign(seg,{reason:pos.reason}));task.unpositionedMin+=pos.durMin;}
      task.knownMin+=pos.durMin;task.status="recorded";
    });
    const sessions=o.sessions||{};
    list.forEach(ev=>{
      const task=byId.get(ev.id);
      task.positioned.sort((a,b)=>a.startMin-b.startMin);
      if(task.status==="recorded")return;
      if(ev.actualMinutesFrom==="reallocated"){task.status="reallocated";return;}
      if(ev.actualTimeUnknown===true){task.status="unknown";return;}
      // Legacy sessions carry no trustworthy instant; show them as minutes only.
      const legacy=Array.isArray(sessions[ev.id])?sessions[ev.id]:[];
      const legacyMin=legacy.reduce((sum,s)=>sum+Math.max(0,Number(s&&s.durationMin)||0),0);
      if(legacyMin>0){task.status="recorded";task.knownMin=legacyMin;task.unpositionedMin=legacyMin;task.unpositioned.push({durMin:legacyMin,source:"legacy",reason:"legacy",entryId:null});}
    });
    extras.unmatched=[...unmatched.values()];
    const matchedMin=[...byId.values()].reduce((sum,t)=>sum+t.knownMin,0);
    const unmatchedMin=extras.unmatched.reduce((sum,x)=>sum+x.min,0);
    return {date,byId,extras,matchedMin,unmatchedMin,knownMin:matchedMin+unmatchedMin,
      unpositionedMin:[...byId.values()].reduce((sum,t)=>sum+t.unpositionedMin,0)};
  }

  function minutes(value){
    const m=Math.max(0,Math.round(value||0));
    return m>=60?Math.floor(m/60)+"h"+(m%60?" "+m%60+"m":""):m+"m";
  }
  function clock(min){
    const m=((Math.round(min)%1440)+1440)%1440,h=Math.floor(m/60),a=h>=12?"PM":"AM";
    return (h%12||12)+":"+String(m%60).padStart(2,"0")+" "+a;
  }

  // One line of plain-language evidence for a task, for list rows and the inspector.
  function describeTask(task){
    const t=task||emptyTask();
    if(t.status==="unknown")return {tone:"unknown",text:"Actual time unknown"};
    if(t.status==="reallocated")return {tone:"unknown",text:"Time moved to other work"};
    if(t.status!=="recorded")return {tone:"none",text:"No recorded actual"};
    const parts=["Actual "+minutes(t.knownMin)];
    if(t.positioned.length){
      const first=t.positioned[0],last=t.positioned[t.positioned.length-1];
      parts.push(clock(first.startMin)+" to "+clock(last.endMin)+(t.positioned.length>1?" · "+t.positioned.length+" segments":""));
    }
    if(t.unpositionedMin>0)parts.push(minutes(t.unpositionedMin)+" without a clock time");
    return {tone:"recorded",text:parts.join(" · ")};
  }

  function describeDay(day){
    const d=day||{knownMin:0,unpositionedMin:0,extras:{unknownMin:0,unmatched:[]},unmatchedMin:0};
    const items=[{key:"known",label:"Known actual",value:minutes(d.knownMin)}];
    if(d.unpositionedMin>0)items.push({key:"unplaced",label:"Without a clock time",value:minutes(d.unpositionedMin)});
    if(d.unmatchedMin>0)items.push({key:"unplanned",label:"Unplanned activity",value:minutes(d.unmatchedMin)});
    if(d.extras.unknownMin>0)items.push({key:"unknown",label:"Unknown time (not focused)",value:minutes(d.extras.unknownMin)});
    return items;
  }

  // Calendar layer: plottable segments and per-day unplaced totals. Never
  // derives a position from the plan.
  function calendarLayer(day){
    const segments=[];let unplacedMin=0;
    (day&&day.byId?[...day.byId.entries()]:[]).forEach(([id,task])=>{
      task.positioned.forEach(seg=>segments.push({taskId:id,startMin:seg.startMin,endMin:seg.endMin,durMin:seg.durMin,source:seg.source,entryId:seg.entryId,entry:seg.entry}));
      unplacedMin+=task.unpositionedMin;
    });
    segments.sort((a,b)=>a.startMin-b.startMin);
    return {segments,unplacedMin,unplannedMin:day?day.unmatchedMin:0,unknownMin:day?day.extras.unknownMin:0};
  }

  return {appTimeZone,entryPosition,projectDay,describeTask,describeDay,calendarLayer,minutes,clock};
});
