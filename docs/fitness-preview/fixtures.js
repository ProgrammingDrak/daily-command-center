// Fictional records only; adapters and credentials do not exist in this preview.
(function(root){
  const base={version:1,source:{provider:'example-provider',recordId:'demo-001',revision:'1',origin:'Demo running watch',startedAt:'2026-10-08T07:00:00-04:00'},occurredOn:'2026-10-08',metrics:{distanceMeters:5000,elapsedSeconds:1800,movingSeconds:1680}};
  const copy=()=>JSON.parse(JSON.stringify(base));
  const missing=copy();missing.metrics.distanceMeters=null;
  const duplicate=copy();const cross=copy();cross.source.provider='example-device-store';cross.source.recordId='demo-002';
  const midnight=copy();midnight.source.startedAt='2026-10-07T23:45:00-07:00';midnight.occurredOn='2026-10-07';
  const revised=copy();revised.source.revision='2';revised.metrics.distanceMeters=5100;
  root.RunImportFixtures=[
    {id:'run',label:'Complete run',candidate:base,existing:[],readConsent:true},
    {id:'missing',label:'Missing distance',candidate:missing,existing:[],readConsent:true},
    {id:'duplicate',label:'Exact duplicate',candidate:duplicate,existing:[base],readConsent:true},
    {id:'cross',label:'Possible duplicate from another source',candidate:cross,existing:[base],readConsent:true},
    {id:'revised',label:'Changed source record',candidate:revised,existing:[base],readConsent:true},
    {id:'midnight',label:'Run before local midnight',candidate:midnight,existing:[],readConsent:true},
    {id:'revoked',label:'Revoked source consent',candidate:base,existing:[],readConsent:false}
  ];
})(typeof self!=='undefined'?self:globalThis);
