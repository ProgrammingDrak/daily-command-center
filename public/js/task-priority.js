// Explicit user priority. Never infer from retired priority/urgent/stage fields.
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root){root.DCC=root.DCC||{};root.DCC.TaskPriority=api;}
})(typeof self!=='undefined'?self:this,function(){
  function normalize(value){
    const key=typeof value==='string'?value.trim().toLowerCase():'';
    return key==='low'?'Low':key==='high'?'High':'Medium';
  }
  function read(task){return normalize(task&&task.taskPriority);}
  // Stable partition: never sort or write the caller's task array. Dedupe IDs
  // because the day model can expose a task through more than one relationship.
  function group(tasks){
    const groups=['High','Medium','Low'].map(priority=>({priority,tasks:[]}));
    const byPriority=new Map(groups.map(group=>[group.priority,group])),seen=new Set();
    (tasks||[]).forEach(task=>{
      if(!task||seen.has(task.id))return;
      seen.add(task.id);byPriority.get(read(task)).tasks.push(task);
    });
    return groups;
  }
  return {normalize,read,group};
});
