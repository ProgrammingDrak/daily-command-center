// Thin client over existing owner-session APIs; only a retry receipt lives locally.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./workout-model'));
  else root.GlassesSession = factory(root.WorkoutModel);
})(typeof self !== 'undefined' ? self : this, function (W) {
  'use strict';
  const issue = (message, status = 0) => Object.assign(new Error(message), { status });
  const identity = me => {
    if (!me.userId || !me.workspaceId) throw issue('Sign in to your DCC workspace.', 401);
    return String(me.userId) + ':' + String(me.workspaceId);
  };
  function create({ request, storage, uuid, online = () => true, changed = () => {} }) {
    const s = { row: null, rows: [], busy: false, pending: null, error: '', status: 'Opening…', code: 0, account: null };
    const notify = () => changed(s);
    const key = () => 'dcc.glasses.pending.v1:' + s.account;
    async function verify() {
      const account = identity(await request('/api/me'));
      if (s.account && account !== s.account) {
        s.row = null; s.rows = []; throw issue('The signed-in account changed. Reload to open its routines.', 403);
      }
      s.account = account;
    }
    function eligible(row) {
      return row?.record?.taskType === 'workout' && !row.removed && !row.archived && W.guidanceSteps(W.upgrade(row.record).plan).length > 0;
    }
    async function row(id) {
      const r = await request('/api/activity/tasks/' + encodeURIComponent(id));
      if (!eligible(r)) throw issue('This routine is unavailable. Open DCC to review its plan.', 404);
      r.record = W.upgrade(r.record); return r;
    }
    async function run(fn) {
      if (s.busy) return;
      s.busy = true; s.error = ''; s.code = 0; notify();
      try {
        if (!online()) throw issue('Offline. No change was sent. Reconnect and retry.');
        await fn();
      } catch (e) {
        s.code = e.status || 0;
        s.error = s.code === 401 ? 'Sign in again, then return here. Your last confirmed position is safe.'
          : s.code === 409 ? 'Changed in another window. Reload the saved routine before continuing.' : e.message;
        s.status = s.pending ? 'Change unconfirmed' : 'Needs attention';
      } finally { s.busy = false; notify(); }
    }
    function remember(pending) {
      // Never send if the retry identity cannot survive reload/storage failure.
      try { storage.setItem(key(), JSON.stringify(pending)); }
      catch { throw issue('Local recovery storage is unavailable. No change was sent. Enable storage and retry.'); }
      s.pending = pending;
    }
    async function sendPending() {
      await verify();
      const p = s.pending;
      if (!p || p.account !== s.account) throw issue('This retry belongs to another account.', 403);
      s.status = 'Saving…'; notify();
      const result = await request(p.url, { method: p.method, body: p.body });
      if (p.kind === 'completion' && (result.ok !== true || result.mutationId !== p.body.mutationId)) throw issue('Completion acknowledgement was invalid. Check the saved state before retrying.');
      const fresh = await row(p.taskId);
      // A retry may return an old receipt after somebody reopened a completed task.
      // Always render the current server state rather than the historical response.
      storage.removeItem(key()); s.pending = null; s.row = fresh; s.status = 'Synced';
    }
    async function load({ taskId, date, discardConflict = false }) {
      return run(async () => {
        await verify();
        if (discardConflict && s.pending) { storage.removeItem(key()); s.pending = null; }
        const raw = storage.getItem(key());
        if (raw) {
          const p = JSON.parse(raw);
          const base = '/api/' + (p.kind === 'completion' ? 'tasks/' : 'activity/tasks/') + encodeURIComponent(p.taskId);
          if (p.account !== s.account || !['guidance', 'completion'].includes(p.kind) || p.url !== base + (p.kind === 'completion' ? '/completion' : '') || p.method !== (p.kind === 'completion' ? 'POST' : 'PUT') || !p.body?.mutationId) throw issue('Recovery receipt is invalid. Clear this site’s local recovery data before continuing.');
          s.pending = p; taskId = p.taskId;
        }
        if (taskId) { s.row = null; s.row = await row(taskId); }
        else {
          s.row = null;
          const data = await request('/api/activity?from=' + encodeURIComponent(date) + '&to=' + encodeURIComponent(date));
          s.rows = data.records.filter(eligible);
        }
        s.status = s.pending ? 'Change unconfirmed · retry to check' : 'Synced';
      });
    }
    async function guide(command) {
      return run(async () => {
        if (s.pending || !s.row || s.row.completed) return;
        await verify();
        const record = W.guide(s.row.record, command);
        remember({ account: s.account, kind: 'guidance', taskId: s.row.taskId,
          url: '/api/activity/tasks/' + encodeURIComponent(s.row.taskId), method: 'PUT',
          body: { record, expectedRevision: s.row.revision, mutationId: uuid() } });
        await sendPending();
      });
    }
    async function complete() {
      return run(async () => {
        if (s.pending || !s.row || s.row.completed || s.row.record.guidance?.status !== 'finished') return;
        await verify();
        const fresh = await row(s.row.taskId);
        s.row = fresh;
        if (fresh.completed) { s.status = 'Synced'; return; }
        if (fresh.record.guidance?.status !== 'finished') throw issue('Guidance changed. Review the saved card before completing.', 409);
        const block = await request('/api/blocks/' + encodeURIComponent(fresh.taskId));
        remember({ account: s.account, kind: 'completion', taskId: fresh.taskId,
          url: '/api/tasks/' + encodeURIComponent(fresh.taskId) + '/completion', method: 'POST',
          body: { completed: true, taskDate: fresh.date, expectedRevision: block.properties?._completionRevision || null, mutationId: uuid() } });
        await sendPending();
      });
    }
    function leaveUnresolved() {
      if (s.busy || !s.pending) return;
      storage.setItem(key() + ':unresolved:' + s.pending.body.mutationId, JSON.stringify(s.pending));
      storage.removeItem(key()); s.pending = null; s.row = null; s.status = 'Left unresolved · change not confirmed'; notify();
    }
    return { state: s, load, guide, complete, retry: () => run(sendPending), leaveUnresolved };
  }
  return { create };
});
