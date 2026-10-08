(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DCCEventAlarms = api;
})(globalThis, function() {
  'use strict';
  const MAX_AGE = 24 * 60 * 60 * 1000;
  function zonedStart(date,time,zone) {
    const [y,m,d]=date.split('-').map(Number), [h,min]=time.split(':').map(Number);
    const target=Date.UTC(y,m-1,d,h,min);
    if(new Date(target).toISOString().slice(0,10)!==date) throw Error('Invalid event date.');
    const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
    const local=at=>{const p=Object.fromEntries(fmt.formatToParts(new Date(at)).map(x=>[x.type,x.value]));return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute);};
    const offsets=new Set([-36,-12,0,12,36].map(hours=>{const at=target+hours*3600000;return local(at)-at;}));
    const candidates=[...offsets].map(o=>target-o).sort((a,b)=>a-b);
    const exact=candidates.filter(at=>local(at)===target);
    if(exact.length)return exact[0]; // earlier fold
    const gap=candidates.filter(at=>local(at)>target).sort((a,b)=>local(a)-local(b));
    if(gap.length)return gap[0]; // move forward by gap
    throw Error('Event timezone could not be resolved.');
  }
  function snapshot(block, workspaceId, offsetMinutes, now = Date.now()) {
    if (!workspaceId || !block || !block.id || block.workspace_id !== workspaceId) throw Error('Save and sync this event in the current workspace first.');
    if (!Number.isInteger(offsetMinutes) || offsetMinutes < 0 || offsetMinutes > 1440) throw Error('Use an offset of 0–1440 minutes before start.');
    const p = block.properties || {};
    if (p.recurrence || p.rrule || p.recurringEventId || p.responsibilityId) throw Error('Choose a saved individual occurrence; recurring series are not supported yet.');
    const sourceZone = p.timeZone || globalThis.DCC_APP_TIME_ZONE;
    if (!sourceZone) throw Error("DCC event timezone unavailable. Refresh configuration first.");
    if(p.all_day || p.allDay)throw Error("Choose a timed event occurrence, not an all-day event.");
    let startAt;
    if (/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(p.start || '')) startAt = Date.parse(p.start);
    else if (/^\d{4}-\d\d-\d\d$/.test(block.date || '') && /^([01]\d|2[0-3]):[0-5]\d$/.test(p.start || '')) {
      startAt = zonedStart(block.date, p.start, sourceZone);
    } else throw Error('This event needs a dated start time; all-day and unscheduled events cannot have alarms.');
    if (!Number.isFinite(startAt)) throw Error('Invalid event start.');
    const state = block.deleted_at || p.status === 'cancelled' || p.status === 'canceled' || p.cancelled === true ? 'unavailable' : 'ready';
    return { workspaceId, blockId: String(block.id), title: String(p.title || p.text || 'Event').slice(0,80), startAt, offsetMinutes, checkedAt: now, validUntil: now + MAX_AGE, state, sourceZone, revision: String(block.updated_at || '') };
  }
  function windowOrModel() { return typeof module === 'object' ? require('./alarm-model') : globalThis.DCCAlarmModel; }
  function proposal(link, now = Date.now()) {
    const when = new Date(link.startAt - link.offsetMinutes * 60000);
    return { id: globalThis.crypto.randomUUID(), label: link.title, date: windowOrModel().dayKey(when), time: String(when.getHours()).padStart(2,'0') + ':' + String(when.getMinutes()).padStart(2,'0'), mode:'once', days:[], challenge:'math', difficulty:'easy', count:3, enabled:false, volume:0.15, snoozes:0, tone:'chime', createdAt:now, eventLink:link };
  }
  function usable(link, now) { return link.state === 'ready' && now >= link.checkedAt - 60000 && now <= link.validUntil && link.validUntil - link.checkedAt === MAX_AGE; }
  return { snapshot, proposal, usable, zonedStart, MAX_AGE };
});
