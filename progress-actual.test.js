const test=require('node:test');
const assert=require('node:assert/strict');
const P=require('./public/js/progress-actual.js');
const projection=require('./public/js/actual-projection.js');
const policy=require('./public/js/work-checkin-policy.js');
const opts={date:'2026-11-03',zone:'America/New_York',projection,policy,now:Date.parse('2026-11-03T15:00:00Z')};
const entry=(id,p)=>({id,date:opts.date,properties:p});
test('empty evidence stays empty; positioned unplanned work keeps gaps and overlaps',()=>{
 assert.deepEqual(P.model([],[],opts).segments,[]);
 const a=entry('a',{blockId:'removed-task',taskTitle:'Old task',start:'09:00',durSec:1800});
 const result=P.model([a,a,entry('b',{start:'09:15',durSec:1800}),entry('c',{start:'11:00',durSec:600})],[],opts);
 assert.deepEqual(result.segments.map(s=>[s.startMin,s.endMin,s.lane]),[[540,570,0],[555,585,1],[660,670,0]]);
 assert.equal(result.segments[0].taskId,'removed-task');
});
test('unknown, estimated, missing and other-day starts never fabricate clock positions',()=>{
 const m=P.model([entry('a',{durSec:600}),entry('b',{start:'09:00',durSec:300,estimated:true}),entry('c',{startedAt:'2026-11-03T04:30:00Z',durSec:900}),entry('u',{allocationKind:'unknown',durSec:420})],[],opts);
 assert.equal(m.segments.length,0);assert.equal(m.unplacedMin,30);assert.equal(m.unknownMin,7);
});
test('app zone, day clipping and live cutoff follow recorded instants and dock policy',()=>{
 const m=P.model([entry('a',{startedAt:'2026-11-03T14:15:00Z',durSec:1200}),entry('late',{start:'23:50',durSec:1800})],[{id:'live',title:'Ongoing',startedAt:'2026-11-03T14:40:00Z'},{id:'stale',startedAt:'2026-11-03T12:00:00Z'}],opts);
 assert.equal(m.segments.find(s=>s.id==='a').startMin,555);
 assert.equal(m.segments.find(s=>s.id==='late').endMin,1440);
 assert.equal(m.segments.find(s=>s.id==='live-live').endMin,600);
 assert.equal(m.segments.find(s=>s.id==='live-stale').endMin,470);
});
test('overnight ongoing work clips to selected day; future days remain empty',()=>{
 const task={id:'live',startedAt:'2026-11-04T04:50:00Z'};
 const o={...opts,date:'2026-11-04',now:Date.parse('2026-11-04T05:10:00Z')};
 assert.deepEqual(P.model([], [task], o).segments.map(s=>[s.startMin,s.endMin]),[[0,10]]);
 assert.equal(P.model([], [task], {...o,date:'2026-11-05'}).segments.length,0);
});
test('DST date boundaries use the application day rather than a fixed 24 hours',()=>{
 assert.equal(P.boundary('2026-11-01',opts.zone,true)-P.boundary('2026-11-01',opts.zone,false),25*3600000);
 assert.equal(P.boundary('2026-03-08',opts.zone,true)-P.boundary('2026-03-08',opts.zone,false),23*3600000);
});

test('fall-back recorded and live intervals split without losing or inventing minutes',()=>{
 const o={...opts,date:'2026-11-01',now:Date.parse('2026-11-01T06:10:00Z')};
 const p={startedAt:'2026-11-01T05:50:00Z',durSec:1200};
 for(const m of [P.model([{id:'dst',date:o.date,properties:p}],[],o),P.model([],[{id:'dst',startedAt:p.startedAt}],o)]){
  assert.deepEqual(m.segments.map(s=>[s.startMin,s.endMin]),[[60,70],[110,120]]);
  assert.equal(m.segments.reduce((n,s)=>n+s.endMin-s.startMin,0),20);
  for(const seg of m.segments)assert.match(seg.clockLabel,/1:50 AM EDT.*1:10 AM EST.*20m session/);
 }
});
test('spring-forward recorded and live intervals leave nonexistent clock times empty',()=>{
 const o={...opts,date:'2026-03-08',now:Date.parse('2026-03-08T07:10:00Z')};
 const p={startedAt:'2026-03-08T06:50:00Z',durSec:1200};
 for(const m of [P.model([{id:'dst',date:o.date,properties:p}],[],o),P.model([],[{id:'dst',startedAt:p.startedAt}],o)]){
  assert.deepEqual(m.segments.map(s=>[s.startMin,s.endMin]),[[110,120],[180,190]]);
  assert.equal(m.segments.reduce((n,s)=>n+s.endMin-s.startMin,0),20);
  for(const seg of m.segments)assert.match(seg.clockLabel,/1:50 AM EST.*3:10 AM EDT/);
 }
});
test('repeated clock portions use separate lanes and clock-only transition dates remain unpositioned',()=>{
 const o={...opts,date:'2026-11-01'};
 const m=P.model([{id:'two-hours',date:o.date,properties:{startedAt:'2026-11-01T05:00:00Z',durSec:7200}},{id:'ambiguous',date:o.date,properties:{start:'01:30',durSec:600}}],[],o);
 assert.deepEqual(m.segments.map(s=>[s.startMin,s.endMin,s.lane]),[[60,120,0],[60,120,1]]);
 assert.equal(m.unplacedMin,10);
});
