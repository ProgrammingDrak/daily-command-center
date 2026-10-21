const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Model=require('./docs/fitness-preview/model'),Activity=require('./public/js/activity-model');
const base=()=>({version:1,source:{provider:'example',recordId:'demo-run',revision:'1',origin:'demo-device',startedAt:'2026-10-07T23:45:00-07:00'},occurredOn:'2026-10-07',metrics:{distanceMeters:5000,elapsedSeconds:1800,movingSeconds:1680}});
test('preview preserves local date, elapsed vs moving time and provenance without rewriting task plan',()=>{
 const input=base(),before=structuredClone(input);
 const envelope=Model.accept(input,{taskId:'demo-task',readConsent:true,attachConsent:true});
 assert.equal(envelope.occurredOn,'2026-10-07');assert.equal(envelope.run.seconds,1800);assert.equal(envelope.movingSeconds,1680);
 assert.deepEqual(envelope.provenance,input.source);assert.deepEqual(input,before);
 const record=Activity.empty('workout');record.actual.runs.push(envelope.run);record.occurredOn=envelope.occurredOn;
 assert.equal(Activity.validate(record).actual.runs[0].distance,5000);
 assert.equal(Model.review(input).paceSecondsPerKm,360);
});
test('preview leaves missing metrics unknown and explicit zero distinct; rejects ambiguous or sensitive data',()=>{
 for(const value of [null,0]){
  const input=base();input.metrics.distanceMeters=value;
  const review=Model.review(input);assert.equal(review.candidate.metrics.distanceMeters,value);assert.equal(review.paceSecondsPerKm,null);
 }
 for(const input of [{...base(),token:'secret'},{...base(),metrics:{...base().metrics,heartRate:70}},{...base(),source:{...base().source,route:[[1,2]]}},{...base(),metrics:{...base().metrics,distanceMeters:-1}},{...base(),metrics:{...base().metrics,movingSeconds:2000}},{...base(),occurredOn:'2026-02-30'},{...base(),source:{...base().source,startedAt:'yesterday'}}]) assert.throws(()=>Model.normalize(input));
});
test('source consent, explicit task selection and attachment consent are independent gates',()=>{
 const options={taskId:'demo-task',readConsent:true,attachConsent:true};
 for(const patch of [{readConsent:false},{attachConsent:false},{taskId:''}])assert.throws(()=>Model.accept(base(),{...options,...patch}));
 assert.ok(Model.accept(base(),options));
});
test('idempotency, changed source and cross-provider duplicate review prevent silent double counting',()=>{
 const original=base(), options={taskId:'demo-task',readConsent:true,attachConsent:true,existing:[original]};
 assert.equal(Model.review(original,[original]).status,'duplicate');assert.throws(()=>Model.accept(original,options),/already attached/);
 const changed=base();changed.source.revision='2';changed.metrics.distanceMeters=5100;
 assert.equal(Model.review(changed,[original]).status,'source-updated');assert.throws(()=>Model.accept(changed,options),/changed source/);
 const other=base();other.source.provider='example-other';
 assert.equal(Model.review(other,[original]).status,'possible-duplicate');assert.throws(()=>Model.accept(other,options),/possible duplicate/);
 assert.ok(Model.accept(other,{...options,allowPossibleDuplicate:true}));
});
test('all deterministic fixtures validate; preview remains outside production UI and disallows networking',()=>{
 const context={};vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('./docs/fitness-preview/fixtures.js'),'utf8'),context);
 assert.equal(context.RunImportFixtures.length,7);for(const scenario of context.RunImportFixtures)Model.review(scenario.candidate,scenario.existing);
 const index=fs.readFileSync(require.resolve('./index.html'),'utf8'), server=fs.readFileSync(require.resolve('./server.js'),'utf8');
 assert.doesNotMatch(index,/fitness-preview|RunImportPreview|RunImportFixtures/);assert.doesNotMatch(server,/fitness-preview|RunImportPreview/);
 const html=fs.readFileSync(require.resolve('./docs/fitness-preview/preview.html'),'utf8');assert.match(html,/connect-src 'none'/);assert.doesNotMatch(html,/fetch\(|localStorage|indexedDB|https?:\/\//);
});
