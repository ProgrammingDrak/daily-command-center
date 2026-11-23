const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./public/js/itinerary-card.js'), 'utf8');

function rowHarness(code = source) {
  let opened = 0;
  const handlers = {};
  const inside = new Set();
  const row = {dataset:{},style:{},querySelector:()=>null,
    addEventListener:(name,fn)=>{handlers[name]=fn;},contains:node=>inside.has(node)};
  const page = {document:{createElement:()=>row},cfg:()=>({color:'purple'})};
  page.window = page;
  vm.runInNewContext(code, page);
  page.renderItineraryListRow({id:'task',title:'Shared task',type:'task'}, {onOpen:()=>opened++});
  return {row,inside,handlers,opened:()=>opened};
}

test('queue sections cannot swallow row clicks, while controls within the row retain their actions', () => {
  const h = rowHarness();
  const section = {tagName:'DETAILS'};
  h.handlers.click({target:{closest:()=>section}});
  assert.equal(h.opened(),1,'a surrounding details section must not block title taps');
  const button = {};
  h.inside.add(button);
  h.handlers.click({target:{closest:()=>button}});
  assert.equal(h.opened(),1,'a row control must not open the editor as well');
  h.handlers.click({target:{closest:()=>null}});
  assert.equal(h.opened(),2);
});

test('collections inherit the itinerary task accent without a local color implementation', () => {
  const {row} = rowHarness();
  assert.match(row.innerHTML,/class="bar" style="background:purple"/);
});

test('task pill views consume the itinerary renderer and contain no alternate row skeleton', () => {
  for (const file of ['delegated','whenever','task-library','catch-up']) {
    const code = fs.readFileSync(require.resolve('./public/js/'+file+'.js'),'utf8');
    assert.equal((code.match(/window\.renderItineraryListRow\(/g)||[]).length,file === 'delegated' ? 2 : 1,file+' must route every row branch through the shared renderer');
    assert.doesNotMatch(code,/<div class="(?:delegated-card|whenever-row|it-list-item)/,file);
  }
  const css = fs.readFileSync(require.resolve('./public/css/dashboard.css'),'utf8') +
    fs.readFileSync(require.resolve('./public/css/task-library.css'),'utf8');
  assert.doesNotMatch(css,/\.whenever-row\.it-list-item|\.task-collection-list \.it-list-/);
});


test('Waiting menus retain check-in, task completion, and dependency actions', () => {
  const code = fs.readFileSync(require.resolve('./public/js/delegated.js'),'utf8');
  const actions = [];
  let menu;
  const page = {window:{openRadialMenu:(_button,items)=>menu=items},
    isDoneDelegated:item=>item.properties.status==='done',
    isTaskDependency:item=>item.properties.blockerType==='task'};
  for (const name of ['markDelegatedItemCheckedById','scheduleDelegatedItem','unblockWaitingItem','releaseTaskDependencyToBacklog','openTaskDependencyModal','removeTaskDependency','openDelegatedModal','completeWaitingItem','deleteDelegatedItem']) {
    page[name]=(...args)=>actions.push([name,...args]);
  }
  vm.runInNewContext(code.slice(code.indexOf('  function waitingActions('),code.indexOf('  function renderTaskDependencyCard(')),page);
  page.waitingActions({id:'waiting',properties:{}},'trigger');
  assert.deepEqual(Array.from(menu,item=>item.label),['Checked in','Schedule check-in','Schedule task','Edit','Complete task','Delete']);
  menu.forEach(item=>item.onPick());
  assert.deepEqual(actions,[['markDelegatedItemCheckedById','waiting'],['scheduleDelegatedItem','waiting','trigger'],['unblockWaitingItem','waiting','trigger'],['openDelegatedModal','waiting'],['completeWaitingItem','waiting'],['deleteDelegatedItem','waiting']]);
  page.waitingActions({id:'waiting',properties:{checkInRepeat:false}},'trigger');
  assert.deepEqual(Array.from(menu,item=>item.label),['Schedule task','Edit','Complete task','Delete']);
  page.waitingActions({id:'waiting',properties:{blockerType:'task',status:'ready'}},'trigger');
  assert.deepEqual(Array.from(menu,item=>item.label),['Schedule task','Move to Solo','Change prerequisite','Remove dependency','Delete']);
  page.waitingActions({id:'waiting',properties:{status:'done'}},'trigger');
  assert.deepEqual(Array.from(menu,item=>item.label),['Edit','Delete']);
});
