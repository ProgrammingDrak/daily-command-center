// TIME BLOCKS: pure day grouping rules shared by owner, guest, and editor views.
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else{root.DCC=root.DCC||{};root.DCC.TimeBlocks=api;}
})(typeof self!=="undefined"?self:this,function(){
  const WEEKDAYS=["mon","tue","wed","thu","fri"];
  const DAYS=WEEKDAYS.concat(["sat","sun"]);
  const DAY_NAMES={mon:"Monday",tue:"Tuesday",wed:"Wednesday",thu:"Thursday",fri:"Friday",sat:"Saturday",sun:"Sunday"};
  const DIVIDER_VARIANT="hairline";
  const DEFAULTS=[
    {name:"Morning Workout",start:"06:30",end:"09:00"},
    {name:"Clever",start:"09:00",end:"17:30"},
    {name:"Post Work",start:"17:30",end:"19:00"},
    {name:"Evening",start:"19:00",end:"22:00"},
    {name:"Bedtime",start:"22:00",end:"24:00"}
  ].map((b,i)=>Object.assign({id:"default-time-block-"+(i+1),activeDays:WEEKDAYS.slice()},b));

  function dayKey(date){
    const d=new Date(String(date||"")+"T12:00:00Z");
    return ["sun","mon","tue","wed","thu","fri","sat"][d.getUTCDay()]||"";
  }
  function isWeekday(date){return WEEKDAYS.includes(dayKey(date));}
  function activeDays(value){
    const raw=Array.isArray(value)?value:WEEKDAYS;
    const normalized=raw.map(x=>String(x).slice(0,3).toLowerCase());
    return DAYS.filter(d=>normalized.includes(d));
  }
  function minutes(value,allowMidnight){
    if(allowMidnight&&value==="24:00")return 1440;
    const m=/^(\d{2}):(\d{2})$/.exec(String(value||""));
    if(!m)return null;
    const h=Number(m[1]),n=Number(m[2]);
    return h<24&&n<60?h*60+n:null;
  }
  function valid(block){
    const s=minutes(block&&block.start,false),e=minutes(block&&block.end,true);
    return !!(block&&String(block.name||"").trim()&&s!==null&&e!==null&&s<e);
  }
  function normalize(block,index){
    return {id:String(block.id||("time-block-"+(index+1))),name:String(block.name||"").trim(),start:block.start,end:block.end,activeDays:activeDays(block.activeDays)};
  }
  function forDate(blocks,date){
    const key=dayKey(date);
    return (blocks||[]).map(normalize).filter(valid).filter(b=>b.activeDays.includes(key));
  }
  function groupByDay(blocks){
    const normalized=(blocks||[]).map(normalize).filter(valid);
    return DAYS.map(day=>({day,name:DAY_NAMES[day],blocks:normalized.filter(block=>block.activeDays.includes(day))}));
  }
  function blockForTask(task,blocks){
    const start=minutes(task&&task.start,false);
    if(start===null)return null;
    return (blocks||[]).find(b=>start>=minutes(b.start,false)&&start<minutes(b.end,true))||null;
  }
  function groupTree(nodes,blocks){
    const groups=(blocks||[]).map(block=>({block,nodes:[]}));
    const byId=new Map(groups.map(group=>[group.block.id,group]));
    const outside={block:null,nodes:[]};
    let bucket=outside;
    (nodes||[]).forEach(node=>{
      if(!node.depth){
        const block=blockForTask(node.ev,blocks);
        bucket=block?(byId.get(block.id)||outside):outside;
      }
      bucket.nodes.push(node);
    });
    return {groups,outside};
  }
  function formatTime(value){
    if(value==="24:00")return "Midnight";
    const n=minutes(value,false);if(n===null)return String(value||"");
    const h=Math.floor(n/60),m=n%60,ap=h>=12?"PM":"AM";
    return (h%12||12)+":"+String(m).padStart(2,"0")+" "+ap;
  }
  function rangeLabel(block){return formatTime(block.start)+" - "+formatTime(block.end);}

  return {WEEKDAYS,DAYS,DAY_NAMES,DEFAULTS,DIVIDER_VARIANT,dayKey,isWeekday,activeDays,minutes,valid,normalize,forDate,groupByDay,blockForTask,groupTree,formatTime,rangeLabel};
});
