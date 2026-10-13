# Ink implements and paper library

This extends the existing Railway `/ink` application, based on upstream main
`fd853b7df7f6dde255d3364315f9018adbeaee60`. It keeps `InkCanvas` and `InkStrokes`
as the canonical drawing implementation. It does not revive the standalone
Cloudflare branch, introduce PhotoCraft, change IndexedDB schema, or migrate notes.
The loaded-client marker and offline shell cache are now `ink-v8`.

## Inventory and controls

| Implement | Behavior |
| --- | --- |
| Ballpoint | Rounded opaque line; restrained pressure variation |
| Fineliner | Uniform rounded width, independent of pressure |
| Fountain pen | Moderate pressure response plus directional nib angle |
| Graphite pencil | Pressure-controlled width and deterministic graphite grain; softer opacity |
| Mechanical pencil | Fine fixed-width graphite; pressure changes grain strength |
| Marker | Broad opaque chisel impression with restrained pressure and square caps |
| Highlighter | Constant width; one translucent multiply composite per new stroke |
| Brush pen | Strong nonlinear pressure response, from fine to broad |
| Calligraphy | Direction and nib angle control width; independent of pressure |
| Eraser | Existing whole-stroke removal; three radius presets plus a slider |

The implement picker shows procedural previews from the actual renderer, short
behavior descriptions, and an angle control only for directional nibs. Each
implement remembers its color, width and angle on this device. The toolbar has
three useful width presets per implement, a continuous width slider and labeled
color swatches. Erasing never paints white or changes the paper.

The paper picker includes 15 layouts: blank; narrow, college and wide ruled;
dot grid; square grid; engineering grid with emphasized fifth lines; Cornell;
music staff; checklist; daily, weekly and undated monthly planners; handwriting
practice; and isometric dot grid. White, cream and soft gray tones are available.
Spacing uses document millimeters (150 page units per inch), bounded from 4–12 mm.
Default grid spacing is 5 mm; ruled defaults are 6/7/9 mm. Margin controls apply
only to ruled pages; fixed planner layouts disable spacing. Previews, paper under
live ink, worker images and main-thread export images all call `drawPaper`.

Paper changes preserve strokes and can be undone/redone in the same history.
Existing pages without paper metadata stay blank white. New pages inherit the
current page's paper; existing pages are not changed en masse. Blank pages remain
local until written on, matching the existing sync policy; archive export includes
their settings. No orientation change or coordinate migration is introduced.

## Compatibility and rendering

The portable page format remains v1. Optional `paper` metadata and per-stroke
`style: {v: 2, angle}` extend it without changing flat `[x,y,pressure,...]` points.
Old pen/highlighter records keep their old appearance, including historical
per-segment highlighter multiplication. New styles capture settings at stroke
creation; later UI changes cannot restyle existing ink. Graphite texture derives
from stored coordinates and pressure, with no random state to lose on reload.

New styles render through a reusable transparent scratch canvas during full
renders. Live input continues using the existing finalized prefix plus provisional
tail. At lift, the raster is composited once; opacity is applied once for graphite
and modern highlighter. New highlighter coverage therefore has no dark dots from
overlapping pressure samples. Separate highlights still darken where they overlap.
Old highlights retain the existing replay path. The scratch canvas is reused per
destination context and is not allocated per input event. Each full render
clears and composites only the stroke's device-pixel bounds, so a redraw costs
about the stroke's area rather than the whole page per stroke.

The vault's strict upload validator now uses the same tool registry, accepts
normalized paper and v2 nib settings, and still rejects unknown tools, invalid
colors/geometry, invalid optional settings, oversized ink and eraser records.
Without this update, new implements would save locally but be rejected on sync.
No database model, endpoint permission or production credential was changed.

Local saves remain debounced. A revision guard and serialized writes prevent an
older IndexedDB acknowledgement from clearing dirty state for a newer edit.
Navigation/export stop when local saving fails. Paper settings and strokes remain
the editable source; raster images are derived artifacts.

## Input and navigation

The app passes `fingerDraw: "off"` to its existing long-lived canvas instance.
Pencil and mouse draw; fingers can swipe horizontally between pages. Finger
writing is an explicit toolbar toggle. Two touches cancel provisional finger ink
and page-swiping intent. Pencil preempts provisional touch; pen contact and the
800 ms after lift suppress palm-driven page turns. A swipe needs over 80 CSS px,
predominantly horizontal motion and a duration under 1.2 seconds. Small taps,
vertical moves and multitouch do not navigate. Native selection/touch guards and
editable notebook dialogs remain intact.

The reusable `InkCanvas` default remains `auto`, preserving legacy hosts. It takes
an optional `onNavigate(delta)` callback; the DCC app owns page persistence and
navigation. `ResizeObserver` keeps the fixed page fitted when toolbar/pager
wrapping changes the available height. Finger pan/zoom and stylus tilt shading
are not implemented. The fixed-page layout and whole-stroke eraser remain deliberate
boundaries of this upgrade.

## Research references

The scope and familiar controls draw on official
[Goodnotes pen documentation](https://support.goodnotes.com/hc/en-us/articles/7353756785679-Write-and-customize-ink-with-the-Pen-tool)
for separate writing styles and presets, and
[reMarkable template documentation](https://support.remarkable.com/articles/Knowledge/Templates)
for notebook papers, Cornell sections and planners. These are design references;
this is a lightweight browser renderer, not a claim to reproduce those engines.
No paid brush packs, subscription service, new dependency or imported marketplace
asset is required.

## Validation and review evidence

Use Node 20 or 22 and the repository's installed dependencies. There is no build
script for these browser assets; syntax checks and the normal repository lint/test
gates apply.

```sh
npm run lint
npm test -- --test-concurrency=4
node --test ink*.test.js vault-notebook-ingest.test.js vault-notebook-page.test.js
INK_ENGINE=webkit node scripts/verify-ink-pencil.mjs
INK_ENGINE=webkit node scripts/verify-ink-gestures.mjs
INK_ENGINE=webkit node scripts/verify-ink-library.mjs
INK_ENGINE=chromium INK_BROWSER_CHANNEL=chrome node scripts/verify-ink-gestures.mjs
INK_ENGINE=chromium INK_BROWSER_CHANNEL=chrome node scripts/verify-ink-library.mjs
```

For a nondefault official WebKit installation, set `PLAYWRIGHT_BROWSERS_PATH` to
its installation directory. The existing Pencil script also accepts
`INK_BROWSER_CHANNEL=chrome` for installed Chrome. All browser fixtures use fresh
contexts with synthetic IndexedDB, intercept HTTP and never open production or
real user storage. `INK_EVIDENCE_DIR` selects screenshot/result output.

- All original 80 Ink tests pass; new tests cover distinct nib behavior, texture
  stability, old-note shape, paper/archive persistence, all template geometry,
  strict vault validation, finger input/swipes/palms, paper history and fast
  highlighter lift.
- WebKit pixel comparisons for all nine implements have zero pixels differing by
  more than eight channel levels between committed ink and a full redraw; maximum
  observed difference is two. A 10,000-point highlight lifted in 0–1 ms in desktop
  synthetic tests. These timings are not measurements of physical Pencil latency.
- WebKit and Chrome pass per-tool memory, paper undo/redo, nine-source-stroke
  save/reload/archive export, inherited page paper, page swiping, delayed-save
  acknowledgement protection, real worker JPEG rendering with cream tone, and
  layouts at 1440×900, 768×1024, 375×812 and 812×375. No browser exceptions occur.
- Both engines pass real browser-injected 99 mouse strokes plus one opt-in touch
  dot, exactly 100 strokes after reload, toolbar selection suppression and editable
  rename input selection.
- **Chrome pixel limitation:** the strict original 100-stroke pixel comparison
  fails on this Mac's installed Chrome with 2,663 material pixels and a maximum
  channel difference of 82. Running the same script against unchanged upstream
  reproduces those exact counts. New implement pixel results are recorded rather
  than presented as parity; WebKit remains the enforced pixel regression gate.
- No physical iPad/Pencil test was performed for this upgrade. Before release,
  verify rapid writing/dots with palm contact, brush/highlighter appearance,
  deliberate page swipes, finger toggle, undo, reopen, background/resume and export
  on the actual device. Prior `ink-v7` hardware success remains baseline evidence,
  not validation of this new feature.

Screenshots: [implements](qa/ink-library/brushes.png),
[paper picker](qa/ink-library/papers.png), [tablet](qa/ink-library/tablet.png),
[phone](qa/ink-library/phone.png). Full synthetic results:
[WebKit](qa/ink-library/webkit-results.json),
[Chrome](qa/ink-library/chrome-results.json).
