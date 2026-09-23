// Mycelium Ink — sync.
//
// Writing never waits for the network. Pages are saved locally the moment the
// pen lifts and marked dirty; this drains that queue whenever it can. If sync
// is down for a week you keep writing and nothing is lost.
//
// "Whenever it can" means WHEN THE PEN IS STILL, and that is load-bearing.
// Uploading a page renders a 2040x2640 canvas -- one stroked path per segment,
// because width follows pressure -- and JPEG-encodes 5.4 megapixels, all on the
// main thread, which is the thread servicing the pen. Doing that while someone
// is writing stalls the stroke under their hand. So the entry point for a local
// change is `nudge`, which waits out the pen; `syncNow` is for deliberate
// flushes only. An earlier version called syncNow straight from the save path
// and the app became unusable to write in.
//
// Same-origin, so the browser's existing DCC session cookie authenticates every
// request. There is no token to store and no login screen to build.
//
// Each page sends TWO things: the strokes (editable, our own open format) and a
// rendered PNG (readable by anything, forever, and what the vault tab displays
// and what server-side OCR reads).

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.InkSync = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ENDPOINT = "/api/vault/notebook-page-ingest";

  // The page is 1275x1650 at scale 1. Rendering at 1.6 lands near 2040px on the
  // long edge: comfortably above what handwriting OCR wants, while staying in
  // the server's inline media tier so blobs commit straight into git.
  const RENDER_SCALE = 1.6;
  const JPEG_QUALITY = 0.82;
  const RETRY_DELAYS = [30000, 120000, 600000, 1800000];

  // How long the pen must be still before this touches the network at all.
  // Uploading a page means rendering 5.4 megapixels and JPEG-encoding it on the
  // main thread -- the same thread that services the pen -- so it has to happen
  // in a gap, never in the middle of a sentence. Every stroke pushes this out,
  // so writing continuously never syncs, and stopping for a breath does.
  const IDLE_SYNC_DELAY = 8000;
  // When the pen starts moving again mid-cycle, wait this long and re-check
  // rather than fighting for the main thread.
  const BUSY_RECHECK_DELAY = 4000;
  // A render that never answers must not strand a page as permanently syncing.
  const WORKER_TIMEOUT_MS = 30000;

  function create(deps) {
    const Store = deps.store;
    const Strokes = deps.strokes;
    const onStatus = deps.onStatus || function () {};
    // True while a stroke is actually in progress. Defaults to "never busy" so
    // a caller that does not wire it up (tests, headless use) behaves as before.
    const isBusy = deps.isBusy || function () { return false; };

    let running = false;
    let queuedAgain = false;
    let retryIndex = 0;
    let retryTimer = null;
    let idleTimer = null;

    // Let the event loop run so queued pointer input is serviced before this
    // takes the main thread for a long render. Only the fallback path needs
    // this; the worker path never touches the main thread.
    function yieldToInput() {
      return new Promise((resolve) => setTimeout(resolve, 0));
    }

    // ── rendering, off the main thread where possible ────────────────────────
    //
    // The worker owns the expensive part. Timing the main-thread render was
    // only ever choosing when to stutter; this removes the stutter instead.
    // Safari 16.4+ has OffscreenCanvas with a 2D context, which covers current
    // iPadOS. Anything older keeps the in-page render, which is why the idle
    // scheduling below is still worth having.

    let worker = null;
    let workerUsable = typeof Worker === "function"
      && typeof OffscreenCanvas === "function"
      && typeof document !== "undefined";
    let nextJobId = 1;
    const jobs = new Map();

    function retireWorker(reason) {
      workerUsable = false;
      if (worker) { try { worker.terminate(); } catch { /* already gone */ } }
      worker = null;
      for (const [, job] of jobs) job.reject(new Error(reason));
      jobs.clear();
    }

    function ensureWorker() {
      if (worker || !workerUsable) return worker;
      try {
        worker = new Worker("/public/js/ink/render-worker.js");
        worker.onmessage = (e) => {
          const msg = e.data || {};
          const job = jobs.get(msg.id);
          if (!job) return;
          jobs.delete(msg.id);
          if (msg.ok) job.resolve(msg);
          else job.reject(new Error(msg.error || "render failed"));
        };
        // A worker that cannot start (blocked, offline and uncached, a parse
        // error) must not take the notebook down with it.
        worker.onerror = () => retireWorker("render worker failed");
      } catch {
        retireWorker("render worker unavailable");
      }
      return worker;
    }

    function renderInWorker(serializedInk) {
      const w = ensureWorker();
      if (!w) return Promise.reject(new Error("no render worker"));
      const id = nextJobId++;
      return new Promise((resolve, reject) => {
        // A render that never answers must not strand the page forever -- but
        // the timer has to be cleared when it does answer, or every successful
        // render leaves a 30-second timer behind.
        const timer = setTimeout(() => {
          if (!jobs.has(id)) return;
          jobs.delete(id);
          reject(new Error("render worker timed out"));
        }, WORKER_TIMEOUT_MS);
        const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
        jobs.set(id, { resolve: settle(resolve), reject: settle(reject) });
        w.postMessage({
          id,
          ink: serializedInk,
          scale: RENDER_SCALE,
          type: "image/jpeg",
          quality: JPEG_QUALITY,
          background: "#ffffff",
        });
      });
    }

    // Produces the page JPEG, in the worker when it can and in the page when it
    // cannot. The fallback is the original code path, unchanged.
    async function renderImage(serializedInk, page) {
      if (workerUsable) {
        try {
          const out = await renderInWorker(serializedInk);
          if (out.blob && out.type === "image/jpeg") return out.blob;
          // Safari hands back a PNG rather than refusing an unsupported type.
          // The in-page encoder does support JPEG, so stop using the worker.
          retireWorker(`worker encoded ${out.type || "an unknown type"}`);
        } catch (e) {
          // One failure is enough to stop trusting it; writing must not depend
          // on a worker that is not working.
          retireWorker(String((e && e.message) || e));
        }
      }
      await yieldToInput();
      if (isBusy()) throw Object.assign(new Error("pen is down"), { deferred: true });
      return canvasToBlob(renderPage(page), "image/jpeg", JPEG_QUALITY);
    }

    function canvasToBlob(canvas, type, quality) {
      return new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode image"))), type, quality);
      });
    }

    function renderPage(page) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(page.w * RENDER_SCALE);
      canvas.height = Math.round(page.h * RENDER_SCALE);
      const ctx = canvas.getContext("2d");
      Strokes.drawPage(ctx, page, { scale: RENDER_SCALE, background: "#ffffff" });
      return canvas;
    }

    // How much ink sits outside anything OCR recognized. We cannot compute the
    // text side in the browser, so the client reports total ink coverage and the
    // server decides. Sending 0 would be a lie, so it is simply omitted until
    // there is a transcript to compare against.
    async function uploadPage(record) {
      const notebook = await Store.getNotebook(record.notebookId);
      if (!notebook) {
        // The notebook was deleted while this page was queued. Drop it rather
        // than retrying forever against a title that no longer exists.
        await Store.markSynced(record.id, null);
        return { skipped: "orphan" };
      }

      // Capture before every early exit. A blank page can become nonblank while
      // this task is running, so its acknowledgement needs the same CAS guard.
      const sentHash = Store.hashOf(record.data);
      const page = Strokes.deserialize(record.data);
      if (Strokes.isBlank(page)) {
        // Never create a vault node for a page nobody wrote on.
        const cleared = await Store.markSynced(record.id, null, sentHash);
        return { skipped: "blank", stillDirty: !cleared };
      }

      // The expensive part -- 5.4 megapixels rasterised and JPEG-encoded -- now
      // happens in a worker, so the pen's thread is free throughout. Only the
      // fallback path can defer, and it says so by throwing.
      const serializedInk = Strokes.serialize(page);
      let imageBlob;
      try {
        imageBlob = await renderImage(serializedInk, page);
      } catch (e) {
        if (e && e.deferred) return { deferred: true, stillDirty: true };
        throw e;
      }
      const inkBlob = new Blob([serializedInk], { type: "application/json" });

      const form = new FormData();
      form.append("ink", inkBlob, `page-${record.index + 1}.json`);
      form.append("image", imageBlob, `page-${record.index + 1}.jpg`);
      form.append("notebookTitle", notebook.title);
      form.append("notebookId", notebook.id);
      form.append("pageNumber", String(record.index + 1));
      form.append("transcript", record.transcript || "");
      form.append("ocrStatus", record.transcript ? "complete" : "pending");
      form.append("ocrSource", record.transcript ? "client" : "none");

      const res = await fetch(ENDPOINT, { method: "POST", body: form, credentials: "same-origin" });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const err = new Error(`${res.status} ${detail.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      const out = await res.json();
      // Conditional on the hash: a page edited mid-upload stays dirty and goes
      // again, instead of being marked clean with strokes that never shipped.
      const cleared = await Store.markSynced(record.id, sentHash, sentHash);
      return { slug: out.slug, page: out.page, deduplicated: out.deduplicated, stillDirty: !cleared };
    }

    async function syncNow() {
      if (running) { queuedAgain = true; return; }
      clearTimeout(retryTimer);
      retryTimer = null;
      running = true;
      try {
        for (;;) {
          const dirty = await Store.dirtyPages();
          if (!dirty.length) { onStatus({ state: "clean", pending: 0 }); retryIndex = 0; break; }
          onStatus({ state: "syncing", pending: dirty.length });

          let progressed = false;
          let deferred = false;
          let firstError = null;
          for (const record of dirty) {
            // Re-checked per page: a long backlog must not hold the pen hostage
            // because writing resumed partway through draining it.
            if (isBusy()) { deferred = true; break; }
            try {
              const out = await uploadPage(record);
              // A deferred page is still dirty on purpose. It must not count as
              // progress, or the outer loop would spin on it.
              if (out.deferred) { deferred = true; break; }
              if (!out.stillDirty) progressed = true;
            } catch (e) {
              // One malformed page must not block every healthy page behind it.
              if (!firstError) firstError = e;
            }
          }
          if (deferred) {
            onStatus({ state: "syncing", pending: (await Store.dirtyPages()).length });
            nudge(BUSY_RECHECK_DELAY);
            break;
          }
          if (firstError) {
            const status = firstError && firstError.status;
            const fatal = status >= 400 && status < 500;
            onStatus({ state: "error", pending: (await Store.dirtyPages()).length, message: describe(firstError), fatal });
            if (!fatal && status !== 401 && status !== 403) scheduleRetry();
            break;
          }
          if (!progressed) break;   // nothing moved; avoid a hot loop
        }
      } finally {
        running = false;
        if (queuedAgain) { queuedAgain = false; setTimeout(syncNow, 50); }
      }
    }

    // The only thing writing is allowed to call. It does not sync; it says
    // "something changed, sync once the pen has been still for a while", and
    // every later call pushes that moment further out. syncNow stays public for
    // the deliberate flushes -- leaving the notebook, hiding the tab -- where a
    // pause is expected anyway.
    function nudge(delay) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (isBusy()) { nudge(BUSY_RECHECK_DELAY); return; }
        syncNow();
      }, delay == null ? IDLE_SYNC_DELAY : delay);
    }

    // Cancels anything pending. Nothing in the app tears a notebook down today,
    // but a scheduler with no off switch is a leak waiting to happen -- and the
    // busy re-arm above would otherwise keep a timer alive indefinitely.
    function stop() {
      clearTimeout(idleTimer);
      clearTimeout(retryTimer);
      idleTimer = null;
      retryTimer = null;
      if (worker) { try { worker.terminate(); } catch { /* already gone */ } }
      worker = null;
      jobs.clear();
    }

    function scheduleRetry() {
      if (retryTimer) return;
      const delay = RETRY_DELAYS[Math.min(retryIndex, RETRY_DELAYS.length - 1)];
      retryIndex += 1;
      retryTimer = setTimeout(() => { retryTimer = null; syncNow(); }, delay);
    }

    function describe(e) {
      if (!navigator.onLine) return "offline";
      const msg = String((e && e.message) || e);
      if (msg.startsWith("401") || msg.startsWith("403")) return "signed out";
      if (msg.startsWith("413")) return "page too large";
      return msg.slice(0, 80);
    }

    // Sync when the network returns, when the tab changes state, and
    // periodically. Deliberately NOT on every stroke: that would put the network
    // in the middle of writing, which is the one place it must never be. Every
    // trigger here goes through `nudge`, so none of them can land mid-sentence
    // -- the periodic one included, which previously fired regardless.
    //
    // Hiding the tab is the exception and flushes immediately: the pen is
    // provably not in use, and it is the last chance before the OS suspends us.
    function start() {
      window.addEventListener("online", () => { retryIndex = 0; nudge(500); });
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) syncNow();
        else nudge();
      });
      setInterval(() => { if (navigator.onLine) nudge(0); }, 300000);
      nudge(1000);
    }

    return { syncNow, nudge, stop, start, renderPage, IDLE_SYNC_DELAY, RENDER_SCALE, RETRY_DELAYS };
  }

  return { create, IDLE_SYNC_DELAY, RENDER_SCALE, RETRY_DELAYS };
});
