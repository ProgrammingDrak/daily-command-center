/* global console, __dirname, fetch, URL, window, process, openAddModal */
// Run against the disposable task-details review server. Never seed production.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const base=process.env.DCC_DETAIL_REVIEW_URL || 'http://127.0.0.1:8301';
const out=path.resolve(__dirname,'../test-results/task-detail-tabs');
fs.mkdirSync(out,{recursive:true});
(async()=>{
 assert.equal((await(await fetch(base+'/api/health')).json()).database,'fixture');
 const executablePath=process.env.CHROME_PATH || (process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
 const browser=await chromium.launch({headless:true,executablePath});
 const errors=[], checks=[];
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
  await page.goto(base);
  await page.waitForFunction(()=>window.blockStore&&typeof openAddModal==='function');
  const open=async()=>{await page.evaluate(()=>openAddModal('review-detail-task'));await page.locator('#am-tab-photos[aria-selected="true"]').waitFor();};
  await open();
  assert.equal(await page.locator('[data-am-tab]').count(),5);
  assert.equal(await page.locator('#am-tab-settings,#am-tab-notes,#am-notes-block-editor').count(),0);
  await page.locator('#am-tab-photos').press('ArrowRight');
  assert.equal(await page.locator('#am-tab-actions').getAttribute('aria-selected'),'true');
  for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:844});
   for(const key of ['photos','actions','subtasks','history','automation']){
    await page.locator('#am-tab-'+key).click();
    assert.equal(await page.locator('.am-detail-panel:visible').count(),1);
    assert.equal(await page.locator('.add-modal-body').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
   }
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('#am-tab-photos').click();
  await page.locator('#am-sources-section > summary').click();
  assert((await page.locator('#am-source-references').innerText()).includes('Project brief'));
  await page.getByRole('textbox',{name:'Task journal',exact:true}).fill('Review journal entry');
  await page.getByRole('button',{name:'Save journal',exact:true}).click();
  await page.getByText('Journal saved.',{exact:true}).waitFor();
  await page.locator('#am-source-form [name=url]').fill('https://example.test/launch');
  await page.locator('#am-source-form [name=name]').fill('Launch notes');
  await page.locator('#am-source-form button').click();
  await page.getByRole('link',{name:/Open link source: Launch notes/}).waitFor();
  await page.locator('#am-tab-actions').click();
  await page.getByRole('button',{name:'Convert…',exact:true}).click();
  await page.getByRole('button',{name:'Back',exact:true}).click();
  await page.getByRole('button',{name:'Lock',exact:true}).click();
  await open();await page.locator('#am-tab-actions').click();
  await page.getByRole('button',{name:'Unlock',exact:true}).waitFor();
  await page.locator('#am-tab-history').click();
  await page.locator('#am-work-actions [data-work-action=start]').click();
  await page.locator('#am-work-actions [data-work-action=pause]').click();
  await page.locator('#am-work-history .work-history-row').first().waitFor();
  await page.locator('#am-work-actions [data-work-complete]').waitFor();
  await page.locator('#am-tab-photos').click();
  await page.screenshot({path:path.join(out,'journal-mobile.png')});
  await page.locator('#am-tab-actions').click();
  await page.screenshot({path:path.join(out,'actions-mobile.png')});
  await page.locator('#add-modal-save').click();
  await page.locator('#am-tab-photos').click();
  await page.locator('#am-sources-section > summary').click();
  assert.equal(await page.locator('#am-source-form [name=url]').isEnabled(),false);
  checks.push('five accessible tabs; mobile layouts; journal and sources; shared conversion and lock; work controls in history; read-only sources');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'qa.json'),JSON.stringify({checks,errors},null,2));
  console.log('PASS task details cleanup',checks);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
