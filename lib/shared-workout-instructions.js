const W = require('../public/js/workout-model');
// Deliberate privacy projection, not planOnly(): planned weights/reps and all
// measured results are private too. IDs are detached from the owner's library.
function instructionPlan(plan, makeId) {
  let n=0; const id=makeId || (()=>'shared-instruction-'+(++n));
  const ids=new Map(plan.exercises.map(e=>[e.id,id()]));
  return W.normalizePlan({
    exercises:plan.exercises.map(e=>({id:ids.get(e.id),catalogExerciseId:null,name:e.name,
      ...(e.movement?{movement:W.movement(e.movement)}:{}),...(e.side?{side:e.side}:{}),
      ...(e.suggestedSeconds!=null?{suggestedSeconds:e.suggestedSeconds}:{}),
      sets:e.sets.map(s=>({id:id(),round:s.round,...W.measurement({})}))})),
    groups:plan.groups.map(g=>({id:id(),kind:g.kind,rounds:g.rounds,exerciseIds:g.exerciseIds.map(e=>ids.get(e)),
      ...(g.label?{label:g.label}:{}),...(g.pacing?{pacing:g.pacing}:{}),...(g.suggestedSeconds!=null?{suggestedSeconds:g.suggestedSeconds}:{})})),
    runs:plan.runs.map(r=>({id:id(),name:r.name,distance:null,seconds:null,unit:'km'}))
  });
}
module.exports={instructionPlan};
