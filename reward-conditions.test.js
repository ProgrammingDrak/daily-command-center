const test = require('node:test'), assert = require('node:assert/strict');
const C = require('./public/js/reward-conditions');
const task = taskId => ({type:'task',taskId});
const group = (op,...children) => ({type:'group',op,children});
test('mixed recursive ALL/ANY truth table, including unavailable leaves', () => {
  const root=C.normalize(group('all',task('a'),group('any',task('b'),group('all',task('c'),task('d')))));
  for(let bits=0;bits<16;bits++){
    const values=['a','b','c','d'].map((_,i)=>!!(bits&(1<<i)));
    assert.equal(C.evaluate(root,n=>values['abcd'.indexOf(n.taskId)]), values[0]&&(values[1]||(values[2]&&values[3])),String(bits));
  }
  assert.equal(C.evaluate(root,()=>undefined),false);
  assert.equal(C.describe(root),'ALL (a; ANY (b; ALL (c; d)))');
});
test('rejects empty, invalid, duplicate, aliased and cyclic conditions', () => {
  for(const root of [null,[],{},group('all'),group('any'),group('xor',task('a')),task(''),task('a'.repeat(201)),group('all',task('a'),task('a'))])assert.throws(()=>C.normalize(root));
  assert.throws(()=>C.normalize(group('any',task('alias'),task('canonical')),id=>({taskId:id,blockId:'same'})),/only once/);
  const cycle=group('all');cycle.children.push(cycle);assert.throws(()=>C.normalize(cycle),/cycles/);
  const reused=task('a');assert.throws(()=>C.normalize(group('all',reused,reused)),/cycles/);
  assert.throws(()=>C.normalize(task('private'),()=>null),/unavailable/);
});
test('depth is bounded by total work, not a shallow nesting limit; input is never mutated',()=>{
  let root=task('one');for(let i=0;i<255;i++)root=group(i%2?'any':'all',root);
  const before=JSON.stringify(root),normalized=C.normalize(root);
  assert.equal(C.evaluate(normalized,()=>true),true);assert.equal(C.leaves(normalized).length,1);assert.equal(JSON.stringify(root),before);
  assert.throws(()=>C.normalize(group('all',root)),/256/);
  assert.throws(()=>C.normalize(group('all',...Array.from({length:256},(_,i)=>task(String(i))))),/256/);
});
