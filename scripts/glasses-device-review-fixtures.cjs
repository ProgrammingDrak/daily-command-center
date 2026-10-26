// Opt-in local presentation fixtures. No imported/user data or network dependencies.
const seedDetails = require('./task-detail-review-fixtures.cjs');
module.exports = function seedGlassesDeviceReview(store, date) {
  seedDetails(store, date);
  const now = new Date().toISOString();
  const add = (id, properties, day = date) => store.set(id, {
    id, type: 'block', date: day, parent_id: null,
    properties: { local_id: id, type: 'task', ...properties },
    created_at: now, updated_at: now, deleted_at: null
  });
  add('glasses-done', {title:'Send the project outline',start:'08:30',end:'08:45',duration:15,done:true,status:'done',completedAt:date+'T08:45:00-07:00'});
  add('glasses-done-child', {title:'Check the outline links',subtaskOf:'glasses-done',start:'08:30',end:'08:30',duration:0,done:true,status:'done'});
  add('glasses-done-untimed', {title:'Book the workshop room',untimed:true,done:true,status:'done',completedAt:date+'T09:00:00-07:00'});
  for(let i=1;i<=7;i++)add('glasses-later-'+i,{title:['Review the draft','Water the plants','Plan tomorrow','Back up the mockups','Pick a workshop date','Write the weekly recap','Evening reading'][i-1],start:(14+i)+':00',end:(14+i)+':20',duration:20});
  const past = new Date(date+'T00:00:00Z'); past.setUTCDate(past.getUTCDate()-1);
  add('glasses-overdue',{title:'Follow up on the example delivery',start:'10:00',end:'10:15',duration:15},past.toISOString().slice(0,10));
};
