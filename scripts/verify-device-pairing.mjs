/* global document, innerWidth */
// Exercises the real DCC login, Connections UI and pairing routes on an isolated
// localhost server. Use the disposable account configured when starting it.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = process.env.DCC_PAIRING_REVIEW_URL || 'http://127.0.0.1:8491';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Local review only');
const password = process.env.DCC_PAIRING_REVIEW_PASSWORD;
assert(password, 'Set DCC_PAIRING_REVIEW_PASSWORD for the disposable account');
const browser = await chromium.launch({ headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
try {
  const glassesContext = await browser.newContext({viewport:{width:600,height:600}});
  const phoneContext = await browser.newContext({viewport:{width:375,height:812}});
  const glasses = await glassesContext.newPage(), phone = await phoneContext.newPage();
  const errors = [];
  for (const page of [glasses, phone]) {
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) return route.abort();
      return route.continue();
    });
  }

  await glasses.goto(base + '/?device=glasses');
  await glasses.getByRole('button',{name:'Sign in on your phone',exact:true}).click();
  const output = glasses.locator('#pair-code');
  await output.waitFor();
  const code = (await output.innerText()).replace(/\s/g,'');
  assert.match(code, /^\d{6}$/);
  const pairingCookie = (await glassesContext.cookies()).find(cookie => cookie.name === 'dcc_session').value;

  // Unauthenticated phone follows DCC's ordinary sign-in and keeps its destination.
  await phone.goto(base + '/connect-glasses');
  assert(new URL(phone.url()).pathname === '/login');
  assert.equal(new URL(phone.url()).searchParams.get('next'), '/connect-glasses');
  await phone.getByRole('textbox',{name:'Username or email',exact:true}).fill('pairing-review');
  await phone.locator('#password').fill(password);
  await phone.locator('#authForm button[type="submit"]').click();
  await phone.waitForURL(base + '/connect-glasses');

  await phone.getByRole('textbox',{name:'Pairing code',exact:true}).fill('incorrect');
  await phone.getByRole('button',{name:'Continue',exact:true}).click();
  await phone.getByRole('status').filter({hasText:'six digits'}).waitFor();
  await phone.getByRole('textbox',{name:'Pairing code',exact:true}).fill(code);
  await phone.getByRole('button',{name:'Continue',exact:true}).click();
  await phone.getByRole('heading',{name:'Connect these glasses?',exact:true}).waitFor();
  assert.equal((await phone.locator('#matching-code').innerText()).replace(/\s/g,''),code);
  assert.match(await phone.locator('#pair-account').innerText(), /pairing-review/);

  // Inspection by itself must never sign the glasses in.
  assert.equal(new URL(glasses.url()).pathname,'/login');
  let heldRedemption;
  let markRedemptionHeld;
  const redemptionHeld = new Promise(resolve => { markRedemptionHeld = resolve; });
  await glasses.route('**/api/auth/device/redeem', route => {
    heldRedemption = route;
    markRedemptionHeld();
  });
  await phone.getByRole('button',{name:'Connect glasses',exact:true}).click();
  await phone.getByRole('heading',{name:'Glasses approved',exact:true}).waitFor();
  await glasses.bringToFront();
  await redemptionHeld;
  await glasses.getByRole('button',{name:'Cancel',exact:true}).click();
  await heldRedemption.continue();
  await glasses.waitForURL(base + '/?device=glasses',{timeout:15000});
  assert.notEqual((await glassesContext.cookies()).find(cookie=>cookie.name==='dcc_session').value,pairingCookie);
  const responses = await Promise.all([
    phoneContext.request.get(base + '/api/me'),
    glassesContext.request.get(base + '/api/me')
  ]);
  for (const response of responses) assert.equal(response.status(),200);
  const [phoneMe, glassesMe] = await Promise.all(responses.map(response=>response.json()));
  assert(phoneMe.userId);
  assert(phoneMe.workspaceId);
  assert.equal(glassesMe.userId,phoneMe.userId);
  assert.equal(glassesMe.workspaceId,phoneMe.workspaceId);

  // Normal phone navigation exposes the new entry in the existing Connections UI.
  await phone.goto(base + '/');
  await phone.getByRole('button',{name:'Settings and utilities',exact:true}).click();
  await phone.getByRole('menuitem',{name:'Connections',exact:true}).click();
  await phone.getByRole('link',{name:/Connect glasses/}).click();
  await phone.waitForURL(base + '/connect-glasses');
  await phone.getByRole('textbox',{name:'Pairing code',exact:true}).waitFor();
  assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);

  // A saved session cookie remains authoritative if redemption's JSON is lost.
  const interruptedContext = await browser.newContext({viewport:{width:600,height:600}});
  const interrupted = await interruptedContext.newPage();
  await interrupted.goto(base + '/?device=glasses');
  await interrupted.getByRole('button',{name:'Sign in on your phone',exact:true}).click();
  await interrupted.locator('#pair-code').waitFor();
  const interruptedCode = (await interrupted.locator('#pair-code').innerText()).replace(/\s/g,'');
  let interruptedRedemption;
  let markInterrupted;
  const interruptedHeld = new Promise(resolve => { markInterrupted = resolve; });
  await interrupted.route('**/api/auth/device/redeem', route => {
    interruptedRedemption = route;
    markInterrupted();
  });
  await phone.getByRole('textbox',{name:'Pairing code',exact:true}).fill(interruptedCode);
  await phone.getByRole('button',{name:'Continue',exact:true}).click();
  await phone.getByRole('button',{name:'Connect glasses',exact:true}).click();
  await interrupted.bringToFront();
  await interruptedHeld;
  await interrupted.getByRole('button',{name:'Cancel',exact:true}).click();
  const savedRedemption = await interruptedRedemption.fetch();
  assert.equal(savedRedemption.status(),200);
  await interruptedRedemption.fulfill({response:savedRedemption,body:'{'});
  await interrupted.waitForURL(base + '/?device=glasses',{timeout:15000});
  const recoveredMe = await interruptedContext.request.get(base + '/api/me');
  assert.equal(recoveredMe.status(),200);
  assert.equal((await recoveredMe.json()).userId,phoneMe.userId);

  const retryContext = await browser.newContext({viewport:{width:600,height:600}});
  const retry = await retryContext.newPage();
  await retry.goto(base + '/?device=glasses');
  await retry.getByRole('button',{name:'Sign in on your phone',exact:true}).click();
  await retry.locator('#pair-code').waitFor();
  const firstCode = await retry.locator('#pair-code').innerText();
  await retry.reload();
  await retry.locator('#pair-code').waitFor();
  assert.equal(await retry.locator('#pair-code').innerText(),firstCode);
  let heldStatus;
  let markStatusHeld;
  const statusHeld = new Promise(resolve => { markStatusHeld = resolve; });
  await retry.route('**/api/auth/device/status', route => {
    if (heldStatus) return route.continue();
    heldStatus = route;
    markStatusHeld();
  });
  await statusHeld;
  await retry.getByRole('button',{name:'Cancel',exact:true}).click();
  await heldStatus.continue();
  await retry.getByRole('button',{name:'Sign in on your phone',exact:true}).waitFor();
  await retry.unroute('**/api/auth/device/status');
  await retry.getByRole('link',{name:'Sign in in this window',exact:true}).click();
  await retry.locator('#clerkSignIn').waitFor({state:'attached'});
  assert.equal(new URL(retry.url()).searchParams.get('method'),'browser');
  assert.deepEqual(errors,[]);
  console.log('PASS real DCC phone login return, explicit matching-code approval, cookie rotation, same account/workspace, Connections menu entry, reload, cancel during polling and browser fallback');
} finally { await browser.close(); }
