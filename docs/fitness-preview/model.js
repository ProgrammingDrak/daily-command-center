// Review-only provider-neutral contract. No IO, SDK, tokens, or production writes.
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.RunImportPreview=factory();
})(typeof self!=='undefined'?self:this,function(){
  'use strict';
  const clone=v=>JSON.parse(JSON.stringify(v));
  const fail=message=>{throw new Error(message);};
  function text(value,label){
    if(typeof value!=='string'||!value.trim()||value.length>200)fail('Invalid '+label);
    return value.trim();
  }
  function metric(value,label){
    if(value==null)return null;
    if(typeof value!=='number'||!Number.isFinite(value)||value<0)fail('Invalid '+label);
    return value;
  }
  function normalize(input){
    if(!input||input.version!==1)fail('Unsupported candidate version');
    const s=input.source||{}, m=input.metrics||{};
    // An adapter's raw provider response cannot be passed through this boundary.
    const allowed=new Set(['version','source','metrics','occurredOn']);
    if(Object.keys(input).some(k=>!allowed.has(k)))fail('Unexpected candidate field');
    if(Object.keys(s).some(k=>!['provider','recordId','revision','origin','startedAt'].includes(k)))fail('Unexpected source field');
    if(Object.keys(m).some(k=>!['distanceMeters','elapsedSeconds','movingSeconds'].includes(k)))fail('Unexpected metric field');
    const source={provider:text(s.provider,'provider'),recordId:text(s.recordId,'record ID'),
      revision:text(s.revision,'source revision'),origin:text(s.origin,'record origin'),startedAt:text(s.startedAt,'start instant')};
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(source.startedAt)||!Number.isFinite(Date.parse(source.startedAt)))fail('Invalid start instant');
    // Results date is a reviewed local date, never silently derived from UTC.
    if(!/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn)||new Date(input.occurredOn+'T12:00:00Z').toISOString().slice(0,10)!==input.occurredOn)fail('Invalid results date');
    const metrics={distanceMeters:metric(m.distanceMeters,'distance'),elapsedSeconds:metric(m.elapsedSeconds,'elapsed time'),movingSeconds:metric(m.movingSeconds,'moving time')};
    if(metrics.distanceMeters>1000000||metrics.elapsedSeconds>31536000||metrics.movingSeconds>31536000)fail('Run metric exceeds the DCC record limit');
    if(metrics.elapsedSeconds!=null&&metrics.movingSeconds!=null&&metrics.movingSeconds>metrics.elapsedSeconds)fail('Moving time exceeds elapsed time');
    return {version:1,source,metrics,occurredOn:input.occurredOn};
  }
  const key=v=>JSON.stringify([v.source.provider,v.source.origin,v.source.recordId]);
  function review(input,existing=[]){
    const candidate=normalize(input), previous=existing.map(normalize);
    const exact=previous.find(v=>key(v)===key(candidate));
    const status=exact?(JSON.stringify(exact)===JSON.stringify(candidate)?'duplicate':'source-updated'):
      previous.some(v=>v.source.startedAt===candidate.source.startedAt&&v.metrics.distanceMeters===candidate.metrics.distanceMeters)?'possible-duplicate':'ready';
    const {distanceMeters:d,elapsedSeconds:e}=candidate.metrics;
    return {candidate,status,paceSecondsPerKm:d>0&&e>0?e/(d/1000):null};
  }
  function accept(input,options={}){
    const result=review(input,options.existing||[]);
    if(options.readConsent!==true)fail('Source read consent is absent or revoked');
    if(options.attachConsent!==true)fail('Approve attaching these metrics to the selected private task');
    const taskId=text(options.taskId,'selected task');
    if(result.status==='duplicate')fail('Source record already attached');
    if(result.status==='source-updated')fail('Review the changed source before replacing a prior result');
    if(result.status==='possible-duplicate'&&options.allowPossibleDuplicate!==true)fail('Review possible duplicate sources first');
    // A future server must store provenance alongside the existing v1 actual
    // run under the same owner lock. This envelope is preview memory only.
    return {taskId,occurredOn:result.candidate.occurredOn,
      run:{id:'preview-run',name:'Run',planRunId:null,distance:result.candidate.metrics.distanceMeters,unit:'m',seconds:result.candidate.metrics.elapsedSeconds},
      provenance:clone(result.candidate.source),movingSeconds:result.candidate.metrics.movingSeconds};
  }
  return {normalize,review,accept};
});
