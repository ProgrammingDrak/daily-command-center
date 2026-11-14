(() => {
  "use strict";

  const PAGE_SIZE = 50;
  const controls = {
    "all-tasks": {search:"", status:"open", schedule:"all", sort:"newest", project:"all"},
    someday: {search:"", status:"all", schedule:"all", sort:"newest", project:"all"},
  };
  let mode = "all-tasks";
  let payload = null;
  let completed = new Set();
  let pending;
  let refreshTimer;
  let limit = PAGE_SIZE;

  function tagsOf(row) {
    return Array.isArray(props(row).tags) ? props(row).tags : [];
  }

  function matches(row, filters) {
    const p = props(row);
    if (filters.status !== "all" && (filters.status === "completed") !== done(row)) return false;
    if (filters.schedule !== "all" && (filters.schedule === "scheduled") !== !!row.date) return false;
    if (filters.project !== "all" && filters.project !== (p.projectId || "solo")) return false;
    const search = filters.search.trim().toLocaleLowerCase();
    return [taskTitle(row), p.detail, p.location, ...tagsOf(row), projectName(p.projectId)]
      .some(value => String(value ?? "").toLocaleLowerCase().includes(search));
  }

  function compareTasks(a, b, sort) {
    const byName = taskTitle(a).localeCompare(taskTitle(b), undefined, {numeric:true, sensitivity:"base"});
    const byCreated = String(a.created_at || props(a).createdAt || "").localeCompare(String(b.created_at || props(b).createdAt || ""));
    if (sort === "az") return byName || byCreated;
    if (sort === "za") return -byName || byCreated;
    if (sort === "scheduled") return (a.date || "9999").localeCompare(b.date || "9999") || byName;
    return (sort === "oldest" ? byCreated : -byCreated) || byName;
  }

  function root() { return document.getElementById("task-collection-root"); }

  function options(entries) {
    return entries.map(([value, label]) => '<option value="'+esc(value)+'">'+esc(label)+'</option>').join("");
  }

  function buildControls() {
    const isSomeday = mode === "someday";
    root().innerHTML = '<div class="task-collection-controls">'+
      '<label class="task-collection-search">Search<input type="search" data-filter="search" placeholder="'+(isSomeday?'Search ideas':'Search tasks')+'"></label>'+
      '<label>Sort<select aria-label="Sort" data-filter="sort">'+options([
        ["newest","Newest created"], ["oldest","Oldest created"], ["az","A–Z"], ["za","Z–A"], ...(!isSomeday ? [["scheduled","Itinerary date"]] : [])
      ])+'</select></label>'+
      (isSomeday ? "" : '<label>Status<select aria-label="Status" data-filter="status">'+options([["open","Open"],["completed","Completed"],["all","Any status"]])+'</select></label>'+
        '<label>Schedule<select aria-label="Schedule" data-filter="schedule">'+options([["all","Any schedule"],["scheduled","Scheduled"],["unscheduled","Unscheduled"]])+'</select></label>')+
      '<label>Project<select aria-label="Project" data-filter="project"></select></label></div>'+
      '<div class="task-collection-actions"><button type="button" class="btn btn-primary" data-add-task>'+(isSomeday?'Add idea':'Add task')+'</button>'+
      (isSomeday ? "" : '<details><summary>Manage</summary><div class="task-collection-tools"><button type="button" class="btn btn-ghost" data-reading-session>Reading time</button><button type="button" class="btn btn-ghost" data-import>Import</button><button type="button" class="btn btn-ghost" data-projects>Projects</button><button type="button" class="btn btn-ghost" data-categories>Categories</button></div></details>')+'</div>'+
      '<p class="task-collection-count" role="status"></p><div class="it-list-view task-collection-list"></div>'+
      '<button type="button" class="btn btn-ghost task-collection-more" hidden>Show more</button>';

    for (const input of root().querySelectorAll("[data-filter]")) {
      input.value = controls[mode][input.dataset.filter];
      input.addEventListener(input.type === "search" ? "input" : "change", () => {
        controls[mode][input.dataset.filter] = input.value;
        limit = PAGE_SIZE;
        renderRows();
      });
    }
    root().querySelector("[data-add-task]").onclick = () => taskEditor(null, {idea:isSomeday});
    if (!isSomeday) {
      root().querySelector("[data-import]").onclick = importProject;
      root().querySelector("[data-projects]").onclick = projectManager;
      root().querySelector("[data-categories]").onclick = facetManager;
    }
    root().querySelector(".task-collection-more").onclick = () => {
      const previous = limit;
      limit += PAGE_SIZE;
      renderRows();
      root().querySelector(".task-collection-list").children[previous]?.querySelector(".ttl")?.focus();
    };
  }

  function updateCollectionBadge(id, count, label) {
    const badge = document.getElementById(id);
    if (!badge) return;
    badge.textContent = count;
    badge.parentElement.setAttribute("aria-label", label + ", " + count + " open");
  }

  function updateProjectOptions() {
    const project = root().querySelector('[data-filter="project"]');
    const entries = (payload.projects || []).map(row => [row.id, projectName(row.id)]);
    project.innerHTML = options([["all","Any project"],["solo","Solo"], ...entries]);
    project.value = controls[mode].project;
    if (!project.value) project.value = controls[mode].project = "all";
  }

  function renderRows() {
    if (!payload || !root()?.querySelector(".task-collection-list")) return;
    const filters = controls[mode];
    const tasks = payload.tasks.filter(row => (mode !== "someday" || isSomedayIdea(row)) && matches(row, filters));
    tasks.sort((a,b) => compareTasks(a,b,filters.sort));
    const list = root().querySelector(".task-collection-list");
    const focused = document.activeElement?.closest(".it-list-item")?.dataset.id;
    const cards = tasks.slice(0,limit).map(row => {
      const ev = window.DCC.TaskModel.fromBlock(row);
      ev.id = row.id;
      ev.title = taskTitle(row);
      const metadata = [row.date || (mode === "someday" ? "Someday" : "Unscheduled"), projectName(props(row).projectId)];
      if (done(row)) metadata.push("Completed");
      else if (payload.readiness?.[row.id]?.state === "blocked") metadata.push("Blocked");
      if (mode === "someday") metadata.push(...tagsOf(row), props(row).location);
      const canReturn = row.date && props(row).someday === true && !done(row);
      return window.renderItineraryListRow(ev, {
        done:done(row),
        metaHtml:metadata.filter(Boolean).map(value => '<span class="task-collection-meta">'+esc(value)+'</span>').join(""),
        onOpen:() => taskEditor(row.id),
        onComplete:() => toggleCompletion(row),
        onSchedule:done(row) ? null : anchor => scheduleTask({id:row.id, title:taskTitle(row), raw:row},anchor),
        actionsBeforeHtml:canReturn ? '<button class="btn btn-ghost" type="button" data-return-idea>Return to Someday</button>' : "",
        afterRender:card => card.querySelector("[data-return-idea]")?.addEventListener("click", event => returnIdea(row, event.currentTarget)),
      });
    });
    list.replaceChildren(...cards);
    if (focused) {
      const replacement = cards.find(card => card.dataset.id === focused)?.querySelector(".ttl");
      (replacement || root().querySelector('[data-filter="search"]'))?.focus();
    }
    if (!tasks.length) {
      const empty = document.createElement("p");
      empty.className = "delegated-empty";
      empty.textContent = "No matching " + (mode === "someday" ? "ideas." : "tasks.");
      list.append(empty);
    }
    const noun = mode === "someday" ? "idea" : "task";
    root().querySelector(".task-collection-count").textContent =
      (cards.length < tasks.length ? cards.length+" of " : "")+tasks.length+" "+noun+(tasks.length === 1 ? "" : "s");
    root().querySelector(".task-collection-more").hidden = cards.length >= tasks.length;
  }

  async function returnIdea(row, button) {
    button.disabled = true;
    try {
      await window.blockStore.rescheduleBlock(row.id, null, {placement:{kind:"whenever",stage:"Backlog"}});
      notify("Returned to Someday");
      await refresh();
    } catch (error) {
      notify(error.message,"error");
      button.disabled = false;
    }
  }

  const completing = new Set();
  async function toggleCompletion(row) {
    if (completing.has(row.id)) return;
    completing.add(row.id);
    try {
      await api('/api/task-library/tasks/'+encodeURIComponent(row.id)+'/complete',{
        method:"POST",body:JSON.stringify({completed:!done(row)})
      });
      await refresh();
    } catch (error) { notify(error.message,"error"); }
    finally { completing.delete(row.id); }
  }

  function loadLibrary() { return api('/api/task-library'); }

  function completedIds(library) {
    return new Set(library.completedTaskIds || library.tasks.filter(ownCompletion).map(row => row.id));
  }

  async function glassesCollections() {
    const library = await loadLibrary();
    if (!Array.isArray(library.tasks)) throw new Error("Could not load tasks");
    const doneIds = completedIds(library);
    const open = library.tasks.filter(row => !row.deleted_at && !doneIds.has(row.id));
    const projects = new Map((library.projects || []).map(row => [row.id, props(row).name || props(row).title || "Project"]));
    const name = row => props(row).projectId ? (projects.get(props(row).projectId) || "Unknown project") : "Solo";
    const describe = row => ({kind:"task", id:row.id, actionId:row.id, row,
      ev:window.DCC.TaskModel.fromBlock(row), title:taskTitle(row)});
    return {
      allTasks:open.slice().sort((a,b) => name(a).localeCompare(name(b),undefined,{numeric:true,sensitivity:"base"})).map(describe),
      someday:open.filter(row => !row.date && props(row).someday === true).sort((a,b) => compareTasks(a,b,"newest")).map(describe),
    };
  }

  function render() {
    const container = root();
    if (!container || !document.getElementById("tasks-drawer")?.dataset.queue?.match(/^(all-tasks|someday)$/)) return;
    if (!payload) {
      container.innerHTML = pending ? '<p role="status">Loading tasks…</p>' : '<p>Could not load tasks.</p><button type="button" class="btn btn-ghost">Try again</button>';
      container.querySelector("button")?.addEventListener("click",refresh);
      return;
    }
    if (!container.querySelector(".task-collection-controls")) buildControls();
    updateProjectOptions();
    renderRows();
  }

  function refresh() {
    if (pending) return pending;
    pending = loadLibrary().then(library => {
      if (!Array.isArray(library.tasks)) throw new Error("Could not load tasks");
      payload = library;
      completed = completedIds(library);
      updateCollectionBadge("all-tasks-pill-nav-count", payload.tasks.filter(row => !done(row)).length, "Open All Tasks");
      updateCollectionBadge("someday-pill-nav-count", payload.tasks.filter(isSomedayIdea).length, "Open Someday ideas");
    }).catch(error => {
      if (payload && root()?.offsetParent) notify(error.message,"error");
    }).finally(() => {
      pending = null;
      render();
    });
    if (!payload) render();
    return pending;
  }

  function show(kind) {
    mode = kind;
    limit = PAGE_SIZE;
    root().replaceChildren();
    render();
    refresh();
  }

  function esc(value){
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[ch]);
  }
  function props(row){ return row && row.properties || {}; }
  function ownCompletion(row){ const p=props(row); return p.status==="done" || p.done===true || p.completed===true || !!(p.completedAt || p.doneAt); }
  function done(row){ return completed.has(row.id); }
  function isSomedayIdea(row){ return !row.deleted_at && !row.date && props(row).someday===true && !done(row); }
  function taskTitle(row){ const p=props(row); return String(p.title || p.text || "Untitled task"); }
  function projectName(id){
    if(!id) return "Solo";
    const project=(payload&&payload.projects||[]).find(row=>row.id===id);
    return project ? (props(project).name || props(project).title || "Project") : "Unknown project";
  }
  function api(url,options){
    return fetch(url,{headers:{"Content-Type":"application/json"},...(options||{})}).then(async response=>{
      const body=await response.json().catch(()=>({}));
      if(!response.ok) throw Object.assign(new Error(body.error||`Request failed (${response.status})`),{status:response.status});
      return body;
    });
  }
  function notify(message,kind){ if(typeof showToast==="function") showToast(message,kind||"success"); }

  function modal(title,body,options){
    const lastTrigger=document.activeElement;
    const overlay=document.createElement('div');overlay.className='tlb-overlay open';overlay.innerHTML='<div class="tlb-modal '+((options&&options.wide)?'wide':'')+'" role="dialog" aria-modal="true" aria-label="'+esc(title)+'"><div class="tlb-modal-head"><div><h3>'+esc(title)+'</h3>'+(options&&options.subtitle?'<p>'+esc(options.subtitle)+'</p>':'')+'</div><button data-modal-close aria-label="Close">×</button></div><div class="tlb-modal-body">'+body+'</div></div>';
    document.body.appendChild(overlay);const close=()=>{document.removeEventListener('keydown',escapeModal);overlay.remove();if(lastTrigger&&lastTrigger.focus)lastTrigger.focus();};overlay.querySelector('[data-modal-close]').onclick=close;overlay.addEventListener('click',event=>{if(event.target===overlay)close();});function escapeModal(event){if(event.key==='Escape'){event.preventDefault();close();}}document.addEventListener('keydown',escapeModal);setTimeout(()=>overlay.querySelector('input,textarea,select,button')?.focus(),0);return {overlay,close};
  }

  function projectManager(){
    const projects=(payload.projects||[]);const body='<div class="tlb-manager-list">'+projects.map(project=>'<div class="tlb-manager-row"><i style="background:'+esc(props(project).color||'#0075EB')+'"></i><div><b>'+esc(props(project).name)+'</b><span>'+esc(props(project).status||'active')+'</span></div><button data-project-edit="'+esc(project.id)+'">Edit</button></div>').join('')+'</div><form id="tlb-project-form" class="tlb-manager-form"><input id="tlb-project-id" type="hidden"><label class="tlb-field"><span>Project name</span><input id="tlb-project-name" required placeholder="Griffin Renovation"></label><label class="tlb-field"><span>Color</span><input id="tlb-project-color" type="color" value="#0075EB"></label><label class="tlb-field"><span>Status</span><select id="tlb-project-status"><option>active</option><option>paused</option><option>complete</option><option>archived</option></select></label><button class="tlb-btn primary" type="submit">Save project</button></form>';
    const m=modal('Projects',body,{subtitle:'Projects organize tasks and add progress, sequencing, and Continue behavior.'});
    m.overlay.querySelectorAll('[data-project-edit]').forEach(button=>button.onclick=()=>{const project=projects.find(row=>row.id===button.dataset.projectEdit);m.overlay.querySelector('#tlb-project-id').value=project.id;m.overlay.querySelector('#tlb-project-name').value=props(project).name;m.overlay.querySelector('#tlb-project-color').value=props(project).color||'#0075EB';m.overlay.querySelector('#tlb-project-status').value=props(project).status||'active';});
    m.overlay.querySelector('form').onsubmit=async event=>{event.preventDefault();const id=m.overlay.querySelector('#tlb-project-id').value;const body={name:m.overlay.querySelector('#tlb-project-name').value,color:m.overlay.querySelector('#tlb-project-color').value,status:m.overlay.querySelector('#tlb-project-status').value};try{await api(id?'/api/projects/'+id:'/api/projects',{method:id?'PATCH':'POST',body:JSON.stringify(body)});m.close();await refresh();notify('Project saved');}catch(error){notify(error.message,'error');}};
  }

  function facetManager(){
    const facets=payload.facets||[],projects=payload.projects||[];
    const body='<div class="tlb-manager-list">'+facets.map(facet=>'<div class="tlb-manager-row"><div><b>'+esc(props(facet).name)+'</b><span>'+esc(props(facet).scope)+(props(facet).scope==='project'?' · '+esc(projectName(props(facet).projectId)):'')+' · '+esc(props(facet).cardinality)+'</span><em>'+esc((props(facet).values||[]).filter(v=>!v.archived).map(v=>v.name).join(', '))+'</em></div><button data-facet-edit="'+esc(facet.id)+'">Edit</button></div>').join('')+'</div><form id="tlb-facet-form" class="tlb-manager-form"><input id="tlb-facet-id" type="hidden"><label class="tlb-field"><span>Category name</span><input id="tlb-facet-name" required placeholder="Area"></label><label class="tlb-field"><span>Scope</span><select id="tlb-facet-scope"><option value="workspace">Every project and Solo</option><option value="project">One project</option></select></label><label class="tlb-field" id="tlb-facet-project-wrap"><span>Project</span><select id="tlb-facet-project">'+projects.filter(p=>props(p).status!=='archived').map(project=>'<option value="'+esc(project.id)+'">'+esc(props(project).name)+'</option>').join('')+'</select></label><label class="tlb-field"><span>Values</span><textarea id="tlb-facet-values" placeholder="Outside, Kitchen, Living Room"></textarea><small>Comma-separated. Existing matching values keep their IDs.</small></label><label class="tlb-field"><span>Selection</span><select id="tlb-facet-cardinality"><option value="single">One value per task</option><option value="multi">Multiple values per task</option></select></label><label class="tlb-check"><input id="tlb-facet-archived" type="checkbox"> Archive category</label><button class="tlb-btn primary" type="submit">Save category</button></form>';
    const m=modal('Manage categories',body,{subtitle:'Every category becomes a field, filter, group, sort, search target, and optional column.'});
    const scope=m.overlay.querySelector('#tlb-facet-scope'),projectWrap=m.overlay.querySelector('#tlb-facet-project-wrap');const syncScope=()=>projectWrap.hidden=scope.value!=='project';scope.onchange=syncScope;syncScope();
    m.overlay.querySelectorAll('[data-facet-edit]').forEach(button=>button.onclick=()=>{const facet=facets.find(row=>row.id===button.dataset.facetEdit),p=props(facet);m.overlay.querySelector('#tlb-facet-id').value=facet.id;m.overlay.querySelector('#tlb-facet-name').value=p.name;m.overlay.querySelector('#tlb-facet-scope').value=p.scope;m.overlay.querySelector('#tlb-facet-project').value=p.projectId||'';m.overlay.querySelector('#tlb-facet-cardinality').value=p.cardinality;m.overlay.querySelector('#tlb-facet-values').value=(p.values||[]).filter(v=>!v.archived).map(v=>v.name).join(', ');m.overlay.querySelector('#tlb-facet-archived').checked=!!p.archived;syncScope();});
    m.overlay.querySelector('form').onsubmit=async event=>{event.preventDefault();const id=m.overlay.querySelector('#tlb-facet-id').value,existing=facets.find(row=>row.id===id),oldValues=existing?props(existing).values||[]:[];const names=m.overlay.querySelector('#tlb-facet-values').value.split(',').map(v=>v.trim()).filter(Boolean);const values=names.map((name,index)=>{const old=oldValues.find(v=>v.name.toLowerCase()===name.toLowerCase());return old?{...old,name,order:(index+1)*1000}:{name,order:(index+1)*1000};});const body={name:m.overlay.querySelector('#tlb-facet-name').value,scope,projectId:scope.value==='project'?m.overlay.querySelector('#tlb-facet-project').value:null,cardinality:m.overlay.querySelector('#tlb-facet-cardinality').value,values,archived:m.overlay.querySelector('#tlb-facet-archived').checked};body.scope=scope.value;try{await api(id?'/api/task-facets/'+id:'/api/task-facets',{method:id?'PATCH':'POST',body:JSON.stringify(body)});m.close();await refresh();notify('Category saved');}catch(error){notify(error.message,'error');}};
  }

  function taskEditor(taskId,defaults){
    const row=taskId&&(payload.tasks||[]).find(item=>item.id===taskId),p=row?props(row):{},projectId=defaults&&defaults.projectId!==undefined?defaults.projectId:(p.projectId||''),facets=(payload.facets||[]).filter(facet=>!props(facet).archived&&(props(facet).scope==='workspace'||props(facet).projectId===projectId));
    const facetFields=facets.map(facet=>{const fp=props(facet),selected=(p.facetValues&&p.facetValues[facet.id])||[];if(fp.cardinality==='multi')return '<fieldset class="tlb-facet-field"><legend>'+esc(fp.name)+'</legend>'+(fp.values||[]).filter(v=>!v.archived).map(value=>'<label><input type="checkbox" data-facet="'+esc(facet.id)+'" value="'+esc(value.id)+'"'+(selected.includes(value.id)?' checked':'')+'>'+esc(value.name)+'</label>').join('')+'</fieldset>';return '<label class="tlb-field"><span>'+esc(fp.name)+'</span><select data-facet="'+esc(facet.id)+'"><option value="">Unassigned</option>'+(fp.values||[]).filter(v=>!v.archived).map(value=>'<option value="'+esc(value.id)+'"'+(selected.includes(value.id)?' selected':'')+'>'+esc(value.name)+'</option>').join('')+'</select></label>';}).join('');
    const idea=p.someday===true||(!row&&defaults?.idea);
    const source=p.sourceReferences?.find(ref=>ref.kind==='link'&&ref.name==='Idea source');
    const ideaFields=idea?'<div class="tlb-form-grid"><label class="tlb-field"><span>Tags</span><input name="ideaTags" placeholder="With Fae" value="'+esc((Array.isArray(p.tags)?p.tags:[]).join(', '))+'"></label><label class="tlb-field"><span>Location</span><input name="ideaLocation" placeholder="Downtown" value="'+esc(p.location||'')+'"></label></div><label class="tlb-field"><span>Source link</span><input name="ideaLink" type="url" value="'+esc(source?.url||'')+'"></label>':'';
    const body='<form id="tlb-task-form"><label class="tlb-field"><span>Task</span><input id="tlb-task-title" required value="'+esc(row?taskTitle(row):'')+'"></label><label class="tlb-field"><span>Project</span><select id="tlb-task-project"><option value="">Solo</option>'+(payload.projects||[]).filter(project=>props(project).status!=='archived').map(project=>'<option value="'+esc(project.id)+'"'+(project.id===projectId?' selected':'')+'>'+esc(props(project).name)+'</option>').join('')+'</select></label><div class="tlb-form-grid"><label class="tlb-field"><span>Duration</span><input id="tlb-task-duration" type="number" min="1" max="1440" value="'+esc(p.duration||p.durMin||30)+'"></label></div><label class="tlb-field"><span>Details</span><textarea id="tlb-task-detail">'+esc(p.detail||'')+'</textarea></label>'+ideaFields+'<div id="tlb-task-facets">'+facetFields+'</div><div class="tlb-modal-actions">'+(row?'<button type="button" id="tlb-task-dependencies">Dependencies</button>':'')+'<button type="button" data-cancel>Cancel</button><button class="primary" type="submit">Save task</button></div></form>';
    const m=modal(row?'Edit task':idea?'Save an idea for Someday':'New task',body);m.overlay.querySelector('[data-cancel]').onclick=m.close;
    m.overlay.querySelector('#tlb-task-project').onchange=()=>{const draft={idea,projectId:m.overlay.querySelector('#tlb-task-project').value};m.close();taskEditor(taskId,draft);};
    const dep=m.overlay.querySelector('#tlb-task-dependencies');if(dep)dep.onclick=()=>{m.close();if(typeof openTaskDependencyModal==='function')openTaskDependencyModal(row.id);};
    m.overlay.querySelector('form').onsubmit=async event=>{event.preventDefault();const facetValues={};m.overlay.querySelectorAll('[data-facet]').forEach(input=>{if((input.type==='checkbox'&&!input.checked)||!input.value)return;(facetValues[input.dataset.facet]||(facetValues[input.dataset.facet]=[])).push(input.value);});const body={title:m.overlay.querySelector('#tlb-task-title').value,projectId:m.overlay.querySelector('#tlb-task-project').value||null,duration:Number(m.overlay.querySelector('#tlb-task-duration').value),detail:m.overlay.querySelector('#tlb-task-detail').value,facetValues};if(idea){const fields=new FormData(event.currentTarget);Object.assign(body,{someday:true,tags:fields.get('ideaTags').split(','),location:fields.get('ideaLocation'),sourceUrl:fields.get('ideaLink')});}const submit=event.currentTarget.querySelector('[type=submit]');submit.disabled=true;try{await api(row?'/api/task-library/tasks/'+row.id:'/api/task-library/tasks',{method:row?'PATCH':'POST',body:JSON.stringify(body)});m.close();await refresh();notify(row?'Task updated':idea?'Saved to Someday':'Task added');}catch(error){notify(error.message,'error');submit.disabled=false;}};
  }

  function importProject(){
    const body='<div id="tlb-import-source"><label class="tlb-field"><span>Project name</span><input id="tlb-import-name" value="Griffin Renovation"></label><label class="tlb-field"><span>Source document URL</span><input id="tlb-import-url" value="https://docs.google.com/document/d/1waOd00fD29aPRPuC5QIZ5W-DaBECSvfrF2CMAT0HYu8/edit"></label><label class="tlb-field"><span>Paste tasks</span><textarea id="tlb-import-text" class="large" placeholder="Paste the full task document here…"></textarea></label><p class="tlb-note">Preview is read-only. The importer recognizes headings, owners, purchases, decisions, repeated workstreams, and buy-to-install sequences.</p><button class="tlb-btn primary" id="tlb-import-preview">Preview import</button></div><div id="tlb-import-review" hidden></div>';
    const m=modal('Import a project',body,{wide:true,subtitle:'Review every proposed task and category before anything is saved.'});
    m.overlay.querySelector('#tlb-import-preview').onclick=async()=>{const button=m.overlay.querySelector('#tlb-import-preview');button.disabled=true;try{const manifest=await api('/api/projects/import/preview',{method:'POST',body:JSON.stringify({projectName:m.overlay.querySelector('#tlb-import-name').value,sourceUrl:m.overlay.querySelector('#tlb-import-url').value,text:m.overlay.querySelector('#tlb-import-text').value})});m.overlay._manifest=manifest;renderImportReview(m);}catch(error){notify(error.message,'error');}finally{button.disabled=false;}};
  }
  function renderImportReview(m){
    const manifest=m.overlay._manifest,review=m.overlay.querySelector('#tlb-import-review');m.overlay.querySelector('#tlb-import-source').hidden=true;review.hidden=false;review.innerHTML='<div class="tlb-import-summary"><b>'+manifest.items.length+' proposed tasks</b><span>'+manifest.facets.map(f=>f.name+': '+f.values.length).join(' · ')+'</span></div><div class="tlb-import-table"><table><thead><tr><th>Task</th><th>Area</th><th>Workstream</th><th>Type</th><th>Vendor</th><th>Depends on</th></tr></thead><tbody>'+manifest.items.map((item,index)=>'<tr><td><input data-import-title="'+index+'" value="'+esc(item.title)+'"></td><td>'+esc(item.area||'—')+'</td><td>'+esc(item.workstream||'—')+'</td><td>'+esc(item.itemType||'—')+'</td><td>'+esc(item.vendor||'—')+'</td><td>'+esc((item.dependsOn||[]).length?String(item.dependsOn.length):'—')+'</td></tr>').join('')+'</tbody></table></div><div class="tlb-modal-actions"><button id="tlb-import-back">Back</button><button class="primary" id="tlb-import-commit">Create '+esc(manifest.project.name)+'</button></div>';
    review.querySelector('#tlb-import-back').onclick=()=>{review.hidden=true;m.overlay.querySelector('#tlb-import-source').hidden=false;};
    review.querySelector('#tlb-import-commit').onclick=async()=>{review.querySelectorAll('[data-import-title]').forEach(input=>manifest.items[Number(input.dataset.importTitle)].title=input.value.trim());const key='import-'+Date.now()+'-'+Math.random().toString(36).slice(2);try{const result=await api('/api/projects/import/commit',{method:'POST',body:JSON.stringify({manifest,idempotencyKey:key})});m.close();await refresh();controls["all-tasks"].project=result.project.id;limit=PAGE_SIZE;render();notify(result.duplicate?'Project was already imported':'Project imported');}catch(error){notify(error.message,'error');}};
  }

  function scheduleTask(task,anchor){
    if(!task||!window.blockStore)return;
    if(typeof openSchedulePopover==='function')openSchedulePopover({mode:'pick',anchorEl:anchor,header:'Add “'+task.title+'” to itinerary',actionLabel:'Add',onPick:async date=>{
      try{
        // A task without a date needs an assignment, not a move from another day.
        // The pool placement preserves its whole tree without requiring a time.
        const options=task.raw.date?{fromDate:task.raw.date}:{placement:{kind:'pool_date'}};
        await window.blockStore.rescheduleBlock(task.id,date,options);
        notify('Added to itinerary');setTimeout(refresh,100);
      }catch(error){notify(error.message||'Could not schedule task','error');}
    }});
  }

  const open = () => window.openTaskQueue("all-tasks");
  window.DCCTaskLibrary = {refresh, glassesCollections, open, show};
  document.getElementById("all-tasks-pill-nav")?.addEventListener("click",open);
  document.getElementById("someday-pill-nav")?.addEventListener("click",() => window.openTaskQueue("someday"));
  window.addEventListener("blocks-changed",() => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      if (pending) await pending;
      refresh();
    },80);
  });
  window.addEventListener("dcc:data-ready",refresh);
  document.addEventListener("DOMContentLoaded",refresh);
})();
