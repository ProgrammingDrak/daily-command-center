// Journal task editor: a handwritten page (Mycelium Ink strokes/canvas, reused
// unmodified) plus optional typed notes, opened from an ordinary DCC task.
//
// Durability contract (docs/journal-task-plan.md):
//   - every committed stroke / typed pause is written to IndexedDB first
//     (JournalPageStore); the status line never says "saved" before oncomplete
//   - a failed local write is shown and blocks a lossy close until the user
//     retries or explicitly discards
//   - the server copy follows through JournalPageSync, which acknowledges only
//     the revision the server actually accepted
//   - each editor session is bound to one journalId; late async results for a
//     previous task never touch the current editor
(function () {
  "use strict";
  const D = window.DCC = window.DCC || {};
  const INK_SCRIPTS = ["/public/js/ink/strokes.js", "/public/js/ink/canvas.js"];
  const FINGER_PREF = "dcc-journal-finger-draw";
  const TYPING_DELAY = 400;
  const TOOLS = [
    { id: "ballpoint", label: "Pen", size: 2.6 },
    { id: "highlighter", label: "Highlighter", size: 14 },
    { id: "eraser", label: "Eraser" },
  ];
  const COLORS = ["#1b1b2f", "#2563eb", "#dc2626", "#16a34a"];

  let storeInstance = null;
  let current = null;
  let seq = 0;
  const syncs = new Map();
  // Pages whose latest strokes could not be written on this device and whose
  // editor has since closed (replaced by another dialog). Kept in memory, retried,
  // restored on reopen, and guarded by beforeunload. Never silently dropped.
  const unsaved = new Map();
  let unsavedTimer = null;
  let inkReady = null;

  // The tab's account is captured once, like account-context.js does for API
  // headers. Every local database and every request stays bound to it; if the
  // page's account context changes, journal work stops until a reload.
  let tabAccount = null;
  function snapshot(a) { return a && Number.isSafeInteger(a.userId) && a.workspaceId ? { userId: a.userId, workspaceId: a.workspaceId } : null; }
  function account() {
    const live = snapshot(window.DCC_ACCOUNT_CONTEXT);
    if (!tabAccount) tabAccount = live;
    if (!tabAccount || !live || live.userId !== tabAccount.userId || live.workspaceId !== tabAccount.workspaceId) return null;
    return tabAccount;
  }
  function store() {
    const acct = account();
    if (!acct) throw new Error("Reload DCC to open your journal on this device.");
    if (!storeInstance) storeInstance = window.JournalPageStore.create({ account: acct });
    return storeInstance;
  }
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.async = false;
      s.onload = resolve; s.onerror = () => reject(new Error("Could not load the handwriting editor"));
      document.head.appendChild(s);
    });
  }
  function ensureInk() {
    if (window.InkStrokes && window.InkCanvas) return Promise.resolve();
    if (!inkReady) inkReady = INK_SCRIPTS.reduce((p, src) => p.then(() => loadScript(src)), Promise.resolve()).catch(e => { inkReady = null; throw e; });
    return inkReady;
  }
  function online() { return typeof navigator === "undefined" || navigator.onLine !== false; }

  // Every task row this tab knows (all days loaded into the block store).
  function blockRows() {
    const bs = window.blockStore;
    try { return bs && typeof bs.getByType === "function" ? bs.getByType("block") : []; }
    catch { return []; }
  }
  // The server row a page may be sent to: the row of the task the page is bound
  // to, and only if no OTHER row carries the same journalId. Never "the first row
  // carrying this journalId" (see binding.js). A task not yet in the block store
  // (created moments ago) is sent under its own id and the server checks it.
  function bindingError(r) {
    return Object.assign(new Error(r.state === "ambiguous"
      ? "Another task carries this journal's identity, so this page is not sent anywhere. It stays on this device."
      : "This task now has a different journal page, so this page is not sent. It stays on this device."), { code: "JOURNAL_BINDING", state: r.state });
  }
  function serverTaskFor(journalId, rec) {
    const keys = store().boundKeys(rec);
    const r = window.JournalTaskBinding.resolve(blockRows(), journalId, keys);
    if (r.state === "ok") {
      if (!keys.includes(r.taskId)) store().bindKeys(journalId, r.keys).catch(() => {});   // learn local -> server alias
      return r.taskId;
    }
    if (r.state === "pending") return rec.taskId;
    throw bindingError(r);
  }

  // One outbox per page, kept alive after the editor closes until it is clean.
  function syncFor(journalId) {
    let s = syncs.get(journalId);
    if (!s) {
      s = window.JournalPageSync.create({
        store: store(), journalId, fetch: (url, init) => window.fetch(url, init), isOnline: online,
        resolveTaskId: rec => serverTaskFor(journalId, rec),
        isBusy: () => !!(current && current.journalId === journalId && current.penDown()),
        onStatus: st => { if (current && current.journalId === st.journalId) current.showSync(st); },
      });
      syncs.set(journalId, s);
    }
    return s;
  }

  // The account-context fetch wrapper adds this tab's X-DCC-User headers, so a
  // tab left over from a previous sign-in gets 409 ACCOUNT_CHANGED, not data.
  async function fetchServer(taskId) {
    if (!account()) throw Object.assign(new Error("This tab belongs to another account. Reload to continue."), { status: 409 });
    const res = await window.fetch("/api/journal/tasks/" + encodeURIComponent(taskId), { credentials: "same-origin" });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) throw Object.assign(new Error((data && data.error) || "Could not load the saved journal"), { status: res.status, code: data && data.code });
    return data;
  }

  // ── unsaved (in-memory only) pages ────────────────────────────────────────
  function stash(journalId, content) {
    unsaved.set(journalId, content);
    if (typeof showToast === "function") showToast("Journal strokes are not saved on this device yet. DCC keeps retrying; keep this tab open or reopen the journal.", "error", 10000);
    scheduleUnsavedRetry();
  }
  function scheduleUnsavedRetry() {
    if (unsavedTimer || !unsaved.size) return;
    unsavedTimer = setTimeout(async () => {
      unsavedTimer = null;
      for (const [journalId, content] of [...unsaved]) {
        if (current && current.journalId === journalId) continue; // the open editor owns it
        // Saved against the version the closed editor showed: if the page has
        // moved on since, this becomes a draft the user can choose, not an overwrite.
        try { const { stale } = await store().saveEdit(journalId, content.content, content.localRev, content.draftId); unsaved.delete(journalId); if (!stale) syncFor(journalId).nudge(); }
        catch { /* still failing; try again */ }
      }
      scheduleUnsavedRetry();
    }, 15000);
  }

  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => { if (v != null) node.setAttribute(k, v); });
    if (text != null) node.textContent = text;
    return node;
  }

  function buildBody() {
    const root = el("div", { class: "jt-editor" });
    const bar = el("div", { class: "jt-toolbar", role: "toolbar", "aria-label": "Journal tools" });
    TOOLS.forEach(t => bar.appendChild(el("button", { type: "button", class: "jt-tool", "data-jt-tool": t.id, "aria-pressed": "false" }, t.label)));
    const swatches = el("span", { class: "jt-swatches" });
    COLORS.forEach(c => { const b = el("button", { type: "button", class: "jt-swatch", "data-jt-color": c, "aria-label": "Ink color " + c, "aria-pressed": "false" }); b.style.background = c; swatches.appendChild(b); });
    bar.appendChild(swatches);
    bar.appendChild(el("button", { type: "button", class: "jt-tool", "data-jt-act": "undo", "aria-label": "Undo" }, "Undo"));
    bar.appendChild(el("button", { type: "button", class: "jt-tool", "data-jt-act": "redo", "aria-label": "Redo" }, "Redo"));
    bar.appendChild(el("button", { type: "button", class: "jt-tool", "data-jt-act": "finger", "aria-label": "Finger drawing" }, "Finger: auto"));
    bar.appendChild(el("button", { type: "button", class: "jt-tool", "data-jt-act": "notes", "aria-expanded": "false" }, "Typed notes"));
    root.appendChild(bar);
    const status = el("div", { class: "jt-status", role: "status", "aria-live": "polite" });
    status.appendChild(el("span", { class: "jt-status-text" }, "Opening…"));
    status.appendChild(el("button", { type: "button", class: "jt-retry", "data-jt-act": "retry", hidden: "" }, "Retry"));
    root.appendChild(status);
    const banner = el("div", { class: "jt-banner", hidden: "" });
    root.appendChild(banner);
    const wrap = el("div", { class: "jt-paper", "data-jt-paper": "" });
    wrap.appendChild(el("canvas", { class: "jt-base", "aria-label": "Handwritten journal page" }));
    wrap.appendChild(el("canvas", { class: "jt-live", "aria-hidden": "true" }));
    root.appendChild(wrap);
    const notes = el("label", { class: "jt-notes", hidden: "" });
    notes.appendChild(el("span", { class: "am-section-label" }, "Typed notes"));
    notes.appendChild(el("textarea", { class: "jt-notes-input", rows: "5", maxlength: "20000", placeholder: "Optional typed notes" }));
    root.appendChild(notes);
    return root;
  }

  function createSession(opts) {
    const session = { id: ++seq, taskId: opts.taskId, journalId: opts.journalId, alive: true,
      // Every id of THIS task; the page store refuses writes for a page bound elsewhere.
      taskKeys: (opts.taskKeys && opts.taskKeys.length ? opts.taskKeys : [opts.taskId]).filter(Boolean) };
    const body = buildBody();
    const q = sel => body.querySelector(sel);
    const statusText = q(".jt-status-text"), retryBtn = q(".jt-retry"), banner = q(".jt-banner");
    const textarea = q(".jt-notes-input");
    let ink = null;
    let writing = null, queued = false, failed = null, typingTimer = null;
    let pendingClose = null, discard = false, ready = false;
    let syncState = null;
    let closeResolvers = [];
    let panCleanup = null;
    let actionBusy = false;
    // The content version this editor displays (page-store localRev) and this
    // session's draft slot. Every save names the version; a mismatch means the
    // displayed page is stale and the save is kept as a draft instead.
    session.localRev = 0;
    session.draftId = window.JournalPageStore.newJournalId().replace(/^jr_/, "draft_");
    session.stale = false;

    // ── status line ──────────────────────────────────────────────────────────
    function paint() {
      if (!session.alive || session.openFailed) return;
      let text, tone = "ok", retry = false;
      if (failed) { text = "Not saved on this device: " + (failed.message || "storage error"); tone = "error"; retry = true; }
      else if (busy()) text = "Saving…";   // includes typing not yet written
      else if (session.stale) { text = "Your writing is saved on this device · this page also changed elsewhere"; tone = "warn"; }
      else if (!syncState) text = ready ? "Saved on this device" : "Opening…";
      else {
        const s = syncState;
        if (s.state === "synced") text = "Saved and synced";
        else if (s.state === "syncing") text = "Saved on this device · syncing…";
        else if (s.state === "pending") text = "Saved on this device";
        else if (s.state === "conflict") { text = "Saved on this device · changed on another device"; tone = "warn"; }
        else if (s.state === "signed-out") { text = s.message; tone = "warn"; retry = true; }
        else if (s.state === "error") { text = s.message; tone = "error"; retry = true; }
        else { text = s.message || "Saved on this device"; tone = "warn"; retry = s.state === "retrying"; }
      }
      statusText.textContent = text;
      body.dataset.jtState = failed ? "local-failed" : busy() ? "saving" : session.stale ? "stale" : (syncState ? syncState.state : "local");
      q(".jt-status").dataset.tone = tone;
      retryBtn.hidden = !retry;
    }
    session.showSync = st => { syncState = st; paint(); if (st.state === "conflict") review(); };

    function showBanner(message, actions) {
      banner.replaceChildren(el("span", null, message));
      actions.forEach(a => { const b = el("button", { type: "button", class: "jt-banner-btn", "data-jt-banner": a.id }, a.label); b.onclick = a.onClick; banner.appendChild(b); });
      banner.hidden = false;
    }
    function hideBanner() { banner.hidden = true; banner.replaceChildren(); }

    // Show exactly this content version in the editor. The ONE place content
    // reaches Ink: a stroke format this build does not know is refused here,
    // before anything is loaded, so every path (mount, background refresh,
    // conflict and recovery choices) fails the same visible way.
    function unsupported() { return Object.assign(new Error("This page was saved by a newer version of DCC. Reload DCC to open it."), { code: "INK_VERSION" }); }
    function unsupportedInk(rec) { return !!(rec && rec.ink != null && (!rec.ink || rec.ink.v !== 1)); }
    function display(rec) {
      if (unsupportedInk(rec)) throw unsupported();
      ink.loadPage(rec && rec.ink ? JSON.parse(JSON.stringify(rec.ink)) : window.InkStrokes.emptyPage());
      textarea.value = (rec && rec.body) || "";
      session.localRev = rec ? rec.localRev || 0 : 0;
    }

    // Every choice that replaces or rebases content runs here: first everything
    // the user did is committed (stroke under the pen, pending typing, queued
    // writes), and while the choice runs the paper and notes accept no input.
    // A failed local write aborts the choice with nothing changed.
    async function settle() {
      commitStroke(); flushTyping();
      while (writing) await writing;
      if (failed) throw Object.assign(new Error("Your latest writing is not saved on this device yet. Retry the save first; nothing was changed."), { code: "LOCAL_SAVE_FAILED" });
    }
    function lock(on) {
      actionBusy = on;
      body.classList.toggle("jt-locked", on);
      textarea.readOnly = on;
      body.querySelectorAll(".jt-banner-btn").forEach(b => { b.disabled = on; });
    }
    async function runAction(fn) {
      if (actionBusy || !ready) return;
      lock(true);
      try { await settle(); await fn(); }
      catch (e) {
        showBanner((e && e.message) || "That choice could not be applied; nothing was changed.", [
          ...(e && e.code === "LOCAL_SAVE_FAILED" ? [{ id: "retry-save", label: "Retry save", onClick: async () => {
            hideBanner(); queueSave();
            while (writing) await writing;
            if (!failed) review();            // saved: offer the pending choice again
          } }] : []),
          { id: "review", label: "Review choices", onClick: () => { hideBanner(); review(); } },
        ]);
      } finally { lock(false); paint(); }
    }

    // Choices, most urgent first: another device (server conflict), then a
    // stale page in this editor or a draft left by another tab, then recovery.
    async function review() {
      const rec = await store().load(session.journalId).catch(() => null);
      if (!session.alive || !rec) return;
      if (rec.conflict && !session.stale) return showConflict(rec);
      const draft = (rec.drafts || []).find(d => d.id === session.draftId) || (rec.drafts || [])[0];
      if (draft) return showDraft(draft, draft.id === session.draftId);
      if ((rec.recoveries || []).length) return offerRecovery(rec);
      hideBanner();
    }

    function showConflict() {
      showBanner("This page changed on another device. Your page is safe on this device.", [
        { id: "keep-local", label: "Keep this device's page", onClick: () => runAction(async () => {
          await store().keepLocal(session.journalId, session.localRev);
          hideBanner(); syncFor(session.journalId).resume(); review();
        }) },
        { id: "use-server", label: "Use the saved page", onClick: () => runAction(async () => {
          const next = await store().useServer(session.journalId, session.localRev);
          display(next); hideBanner(); syncFor(session.journalId).resume(); review();
        }) },
      ]);
    }
    function showDraft(draft, mine) {
      showBanner(mine
        ? "This page changed in another tab or on another device while you were writing. Your version is saved on this device."
        : "A version written in another tab was kept on this device.", [
        { id: "keep-mine", label: mine ? "Keep my version" : "Use that version", onClick: () => runAction(async () => {
          const cur = await store().load(session.journalId);
          const next = await store().resolveDraft(session.journalId, draft.id, "mine", cur.localRev);
          display(next); session.stale = false; hideBanner(); syncFor(session.journalId).nudge(); review();
        }) },
        { id: "use-newer", label: mine ? "Use the newer page" : "Keep this page", onClick: () => runAction(async () => {
          const cur = await store().load(session.journalId);
          const next = await store().resolveDraft(session.journalId, draft.id, "theirs", cur.localRev);
          if (mine) { display(next); session.stale = false; }
          hideBanner(); review();
        }) },
      ]);
    }
    function offerRecovery(rec) {
      const item = rec && (rec.recoveries || [])[0];
      if (!item) return;
      const kept = rec.recoveries.length;
      showBanner(kept > 1
        ? "Earlier versions of this page are kept on this device (" + kept + ", newest first). They stay until you restore or delete them."
        : "An earlier version of this page is kept on this device. It stays until you restore or delete it.", [
        { id: "restore-recovery", label: "Restore it", onClick: () => runAction(async () => {
          const next = await store().restoreRecovery(session.journalId, item.id, session.localRev);
          display(next); hideBanner(); syncFor(session.journalId).nudge();
        }) },
        // Hiding the banner keeps the copy; only "Delete copy" removes it.
        { id: "dismiss", label: "Not now", onClick: hideBanner },
        { id: "delete-recovery", label: "Delete copy", onClick: () => runAction(async () => {
          await store().dismissRecovery(session.journalId, item.id); hideBanner(); review();
        }) },
      ]);
    }

    // ── local saves: serialized, coalesced, one transaction each ────────────
    function queueSave() {
      if (!ready || discard) return;
      if (writing) { queued = true; paint(); return; }
      writing = (async () => {
        let wentStale = false;
        do {
          queued = false; paint();
          try {
            const { record, stale } = await store().saveEdit(session.journalId, content(), session.localRev, session.draftId);
            failed = null;
            if (stale) { if (!session.stale) wentStale = true; session.stale = true; }
            else session.localRev = record.localRev;
          } catch (e) { failed = e; queued = false; }
        } while (queued && !failed);
        writing = null;
        paint();
        if (!failed) { unsaved.delete(session.journalId); if (!session.stale) syncFor(session.journalId).nudge(); }
        else if (!session.alive && !discard) stash(session.journalId, stashed());
        if (wentStale && session.alive && !actionBusy) review();
        // A late identity refusal was waiting for this writing to be on the device.
        if (!failed && session.freezePending && session.alive) { const m = session.freezePending; session.freezePending = null; hideBanner(); session.fail(m); }
        settleClose();
      })();
      paint();
    }
    function content() { return { taskId: session.taskId, taskKeys: session.taskKeys, ink: ink.getPage(), body: textarea.value }; }
    // What a closed editor still owes the device: its content AND the version it
    // was based on, so a later retry cannot overwrite something it never showed.
    function stashed() { return { content: content(), localRev: session.localRev, draftId: session.draftId }; }
    function flushTyping() { if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; queueSave(); } }

    // Commit an in-progress stroke (close, pagehide, background). The canvas
    // finishes a stroke on pointerup without reading coordinates from the event.
    function commitStroke() {
      if (!ink || !ink.isPenDown()) return false;
      const base = q(".jt-base");
      const id = ink.state.activePointer;
      try { base.dispatchEvent(new PointerEvent("pointerup", { pointerId: id, pointerType: ink.state.activePointerType || "pen", bubbles: false })); }
      catch { return false; }
      return true;
    }
    session.penDown = () => !!(ink && ink.isPenDown());

    // ── close / switch ───────────────────────────────────────────────────────
    function busy() { return !!(writing || queued || typingTimer); }
    function settleClose() {
      if (!pendingClose || busy()) return;
      const reason = pendingClose; pendingClose = null;
      if (failed && !discard) { blockedClose(); return; }
      session.handle.close(reason);
    }
    function blockedClose() {
      closeResolvers.splice(0).forEach(r => r(false));
      showBanner("Your latest strokes are not saved on this device.", [
        { id: "retry-save", label: "Retry save", onClick: () => { hideBanner(); queueSave(); } },
        { id: "discard", label: "Discard and close", onClick: () => { discard = true; hideBanner(); session.handle.close("discard"); } },
      ]);
    }
    function canClose(reason) {
      if (discard || !ready) return true;
      const committed = commitStroke();
      flushTyping();
      // Another dialog is replacing this one. Refusing would hand OUR handle to
      // that caller (core-ui returns the still-open overlay), so let it go: an
      // in-flight write finishes on its own, and a failed one is stashed,
      // retried and guarded by beforeunload instead of being dropped.
      if (reason === "replaced") {
        if (failed && !busy()) stash(session.journalId, stashed());
        return true;
      }
      if (committed || busy()) { pendingClose = reason; paint(); return false; }
      if (failed) { blockedClose(); return false; }
      return true;
    }
    session.requestClose = reason => new Promise(resolve => {
      if (!session.alive) { resolve(true); return; }
      closeResolvers.push(resolve);
      session.handle.close(reason || "switch");
    });

    // ── lifecycle listeners ──────────────────────────────────────────────────
    function onHide() { commitStroke(); flushTyping(); }
    function onVisibility() { if (document.visibilityState === "hidden") onHide(); }
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    session.unsafeToLeave = () => !!(failed || busy() || session.penDown());

    function teardown() {
      session.alive = false;
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      if (panCleanup) panCleanup();
      if (typingTimer) clearTimeout(typingTimer);
      if (ink) ink.destroy();
      if (current === session) current = null;
      closeResolvers.splice(0).forEach(r => r(true));
      document.dispatchEvent(new CustomEvent("dcc:journal-closed", { detail: { journalId: session.journalId, taskId: session.taskId } }));
    }

    session.handle = D.overlay.open({
      kind: "modal", title: opts.title || "Journal", body,
      canClose, onClose: teardown,
    });
    session.handle.el.classList.add("jt-dialog");
    session.handle.el.dataset.journalId = session.journalId;
    session.body = body;

    // ── wiring ───────────────────────────────────────────────────────────────
    function setTool(id) {
      body.querySelectorAll("[data-jt-tool]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.jtTool === id)));
      const t = TOOLS.find(x => x.id === id);
      ink.setTool(id);
      if (t && t.size) ink.setSize(t.size);
    }
    function setColor(c) {
      body.querySelectorAll("[data-jt-color]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.jtColor === c)));
      ink.setColor(c);
    }
    function fingerLabel(mode) { return "Finger: " + mode; }
    body.addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b || !ink) return;
      if (actionBusy) return;   // a conflict/recovery choice is being applied
      if (b.dataset.jtTool) setTool(b.dataset.jtTool);
      else if (b.dataset.jtColor) setColor(b.dataset.jtColor);
      else if (b.dataset.jtAct === "undo") ink.undo();
      else if (b.dataset.jtAct === "redo") ink.redo();
      else if (b.dataset.jtAct === "finger") {
        const order = ["auto", "on", "off"], next = order[(order.indexOf(ink.state.fingerDraw) + 1) % 3];
        ink.setFingerDraw(next); b.textContent = fingerLabel(next);
        try { localStorage.setItem(FINGER_PREF, next); } catch { /* preference only */ }
      } else if (b.dataset.jtAct === "notes") {
        const notes = q(".jt-notes"), open = notes.hidden;
        notes.hidden = !open; b.setAttribute("aria-expanded", String(open));
        if (open) textarea.focus();
      } else if (b.dataset.jtAct === "retry") {
        if (failed) queueSave(); else syncFor(session.journalId).resume();
      }
    });
    textarea.addEventListener("input", () => {
      if (typingTimer) clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { typingTimer = null; queueSave(); }, TYPING_DELAY);
      paint();
    });

    // Finger panning. Ink owns every gesture on the paper (touch-action:none and
    // preventDefault on pointerdown, so the page never scrolls natively there).
    // Once a finger is not drawing -- after a pen has been seen in "auto", or
    // always in "off" -- a one-finger drag scrolls the dialog instead. A second
    // finger ends the pan, matching Ink's two-finger cancel.
    function wirePan(paper, scroller) {
      let pan = null;
      const touches = new Set();
      const fingerDraws = () => ink.state.fingerDraw === "on" || (ink.state.fingerDraw === "auto" && !ink.state.penSeen);
      const down = ev => {
        if (ev.pointerType !== "touch") return;
        touches.add(ev.pointerId);
        if (touches.size > 1) { pan = null; return; }
        if (!fingerDraws()) pan = { id: ev.pointerId, y: ev.clientY, x: ev.clientX };
      };
      const move = ev => {
        if (!pan || ev.pointerId !== pan.id) return;
        scroller.scrollTop += pan.y - ev.clientY;
        scroller.scrollLeft += pan.x - ev.clientX;
        pan.y = ev.clientY; pan.x = ev.clientX;
      };
      const up = ev => { touches.delete(ev.pointerId); if (pan && ev.pointerId === pan.id) pan = null; };
      paper.addEventListener("pointerdown", down, true);
      paper.addEventListener("pointermove", move, true);
      ["pointerup", "pointercancel", "lostpointercapture"].forEach(t => paper.addEventListener(t, up, true));
      return () => {
        paper.removeEventListener("pointerdown", down, true);
        paper.removeEventListener("pointermove", move, true);
        ["pointerup", "pointercancel", "lostpointercapture"].forEach(t => paper.removeEventListener(t, up, true));
      };
    }

    session.mount = function (rec) {
      if (!session.alive) return;
      // A page in a stroke format this build does not know is shown as an error,
      // never loaded into the editor where an edit would rewrite it as v1.
      if (unsupportedInk(rec)) { session.fail(unsupported().message); return; }
      let finger = "auto";
      try { finger = localStorage.getItem(FINGER_PREF) || "auto"; } catch { /* default */ }
      ink = window.InkCanvas.create({ base: q(".jt-base"), live: q(".jt-live"), wrap: q(".jt-paper"), fingerDraw: finger, onChange: queueSave });
      panCleanup = wirePan(q(".jt-paper"), session.handle.el.querySelector(".dcc-overlay-body") || body);
      q('[data-jt-act="finger"]').textContent = fingerLabel(ink.state.fingerDraw);
      // Strokes that failed to save after an earlier editor closed are newer than
      // anything stored. Restore them WITH the version they were based on, so
      // saving them again either applies cleanly or becomes a draft to choose.
      const pendingMemory = unsaved.get(session.journalId);
      display(rec);
      if (pendingMemory) {
        display(pendingMemory.content);
        session.localRev = pendingMemory.localRev; session.draftId = pendingMemory.draftId;
      }
      if (textarea.value) { q(".jt-notes").hidden = false; q('[data-jt-act="notes"]').setAttribute("aria-expanded", "true"); }
      setTool("ballpoint"); setColor(COLORS[0]);
      ready = true;
      body.dataset.jtReady = "true";   // the paper accepts ink from here on
      requestAnimationFrame(() => { if (session.alive) ink.layout(); });
      paint();
      if (pendingMemory) { session.restored = true; queueSave(); }
      review();
    };
    // A newer copy (server, or another tab) is now the stored content. Show it
    // only if this editor has nothing of its own: no stroke under the pen, no
    // pending typing or write, no edit since opening. Otherwise the editor keeps
    // its page, and its next save, naming the older version, becomes a draft.
    session.replaceIfUntouched = function (rec, openedLocalRev) {
      if (!session.alive || !ink || !rec || session.restored || busy() || ink.isPenDown() || ink.state.revision > 0) return;
      if (session.localRev !== openedLocalRev || session.stale) return;
      // An unknown format arriving in the background leaves the page as shown
      // and makes the editor read-only, exactly like opening it would.
      try { display(rec); } catch (e) { session.fail(e.message); }
    };
    // An open that cannot safely edit (unknown format, other account, storage
    // unavailable) stays an error and takes no further input; later sync status
    // never repaints over it, and nothing is saved from it.
    session.fail = function (message) {
      if (!session.alive) return;
      session.openFailed = message;
      ready = false;                       // queueSave refuses from here on
      actionBusy = true;                   // toolbar and choices refuse too
      body.classList.add("jt-locked"); textarea.readOnly = true;
      statusText.textContent = message; q(".jt-status").dataset.tone = "error"; retryBtn.hidden = true;
      body.dataset.jtState = "open-failed";
    };
    // A refusal that arrives AFTER the page is open and editable (the server says
    // this task does not own its journal identity, or knows it under another id)
    // while the user may be mid-stroke or mid-typing. That input belongs to THIS
    // task's own device page (the binding check already passed), so it is first
    // committed and written there -- never dropped -- and only then is the editor
    // frozen. Nothing is sent: the server refuses this task's saves. If the local
    // write fails, the editor stays in the not-saved state (close blocked behind
    // Retry save / Discard) until the writing is on the device.
    session.freeze = async function (message) {
      if (!session.alive || session.openFailed || session.freezing) return;
      if (!ready) { session.fail(message); return; }
      session.freezing = true;
      lock(true);                              // no new input while we settle
      try { await settle(); }
      catch {
        // Stay frozen-pending: input stays locked, close stays blocked (failed),
        // and the FIRST successful local save -- from this Retry or from the close
        // dialog's Retry -- completes the freeze (see queueSave).
        session.freezing = false;
        session.freezePending = message;
        statusText.textContent = message + " Your latest writing is NOT saved on this device yet.";
        q(".jt-status").dataset.tone = "error"; body.dataset.jtState = "freeze-pending";
        showBanner("Your latest writing is not saved on this device yet.", [
          { id: "retry-save", label: "Retry save", onClick: () => { hideBanner(); queueSave(); } },
          { id: "discard", label: "Discard and close", onClick: () => { discard = true; hideBanner(); session.handle.close("discard"); } },
        ]);
        return;
      }
      session.freezing = false;
      session.fail(message);
    };
    return session;
  }

  // Resolve the stable journal identity for a task without a second source of
  // truth: the task row first, then the server's copy of the block.
  // The task's OWN row is the authority (it reflects a server re-mint), then the
  // id the caller passed, then the server.
  async function resolveJournalId(keys, given, taskId) {
    const own = Array.from(new Set(blockRows()
      .filter(b => b && window.JournalTaskBinding.idsOf(b).some(k => keys.includes(k)))
      .map(b => (b.properties || {}).journalId).filter(Boolean)));
    if (own.length > 1) throw Object.assign(new Error("This task has more than one journal identity on this device, so it cannot be opened."), { code: "JOURNAL_BINDING" });
    if (own.length === 1) return own[0];
    if (given) return given;
    const server = await fetchServer(taskId);
    return server.journalId;
  }

  async function open(opts) {
    const o = opts || {};
    if (!window.JournalPageStore || !window.JournalPageSync || !D.overlay) throw new Error("Journal editor is still loading");
    if (!account()) {
      if (typeof showToast === "function") showToast("This tab belongs to another account. Reload DCC to open your journal.", "error");
      return null;
    }
    if (current) {
      if (current.taskId === o.taskId) return current;
      const closed = await current.requestClose("switch");
      if (!closed) return null;
    }
    // Every id this task is known by (local id, server id), from the block store.
    const keys = window.JournalTaskBinding.expand(blockRows(), [o.taskId, o.localId].filter(Boolean));
    let journalId;
    try { journalId = await resolveJournalId(keys, o.journalId, o.taskId); }
    catch (e) {
      if (typeof showToast === "function") showToast(e.code === "JOURNAL_BINDING" ? e.message : e.status === 401 ? "Sign in to open this journal." : "Couldn't open this journal yet. Try again when you're online.", "error");
      return null;
    }
    if (current) return null; // another open won the race while we resolved the id
    const session = createSession({ taskId: o.taskId, journalId, taskKeys: keys, title: o.title || "Journal" });
    current = session;
    const refuse = message => { session.fail(message); return session; };
    try {
      await ensureInk();
      const s = store();
      // Which server row is this task, and does any OTHER task carry this id?
      const local = window.JournalTaskBinding.resolve(blockRows(), journalId, keys);
      if (local.state === "mismatch") return refuse(bindingError(local).message);
      const serverId = local.state === "ok" ? local.taskId : (local.ownTaskId || o.taskId);
      let rec = await s.load(journalId);
      // A page bound to another task is never rendered, edited or sent from here.
      if (rec && !s.belongsTo(rec, keys)) return refuse("This journal page belongs to a different task on this device. Nothing was opened or changed.");
      // Two rows in this tab carry the id: open only if the server confirms that
      // THIS task owns it (the server's claim decides; see journal-store.js).
      let confirmed = null;
      if (local.state === "ambiguous") {
        confirmed = await fetchServer(serverId).catch(() => null);
        if (!confirmed || confirmed.journalId !== journalId || !keys.includes(confirmed.taskId)) {
          return refuse("Another task carries this journal's identity, so this page cannot be opened here. Nothing was opened or changed.");
        }
      }
      // Only a response for THIS journal, for THIS task, for this tab's account,
      // is ever seeded.
      const seedFrom = server => server && server.journalId === journalId && keys.includes(server.taskId) ? s.seed(journalId, server, keys) : null;
      const serverRefused = e => e && (e.code === "ACCOUNT_CHANGED" || e.code === "JOURNAL_AMBIGUOUS" || e.code === "TASK_MISMATCH");
      // The server knows THIS task under a different journal id (this tab's cache
      // is stale, or the id was re-minted): never start a page under the old id.
      const staleId = server => server && keys.includes(server.taskId) && server.journalId && server.journalId !== journalId;
      const staleIdMessage = "This task's journal identity changed on the server. Reload DCC to open it. Nothing was opened or changed.";
      if (!rec && (confirmed || online())) {
        try {
          const server = confirmed || await fetchServer(serverId);
          if (staleId(server)) return refuse(staleIdMessage);
          rec = (await seedFrom(server)) || rec;
        }
        catch (e) {
          if (serverRefused(e)) return refuse(e.message);
          if (e.status === 401) session.showSync({ state: "signed-out", message: "Sign in to sync. New strokes save on this device." });
        }
      }
      // Writing this task saved under an EARLIER journal id (the server gave the
      // task a fresh id because its first one was already claimed) is kept as a
      // recovery copy here rather than left unseen.
      const orphans = await s.boundElsewhere(journalId, keys).catch(() => []);
      // Copies whatever each source holds NOW (re-read inside adopt); a source that
      // changes meanwhile stays discoverable and is picked up on the next open.
      for (const orphan of orphans) await s.adopt(journalId, orphan.journalId, keys).catch(() => {});
      if (orphans.length) rec = await s.load(journalId);
      const openedLocalRev = rec ? rec.localRev || 0 : 0;
      if (!session.alive || current !== session) return null;
      session.mount(rec);
      if (session.openFailed) return session;
      if (rec && !rec.dirty && !rec.conflict && online()) {
        // Refresh from the server in the background; never clobber local edits,
        // and never paint into an editor that has closed or been replaced.
        fetchServer(serverId).then(server => {
          if (staleId(server)) { if (current === session) session.freeze(staleIdMessage); return null; }
          return seedFrom(server);
        }).then(next => { if (next && current === session) session.replaceIfUntouched(next, openedLocalRev); })
          .catch(e => { if (serverRefused(e) && current === session) session.freeze(e.message); });
      }
      syncFor(journalId).flush();
    } catch (e) {
      session.fail((e && e.message) || "Could not open the journal on this device.");
    }
    return session;
  }

  // Every dirty page on this device drains -- including pages whose editor
  // closed long ago and pages saved before a reload -- without reopening them.
  async function resumePending() {
    if (!account() || !window.JournalPageStore) return;
    try {
      const dirty = await store().listDirty();
      dirty.forEach(rec => { if (!rec.conflict) syncFor(rec.journalId).resume(); });
    } catch { /* storage unavailable; the next trigger retries */ }
  }

  // Task detail affordance: open a Journal, or turn a plain task into one.
  function taskButton(taskId, task) {
    const host = document.getElementById("am-journal-entry"); if (!host) return;
    host.innerHTML = "";
    if (!task) return;
    const type = task.type || "task";
    if (type !== "journal" && !["task", "focus", "habit"].includes(type)) return;
    host.appendChild(el("div", { class: "am-section-label" }, "Private journal"));
    const b = el("button", { type: "button", class: "btn btn-sm jt-open", "data-activity-open": type === "journal" ? "" : null },
      type === "journal" ? "Open journal page" : "Use as Journal");
    b.onclick = async () => {
      if (typeof closeAddModal === "function") closeAddModal();
      if (type !== "journal") {
        if (typeof convertTaskType !== "function" || !(await convertTaskType(task.id, "journal"))) return;
      }
      open({ taskId: taskId, localId: task.id, journalId: task.journalId, title: task.title });
    };
    host.appendChild(b);
  }
  function attach(rowEl, task) {
    if (!task || task.type !== "journal") return;
    const main = rowEl.querySelector(".it-list-main"); if (!main || main.querySelector(".jt-row-open")) return;
    const b = el("button", { type: "button", class: "wp-toggle jt-row-open" }, "Open journal");
    b.onclick = e => { e.stopPropagation(); open({ taskId: task._blockId || task.id, localId: task.id, journalId: task.journalId, title: task.title }); };
    main.append(b);
  }

  window.addEventListener("online", resumePending);
  window.addEventListener("offline", () => { if (current) syncFor(current.journalId).flush(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") resumePending(); });
  // Leaving the page while strokes are only in memory would lose them; the
  // browser's own "leave site?" prompt is the last guard. Saved-on-device pages
  // need no prompt: they sync on the next visit by the same account.
  window.addEventListener("beforeunload", e => {
    if (unsaved.size || (current && current.unsafeToLeave())) { e.preventDefault(); e.returnValue = ""; }
  });
  if (document.readyState === "complete") setTimeout(resumePending, 2000);
  else window.addEventListener("load", () => setTimeout(resumePending, 2000), { once: true });

  D.JournalTask = { open, taskButton, attach, resumePending, get current() { return current; } };
})();
