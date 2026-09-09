const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const TimeBlocks=require("./public/js/time-blocks");
const {validateBlock}=require("./db");

const blocks=TimeBlocks.DEFAULTS;

test("default Time Blocks use the approved names and weekday ranges",()=>{
  assert.deepEqual(blocks.map(({name,start,end})=>({name,start,end})),[
    {name:"Morning Workout",start:"06:30",end:"09:00"},
    {name:"Clever",start:"09:00",end:"17:30"},
    {name:"Post Work",start:"17:30",end:"19:00"},
    {name:"Evening",start:"19:00",end:"22:00"},
    {name:"Bedtime",start:"22:00",end:"24:00"},
  ]);
  assert.ok(blocks.every(b=>b.activeDays.join(",")==="mon,tue,wed,thu,fri"));
});

test("day filtering keeps weekday defaults but permits weekend blocks",()=>{
  assert.equal(TimeBlocks.forDate(blocks,"2026-09-03").length,5);
  assert.deepEqual(TimeBlocks.forDate(blocks,"2026-09-05"),[]);
  const mondayOnly=[{id:"m",name:"Monday",start:"09:00",end:"10:00",activeDays:["mon"]}];
  const saturdayOnly=[{id:"s",name:"Saturday",start:"09:00",end:"11:00",activeDays:["sat"]}];
  assert.equal(TimeBlocks.forDate(mondayOnly,"2026-09-07").length,1);
  assert.equal(TimeBlocks.forDate(mondayOnly,"2026-09-08").length,0);
  assert.equal(TimeBlocks.forDate(saturdayOnly,"2026-09-05").length,1);
  assert.equal(TimeBlocks.forDate(saturdayOnly,"2026-09-06").length,0);
});

test("weekday filtering preserves the saved divider order",()=>{
  const reversed=blocks.slice().reverse();
  assert.deepEqual(TimeBlocks.forDate(reversed,"2026-09-03").map(b=>b.name),reversed.map(b=>b.name));
});

test("active day normalization retains weekends in Monday-first order",()=>{
  assert.deepEqual(TimeBlocks.activeDays(["sun","fri","sat","mon"]),["mon","fri","sat","sun"]);
  assert.deepEqual(TimeBlocks.activeDays(),TimeBlocks.WEEKDAYS);
});

test("By Day view includes all seven days and empty groups",()=>{
  const custom=blocks.concat({id:"weekend",name:"Weekend Reset",start:"09:00",end:"11:00",activeDays:["sat"]});
  const groups=TimeBlocks.groupByDay(custom);
  assert.deepEqual(groups.map(group=>group.name),["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]);
  assert.equal(groups[0].blocks.length,5);
  assert.deepEqual(groups[5].blocks.map(block=>block.name),["Weekend Reset"]);
  assert.deepEqual(groups[6].blocks,[]);
});

test("exact boundaries assign a task to the block it starts within",()=>{
  assert.equal(TimeBlocks.blockForTask({start:"08:59"},blocks).name,"Morning Workout");
  assert.equal(TimeBlocks.blockForTask({start:"09:00"},blocks).name,"Clever");
  assert.equal(TimeBlocks.blockForTask({start:"17:30"},blocks).name,"Post Work");
  assert.equal(TimeBlocks.blockForTask({start:"22:00"},blocks).name,"Bedtime");
});

test("spanning tasks stay inside their starting block",()=>{
  assert.equal(TimeBlocks.blockForTask({start:"08:45",end:"10:30"},blocks).name,"Morning Workout");
});

test("Midnight is valid only as an end and renders quietly",()=>{
  assert.equal(TimeBlocks.minutes("24:00",false),null);
  assert.equal(TimeBlocks.minutes("24:00",true),1440);
  assert.equal(TimeBlocks.valid({name:"Bedtime",start:"22:00",end:"24:00"}),true);
  assert.equal(TimeBlocks.rangeLabel(blocks.at(-1)),"10:00 PM - Midnight");
});

test("database writes enforce the Midnight and active-day contract",()=>{
  assert.doesNotThrow(()=>validateBlock("schedule_block",{name:"Bedtime",start:"22:00",end:"24:00",activeDays:["sat"]}));
  assert.throws(()=>validateBlock("schedule_block",{name:"Broken",start:"24:00",end:"24:00",activeDays:["sat"]}),/Invalid Time Block/);
  assert.throws(()=>validateBlock("schedule_block",{name:"Never",start:"09:00",end:"10:00",activeDays:[]}),/at least one active day/);
});

test("uncovered timed tasks are outside Time Blocks",()=>{
  assert.equal(TimeBlocks.blockForTask({start:"06:00"},blocks),null);
  assert.equal(TimeBlocks.blockForTask({start:"00:00"},blocks),null);
});

test("nested tasks stay with their root assignment",()=>{
  const nodes=[
    {depth:0,ev:{id:"root",start:"08:45",end:"10:00"}},
    {depth:1,ev:{id:"child",start:"14:00",end:"14:30"}},
    {depth:0,ev:{id:"late",start:"19:00",end:"19:30"}},
  ];
  const grouped=TimeBlocks.groupItineraryTree(nodes,blocks);
  assert.deepEqual(grouped[1].nodes.map(n=>n.ev.id),["root","child"]);
  assert.deepEqual(grouped[4].nodes.map(n=>n.ev.id),["late"]);
});

test("owner and shared itineraries use the same grouping and gap reset",()=>{
  const owner=fs.readFileSync("public/js/schedule-tab.js","utf8");
  const shared=fs.readFileSync("public/js/public-todo-share.js","utf8");
  assert.match(owner,/TimeBlocks\.groupItineraryTree\(DCC\.TaskModel\.selectTree/);
  assert.match(shared,/TimeBlocks\.groupItineraryTree\(guestTree\(visible\),blocks\)/);
  assert.match(owner,/let prevEnd=null;\s*nodes\.forEach/);
  assert.match(shared,/function emitGroup\(group,timed\)\{\s*let prevEnd=null;/);
  assert.match(owner,/TimeBlockView\.header/);
  assert.match(shared,/TimeBlockView\.header/);
});

test("editor offers all-day controls and a grouped By Day tab",()=>{
  const owner=fs.readFileSync("public/js/schedule-tab.js","utf8");
  const html=fs.readFileSync("index.html","utf8");
  assert.match(owner,/DCC\.TimeBlocks\.DAYS\.map/);
  assert.match(owner,/TimeBlocks\.groupByDay\(_beBlocks\)/);
  assert.match(html,/data-be-view="week"[^>]*>By Day</);
});

test("only today's owner itinerary can highlight the current block",()=>{
  const owner=fs.readFileSync("public/js/schedule-tab.js","utf8");
  assert.match(owner,/const current=block\.timed&&block\.start&&isTodayView&&nowMin>=/);
});

test("permanent blocks survive empty weekdays, weekends, and filtered views",()=>{
  for(const date of ['2026-09-09','2026-09-12']){
    const groups=TimeBlocks.groupItineraryTree([],TimeBlocks.forDate(blocks,date));
    assert.equal(groups[0].block.id,'triage');assert.equal(groups.at(-1).block.id,'unplanned');
    assert.ok(groups.every(group=>!group.nodes.length));
    assert.ok(groups.every(group=>group.block.collapsible));
    assert.equal(TimeBlocks.forDate([TimeBlocks.TRIAGE_BLOCK,TimeBlocks.UNPLANNED_BLOCK],date).length,0);
  }
});

test("each root owns its descendants regardless of completion, timing, or Triage flags",()=>{
  const nodes=[
    {depth:0,ev:{id:'triage',untimed:true,triageBlock:true,status:'done'}},
    {depth:1,ev:{id:'triage-child',start:'09:00'}},
    {depth:0,ev:{id:'timed',start:'09:00',triageBlock:true}},
    {depth:1,ev:{id:'untimed-child',untimed:true}},
    {depth:0,ev:{id:'outside',start:'01:00',untimed:false,status:'done'}},
    {depth:0,ev:{id:'unplanned',start:'10:00',untimed:true}},
    {depth:1,ev:{id:'grandparent',triageBlock:true}},
    {depth:2,ev:{id:'grandchild',start:'17:00'}},
  ];
  const groups=TimeBlocks.groupItineraryTree(nodes,blocks);
  const ids=group=>group.nodes.map(node=>node.ev.id);
  assert.deepEqual(ids(groups[0]),['triage','triage-child']);
  assert.deepEqual(ids(groups[2]),['timed','untimed-child']);
  assert.deepEqual(ids(groups.at(-2)),['outside']);
  assert.deepEqual(ids(groups.at(-1)),['unplanned','grandparent','grandchild']);
  assert.equal(new Set(groups.flatMap(ids)).size,nodes.length);
  assert.equal(groups.flatMap(ids).length,nodes.length);
  assert.notEqual(TimeBlocks.collapseKey('2026-09-09',TimeBlocks.TRIAGE_BLOCK),TimeBlocks.collapseKey('2026-09-10',TimeBlocks.TRIAGE_BLOCK));
});
