// One bounded consistency loop for live views. SSE (or any ping) remains the
// immediate update path; this catches missed broadcasts and suspended connections
// without retaining snapshots or starting one timer per row. Dependencies are
// injected so timing, visibility and overlap behavior stay directly testable.
//
// Used by the owner itinerary (sse.js) and the shared activity page. Every option
// below the original set is opt-in and defaults to the owner's incumbent behavior.
//   trailing         a refresh requested mid-read runs once more after it, so a
//                    ping never lands on a response that was already in flight
//   refreshOnVisible returning to the tab always refreshes (not only when stale)
//   isLoaded         accepts a loaded value (default: Array.isArray, for day rows)
//   retryDelaysMs    after a failed read, retry on this schedule (last value repeats)
//   setTimeoutFn / clearTimeoutFn / clearIntervalFn / removeVisibilityListener
(function(root, factory){
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DCCRefreshCoordinator = api;
})(typeof window !== "undefined" ? window : globalThis, function(){
  "use strict";
  function createTaskRefreshCoordinator(opts){
    opts=opts||{};
    const intervalMs=opts.intervalMs||60*1000;
    const now=opts.now||(()=>Date.now());
    const isLoaded=opts.isLoaded||Array.isArray;
    const setTimeoutFn=opts.setTimeoutFn||((fn,ms)=>setTimeout(fn,ms));
    const clearTimeoutFn=opts.clearTimeoutFn||(id=>clearTimeout(id));
    let lastSuccessAt=now();
    let inFlight=null;
    let timer=null;
    let listening=false;
    let rerun=null;
    let failures=0;
    let retryTimer=null;
    let runAtTimer=null;
    let stopped=false;

    async function refresh(reason){
      if(stopped||!opts.isVisible()||!opts.canRefresh())return false;
      if(inFlight){
        if(!opts.trailing)return inFlight;
        return rerun||(rerun=inFlight.then(()=>{rerun=null;return refresh(reason);}));
      }
      const date=opts.getDate();
      if(!date)return false;
      const mutationGeneration=opts.getMutationGeneration?opts.getMutationGeneration():null;
      inFlight=(async()=>{
        const loaded=await opts.loadDay(date);
        if(!isLoaded(loaded)||opts.getDate()!==date||!opts.canRefresh())return false;
        if(opts.getMutationGeneration&&opts.getMutationGeneration()!==mutationGeneration)return false;
        await opts.apply(date,reason||"timer",loaded);
        lastSuccessAt=now();
        failures=0;
        return true;
      })().catch(e=>{
        if(opts.onError)opts.onError(e);
        scheduleRetry();
        return false;
      }).finally(()=>{inFlight=null;});
      return inFlight;
    }

    function scheduleRetry(){
      const delays=opts.retryDelaysMs;
      if(stopped||!delays||!delays.length)return;
      failures+=1;
      if(retryTimer!=null)clearTimeoutFn(retryTimer);
      retryTimer=setTimeoutFn(()=>{retryTimer=null;refresh("retry");},delays[Math.min(failures,delays.length)-1]);
    }

    // One pending timed refresh (e.g. when a known lease lapses); a new time replaces it.
    function runAt(atMs,reason){
      if(runAtTimer!=null){clearTimeoutFn(runAtTimer);runAtTimer=null;}
      if(stopped||!Number.isFinite(atMs))return;
      runAtTimer=setTimeoutFn(()=>{runAtTimer=null;refresh(reason||"scheduled");},Math.max(0,atMs-now()));
    }

    function tick(){
      if(now()-lastSuccessAt>=intervalMs)refresh("timer");
    }

    function onVisibilityChange(){
      if(opts.isVisible()&&(opts.refreshOnVisible||now()-lastSuccessAt>=intervalMs))refresh("visible");
    }

    function start(){
      if(timer==null)timer=opts.setIntervalFn(tick,intervalMs);
      if(!listening){opts.addVisibilityListener(onVisibilityChange);listening=true;}
    }

    function stop(){
      stopped=true;
      if(timer!=null&&opts.clearIntervalFn)opts.clearIntervalFn(timer);
      timer=null;
      if(retryTimer!=null)clearTimeoutFn(retryTimer);
      if(runAtTimer!=null)clearTimeoutFn(runAtTimer);
      retryTimer=runAtTimer=null;
      if(listening&&opts.removeVisibilityListener)opts.removeVisibilityListener(onVisibilityChange);
      listening=false;
    }

    return {refresh,start,stop,runAt,tick,onVisibilityChange,isInFlight:()=>!!inFlight,lastSuccessAt:()=>lastSuccessAt};
  }
  return {createTaskRefreshCoordinator};
});
