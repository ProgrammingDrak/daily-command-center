(function(){
  const slug=location.pathname.split("/").filter(Boolean).pop();
  let state=null;
  function esc(value) { return window.DCC.esc(value); } // delegates to core.js
  function pct(value){return Math.max(0,Math.min(100,Number(value)||0));}
  function petGlyph(base){return {sprout:"S",mossling:"M",moonpup:"P",pufflet:"F"}[base]||"S";}
  function accessoryGlyph(accessory){return {bandana:"◇",hat:"^",necklace:"o",flower:"*"}[accessory]||"";}
  function api(path, opts) { return window.DCC.api(path, { ...(opts||{}), errorLabel: "Pet Home is unavailable" }); } // delegates to core.js
  function setError(message){
    document.getElementById("public-pet-content").hidden=true;
    const err=document.getElementById("public-pet-error");
    err.hidden=false;
    err.textContent=message;
  }
  function renderAvatar(home){
    const avatar=document.getElementById("public-pet-avatar");
    const pet=home.pet||{};
    avatar.style.setProperty("--pet-color",pet.color||"#f2b56b");
    avatar.dataset.base=pet.base||"sprout";
    avatar.innerHTML='<span class="pet-ears"></span><strong>'+petGlyph(pet.base)+'</strong><span class="pet-face"></span><em>'+accessoryGlyph(pet.accessory)+'</em>';
  }
  function renderCare(home){
    const food=pct(home.foodLevel),mood=pct(home.moodLevel);
    document.getElementById("public-food-fill").style.width=food+"%";
    document.getElementById("public-mood-fill").style.width=mood+"%";
    document.getElementById("public-food-label").textContent=food+"%";
    document.getElementById("public-mood-label").textContent=mood+"%";
  }
  function renderZones(home){
    const equipped=new Set(((home||{}).home||{}).equippedDecor||[]);
    document.getElementById("public-garden-zone").textContent=equipped.has("tiny-fountain")?"Fountain garden":equipped.has("flower-box")?"Flower garden":equipped.has("garden-pot")?"Tiny garden":"";
    document.getElementById("public-special-zone").textContent=equipped.has("slot-corner")?"Slot corner":"";
  }
  function renderTasks(tasks){
    const board=document.getElementById("public-task-list");
    const progress=document.getElementById("public-progress-list");
    if(!tasks.length){
      board.innerHTML='<div class="pet-empty">No public tasks on the board.</div>';
      progress.innerHTML='<div class="pet-empty">Nothing shared yet.</div>';
      return;
    }
    board.innerHTML=tasks.slice(0,7).map(t=>'<div class="pet-board-task '+(t.status==="done"?"done":"")+'"><span></span>'+esc(t.title)+'</div>').join("");
    progress.innerHTML=tasks.map(t=>
      '<div class="pet-public-task '+(t.status==="done"?"done":"")+'"><span>'+esc(t.status==="done"?"Done":"Open")+'</span><strong>'+esc(t.title)+'</strong></div>'
    ).join("");
  }
  function renderEvents(events){
    const wrap=document.getElementById("public-events");
    if(!events.length){wrap.innerHTML='<div class="pet-empty">No encouragement yet.</div>';return;}
    wrap.innerHTML=events.slice(0,16).map(ev=>{
      const actor=ev.actor_name?esc(ev.actor_name)+" · ":"";
      const label=ev.event_type==="encouragement"?"Cheer":ev.event_type==="task_feed"?"Fed":"Update";
      return '<div class="pet-event"><span>'+label+'</span><strong>'+actor+esc(ev.message||"Pet home updated")+'</strong></div>';
    }).join("");
  }
  function render(){
    const home=state.home;
    document.getElementById("public-pet-content").hidden=false;
    document.getElementById("public-pet-title").textContent=(home.pet&&home.pet.name?home.pet.name:"Pet")+" Home";
    document.getElementById("public-pet-subtitle").textContent="Visit, cheer, and suggest tasks for the shared board.";
    renderAvatar(home);
    renderCare(home);
    renderZones(home);
    renderTasks(state.tasks||[]);
    renderEvents(state.events||[]);
  }
  async function load(){
    state=await api("/api/public/pet-home/"+encodeURIComponent(slug));
    render();
  }
  function visitorName(){
    const name=document.getElementById("public-visitor-name").value.trim();
    if(!name)throw new Error("Add your name first.");
    return name;
  }
  async function sendEncouragement(){
    const message=document.getElementById("public-encouragement").value.trim();
    if(!message)throw new Error("Write a note first.");
    await api("/api/public/pet-home/"+encodeURIComponent(slug)+"/encouragement",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({visitorName:visitorName(),message})
    });
    document.getElementById("public-encouragement").value="";
    await load();
  }
  async function sendSuggestion(){
    const title=document.getElementById("public-suggestion-title").value.trim();
    const note=document.getElementById("public-suggestion-note").value.trim();
    if(!title)throw new Error("Add a task idea first.");
    await api("/api/public/pet-home/"+encodeURIComponent(slug)+"/suggestions",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({visitorName:visitorName(),title,note})
    });
    document.getElementById("public-suggestion-title").value="";
    document.getElementById("public-suggestion-note").value="";
    await load();
  }
  function flashError(message){
    const err=document.getElementById("public-pet-error");
    err.hidden=false;
    err.textContent=message;
    setTimeout(()=>{if(state)err.hidden=true;},3000);
  }
  document.getElementById("public-send-encouragement").addEventListener("click",()=>sendEncouragement().catch(e=>flashError(e.message)));
  document.getElementById("public-send-suggestion").addEventListener("click",()=>sendSuggestion().catch(e=>flashError(e.message)));
  load().catch(e=>setError(e.message));
})();
