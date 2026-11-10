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
