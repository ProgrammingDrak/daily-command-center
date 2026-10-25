/* global window, sessionStorage */
// Synthetic browser auth only. All requests are fulfilled locally; no provider,
// credentials, database or production task is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
const html = await fs.readFile(new URL('../login.html', import.meta.url), 'utf8');
const helper = await fs.readFile(new URL('../public/js/login-return.js', import.meta.url), 'utf8');
const handoff = await fs.readFile(new URL('../public/js/login-handoff.js', import.meta.url), 'utf8');
const executablePath = process.env.DCC_CHROMIUM_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
const browser = await chromium.launch({ headless: true, executablePath });
const context = await browser.newContext({ viewport: { width: 600, height: 600 } });
const page = await context.newPage(), errors = [];
page.on('pageerror', e => errors.push(e.message));
const base = 'http://127.0.0.1:8399';
let failPassword = false;
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, base, 'No external navigation or provider request');
  if (url.pathname === '/public/js/login-return.js') return route.fulfill({ contentType: 'application/javascript', body: helper });
  if (url.pathname === '/public/js/login-handoff.js') return route.fulfill({ contentType: 'application/javascript', body: handoff });
  if (url.pathname === '/vendor/drake-auth/browser.js') return route.fulfill({ contentType: 'application/javascript', body: 'export async function initClerkAuth(options) { window.fixtureAuth = options; return { clerk: { user: null } }; }' });
  if (url.pathname === '/api/auth/login') {
    if (failPassword) { failPassword = false; return route.abort(); }
    return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
  }
  if (url.pathname === '/login' || url.pathname === '/register') return route.fulfill({ contentType: 'text/html', body: html });
  return route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic destination</h1>' });
});
async function login(next, suffix = '') {
  await page.goto(base + '/login' + (next === undefined ? '' : '?next=' + encodeURIComponent(next)) + suffix);
  await page.waitForFunction(() => !!window.fixtureAuth);
}
async function password() {
  await page.locator('#username').fill('fixture'); await page.locator('#password').fill('synthetic-password');
  await page.locator('#submitBtn').click();
}
try {
  const target = '/glasses.html?view=tasks&task=fixture&page=2';
  await login(target); await page.evaluate(() => sessionStorage.setItem('dcc.glasses.task-retry.v1:fixture', 'receipt'));
  failPassword = true; await password(); await page.getByRole('alert').filter({ hasText: 'Network error' }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('next'), target);
  await page.reload(); await password(); await page.waitForURL(base + target);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('dcc.glasses.task-retry.v1:fixture')), 'receipt');
  console.log('PASS password interruption, reload and retry retain destination and tab receipt');

  await login(target, '&auth=verifying');
  assert.equal(new URL(await page.evaluate(() => window.fixtureAuth.redirectUrl), base).searchParams.get('next'), target);
  await page.evaluate(() => window.fixtureAuth.onError(new Error('Synthetic provider interruption')));
  await page.getByRole('alert').filter({ hasText: 'Synthetic provider interruption' }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('next'), target);
  assert.equal(new URL(page.url()).searchParams.has('auth'), false);
  await page.reload(); await page.waitForFunction(() => !!window.fixtureAuth);
  await page.evaluate(() => window.fixtureAuth.onSignedIn()); await page.waitForURL(base + target);
  console.log('PASS provider interruption and reload retain local return destination');

  for (const next of [undefined, '//evil.example', '/\\evil.example', '/%2f%2fevil.example', 'https://evil.example', '/login']) {
    await login(next); await password(); await page.waitForURL(base + '/');
    await login(next);
    assert.equal(new URL(await page.evaluate(() => window.fixtureAuth.redirectUrl), base).searchParams.get('next'), '/');
    await page.evaluate(() => window.fixtureAuth.onSignedIn()); await page.waitForURL(base + '/');
  }
  console.log('PASS missing and malicious paths fall back to home for both login methods');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }

// Keep the existing login browser check covering the configured email fallback.
await import('./verify-login-email.mjs');
