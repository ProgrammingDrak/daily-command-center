/* global window, document, Event, historyForTask */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const root = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, 'package.json'));
const { chromium } = require('playwright-core');
const src = fs.readFileSync(path.join(root, 'public/js/delegated.js'), 'utf8');
function fn(name) {
  const match = src.match(new RegExp('  (?:async )?function ' + name + '\\([^]*?\\n  \\}'));
  assert.ok(match, name);
  return match[0];
}
const prompt = src.slice(src.indexOf('  let _checkInPrompt'), src.indexOf('  async function snoozeWaitingItem'));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
for (const width of [1280, 390, 320]) {
  const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: width <= 600, reducedMotion: 'reduce' });
  await page.setContent('<button id="opener">Checked in</button><button id="background">Background</button><div id="delegated-modal-overlay"></div><div id="history"></div>');
  await page.addStyleTag({ content: ':root{--z-overlay:1000;--surface-scrim:#0007;--surface-overlay:#fff;--ink:#111;--target-min:44px;--sp-4:16px;--sp-3:12px;--sp-2:8px;--fs-md:14px;--fs-lg:18px} ' + fs.readFileSync(path.join(root, 'public/css/core-ui.css'), 'utf8') + fs.readFileSync(path.join(root, 'public/css/dashboard.css'), 'utf8') });
  await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js/core-ui.js'), 'utf8') });
  await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js/time-picker.js'), 'utf8') });
  await page.addScriptTag({ content: `
    window.calls=[]; window.refreshes=0; window.toasts=[]; window.failSave=false;
    const item={id:'wait-1',properties:{status:'open',myTask:'Launch plan',checkInDate:'2026-10-07',checkInRepeat:false,checkInDays:7,linkedBlockId:'original'}};
    function getDelegatedItemById(){return item}
    function getAllDelegatedItems(){return [item]}
    function isOpenDelegated(){return true}
    function todayStr(){return '2026-10-07'}
    function closeDelegatedModal(){document.getElementById('delegated-modal-overlay').classList.remove('open')}
    async function afterWaitingAction(){window.refreshes++}
    function toast(...args){window.toasts.push(args)}
    function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c])}
    async function postWaitingAction(id,action,body){
      window.calls.push({id,action,body});
      await new Promise(r=>setTimeout(r,200));
      if(window.failSave)throw new Error('fixture failure');
      item.properties.checkInDate=body.nextCheckInDate;
      item.properties.checkInHistory=[{completedAt:body.completedAt,nextCheckInDate:body.nextCheckInDate,note:body.note}];
      return {ok:true,status:'completed'};
    }
    ${['checkInDaysFor','parseLocalDate','toDateInputValue','cycleKey','cycleDueOf','completeCheckInCycle'].map(fn).join('\n')}
    ${prompt}
    window.openCheckIn=markDelegatedItemCheckedById;
    window.historyForTask=checkInHistoryForTask;
    document.getElementById('opener').onclick=()=>{window.outcome='pending';openCheckIn('wait-1').then(result=>window.outcome=result)};
  ` });
  const replacement = await page.evaluate(()=>{
    const first=window.DCC.overlay.open({title:'Optional setup'});
    first.close('setup-chosen');
    const second=window.DCC.overlay.open({title:'Chosen setup'});
    const different=second!==first;
    const title=second.el.querySelector('.dcc-overlay-title').textContent;
    second.close('fixture-done');
    return {different,title};
  });
  assert.deepEqual(replacement,{different:true,title:'Chosen setup'},'opening during close animation creates the requested overlay');
  await page.locator('.dcc-overlay').waitFor({state:'detached'});
  await page.click('#opener');
  assert.equal(await page.locator('.dcc-overlay').getAttribute('data-overlay-kind'), width <= 600 ? 'sheet' : 'modal');
  assert.equal(await page.locator('#wci-date').inputValue(), '2026-10-14');
  assert.equal(await page.locator('#wci-date').getAttribute('type'),'date','shared enhancement preserves native validation');
  assert.equal(await page.evaluate(()=>document.getElementById('opener').inert), true);
  const geometry = await page.locator('.dcc-overlay-body').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
  assert.ok(geometry.scroll <= geometry.width, `no horizontal overflow at ${width}`);
  await page.waitForFunction(()=>document.activeElement.classList.contains('dcc-overlay-close'));
  await page.focus('.dcc-overlay-close');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('dcc-overlay-close')),true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.type),'submit');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('dcc-overlay-close')),true);
  const snapshots = path.join(root, 'test-results', 'waiting-checkin');
  fs.mkdirSync(snapshots, { recursive: true });
  await page.screenshot({ path: path.join(snapshots, `prompt-${width}.png`) });
  await page.fill('#wci-note','discard this note');
  await page.click('[data-wci-cancel]');
  await page.locator('.dcc-overlay').waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>window.calls.length),0);
  assert.equal(await page.evaluate(()=>window.outcome),false,'Cancel preserves async callers');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'opener');
  await page.click('#opener');
  assert.equal(await page.locator('#wci-note').inputValue(),'');
  await page.keyboard.press('Escape');
  await page.locator('.dcc-overlay').waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>window.calls.length),0);
  await page.click('#opener');
  await page.fill('#wci-date','2026-10-06');
  await page.click('button[type="submit"]');
  assert.equal(await page.evaluate(()=>window.calls.length),0,'invalid date does not write');
  await page.fill('#wci-date','2026-10-20');
  await page.fill('#wci-note','Sent follow-up <script>bad()</script>\nNo reply');
  await page.evaluate(()=>window.failSave=true);
  await page.click('button[type="submit"]');
  await page.locator('[role="alert"]').filter({hasText:'fixture failure'}).waitFor();
  assert.equal(await page.locator('#wci-date').inputValue(),'2026-10-20');
  assert.ok((await page.locator('#wci-note').inputValue()).includes('No reply'));
  await page.evaluate(()=>window.failSave=false);
  await page.focus('button[type="submit"]');
  await page.keyboard.press('Enter');
  await page.evaluate(()=>{
    document.querySelector('.waiting-checkin-form').dispatchEvent(new Event('submit',{cancelable:true}));
    document.querySelector('.waiting-checkin-form').dispatchEvent(new Event('submit',{cancelable:true}));
  });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.dcc-overlay').count(),1,'pending save cannot be dismissed');
  const replaced = await page.evaluate(()=>{const original=window.DCC.overlay.activeBlocking;return window.DCC.overlay.open({title:'Other modal'})===original});
  assert.equal(replaced,true,'pending save cannot be replaced by another blocking overlay');
  await page.locator('.dcc-overlay').waitFor({state:'detached'});
  const state = await page.evaluate(()=>({calls:window.calls,refreshes:window.refreshes,history:historyForTask({id:'original',properties:{}})}));
  assert.equal(state.calls.length,2,'failed request plus one successful request, no duplicate');
  assert.equal(state.calls[1].body.nextCheckInDate,'2026-10-20');
  assert.equal(state.refreshes,1);
  assert.equal(await page.evaluate(()=>window.outcome),true,'successful Save resolves completion callers');
  assert.ok(state.history.includes('Checked in'));
  assert.ok(state.history.includes('&lt;script&gt;bad()&lt;/script&gt;'));
  await page.evaluate(()=>document.getElementById('history').innerHTML=historyForTask({id:'original',properties:{}}));
  assert.equal(await page.locator('#history script').count(),0);
  await page.click('#opener');
  await page.fill('#wci-date','2026-10-07');
  assert.equal(await page.locator('#wci-date').evaluate(el=>el.checkValidity()),true,'today is valid');
  await page.click('button[type="submit"]');
  await page.locator('.dcc-overlay').waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>window.calls[2].body.nextCheckInDate),'2026-10-07');
  assert.equal(await page.evaluate(()=>window.outcome),true);
  console.log(`PASS ${width}px: Cancel, Escape, focus trap, validation, failed-save recovery, keyboard Save, duplicate guard, history escaping`);
  await page.close();
}
} finally { await browser.close(); }
