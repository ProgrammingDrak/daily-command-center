/* global DccLoginReturn */
(function () {
  'use strict';
  const get = id => document.getElementById(id);
  const glasses = document.body.dataset.pairingView === 'glasses';
  let busy = false, polling = null, timer = null, active = false, approval = null, disposed = false;
  let connected = false;
  let nextPoll = 3000;
  function feedback(message) {
    get('feedback').textContent = message || '';
    get('feedback').hidden = !message;
  }
  async function request(action, data = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/auth/device/' + action, {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Device-Pairing': '1' },
        body: JSON.stringify(data)
      });
      if (response.status === 401 && !glasses) {
        location.href = '/login?next=' + encodeURIComponent('/connect-glasses');
        throw new Error('Sign in to DCC on your phone to continue.');
      }
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not connect. Please try again.');
      return body;
    } finally { clearTimeout(timeout); }
  }
  async function act(callback) {
    if (busy) return;
    busy = true;
    feedback('');
    document.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      if (polling) await polling;
      if (connected) return;
      await callback();
    }
    catch (error) { feedback(error.message || 'Could not connect. Please try again.'); }
    finally {
      busy = false;
      document.querySelectorAll('button').forEach(button => { button.disabled = false; });
      if (document.activeElement === document.body) {
        [...document.querySelectorAll('button')].find(button => button.getClientRects().length)?.focus();
      }
      schedule();
    }
  }
  function pause() { clearTimeout(timer); timer = null; }
  function schedule() {
    pause();
    if (disposed || !glasses || !active || busy || polling || document.hidden) return;
    timer = setTimeout(poll, nextPoll);
  }
  function finish() {
    connected = true;
    active = false;
    pause();
    const next = DccLoginReturn.normalize(new URLSearchParams(location.search).get('next'));
    location.replace(next === '/' ? '/?device=glasses' : next);
  }
  function updateGlasses(data) {
    if (data.state === 'connected') { finish(); return; }
    const expired = data.state === 'expired';
    active = !expired;
    get('pair-start').hidden = true;
    get('pair-waiting').hidden = false;
    get('pair-title').textContent = expired ? 'Code expired' : 'Connect your glasses';
    get('pair-code').hidden = expired;
    get('pair-renew').hidden = !expired;
    if (data.code) {
      get('pair-code').textContent = data.code.slice(0, 3) + ' ' + data.code.slice(3);
      get('pair-code').setAttribute('aria-label', 'Pairing code ' + data.code.split('').join(' '));
    }
    const minutes = Math.max(1, Math.ceil((Date.parse(data.expiresAt) - Date.now()) / 60000));
    get('pair-expiry').textContent = expired
      ? 'Get a new code, then enter it on your phone.'
      : 'Code expires in ' + minutes + (minutes === 1 ? ' minute.' : ' minutes.');
  }
  async function poll() {
    pause();
    if (busy || polling || !active || disposed || document.hidden) return;
    let finishPolling;
    polling = new Promise(resolve => { finishPolling = resolve; });
    try {
      const data = await request('status');
      if (disposed) return;
      if (data.state === 'connected') { updateGlasses(data); return; }
      if (busy) return;
      updateGlasses(data);
      feedback('');
      if (data.state === 'approved') {
        const result = await request('redeem');
        if (!disposed && (result.state === 'connected' || !busy)) updateGlasses(result);
      }
      nextPoll = 3000;
    } catch {
      nextPoll = Math.min(nextPoll * 2, 30000);
      if (!disposed && !busy) feedback('Connection interrupted. Retrying while this page is open.');
    } finally {
      polling = null;
      finishPolling();
      schedule();
    }
  }
  function phoneView(id) {
    for (const name of ['phone-code', 'phone-confirm', 'phone-complete']) get(name).hidden = name !== id;
  }
  if (glasses) {
    const params = new URLSearchParams(location.search);
    const next = DccLoginReturn.normalize(params.get('next'));
    get('browser-signin').href = '/login?method=browser&next=' + encodeURIComponent(next);
    get('pair-begin').addEventListener('click', () => act(async () => {
      updateGlasses(await request('start'));
    }));
    get('pair-renew').addEventListener('click', () => act(async () => {
      updateGlasses(await request('start'));
    }));
    get('pair-cancel').addEventListener('click', () => act(async () => {
      await request('cancel');
      active = false;
      pause();
      get('pair-start').hidden = false;
      get('pair-waiting').hidden = true;
      get('pair-begin').focus();
    }));
    // Reload resumes only this glasses browser's cookie-bound request.
    act(async () => {
      const data = await request('status');
      if (data.state !== 'expired') updateGlasses(data);
    });
    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('pagehide', () => { disposed = true; pause(); });
    window.addEventListener('pageshow', () => { disposed = false; schedule(); });
  } else {
    get('pair-form').addEventListener('submit', event => {
      event.preventDefault();
      act(async () => {
        approval = await request('inspect', { code: get('pair-input').value });
        get('matching-code').textContent = approval.code.slice(0, 3) + ' ' + approval.code.slice(3);
        get('pair-account').textContent = 'Signed in as ' + approval.account;
        phoneView('phone-confirm');
        get('pair-approve').focus();
      });
    });
    get('pair-change').addEventListener('click', () => {
      approval = null;
      feedback('');
      phoneView('phone-code');
      get('pair-input').focus();
    });
    get('pair-approve').addEventListener('click', () => act(async () => {
      if (!approval) throw new Error('Enter your glasses code again.');
      await request('approve', { challenge: approval.challenge });
      approval = null;
      phoneView('phone-complete');
      get('phone-complete').querySelector('h1').focus();
    }));
  }
})();
