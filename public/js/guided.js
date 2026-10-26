/* Authenticated browser handoff. No model invocation, hidden prompt rewrite or token storage. */
(() => {
  const $ = id => document.getElementById(id), form = $("definition-form");
  let library = {definitions:[],tasks:[]}, selected = null, taskId = new URLSearchParams(location.search).get("task"), busy = false;
  let createId = crypto.randomUUID(), definitionId = crypto.randomUUID(), pendingAction = null, editorRevision = 0;
  function notice(message) { $("notice").textContent = message; }
  async function api(path, body, method = "POST") {
    const response = await fetch("/api/guided" + path, {credentials:"same-origin", cache:"no-store", ...(body ? {method,headers:{"Content-Type":"application/json"},body:JSON.stringify(body)} : {})});
    const value = await response.json();
    if (!response.ok) { const e = new Error(value.error || "Request failed"); e.status = response.status; throw e; } return value;
  }
  async function run(fn) {
    if (busy) return; busy = true; document.querySelectorAll("button").forEach(b => b.disabled = true);
    try { await fn(); } catch(e) { notice((e.status === 409 ? "Conflict: " : "") + e.message + (e.status === 409 ? ". Refresh and review before retrying." : "")); }
    finally { busy=false; document.querySelectorAll("button").forEach(b=>b.disabled=false); $("copy").disabled=!selected?.prompt; }
  }
  function populateDefinition(d) {
    const v = d?.definition || {completionCriteria:"Confirm the outcome with me before completing this task."};
    for (const name of ["title","goal","starterPrompt","completionCriteria","context"]) form.elements[name].value = v[name] || "";
    form.elements.checklist.value = (v.checklist || []).join("\n");
    form.elements.references.value = (v.references || []).map(r=>r.label+" | "+r.url).join("\n");
    $("prerequisite-editor").replaceChildren();for(const p of v.prerequisites || []) addPrerequisite(p);
    form.elements.includeTaskDetail.checked = !!v.includeTaskDetail;
    definitionId = d?.id || crypto.randomUUID(); editorRevision=d?.revision || 0;
  }
  async function refreshLibrary(keepDefinition = true) {
    const prior = keepDefinition ? $("definitions").value : "";
    library = await api(""); $("tasks").replaceChildren();
    for (const task of library.tasks) {
      const b=document.createElement("button"); b.textContent=`${task.title} · ${String(task.date || "Unscheduled").slice(0,10)} · ${task.status === "done" ? "Completed" : task.session_state || "Not started"}`;
      b.onclick=()=>run(()=>loadTask(task.id,true)); $("tasks").append(b);
    }
    $("definitions").replaceChildren(new Option("New definition",""));
    for(const d of library.definitions) $("definitions").add(new Option(d.definition.title + " · v" + d.revision,d.id));
    $("definitions").value=prior;
  }
  function addPrerequisite(p={}) {
    if($("prerequisite-editor").children.length>=12){notice("Use at most 12 access requirements.");return;}
    const row=document.createElement("fieldset"),legend=document.createElement("legend");legend.textContent=p.service || "Access requirement";row.append(legend);
    for(const [key,title] of [["service","Service or report"],["account","Account identity"],["resource","Exact resource needed"],["action","Action needed"],["reason","Why it is needed"],["remedy","How to resolve missing access"]]) {
      const label=document.createElement("label"),input=document.createElement("input");label.textContent=title;input.dataset.field=key;input.maxLength=500;input.value=p[key] || (key==="action" ? "Read" : "");input.required=["service","resource","action"].includes(key);label.append(input);row.append(label);
    }
    const label=document.createElement("label"),select=document.createElement("select");label.textContent="Available safe check";select.dataset.field="readCheck";
    for(const [value,title] of [["none","No supported check yet"],["dcc-owner-session","DCC owner sign-in"],["connected-service-read","Connected service, checked by assistant"],["signed-in-page-read","Signed-in page, checked by assistant"]])select.add(new Option(title,value));
    select.value=p.readCheck || "none";label.append(select);row.append(label);
    const required=document.createElement("label"),check=document.createElement("input");required.className="check";check.type="checkbox";check.dataset.field="required";check.checked=p.required!==false;required.append(check,document.createTextNode("Required before completion"));row.append(required);
    const remove=document.createElement("button");remove.type="button";remove.textContent="Remove requirement";remove.onclick=()=>row.remove();row.append(remove);$("prerequisite-editor").append(row);
  }
  function editorPrerequisites() {
    return [...$("prerequisite-editor").children].map(row=>Object.fromEntries([...row.querySelectorAll("[data-field]")].map(el=>[el.dataset.field,el.type==="checkbox" ? el.checked : el.value])));
  }
  function editorDefinition() {
    const fields=Object.fromEntries(new FormData(form));
    return {...fields,prerequisites:editorPrerequisites(),checklist:fields.checklist.split("\n").filter(s=>s.trim()),includeTaskDetail:form.elements.includeTaskDetail.checked,
      references:fields.references.split("\n").filter(s=>s.trim()).map(line=>{const i=line.indexOf("|");return {label:line.slice(0,i).trim(),url:line.slice(i+1).trim()};})};
  }
  function renderTask() {
    const v=selected,s=v?.session;
    $("task-title").textContent=v?.title || "Choose a task to preview";
    $("identity").textContent=v ? `Task / occurrence: ${v.taskId} · definition: ${v.definitionId || "not assigned"} · session: ${s?.id || "not started"}` : "";
    $("state").textContent=v ? v.completed ? "Task completed" : s ? `Session ${s.state}${s.state==="active" && !v.startedAt ? " · work timer is paused" : ""}` : "Not started. Preview and copy are read-only." : "";
    $("prompt").value=v?.prompt || "Select saved instructions, then attach them to this task.";
    $("copy").disabled=!v?.prompt;
    $("start").hidden=!v?.prompt || !!s || v.completed;
    $("resume").hidden=!s || v.completed || s.state==="completed";
    $("reopen").hidden=!s || !v.completed || s.state!=="completed";
    $("pause").hidden=!s || !v.startedAt || v.completed;
    $("progress-form").hidden=!s || v.completed || s.state==="completed";
    $("attach").hidden=!v || !!v.definitionId;
    $("progress").value=s?.progress || ""; $("outcome").value=s?.outcome || ""; $("confirmed").checked=false;
    $("checklist").replaceChildren();
    (s?.snapshot?.checklist || []).forEach((item,i)=>{const label=document.createElement("label"),input=document.createElement("input");label.className="check";input.type="checkbox";input.value=i;input.checked=!!s.checked.includes(i);label.append(input,document.createTextNode(item));$("checklist").append(label);});
    $("preflight").replaceChildren();
    if(s) (s.snapshot.prerequisites || []).forEach((p,i)=>{
      const box=document.createElement("fieldset"),legend=document.createElement("legend"),status=document.createElement("select"),note=document.createElement("textarea"),save=document.createElement("button"),description=document.createElement("p");
      box.dataset.prerequisiteIndex=i;
      legend.textContent=(p.required ? "Required: ":"Optional: ")+p.service;description.textContent=`${p.account || "Account unspecified"} · ${p.resource} · ${p.action}. ${p.reason} Remedy: ${p.remedy}. Last observation: ${s.access?.[i]?.at || "never"}. Ready observations expire after 30 minutes.`;
      for(const state of ["unchecked","login-needed","forbidden","approval-needed","unavailable","denied","ready"]) status.add(new Option(state,state));status.value=s.access?.[i]?.status || "unchecked";status.setAttribute("aria-label","Observed access state for "+p.service);note.placeholder="Evidence from a permitted current check; no credentials";note.maxLength=2000;note.setAttribute("aria-label","Access evidence for "+p.service);save.textContent="Record access observation";
      save.onclick=()=>run(async()=>{selected=await api("/tasks/"+encodeURIComponent(taskId)+"/actions",{action:"preflight",expectedRevision:selected.revision,operationId:crypto.randomUUID(),prerequisiteIndex:i,status:status.value,note:note.value});renderTask();notice("Reported access observation saved. DCC did not contact the external service.");});const carry=document.createElement("label"),carryInput=document.createElement("input");carry.className="check";carryInput.type="checkbox";carryInput.dataset.completionObservation="true";carry.append(carryInput,document.createTextNode("I have just verified this observation; include it with completion"));
      const expired=s.access?.[i]?.status==="ready" && Date.now()-Date.parse(s.access[i].at)>30*60000;
      if(expired){status.value="unchecked";description.textContent+=" Prior ready observation is EXPIRED; verify again before marking ready.";}
      box.append(legend,description,status,note,save,carry);$("preflight").append(box);
    });
    $("feedback-form").hidden=!s;
    for(const name of ["worked","failed","blockers","corrections","proposedChanges"]) $("feedback-form").elements[name].value=s?.feedback?.[name] || "";
    $("include-proposal").checked=false;
    $("apply-proposal").hidden=!s?.feedback?.proposedDefinition;
    $("review-proposal").hidden=!s?.feedback?.proposedDefinition;
    $("events").textContent=(s?.initialPrompt ? "ORIGINAL START BRIEFING (immutable)\n"+s.initialPrompt.text+"\n\nHISTORY\n" : "")+(s?.events || []).map(e=>`${e.at} · ${e.action}\n${e.progress || ""}${e.outcome ? "\nOutcome: "+e.outcome : ""}`).join("\n\n") || "No work recorded.";
  }
  async function loadTask(id, scroll=false) {
    selected=await api("/tasks/"+encodeURIComponent(id)); taskId=id; pendingAction=null; reviewedProposalRevision=null;
    history.replaceState(null,"","/guided?task="+encodeURIComponent(id)); renderTask();
    if(scroll) $("conversation").scrollIntoView({block:"start"});
  }
  async function action(name) {
    if(!selected) return;
    const values={action:name,expectedRevision:selected.revision,expectedDefinitionRevision:selected.definitionRevision,expectedContextVersion:selected.contextVersion,
      progress:$("progress").value,outcome:$("outcome").value,checked:[...$("checklist").querySelectorAll("input:checked")].map(i=>Number(i.value)),confirmed:$("confirmed").checked};
    if(name==="complete") values.observations=[...$("preflight").querySelectorAll("fieldset")].filter(box=>box.querySelector("[data-completion-observation]").checked).map(box=>({index:Number(box.dataset.prerequisiteIndex),status:box.querySelector("select").value,note:box.querySelector("textarea").value}));
    const key=JSON.stringify(values);
    if(pendingAction?.key!==key) pendingAction={key,body:{...values,operationId:crypto.randomUUID()}};
    selected=await api("/tasks/"+encodeURIComponent(taskId)+"/actions",pendingAction.body); pendingAction=null; renderTask(); await refreshLibrary(); notice("Saved and read back: "+name+".");
  }
  form.onsubmit=e=>{e.preventDefault();run(async()=>{
    const d=library.definitions.find(d=>d.id===$("definitions").value), fields=Object.fromEntries(new FormData(form));
    const definition={...fields,prerequisites:editorPrerequisites(),checklist:fields.checklist.split("\n").filter(s=>s.trim()),includeTaskDetail:form.elements.includeTaskDetail.checked,
      references:fields.references.split("\n").filter(s=>s.trim()).map(line=>{const i=line.indexOf("|");return {label:line.slice(0,i).trim(),url:line.slice(i+1).trim()};})};
    const saved=await api("/definitions"+(d?"/"+encodeURIComponent(d.id):""),{id:definitionId,expectedRevision:editorRevision,definition},d?"PUT":"POST");
    await refreshLibrary(); $("definitions").value=saved.id; populateDefinition(saved);
    if(taskId) await loadTask(taskId); notice("Instructions saved as revision "+saved.revision+". Started sessions retain their original instructions.");
  });};
  $("add-prerequisite").onclick=()=>addPrerequisite();
  $("reload-instructions").onclick=()=>run(async()=>{const id=$("definitions").value;await refreshLibrary();populateDefinition(library.definitions.find(d=>d.id===id));notice("Saved instructions reloaded. The editor now uses the current accepted revision.");});
  $("feedback-form").onsubmit=e=>{e.preventDefault();run(async()=>{
    if($("include-proposal").checked && (definitionId!==selected.definitionId || editorRevision!==selected.definitionRevision)) throw new Error("Reload and review this task's current saved instructions before including a proposal");
    const feedback={...Object.fromEntries(new FormData($("feedback-form"))),baseDefinitionRevision:$("include-proposal").checked ? editorRevision : selected.definitionRevision,
      proposedDefinition:$("include-proposal").checked ? editorDefinition() : null};
    selected=await api("/tasks/"+encodeURIComponent(taskId)+"/actions",{action:"feedback",operationId:crypto.randomUUID(),expectedRevision:selected.revision,feedback});renderTask();notice("Run feedback saved. Future instructions have not changed.");
  });};
  let reviewedProposalRevision=null;
  $("review-proposal").onclick=()=>{const f=selected.session.feedback;populateDefinition({id:selected.definitionId,revision:f.baseDefinitionRevision,definition:f.proposedDefinition});$("definitions").value=selected.definitionId;reviewedProposalRevision=taskId+":"+selected.session.id+":"+selected.revision;form.scrollIntoView({block:"start"});notice("Review this saved proposal. Apply uses the saved proposal; save feedback again to include further editor changes.");};
  $("apply-proposal").onclick=()=>run(async()=>{
    if(reviewedProposalRevision!==taskId+":"+selected.session.id+":"+selected.revision) throw new Error("Review the saved proposal before applying it");
    const d=await api("/tasks/"+encodeURIComponent(taskId)+"/apply-feedback",{expectedRevision:selected.definitionRevision,expectedSessionRevision:selected.revision});
    await refreshLibrary();$("definitions").value=d.id;populateDefinition(d);await loadTask(taskId);notice("Accepted revision "+d.revision+" for future starts. This session snapshot is unchanged.");
  });
  $("load-versions").onclick=()=>run(async()=>{
    const id=$("definitions").value;if(!id) throw new Error("Select saved instructions first");
    const v=await api("/definitions/"+encodeURIComponent(id)+"/versions");$("versions").replaceChildren();
    for(const version of v.versions){const details=document.createElement("details"),summary=document.createElement("summary"),pre=document.createElement("pre"),button=document.createElement("button");summary.textContent=`Revision ${version.revision} · ${version.provenance.source}`;pre.textContent=JSON.stringify(version.definition,null,2);button.textContent="Restore this version for future starts";button.onclick=()=>run(async()=>{const d=library.definitions.find(d=>d.id===id);const saved=await api("/definitions/"+encodeURIComponent(id)+"/rollback",{expectedRevision:d.revision,targetRevision:version.revision});await refreshLibrary();populateDefinition(saved);if(taskId)await loadTask(taskId);notice("Rollback saved as a new revision "+saved.revision+". Prior sessions are unchanged.");});details.append(summary,pre,button);$("versions").append(details);}
  });
  $("definitions").onchange=()=>{populateDefinition(library.definitions.find(d=>d.id===$("definitions").value));createId=crypto.randomUUID();};
  $("create-form").onsubmit=e=>{e.preventDefault();run(async()=>{
    if(!$("definitions").value) throw new Error("Save or select instructions first");
    const v=await api("/tasks",{id:createId,definitionId:$("definitions").value,date:$("task-date").value});
    await loadTask(v.taskId,true); createId=crypto.randomUUID(); await refreshLibrary(); notice("Guided task created. No work has started.");
  });};
  $("attach").onclick=()=>run(async()=>{if(!$("definitions").value) throw new Error("Select saved instructions first");selected=await api("/tasks/"+encodeURIComponent(taskId)+"/definition",{definitionId:$("definitions").value,expectedContextVersion:selected.contextVersion});renderTask();await refreshLibrary();notice("Instructions attached. No work has started.");});
  $("refresh").onclick=()=>run(async()=>{await refreshLibrary();if(taskId)await loadTask(taskId);notice("Reloaded saved data. Unsaved progress is not retained.");});
  $("preview").onclick=()=>run(async()=>{if(taskId) await loadTask(taskId);notice("Preview refreshed. No work was recorded.");});
  $("copy").onclick=()=>run(async()=>{
    // Refresh the allowlisted source context, display it, then copy EXACTLY that displayed value.
    const latest=await api("/tasks/"+encodeURIComponent(taskId)); $("prompt").value=latest.prompt;
    // The progress form keeps its own revision. Copy cannot authorize stale form writes.
    if(latest.revision===selected.revision) { selected.contextVersion=latest.contextVersion; selected.definitionRevision=latest.definitionRevision; }
    if(!latest.prompt) throw new Error("Save valid instructions before copying");
    try { if(!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable"); await navigator.clipboard.writeText($("prompt").value); notice("Prompt copied. No work was started or completed."); }
    catch { $("prompt").focus(); $("prompt").select(); notice("Clipboard unavailable. The complete prompt is selected; copy it manually. No work was started or completed."); }
  });
  for(const name of ["start","resume","pause","complete","reopen"]) $(name).onclick=()=>run(()=>action(name));
  $("progress-form").onsubmit=e=>{e.preventDefault();run(()=>action("progress"));};
  const now=new Date(); $("task-date").value=[now.getFullYear(),String(now.getMonth()+1).padStart(2,"0"),String(now.getDate()).padStart(2,"0")].join("-");
  run(async()=>{await refreshLibrary();if(taskId) await loadTask(taskId);});
})();
