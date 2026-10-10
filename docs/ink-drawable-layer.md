# Ink drawable-layer building block

Use the existing `InkCanvas` component and `InkStrokes` format as the drawing
foundation for another notebook, sketchpad, or drawing view. This guide preserves
the working implementation; it does not extract a new package, change storage,
or choose a host application. A PhotoCraft/ArtCraft integration or migration is
a separate architecture decision.

## Provenance and validation

The baseline is [PR #406](https://github.com/ProgrammingDrak/daily-command-center/pull/406)
plus [PR #407](https://github.com/ProgrammingDrak/daily-command-center/pull/407),
deployed as [`f278ff9`](https://github.com/ProgrammingDrak/daily-command-center/commit/f278ff9053dcded478933c86fdcf59110f160baf)
with the loaded-client marker `ink-v7`.

On 2026-10-10, the user reported that `ink-v7` works on their physical iPad with
Apple Pencil. This validates the combined fix for the reported use case; it does
not isolate which change removed the freeze or establish coverage of every
iPadOS/device combination. The first rendering-only fix had not resolved the
user's problem. Preserve the input guards together with the rendering behavior.

Independent desktop WebKit and Edge checks verified 99 browser-injected mouse
strokes plus one touch tap, exactly 100 strokes after save/reload, suppression of
toolbar text selection, and usable selection in the rename input. Synthetic
Pencil tests cover rapid strokes and a 10,000-point stroke. These are distinct
from the user's physical-device report.

## Source of truth and boundaries

| Part | Source | Responsibility |
| --- | --- | --- |
| Drawing component | [canvas.js](../public/js/ink/canvas.js) | Pointer ownership, live/committed rendering, tools, undo/redo, cancellation |
| Portable stroke data | [strokes.js](../public/js/ink/strokes.js) | Page units, pressure, vector rendering, versioned serialization |
| Required DOM/CSS pattern | [ink.html](../ink.html) | Canvas stacking, native gesture suppression, editable-dialog boundary |
| Reference host | [app.js](../public/js/ink/app.js) | Notebook navigation, toolbar, debounced local saves |
| Optional local persistence | [store.js](../public/js/ink/store.js) | Account-scoped IndexedDB, local page records |
| Optional remote sync | [sync.js](../public/js/ink/sync.js), [render-worker.js](../public/js/ink/render-worker.js) | Idle scheduling, worker rendering, version-aware upload acknowledgements |

Only `strokes.js` and `canvas.js` are needed for an in-memory drawing surface.
The canvas does not require DCC APIs, authentication, a notebook shelf, OCR,
IndexedDB, or a service worker. Those are host responsibilities. Reuse these
canonical files rather than maintaining a divergent copy inside DCC.

## Minimal host integration

Load `strokes.js` before `canvas.js`; browser globals are `InkStrokes` and
`InkCanvas`. The canvas requires the browser DOM and a 2D canvas context. Its
CommonJS export is not a headless drawing implementation.

```html
<section class="drawing-ui">
  <div class="drawing-status" aria-live="polite"></div>
  <div class="drawing-wrap">
    <canvas class="drawing-base"></canvas>
    <canvas class="drawing-live"></canvas>
  </div>
</section>
<!-- Actual text editors/dialogs belong outside the noneditable drawing UI. -->
<input class="drawing-title" aria-label="Drawing title">
<script src="/public/js/ink/strokes.js"></script>
<script src="/public/js/ink/canvas.js"></script>
```

```css
.drawing-ui, .drawing-ui * {
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}
.drawing-wrap {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  height: 70vh; /* Host supplies a nonzero, visible drawing area. */
  touch-action: none;
}
.drawing-wrap canvas { position: absolute; touch-action: none; }
.drawing-live { pointer-events: none; }
```

```js
const wrap = document.querySelector(".drawing-wrap");
const surface = InkCanvas.create({
  wrap,
  base: wrap.querySelector(".drawing-base"),
  live: wrap.querySelector(".drawing-live"),
  onChange() {
    // Signal the host's debounced local-save scheduler. Keep this callback cheap.
    // This event is synchronous; its listeners must not serialize/render/upload.
    wrap.dispatchEvent(new Event("drawingchange"));
  },
});
surface.loadPage(InkStrokes.emptyPage());
surface.setTool("pen");
surface.setColor("#1b1b2f");
surface.setSize(2.6);

// At the host's scheduled save boundary, make a durable snapshot:
function snapshotCommittedDrawing() {
  return InkStrokes.serialize(surface.getPage());
}
// To reopen a saved page when no stroke is active:
// surface.loadPage(InkStrokes.deserialize(savedJson));
```

This example intentionally has no storage adapter. Wire `drawingchange` to the
host's local durability path before presenting the view as a saved notebook.
For an existing notebook, load its saved page instead of `emptyPage()`; never
replace real data with the example's empty page during adoption or testing.

## Input and rendering contract

- Apply selection/callout suppression to the paper and noneditable chrome,
  including status labels. `touch-action` controls pan/zoom, not text selection.
  Do not apply the nonselection rule globally to editable controls. DCC keeps
  rename/create dialogs outside `#writer`; integrations must preserve an
  equivalent boundary and test editing, selection and paste.
- The paper's non-passive `touchstart`/`touchmove` listeners cancel native
  defaults. They do not draw. Drawing from both touch and pointer events would
  duplicate strokes. Do not make these listeners passive.
- Mouse and pen draw. Touch draws only until a pen has been observed for that
  component instance. Pencil can cancel a provisional touch that arrived first;
  a resting palm must not hold the active pointer hostage. After pen use, touch
  is ignored for drawing. This component does not implement finger navigation
  or pinch zoom; those require an explicit host gesture design.
- One active pointer owns a stroke. Pointer capture keeps it alive outside the
  paper. Up clears active ownership synchronously before the save callback;
  a subsequent capture-loss event does not commit that finished stroke twice.
  Capture failure clears ownership. Cancel discards provisional pen ink and
  restores provisional erasures. Do not add delayed completion callbacks that
  can clear a newer stroke or remount the canvas on each change.
- Taps draw a dot; zero/nonpositive pressure normalizes to neutral pressure.
  Coalesced samples are feature-detected. Predicted samples are not implemented.
- Committed and live ink use separate canvases, with a detached finalized-prefix
  canvas for the current pen stroke. Pencil lift copies the already-rasterized
  opaque stroke instead of replaying all its segments. Keep the live context
  synchronized: a desynchronized source previously exposed stale pixels during
  copy/clear. Highlighter keeps its per-segment multiply replay for correct
  overlaps; do not flatten it through the opaque-pen shortcut.
- `onChange` runs on the input thread. Full-page serialization, encoding,
  redraws, uploads, or host-framework remounts must not be added to that path.
  The existing host debounces local saves; sync uses an idle delay and worker
  rendering where available. Preserve responsiveness both during strokes and
  between rapid separate strokes.

## Persistence and API contract

| API | Host obligation |
| --- | --- |
| `loadPage(page)` | Call only while input is idle; resets page history and dirty state. Supply a visible wrapper and call `layout()` after revealing/resizing a host panel. |
| `layout()`, `redraw()` | Layout fits fixed page units to wrapper dimensions and caps DPR at 3. Do not drive full redraw from every host state update. |
| `getPage()` | Read committed ink for persistence. During erasing it exposes the original stroke list, so a previous pending save cannot persist provisional deletions. Treat returned objects as borrowed, not immutable snapshots. |
| `isDirty()`, `clearDirty()` | Dirty state is not a version token. Clear only after the corresponding local save succeeds and no newer change has occurred; serialize async saves or track a host revision. |
| `isPenDown()` | Gate expensive host work and page switching. It reports active drawing input, not exclusively physical pen input. |
| `undo()`, `redo()`, `canUndo()`, `canRedo()` | Operate on the current page; history is bounded to 60 entries. Call at an idle input boundary. |
| `setTool()`, `setColor()`, `setSize()` | Existing tools are pen, highlighter and whole-stroke eraser. Select tools between strokes. |
| `renderToCanvas(scale)` | Synchronous full-page white-background render. Schedule outside input; it renders internal state, so do not use it as a persistence snapshot during provisional erasing. |
| `destroy()` | Removes wrap touch and window resize/orientation listeners. It is not a complete reusable-node teardown: base pointer listeners and a pending resize timer are not removed. Use one long-lived instance per DOM canvas pair; do not destroy/recreate repeatedly on the same nodes. |

The portable format remains v1: `{v, w, h, strokes}`; each stroke contains
`tool`, `color`, `size`, and flat `[x, y, pressure, ...]` points in page units.
Use `InkStrokes.serialize`/`deserialize`. Keep editable strokes as source data;
rendered images and OCR are derived artifacts. Do not migrate or clear real
IndexedDB/localStorage merely to adopt this component. The DCC service worker
caches shell assets only and its version is independent of note format.

This is a fixed-page white-paper component, not yet a transparent image-editor
overlay, infinite canvas, transformable layer stack, or general disposal-safe
framework widget. Preserve the input and persistence contract if those features
are added later; the current documentation does not claim them as supported.

## Regression and adoption gates

Use Node 22 and the repository's installed dependencies:

```sh
node --test ink-strokes.test.js ink-live-render.test.js ink-pointer-lift.test.js ink-sync-idle.test.js ink-render-worker.test.js ink-archive.test.js
node scripts/verify-ink-pencil.mjs
node scripts/verify-ink-gestures.mjs
```

`verify-ink-pencil.mjs` defaults to installed Edge; set `INK_ENGINE=webkit` to
exercise desktop WebKit. `verify-ink-gestures.mjs` defaults to WebKit; set
`INK_ENGINE=chromium` for installed Edge. Install the matching official WebKit
runtime with `node node_modules/playwright-core/cli.js install webkit` if needed.
An optional `PLAYWRIGHT_BROWSERS_PATH` must match installation and execution.

The scripts use fresh browser contexts; gesture QA intercepts all HTTP and uses
synthetic IndexedDB data. Never point these fixtures at a real notebook or clear
user storage to make tests pass. Pointer-handler unit tests cover rapid lifts,
palm-first takeover, capture failure/loss, cancellation, resize, highlighter
rendering, and cancelled erasure versus a pending committed snapshot.

Before a new host release, run its normal release gates plus these regressions.
Verify native editing remains usable and repeat a physical iPad check of quick
separate strokes/dots with normal palm contact, then undo, save/reopen and
background/resume. Report engine simulation and actual hardware results
separately. Preserve the user's `ink-v7` success as a baseline, not as a blanket
guarantee for a new host or a refactored input system.

Standards context: [Pointer Events](https://www.w3.org/TR/pointerevents/),
[Safari CSS reference](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariCSSRef/Articles/StandardCSSProperties.html).
