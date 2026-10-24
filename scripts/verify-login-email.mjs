/* global window, document, sessionStorage */
// Executes the real login page and drake-auth bridge with synthetic Clerk UI,
// verification and sync responses. No email, provider grant or real session.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url);
const html = await fs.readFile(new URL('../login.html', import.meta.url), 'utf8');
const helper = await fs.readFile(new URL('../public/js/login-return.js', import.meta.url), 'utf8');
const bridge = await fs.readFile(require.resolve('drake-auth/browser'), 'utf8');
const browser = await chromium.launch({ headless: true, executablePath: process.env.DCC_CHROMIUM_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) });
const base = 'http://127.0.0.1:8399', target = '/glasses.html?view=tasks';
const context = await browser.newContext(), page = await context.newPage(), errors = [];
page.on('pageerror', e => errors.push(e.message));
let syncs = 0, failSync = true;
await page.addInitScript(() => {
  let listener;
  window.Clerk = {
    load: async () => {}, user: null, session: { getToken: async () => 'synthetic-clerk-token' },
    addListener: fn => { listener = fn; return () => {}; },
    unmountSignIn: () => {},
    mountSignIn(el) {
      el.innerHTML = '<div class="cl-signIn-start"><button type="button">Continue with Google</button><form class="cl-form"><label>Email address<input type="email" required></label><button type="submit">Continue with email</button></form></div>';
      el.querySelector('form').addEventListener('submit', event => {
        event.preventDefault();
        el.innerHTML = '<form><label>Verification code<input inputmode="numeric" required></label><p role="alert" id="codeError"></p><button type="submit">Verify code</button></form>';
        el.querySelector('form').addEventListener('submit', e => {
          e.preventDefault();
          if (el.querySelector('input').value !== '123456') { document.getElementById('codeError').textContent = 'Code is incorrect or expired'; return; }
          listener({ user: { id: 'synthetic-verified-user' } });
        });
      });
    }
  };
});
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  assert.equal(url.origin, base, 'No external auth or email requests');
  assert.equal(url.search.includes('synthetic-clerk-token'), false);
  if (url.pathname === '/login') return route.fulfill({ contentType: 'text/html', body: html });
  if (url.pathname === '/public/js/login-return.js') return route.fulfill({ contentType: 'application/javascript', body: helper });
  if (url.pathname === '/vendor/drake-auth/browser.js') return route.fulfill({ contentType: 'application/javascript', body: bridge });
  if (url.pathname === '/api/auth/config') return route.fulfill({ contentType: 'application/json', body: '{"clerkPublishableKey":"synthetic-config"}' });
  if (url.pathname === '/api/auth/clerk-sync') {
    syncs++; assert.equal(request.method(), 'POST'); assert.equal(request.headers().authorization, 'Bearer synthetic-clerk-token');
    return route.fulfill({ status: failSync ? 503 : 200, contentType: 'application/json', body: failSync ? '{"error":"Synthetic sign-in sync interrupted"}' : '{"ok":true}' });
  }
  return route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic destination</h1>' });
});
try {
  for (const [width, height] of [[600, 600], [375, 812], [1440, 1000]]) {
    await page.setViewportSize({ width, height }); await page.goto(base + '/login?next=' + encodeURIComponent(target));
    await page.getByRole('textbox', { name: 'Email address', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  }
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('status').filter({ hasText: 'If nothing opens' }).waitFor();
  assert.equal(syncs, 0);
  await page.getByRole('textbox', { name: 'Email address', exact: true }).fill('fixture@example.invalid');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('dcc-clerk-pending')), null);
  await page.getByRole('button', { name: 'Continue with email' }).click();
  await page.getByRole('textbox', { name: 'Verification code' }).fill('000000');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await page.getByRole('alert').filter({ hasText: 'incorrect or expired' }).waitFor(); assert.equal(syncs, 0);
  await page.getByRole('textbox', { name: 'Verification code' }).fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await page.locator('#error.visible').filter({ hasText: 'Synthetic sign-in sync interrupted' }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/login'); assert.equal(syncs, 1);
  failSync = false; await page.getByRole('button', { name: 'Verify code' }).click(); await page.waitForURL(base + target); assert.equal(syncs, 2);
  assert.deepEqual(errors, []);
  console.log('PASS email field visible at 600/375/1440; stalled Google keyboard click gives feedback; invalid code never syncs; sync failure remains on login; verified retry returns to glasses through unchanged auth bridge');
} finally { await browser.close(); }
