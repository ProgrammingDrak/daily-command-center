const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,name),'utf8');
const strip=code=>code.replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:])\/\/[^\n]*/g,'$1');
const requirements={
  'public/js/block-store.js':['TaskActions?.captureWrite','TaskActions?.finish','TaskActions?.restore'],
  'public/js/working-queue.js':['TaskModel.projectCollection','TaskActions?.capture','TaskActions?.finish'],
  'public/js/unfinished-tasks.js':['TaskModel.projectCollection','TaskActions.run'],
  'public/js/task-library.js':['TaskModel','TM.projectCollection','TaskActions.run'],
  'public/js/itinerary-card.js':['TaskActions.bind','TaskModel?.hierarchyLabel'],
  'public/js/triage.js':['TaskModel.normalizeCollection','TaskRows?.bind'],
  'public/js/schedule-tab.js':['TaskModel.normalizeCollection','TaskRows?.bind'],
  'public/js/persistence.js':['TM.projectCollection','projectedTasks.get'],
  'public/js/schedule.js':['TaskActions.run','TM.normalizeCollection'],
  'public/js/glasses-tasks-session.js':["require('./task-actions')",'captureWrite','controller().finish'],
  'public/js/glasses-model.js':['TM.projectCollection','TM.normalizeCollection'],
  'db.js':['TaskModel.projectCollection','TaskModel.actionTargets']
};
function violations(files){
  const out=[];
  for(const [file,markers]of Object.entries(requirements))for(const marker of markers)
    if(!strip(files[file]).includes(marker))out.push(file+': missing '+marker);
  for(const file of ['public/js/working-queue.js','public/js/unfinished-tasks.js','public/js/task-library.js']){
    const code=strip(files[file]);
    if(/parents\.get\(ev\[key\]\)|parentKeys\.get\(task\.(subtaskOf|wrapId)\)/.test(code))out.push(file+': private alias resolver');
    if(/\/api\/task-library\/tasks\/.*\/complete/.test(code))out.push(file+': private completion endpoint');
  }
  return out;
}
test('every task surface reaches the shared hierarchy and durable action lifecycle',()=>{
  const files=Object.fromEntries(Object.keys(requirements).map(file=>[file,read(file)]));
  assert.deepEqual(violations(files),[]);
  for(const [file,marker]of [['public/js/block-store.js','TaskActions?.captureWrite'],['public/js/itinerary-card.js','TaskActions.bind'],['public/js/working-queue.js','TaskModel.projectCollection']]){
    const mutant={...files,[file]:files[file].replaceAll(marker,'BYPASSED')};
    assert.ok(violations(mutant).length>0,'guard must reject bypass in '+file);
  }
  const duplicate={...files,'public/js/working-queue.js':files['public/js/working-queue.js']+'\nparents.get(ev[key]);'};
  assert.ok(violations(duplicate).some(message=>message.includes('private alias')));
});
test('both entry documents load the controller after the model and before task surfaces',()=>{
  for(const file of ['index.html','glasses.html']){
    const html=read(file),model=html.indexOf('src="/public/js/task-model.js'),actions=html.indexOf('src="/public/js/task-actions.js');
    assert.ok(model>=0&&actions>model,file);
    const consumer=file==='index.html'?'src="/public/js/schedule.js':'src="/public/js/glasses-tasks-session.js';
    assert.ok(html.indexOf(consumer)>actions,file);
  }
});
