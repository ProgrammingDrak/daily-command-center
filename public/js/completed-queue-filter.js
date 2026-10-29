// Filters the complete retained queue snapshot, never the task-search page/cache.
(function(root){
  'use strict';
  const options=[['today','Today'],['latest','Last completed'],['hour','1 hour'],['day','1 day'],['week','1 week'],['month','1 month (30 days)'],['all','All time']];
  const windows={hour:3600000,day:86400000,week:7*86400000,month:30*86400000};
  function zone(value){try{new Intl.DateTimeFormat('en-US',{timeZone:value}).format();return value||Intl.DateTimeFormat().resolvedOptions().timeZone;}catch(_e){return Intl.DateTimeFormat().resolvedOptions().timeZone;}}
  function select(items,period='today',now=Date.now(),timeZone){
    const tz=zone(timeZone),day=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'});
    const all=items.filter(item=>item.status==='completed').slice().sort((a,b)=>{
      const at=Number.isFinite(a.completedAt)?a.completedAt:-Infinity,bt=Number.isFinite(b.completedAt)?b.completedAt:-Infinity;
      return at===bt?String(a.task.id).localeCompare(String(b.task.id)):bt-at;
    });
    const known=all.filter(item=>Number.isFinite(item.completedAt)&&item.completedAt<=now);
    let rows;
    if(period==='all')rows=all;
    else if(period==='latest')rows=known.slice(0,1);
    else if(windows[period])rows=known.filter(item=>item.completedAt>=now-windows[period]);
    else rows=known.filter(item=>day.format(item.completedAt)===day.format(now));
    return {rows,total:all.length,unknown:all.filter(item=>!Number.isFinite(item.completedAt)).length,timeZone:tz};
  }
  const api={options,select};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.DCCCompletedQueueFilter=api;
})(typeof window!=='undefined'?window:globalThis);
