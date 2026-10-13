// Private files are an explicitly online feature. Successful files are durable;
// failed selections stay in this control for Retry while the Notes view is open.
(function () {
  'use strict';
  var DCC = window.DCC = window.DCC || {};
  // Panels re-mount on every list re-render (Quick Notes rebuilds all cards), so
  // reuse a recent list per account+parent instead of one GET per card per render.
  var LIST_TTL_MS = 30000, listCache = new Map();
  function mount(host, blockId, options) {
    var parentKind = options && options.kind === "note" ? "note" : "task";
    var old = host._taskAttachments;
    if (old) old.destroy();
    var panel = document.createElement('section');
    panel.className = 'task-file-panel';
    panel.setAttribute('aria-label', 'Private ' + parentKind + ' files');
    host.before(panel);
    var account = JSON.stringify(window.DCC_ACCOUNT_CONTEXT || null);
    var base = '/api/' + (parentKind === 'note' ? 'notes' : 'tasks') + '/' + encodeURIComponent(blockId || '') + '/attachments';
    var live = true, busy = false, pending = [], files = [], currentXHR, listed = !blockId;
    var initialized = Promise.resolve();
    var label = document.createElement('label');
    label.textContent = 'Attach private files ';
    var picker = document.createElement('input');
    picker.type = 'file'; picker.multiple = true;
    picker.accept = '.pdf,.png,.jpg,.jpeg,.webp,.txt,.csv,.md';
    label.appendChild(picker); panel.appendChild(label);
    var hint = document.createElement('p');
    hint.textContent = 'PDF, images, text, Markdown or CSV · 10 MB each · 20 files per ' + parentKind + '. Uploads and downloads require a connection.';
    panel.appendChild(hint);
    var list = document.createElement('div'); panel.appendChild(list);
    var status = document.createElement('p'); status.setAttribute('role', 'status'); panel.appendChild(status);
    var progress = document.createElement('progress'); progress.max = 100; progress.hidden = true;
    progress.setAttribute('aria-label', 'File upload progress'); panel.appendChild(progress);
    var retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry failed files'; retry.hidden = true;
    panel.appendChild(retry);
    function sameAccount() {
      if (account !== JSON.stringify(window.DCC_ACCOUNT_CONTEXT || null)) throw new Error('Account changed. Reopen task Notes before accessing files.');
    }
    var cacheKey = account + ' ' + base;
    async function request(path, method) {
      sameAccount();
      if (method) listCache.delete(cacheKey);
      var body = await DCC.api(base + path, { method: method || 'GET', credentials: 'same-origin', cache: 'no-store', headers: method ? { 'X-DCC-Attachment': '1' } : {}, errorLabel: 'Task file request failed' });
      sameAccount();
      return body;
    }
    function draw() {
      if (!live) return;
      list.replaceChildren();
      files.forEach(function (file) {
        var row = document.createElement('div'); row.className = 'task-file-row';
        if (file.removed || file.pending) {
          var text = document.createElement('span'); text.textContent = file.filename + (file.removed ? ' — removed' : ' — upload incomplete; select the same file to retry'); row.appendChild(text);
        } else {
          var link = document.createElement('a'); link.className = 'task-source-pill';
          link.href = base + '/' + encodeURIComponent(file.id) + '/download';
          link.textContent = file.filename + ' ↓'; link.setAttribute('aria-label', 'Download private file: ' + file.filename);
          link.onclick = async function (event) {
            event.preventDefault();
            try {
              sameAccount();
              var response = await fetch(link.href, { credentials: 'same-origin', cache: 'no-store' });
              if (!response.ok) { var errorBody = await response.json().catch(function () { return {}; }); throw new Error(errorBody.error || 'Download failed'); }
              var blob = await response.blob(); sameAccount();
              if (!live) return;
              var url = URL.createObjectURL(blob), download = document.createElement('a');
              download.href = url; download.download = file.filename; document.body.appendChild(download); download.click(); download.remove();
              window.setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
              status.textContent = 'Downloaded ' + file.filename;
            } catch (error) { if (live) status.textContent = error.message; }
          };
          row.appendChild(link);
        }
        var action = document.createElement('button'); action.type = 'button';
        action.textContent = file.removed ? 'Undo removal' : 'Remove'; action.disabled = busy;
        action.setAttribute('aria-label', action.textContent + ': ' + file.filename);
        action.onclick = async function () {
          if (busy) return;
          if (!file.removed && !window.confirm('Remove “' + file.filename + '” from this ' + parentKind + '? It will stop downloading. Undo removal restores it; the private original is retained.')) return;
          var wasRemoved = file.removed;
          busy = true; picker.disabled = true; draw();
          try { await request('/' + file.id + (file.removed ? '/restore' : ''), file.removed ? 'POST' : 'DELETE'); await refresh(); status.textContent = wasRemoved ? 'File restored' : 'File removed. The private original is retained; Undo removal restores it.'; }
          catch (error) { status.textContent = error.message; }
          finally { busy = false; picker.disabled = false; draw(); }
        };
        row.appendChild(action); list.appendChild(row);
      });
      pending.forEach(function (entry) {
        var text = document.createElement('p'); text.textContent = entry.file.name + ' — ' + (entry.error || 'waiting to upload'); list.appendChild(text);
      });
      retry.hidden = !pending.length; retry.disabled = busy;
    }
    async function refresh(useCache) {
      var cached = useCache && listCache.get(cacheKey);
      var result = cached && Date.now() - cached.at < LIST_TTL_MS ? cached.result : await request('');
      if (!cached || result !== cached.result) listCache.set(cacheKey, { at: Date.now(), result: result });
      files = result.files.slice(); listed = true; draw();
      if (!result.configured) status.textContent = 'Private ' + parentKind + ' file storage is not configured. Your selection remains available for Retry while Notes is open.';
      return result;
    }
    function send(entry) {
      sameAccount();
      // Any attempt may leave a server reservation, success or not.
      listCache.delete(cacheKey);
      return new Promise(function (resolve, reject) {
        var xhr = currentXHR = new XMLHttpRequest();
        xhr.open('POST', base); xhr.withCredentials = true; xhr.timeout = 90000;
        xhr.setRequestHeader('X-DCC-Attachment', '1'); xhr.setRequestHeader('X-Upload-Id', entry.id);
        xhr.upload.onprogress = function (event) { if (live && event.lengthComputable) { progress.value = event.loaded / event.total * 100; if (event.loaded === event.total) status.textContent = 'Storing ' + entry.file.name + ' privately…'; } };
        xhr.onerror = function () { reject(new Error('Connection failed. Retry this file when online.')); };
        xhr.ontimeout = function () { reject(new Error('Upload timed out. Retry safely with the same upload identity.')); };
        xhr.onabort = function () { reject(new Error('Upload interrupted. Reopen Notes to check stored files.')); };
        xhr.onload = function () {
          try { sameAccount(); var result = JSON.parse(xhr.responseText); if (xhr.status < 200 || xhr.status >= 300) throw new Error(result.error || 'Upload failed'); resolve(result); }
          catch (error) { reject(error); }
        };
        var data = new FormData(); data.append('file', entry.file); xhr.send(data);
      });
    }
    async function run() {
      if (busy || !pending.length) return;
      busy = true; picker.disabled = true; progress.hidden = false; draw();
      // Snapshot avoids retrying a failing file indefinitely and retains successes.
      await initialized;
      var queue = pending.slice(), succeeded = 0;
      for (var entry of queue) {
        if (!live) break;
        try {
          status.textContent = 'Uploading ' + entry.file.name + '…'; progress.value = 0;
          var stored = await send(entry); pending = pending.filter(function (p) { return p !== entry; });
          files = files.filter(function (f) { return f.id !== stored.id; }); files.push(stored);
          succeeded++;
        } catch (error) { entry.error = error.message; }
        draw();
      }
      busy = false; picker.disabled = false; progress.hidden = true;
      status.textContent = pending.length ? succeeded + ' file(s) saved; ' + pending.length + ' failed. Retry keeps successful files. Failed selections are held only while Notes stays open.' : 'Private files saved';
      draw();
    }
    function add(selected) {
      if (!blockId) { status.textContent = 'Save this ' + parentKind + ' before attaching files.'; return; }
      if (busy) { status.textContent = 'Wait for the current upload before adding files.'; return; }
      for (var file of Array.from(selected)) {
        var incomplete = files.find(function (f) { return f.pending && !f.removed && f.filename === file.name && f.size === file.size; });
        if (!incomplete && pending.length + files.filter(function (f) { return !f.removed; }).length >= 20) { status.textContent = 'A ' + parentKind + ' can hold at most 20 files.'; break; }
        pending.push({ id: incomplete ? incomplete.id : window.crypto.randomUUID(), file: file });
      }
      run();
    }
    picker.onchange = function () { add(picker.files); picker.value = ''; };
    panel.ondragover = function (event) { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); };
    panel.ondrop = function (event) { if (event.dataTransfer.files.length) { event.preventDefault(); add(event.dataTransfer.files); } };
    retry.onclick = run;
    var api = { hasAttachments: function () { return !listed || busy || pending.length > 0 || files.length > 0; }, add: function (file) { add([file]); }, destroy: function () { live = false; if (currentXHR && currentXHR.readyState !== 4) currentXHR.abort(); panel.remove(); } };
    host._taskAttachments = api;
    if (!blockId) { picker.disabled = true; status.textContent = 'Save this ' + parentKind + ' before attaching files.'; }
    else initialized = refresh(true).catch(function (error) { if (live) status.textContent = error.message; });
    return api;
  }
  DCC.TaskAttachments = { mount: mount };
})();
