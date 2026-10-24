// Canonical queue selectors shared by desktop and compact itinerary views.
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else {root.DCC=root.DCC||{};root.DCC.TaskQueues=api;}
})(typeof self!=='undefined'?self:this,function(){
function checkInDaysFor(props) {
    props = props || {};
    const explicit = Number(props.checkInDays);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const cad = String(props.checkInCadence || "").toLowerCase();
    if (cad === "daily") return 1;
    if (cad === "weekly") return 7;
    if (cad === "monthly") return 30;
    return 7;
  }
function parseLocalDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  function waitingRules({today,nowValue=new Date(),scoreClass=()=>''}) {
  
  
  function dayDiffFromToday(targetDate, now) {
    const today0 = new Date(now || Date.now());
    today0.setHours(0, 0, 0, 0);
    const tgt0 = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
    return Math.round((tgt0.getTime() - today0.getTime()) / 86400000);
  }
  function itemUrgency(item) {
    const p = item.properties || {};
    if (p.checkInRepeat === false && !p.checkInDate) {
      return { score: 0, cls: "", timing: { cadence: 0, elapsed: 0, remaining: Infinity, progress: 0 } };
    }
    const anchorIso = p.lastCheckedAt || item.created_at || p.createdAt || null;
    const now = new Date(nowValue);
    const anchor = parseLocalDate(String(anchorIso || "").slice(0, 10)) || new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let target = parseLocalDate(p.checkInDate);
    if (!target) {
      target = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
      target.setDate(target.getDate() + checkInDaysFor(p));
    }
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const cadence = Math.max(1, Math.round((target.getTime() - anchor.getTime()) / 86400000));
    const elapsed = Math.max(0, Math.round((today.getTime() - anchor.getTime()) / 86400000));
    const remaining = dayDiffFromToday(target, now);
    const progress = remaining <= 0 ? 100 : Math.max(0, Math.min(99, Math.round((elapsed / cadence) * 100)));
    const timing = { cadence, elapsed, remaining, progress };
    return { score: progress, cls: scoreClass(progress), timing };
  }
  function sortByUrgency(a, b) {
    const doneA = isDoneDelegated(a);
    const doneB = isDoneDelegated(b);
    if (doneA !== doneB) return doneA ? 1 : -1;
    const readyA = isTaskDependency(a) && (a.properties || {}).status === "ready";
    const readyB = isTaskDependency(b) && (b.properties || {}).status === "ready";
    if (readyA !== readyB) return readyA ? -1 : 1;
    if (isTaskDependency(a) !== isTaskDependency(b)) return isTaskDependency(a) ? -1 : 1;
    const sa = itemUrgency(a).score;
    const sb = itemUrgency(b).score;
    if (sb !== sa) return sb - sa;
    return ((a.properties || {}).title || "").localeCompare((b.properties || {}).title || "");
  }
  function isDoneDelegated(item) {
    if (!item) return false;
    const p = item.properties || {};
    return !!p.completedAt || p.status === "done" || p.status === "unblocked";
  }
  function isOpenDelegated(item) {
    return !isDoneDelegated(item);
  }
  function wantsCheckIn(item) {
    if (!isOpenDelegated(item) || isSnoozed(item) || isTaskDependency(item)) return false;
    const p = item.properties || {};
    if (p.checkInRepeat === false && !p.checkInDate) return false;
    // Once a real check-in task owns this cycle, it needs no second decision row. The
    // triage draft remains available for review/send.
    if (p.checkInTaskId && p.checkInScheduledFor && p.checkInScheduledFor >= today) return false;
    return true;
  }
  function isOverdue(item) {
    return wantsCheckIn(item) && itemUrgency(item).timing.remaining < 0;
  }
  function isTaskDependency(item) {
    const p = (item && item.properties) || {};
    return p.blockerType === "task" && !!p.blockerBlockId && !!p.linkedBlockId;
  }
  function isSnoozed(item) {
    const until = String(((item.properties || {}).snoozedUntil) || "");
    return /^\d{4}-\d{2}-\d{2}$/.test(until) && until > today;
  }
  function attentionItems(items) {
    return items.filter(item => {
      if (!wantsCheckIn(item)) return false;
      const u = itemUrgency(item);
      return u.score >= 70 || u.timing.remaining < 0;
    });
  }
    return {itemUrgency,sortByUrgency,isDoneDelegated,isOpenDelegated,wantsCheckIn,isOverdue,isTaskDependency,isSnoozed,attentionItems};
  }
  function activeTriage(items,{dismissed={},scheduled={},deleted=[],suppressed={}}={}) {
    return (items||[]).filter(i=>!dismissed[i.id]&&!scheduled[i.id]&&!deleted.includes(i.id)&&!suppressed[i.id]);
  }
  function durationOf(item){const n=Number(item&&(item.durMin||item.duration));return Number.isFinite(n)&&n>0?n:30;}
  function createdMs(item){const t=new Date((item&&(item.createdAt||item.addedAt||item.added_at))||0).getTime();return Number.isFinite(t)?t:0;}
  function selectWhenever(items){return (Array.isArray(items)?items:[]).filter(i=>i&&i.stage==='Whenever'&&i.status!=='done'&&i.done!==true).slice().sort((a,b)=>durationOf(a)-durationOf(b)||createdMs(a)-createdMs(b)||String(a.title||'').localeCompare(String(b.title||'')));}
  function orderUnscheduled(rows,order,getCreated=ev=>ev&&(ev.createdAt||(ev.__unf&&ev.__unf.sourceDate))||'') {
    if(!order.length)return rows;
    const positions=new Map(order.map((id,i)=>[id,i]));
    return rows.slice().sort((a,b)=>(positions.get(a.id)??9999)-(positions.get(b.id)??9999)||Number(!!a.__unf)-Number(!!b.__unf)||String(getCreated(b)).localeCompare(String(getCreated(a))));
  }
  return {checkInDaysFor,parseLocalDate,orderUnscheduled,waitingRules,activeTriage,durationOf,selectWhenever};
});
