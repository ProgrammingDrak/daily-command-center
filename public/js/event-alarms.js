/* Event links are snapshots of acknowledged server blocks. Native Android owns delivery. */
(function() {
  'use strict';
  const native = window.DCCNativeAlarms, model = window.DCCEventAlarms;
  let definitions = [], running = false, generation = 0, initialRefresh = false;
  const page = document.getElementById('alarms-page');
  const send = payload => { if (!native?.postMessage) throw Error('Use the DCC Android app to save an event alarm on this phone.'); native.postMessage(JSON.stringify(payload)); };
  const status = text => { const el = document.getElementById('event-alarm-status'); if (el) el.textContent = text; };
  const get = async url => { let r; try { r = await fetch(url, {cache:'no-store', credentials:'same-origin'}); } catch (_) { throw Error('Event refresh failed (offline). Last saved timing remains until freshness expires.'); } if (!r.ok) { const e = Error('Event refresh failed ('+r.status+'). Last saved timing remains until freshness expires.'); e.status = r.status; throw e; } return r.json(); };
  function receive(reply) { if(reply.error){status("Phone rejected the alarm request. Open native Alarms to review its state.");return;} if (!Array.isArray(reply.alarms)) return; definitions = reply.alarms; render(); if(!initialRefresh){initialRefresh=true;refresh();} }
  window.addEventListener('dcc:native-alarm-status', e => receive(e.detail));
  if (page && native) native.onmessage = e => { try { receive(JSON.parse(e.data)); } catch (_) { status('Phone state unavailable. Use Device alarms.'); } };
  function description(blockId) {
    const a=definitions.find(a=>a.eventLink?.blockId===blockId);
    if(!a)return 'Saved event '+blockId+' · no linked alarm reported. Open Alarms to check this phone.';
    const l=a.eventLink;
    return 'Linked event '+blockId+' · '+l.offsetMinutes+' min before · '+(a.enabled?'enabled definition':'disabled')+' · next local delivery '+(a.nextAt?new Date(a.nextAt).toLocaleString():'not scheduled')+' · last DCC refresh '+new Date(l.checkedAt).toLocaleString()+'. Remote/calendar provider changes may lag.';
  }
  function render() {
    document.querySelectorAll('[data-event-alarm-block]').forEach(el=>{el.textContent=description(el.dataset.eventAlarmBlock);});
    const list = document.getElementById('phone-alarm-list'); if (!list) return;
    list.replaceChildren();
    for (const a of definitions) {
      const row = document.createElement('li'), title = document.createElement('strong'), detail = document.createElement('p');
      title.textContent = a.label + ' · ' + (a.enabled ? 'Enabled' : 'Disabled');
      const link = a.eventLink;
      detail.textContent = link ? 'Event '+link.blockId+' · '+link.offsetMinutes+' min before · '+new Date(link.startAt-link.offsetMinutes*60000).toLocaleString()+' · source zone '+link.sourceZone+' · last DCC refresh '+new Date(link.checkedAt).toLocaleString()+' · '+(model.usable(link, Date.now()) ? 'snapshot current (may change remotely)' : 'stale/unavailable: not armed') : 'Independent alarm · '+a.time+' · '+(a.mode==='once'?a.date:'repeat days '+a.days.join(', '));
      const next = document.createElement('p'); next.textContent = 'Local phone delivery · Next: '+(a.nextAt ? new Date(a.nextAt).toLocaleString() : 'not scheduled');
      row.append(title,detail,next);
      if (link) { const edit = document.createElement('a'); edit.href = '/public/alarms.html?event='+encodeURIComponent(link.blockId); edit.textContent = 'Review linked event / timing'; row.append(edit); }
      list.append(row);
    }
    if (!definitions.length) list.textContent = native ? 'No phone definitions returned yet. Open Device alarms to add an independent alarm.' : 'Native phone state is available in the DCC Android app. Browser prototype alarms are separate.';
  }
  async function refresh() {
    if (!native || running || document.hidden) return;
    running = true; let failed=false; const refreshButton=document.getElementById("refresh-event-alarms"); if(refreshButton)refreshButton.disabled=true; const current = generation;
    try {
      const context = await get('/api/alarm-context');
      for (const a of definitions.filter(a=>a.eventLink && a.eventLink.workspaceId === context.workspaceId)) {
        const old = a.eventLink;
        try {
          const block = await get('/api/blocks/'+encodeURIComponent(old.blockId));
          const link = model.snapshot(block, context.workspaceId, old.offsetMinutes);
          const scope=await get('/api/alarm-context');
          if (current === generation && scope.workspaceId===context.workspaceId) send({action:'syncEvent', eventLink:link});
        } catch (e) {
          failed=true; const scope=await get('/api/alarm-context');
          if (current === generation && scope.workspaceId===context.workspaceId && e.status === 404) send({action:'syncEvent',eventLink:{...old,state:'unavailable',checkedAt:Date.now(),validUntil:Date.now()+model.MAX_AGE}});
          else status(e.message);
        }
      }
      if (current === generation) {send({action:'status'});if(!failed)status('Refreshed saved DCC event links. Check next local delivery below; provider changes may still lag.');}
    } catch (e) { status(e.message); }
    finally { running = false; if(refreshButton)refreshButton.disabled=false; }
  }
  async function reviewEvent(blockId, offset = 0, choices = {}) {
    const context = await get('/api/alarm-context');
    const block = await get('/api/blocks/'+encodeURIComponent(blockId));
    const link = model.snapshot(block,context.workspaceId,offset);
    if (link.state !== 'ready' || link.startAt-offset*60000 <= Date.now()) throw Error('Choose an available future event occurrence.');
    const scope=await get('/api/alarm-context');
    if(scope.workspaceId!==context.workspaceId)throw Error('Account changed; review the event again.');
    const a = {...model.proposal(link),...choices,enabled:false,eventLink:link};
    send({action:'reviewEvent',alarm:a});
    status('Review on the native Alarms page. The linked definition starts disabled; enable it on this phone after reviewing readiness.');
  }
  window.DCCEventAlarmUI = {
    open(blockId) { location.href = '/public/alarms.html?event='+encodeURIComponent(blockId); },
    async afterCreate(persisted,offset) { try { const block = await persisted; if (!block?.id) throw Error('Save and sync the event first.'); await reviewEvent(block.id,offset); } catch(e) { if (window.showToast) window.showToast('Event saved; alarm not saved: '+e.message,'error'); } },
    refresh, description
  };
  window.addEventListener('dcc:native-auth-cancel',()=>{generation++;definitions=[];render();});
  window.addEventListener('online',refresh);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  window.setInterval(refresh,60000);
  if (native && page) send({action:'status'});
  if (!page) return;
  document.getElementById('manage-phone-alarms').onclick = () => {try{send({action:'open'});}catch(e){status(e.message);}};
  document.getElementById('refresh-event-alarms').onclick = refresh;
  const form = document.getElementById('linked-alarm-form');
  const eventId = new URLSearchParams(location.search).get('event');
  if (eventId) form.elements.event.value = eventId;
  form.onsubmit = async e => { e.preventDefault(); const data = new FormData(form); try { await reviewEvent(String(data.get('event')),Number(data.get('offset')), {challenge:data.get('challenge'),difficulty:data.get('difficulty'),count:Number(data.get('count'))}); } catch(err) {status(err.message);} };
  if (eventId) get('/api/blocks/'+encodeURIComponent(eventId)).then(b=>{document.getElementById('event-link-name').textContent = 'Linked event: '+(b.properties?.title||b.properties?.text||b.id)+' · stable ID '+b.id;}).catch(e=>status(e.message));
  render();
})();
