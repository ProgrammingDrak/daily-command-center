const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const scheduleSource = fs.readFileSync(path.join(__dirname, "public/js/schedule-tab.js"), "utf8");
const listRowSource = fs.readFileSync(path.join(__dirname, "public/js/itinerary-card.js"), "utf8");
const dashboardCss = fs.readFileSync(path.join(__dirname, "public/css/dashboard.css"), "utf8");
const optimizationCss = fs.readFileSync(path.join(__dirname, "public/css/ui-optimization.css"), "utf8");

// Bound a rule assertion to ONE declaration block. An unbounded `[\s\S]*?`
// between a selector and a declaration is lazy but not fenced: it walks past `}`
// into unrelated rules, so it reports a match for a declaration that lives 400
// lines away and the assertion can never fail. Two of the asserts below were
// written that way and were verified to pass with the rule they guard deleted.
function cssRule(selectorPattern) {
  // Anchored at a line start so a selector that also appears INSIDE a grouped
  // selector list resolves to its own rule: `.tri-quick svg` heads one rule and
  // is also the second half of `.chk-quick svg, .tri-quick svg`, and an
  // unanchored match returns whichever comes first in the file.
  const found = optimizationCss.match(new RegExp("^" + selectorPattern + "\\s*\\{[^}]*\\}", "m"));
  assert.ok(found, `no rule found for ${selectorPattern}`);
  // Comments out: these blocks are heavily commented, and a comment that quotes
  // a declaration ("setting `height: 18px` here broke the touch target") makes a
  // doesNotMatch assert against its own prose instead of the CSS.
  return found[0].replace(/\/\*[\s\S]*?\*\//g, "");
}

test("list rows keep one completion control in a compact utility rail", () => {
  assert.match(listRowSource, /class="it-list-utility"/);
  assert.match(listRowSource, /class="it-list-nav"/);
  assert.doesNotMatch(listRowSource, /class="wrap-collapse-spacer"/);
  assert.doesNotMatch(listRowSource, /<button class="chk-quick"/);
  assert.match(listRowSource, /quick-complete-control/);
  assert.match(listRowSource, /bindQuickCompleteControl/);
  assert.doesNotMatch(listRowSource, /label:"Complete without notes"/);
  assert.match(scheduleSource, /renderItineraryListRow\(ev,/);
  assert.match(optimizationCss, /\.it-list-item:not\(\.done\) \.it-list-utility/);
  assert.match(optimizationCss, /\.it-list-item:not\(\.done\) \.quick-complete-control::before/);
});

test("completed rows collapse the utility rail with their compact presentation", () => {
  assert.match(dashboardCss, /\.it-list-item\.done:not\(\.sub\) \.it-list-utility\{width:18px;/);
  assert.match(dashboardCss, /\.it-list-item\.done:not\(\.sub\) \.it-list-nav\{display:none\}/);
  // Both of the row's own compact sizes are `height`, and the global touch
  // floor near the top of ui-optimization.css is `min-height`, which wins over
  // a smaller height. Without these two the "collapsed" row measured 48px
  // instead of 18px: the check inflated to 44px and the hidden colour bar held
  // its 36px `.bar` floor.
  assert.match(optimizationCss, /\.it-list-item\.done:not\(\.sub\) \.it-list-check \{ min-height: 0; \}/);
  assert.match(optimizationCss, /\.it-list-item\.done:not\(\.sub\) > \.bar \{ min-height: 0; \}/);
});

test("the quick-complete bolt is a shared inline SVG, not the raw emoji", () => {
  // U+26A1 in an emoji font has asymmetric side bearings and an ascent+descent
  // over 1em, so flexbox centres its advance box while the ink lands high and
  // left. Measured before the swap: 7.5px above the glyph, 11.5px below it.
  const coreSource = fs.readFileSync(path.join(__dirname, "public/js/core.js"), "utf8");
  const cardSource = fs.readFileSync(path.join(__dirname, "public/js/itinerary-card.js"), "utf8");
  const triageSource = fs.readFileSync(path.join(__dirname, "public/js/triage.js"), "utf8");

  // The registry states a default size on every entry (see core.js): a viewBox
  // with no width/height has no intrinsic size and resolves against its
  // container, so a future consumer that forgets the CSS gets a full-width bolt.
  assert.match(coreSource, /bolt: '<svg width="14" height="14" viewBox="0 0 24 24"/);
  for (const [name, src] of [["schedule-tab", scheduleSource], ["itinerary-card", cardSource], ["triage", triageSource]]) {
    assert.doesNotMatch(src, /&#9889;/, `${name}.js still emits the raw bolt emoji`);
  }
  // Every surface reads the one copy in DCC.icons rather than re-inlining a path.
  assert.match(scheduleSource, /_boltSvg=\(window\.DCC&&window\.DCC\.icons&&window\.DCC\.icons\.bolt\)/);
  assert.match(cardSource, /_boltSvg=\(window\.DCC&&window\.DCC\.icons&&window\.DCC\.icons\.bolt\)/);
  assert.match(triageSource, /_triBoltSvg=\(window\.DCC&&window\.DCC\.icons&&window\.DCC\.icons\.bolt\)/);

  // The button must centre it, and the amber plate must centre itself: an
  // absolute ::before with no offsets parks at its static position, not the
  // middle, which is what put the plate 3.5px off-centre on its own.
  // Per declaration, not one whitespace- and order-coupled blob: these three
  // have no interaction, so a reorder must not fail while `flex` -> `block`
  // (the actual regression) would.
  const centering = cssRule("\\.it-list-item:not\\(\\.done\\) \\.it-list-check");
  for (const decl of [/display:\s*inline-flex/, /align-items:\s*center/, /justify-content:\s*center/]) {
    assert.match(centering, decl);
  }
  const plate = cssRule("\\.it-list-item:not\\(\\.done\\) \\.quick-complete-control::before");
  assert.match(plate, /inset:\s*0/);
  assert.match(plate, /margin:\s*auto/);
  // Sizes, per surface. The glyph is `fill: currentColor` with a viewBox, so if
  // any of these is dropped the bolt takes its default size on that surface.
  const listSvg = cssRule("\\.it-list-item \\.quick-complete-control svg");
  assert.match(listSvg, /width:\s*19px/);
  assert.match(listSvg, /height:\s*19px/);
  assert.match(cssRule("\\.tri-quick svg"), /width:\s*13px/);
  assert.match(cssRule("\\.card \\.quick-complete-control\\.chk-quick svg"), /width:\s*20px/);
  // The amber rides the GLYPH, not the button: triage.js also renders a
  // `.tri-quick resp-triage-pause` whose U+23F8 is text-presentation and would
  // have been recoloured by a button-level rule.
  assert.match(optimizationCss, /\.chk-quick svg, \.tri-quick svg \{[^}]*color: #fbbf24/);
  assert.doesNotMatch(optimizationCss, /^\.chk-quick, \.tri-quick \{ color/m);

  // All three files capture the icon in a top-level binding at PARSE time, so if
  // core.js ever loads after them the `|| ""` fallback yields an empty string and
  // the button renders with no glyph at all: no error, no console warning, just a
  // missing control on four surfaces. index.html carries a comment about exactly
  // this hazard; pin the order it depends on, on every page that loads a consumer.
  for (const page of ["index.html", "public-todo.html"]) {
    const html = fs.readFileSync(path.join(__dirname, page), "utf8");
    const core = html.indexOf("/public/js/core.js");
    assert.ok(core >= 0, `${page} loads a bolt consumer but not core.js`);
    for (const consumer of ["itinerary-card.js", "schedule-tab.js", "triage.js"]) {
      const at = html.indexOf(`/public/js/${consumer}`);
      if (at < 0) continue;
      assert.ok(core < at, `${page}: core.js must load before ${consumer}`);
    }
  }

  // The behaviour the swap must not touch.
  assert.match(cardSource, /bindQuickCompleteControl"\)\(completionButton/);
  assert.match(optimizationCss, /\.quick-complete-control\.flash::before \{ animation:qflash/);
  assert.match(optimizationCss, /quick-complete-control:hover::before/);
});

test("row chips carry a line box, not the 44px touch floor", () => {
  // `button { min-height: var(--target-min) }` in this file has no media query,
  // so the privacy pill, tag count, row "+" and the meta line's schedule button
  // were each a 44px box around 10px of text. Both of the row's text lines then
  // measured 44px instead of 18px, which was the whole of the reported dead air
  // between the title and the `TASK / 9:00 AM` line (16.91px measured, 4px by
  // design).
  assert.match(optimizationCss, /\.it-list-item \.it-list-title-row > :is\(\.pet-privacy-toggle, \.card-tags-toggle, \.btn-add-menu, \.wrap-collapse\)/);
  assert.match(optimizationCss, /\.it-list-item \.it-list-meta > button \{[^}]*min-height: 0;/);
  // The completion control keeps the full 44px at every width -- it is the
  // row's primary action. Bounded to the block: the unbounded form of this
  // assertion reached a `min-height: var(--target-min)` several hundred lines
  // downstream and still passed with this rule's whole size group deleted.
  const control = cssRule("\\.it-list-item:not\\(\\.done\\) \\.it-list-check");
  assert.match(control, /(?<!min-)height: var\(--target-min\);/);
  assert.match(control, /(?<!min-)width: var\(--target-min\);/);
  // The chips keep a 44px target too and shed only their claim on row height,
  // via a negative block margin. scripts/verify-ui-optimization.mjs pins BOTH
  // halves of that contract for the privacy chip: "List privacy uses a compact
  // visual pill" (pill <= 24px) and "List privacy keeps a 44 pixel touch
  // target" (button >= 44px). A plain `height: 18px` here satisfies the first
  // and silently reverses the second.
  const chips = cssRule("\\.it-list-item \\.it-list-title-row > :is\\(\\.pet-privacy-toggle, \\.card-tags-toggle, \\.btn-add-menu, \\.wrap-collapse\\)");
  assert.match(chips, /height: var\(--target-min\)/);
  assert.match(chips, /margin-block: calc\(\(18px - var\(--target-min\)\) \/ 2\)/);
  assert.doesNotMatch(chips, /height: 18px/);
  // The row "+" is hidden below 480px; the flex centering above is more
  // specific than that rule, so the hide has to be restated. Slice the block
  // rather than spanning to it: the unbounded form anchored on the FIRST 480px
  // query in the file and still passed with this rule hoisted out of every
  // media query, which would hide the "+" at all widths.
  const narrow = optimizationCss.slice(optimizationCss.lastIndexOf("@media (max-width: 480px) {"));
  const narrowBlock = narrow.slice(0, narrow.indexOf("\n}"));
  assert.match(narrowBlock, /\.it-list-item \.it-list-title-row > \.btn-add-menu \{ display: none; \}/);
  assert.doesNotMatch(
    optimizationCss.slice(0, optimizationCss.indexOf("@media")),
    /\.it-list-item \.it-list-title-row > \.btn-add-menu \{ display: none; \}/,
  );
});

test("a long title ellipsizes instead of wrapping the chips to a second line", () => {
  // `min-width: 0` alone is not enough: with `flex-wrap: wrap` the browser
  // breaks the line on hypothetical main sizes and only shrinks within a line,
  // so a 602px title in a 702px row pushed the "+" down and that row measured
  // 84px while its neighbours measured 64px. Only visible between roughly 900
  // and 1200px, which is why the guard names the width.
  assert.match(optimizationCss, /\.it-list-item \.it-list-title-row > \.ttl \{ min-width: 0; \}/);
  // Stated as a base rule and re-enabled for phones below, NOT as a
  // `min-width: 761px` query -- ui-optimization.test.js pins every stylesheet
  // to the 480/760/1024 breakpoints and a fourth one fails it.
  assert.match(optimizationCss, /^\.it-list-item \.it-list-title-row \{ flex-wrap: nowrap; \}$/m);
  // Below 760px the wrap comes BACK: the title clamps to two lines and takes
  // the full width there on purpose, and pulling the chips up onto its line
  // truncated every row to about thirteen characters. Sliced rather than
  // matched with one cross-block regex -- a lazy `[\s\S]*?` happily spans from
  // an early `max-width: 760px` to a `flex-wrap` in a LATER block, proving
  // nothing.
  // Anchored on the block's own comment, not `lastIndexOf` of the media query:
  // this file is append-only, so the next 760px block added at the bottom moves
  // that anchor past this rule and fails a test with nothing wrong in the CSS.
  // responsive-task-actions.test.js uses the same comment-marker idiom.
  const mobileTail = optimizationCss.slice(optimizationCss.indexOf("/* Mobile was worse than desktop"));
  assert.match(mobileTail, /\.it-list-item \.it-list-title-row \{ flex-wrap: wrap; \}/);
});
