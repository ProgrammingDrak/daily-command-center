// Whenever is a placement of an ordinary task tree, not a separate task type.
// Reuse the canonical two-edge subtree collector and transactional rescheduler.
const TaskModel=require('../public/js/task-model');
const {collectSubtreeBlockIds,unplannedProperties}=require('./reschedule');
function fail(message,statusCode=400){const error=new Error(message);error.statusCode=statusCode;throw error;}
function plan(parent,pool,{targetDate,placement,parentStart,parentEnd}){
 const stage=placement.stage||TaskModel.WHENEVER_STAGE;
 const toPool=placement.kind==='whenever';
 const dateOnly=placement.kind==='pool_date';
 if(!TaskModel.isTaskRow(parent)||parent.type==='day_root')fail('Only tasks can move to Whenever');
 const p=parent.properties||{};
 if(parent.deleted_at)fail('Block is deleted');
 if((p.source==='calendar'||p.gcal_event_id||p.calendar_id)&&['meeting','oneone'].includes(p.type||p.kind))fail('Calendar meetings must be moved in their source calendar',409);
 if(toPool){
  if(targetDate!==null)fail('Whenever placement requires a null targetDate');
  if(!['Whenever','Backlog'].includes(stage))fail('Invalid task pool stage');
 }else{
  if(parent.date||(!dateOnly&&p.kind!=='backlog')||(placement.kind==='whenever_schedule'&&!TaskModel.isWheneverPoolRow(parent)))fail('Task has already left the task pool',409);
  if(dateOnly&&!TaskModel.foldsIntoItinerary(parent)&&p.kind!=='backlog')fail('Only tasks can be assigned a date');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(targetDate||''))fail('Invalid targetDate');
  const hhmm=v=>/^([01]\d|2[0-3]):[0-5]\d$/.test(v||'');
  if(dateOnly){
   if(parentStart!=null||parentEnd!=null)fail('Date-only placement cannot include a time');
  }else if(!hhmm(parentStart)||!hhmm(parentEnd)||parentEnd<=parentStart)fail('Scheduling requires a valid start and end');
 }
 const byId=new Map(pool.map(row=>[row.id,row]));byId.set(parent.id,parent);
 const ids=collectSubtreeBlockIds(pool,parent);
 const min=s=>Number(s.slice(0,2))*60+Number(s.slice(3));
 const fmt=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
 const durations=placement.durations||{};
 if(typeof durations!=='object'||Array.isArray(durations)||Object.entries(durations).some(([id,value])=>!ids.includes(id)||!Number.isFinite(value)||value<0||value>1440))fail('Invalid subtree durations');
 const moves=ids.map(id=>{
  const row=byId.get(id);
  // An undated task gets a day, not an invented origin or a timed slot. Reuse
  // unplanned placement so stale pins/all-day fields cannot survive the move.
  // The same subtree transaction still owns identity, notes and revisions.
  if(dateOnly){
   const declaredDuration=durations[id]??(row.properties||{}).duration??(row.properties||{}).durMin;
   const requested=declaredDuration==null?durations:{[id]:declaredDuration};
   const props=unplannedProperties(row,parent.id,requested);
   if(!props.local_id&&(row.properties||{}).kind==='backlog')props.kind='task';
   return {id,date:targetDate,properties:props,...(id===parent.id?{parentId:null}:{}),expectedDate:row.date,expectedUpdatedAt:row.updated_at};
  }
  const props={...row.properties};
  const raw=durations[id]??props.durMin??props.duration??30;
  const duration=id!==parent.id&&props.subtaskOf?0:(Number.isFinite(Number(raw))&&Number(raw)>0?Number(raw):30);
  props.duration=duration;props.durMin=duration;
  delete props._pinnedStart;delete props.userSetStart;
  // Moving a branch out detaches only its root from an ancestor outside the move.
  if(id===parent.id){delete props.subtaskOf;delete props.wrapId;}
  if(toPool){
   props.kind='backlog';props.stage=stage;delete props.start;delete props.end;
   delete props.all_day;delete props.all_day_start;delete props.all_day_end;
  }else{
   if(props.kind==='backlog'){if(props.local_id)delete props.kind;else props.kind='task';}
   props.start=parentStart;
   props.end=id===parent.id?parentEnd:(props.subtaskOf?parentStart:fmt(Math.min(1439,min(parentStart)+duration)));
  }
  return {id,date:toPool?null:targetDate,properties:props,...(id===parent.id?{parentId:null}:{}),expectedDate:row.date,expectedUpdatedAt:row.updated_at};
 });
 return {ids,moves};
}
module.exports={plan};
