// Journal + Daylio-style mood/activity tagging.
//
// Lifted out of public/js/glymphatic-brief.js on 2026-08-20, when the Day-in-Review
// task scan was ripped out. The journal was a keeper that happened to live inside
// that scan's UI and was only reachable through it, so it moved here and now stands
// on its own: it renders as its own Loose Ends section (catch-up.js) and needs no
// nightly packet to exist.
//
// The `gb*` prefix on the moved functions stands for nothing any more. It is kept
// verbatim on purpose: the injected `gb-daylio-style` CSS block, the `gb-*` classes
// in public/css/dashboard.css, and the `data-gb-*` hooks catch-up.js queries are all
// spelled that way, and renaming them would be churn with a chance of a silent miss.
//
// STORAGE. Keys are byte-identical to what the brief used, so every past entry and
// the whole mood taxonomy stay readable:
//   entries  dcc-glymphatic-brief:review:<workspaceId>:<userId>:<YYYY-MM-DD>
//   taxonomy dcc-daylio-taxonomy:v1:<workspaceId>:<userId>
// What changed is only WHICH date is passed in. The brief keyed entries by the
// packet's "review date" (usually yesterday) because that is the day the scan
// reconstructed. There is no review date now, so an entry keys to the day on screen
// -- which is what the section's own copy ("How did today actually go?") always
// implied, and which lets date navigation backfill or reread any day.
(function(){
  var LOCAL_PREFIX = "dcc-glymphatic-brief:";
  var jrOwnerScope = null;

  function gbEsc(value){
    return String(value == null ? "" : value)
      .replace(/&/g,"&amp;")
      .replace(/</g,"&lt;")
      .replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;")
      .replace(/'/g,"&#39;");
  }

  // Same body, and the SAME output string, as the brief's gbEnsureReviewOwnerScope.
  // The scope is baked into every storage key, so the "workspace"/"user" fallbacks
  // and the literal "unidentified" below must not drift -- changing either orphans
  // every entry already on disk plus the taxonomy.
  async function jrEnsureScope(){
    if(jrOwnerScope)return jrOwnerScope;
    var res = await fetch("/api/me");
    if(!res.ok)throw new Error("Could not identify the current workspace");
    var me = await res.json();
    if(!me || (!me.workspaceId && !me.userId))throw new Error("Could not identify the current workspace");
    jrOwnerScope = String(me.workspaceId || "workspace") + ":" + String(me.userId || "user");
    return jrOwnerScope;
  }

  // The day on screen. In the Loose Ends overlay that is always today (catch-up.js
  // bails unless viewMode === "today"), but keying off __state.date rather than a
  // hardcoded today is what makes date navigation work.
  function jrDate(){
    return (typeof __state !== "undefined" && __state && __state.date)
      || (typeof __todayDate !== "undefined" && __todayDate)
      || new Date().toISOString().slice(0,10);
  }

  // "review:" is historical and deliberately unchanged -- it is what past entries
  // are already filed under.
  function jrKey(date){
    return LOCAL_PREFIX + "review:" + (jrOwnerScope || "unidentified") + ":" + (date || jrDate());
  }

  function jrUi(){
    try{ return JSON.parse(localStorage.getItem(jrKey(jrDate())) || "{}"); }
    catch(e){ return {}; }
  }

  function jrSave(ui){
    try{ localStorage.setItem(jrKey(jrDate()), JSON.stringify(ui || {})); }catch(e){}
  }

  // The element our section was rendered into, so a mood edit can repaint just it.
  var jrHostEl = null;
  function jrHost(){
    if(jrHostEl && jrHostEl.isConnected)return jrHostEl;
    jrHostEl = document.querySelector(".cu-journal-wrap");
    return jrHostEl;
  }

  function jrRepaint(){
    var host = jrHost();
    if(host)host.innerHTML = gbJournalSection(jrUi());
  }

  // Journal entry — local-only for now. FUTURE: wire gbSaveJournal to the
  // Mycelium vault (vault_append to today's journal node). Kept per-date in the
  // brief's localStorage (ui.journal) so it survives the 60s auto-refresh.
  function gbSetJournal(value){
    var ui = jrUi();
    ui.journal = value;
    jrSave(ui);
  }

  function gbSaveJournal(){
    var el = document.querySelector("[data-gb-journal]");
    var ui = jrUi();
    ui.journal = el ? el.value : (ui.journal || "");
    ui.journal_saved_at = new Date().toISOString();
    jrSave(ui);
    var status = document.querySelector("[data-gb-journal-status]");
    if(status)status.textContent = "Saved " + new Date(ui.journal_saved_at).toLocaleTimeString([], {hour:"numeric", minute:"2-digit"});
    if(typeof showToast === "function")showToast("Journal saved locally (vault wiring pending)", "success");
    // FUTURE: POST the entry to the Mycelium vault here.
  }

  // --- Daylio-style mood + activity tagging ---------------------------------
  // One mood per entry on a 5-level scale, plus activities grouped into editable
  // categories (multi-select). Taxonomy (moods + groups) is global across dates
  // in its own localStorage key; the per-day selection (mood + activity ids)
  // rides in the per-date brief ui. All local for now — same future Mycelium hook.

  var GB_TAXO_KEY = "dcc-daylio-taxonomy:v1";
  function gbTaxoKey(){ return GB_TAXO_KEY + ":" + (jrOwnerScope || "unidentified"); }

  function gbDefaultTaxonomy(){
    return {
      moods: [
        {id:"rad",   name:"rad",   level:5, emoji:"😄", color:"#43A047"},
        {id:"good",  name:"good",  level:4, emoji:"🙂", color:"#7CB342"},
        {id:"meh",   name:"meh",   level:3, emoji:"😐", color:"#00ACC1"},
        {id:"bad",   name:"bad",   level:2, emoji:"😕", color:"#FB8C00"},
        {id:"awful", name:"awful", level:1, emoji:"😢", color:"#E53935"}
      ],
      groups: [
        {id:"emotions", name:"Emotions", activities:[
          {id:"happy",name:"happy",emoji:"😊"},{id:"excited",name:"excited",emoji:"🤩"},
          {id:"grateful",name:"grateful",emoji:"🙏"},{id:"relaxed",name:"relaxed",emoji:"😌"},
          {id:"tired",name:"tired",emoji:"🥱"},{id:"anxious",name:"anxious",emoji:"😰"},
          {id:"stressed",name:"stressed",emoji:"😫"},{id:"sad",name:"sad",emoji:"😢"},
          {id:"angry",name:"angry",emoji:"😠"},{id:"bored",name:"bored",emoji:"😑"}
        ]},
        {id:"sleep", name:"Sleep", activities:[
          {id:"good-sleep",name:"good sleep",emoji:"😴"},{id:"medium-sleep",name:"medium sleep",emoji:"🛌"},
          {id:"bad-sleep",name:"bad sleep",emoji:"🥴"}
        ]},
        {id:"social", name:"Social", activities:[
          {id:"family",name:"family",emoji:"👨‍👩‍👧"},{id:"friends",name:"friends",emoji:"🧑‍🤝‍🧑"},
          {id:"date",name:"date",emoji:"❤️"},{id:"party",name:"party",emoji:"🎉"},
          {id:"call",name:"call",emoji:"📞"}
        ]},
        {id:"hobbies", name:"Hobbies", activities:[
          {id:"movies",name:"movies & tv",emoji:"🎬"},{id:"reading",name:"reading",emoji:"📖"},
          {id:"gaming",name:"gaming",emoji:"🎮"},{id:"music",name:"music",emoji:"🎵"},
          {id:"sport",name:"sport",emoji:"🏃"}
        ]},
        {id:"health", name:"Health", activities:[
          {id:"exercise",name:"exercise",emoji:"💪"},{id:"walk",name:"walk",emoji:"🚶"},
          {id:"water",name:"drink water",emoji:"💧"},{id:"eat-healthy",name:"eat healthy",emoji:"🥗"},
          {id:"meditation",name:"meditation",emoji:"🧘"}
        ]},
        {id:"chores", name:"Chores", activities:[
          {id:"shopping",name:"shopping",emoji:"🛒"},{id:"cleaning",name:"cleaning",emoji:"🧹"},
          {id:"cooking",name:"cooking",emoji:"🍳"},{id:"laundry",name:"laundry",emoji:"🧺"}
        ]},
        {id:"work", name:"Work", activities:[
          {id:"shipped",name:"shipped",emoji:"🚀"},{id:"meetings",name:"meetings",emoji:"👥"},
          {id:"deep-work",name:"deep work",emoji:"🎯"},{id:"email",name:"email",emoji:"✉️"}
        ]}
      ]
    };
  }

  function gbLoadTaxo(){
    try{
      var t = JSON.parse(localStorage.getItem(gbTaxoKey()) || "null");
      if(t && Array.isArray(t.moods) && Array.isArray(t.groups))return t;
    }catch(e){}
    return gbDefaultTaxonomy();
  }
  function gbSaveTaxo(t){ try{ localStorage.setItem(gbTaxoKey(), JSON.stringify(t)); }catch(e){} }

  function gbSlug(s){
    return String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") || "item";
  }
  function gbNewId(name){ return gbSlug(name) + "-" + Date.now().toString(36); }

  function gbFindMood(taxo, id){
    return (taxo.moods || []).filter(function(m){ return m.id === id; })[0] || null;
  }
  function gbFindActivity(taxo, id){
    for(var i=0;i<(taxo.groups||[]).length;i++){
      var a = (taxo.groups[i].activities || []).filter(function(x){ return x.id === id; })[0];
      if(a)return a;
    }
    return null;
  }
  function gbToggleActivity(id){
    var ui = jrUi();
    var list = Array.isArray(ui.activities) ? ui.activities.slice() : [];
    var i = list.indexOf(id);
    if(i === -1)list.push(id); else list.splice(i,1);
    ui.activities = list;
    jrSave(ui);
  }
  function gbSetMood(id){
    var ui = jrUi();
    ui.mood = (ui.mood === id) ? null : id;
    jrSave(ui);
  }

  function gbEnsureDaylioStyles(){
    if(document.getElementById("gb-daylio-style"))return;
    var css = ''+
      '.gb-modal-overlay{position:fixed;inset:0;background:rgba(6,10,16,.62);display:flex;align-items:flex-start;justify-content:center;z-index:9999;padding:5vh 16px;overflow:auto}'+
      '.gb-modal{width:100%;max-width:560px;background:var(--surface,#161d29);color:var(--text,#e8edf3);border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:18px 18px 20px;box-shadow:0 20px 60px rgba(0,0,0,.5)}'+
      '.gb-modal-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px}'+
      '.gb-mood-row{display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap}'+
      '.gb-mood-wrap{position:relative;display:flex;flex:1 1 0;min-width:62px}'+
      '.gb-mood{flex:1;min-width:62px;display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 6px;border:2px solid transparent;border-radius:14px;cursor:pointer;background:rgba(255,255,255,.03);color:inherit;font:inherit;transition:transform .08s,border-color .12s,background .12s}'+
      '.gb-mood:hover{transform:translateY(-1px)}'+
      '.gb-mood.on{background:color-mix(in srgb, var(--mc,#43A047) 20%, transparent)}'+
      '.gb-mood-emoji{font-size:30px;line-height:1}'+
      '.gb-mood-name{font-size:11px;text-transform:capitalize;color:var(--text-muted,#9fb0c3)}'+
      '.gb-group{margin-top:16px}'+
      '.gb-group-title{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted,#9fb0c3);margin-bottom:8px}'+
      '.gb-act-grid{display:flex;flex-wrap:wrap;gap:8px}'+
      '.gb-act-wrap{position:relative;display:inline-flex}'+
      '.gb-act{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border:1px solid rgba(255,255,255,.12);border-radius:999px;cursor:pointer;color:inherit;font:inherit;font-size:13px;background:rgba(255,255,255,.03);transition:border-color .1s,background .1s}'+
      '.gb-act:hover{border-color:rgba(255,255,255,.28)}'+
      '.gb-act.on{background:rgba(90,150,255,.22);border-color:rgba(120,170,255,.7)}'+
      '.gb-act-emoji{font-size:15px}'+
      '.gb-mini-del{position:absolute;top:-7px;right:-7px;width:18px;height:18px;line-height:16px;text-align:center;border-radius:50%;border:none;background:#e2564d;color:#fff;font-size:12px;cursor:pointer;padding:0}'+
      '.gb-group-title .gb-mini-del{position:static;width:18px;height:18px;line-height:16px}'+
      '.gb-add-row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center}'+
      '.gb-inp{padding:7px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:inherit;font:inherit}'+
      '.gb-daylio-summary{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}'+
      '.gb-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);font-size:13px}'+
      '.gb-mood-chip{border-width:2px}'+
      '.gb-icon-btn.on{background:rgba(90,150,255,.22);border-color:rgba(120,170,255,.7)}';
    var el = document.createElement("style");
    el.id = "gb-daylio-style";
    el.textContent = css;
    document.head.appendChild(el);
  }

  var GB_MOOD_LEVELS = {5:"Rad", 4:"Good", 3:"Meh", 2:"Bad", 1:"Awful"};
  var gbMoodReturnFocus = null;

  function gbMoodModalHtml(editMode){
    var taxo = gbLoadTaxo();
    var ui = jrUi();
    var selMood = ui.mood;
    var selActs = ui.activities || [];
    var moods = (taxo.moods || []).slice().sort(function(a,b){ return (b.level||0) - (a.level||0); });
    var moodRow = moods.map(function(m){
      var on = m.id === selMood;
      return '<div class="gb-mood-wrap"><button type="button" class="gb-mood'+(on?' on':'')+'" data-gb-mood="'+gbEsc(m.id)+'" aria-pressed="'+(on?'true':'false')+'"'+(on?' style="--mc:'+gbEsc(m.color)+';border-color:'+gbEsc(m.color)+'"':'')+'>'+
        '<div class="gb-mood-emoji">'+gbEsc(m.emoji)+'</div><div class="gb-mood-name">'+gbEsc(m.name)+'</div>'+
      '</button>'+(editMode?'<button type="button" class="gb-mini-del" data-gb-del-mood="'+gbEsc(m.id)+'" aria-label="Delete '+gbEsc(m.name)+' mood">&times;</button>':'')+'</div>';
    }).join("");
    var addMoodRow = editMode ?
      '<div class="gb-add-row">'+
        '<input class="gb-inp" data-gb-new-mood-emoji placeholder="🙂" maxlength="4" style="width:52px;text-align:center">'+
        '<input class="gb-inp" data-gb-new-mood-name placeholder="new mood" style="flex:1;min-width:120px">'+
        '<select class="gb-inp" data-gb-new-mood-level>'+[5,4,3,2,1].map(function(l){ return '<option value="'+l+'">'+GB_MOOD_LEVELS[l]+'</option>'; }).join("")+'</select>'+
        '<button class="gb-add-btn" data-gb-add-mood>Add mood</button>'+
      '</div>' : "";
    var groupsHtml = (taxo.groups || []).map(function(g){
      var acts = (g.activities || []).map(function(a){
        var on = selActs.indexOf(a.id) !== -1;
        return '<div class="gb-act-wrap"><button type="button" class="gb-act'+(on?' on':'')+'" data-gb-activity="'+gbEsc(a.id)+'" aria-pressed="'+(on?'true':'false')+'">'+
          '<span class="gb-act-emoji">'+gbEsc(a.emoji)+'</span><span>'+gbEsc(a.name)+'</span>'+
        '</button>'+(editMode?'<button type="button" class="gb-mini-del" data-gb-del-activity="'+gbEsc(g.id)+':'+gbEsc(a.id)+'" aria-label="Delete '+gbEsc(a.name)+' activity">&times;</button>':'')+'</div>';
      }).join("");
      var addAct = editMode ?
        '<div class="gb-add-row">'+
          '<input class="gb-inp" data-gb-new-act-emoji="'+gbEsc(g.id)+'" placeholder="🏷️" maxlength="4" style="width:52px;text-align:center">'+
          '<input class="gb-inp" data-gb-new-act-name="'+gbEsc(g.id)+'" placeholder="new activity" style="flex:1;min-width:120px">'+
          '<button class="gb-add-btn" data-gb-add-activity="'+gbEsc(g.id)+'">Add</button>'+
        '</div>' : "";
      return '<div class="gb-group"><div class="gb-group-title"><span>'+gbEsc(g.name)+'</span>'+
        (editMode?'<button class="gb-mini-del" data-gb-del-group="'+gbEsc(g.id)+'" title="Delete category">&times;</button>':'')+'</div>'+
        '<div class="gb-act-grid">'+(acts || '<div class="gb-empty">No activities yet.</div>')+'</div>'+addAct+'</div>';
    }).join("");
    var addGroup = editMode ?
      '<div class="gb-group"><div class="gb-add-row">'+
        '<input class="gb-inp" data-gb-new-group-name placeholder="new category" style="flex:1;min-width:140px">'+
        '<button class="gb-add-btn" data-gb-add-group>Add category</button>'+
      '</div></div>' : "";
    return '<div class="gb-modal" role="dialog" aria-modal="true" aria-labelledby="gb-mood-title">'+
      '<div class="gb-modal-head">'+
        '<div class="gb-section-title" id="gb-mood-title">How was your day?</div>'+
        '<div style="display:flex;gap:8px;align-items:center">'+
          '<button class="gb-icon-btn'+(editMode?' on':'')+'" data-gb-modal-edit>'+(editMode?'Done editing':'Edit categories')+'</button>'+
          '<button class="gb-icon-btn" data-gb-modal-close title="Close">Close</button>'+
        '</div>'+
      '</div>'+
      '<div class="gb-mood-row">'+moodRow+'</div>'+addMoodRow+
      groupsHtml+addGroup+
      '<div class="gb-task-actions" style="justify-content:flex-end;margin-top:16px"><button class="gb-add-btn" data-gb-modal-close>Done</button></div>'+
    '</div>';
  }

  // Re-render ONLY our own host node. The old version called
  // buildGlymphaticBrief() + fired dcc:day-review-changed, which made catch-up.js
  // rebuild the whole Loose Ends modal and destroy the focused control -- the
  // reason a `preserveMoodFocus` workaround existed there. Repainting in place and
  // focusing the replacement button keeps the rest of the modal untouched.
  function jrCloseMoodModal(){
    var el = document.getElementById("gb-mood-modal");
    if(el)el.remove();
    jrRepaint();
    var host = jrHost();
    var back = host && host.querySelector("[data-gb-open-mood]");
    if(back && typeof back.focus === "function")back.focus();
    else if(gbMoodReturnFocus && typeof gbMoodReturnFocus.focus === "function")gbMoodReturnFocus.focus();
    gbMoodReturnFocus = null;
  }

  function gbOpenMoodModal(){
    gbEnsureDaylioStyles();
    gbMoodReturnFocus = document.activeElement;
    var prev = document.getElementById("gb-mood-modal");
    if(prev)prev.remove();
    var overlay = document.createElement("div");
    overlay.id = "gb-mood-modal";
    overlay.className = "gb-modal-overlay";
    var editMode = false;
    function focusToken(target){
      var attrs = ["data-gb-mood","data-gb-activity","data-gb-modal-edit","data-gb-add-mood","data-gb-add-activity","data-gb-add-group"];
      for(var i=0;i<attrs.length;i++){
        var found = target && target.closest ? target.closest("["+attrs[i]+"]") : null;
        if(found)return { attr:attrs[i], value:found.getAttribute(attrs[i]) || "" };
      }
      return null;
    }
    function rerender(token){
      overlay.innerHTML = gbMoodModalHtml(editMode);
      if(!token)return;
      var candidates = overlay.querySelectorAll("["+token.attr+"]");
      var target = Array.prototype.slice.call(candidates).filter(function(el){ return (el.getAttribute(token.attr) || "") === token.value; })[0];
      if(!target)target = overlay.querySelector("[data-gb-modal-edit], [data-gb-modal-close]");
      if(target && typeof target.focus === "function")target.focus();
    }
    overlay.addEventListener("click", function(e){
      var returnToken = focusToken(e.target);
      if(e.target === overlay || e.target.closest("[data-gb-modal-close]")){ jrCloseMoodModal(); return; }
      if(e.target.closest("[data-gb-modal-edit]")){ editMode = !editMode; rerender(returnToken); return; }

      var delMood = e.target.closest("[data-gb-del-mood]");
      if(delMood){
        var mid = delMood.dataset.gbDelMood;
        var t = gbLoadTaxo(); t.moods = (t.moods||[]).filter(function(m){ return m.id !== mid; }); gbSaveTaxo(t);
        var ui = jrUi(); if(ui.mood === mid){ ui.mood = null; jrSave(ui); }
        rerender(returnToken); return;
      }
      var moodBtn = e.target.closest("[data-gb-mood]");
      if(moodBtn && !editMode){ gbSetMood(moodBtn.dataset.gbMood); rerender(returnToken); return; }

      var delAct = e.target.closest("[data-gb-del-activity]");
      if(delAct){
        var parts = delAct.dataset.gbDelActivity.split(":");
        var t2 = gbLoadTaxo();
        (t2.groups||[]).forEach(function(g){ if(g.id === parts[0])g.activities = (g.activities||[]).filter(function(a){ return a.id !== parts[1]; }); });
        gbSaveTaxo(t2); rerender(returnToken); return;
      }
      var actBtn = e.target.closest("[data-gb-activity]");
      if(actBtn && !editMode){ gbToggleActivity(actBtn.dataset.gbActivity); rerender(returnToken); return; }

      var addAct = e.target.closest("[data-gb-add-activity]");
      if(addAct){
        var gid = addAct.dataset.gbAddActivity;
        var nameEl = overlay.querySelector('[data-gb-new-act-name="'+gid+'"]');
        var emEl = overlay.querySelector('[data-gb-new-act-emoji="'+gid+'"]');
        var name = nameEl ? nameEl.value.trim() : "";
        if(!name)return;
        var t3 = gbLoadTaxo();
        (t3.groups||[]).forEach(function(g){ if(g.id === gid)g.activities = (g.activities||[]).concat([{id:gbNewId(name), name:name, emoji:(emEl && emEl.value.trim()) || "🏷️"}]); });
        gbSaveTaxo(t3); rerender(returnToken); return;
      }
      var delGroup = e.target.closest("[data-gb-del-group]");
      if(delGroup){
        var t4 = gbLoadTaxo(); t4.groups = (t4.groups||[]).filter(function(g){ return g.id !== delGroup.dataset.gbDelGroup; }); gbSaveTaxo(t4); rerender(returnToken); return;
      }
      var addGroup = e.target.closest("[data-gb-add-group]");
      if(addGroup){
        var gEl = overlay.querySelector("[data-gb-new-group-name]");
        var gName = gEl ? gEl.value.trim() : "";
        if(!gName)return;
        var t5 = gbLoadTaxo(); t5.groups = (t5.groups||[]).concat([{id:gbNewId(gName), name:gName, activities:[]}]); gbSaveTaxo(t5); rerender(returnToken); return;
      }
      var addMood = e.target.closest("[data-gb-add-mood]");
      if(addMood){
        var mnEl = overlay.querySelector("[data-gb-new-mood-name]");
        var meEl = overlay.querySelector("[data-gb-new-mood-emoji]");
        var mlEl = overlay.querySelector("[data-gb-new-mood-level]");
        var mName = mnEl ? mnEl.value.trim() : "";
        if(!mName)return;
        var t6 = gbLoadTaxo();
        t6.moods = (t6.moods||[]).concat([{id:gbNewId(mName), name:mName, emoji:(meEl && meEl.value.trim()) || "🙂", level:(mlEl ? parseInt(mlEl.value,10) : 3), color:"#9E9E9E"}]);
        gbSaveTaxo(t6); rerender(returnToken); return;
      }
    });
    overlay.addEventListener("keydown", function(e){
      if(e.key === "Escape"){ e.preventDefault(); jrCloseMoodModal(); return; }
      if(e.key !== "Tab")return;
      var focusable = Array.prototype.slice.call(overlay.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      if(!focusable.length){ e.preventDefault(); return; }
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
    });
    document.body.appendChild(overlay);
    rerender();
    var firstChoice = overlay.querySelector("[data-gb-mood], [data-gb-modal-close]");
    if(firstChoice)firstChoice.focus();
  }

  function gbDaylioSummary(ui){
    var taxo = gbLoadTaxo();
    var mood = gbFindMood(taxo, ui.mood);
    var acts = (ui.activities || []).map(function(id){ return gbFindActivity(taxo, id); }).filter(Boolean);
    var chips = (mood ? '<span class="gb-chip gb-mood-chip" style="border-color:'+gbEsc(mood.color)+'"><span>'+gbEsc(mood.emoji)+'</span> '+gbEsc(mood.name)+'</span>' : "")+
      acts.map(function(a){ return '<span class="gb-chip"><span>'+gbEsc(a.emoji)+'</span> '+gbEsc(a.name)+'</span>'; }).join("");
    var label = (mood || acts.length) ? "Edit mood &amp; activities" : "How was your day?";
    return '<div class="gb-daylio-summary">'+chips+
      '<button class="gb-add-btn" data-gb-open-mood>'+label+'</button>'+
    '</div>';
  }

  function gbJournalSection(ui){
    var val = (ui && typeof ui.journal === "string") ? ui.journal : "";
    var saved = (ui && ui.journal_saved_at)
      ? "Saved " + new Date(ui.journal_saved_at).toLocaleTimeString([], {hour:"numeric", minute:"2-digit"})
      : "";
    return '<section class="gb-section gb-journal"><div class="gb-section-title">Journal</div>'+
      gbDaylioSummary(ui)+
      '<div class="gb-row-sub" style="margin-bottom:8px">A note on today. Saved locally for now; wiring to the vault comes later.</div>'+
      '<label class="gb-row-sub" for="gb-review-journal">Journal entry</label>'+
      '<textarea id="gb-review-journal" data-gb-journal placeholder="How did today actually go?" '+
        'style="width:100%;min-height:120px;resize:vertical;padding:10px;border-radius:10px;'+
        'border:1px solid var(--border,rgba(255,255,255,.14));background:var(--surface-2,rgba(255,255,255,.03));'+
        'color:inherit;font:inherit;line-height:1.5;box-sizing:border-box">'+gbEsc(val)+'</textarea>'+
      '<div class="gb-task-actions" style="margin-top:8px;justify-content:flex-end;align-items:center;gap:10px">'+
        '<span class="gb-row-meta" data-gb-journal-status>'+gbEsc(saved)+'</span>'+
        '<button class="gb-add-btn" data-gb-journal-save title="Save this entry">Save</button>'+
      '</div>'+
    '</section>';
  }

  // Nothing is saved until Save is pressed for the text, but mood/activity taps are
  // immediate (they were in the brief too) -- so a tap is durable even if the modal
  // is dismissed without touching the journal textarea.
  function jrIsPending(){
    // No scope means no correct key, so there is nothing honest to prompt about.
    if(!jrOwnerScope)return false;
    var ui = jrUi();
    if(ui && ui.journal_saved_at)return false;
    if(ui && ui.mood)return false;
    if(ui && Array.isArray(ui.activities) && ui.activities.length)return false;
    return true;
  }

  document.addEventListener("click", function(e){
    var save = e.target.closest && e.target.closest("[data-gb-journal-save]");
    if(save){ gbSaveJournal(); return; }
    var mood = e.target.closest && e.target.closest("[data-gb-open-mood]");
    if(mood){ gbOpenMoodModal(); return; }
  });

  document.addEventListener("input", function(e){
    var j = e.target.closest && e.target.closest("[data-gb-journal]");
    if(j)gbSetJournal(j.value);
  });

  window.DCC = window.DCC || {};
  window.DCC.Journal = {
    ensureScope: jrEnsureScope,
    // Renders NOTHING until the owner scope is resolved. Every storage key embeds the
    // scope, so painting the section early would write the entry under "unidentified"
    // and orphan it from the real one. Callers must await ensureScope() first and treat
    // an empty string as "no journal section this pass".
    render: function(){ return jrOwnerScope ? gbJournalSection(jrUi()) : ""; },
    isPending: jrIsPending,
    // Test/consumer seam: the host is normally found by class, but catch-up.js can
    // hand us the node it rendered into so a mood edit repaints the right one.
    setHost: function(el){ jrHostEl = el || null; },
  };
})();
