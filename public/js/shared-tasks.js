// Participation decorates ordinary owned task cards. Completion still uses
// schedule.js / block-store's revision-checked, account-scoped durable outbox.
(function () {
  'use strict';
  const D = window.DCC, esc = D.esc;
  let shares = [], notifications = [], notificationPreferences = {enabled:true}, syncWarning = '', fresh = false, loading = null, again = false;
  const api = (path = '', options) => D.api('/api/shared-tasks' + path, options);
  const forTask = id => shares.find(s => s.taskId === id && s.state === 'accepted');
  async function timedApi(path,options={}) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try {return await api(path,{...options,signal:controller.signal});}finally{clearTimeout(timer);}
  }
  function badge(share, ev) {
    const accepted = share.participants.filter(p => p.state === 'accepted');
    const done = p => p.self && ev && typeof isDone === 'function' ? isDone(ev) : p.completed;
    const count = accepted.filter(done).length;
    const label = accepted.length > 1 && count === accepted.length ? 'All done' : count + '/' + accepted.length + ' done';
    const people = share.participants.map(p => {
      const complete = done(p), text = p.name + (p.self ? ' (you)' : '') + (p.state === 'pending' ? ': invited' : complete ? ': completed' : ': not completed');
      // Profile photos only; never load arbitrary data/javascript URLs.
      const photo = /^https:\/\//i.test(p.avatar || '') ? '<img src="' + esc(p.avatar) + '" alt="" referrerpolicy="no-referrer">' : esc(Array.from(p.name || '?').slice(0,2).join('').toUpperCase());
      return '<span class="shared-avatar' + (complete ? ' completed' : '') + '" role="img" aria-label="' + esc(text) + '" title="' + esc(text) + '">' + photo + (complete ? '<b aria-hidden="true">✓</b>' : '') + '</span>';
    }).join('');
    return people + '<span class="shared-count">' + label + '</span>';
  }
  function placeBadge(host) {
    const card=host.closest?.('.it-list-item');
    if(!card)return;
    const head=card.querySelector(':scope > .it-list-main > .it-list-title-row');
    if(!head)return;
    const active=host.classList.contains('has-participants');
    host.classList.toggle('shared-card-corner',active);
    if(active && host.parentElement!==card)card.prepend(host);
    else if(!active && host.parentElement!==head)head.append(host);
  }
  function paint() {
    document.querySelectorAll('[data-shared-task]').forEach(host => {
      const share = forTask(host.dataset.sharedTask);
      host.classList?.toggle('has-participants',fresh && !!share);
      host.innerHTML = fresh && share ? badge(share, host._sharedTask) : esc(fresh ? 'Share task' : 'Sharing unavailable');
      placeBadge(host);
      host.setAttribute('aria-label', fresh && share ? 'Shared task participants: ' + share.title : 'Share this task occurrence');
    });
    const launcher = document.getElementById('shared-tasks-open');
    if (launcher) {
      const pending = shares.filter(s => s.state === 'pending').length;
      const unread=notificationPreferences.enabled ? notifications.filter(n=>!n.read).length : 0;
      launcher.textContent = 'Shared tasks' + (pending ? ' · ' + pending + ' invited' : '') + (unread ? ' · ' + unread + ' new' : '');
    }
    document.querySelectorAll('[data-shared-summary]').forEach(host => {
      const share = shares.find(s => s.id === host.dataset.sharedSummary);
      host.innerHTML = fresh && share ? badge(share) : 'Status unavailable · refresh to retry';
    });
  }
  async function refresh() {
    if (loading) { again = true; return loading; }
    loading = (async () => {
      try { const date=typeof _viewedDateStr === 'function' ? _viewedDateStr() : D.dates.todayKey();
        const today=D.dates.todayKey(), limit=new Date(Date.parse(today+'T12:00:00Z')+14*86400000).toISOString().slice(0,10);
        syncWarning='';
        // The generation horizon is not a read/invitation horizon. A one-off
        // occurrence remains usable on any valid past or future date.
        if(date>=today && date<=limit) {
          try {const synced=await timedApi('/sync',{method:'POST',body:{date}});
            if(synced.created)window.refreshDccStateFromServer?.();}
          catch (_) {syncWarning='New recurring tasks could not be prepared. Existing shared tasks are shown; refresh to retry.';}
        }
        const data = await timedApi('?date='+encodeURIComponent(date));
        shares = data.shares || []; notifications=data.notifications || []; notificationPreferences=data.notificationPreferences || {enabled:true}; fresh = true; }
      catch (_) { shares = []; notifications = []; fresh = false; } // Never retain another account's identity or stale green checkmarks.
      finally { loading = null; paint(); if (again) { again = false; void refresh(); } }
    })();
    return loading;
  }
  function attach(el, ev) {
    if (ev._dateless || !ev._blockId || !['task','focus','habit','workout'].includes(ev.type || 'task')) return;
    const head = el.querySelector('.it-list-title-row,.title-row,.compact-row');
    if (!head) return;
    const host = document.createElement('button');
    host.type = 'button'; host.className = 'shared-task-badge'; host.dataset.sharedTask = ev._blockId;
    host._sharedTask = ev;
    const share = forTask(ev._blockId);
    host.classList.toggle('has-participants',fresh && !!share);
    host.innerHTML = fresh && share ? badge(share,ev) : 'Share task';
    host.setAttribute('aria-label','Shared task participants: ' + (ev.title || 'Task'));
    host.onclick = e => { e.stopPropagation(); void open(ev); };
    head.append(host);
    placeBadge(host);
  }
  function instructionsHtml(plan) {
    if (!plan) return '<p>No workout instructions included. Each person chooses their own plan.</p>';
    const entries = plan.groups.flatMap(g => g.exerciseIds.map(id => plan.exercises.find(e => e.id === id))).filter(Boolean);
    return '<details class="shared-instructions"><summary>Workout instruction snapshot · '+entries.length+' movement cards</summary><p>Movement order, sides, authored cues and suggested pacing only. Personal weights/reps, results and timing are excluded. Review authored text before sharing it. Later edits do not change this snapshot.</p><ol>'+entries.map(e => '<li><strong>'+esc(e.name)+(e.side && e.side !== 'none' ? ' · '+esc(e.side) : '')+'</strong>'+ (e.movement ? '<p>'+esc(e.movement.visualInstructions)+'</p><p>Spoken cue: '+esc(e.movement.spokenCue)+'</p>' : '')+'</li>').join('') + plan.runs.map(r=>'<li>'+esc(r.name)+'</li>').join('')+'</ol></details>';
  }
  async function open(ev) {
    const body = document.createElement('div'); body.className = 'shared-tasks-dialog';
    body.textContent = 'Loading shared tasks…';
    D.modal({title:ev ? 'Share this task' : 'Shared tasks',body,actions:[{label:'Close'}]});
    let friends = [], preview = null;
    async function draw() {
      await refresh();
      if (!body.isConnected) return;
      if (!fresh) {
        body.innerHTML = '<p role="alert">Sharing is unavailable. Your own completion and workout log still save through the task.</p><button data-retry type="button">Retry</button>';
        body.querySelector('[data-retry]').onclick = draw; return;
      }
      if (ev) {
        try { friends = await D.api('/api/social/friends'); }
        catch (_) { friends = []; }
      }
      const share = ev ? forTask(ev._blockId) : null;
      preview = null;
      if (ev && !share) {
        try { preview = await api('/preview/'+encodeURIComponent(ev._blockId)); }
        catch (e) { preview = {error:e.message}; }
      }
      const visible = ev ? (share ? [share] : []) : shares;
      const history=ev ? notifications.filter(n=>n.shareId===share?.id) : notifications;
      const unread=notificationPreferences.enabled ? history.filter(n=>!n.read) : [];
      body.innerHTML = '<p>Share a title and date, with a separate task and completion for each person. Results, personal weights/reps, notes and timing stay private. You may include a reviewed instruction snapshot for each person’s Plan &amp; Log.</p><p>Choose this occurrence or, for an eligible scheduled repeat, this recurring routine. A routine invitation is accepted once; each scheduled date has separate completion and private logs. Leaving or removing a participant stops sharing for the whole routine.</p>' +
        '<div class="shared-task-status" role="status" aria-live="polite"></div>' +
        (syncWarning ? '<p role="alert">'+esc(syncWarning)+'</p>' : '') +
        '<label class="shared-include"><input type="checkbox" data-notification-preference'+(notificationPreferences.enabled ? ' checked' : '')+'> In-app completion alerts</label><p>Completion and reopening history stays here. Turning alerts off clears new badges; it does not affect invitations or anyone’s task.</p>' +
        (history.length ? '<details class="shared-notifications"><summary>Completion history'+(unread.length ? ' · '+unread.length+' unread' : '')+'</summary><ol>'+history.map(n=>'<li'+(!n.read && notificationPreferences.enabled ? ' class="unread"' : '')+'>'+esc(n.actorName)+' '+(n.completed ? 'completed' : 'reopened')+' '+esc(n.title)+' · '+esc(n.date)+(n.currentCompleted!==n.completed ? (n.currentCompleted ? ' (now completed)' : ' (now reopened)') : '')+'</li>').join('')+'</ol>'+(unread.length ? '<button data-read-notifications type="button">Mark shown updates read</button>' : '')+'</details>' : '') +
        visible.map(s => '<section class="shared-task-entry"><strong>' + esc(s.title) + '</strong><p>' + esc(s.date) + (s.scope==='series' ? ' · Recurring routine (accepted once)' : ' · This occurrence') + '</p>' + instructionsHtml(s.instructions) +
          (s.state === 'pending' ? '<p>You are invited to participate. Accept adds your own private task'+(s.scope==='series' ? ' for each scheduled occurrence from this date onward' : ' for this date')+' and shares only completion with the other accepted participants. You can leave at any time.</p><button data-action="accept" data-share="' + esc(s.id) + '">Accept</button> <button data-action="decline" data-share="' + esc(s.id) + '">Decline</button>' :
            '<div class="shared-summary" data-shared-summary="' + esc(s.id) + '">' + badge(s) + '</div>' +
            (s.isOwner ? s.participants.filter(p => !p.self).map(p => '<p>' + esc(p.name) + ' · ' + (p.state === 'pending' ? 'Invited' : 'Participating') + ' <button data-action="remove" data-share="' + esc(s.seriesId || s.id) + '" data-user="' + p.userId + '">Remove</button></p>').join('') :
              '<button data-action="remove" data-share="' + esc(s.seriesId || s.id) + '">Leave shared '+(s.scope==='series' ? 'routine' : 'task')+'</button>')) + '</section>').join('') +
        (!ev && !visible.length ? '<p>No shared tasks or invitations yet. Use Share task on a dated task card.</p>' : '') +
        (ev?.type === 'workout' && !share ? (preview?.instructions ? instructionsHtml(preview.instructions) + '<label class="shared-include"><input type="checkbox" data-include-instructions checked> Include this reviewed instruction snapshot</label>' : '<p>'+esc(preview?.error || 'No saved instructions yet. Save a workout in Plan & Log to include its movement cards, or invite with title/date only.')+'</p>') : '') +
        (ev && !share && preview?.seriesEligible ? '<label>Invitation scope <select data-scope><option value="occurrence">This occurrence</option><option value="series">This recurring routine · accept once</option></select></label>' : '') +
        (ev && (!share || share.isOwner) ? '<label>Invite an existing friend <select data-friend><option value="">Choose a friend</option>' + friends.filter(f => !share?.participants.some(p => p.userId === f.friend_id)).map(f => '<option value="' + f.friend_id + '">' + esc(f.name || f.username) + '</option>').join('') + '</select></label><button data-invite type="button">Send invitation</button><p>Only accepted friends are listed. Manage friendships in Social.</p>' : '') +
        '<button data-retry type="button">Refresh</button>';
      body.querySelector('[data-retry]').onclick = draw;
      body.querySelector('[data-notification-preference]').onchange=e=>mutate('/notification-preferences',{enabled:e.target.checked});
      body.querySelector('[data-read-notifications]')?.addEventListener('click',()=>mutate('/notifications/read',{ids:unread.map(n=>n.id)}));
      body.querySelector('[data-invite]')?.addEventListener('click', () => mutate('/invite',{taskId:ev._blockId,scope:share?.scope || body.querySelector('[data-scope]')?.value || 'occurrence',userId:Number(body.querySelector('[data-friend]').value),includeInstructions:!!body.querySelector('[data-include-instructions]')?.checked,instructionsHash:preview?.hash}));
      body.querySelectorAll('[data-action]').forEach(button => button.onclick = () => mutate('/' + encodeURIComponent(button.dataset.share) + '/respond',{
        action:button.dataset.action,...(button.dataset.user ? {userId:Number(button.dataset.user)} : {})
      }));
    }
    async function mutate(path, payload) {
      body.querySelectorAll('button,select,input').forEach(b => b.disabled = true);
      const status = body.querySelector('.shared-task-status'); status.textContent = 'Saving…';
      try {
        await api(path,{method:'POST',body:payload});
        // Re-read after acknowledgement; an uncertain acknowledgement can safely
        // be retried without creating a duplicate participant or private task.
        await draw();
        window.refreshDccStateFromServer?.();
      } catch (e) {
        status.textContent = e.message + ' — retry the same action or Refresh to check whether it saved.';
        body.querySelectorAll('button,select,input').forEach(b => b.disabled = false);
      }
    }
    await draw();
  }
  D.SharedTasks = {attach,refresh,open,badge};
  function start() {
    document.getElementById('shared-tasks-open')?.addEventListener('click',() => open());
    void refresh();
    setInterval(() => { if (!document.hidden) void refresh(); },15000);
    window.addEventListener('online',refresh);
    window.addEventListener('offline',() => { shares=[]; notifications=[]; fresh=false; paint(); });
    window.addEventListener('dcc:view-date-changed',refresh);
    window.addEventListener('dcc:data-ready',refresh);
    document.addEventListener('visibilitychange',() => { if (!document.hidden) void refresh(); });
    document.addEventListener('shared-tasks-changed',refresh);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',start); else start();
})();
