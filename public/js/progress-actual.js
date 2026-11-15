// Read-only timeline of canonical time_entry evidence and current work sessions.
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root){root.DCC=root.DCC||{};root.DCC.ProgressActual=api;}
})(typeof window!=="undefined"?window:null,function(){
  "use strict";
  const formatters=new Map();
  function parts(value,zone){
    let formatter=formatters.get(zone);
    if(!formatter){formatter=new Intl.DateTimeFormat("en-CA",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});formatters.set(zone,formatter);}
    const p=formatter.formatToParts(new Date(value));
    const get=k=>p.find(x=>x.type===k).value;
    return {date:get("year")+"-"+get("month")+"-"+get("day"),minute:Number(get("hour"))*60+Number(get("minute"))};
  }
  // Find the date's actual instant boundaries, including DST's 23/25-hour days.
  function boundary(date,zone,after){
    const noon=Date.parse(date+"T12:00:00Z");
    let lo=noon-36*3600000,hi=noon+36*3600000;
    while(hi-lo>1){const mid=Math.floor((hi+lo)/2);if(after?parts(mid,zone).date<=date:parts(mid,zone).date<date)lo=mid;else hi=mid;}
    return hi;
  }
  function offset(ms,zone){
    const p=parts(ms,zone);
    return Date.parse(p.date+"T00:00:00Z")+p.minute*60000-Math.floor(ms/60000)*60000;
  }
  function dayClock(date,zone){
    const start=boundary(date,zone,false),end=boundary(date,zone,true),changes=[];
    let left=start;
    while(left<end){
      const right=Math.min(left+30*60000,end);
      if(offset(left,zone)!==offset(right-1,zone)){
        let lo=left,hi=right;const before=offset(left,zone);
        while(hi-lo>1){const mid=Math.floor((lo+hi)/2);if(offset(mid,zone)===before)lo=mid;else hi=mid;}
        changes.push(hi);
      }
      // A change can land exactly on a scanning boundary.
      if(right<end&&offset(right-1,zone)!==offset(right,zone))changes.push(right);
      left=right;
    }
    return {start,end,changes:[...new Set(changes)]};
  }
  function instant(props){
    const raw=props.startedAt||props.start||"";
    return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)?Date.parse(raw):NaN;
  }
  // The common axis is wall-clock time. Split real intervals at each offset
  // change. A fold's two portions occupy their respective clock positions (and
  // lanes if they overlap); a spring gap stays blank. Never bridge the jump.
  function splitClock(start,end,clock,zone,projection){
    const s=Math.max(start,clock.start),e=Math.min(end,clock.end);
    if(!(e>s))return [];
    const cuts=[s,...clock.changes.filter(t=>t>s&&t<e),e],result=[];
    const clockLabel=clock.changes.length?new Intl.DateTimeFormat("en-US",{timeZone:zone,hour:"numeric",minute:"2-digit",timeZoneName:"short"}):null;
    for(let i=0;i<cuts.length-1;i++){
      const a=cuts[i],b=cuts[i+1],startMin=parts(a,zone).minute+(a%60000)/60000;
      const endMin=Math.min(1440,startMin+(b-a)/60000);
      result.push({startMin,endMin,instantStart:a,clockLabel:clockLabel?clockLabel.format(s)+" – "+clockLabel.format(e)+" · "+projection.minutes((e-s)/60000)+" session; portion":null});
    }
    return result;
  }

  function model(entries,active,opts){
    const {date,zone,projection,policy}=opts,now=opts.now??Date.now();
    const clock=dayClock(date,zone);
    const segments=[],seen=new Set();let unplacedMin=0,unknownMin=0;
    for(const entry of entries||[]){
      if(!entry||entry.deleted_at||(entry.date&&entry.date!==date)||seen.has(entry.id))continue;
      if(entry.id)seen.add(entry.id);
      const p=entry.properties||{},pos=projection.entryPosition(p,date,{timeZone:zone});
      if(p.allocationKind==="unknown"){unknownMin+=pos.durMin;continue;}
      if(!pos.positioned){unplacedMin+=pos.durMin;continue;}
      const started=instant(p);
      if(clock.changes.length&&!Number.isFinite(started)){unplacedMin+=pos.durMin;continue;}
      const spans=Number.isFinite(started)?splitClock(started,started+pos.durMin*60000,clock,zone,projection):[{startMin:Math.max(0,pos.startMin),endMin:Math.min(1440,pos.startMin+pos.durMin)}];
      spans.forEach(span=>{if(span.endMin>span.startMin)segments.push({...span,id:spans.length>1?entry.id+"-"+span.instantStart:entry.id,taskId:p.blockId,title:p.taskTitle||"Recorded activity",live:false});});
    }
    const seenTasks=new Set();
    for(const task of active||[]){
      const key=task._blockId||task.id;
      if(seenTasks.has(key))continue;seenTasks.add(key);
      const started=Date.parse(task.startedAt||"");
      if(!Number.isFinite(started)||started>=now||task.done||task.status==="done")continue;
      // The dock's unattended-work policy owns the cutoff; no background elapsed.
      const cutoff=policy.checkInState(task,now).autoPauseAtMs;
      const spans=splitClock(started,Math.min(now,cutoff),clock,zone,projection);
      spans.forEach(span=>segments.push({...span,id:"live-"+key+(spans.length>1?"-"+span.instantStart:""),taskId:key,title:task.title||"Active work",live:true}));
    }
    // Separate lanes preserve concurrent work and leave unrecorded gaps empty.
    segments.sort((a,b)=>a.startMin-b.startMin||a.endMin-b.endMin);
    const ends=[];
    for(const seg of segments){let lane=ends.findIndex(end=>end<=seg.startMin);if(lane<0)lane=ends.length;seg.lane=lane;ends[lane]=seg.endMin;}
    return {segments,lanes:Math.max(1,ends.length),unplacedMin,unknownMin,clockChange:clock.changes.length>0};
  }
  return {parts,boundary,model};
});
