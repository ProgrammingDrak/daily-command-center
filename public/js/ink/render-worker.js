"use strict";
/* global self, importScripts, OffscreenCanvas */

// Mycelium Ink — page rendering, off the main thread.
//
// Uploading a page means rasterising 5.4 megapixels and JPEG-encoding them.
// Done on the main thread that is also servicing the pen, it stalls the stroke
// under someone's hand -- and no amount of scheduling fixes that, it only moves
// where the stall lands. So it does not happen on that thread at all.
//
// This runs in a dedicated Worker with an OffscreenCanvas. The main thread hands
// over a serialized page, gets a Blob back, and does no drawing work of its own.
//
// The drawing code is the SAME strokes.js the live canvas uses, imported rather
// than reimplemented, so a page can never render one way under the pen and
// another way in the vault. It is UMD over `self`, so it loads here unchanged.
importScripts("/public/js/ink/strokes.js");

const S = self.InkStrokes;

self.addEventListener("message", (event) => {
  const msg = event.data || {};
  const id = msg.id;
  try {
    const page = S.deserialize(msg.ink);
    const scale = Number(msg.scale) || 1;
    const canvas = new OffscreenCanvas(
      Math.round(page.w * scale),
      Math.round(page.h * scale),
    );
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context in this worker");
    S.drawPage(ctx, page, { scale, background: msg.background || "#ffffff" });

    canvas.convertToBlob({ type: msg.type || "image/jpeg", quality: msg.quality })
      .then((blob) => {
        // Safari does not throw when it cannot encode the requested format --
        // it hands back a PNG. A PNG of this canvas is several megabytes rather
        // than a few hundred kilobytes, so the caller has to be told the truth
        // and fall back, instead of silently uploading the wrong thing.
        self.postMessage({ id, ok: true, blob, type: blob.type, bytes: blob.size });
      })
      .catch((e) => {
        self.postMessage({ id, ok: false, error: String((e && e.message) || e) });
      });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
});
