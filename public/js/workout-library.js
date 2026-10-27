/* Owner-private reusable definitions and compositions. No session writes on browse. */
(function () {
  'use strict';
  const D=window.DCC,W=window.WorkoutModel,esc=D.esc;
  const api=(path,opts)=>D.api('/api/activity'+path,opts);
  const button=(label,action,id='')=>'<button type="button" data-library-action="'+action+'" data-id="'+esc(id)+'">'+esc(label)+'</button>';
  const date=value=>value?new Date(value).toLocaleString():'Not recorded';
  const field=(label,key,value,textarea=false)=>'<label class="wp-field"><span>'+esc(label)+'</span>'+(textarea?'<textarea data-field="'+key+'" rows="3">'+esc(value||'')+'</textarea>':'<input data-field="'+key+'" value="'+esc(value||'')+'">')+'</label>';
  const select=(label,key,value,options)=>'<label class="wp-field"><span>'+esc(label)+'</span><select data-field="'+key+'">'+options.map(x=>'<option'+(x===value?' selected':'')+'>'+esc(x)+'</option>').join('')+'</select></label>';
  function planDetails(plan){return plan.groups.map((g,i)=>'<section class="wp-library-group"><strong>'+(i+1)+'. '+esc(g.label||g.kind)+' · '+g.rounds+' round'+(g.rounds===1?'':'s')+'</strong>'+(g.suggestedSeconds!=null?'<p>Shared suggested window: '+g.suggestedSeconds+'s</p>':'')+'<ol>'+g.exerciseIds.map(id=>{const e=plan.exercises.find(x=>x.id===id);return '<li><strong>'+esc(e.name)+(e.side&&e.side!=='none'?' · '+esc(e.side.toUpperCase()):'')+'</strong>'+ (e.suggestedSeconds!=null?' · suggested '+e.suggestedSeconds+'s':'')+'<small>'+e.sets.map(s=>[s.reps!=null?s.reps+(s.repsMax!=null&&s.repsMax!==s.reps?'–'+s.repsMax:'')+' reps':'',s.weight!=null?s.weight+' '+s.unit:'',s.seconds!=null?s.seconds+'s planned hold':''].filter(Boolean).join(' · ')).filter(Boolean).join(' / ')+'</small><small>Movement '+esc(e.catalogExerciseId||'session-only')+' · snapshot revision '+esc(e.definitionRevision??'not recorded')+'</small></li>';}).join('')+'</ol></section>').join('');}
  async function open(tab='movements'){
    const body=document.createElement('div');body.className='workout-planner wp-library';body.textContent='Loading private library…';
    const modal=D.modal({title:'Guided routines · workouts',body,actions:[{label:'Close'}]});modal.el.classList.add('wp-dialog');
    let catalog=[],templates=[];
    try{const result=await Promise.all([api('/exercises'),api('/templates')]);catalog=result[0].exercises;templates=result[1].templates;D.Workout.refreshLibrary(catalog,templates);}
    catch(e){body.textContent=e.message;return;}
    function render(query=''){
      body.innerHTML='<nav class="wp-toolbar" aria-label="Workout library sections">'+button('Movement cards','movements')+button('Workout templates','workouts')+'</nav><h3>'+(tab==='movements'?'Movement cards':'Workout templates')+'</h3><p class="wp-notice">Private library → reusable workout template → detached session. Library edits never rewrite saved templates or frozen sessions.</p><p role="alert" class="act-error"></p>'+
        (tab==='movements'?button('New movement','new-movement')+'<label class="wp-field">Find movement<input type="search" data-library-search value="'+esc(query)+'"></label>'+catalog.filter(e=>e.name.toLowerCase().includes(query.toLowerCase())).map(e=>{
          const used=templates.filter(t=>t.plan.exercises.some(x=>x.catalogExerciseId===e.id));
          return '<details class="wp-library-item"><summary><strong>'+esc(e.name)+'</strong><span>'+ (e.builtin?'Built-in':'Your movement')+' · revision '+e.revision+'</span></summary><p>'+esc(e.movement?.visualInstructions||'No visual instructions recorded.')+'</p><p><strong>Spoken cue text · no audio</strong><br>'+esc(e.movement?.spokenCue||'Not authored')+'</p><small>Movement ID: '+esc(e.id)+'<br>Last edited: '+(e.builtin?'Bundled definition v1':date(e.updatedAt))+'</small><p>Used in saved workout templates: '+(used.length?used.map(t=>esc(t.title)+' (r'+t.revision+')').join(', '):'None')+'</p>'+button(e.builtin?'Make editable copy':'Edit movement','edit-movement',e.id)+'</details>';
        }).join(''):
        button('New workout template','new-workout')+button('Gentle Reset example','example')+'<p class="wp-notice">Templates contain planned cards and goals only. Create a detached session to use prompted guidance.</p>'+templates.map(t=>'<details class="wp-library-item"><summary><strong>'+esc(t.title)+'</strong><span>Revision '+t.revision+' · '+t.plan.groups.length+' groups</span></summary><small>Template ID: '+esc(t.id)+'<br>Last edited: '+date(t.updatedAt)+'<br>Source: '+esc(t.sourceTemplateId?'template '+t.sourceTemplateId:t.sourceSessionId?'session '+t.sourceSessionId:'authored template')+'</small>'+planDetails(t.plan)+button('Edit composition','edit-workout',t.id)+button('Create detached session','use-workout',t.id)+'</details>').join('')+(templates.length?'':'<p>No saved workout templates yet. Start with Gentle Reset or a blank composition.</p>'));
    }
    body.addEventListener('input',e=>{if(!e.target.matches('[data-library-search]'))return;const query=e.target.value;render(query);const input=body.querySelector('[data-library-search]');input.focus();});
    body.addEventListener('click',async e=>{const b=e.target.closest('[data-library-action]');if(!b)return;const a=b.dataset.libraryAction,id=b.dataset.id;
      try{if(a==='movements'||a==='workouts'){tab=a;render();}
        else if(a==='new-movement'||a==='edit-movement')editMovement(a==='new-movement'?null:catalog.find(x=>x.id===id));
        else if(a==='new-workout'||a==='edit-workout'||a==='example'){const t=a==='example'?{title:'Gentle Reset',plan:W.gentleReset(()=>crypto.randomUUID())}:a==='edit-workout'?templates.find(t=>t.id===id):null;D.Workout.editTemplate(t,catalog,templates);}
        else if(a==='use-workout'){const t=templates.find(t=>t.id===id);D.Activity.create('workout',{templateId:t.id,title:t.title});}
      }catch(err){body.querySelector('[role=alert]').textContent=err.message;}
    });render();
  }
  function editMovement(original){const editing=original&&!original.builtin,body=document.createElement('div');body.className='workout-planner';
    body.innerHTML=field('Movement name','name',editing?original.name:original?original.name+' · my version':'')+field('Visual instructions','visualInstructions',original?.movement?.visualInstructions,true)+field('Spoken cue text · audio deferred','spokenCue',original?.movement?.spokenCue,true)+select('Primary goal','goalKind',original?.movement?.goalKind||'strength',['strength','hold','window'])+'<details><summary>Conventions &amp; optional breath</summary>'+select('Load convention','loadMode',original?.loadMode||'bodyweight',['total','per-dumbbell','bodyweight','added','assistance'])+select('Has separate sides','supportsSide',original?.movement?.supportsSide?'yes':'no',['no','yes'])+select('Optional movement-linked breath','breath',original?.movement?.breath||'none',['none','inhale','exhale'])+'</details><p>Changes apply to future card insertions. Saved templates and started sessions retain their snapshots. Refresh a card explicitly in a template to adopt this revision.</p><p role="alert" class="act-error"></p>';
    let busy=false;
    const modal=D.modal({title:editing?'Edit movement · revision '+original.revision:'New reusable movement',body,onClose:reason=>{if(reason!=='replaced')queueMicrotask(()=>open('movements'));},actions:[{label:'Cancel'},{label:'Save movement',kind:'primary',onClick:async()=>{if(busy)return false;busy=true;const get=k=>body.querySelector('[data-field="'+k+'"]').value;try{await api('/exercises'+(editing?'/'+encodeURIComponent(original.id):''),{method:editing?'PUT':'POST',body:{name:get('name'),loadMode:get('loadMode'),movement:{visualInstructions:get('visualInstructions'),spokenCue:get('spokenCue'),goalKind:get('goalKind'),supportsSide:get('supportsSide')==='yes',breath:get('breath')},...(editing?{expectedRevision:original.revision}:{})}});return true;}catch(e){body.querySelector('[role=alert]').textContent=e.message;return false;}finally{busy=false;}}}]});modal.el.classList.add('wp-dialog');
  }
  document.getElementById('workout-library-open')?.addEventListener('click',()=>open('workouts'));
  D.WorkoutLibrary={open};
})();
