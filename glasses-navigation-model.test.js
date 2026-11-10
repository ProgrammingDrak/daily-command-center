const test = require('node:test');
const assert = require('node:assert/strict');
const {create, viewport, COLLECTIONS, LANES} = require('./public/js/device-views/glasses-navigation-model');
const rows = count => Array.from({length:count}, (_,i)=>({id:'task-'+i,title:'Task '+i}));
test('collection order and working queue lanes are fixed',()=>{
 assert.deepEqual(COLLECTIONS,['All Tasks','Working Queue','Itinerary','Loose Ends','Unscheduled','Whenever','Someday','Waiting']);
 assert.deepEqual(LANES,['Foreground','Needs You','Background','Priority Queue']);
});
test('11-row viewport remains full near boundaries',()=>{
 assert.deepEqual(viewport(20,0),{start:0,end:11,selectedSlot:0});
 assert.deepEqual(viewport(20,10),{start:5,end:16,selectedSlot:5});
 assert.deepEqual(viewport(20,19),{start:9,end:20,selectedSlot:10});
});
test('jump moves five, select moves one and back preserves selection',()=>{
 const m=create();m.setLists(COLLECTIONS.map(()=>rows(20)));
 m.input('down');assert.equal(m.snapshot().index,5);
 m.input('tap-fore');assert.equal(m.snapshot().level,'select');
 m.input('down');assert.equal(m.snapshot().index,6);
 m.input('tap-fore');assert.equal(m.snapshot().level,'task');
 m.input('hold-fore');assert.equal(m.snapshot().level,'details');
 m.input('back');assert.equal(m.snapshot().level,'task');
 m.input('back');assert.equal(m.snapshot().level,'select');
 assert.equal(m.snapshot().index,6);
});
test('collections retain independent selected task identities across refresh',()=>{
 const m=create();m.setLists(COLLECTIONS.map(()=>rows(20)));
 m.input('down');m.input('left');m.input('down');
 assert.equal(m.snapshot().collectionName,'Working Queue');
 assert.equal(m.snapshot().index,5);
 m.input('right');assert.equal(m.snapshot().index,5);
 m.setLists(COLLECTIONS.map(()=>rows(20).slice(1)));
 assert.equal(m.snapshot().selected.id,'task-5');
});
test('home returns to All Tasks jump view',()=>{
 const m=create();m.setLists(COLLECTIONS.map(()=>rows(20)));
 m.input('left');m.input('tap-fore');m.input('tap-fore');m.input('home');
 assert.equal(m.snapshot().collectionName,'All Tasks');assert.equal(m.snapshot().level,'jump');
});
test('range contains five tasks at boundaries and headers never enter the model',()=>{
 const m=create();m.setLists([rows(24)]);assert.deepEqual(m.snapshot().range,{start:0,end:5,selectedSlot:0});
 for(let i=0;i<10;i++)m.input('down');assert.equal(m.snapshot().index,23);assert.equal(m.snapshot().rows.length,11);assert.equal(m.snapshot().range.end-m.snapshot().range.start,5);
});
test('removing a focused task returns to select instead of silently acting on another',()=>{
 const m=create();m.setLists([rows(4)]);m.input('tap-fore');m.input('tap-fore');
 m.setLists([rows(4).slice(1)]);assert.equal(m.snapshot().level,'select');assert.equal(m.snapshot().selected.id,'task-1');
});
test('More returns to Task and home preserves the All Tasks selection',()=>{
 const m=create();m.setLists(COLLECTIONS.map(()=>rows(20)));m.input('down');m.input('tap-fore');m.input('tap-fore');m.input('more');
 assert.equal(m.snapshot().level,'more');m.input('back');assert.equal(m.snapshot().level,'task');m.input('home');assert.equal(m.snapshot().index,5);
});
function clock(){let t=0,id=0;const jobs=new Map();return {setTimeout:(fn,ms)=>{jobs.set(++id,{fn,at:t+ms});return id;},clearTimeout:key=>jobs.delete(key),advance:ms=>{t+=ms;for(const [key,job]of [...jobs])if(job.at<=t){jobs.delete(key);job.fn();}}};}
test('single middle is delayed; double middle cancels Back and fires exactly once',()=>{
 const time=clock(),actions=[],input=require('./public/js/device-views/glasses-navigation-model').createInput(a=>actions.push(a),time);
 input.down('middle');input.up('middle');time.advance(100);assert.deepEqual(actions,[]);input.down('middle');input.up('middle');time.advance(400);assert.deepEqual(actions,['double-middle']);
 input.down('middle');input.up('middle');time.advance(320);assert.deepEqual(actions,['double-middle','tap-middle']);
});
test('holds and cancellation never leak a forefinger completion tap',()=>{
 const time=clock(),actions=[],input=require('./public/js/device-views/glasses-navigation-model').createInput(a=>actions.push(a),time);
 input.down('fore');input.down('fore');time.advance(550);input.up('fore');assert.deepEqual(actions,['hold-fore']);
 input.down('fore');input.cancel();input.up('fore');time.advance(600);assert.deepEqual(actions,['hold-fore']);
 input.down('fore');input.up('fore');assert.deepEqual(actions,['hold-fore','tap-fore']);
 input.down('middle');input.up('middle');input.reset();time.advance(400);assert.deepEqual(actions,['hold-fore','tap-fore']);
});
test('More supports bounded gesture selection and returns to task',()=>{
 const m=create();m.setLists([rows(2)]);m.input('tap-fore');m.input('tap-fore');m.input('more');
 assert.equal(m.snapshot().moreIndex,0);m.input('down');assert.equal(m.snapshot().moreIndex,1);
 for(let i=0;i<10;i++)m.input('down');assert.equal(m.snapshot().moreIndex,3);
 m.input('back');assert.equal(m.snapshot().level,'task');m.input('more');assert.equal(m.snapshot().moreIndex,0);
});
