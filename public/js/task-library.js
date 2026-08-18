(function(){
  "use strict";

  const STORAGE_KEY = "dcc.task-library.state.v1";
  const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
  const DEFAULT_COLUMNS = ["select","title","project","schedule","readiness","priority","duration"];
  const BUILTIN_IDS = new Set(["all-open","unscheduled","scheduled","solo","waiting","completed"]);
  const state = {
    activeViewId: "all-open", query: "", filters: [], groupBy: "none",
    sort: { key: "project", dir: "asc" }, columns: DEFAULT_COLUMNS.slice(), density: "comfortable",
    mode: "table", selected: new Set(), matrixRows: null, matrixColumns: null,
  };
  let payload = null;
  let loading = false;
  let lastTrigger = null;

  function esc(value){
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[ch]);
  }
  function text(value){ return String(value == null ? "" : value).trim(); }
  function props(row){ return row && row.properties || {}; }
  function done(row){ const p=props(row); return p.status==="done" || p.done===true || !!p.completedAt; }
  function taskTitle(row){ const p=props(row); return p.title || p.text || "Untitled task"; }
  function projectName(id){
    if(!id) return "Solo";
    const project=(payload&&payload.projects||[]).find(row=>row.id===id);
    return project ? (props(project).name || props(project).title || "Project") : "Unknown project";
  }
  function facetName(id){ const facet=(payload&&payload.facets||[]).find(row=>row.id===id); return facet ? props(facet).name : id; }
  function facetValue(facetId,valueId){
    const facet=(payload&&payload.facets||[]).find(row=>row.id===facetId);
    const value=facet && (props(facet).values||[]).find(item=>item.id===valueId);
    return value ? value.name : valueId;
  }
  function facetColor(facetId,valueId){
    const facet=(payload&&payload.facets||[]).find(row=>row.id===facetId);
    const value=facet && (props(facet).values||[]).find(item=>item.id===valueId);
    return value && value.color || "#0075EB";
  }
  function activeFacets(){
    return (payload&&payload.facets||[]).filter(row=>{
      const p=props(row); return !p.archived && (p.scope!=="project" || !stateProjectId() || p.projectId===stateProjectId());
    });
  }
  function stateProjectId(){
    const projectFilter=state.filters.find(filter=>filter.key==="project");
    return projectFilter && projectFilter.value && projectFilter.value.length===1 && projectFilter.value[0]!=="solo" ? projectFilter.value[0] : null;
  }
  function api(url,options){
    return fetch(url,{headers:{"Content-Type":"application/json"},...(options||{})}).then(async response=>{
      const body=await response.json().catch(()=>({}));
      if(!response.ok) throw new Error(body.error||`Request failed (${response.status})`);
      return body;
    });
  }
  function notify(message,kind){ if(typeof showToast==="function") showToast(message,kind||"success"); }

  function serializeState(){
    return { activeViewId:state.activeViewId,query:state.query,filters:state.filters,groupBy:state.groupBy,
      sort:state.sort,columns:state.columns,density:state.density,mode:state.mode,matrixRows:state.matrixRows,matrixColumns:state.matrixColumns };
  }
  function persist(){
    const data=serializeState();
    try{localStorage.setItem(STORAGE_KEY,JSON.stringify(data));}catch(_){ }
    try{
      const url=new URL(location.href);
      url.searchParams.set("tl",btoa(unescape(encodeURIComponent(JSON.stringify(data)))));
      history.replaceState(null,"",url.pathname+url.search+url.hash);
    }catch(_){ }
  }
  function restore(){
    let saved=null;
    try{
      const encoded=new URL(location.href).searchParams.get("tl");
      if(encoded) saved=JSON.parse(decodeURIComponent(escape(atob(encoded))));
    }catch(_){ }
    if(!saved){try{saved=JSON.parse(localStorage.getItem(STORAGE_KEY)||"null");}catch(_){}}
    if(!saved)return;
    Object.assign(state,saved);
    state.filters=Array.isArray(saved.filters)?saved.filters:[];
    state.columns=Array.isArray(saved.columns)?saved.columns:DEFAULT_COLUMNS.slice();
    state.selected=new Set();
  }

  function inferSchema(rows){
    const system=[
      {key:"title",label:"Task",kind:"text"},
      {key:"project",label:"Project",kind:"enum",values:[{id:"solo",name:"Solo"}].concat((payload.projects||[]).filter(row=>props(row).status!=="archived").map(row=>({id:row.id,name:props(row).name})))},
      {key:"schedule",label:"Schedule",kind:"enum",values:[{id:"scheduled",name:"Scheduled"},{id:"unscheduled",name:"Unscheduled"}]},
      {key:"status",label:"Status",kind:"enum",values:[{id:"open",name:"Open"},{id:"waiting",name:"Waiting"},{id:"done",name:"Completed"}]},
      {key:"readiness",label:"Readiness",kind:"enum",values:[{id:"ready",name:"Ready"},{id:"blocked",name:"Blocked"}]},
      {key:"priority",label:"Priority",kind:"enum",values:[{id:"High",name:"High"},{id:"Medium",name:"Medium"},{id:"Low",name:"Low"}]},
      {key:"duration",label:"Duration",kind:"number"},
      {key:"createdAt",label:"Created",kind:"date"},
      {key:"date",label:"Scheduled date",kind:"date"},
      {key:"completedAt",label:"Completed date",kind:"date"},
    ];
    const facets=(payload.facets||[]).filter(row=>!props(row).archived).map(row=>({
      key:"facet:"+row.id,label:props(row).name,kind:"enum",facetId:row.id,cardinality:props(row).cardinality,
      values:(props(row).values||[]).filter(value=>!value.archived).map(value=>({id:value.id,name:value.name,color:value.color})),
    }));
    return system.concat(facets).map(field=>{
      if(field.kind!=="enum")return field;
      const counts={};
      rows.forEach(row=>{
        const values=Array.isArray(row[field.key])?row[field.key]:[row[field.key]];
        values.filter(Boolean).forEach(value=>counts[value]=(counts[value]||0)+1);
      });
      return {...field,values:(field.values||[]).map(value=>({...value,count:counts[value.id]||0}))};
    });
  }

  function flattenTask(row){
    const p=props(row), readiness=(payload.readiness&&payload.readiness[row.id])||{state:"ready",total:0,satisfied:0,blockers:[]};
    const item={
      id:row.id,raw:row,title:taskTitle(row),project:p.projectId||"solo",schedule:row.date?"scheduled":"unscheduled",
      status:done(row)?"done":(readiness.state==="blocked"?"waiting":"open"),readiness:readiness.state,
      priority:p.priority||"Medium",duration:Number(p.duration||p.durMin||30),createdAt:(row.created_at||p.createdAt||"").slice(0,10),
      date:row.date||null,completedAt:p.completedAt?String(p.completedAt).slice(0,10):null,
      projectOrder:Number.isFinite(Number(p.projectOrder))?Number(p.projectOrder):Number(row.sort_order||0),
      detail:p.detail||"",facetValues:p.facetValues||{},blockers:readiness.blockers||[],dependencyTotal:readiness.total||0,
      dependencySatisfied:readiness.satisfied||0,projectRole:p.projectRole||"leaf",
    };
    (payload.facets||[]).forEach(facet=>{item["facet:"+facet.id]=(item.facetValues[facet.id]||[]).map(String);});
    return item;
  }

  function currentView(){
    const builtin=(payload&&payload.builtinViews||[]).find(view=>view.id===state.activeViewId);
    if(builtin)return builtin;
    const saved=(payload&&payload.views||[]).find(row=>row.id===state.activeViewId);
    return saved ? {id:saved.id,name:props(saved).name,...props(saved)} : null;
  }
  function baseScope(item){
    const view=currentView();
    const scope=(view&&((view.query&&view.query.scope)||view.scope))||"open";
    if(scope==="open"&&item.status==="done")return false;
    if(scope==="completed"&&item.status!=="done")return false;
    const q=view&&view.query||{};
    if(q.scheduled==="yes"&&item.schedule!=="scheduled")return false;
    if(q.scheduled==="no"&&item.schedule!=="unscheduled")return false;
    if(q.projectId&&item.project!==q.projectId)return false;
    if(q.readiness&&item.readiness!==q.readiness)return false;
    return true;
  }
  function rollingRange(value){
    const today=new Date(); today.setHours(0,0,0,0); let from=new Date(today),to=new Date(today);
    const day=86400000;
    if(value.kind==="last_n_days")from=new Date(today-(Math.max(1,Number(value.n)||1)-1)*day);
    else if(value.kind==="this_week"){const dow=(today.getDay()+6)%7;from=new Date(today-dow*day);}
    else if(value.kind==="last_week"){const dow=(today.getDay()+6)%7;to=new Date(today-(dow+1)*day);from=new Date(to-6*day);}
    else if(value.kind==="this_month")from=new Date(today.getFullYear(),today.getMonth(),1);
    else if(value.kind==="last_month"){from=new Date(today.getFullYear(),today.getMonth()-1,1);to=new Date(today.getFullYear(),today.getMonth(),0);}
    else if(value.kind==="ytd")from=new Date(today.getFullYear(),0,1);
    else if(value.kind==="custom"){from=new Date(value.from+"T00:00:00");to=new Date(value.to+"T00:00:00");}
    return {from,to};
  }
  function matchesFilter(item,filter){
    const value=item[filter.key];
    if(filter.op==="contains")return text(value).toLowerCase().includes(text(filter.value).toLowerCase());
    if(filter.op==="in"||filter.op==="all"){
      const actual=Array.isArray(value)?value:[value]; const expected=filter.value||[];
      return filter.op==="all"?expected.every(v=>actual.includes(v)):expected.some(v=>actual.includes(v));
    }
    if(filter.op==="min")return Number(value)>=Number(filter.value);
    if(filter.op==="max")return Number(value)<=Number(filter.value);
    if(!value)return false;
    const actual=new Date(String(value).slice(0,10)+"T00:00:00");
    if(filter.op==="after")return actual>new Date(filter.value+"T00:00:00");
    if(filter.op==="before")return actual<new Date(filter.value+"T00:00:00");
    if(filter.op==="between")return actual>=new Date(filter.value.from+"T00:00:00")&&actual<=new Date(filter.value.to+"T00:00:00");
    if(filter.op==="rolling"){const range=rollingRange(filter.value||{});return actual>=range.from&&actual<=range.to;}
    return true;
  }
  function filteredRows(){
    let rows=(payload&&payload.tasks||[]).map(flattenTask).filter(baseScope);
    const query=state.query.trim().toLowerCase();
    if(query)rows=rows.filter(item=>{
      const facetText=Object.entries(item.facetValues).flatMap(([facetId,ids])=>[facetName(facetId),...ids.map(id=>facetValue(facetId,id))]).join(" ");
      return [item.title,item.detail,projectName(item.project==="solo"?null:item.project),item.priority,facetText].join(" ").toLowerCase().includes(query);
    });
    rows=rows.filter(item=>state.filters.every(filter=>matchesFilter(item,filter)));
    const key=state.sort&&state.sort.key||"title",dir=state.sort&&state.sort.dir==="desc"?-1:1;
    return rows.sort((a,b)=>{
      let av=a[key],bv=b[key];
      if(key==="project"){av=projectName(av==="solo"?null:av);bv=projectName(bv==="solo"?null:bv);}
      if(Array.isArray(av))av=av.map(v=>key.startsWith("facet:")?facetValue(key.slice(6),v):v).join(", ");
      if(Array.isArray(bv))bv=bv.map(v=>key.startsWith("facet:")?facetValue(key.slice(6),v):v).join(", ");
      if(av==null&&bv==null)return 0;if(av==null)return 1;if(bv==null)return-1;
      if(typeof av==="number"&&typeof bv==="number")return(av-bv)*dir;
      return String(av).localeCompare(String(bv),undefined,{numeric:true,sensitivity:"base"})*dir;
    });
  }

  function formatDate(value){ if(!value)return "—";const d=new Date(String(value).slice(0,10)+"T12:00:00");return d.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}); }
  function fieldByKey(key){return inferSchema((payload.tasks||[]).map(flattenTask)).find(field=>field.key===key);}
  function fieldLabel(key){const field=fieldByKey(key);return field?field.label:key;}
  function formatFilter(filter){
    const label=fieldLabel(filter.key);
    if(filter.op==="contains")return `${label} contains “${filter.value}”`;
    if(filter.op==="in"||filter.op==="all"){
      const field=fieldByKey(filter.key);const names=(filter.value||[]).map(id=>{const value=field&&field.values&&field.values.find(v=>v.id===id);return value?value.name:id;});
      return `${label} ${filter.op==="all"?"has all":"is"} ${names.length>2?names.length+" values":names.join(", ")}`;
    }
    if(filter.op==="min")return `${label} ≥ ${filter.value}`;
    if(filter.op==="max")return `${label} ≤ ${filter.value}`;
    if(filter.op==="between")return `${label} ${filter.value.from} to ${filter.value.to}`;
    if(filter.op==="rolling")return `${label} ${String(filter.value.kind||"").replace(/_/g," ")}`;
    return `${label} ${filter.op} ${filter.value}`;
  }

  function projectChips(rows){
    const counts={solo:0};rows.forEach(item=>counts[item.project]=(counts[item.project]||0)+1);
    const current=state.filters.find(filter=>filter.key==="project");const selected=current&&current.value&&current.value[0];
    const projects=(payload.projects||[]).filter(row=>props(row).status!=="archived");
    return '<div class="tlb-project-strip"><span class="tlb-strip-label">Projects</span>'+
      projects.map(project=>'<button class="tlb-project-chip '+(selected===project.id?'active':'')+'" data-project-filter="'+esc(project.id)+'"><i style="background:'+esc(props(project).color||'#0075EB')+'"></i>'+esc(props(project).name)+' <b>'+String(counts[project.id]||0)+'</b></button>').join('')+
      '<button class="tlb-project-chip '+(selected==='solo'?'active':'')+'" data-project-filter="solo"><i class="solo"></i>Solo <b>'+String(counts.solo||0)+'</b></button></div>';
  }

  function viewTabs(){
    const builtins=(payload.builtinViews||[]);const saved=(payload.views||[]).map(row=>({id:row.id,name:props(row).name}));
    return '<div class="tlb-view-tabs" role="tablist" aria-label="Task views">'+builtins.concat(saved).map(view=>
      '<button type="button" class="tlb-view-tab '+(state.activeViewId===view.id?'active':'')+'" data-view-id="'+esc(view.id)+'">'+esc(view.name)+'</button>').join('')+'</div>';
  }

  function toolbar(schema,rows){
    const filters=state.filters.map((filter,index)=>'<span class="tlb-filter-chip"><button data-edit-filter="'+index+'">'+esc(formatFilter(filter))+'</button><button data-remove-filter="'+index+'" aria-label="Remove filter">×</button></span>').join('');
    const groupOptions=[{key:"none",label:"No grouping"},{key:"project",label:"Project"},{key:"status",label:"Status"},{key:"schedule",label:"Schedule"}].concat(schema.filter(field=>field.facetId).map(field=>({key:field.key,label:field.label})));
    return '<div class="tlb-toolbar">'+
      '<label class="tlb-search"><span aria-hidden="true">⌕</span><input id="tlb-search" type="search" value="'+esc(state.query)+'" placeholder="Search every task and category…" aria-label="Search task library"></label>'+
      '<div class="tlb-filter-bar">'+filters+'<button class="tlb-add-filter" id="tlb-add-filter">+ Filter</button></div>'+
      '<label class="tlb-compact-select">Group <select id="tlb-group">'+groupOptions.map(option=>'<option value="'+esc(option.key)+'"'+(state.groupBy===option.key?' selected':'')+'>'+esc(option.label)+'</option>').join('')+'</select></label>'+
      '<button class="tlb-tool-btn" id="tlb-columns">Columns</button><button class="tlb-tool-btn" id="tlb-save-view">Save view</button>'+
      '<span class="tlb-row-count">'+rows.length+' task'+(rows.length===1?'':'s')+'</span></div>';
  }

  function cell(item,key){
    if(key==="select")return '<input type="checkbox" class="tlb-row-select" data-task-id="'+esc(item.id)+'"'+(state.selected.has(item.id)?' checked':'')+' aria-label="Select '+esc(item.title)+'">';
    if(key==="title")return '<button class="tlb-title-btn" data-edit-task="'+esc(item.id)+'">'+esc(item.title)+'</button>'+(item.projectRole==='parent'?'<span class="tlb-parent-pill">Parent</span>':'');
    if(key==="project")return '<button class="tlb-data-chip" data-project-filter="'+esc(item.project)+'">'+esc(projectName(item.project==='solo'?null:item.project))+'</button>';
    if(key==="schedule")return item.date?'<button class="tlb-date-btn" data-schedule-task="'+esc(item.id)+'">'+esc(formatDate(item.date))+'</button>':'<span class="tlb-muted">Unscheduled</span>';
    if(key==="readiness")return item.readiness==='blocked'?'<span class="tlb-status warning" title="'+esc(item.blockers.map(blocker=>blocker.title).join(', '))+'">Blocked '+item.dependencySatisfied+'/'+item.dependencyTotal+'</span>':'<span class="tlb-status ready">Ready</span>';
    if(key==="status")return '<span class="tlb-status '+(item.status==='done'?'done':item.status==='waiting'?'warning':'open')+'">'+esc(item.status)+'</span>';
    if(key==="priority")return '<span class="tlb-priority '+esc(item.priority.toLowerCase())+'">'+esc(item.priority)+'</span>';
    if(key==="duration")return esc(item.duration+'m');
    if(["createdAt","date","completedAt"].includes(key))return esc(formatDate(item[key]));
    if(key.startsWith("facet:")){
      const facetId=key.slice(6),values=item[key]||[];
      return values.length?values.map(id=>'<button class="tlb-data-chip facet" data-facet-filter="'+esc(facetId)+'" data-value-filter="'+esc(id)+'" style="--chip:'+esc(facetColor(facetId,id))+'">'+esc(facetValue(facetId,id))+'</button>').join(' '):'<span class="tlb-muted">—</span>';
    }
    return esc(item[key]||"—");
  }

  function table(rows,schema){
    const validKeys=new Set(["select",...schema.map(field=>field.key)]);
    state.columns=state.columns.filter(key=>validKeys.has(key));
    schema.forEach(field=>{if(!state.columns.includes(field.key)&&field.facetId&&state.columns.length<9)state.columns.push(field.key);});
    if(!state.columns.includes("select"))state.columns.unshift("select");
    const cols=state.columns;
    const head='<thead><tr>'+cols.map(key=>key==='select'?'<th class="tlb-select-col"><input type="checkbox" id="tlb-select-all" aria-label="Select all visible tasks"></th>':'<th draggable="true" data-column="'+esc(key)+'" class="'+(state.sort.key===key?'sorted':'')+'"><button data-sort="'+esc(key)+'">'+esc(fieldLabel(key))+' <span>'+((state.sort.key===key)?(state.sort.dir==='asc'?'▲':'▼'):'↕')+'</span></button></th>').join('')+'<th class="tlb-actions-col">Actions</th></tr></thead>';
    const groups=new Map();
    if(state.groupBy==='none')groups.set('',rows);
    else rows.forEach(item=>{
      let values=item[state.groupBy];if(state.groupBy==='project')values=[item.project];else if(!Array.isArray(values))values=[values||'unassigned'];
      values.forEach(value=>{const key=String(value||'unassigned');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);});
    });
    let body='';
    groups.forEach((items,key)=>{
      if(state.groupBy!=='none'){
        let label=key==='unassigned'?'Unassigned':key;
        if(state.groupBy==='project')label=projectName(key==='solo'?null:key);
        if(state.groupBy.startsWith('facet:'))label=facetValue(state.groupBy.slice(6),key);
        body+='<tr class="tlb-group-row"><td colspan="'+(cols.length+1)+'"><span>'+esc(label)+'</span><b>'+items.length+'</b></td></tr>';
      }
      body+=items.map(item=>'<tr data-task-row="'+esc(item.id)+'" class="'+(state.selected.has(item.id)?'selected ':'')+(item.status==='done'?'completed':'')+'">'+cols.map(key=>'<td data-field="'+esc(key)+'">'+cell(item,key)+'</td>').join('')+
        '<td class="tlb-row-actions"><button data-schedule-task="'+esc(item.id)+'">'+(item.date?'Move':'Itinerary')+'</button><button data-edit-task="'+esc(item.id)+'">Edit</button></td></tr>').join('');
    });
    if(!rows.length)body='<tr><td class="tlb-empty" colspan="'+(cols.length+1)+'"><strong>No tasks match this view.</strong><span>Clear filters or add a task in the current context.</span></td></tr>';
    return '<div class="tlb-table-scroll"><table class="tlb-table '+(state.density==='compact'?'compact':'')+'">'+head+'<tbody>'+body+'</tbody></table></div>';
  }

  function matrix(rows,schema){
    const facets=schema.filter(field=>field.facetId&&field.cardinality==='single');
    if(facets.length<2)return '<div class="tlb-empty-card"><strong>Matrix needs two single-select categories.</strong><span>Create categories such as Area and Workstream, then assign them to tasks.</span></div>';
    const rowField=facets.find(field=>field.key===state.matrixRows)||facets[0];
    const colField=facets.find(field=>field.key===state.matrixColumns&&field.key!==rowField.key)||facets.find(field=>field.key!==rowField.key);
    state.matrixRows=rowField.key;state.matrixColumns=colField.key;
    const rowValues=rowField.values.filter(value=>rows.some(item=>(item[rowField.key]||[]).includes(value.id)));
    const colValues=colField.values.filter(value=>rows.some(item=>(item[colField.key]||[]).includes(value.id)));
    return '<div class="tlb-matrix-tools"><label>Rows <select id="tlb-matrix-rows">'+facets.map(field=>'<option value="'+esc(field.key)+'"'+(field.key===rowField.key?' selected':'')+'>'+esc(field.label)+'</option>').join('')+'</select></label><label>Columns <select id="tlb-matrix-cols">'+facets.map(field=>'<option value="'+esc(field.key)+'"'+(field.key===colField.key?' selected':'')+'>'+esc(field.label)+'</option>').join('')+'</select></label></div>'+
      '<div class="tlb-table-scroll"><table class="tlb-matrix"><thead><tr><th>'+esc(rowField.label)+' × '+esc(colField.label)+'</th>'+colValues.map(value=>'<th>'+esc(value.name)+'</th>').join('')+'</tr></thead><tbody>'+rowValues.map(rowValue=>'<tr><th>'+esc(rowValue.name)+'</th>'+colValues.map(colValue=>{const matching=rows.filter(item=>(item[rowField.key]||[]).includes(rowValue.id)&&(item[colField.key]||[]).includes(colValue.id));return '<td><button data-matrix-cell="'+esc(rowField.key)+'|'+esc(rowValue.id)+'|'+esc(colField.key)+'|'+esc(colValue.id)+'"><b>'+matching.length+'</b><span>'+matching.filter(item=>item.status==='done').length+' done</span></button></td>';}).join('')+'</tr>').join('')+'</tbody></table></div>';
  }

  function summary(rows){
    const open=rows.filter(item=>item.status!=='done'),ready=open.filter(item=>item.readiness==='ready'&&!item.date),blocked=open.filter(item=>item.readiness==='blocked'),scheduled=open.filter(item=>!!item.date),completed=rows.filter(item=>item.status==='done');
    return '<div class="tlb-summary"><div><span>Open</span><b>'+open.length+'</b></div><div class="ready"><span>Ready now</span><b>'+ready.length+'</b></div><div class="warning"><span>Blocked</span><b>'+blocked.length+'</b></div><div><span>Scheduled</span><b>'+scheduled.length+'</b></div><div class="done"><span>Completed</span><b>'+completed.length+'</b></div></div>';
  }

  function render(){
    const root=document.getElementById("task-library-root");if(!root)return;
    if(loading&&!payload){root.innerHTML='<div class="task-library-loading">Loading your task library…</div>';return;}
    if(!payload){root.innerHTML='<div class="tlb-error">Task Library could not load. <button id="tlb-retry">Try again</button></div>';root.querySelector('#tlb-retry').onclick=refresh;return;}
    const all=(payload.tasks||[]).map(flattenTask),rows=filteredRows(),schema=inferSchema(all);
    const badge=document.getElementById("task-library-count");if(badge){badge.textContent=all.filter(item=>item.status!=='done').length;badge.style.display='';}
    root.innerHTML='<div class="task-library-shell">'+
      '<div class="tlb-head"><div><h2>Task Library</h2><p>Every task, organized your way. Unassigned work lives in Solo.</p></div><div class="tlb-head-actions">'+
      '<button class="tlb-btn secondary" id="tlb-import">Import</button><button class="tlb-btn secondary" id="tlb-manage-facets">Categories</button><button class="tlb-btn secondary" id="tlb-manage-projects">Projects</button><button class="tlb-btn primary" id="tlb-add-task">+ Task</button></div></div>'+
      summary(all)+viewTabs()+projectChips(all)+toolbar(schema,rows)+
      '<div class="tlb-mode-row"><button class="'+(state.mode==='table'?'active':'')+'" data-mode="table">Table</button><button class="'+(state.mode==='matrix'?'active':'')+'" data-mode="matrix">Matrix</button>'+
      (stateProjectId()?'<button class="tlb-continue" id="tlb-continue">Continue '+esc(projectName(stateProjectId()))+'</button>':'')+
      '<div class="tlb-bulk" '+(state.selected.size?'':'hidden')+'><b>'+state.selected.size+' selected</b><button id="tlb-bulk-project">Change project</button><button id="tlb-bulk-schedule">Add to itinerary</button><button id="tlb-clear-selection">Clear</button></div></div>'+
      (state.mode==='matrix'?matrix(rows,schema):table(rows,schema))+'</div>';
    bind(schema,rows);
    persist();
  }

  async function refresh(){
    if(loading)return;loading=true;render();
    try{payload=await api('/api/task-library');reconcile();}
    catch(error){console.error('[task-library]',error);notify(error.message,'error');}
    finally{loading=false;render();}
  }
  function reconcile(){
    const schema=inferSchema((payload.tasks||[]).map(flattenTask));const valid=new Set(schema.map(field=>field.key));
    state.filters=state.filters.filter(filter=>valid.has(filter.key));
    state.columns=state.columns.filter(key=>key==='select'||valid.has(key));
    if(!currentView())state.activeViewId='all-open';
  }

  function activateView(id){
    state.activeViewId=id;state.selected.clear();
    const builtin=(payload.builtinViews||[]).find(view=>view.id===id);
    if(builtin){state.filters=[];state.query='';state.groupBy='none';state.sort=builtin.sort||{key:'title',dir:'asc'};state.mode='table';}
    else{
      const view=(payload.views||[]).find(row=>row.id===id);const p=props(view);
      state.filters=Array.isArray(p.filters)?p.filters:[];state.query=p.query||'';state.groupBy=p.groupBy||'none';state.sort=p.sort||{key:'title',dir:'asc'};state.columns=Array.isArray(p.columns)&&p.columns.length?p.columns:DEFAULT_COLUMNS.slice();state.density=p.density||'comfortable';
    }
    render();
  }

  function setProjectFilter(projectId){
    state.filters=state.filters.filter(filter=>filter.key!=='project');
    state.filters.push({key:'project',op:'in',value:[projectId]});state.activeViewId='all-open';render();
  }
  function setFacetFilter(facetId,valueId){
    state.filters=state.filters.filter(filter=>filter.key!=='facet:'+facetId);
    state.filters.push({key:'facet:'+facetId,op:'in',value:[valueId]});state.activeViewId='all-open';render();
  }

  function popup(anchor,html,className){
    document.querySelectorAll('.tlb-popover,.tlb-overlay').forEach(node=>node.remove());
    const backdrop=document.createElement('div');backdrop.className='tlb-popover-backdrop';document.body.appendChild(backdrop);
    const pop=document.createElement('div');pop.className='tlb-popover '+(className||'');pop.innerHTML=html;document.body.appendChild(pop);
    const rect=anchor.getBoundingClientRect();const left=Math.min(rect.left,window.innerWidth-pop.offsetWidth-12);
    pop.style.left=Math.max(12,left)+'px';pop.style.top=Math.min(rect.bottom+6,window.innerHeight-pop.offsetHeight-12)+'px';
    const close=()=>{pop.remove();backdrop.remove();};backdrop.onclick=close;pop.querySelectorAll('[data-pop-close]').forEach(button=>button.onclick=close);
    return {pop,close};
  }
  function modal(title,body,options){
    lastTrigger=document.activeElement;
    const overlay=document.createElement('div');overlay.className='tlb-overlay open';overlay.innerHTML='<div class="tlb-modal '+((options&&options.wide)?'wide':'')+'" role="dialog" aria-modal="true" aria-label="'+esc(title)+'"><div class="tlb-modal-head"><div><h3>'+esc(title)+'</h3>'+(options&&options.subtitle?'<p>'+esc(options.subtitle)+'</p>':'')+'</div><button data-modal-close aria-label="Close">×</button></div><div class="tlb-modal-body">'+body+'</div></div>';
    document.body.appendChild(overlay);const close=()=>{overlay.remove();if(lastTrigger&&lastTrigger.focus)lastTrigger.focus();};overlay.querySelector('[data-modal-close]').onclick=close;overlay.addEventListener('click',event=>{if(event.target===overlay)close();});document.addEventListener('keydown',function escapeModal(event){if(event.key==='Escape'&&document.body.contains(overlay)){close();document.removeEventListener('keydown',escapeModal);}});setTimeout(()=>overlay.querySelector('input,textarea,select,button')?.focus(),0);return {overlay,close};
  }

  function openFilterPicker(anchor,editIndex){
    const schema=inferSchema((payload.tasks||[]).map(flattenTask));
    if(editIndex!=null){openFilterEditor(anchor,schema.find(field=>field.key===state.filters[editIndex].key),editIndex);return;}
    const mounted=popup(anchor,'<div class="tlb-pop-title">Filter by</div><input class="tlb-pop-search" placeholder="Search fields…"><div class="tlb-pop-list">'+schema.map(field=>'<button data-field="'+esc(field.key)+'"><span>'+esc(field.label)+'</span><em>'+esc(field.kind)+'</em></button>').join('')+'</div>');
    const input=mounted.pop.querySelector('input');const draw=()=>mounted.pop.querySelectorAll('[data-field]').forEach(button=>button.hidden=!button.textContent.toLowerCase().includes(input.value.toLowerCase()));input.oninput=draw;input.focus();mounted.pop.querySelectorAll('[data-field]').forEach(button=>button.onclick=()=>{const field=schema.find(item=>item.key===button.dataset.field);mounted.close();openFilterEditor(anchor,field,null);});
  }
  function openFilterEditor(anchor,field,editIndex){
    const existing=editIndex!=null?state.filters[editIndex]:null;let html='';
    if(field.kind==='enum')html='<div class="tlb-pop-title">'+esc(field.label)+'</div>'+(field.cardinality==='multi'?'<select id="tlb-filter-op"><option value="in">Any selected</option><option value="all">All selected</option></select>':'')+'<div class="tlb-filter-options">'+(field.values||[]).map(value=>'<label><input type="checkbox" value="'+esc(value.id)+'"'+(existing&&existing.value&&existing.value.includes(value.id)?' checked':'')+'><span>'+esc(value.name)+'</span><b>'+String(value.count||0)+'</b></label>').join('')+'</div>';
    else if(field.kind==='number')html='<div class="tlb-pop-title">'+esc(field.label)+'</div><select id="tlb-filter-op"><option value="min">At least</option><option value="max">At most</option></select><input id="tlb-filter-number" type="number" value="'+esc(existing&&existing.value||'')+'">';
    else if(field.kind==='date')html='<div class="tlb-pop-title">'+esc(field.label)+'</div><select id="tlb-filter-op"><option value="between">Between</option><option value="after">After</option><option value="before">Before</option><option value="rolling">Rolling</option></select><div id="tlb-date-fields"></div>';
    else html='<div class="tlb-pop-title">'+esc(field.label)+'</div><input id="tlb-filter-text" value="'+esc(existing&&existing.value||'')+'" placeholder="Contains…">';
    html+='<div class="tlb-pop-actions"><button data-pop-close>Cancel</button><button class="primary" id="tlb-filter-apply">Apply</button></div>';
    const mounted=popup(anchor,html,'editor');const pop=mounted.pop;
    if(existing&&pop.querySelector('#tlb-filter-op'))pop.querySelector('#tlb-filter-op').value=existing.op;
    const drawDates=()=>{const op=pop.querySelector('#tlb-filter-op').value;const current=existing&&existing.op===op?existing.value:null;pop.querySelector('#tlb-date-fields').innerHTML=op==='between'?'<label>From<input id="tlb-date-from" type="date" value="'+esc(current&&current.from||'')+'"></label><label>To<input id="tlb-date-to" type="date" value="'+esc(current&&current.to||'')+'"></label>':op==='rolling'?'<select id="tlb-rolling"><option value="today">Today</option><option value="this_week">This week</option><option value="last_week">Last week</option><option value="this_month">This month</option><option value="last_month">Last month</option><option value="ytd">Year to date</option><option value="last_n_days">Last N days</option></select><input id="tlb-last-n" type="number" min="1" placeholder="Number of days">':'<input id="tlb-date-one" type="date" value="'+esc(typeof current==='string'?current:'')+'">';};
    if(field.kind==='date'){drawDates();pop.querySelector('#tlb-filter-op').onchange=drawDates;}
    pop.querySelector('#tlb-filter-apply').onclick=()=>{
      let filter=null;
      if(field.kind==='enum'){const values=[...pop.querySelectorAll('input:checked')].map(input=>input.value);if(values.length)filter={key:field.key,op:pop.querySelector('#tlb-filter-op')?.value||'in',value:values};}
      else if(field.kind==='number'){const value=pop.querySelector('#tlb-filter-number').value;if(value!=='')filter={key:field.key,op:pop.querySelector('#tlb-filter-op').value,value};}
      else if(field.kind==='date'){const op=pop.querySelector('#tlb-filter-op').value;if(op==='between'){const from=pop.querySelector('#tlb-date-from').value,to=pop.querySelector('#tlb-date-to').value;if(from&&to)filter={key:field.key,op,value:{from,to}};}else if(op==='rolling'){const kind=pop.querySelector('#tlb-rolling').value,n=pop.querySelector('#tlb-last-n').value;if(kind!=='last_n_days'||n)filter={key:field.key,op,value:{kind,n:Number(n)||null}};}else{const value=pop.querySelector('#tlb-date-one').value;if(value)filter={key:field.key,op,value};}}
      else{const value=pop.querySelector('#tlb-filter-text').value.trim();if(value)filter={key:field.key,op:'contains',value};}
      if(filter){if(editIndex!=null)state.filters[editIndex]=filter;else state.filters.push(filter);}mounted.close();render();
    };
  }

  function openColumns(anchor,schema){
    const all=['select',...schema.map(field=>field.key)];const mounted=popup(anchor,'<div class="tlb-pop-title">Columns</div><div class="tlb-column-list">'+all.map(key=>'<label draggable="true" data-col-row="'+esc(key)+'"><span>⠿</span><input type="checkbox" value="'+esc(key)+'"'+(state.columns.includes(key)?' checked':'')+'><b>'+esc(key==='select'?'Select':fieldLabel(key))+'</b></label>').join('')+'</div><div class="tlb-pop-actions"><button id="tlb-columns-reset">Reset</button><button class="primary" data-pop-close>Done</button></div>');
    mounted.pop.querySelectorAll('input').forEach(input=>input.onchange=()=>{if(input.checked&&!state.columns.includes(input.value))state.columns.push(input.value);if(!input.checked)state.columns=state.columns.filter(key=>key!==input.value);render();});
    mounted.pop.querySelector('#tlb-columns-reset').onclick=()=>{state.columns=DEFAULT_COLUMNS.slice();mounted.close();render();};
    let dragged=null;mounted.pop.querySelectorAll('[data-col-row]').forEach(row=>{row.ondragstart=()=>dragged=row.dataset.colRow;row.ondragover=event=>event.preventDefault();row.ondrop=event=>{event.preventDefault();const target=row.dataset.colRow;const from=state.columns.indexOf(dragged),to=state.columns.indexOf(target);if(from>=0&&to>=0){state.columns.splice(to,0,state.columns.splice(from,1)[0]);mounted.close();render();}};});
  }

  function saveView(){
    const current=currentView();const saved=current&&!BUILTIN_IDS.has(current.id)?current:null;
    const m=modal(saved?'Update saved view':'Save this view','<label class="tlb-field"><span>Name</span><input id="tlb-view-name" value="'+esc(saved&&saved.name||'')+'" placeholder="e.g. Renovation purchases"></label><label class="tlb-check"><input id="tlb-save-query" type="checkbox"'+(state.query?' checked':'')+'> Include the current search query</label><div class="tlb-modal-actions"><button data-cancel>Cancel</button><button class="primary" id="tlb-view-save">'+(saved?'Update view':'Save view')+'</button></div>');
    m.overlay.querySelector('[data-cancel]').onclick=m.close;m.overlay.querySelector('#tlb-view-save').onclick=async()=>{const name=m.overlay.querySelector('#tlb-view-name').value.trim();if(!name)return;const body={name,filters:state.filters,groupBy:state.groupBy,sort:state.sort,columns:state.columns,query:m.overlay.querySelector('#tlb-save-query').checked?state.query:'',density:state.density,scope:(current&&current.query&&current.query.scope)||current&&current.scope||'open'};try{const view=await api(saved?'/api/task-views/'+saved.id:'/api/task-views',{method:saved?'PATCH':'POST',body:JSON.stringify(body)});m.close();await refresh();activateView(view.id);}catch(error){notify(error.message,'error');}};
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
    const body='<form id="tlb-task-form"><label class="tlb-field"><span>Task</span><input id="tlb-task-title" required value="'+esc(row?taskTitle(row):'')+'"></label><label class="tlb-field"><span>Project</span><select id="tlb-task-project"><option value="">Solo</option>'+(payload.projects||[]).filter(project=>props(project).status!=='archived').map(project=>'<option value="'+esc(project.id)+'"'+(project.id===projectId?' selected':'')+'>'+esc(props(project).name)+'</option>').join('')+'</select></label><div class="tlb-form-grid"><label class="tlb-field"><span>Priority</span><select id="tlb-task-priority">'+['High','Medium','Low'].map(value=>'<option'+((p.priority||'Medium')===value?' selected':'')+'>'+value+'</option>').join('')+'</select></label><label class="tlb-field"><span>Duration</span><input id="tlb-task-duration" type="number" min="1" max="1440" value="'+esc(p.duration||p.durMin||30)+'"></label></div><label class="tlb-field"><span>Details</span><textarea id="tlb-task-detail">'+esc(p.detail||'')+'</textarea></label><div id="tlb-task-facets">'+facetFields+'</div><div class="tlb-modal-actions">'+(row?'<button type="button" id="tlb-task-dependencies">Dependencies</button>':'')+'<button type="button" data-cancel>Cancel</button><button class="primary" type="submit">Save task</button></div></form>';
    const m=modal(row?'Edit task':'New task',body);m.overlay.querySelector('[data-cancel]').onclick=m.close;
    m.overlay.querySelector('#tlb-task-project').onchange=()=>{const draft={projectId:m.overlay.querySelector('#tlb-task-project').value};m.close();taskEditor(taskId,draft);};
    const dep=m.overlay.querySelector('#tlb-task-dependencies');if(dep)dep.onclick=()=>{m.close();if(typeof openTaskDependencyModal==='function')openTaskDependencyModal(row.id);};
    m.overlay.querySelector('form').onsubmit=async event=>{event.preventDefault();const facetValues={};m.overlay.querySelectorAll('[data-facet]').forEach(input=>{if((input.type==='checkbox'&&!input.checked)||!input.value)return;(facetValues[input.dataset.facet]||(facetValues[input.dataset.facet]=[])).push(input.value);});const body={title:m.overlay.querySelector('#tlb-task-title').value,projectId:m.overlay.querySelector('#tlb-task-project').value||null,priority:m.overlay.querySelector('#tlb-task-priority').value,duration:Number(m.overlay.querySelector('#tlb-task-duration').value),detail:m.overlay.querySelector('#tlb-task-detail').value,facetValues};try{await api(row?'/api/task-library/tasks/'+row.id:'/api/task-library/tasks',{method:row?'PATCH':'POST',body:JSON.stringify(body)});m.close();await refresh();notify(row?'Task updated':'Task added');}catch(error){notify(error.message,'error');}};
  }

  function importProject(){
    const body='<div id="tlb-import-source"><label class="tlb-field"><span>Project name</span><input id="tlb-import-name" value="Griffin Renovation"></label><label class="tlb-field"><span>Source document URL</span><input id="tlb-import-url" value="https://docs.google.com/document/d/1waOd00fD29aPRPuC5QIZ5W-DaBECSvfrF2CMAT0HYu8/edit"></label><label class="tlb-field"><span>Paste tasks</span><textarea id="tlb-import-text" class="large" placeholder="Paste the full task document here…"></textarea></label><p class="tlb-note">Preview is read-only. The importer recognizes headings, owners, purchases, decisions, repeated workstreams, and buy-to-install sequences.</p><button class="tlb-btn primary" id="tlb-import-preview">Preview import</button></div><div id="tlb-import-review" hidden></div>';
    const m=modal('Import a project',body,{wide:true,subtitle:'Review every proposed task and category before anything is saved.'});
    m.overlay.querySelector('#tlb-import-preview').onclick=async()=>{const button=m.overlay.querySelector('#tlb-import-preview');button.disabled=true;try{const manifest=await api('/api/projects/import/preview',{method:'POST',body:JSON.stringify({projectName:m.overlay.querySelector('#tlb-import-name').value,sourceUrl:m.overlay.querySelector('#tlb-import-url').value,text:m.overlay.querySelector('#tlb-import-text').value})});m.overlay._manifest=manifest;renderImportReview(m);}catch(error){notify(error.message,'error');}finally{button.disabled=false;}};
  }
  function renderImportReview(m){
    const manifest=m.overlay._manifest,review=m.overlay.querySelector('#tlb-import-review');m.overlay.querySelector('#tlb-import-source').hidden=true;review.hidden=false;review.innerHTML='<div class="tlb-import-summary"><b>'+manifest.items.length+' proposed tasks</b><span>'+manifest.facets.map(f=>f.name+': '+f.values.length).join(' · ')+'</span></div><div class="tlb-import-table"><table><thead><tr><th>Task</th><th>Area</th><th>Workstream</th><th>Type</th><th>Vendor</th><th>Depends on</th></tr></thead><tbody>'+manifest.items.map((item,index)=>'<tr><td><input data-import-title="'+index+'" value="'+esc(item.title)+'"></td><td>'+esc(item.area||'—')+'</td><td>'+esc(item.workstream||'—')+'</td><td>'+esc(item.itemType||'—')+'</td><td>'+esc(item.vendor||'—')+'</td><td>'+esc((item.dependsOn||[]).length?String(item.dependsOn.length):'—')+'</td></tr>').join('')+'</tbody></table></div><div class="tlb-modal-actions"><button id="tlb-import-back">Back</button><button class="primary" id="tlb-import-commit">Create '+esc(manifest.project.name)+'</button></div>';
    review.querySelector('#tlb-import-back').onclick=()=>{review.hidden=true;m.overlay.querySelector('#tlb-import-source').hidden=false;};
    review.querySelector('#tlb-import-commit').onclick=async()=>{review.querySelectorAll('[data-import-title]').forEach(input=>manifest.items[Number(input.dataset.importTitle)].title=input.value.trim());const key='import-'+Date.now()+'-'+Math.random().toString(36).slice(2);try{const result=await api('/api/projects/import/commit',{method:'POST',body:JSON.stringify({manifest,idempotencyKey:key})});m.close();await refresh();setProjectFilter(result.project.id);notify(result.duplicate?'Project was already imported':'Project imported');}catch(error){notify(error.message,'error');}};
  }

  function scheduleTask(task,anchor){
    if(!task||!window.blockStore)return;
    if(typeof openSchedulePopover==='function')openSchedulePopover({mode:'pick',anchorEl:anchor,header:'Add “'+task.title+'” to itinerary',actionLabel:'Add',onPick:async date=>{await window.blockStore.rescheduleBlock(task.id,date,{fromDate:task.raw.date||null});notify('Added to itinerary');setTimeout(refresh,100);}});
  }
  function continueProject(anchor){
    const projectId=stateProjectId();const next=(payload.tasks||[]).map(flattenTask).filter(item=>item.project===projectId&&item.status!=='done'&&item.readiness==='ready'&&!item.date).sort((a,b)=>a.projectOrder-b.projectOrder)[0];
    if(!next){const blocked=(payload.tasks||[]).map(flattenTask).find(item=>item.project===projectId&&item.readiness==='blocked');notify(blocked?'Complete '+(blocked.blockers[0]&&blocked.blockers[0].title||'a prerequisite')+' to unlock more work':'No unscheduled ready tasks in this project','info');return;}scheduleTask(next,anchor);
  }

  function bind(schema,rows){
    document.querySelectorAll('[data-view-id]').forEach(button=>button.onclick=()=>activateView(button.dataset.viewId));
    document.querySelectorAll('[data-project-filter]').forEach(button=>button.onclick=event=>{event.stopPropagation();setProjectFilter(button.dataset.projectFilter);});
    document.querySelectorAll('[data-facet-filter]').forEach(button=>button.onclick=event=>{event.stopPropagation();setFacetFilter(button.dataset.facetFilter,button.dataset.valueFilter);});
    const search=document.getElementById('tlb-search');if(search)search.oninput=()=>{state.query=search.value;state.activeViewId='all-open';render();};
    document.getElementById('tlb-add-filter')?.addEventListener('click',event=>openFilterPicker(event.currentTarget,null));
    document.querySelectorAll('[data-remove-filter]').forEach(button=>button.onclick=()=>{state.filters.splice(Number(button.dataset.removeFilter),1);render();});
    document.querySelectorAll('[data-edit-filter]').forEach(button=>button.onclick=event=>openFilterPicker(event.currentTarget,Number(button.dataset.editFilter)));
    document.getElementById('tlb-group')?.addEventListener('change',event=>{state.groupBy=event.target.value;render();});
    document.getElementById('tlb-columns')?.addEventListener('click',event=>openColumns(event.currentTarget,schema));
    document.getElementById('tlb-save-view')?.addEventListener('click',saveView);
    document.getElementById('tlb-manage-projects')?.addEventListener('click',projectManager);
    document.getElementById('tlb-manage-facets')?.addEventListener('click',facetManager);
    document.getElementById('tlb-add-task')?.addEventListener('click',()=>taskEditor(null,{projectId:stateProjectId()||''}));
    document.getElementById('tlb-import')?.addEventListener('click',importProject);
    document.getElementById('tlb-continue')?.addEventListener('click',event=>continueProject(event.currentTarget));
    document.querySelectorAll('[data-mode]').forEach(button=>button.onclick=()=>{state.mode=button.dataset.mode;render();});
    document.querySelectorAll('[data-sort]').forEach(button=>button.onclick=()=>{const key=button.dataset.sort;state.sort=state.sort.key===key?{key,dir:state.sort.dir==='asc'?'desc':'asc'}:{key,dir:'asc'};render();});
    document.querySelectorAll('[data-edit-task]').forEach(button=>button.onclick=event=>{event.stopPropagation();taskEditor(button.dataset.editTask);});
    document.querySelectorAll('[data-schedule-task]').forEach(button=>button.onclick=event=>{event.stopPropagation();scheduleTask(rows.find(item=>item.id===button.dataset.scheduleTask)||(payload.tasks||[]).map(flattenTask).find(item=>item.id===button.dataset.scheduleTask),button);});
    document.querySelectorAll('.tlb-row-select').forEach(input=>input.onchange=()=>{if(input.checked)state.selected.add(input.dataset.taskId);else state.selected.delete(input.dataset.taskId);render();});
    const selectAll=document.getElementById('tlb-select-all');if(selectAll)selectAll.onchange=()=>{rows.forEach(item=>selectAll.checked?state.selected.add(item.id):state.selected.delete(item.id));render();};
    document.getElementById('tlb-clear-selection')?.addEventListener('click',()=>{state.selected.clear();render();});
    document.getElementById('tlb-bulk-project')?.addEventListener('click',bulkProject);
    document.getElementById('tlb-bulk-schedule')?.addEventListener('click',event=>{const tasks=(payload.tasks||[]).map(flattenTask).filter(item=>state.selected.has(item.id));if(tasks.length)scheduleTask(tasks[0],event.currentTarget);if(tasks.length>1)notify('Place each selected task one at a time; the next remains selected','info');});
    document.getElementById('tlb-matrix-rows')?.addEventListener('change',event=>{state.matrixRows=event.target.value;render();});document.getElementById('tlb-matrix-cols')?.addEventListener('change',event=>{state.matrixColumns=event.target.value;render();});
    document.querySelectorAll('[data-matrix-cell]').forEach(button=>button.onclick=()=>{const [a,av,b,bv]=button.dataset.matrixCell.split('|');state.filters=state.filters.filter(filter=>filter.key!==a&&filter.key!==b);state.filters.push({key:a,op:'in',value:[av]},{key:b,op:'in',value:[bv]});state.mode='table';render();});
    wireColumnDrag();
  }
  function wireColumnDrag(){let dragged=null;document.querySelectorAll('.tlb-table th[data-column]').forEach(th=>{th.ondragstart=event=>{dragged=th.dataset.column;event.dataTransfer.effectAllowed='move';};th.ondragover=event=>event.preventDefault();th.ondrop=event=>{event.preventDefault();const target=th.dataset.column,from=state.columns.indexOf(dragged),to=state.columns.indexOf(target);if(from>=0&&to>=0){state.columns.splice(to,0,state.columns.splice(from,1)[0]);render();}};});}
  function bulkProject(){
    const m=modal('Change project for '+state.selected.size+' tasks','<label class="tlb-field"><span>Project</span><select id="tlb-bulk-project-value"><option value="">Solo</option>'+(payload.projects||[]).filter(project=>props(project).status!=='archived').map(project=>'<option value="'+esc(project.id)+'">'+esc(props(project).name)+'</option>').join('')+'</select></label><p class="tlb-note">Workspace categories stay assigned. Categories scoped to the prior project are removed.</p><div class="tlb-modal-actions"><button data-cancel>Cancel</button><button class="primary" id="tlb-bulk-project-save">Move tasks</button></div>');m.overlay.querySelector('[data-cancel]').onclick=m.close;m.overlay.querySelector('#tlb-bulk-project-save').onclick=async()=>{const projectId=m.overlay.querySelector('#tlb-bulk-project-value').value||null;try{await Promise.all([...state.selected].map(id=>api('/api/task-library/tasks/'+id,{method:'PATCH',body:JSON.stringify({projectId})})));state.selected.clear();m.close();await refresh();notify('Tasks moved');}catch(error){notify(error.message,'error');}};
  }

  restore();
  window.DCCTaskLibrary={refresh,open:function(){if(typeof openTasksToSection==='function')openTasksToSection('tm-task-library-section',{solo:true});else refresh();}};
  window.addEventListener('blocks-changed',()=>setTimeout(refresh,80));
  window.addEventListener('dcc:data-ready',()=>refresh());
  document.addEventListener('DOMContentLoaded',()=>{document.getElementById('tm-task-library-section')&&refresh();});
})();
