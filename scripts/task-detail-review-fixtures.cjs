// Disposable review examples. No credentials, imported records or user data.
module.exports = function seedTaskDetailReview(store, date) {
  const now=new Date().toISOString();
  const add=(id,properties,day=date)=>store.set(id,{id,type:'block',date:day,parent_id:null,properties,created_at:now,updated_at:now,deleted_at:null});
  add('review-detail-task',{local_id:'review-detail-task',title:'Prepare the project handoff with the revised launch notes',type:'task',start:'10:00',end:'10:30',duration:30,tags:[],priority:'High'});
  add('review-detail-step',{local_id:'review-detail-step',title:'Attach the latest mockups',type:'task',subtaskOf:'review-detail-task',start:'10:00',end:'10:00',duration:0});
  add('review-workout',{local_id:'review-workout',title:'Strength session',type:'workout',start:'11:00',end:'11:45',duration:45,description:'Plan: three sets of eight squats, then a ten-minute walk.'});
  add('review-meal',{local_id:'review-meal',title:'Lunch',type:'meal',start:'12:00',end:'12:30',duration:30,description:'Plan: a bowl of rice, vegetables and tofu.'});
  add('review-meeting',{local_id:'review-meeting',title:'Example project review',type:'meeting',start:'14:00',end:'14:30',duration:30,description:'Agenda: review the handoff and agree the next step.'});
  add('review-unscheduled',{local_id:'review-unscheduled',title:'Choose a time for the workshop',type:'task',duration:30,untimed:true});
  add('review-incoming',{local_id:'review-incoming',title:'Review the request from the example meeting',type:'task',duration:15,untimed:true,triageBlock:true,triageId:'meeting:synthetic-review',triageContext:{id:'meeting:synthetic-review',type:'meeting'}},null);
  add('review-whenever',{local_id:'review-whenever',title:'Organize the example project folder',kind:'backlog',stage:'Whenever',duration:15},null);
  add('review-waiting',{kind:'delegated_item',myTask:'Finalize the project estimate',title:'Revised supplier quote',delegatee:{name:'Example reviewer'},notes:'The estimate needs an updated materials total.',status:'open',checkInDate:date,checkInRepeat:false},null);
};
