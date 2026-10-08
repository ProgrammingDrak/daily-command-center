// Browser regression against the explicitly disposable activity review backend.
/* global document, innerWidth */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
const base = process.argv[2] || "http://127.0.0.1:8199";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname), "QA is localhost-only");
const info = await (await fetch(base + "/api/activity-review-info")).json();
assert.equal(info.synthetic, true); assert.equal(info.storage, "memory");
const output = path.resolve(process.env.DCC_QA_OUTPUT || "activity-qa"); await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.DCC_CHROMIUM_PATH ? { executablePath: process.env.DCC_CHROMIUM_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
const page = await context.newPage(), errors = [], checks = [];
page.on("pageerror", e => errors.push(e.message));
const mark = s => { checks.push(s); console.log("PASS " + s); };
const recordUrl = id => "/api/activity/tasks/" + id;
const json = async (url, options) => { const r = await fetch(base + url, options); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
const field = key => page.locator('.act-editor [data-path="' + key + '"]');
const settle = async () => { await page.locator('#activity-dashboard .act-metrics').waitFor(); };
try {
  await page.goto(base); await page.locator('#api-loading').waitFor({ state: 'detached' });
  await page.locator('#activity-tab-btn').click(); await settle();
  await page.locator('#tab-activity [data-path="weight"]').selectOption('kg');
  await page.locator('#tab-activity [data-path="distance"]').selectOption('km');
  assert.match(await page.locator('#activity-dashboard').innerText(), /680\.39/);
  assert.match(await page.locator('#activity-dashboard').innerText(), /6:13/);
  assert.match(await page.locator('#activity-dashboard').innerText(), /1\/2 foods known/);
  await page.screenshot({ path: path.join(output, 'desktop-dashboard.png'), fullPage: true });
  mark('desktop dashboards: units, exercise volume, pace, partial nutrition coverage');
  const all = await json('/api/activity?from=' + info.date + '&to=' + info.date);
  const workout = all.records.find(r => r.title === 'DEMO · Strength & run'), meal = all.records.find(r => r.record.taskType === 'meal');
  await page.locator('[data-act="open"][data-id="' + workout.taskId + '"]').click();
  await field('actual.sets.0.reps').waitFor();
  assert.equal(await field('plan.exercises.0.sets.0.reps').inputValue(), '10');
  await page.locator('[data-act="actual-set"][data-ex="0"][data-set="0"]').click();
  assert.equal(await field('actual.sets.2.reps').inputValue(), '', 'new actuals are never invented');
  await field('actual.sets.2.reps').fill('7'); await field('actual.sets.2.weight').fill('12');
  await field('actual.sets.2.unit').selectOption('kg');
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await page.locator('.act-dialog').waitFor({ state: 'detached' });
  const saved = await json(recordUrl(workout.taskId)); assert.equal(saved.record.actual.sets.length, 3); assert.equal(saved.record.actual.sets[2].planSetId, 'plan-1');
  assert.equal(saved.record.plan.exercises[0].sets[0].reps, 10);
  mark('multiple actual sets persist against one plan without changing planned reps');
  // Mobile edit with another actual set, keyboard-scale form and recovery.
  await page.setViewportSize({ width: 375, height: 900 });
  await page.locator('[data-act="open"][data-id="' + workout.taskId + '"]').click(); await field('actual.sets.2.reps').waitFor();
  await page.locator('[data-act="actual-set"][data-ex="0"][data-set="0"]').click();
  await field('actual.sets.3.reps').fill('4'); await field('actual.sets.3.weight').fill('25');
  const overflow = await page.locator('.act-dialog').evaluate(el => el.scrollWidth > el.clientWidth + 1); assert.equal(overflow, false);
  await field('actual.sets.2.reps').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'mobile-multiple-sets.png') });
  await page.getByRole('button', { name: 'Save record', exact: true }).click(); await page.locator('.act-dialog').waitFor({ state: 'detached' });
  await page.locator('[data-act="open"][data-id="' + workout.taskId + '"]').click(); await field('actual.sets.3.reps').waitFor();
  await page.getByRole('button', { name: 'Undo last saved edit', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-path="actual.sets.3.reps"]'));
  assert.equal((await json(recordUrl(workout.taskId))).record.actual.sets.length, 3);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.locator('.act-dialog').waitFor({ state: 'detached' });
  mark('375px multiple-set editing, no dialog overflow, persisted undo');
  await page.locator('[data-act="open"][data-id="' + meal.taskId + '"]').click(); await field('actual.foods.0.calories').waitFor();
  assert.equal(await field('actual.foods.0.calories').inputValue(), '300'); assert.equal(await field('actual.foods.0.carbs').inputValue(), '');
  await field('actual.foods.0.calories').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'mobile-partial-meal.png') });
  await page.locator('[data-act="archive"]').click(); await page.getByRole('button', { name: 'Restore record', exact: true }).waitFor();
  assert.equal((await json(recordUrl(meal.taskId))).archived, true);
  await page.getByRole('button', { name: 'Restore record', exact: true }).click(); await page.getByRole('button', { name: 'Save record', exact: true }).waitFor();
  assert.equal((await json(recordUrl(meal.taskId))).archived, false);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.locator('.act-dialog').waitFor({ state: 'detached' });
  mark('partial meal fields remain blank; record archive and restoration');
  const emptyDay = new Date(info.date + 'T12:00:00Z'); emptyDay.setUTCMonth(emptyDay.getUTCMonth() + 1, 1);
  for (const key of ['from', 'to']) {
    const input = page.locator('#tab-activity [data-path="' + key + '"]');
    const current = new Date((await input.inputValue()) + 'T12:00:00Z');
    await page.locator('#tab-activity .act-field:has([data-path="' + key + '"]) .tw-field-date').click();
    const months = (emptyDay.getUTCFullYear() - current.getUTCFullYear()) * 12 + emptyDay.getUTCMonth() - current.getUTCMonth();
    for (let i = 0; i < months; i++) await page.locator('.tw-overlay.open .tw-cal-nav').last().click();
    await page.locator('.tw-overlay.open .tw-cal-day').getByText('1', { exact: true }).click();
  }
  await page.getByRole('button', { name: 'Apply dates', exact: true }).click();
  await page.getByText('No workout or meal records in this date range.', { exact: false }).waitFor();
  assert.match(await page.locator('#activity-dashboard').innerText(), /0\/0 foods known/);
  await page.locator('#activity-dashboard .act-metrics').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'mobile-empty-date.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  mark('empty date range shows unknown nutrition and no page overflow');
  await page.locator('#tab-activity [data-act="today"]').click();
  assert.equal(await page.locator('#tab-activity [data-path="to"]').inputValue(), info.date, 'Today uses the DCC server date');
  await page.locator('[data-act="open"][data-id="' + workout.taskId + '"]').waitFor();
  const downloadPromise = page.waitForEvent('download'); await page.locator('[data-act="csv"]').click(); const download = await downloadPromise;
  await download.saveAs(path.join(output, 'synthetic-export.csv')); assert.match(await fs.readFile(path.join(output, 'synthetic-export.csv'), 'utf8'), /actual-1/);
  mark('CSV download contains individual actual sets');
  // Reuse a saved plan, then configure normal DCC scheduled recurrence in the UI.
  await page.locator('[data-act="open"][data-id="' + workout.taskId + '"]').click(); await field('actual.sets.0.reps').waitFor();
  await page.locator('[data-act="reuse"]').click(); await page.getByRole('button', { name: 'Create task', exact: true }).waitFor();
  await field('title').fill('QA · Reused workout'); await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await page.getByRole('button', { name: 'Make repeat…', exact: true }).waitFor();
  assert.equal(await page.locator('[data-path="actual.sets.0.reps"]').count(), 0);
  await page.getByRole('button', { name: 'Make repeat…', exact: true }).click();
  await page.locator('#resp-title').waitFor({ state: 'visible' });
  await page.locator('#resp-title').fill('QA · Recurring workout');
  await page.locator('#resp-repeat-type').selectOption('scheduled');
  await page.locator('#resp-save').click();
  await page.waitForFunction(() => !document.getElementById('responsibility-modal-overlay').classList.contains('open'));
  const definitions = await json('/api/responsibilities');
  const series = (Array.isArray(definitions) ? definitions : definitions.items).find(r => r.properties.title === 'QA · Recurring workout');
  assert.equal(series.properties.activityTaskType, 'workout');
  mark('reuse starts with empty actuals; Make repeat preserves the private workout plan');
  for (const [session, code] of [['none',401],['viewer',403],['other',404]]) {
    const r = await fetch(base + recordUrl(workout.taskId), { headers: { 'x-review-session': session } }); assert.equal(r.status, code);
  }
  const guestExport = await fetch(base + '/api/activity/export?from=' + info.date + '&to=' + info.date, { headers: { 'x-review-session': 'viewer' } }); assert.equal(guestExport.status, 403);
  mark('unauthenticated, viewer and other-owner privacy checks');
  assert.deepEqual(errors, [], 'no browser JavaScript errors');
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ base, synthetic: true, checks, errors, completedAt: new Date().toISOString() }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  await fs.writeFile(path.join(output, 'failure.txt'), error.stack + '\nBrowser errors:\n' + errors.join('\n'));
  throw error;
} finally { await browser.close(); }
