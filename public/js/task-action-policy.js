// One vocabulary for role-aware task controls. A role name never implies a new grant.
(function(root,factory){const value=factory();if(typeof module==='object'&&module.exports)module.exports=value;else{root.DCC=root.DCC||{};root.DCC.TaskActionPolicy=value;}})(typeof window==='undefined'?globalThis:window,function(){
  'use strict';
  const labels=Object.freeze({complete:'Completion',edit:'Task title',schedule:'Scheduling',delegate:'Move to Waiting',react:'Reactions',bounty:'Daily points bounty',reward:'Reward offers'});
  const actions=Object.freeze(Object.keys(labels));
  const modes=Object.freeze(['view','suggest','execute']);
  function valid(value){return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.entries(value).every(([key,mode])=>actions.includes(key)&&modes.includes(mode));}
  function resolve({owner=false,allowed=false,permissions={},preview=false}={}){
    return Object.fromEntries(actions.map(action=>[action,preview||!allowed?'view':owner?'execute':valid(permissions)&&modes.includes(permissions[action])?permissions[action]:'view']));
  }
  function mode(map,action){return actions.includes(action)&&modes.includes(map?.[action])?map[action]:'view';}
  return {labels,actions,modes,valid,resolve,mode};
});
