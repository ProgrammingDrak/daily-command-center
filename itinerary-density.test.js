const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const scheduleSource = fs.readFileSync(path.join(__dirname, "public/js/schedule-tab.js"), "utf8");
const dashboardCss = fs.readFileSync(path.join(__dirname, "public/css/dashboard.css"), "utf8");
const optimizationCss = fs.readFileSync(path.join(__dirname, "public/css/ui-optimization.css"), "utf8");

test("list rows keep one completion control in a compact utility rail", () => {
  assert.match(scheduleSource, /class="it-list-utility"/);
  assert.match(scheduleSource, /class="it-list-nav"/);
  assert.doesNotMatch(scheduleSource, /class="wrap-collapse-spacer"/);
  assert.doesNotMatch(scheduleSource, /<button class="chk-quick"/);
  assert.match(scheduleSource, /quick-complete-control/);
  assert.match(scheduleSource, /bindQuickCompleteControl/);
  assert.doesNotMatch(scheduleSource, /label:"Complete without notes"/);
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

  assert.match(coreSource, /bolt: '<svg viewBox="0 0 24 24"/);
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
  assert.match(optimizationCss, /\.it-list-item:not\(\.done\) \.it-list-check \{\s*display: inline-flex;\s*align-items: center;\s*justify-content: center;/);
  assert.match(optimizationCss, /\.it-list-item:not\(\.done\) \.quick-complete-control::before \{\s*inset: 0;\s*margin: auto;/);
  assert.match(optimizationCss, /\.it-list-item \.quick-complete-control svg \{ display: block;/);

  // The behaviour the swap must not touch.
  assert.match(scheduleSource, /bindQuickCompleteControl\(completionButton/);
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
  // The completion control is the one target that KEEPS the full 44px, at
  // every width -- it is the row's primary action.
  assert.match(optimizationCss, /\.it-list-item:not\(\.done\) \.it-list-check \{[\s\S]*?height: var\(--target-min\);/);
  // The row "+" is hidden below 480px; the flex centering above is more
  // specific than that rule, so the hide has to be restated.
  assert.match(optimizationCss, /@media \(max-width: 480px\) \{[\s\S]*?\.it-list-item \.it-list-title-row > \.btn-add-menu \{ display: none; \}/);
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
  const mobileTail = optimizationCss.slice(optimizationCss.lastIndexOf("@media (max-width: 760px)"));
  assert.match(mobileTail, /\.it-list-item \.it-list-title-row \{ flex-wrap: wrap; \}/);
});
