// Mycelium Ink — sync.
//
// Writing never waits for the network. Pages are saved locally the moment the
// pen lifts and marked dirty; this drains that queue whenever it can. If sync
// is down for a week you keep writing and nothing is lost.
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

  function create(deps) {
    const Store = deps.store;
    const Strokes = deps.strokes;
    const onStatus = deps.onStatus || function () {};

    let running = false;
    let queuedAgain = false;
    let backoff = 0;

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

      const page = Strokes.deserialize(record.data);
      if (Strokes.isBlank(page)) {
        // Never create a vault node for a page nobody wrote on.
        await Store.markSynced(record.id, null);
        return { skipped: "blank" };
      }

      // Captured BEFORE the upload so we can tell whether the page changed
      // while it was in flight.
      const sentHash = Store.hashOf(record.data);

      const canvas = renderPage(page);
      const imageBlob = await canvasToBlob(canvas, "image/jpeg", JPEG_QUALITY);
      const inkBlob = new Blob([Strokes.serialize(page)], { type: "application/json" });

      const form = new FormData();
      form.append("ink", inkBlob, `page-${record.index + 1}.json`);
      form.append("image", imageBlob, `page-${record.index + 1}.jpg`);
      form.append("notebookTitle", notebook.title);
      form.append("pageNumber", String(record.index + 1));
      form.append("transcript", record.transcript || "");
      form.append("ocrSource", record.transcript ? "client" : "pending");

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
      running = true;
      try {
        for (;;) {
          const dirty = await Store.dirtyPages();
          if (!dirty.length) { onStatus({ state: "clean", pending: 0 }); backoff = 0; break; }
          onStatus({ state: "syncing", pending: dirty.length });

          let progressed = false;
          for (const record of dirty) {
            try {
              const out = await uploadPage(record);
              if (!out.stillDirty) progressed = true;
            } catch (e) {
              // 4xx means this page will never be accepted as-is. Retrying it
              // forever would block every page behind it, so leave it dirty,
              // report it, and move on rather than spinning.
              const status = e && e.status;
              onStatus({ state: "error", pending: dirty.length, message: describe(e), fatal: status >= 400 && status < 500 });
              backoff = Math.min(backoff ? backoff * 2 : 5000, 300000);
              return;
            }
          }
          if (!progressed) break;   // nothing moved; avoid a hot loop
        }
      } finally {
        running = false;
        if (queuedAgain) { queuedAgain = false; setTimeout(syncNow, 50); }
      }
    }

    function describe(e) {
      if (!navigator.onLine) return "offline";
      const msg = String((e && e.message) || e);
      if (msg.startsWith("401") || msg.startsWith("403")) return "signed out";
      if (msg.startsWith("413")) return "page too large";
      return msg.slice(0, 80);
    }

    // Sync when the network returns, when the tab comes back, and periodically.
    // Deliberately NOT on every stroke: that would put the network in the middle
    // of writing, which is the one place it must never be.
    function start() {
      window.addEventListener("online", () => syncNow());
      document.addEventListener("visibilitychange", () => { if (!document.hidden) syncNow(); });
      setInterval(() => { if (navigator.onLine) syncNow(); }, 60000);
      syncNow();
    }

    return { syncNow, start, renderPage, RENDER_SCALE };
  }

  return { create, RENDER_SCALE };
});
