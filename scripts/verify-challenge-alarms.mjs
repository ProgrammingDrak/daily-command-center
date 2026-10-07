/* global window, document, navigator, DCCAlarmStore, innerWidth */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const { chromium } = require('playwright-core');
const base = process.argv[2] || 'http://127.0.0.1:8199';
const target = new URL(base);
if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw Error('Use the local database-free review server only.');
const review = await fetch(new URL('/api/auth/me', base)).then(r=>r.json());
if (review.user?.username !== 'review' || review.user?.name !== 'Review User') throw Error('Target is not the database-free review fixture.');
const shots = process.argv[3] || path.join(root, 'test-results', 'challenge-alarms');
fs.mkdirSync(shots,{recursive:true});
const chrome = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(p=>p && fs.existsSync(p));
const browser = await chromium.launch({ executablePath: chrome, headless:true });
const checks = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS '+name); };
async function setup(context, options = {}) {
  await context.addInitScript(({ noLocks, denyStorage, denyAudio }) => {
    const RealDate = Date;
    window.__alarmNow = new RealDate('2026-10-07T12:00:00Z').getTime();
    window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [window.__alarmNow])); } static now() { return window.__alarmNow; } };
    window.__audioCalls = 0;
    window.AudioContext = class {
      constructor() { window.__audioCalls++; this.currentTime = 0; this.state = 'running'; this.destination = {}; }
      resume() { return denyAudio ? Promise.reject(Error('Denied')) : Promise.resolve(); }
      close() { this.state = 'closed'; return Promise.resolve(); }
      createOscillator() { return { frequency:{value:0}, connect(){}, start(){}, stop(){} }; }
      createGain() { return { gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){} }; }
    };
    window.webkitAudioContext = window.AudioContext;
    if (noLocks) Object.defineProperty(navigator,'locks',{value:undefined});
    if (denyStorage) Object.defineProperty(window,'indexedDB',{value:{open(){throw Error('Storage denied');}}});
  }, options);
}
async function read(page) { return page.evaluate(() => DCCAlarmStore.transact()); }
async function until(fn) { for (let i=0;i<100;i++) { if (await fn()) return; await new Promise(r=>setTimeout(r,50)); } throw Error('Timed out waiting for persisted state'); }
async function open(page) {
  await page.goto(base); await page.waitForFunction(() => document.getElementById('dcc-alarms-open')?.getAttribute('aria-label')?.includes('Browser prototype')); 
  await page.locator('#dcc-alarms-open').click();
  await page.getByRole('heading',{name:'Clock & challenge alarms'}).waitFor();
}
async function save(page, label, challenge = 'math') {
  const form = page.locator('#alarm-form');
  await form.locator('[name=label]').fill(label);
  await form.locator('[name=challenge]').selectOption(challenge);
  await form.locator('[name=mode]').selectOption('once');
  await form.locator('[name=date]').fill('2026-10-07');
  await form.locator('[name=time]').fill('12:01');
  await form.locator('[name=snoozes]').selectOption('1');
  await form.getByRole('button',{name:'Save alarm locally'}).click();
  await page.getByText('Saved locally. No background wake-up is scheduled.',{exact:true}).waitFor();
}
try {
  const context = await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'UTC',reducedMotion:'reduce'});
  await setup(context);
  const page = await context.newPage(); await open(page);
  check('prototype limitations and local ownership visible', await page.getByText(/not a dependable wake-up alarm/).isVisible());
  check('opening alarm UI creates no audio', await page.evaluate(() => window.__audioCalls) === 0);
  await save(page,'Morning math'); await save(page,'Morning quiz','quiz');
  check('one-off definitions persist atomically', (await read(page)).alarms.length === 2);
  await page.locator('.dcc-overlay-body').evaluate(el=>el.scrollTop=0); await page.screenshot({path:shots+'/desktop-alarms.png'});
  await page.getByRole('button',{name:'Start visible session',exact:true}).click();
  await page.getByRole('button',{name:'Stop visible session',exact:true}).waitFor();
  const second = await context.newPage(); await open(second);
  await second.getByRole('button',{name:'Start visible session',exact:true}).click();
  await second.getByText(/Another DCC tab has the alarm session/).waitFor();
  check('second tab cannot acquire scheduler lease',true);
  await second.close();
  await page.bringToFront(); await page.evaluate(() => { window.__alarmNow += 60000; });
  await until(async () => (await read(page)).runs.length === 2);
  check('synthetic scheduled delivery queues distinct alarms', (await read(page)).runs.length === 2);
  await page.getByRole('button',{name:'Resume saved challenge',exact:true}).click();
  await page.getByText('0 of 3 correct answers',{exact:true}).waitFor();
  check('ringing state is silent until a user sound gesture', await page.evaluate(() => window.__audioCalls) === 0);
  await page.locator('[name=answer]').fill('999999'); await page.getByRole('button',{name:'Check answer',exact:true}).click();
  await page.getByText('Try again. Enter the correct whole number.',{exact:true}).waitFor();
  check('wrong answer stays at zero with aria-invalid feedback', await page.locator('[name=answer]').getAttribute('aria-invalid') === 'true' && (await read(page)).runs[0].index === 0);
  const expected = (await read(page)).runs[0].questions[0].answer;
  await page.locator('[name=answer]').fill(expected); await page.locator('[name=answer]').press('Enter');
  await page.getByText('1 of 3 correct answers',{exact:true}).waitFor();
  await page.reload(); await page.locator('#dcc-alarms-open').click();
  await page.getByText('1 of 3 correct answers',{exact:true}).waitFor();
  check('reload preserves question and progress without enabling a session or sound', (await read(page)).runs[0].index === 1 && await page.evaluate(()=>window.__audioCalls) === 0);
  await page.screenshot({path:shots+'/desktop-challenge.png'});
  await page.keyboard.press('Escape'); await page.waitForTimeout(350);
  check('Escape pauses instead of falsely completing', (await read(page)).runs.length === 2);
  check('Escape restores focus to alarm opener', await page.locator('#dcc-alarms-open').evaluate(el=>el===document.activeElement));
  await page.locator('#dcc-alarms-open').click();
  const close = page.getByRole('button',{name:'Pause challenge and stop sound',exact:true});
  await close.focus(); await page.keyboard.press('Shift+Tab');
  check('Shift+Tab wraps inside challenge', await page.getByRole('button',{name:'Emergency stop · skip quiz',exact:true}).evaluate(el=>el===document.activeElement));
  await page.keyboard.press('Tab');
  check('Tab wraps inside challenge', await close.evaluate(el=>el===document.activeElement));
  check('background header inert during challenge', await page.locator('.header').evaluate(el=>el.inert));
  await page.getByRole('button',{name:'Emergency stop · skip quiz',exact:true}).click();
  await page.getByText('0 of 3 correct answers',{exact:true}).waitFor();
  check('emergency stop consumes one occurrence and proceeds to queued challenge', (await read(page)).runs.length === 1);
  while ((await read(page)).runs.length) {
    const s = await read(page), r = s.runs[0];
    await page.locator('[name=answer]').fill(r.questions[r.index].answer);
    await page.locator('[name=answer]').press('Enter');
    await until(async () => { const s = await read(page); return !s.runs.length || s.runs[0].index !== r.index; });
  }
  await page.getByRole('heading',{name:'Clock & challenge alarms'}).waitFor();
  check('quiz completion atomically removes final active challenge', (await read(page)).runs.length === 0);
  await page.getByRole('button',{name:'Practice silently',exact:true}).click();
  await page.getByText(/Practice only. Your schedules are untouched./).waitFor();
  await page.getByRole('button',{name:'Emergency stop · skip quiz',exact:true}).click();
  check('silent practice does not write a scheduled occurrence', Object.keys((await read(page)).handled).length === 2);
  await page.setViewportSize({width:390,height:844});
  await page.locator('.dcc-overlay-body').evaluate(el=>el.scrollTop=0); await page.screenshot({path:shots+'/mobile-alarms.png'});
  check('mobile modal fits viewport', await page.locator('.dcc-modal').evaluate(el=>el.getBoundingClientRect().right<=innerWidth && el.getBoundingClientRect().left>=0));
  await page.getByRole('button',{name:'Practice silently',exact:true}).click();
  await page.screenshot({path:shots+'/mobile-challenge.png'});
  await context.close();
  const blocked = await browser.newContext({viewport:{width:390,height:844},timezoneId:'UTC'}); await setup(blocked,{noLocks:true,denyAudio:true});
  const fallback = await blocked.newPage(); await open(fallback);
  await fallback.getByRole('button',{name:'Start visible session',exact:true}).click();
  await fallback.getByText(/lacks tab coordination/).waitFor();
  check('missing lock support disables scheduling explicitly',true);
  await fallback.getByRole('button',{name:'Preview sound (4 sec)',exact:true}).click();
  await fallback.getByText(/Sound unavailable or blocked/).waitFor();
  check('denied playback has visual fallback',true);
  await fallback.getByRole('button',{name:'Practice silently',exact:true}).click();
  await fallback.getByText(/Practice only/).waitFor(); check('silent practice works with denied capabilities',true);
  await blocked.close();
  const denied = await browser.newContext({timezoneId:'UTC'}); await setup(denied,{denyStorage:true});
  const deniedPage = await denied.newPage(); await open(deniedPage);
  check('storage denial reports failure and disables scheduler',await deniedPage.getByRole('button',{name:'Start visible session',exact:true}).isDisabled());
  await denied.close();
  fs.writeFileSync(shots+'/checks.json',JSON.stringify({checks,silentAudioMock:true},null,2));
  console.log(`${checks.length} browser checks passed; screenshots in ${shots}`);
} finally { await browser.close(); }
