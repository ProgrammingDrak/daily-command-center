// Read-only timeline of canonical time_entry evidence and current work sessions.
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root){root.DCC=root.DCC||{};root.DCC.ProgressActual=api;}
})(typeof window!=="undefined"?window:null,function(){
  "use strict";
  function parts(value,zone){
    const p=new Intl.DateTimeFormat("en-CA",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(value));
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
  function model(entries,active,opts){
    const {date,zone,projection,policy}=opts,now=opts.now??Date.now();
    const segments=[],seen=new Set();let unplacedMin=0,unknownMin=0;
    for(const entry of entries||[]){
      if(!entry||entry.deleted_at||(entry.date&&entry.date!==date)||seen.has(entry.id))continue;
      if(entry.id)seen.add(entry.id);
      const p=entry.properties||{},pos=projection.entryPosition(p,date,{timeZone:zone});
      if(p.allocationKind==="unknown"){unknownMin+=pos.durMin;continue;}
      if(!pos.positioned){unplacedMin+=pos.durMin;continue;}
      const startMin=Math.max(0,pos.startMin),endMin=Math.min(1440,pos.startMin+pos.durMin);
      if(endMin>startMin)segments.push({id:entry.id,taskId:p.blockId,title:p.taskTitle||"Recorded activity",startMin,endMin,live:false});
    }
    const seenTasks=new Set();
    for(const task of active||[]){
      const key=task._blockId||task.id;
      if(seenTasks.has(key))continue;seenTasks.add(key);
      const started=Date.parse(task.startedAt||"");
      if(!Number.isFinite(started)||started>=now||task.done||task.status==="done")continue;
      // The dock's unattended-work policy owns the cutoff; no background elapsed.
      const cutoff=policy.checkInState(task,now).autoPauseAtMs;
      const s=Math.max(started,boundary(date,zone,false)),e=Math.min(now,cutoff,boundary(date,zone,true));
      if(!(e>s))continue;
      const startMin=parts(s,zone).minute,endMin=e===boundary(date,zone,true)?1440:parts(e,zone).minute;
      if(endMin>startMin)segments.push({id:"live-"+key,taskId:key,title:task.title||"Active work",startMin,endMin,live:true});
    }
    // Separate lanes preserve concurrent work and leave unrecorded gaps empty.
    segments.sort((a,b)=>a.startMin-b.startMin||a.endMin-b.endMin);
    const ends=[];
    for(const seg of segments){let lane=ends.findIndex(end=>end<=seg.startMin);if(lane<0)lane=ends.length;seg.lane=lane;ends[lane]=seg.endMin;}
    return {segments,lanes:Math.max(1,ends.length),unplacedMin,unknownMin};
  }
  return {parts,boundary,model};
});
