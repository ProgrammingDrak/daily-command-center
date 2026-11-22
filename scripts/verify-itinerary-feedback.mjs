/* global document, window */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
const origin=process.env.DCC_FEEDBACK_REVIEW_URL||'http://127.0.0.1:8117';
assert.ok(['127.0.0.1','localhost'].includes(new URL(origin).hostname),'Use a disposable localhost fixture');
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const watchdog=setTimeout(()=>{console.error('Feedback review timed out');void browser.close();},120000);
const output='test-results/itinerary-feedback';
await fs.mkdir(output,{recursive:true});
const errors=[];
async function page(width=390) {
  const context=await browser.newContext({viewport:{width,height:900},timezoneId:'America/New_York'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  return page;
}
const request=await browser.newContext();
try {
  const info=await request.request.get(origin+'/api/feedback-review-info').then(r=>r.json());
  assert.equal(info.synthetic,true);
  const dayState=await request.request.get(origin+'/api/state/day').then(r=>r.json());
  assert.equal(dayState.date,info.date,'review bootstrap day must match the fixture day across server timezones');
  assert.equal((await request.request.post(origin+'/review/feedback/reset')).status(),200);
  const owner=await page();
  await owner.goto(origin+'/?tab=tasks&view=list',{waitUntil:'domcontentloaded'});
  await owner.getByRole('button',{name:'Share Itinerary',exact:true}).click();
  const share=owner.locator('.dcc-overlay:has(.itinerary-share-content)');
  await share.getByRole('link',{name:'Preview shared day'}).waitFor();
  assert.equal(await share.getByText('PRIVATE fixture appointment').count(),0);
  assert.equal(await share.getByText('Coffee and plan the day',{exact:true}).count(),1);
  await share.screenshot({path:output+'/share-mobile.png'});
  const shared=await share.getByLabel('Daily itinerary link').inputValue();
  assert.equal(new URL(shared).pathname,info.sharedPath);
  await share.getByRole('button',{name:'Close',exact:true}).click();
  const guest=await page();
  await guest.goto(shared,{waitUntil:'domcontentloaded'});
  const coffee=guest.locator('[data-id="feedback-coffee"]');
  await coffee.getByRole('button',{name:/Comments on Coffee/}).waitFor();
  assert.equal(await guest.getByText('PRIVATE fixture appointment').count(),0);
  assert.equal(await guest.getByText('PRIVATE fixture notes never shared').count(),0);
  assert.equal(await guest.locator('.quick-complete-control,[data-task-collaborate],#itinerary-collaboration').count(),0);
  await coffee.getByRole('button',{name:/clap reaction/}).click();
  await coffee.getByRole('button',{name:/clap reaction.*: 1/}).waitFor();
  assert.equal(await coffee.getByRole('button',{name:/heart reaction/}).textContent(),'❤️ 0');
  await coffee.getByRole('button',{name:/Comments on Coffee/}).click();
  const thread=guest.locator('.dcc-discussion-sheet');
  await thread.getByRole('button',{name:'View 1 reply',exact:true}).click();
  await thread.getByText('@Blair Yes! I will grab a table outside.',{exact:true}).waitFor();
  await thread.getByRole('button',{name:'Reply',exact:true}).first().click();
  await thread.getByLabel('Your name',{exact:true}).fill('Casey');
  await thread.getByLabel('Comment',{exact:true}).fill('I can join you at 9:15.');
  await thread.getByRole('button',{name:'Post',exact:true}).click();
  await thread.getByText('@Blair I can join you at 9:15.',{exact:true}).waitFor();
  // Polling must preserve a blurred draft and its reply target.
  await thread.getByRole('button',{name:'Reply',exact:true}).first().click();
  await thread.getByLabel('Comment',{exact:true}).fill('Keep this unsent draft.');
  await thread.getByRole('heading').click();
  await request.request.post(origin+'/api/public/itinerary/'+info.sharedPath.split('/').pop()+'/contributions',{headers:{'X-DCC-Itinerary':'1'},data:{action:'comment',blockId:'feedback-coffee',name:'Blair',text:'A new message while you are drafting.'}});
  await thread.getByText('A new message while you are drafting.',{exact:true}).waitFor();
  assert.equal(await thread.getByLabel('Comment',{exact:true}).inputValue(),'Keep this unsent draft.');
  assert.match(await thread.locator('.discussion-reply-quote').textContent(),/^Replying to Blair/);
  await guest.reload({waitUntil:'domcontentloaded'});
  await coffee.getByRole('button',{name:/Comments on Coffee/}).click();
  assert.equal(await thread.getByLabel('Comment',{exact:true}).inputValue(),'Keep this unsent draft.');
  assert.match(await thread.locator('.discussion-reply-quote').textContent(),/^Replying to Blair/);
  // A lost response can be retried without duplicating a saved comment.
  let lose=true;
  await guest.route('**/contributions',async route=>{
    if(lose&&route.request().postDataJSON()?.action==='comment'){
      lose=false;await route.fetch();await route.abort();
    }else await route.continue();
  });
  await thread.getByRole('button',{name:'Post',exact:true}).click();
  await thread.locator('output').getByText(/Could not|Failed|fetch/i).waitFor();
  await thread.getByRole('button',{name:'Post',exact:true}).click();
  await thread.getByText('@Blair Keep this unsent draft.',{exact:true}).waitFor();
  const data=await request.request.get(origin+'/api/public/itinerary/'+info.sharedPath.split('/').pop()).then(r=>r.json());
  assert.equal(data.stops[0].comments.filter(c=>c.text==='Keep this unsent draft.').length,1);
  // Delayed successful responses cannot erase a newer draft.
  await guest.unroute('**/contributions');
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  let began;
  const started=new Promise(resolve=>{began=resolve;});
  await guest.route('**/contributions',async route=>{
    const response=await route.fetch();began();await gate;await route.fulfill({response});
  });
  await thread.getByLabel('Comment',{exact:true}).fill('The first message.');
  await thread.getByRole('button',{name:'Post',exact:true}).click();
  await started;
  await thread.getByRole('button',{name:'Close',exact:true}).click();
  await coffee.getByRole('button',{name:/Comments on Coffee/}).click();
  await thread.getByLabel('Comment',{exact:true}).fill('My newer unsent message.');
  await thread.getByRole('heading').click();release();
  await thread.getByText('The first message.',{exact:true}).waitFor();
  assert.equal(await thread.getByLabel('Comment',{exact:true}).inputValue(),'My newer unsent message.');
  await guest.unroute('**/contributions');
  await thread.getByRole('button',{name:'Close',exact:true}).click();
  // Both sides use the same persisted task thread.
  await owner.locator('[data-id="feedback-coffee"]').getByRole('button',{name:/Comments on Coffee/}).click();
  const ownerThread=owner.locator('.dcc-discussion-sheet');
  await ownerThread.getByText('The first message.',{exact:true}).waitFor();
  await ownerThread.getByLabel('Your name',{exact:true}).fill('Alex');
  await ownerThread.getByLabel('Comment',{exact:true}).fill('Looking forward to it!');
  await ownerThread.getByRole('button',{name:'Post',exact:true}).click();
  await ownerThread.getByText('Looking forward to it!',{exact:true}).waitFor();
  // Sharing must load independently while a closed discussion is still posting.
  let releaseOwner,ownerBegan;
  const ownerGate=new Promise(resolve=>{releaseOwner=resolve;});
  const ownerStarted=new Promise(resolve=>{ownerBegan=resolve;});
  await owner.route('**/contributions',async route=>{const response=await route.fetch();ownerBegan();await ownerGate;await route.fulfill({response});});
  await ownerThread.getByLabel('Comment',{exact:true}).fill('An owner message still sending.');
  await ownerThread.getByRole('button',{name:'Post',exact:true}).click();
  await ownerStarted;
  await ownerThread.getByRole('button',{name:'Close',exact:true}).click();
  await owner.getByRole('button',{name:'Share Itinerary',exact:true}).click();
  try {
    await share.getByRole('link',{name:'Preview shared day'}).waitFor();
    assert.equal(new URL(await share.getByLabel('Daily itinerary link').inputValue()).pathname,info.sharedPath);
  } finally {releaseOwner();}
  await share.getByRole('button',{name:'Close',exact:true}).click();
  await owner.unroute('**/contributions');
  await owner.locator('[data-id="feedback-coffee"]').getByRole('button',{name:/Comments on Coffee/}).click();
  await ownerThread.getByText('An owner message still sending.',{exact:true}).waitFor();
  await ownerThread.screenshot({path:output+'/thread-mobile.png'});
  for(const width of [320,390,760,1024,1440]){
    await guest.setViewportSize({width,height:900});
    assert.ok(await guest.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'overflow '+width);
    await guest.screenshot({path:output+'/shared-'+width+'.png'});
  }
  // Real variants share one implementation and differ only by the named constant.
  for(const variant of ['inline','compact','footer']){
    await guest.locator('.itinerary-feedback').evaluateAll((rows,style)=>rows.forEach(row=>{row.dataset.presentation=style;}),variant);
    await guest.setViewportSize({width:390,height:900});
    await guest.screenshot({path:output+'/variant-'+variant+'.png'});
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: owner sharing preview, guest privacy, task reactions, nested replies, owner responses, draft reload/polling, lost-response idempotency, delayed-response drafts and five responsive widths');
}finally{clearTimeout(watchdog);await browser.close();}
