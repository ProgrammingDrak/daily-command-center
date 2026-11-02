/* DCC navigation state. Pure parsing, preference migration and URL output for
   the Tasks / Budget / Workouts & meals pages. tabs.js owns the DOM side. */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root){root.DCC=root.DCC||{};root.DCC.NavState=api;}
})(typeof window!=="undefined"?window:null,function(){
  "use strict";

  const PAGES=["tasks","budget","activity"];
  const VIEWS=["queue","list","calendar"];
  const BASE_VIEWS=["list","calendar"];
  const VIEW_KEY="dcc-itinerary-view";
  const ACTUAL_KEY="dcc-itinerary-actual";
  // Retired from navigation only. Records, APIs and background helpers remain.
  const RETIRED={"meeting-reviews":"Meeting Reviews","pet-home":"Pet Home",social:"Social",vault:"Mycelium"};
  const DEFAULT={page:"tasks",view:"queue",actual:false};

  function isRetired(name){return Object.prototype.hasOwnProperty.call(RETIRED,String(name||""));}
  function retiredLabel(name){return isRetired(name)?RETIRED[name]:"";}

  function get(storage,key){try{return storage?storage.getItem(key):null;}catch(_e){return null;}}
  function set(storage,key,value){try{if(storage)storage.setItem(key,value);}catch(_e){}}

  // Saved preferences. A legacy stored "actual" view becomes List plus the Actual
  // toggle, once. A chosen base view is never rewritten here.
  function readPrefs(storage,opts){
    const write=!(opts&&opts.write===false);
    const raw=get(storage,VIEW_KEY);
    const rawActual=get(storage,ACTUAL_KEY);
    let baseView=BASE_VIEWS.includes(raw)?raw:"list";
    let actual=rawActual==="1";
    let migrated=false;
    if(raw==="actual"){
      baseView="list";
      if(rawActual==null)actual=true;
      migrated=true;
      if(write){set(storage,VIEW_KEY,"list");if(rawActual==null)set(storage,ACTUAL_KEY,"1");}
    }
    return {baseView,actual,migrated};
  }
  function saveBaseView(storage,view){if(BASE_VIEWS.includes(view))set(storage,VIEW_KEY,view);}
  function saveActual(storage,on){set(storage,ACTUAL_KEY,on?"1":"0");}

  function normalize(state,prefs){
    const p=prefs||{baseView:"list",actual:false};
    const page=PAGES.includes(state&&state.page)?state.page:DEFAULT.page;
    const view=VIEWS.includes(state&&state.view)?state.view:"queue";
    const actual=typeof(state&&state.actual)==="boolean"?state.actual:!!p.actual;
    return {page,view,actual};
  }

  // Legacy tab name -> state. Retired and unknown names land on the Working Queue.
  function fromLegacyTab(name,prefs){
    const p=prefs||{baseView:"list",actual:false};
    if(name==="working-queue")return {page:"tasks",view:"queue",actual:!!p.actual};
    if(name==="schedule")return {page:"tasks",view:p.baseView,actual:!!p.actual};
    if(name==="budget"||name==="activity")return {page:name,view:"queue",actual:!!p.actual};
    return null;
  }

  function parseActual(value){
    if(value==="1"||value==="true"||value==="on")return true;
    if(value==="0"||value==="false"||value==="off")return false;
    return null;
  }

  // The Tasks workspace remembered by a history entry: its view and Actual
  // choice ride along while Budget or Workouts & meals is showing.
  function savedNav(historyState,prefs){
    const saved=historyState&&historyState.dccNav;
    return saved&&PAGES.includes(saved.page)?normalize(saved,prefs):null;
  }

  // search: location.search. historyState: history.state. prefs: readPrefs().
  // fallback: the in-memory state, for entries that carry no saved nav.
  // Returns {state, explicitActual, legacy:{from,retired,label}|null, canonical}.
  // An actual=1|0 parameter is an explicit choice; so is a history entry that
  // recorded one (dccActualExplicit). Anything else comes from preferences.
  function parse(search,historyState,prefs,fallback){
    const p=prefs||{baseView:"list",actual:false};
    const params=new URLSearchParams(search||"");
    const tab=params.get("tab");
    const viewParam=params.get("view");
    const actualParam=parseActual(params.get("actual"));
    const saved=savedNav(historyState,p);
    const remembered=saved||(fallback&&PAGES.includes(fallback.page)?normalize(fallback,p):null);
    const savedExplicit=!!(saved&&historyState.dccActualExplicit===true);
    let state=null,legacy=null,explicit=false;
    // Old links could ask for the Actual view directly.
    const legacyActualView=viewParam==="actual";
    if(tab==="tasks"){
      const view=VIEWS.includes(viewParam)?viewParam:legacyActualView?p.baseView:"queue";
      state={page:"tasks",view,actual:!!p.actual};
      if(legacyActualView)legacy={from:"view=actual",retired:false,label:""};
    }else if(PAGES.includes(tab)){
      // A non-task page keeps the workspace it came from; the URL names only the page.
      state={page:tab,view:remembered?remembered.view:"queue",actual:remembered?remembered.actual:!!p.actual};
      explicit=savedExplicit;
    }else if(tab){
      const mapped=fromLegacyTab(tab,p);
      if(mapped){state=mapped;if(tab==="schedule"&&BASE_VIEWS.includes(viewParam))state.view=viewParam;}
      else state={page:"tasks",view:"queue",actual:!!p.actual};
      legacy={from:tab,retired:isRetired(tab),label:retiredLabel(tab)};
    }else{
      if(saved){state=saved;explicit=savedExplicit;}
      else if(historyState&&historyState.dccTab){
        state=fromLegacyTab(historyState.dccTab,p)||{page:"tasks",view:"queue",actual:!!p.actual};
      }else if(legacyActualView){
        state={page:"tasks",view:p.baseView,actual:true};
        legacy={from:"view=actual",retired:false,label:""};
      }else state={page:"tasks",view:"queue",actual:!!p.actual};
    }
    if(legacyActualView)state.actual=true;
    if(actualParam!==null)state.actual=actualParam;
    state=normalize(state,p);
    const explicitActual=explicit||actualParam!==null||legacyActualView;
    const canonical=toSearch(state,search,{explicitActual})===normalizeSearch(search);
    return {state,explicitActual,legacy,canonical};
  }

  function normalizeSearch(search){const s=String(search||"");return s&&s!=="?"?(s[0]==="?"?s:"?"+s):"";}

  // Write the nav keys and keep every other parameter in its original order.
  // Actual is written, on or off, only when it was an explicit choice, so a
  // reload or Back keeps that choice and a past-day default never becomes one.
  function toSearch(state,search,opts){
    const s=normalize(state);
    const params=new URLSearchParams(search||"");
    params.set("tab",s.page);
    if(s.page==="tasks"){
      params.set("view",s.view);
      if(opts&&opts.explicitActual)params.set("actual",s.actual?"1":"0");else params.delete("actual");
    }else{params.delete("view");params.delete("actual");}
    const out=params.toString();
    return out?"?"+out:"";
  }

  function panelFor(state){
    const s=normalize(state);
    if(s.page==="tasks")return s.view==="queue"?"working-queue":"schedule";
    return s.page;
  }

  // Archive (past) days open with Actual on for that visit, unless the person
  // already chose. Never persisted and never changes the base view.
  function withArchiveDefault(state,opts){
    const s=normalize(state);
    if(opts&&opts.archive&&!opts.explicitActual)return Object.assign({},s,{actual:true});
    return s;
  }

  function same(a,b){return !!a&&!!b&&a.page===b.page&&a.view===b.view&&a.actual===b.actual;}

  return {PAGES,VIEWS,BASE_VIEWS,VIEW_KEY,ACTUAL_KEY,RETIRED,DEFAULT,isRetired,retiredLabel,readPrefs,saveBaseView,saveActual,normalize,fromLegacyTab,parse,toSearch,panelFor,withArchiveDefault,same};
});
