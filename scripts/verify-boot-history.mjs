/* global document, innerWidth */
// Synthetic history regression: fast API responses must not outrun shell scripts.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const base=process.env.DCC_GLASSES_REVIEW_URL||'http://127.0.0.1:18430';
assert.ok(['localhost','127.0.0.1'].includes(new URL(base).hostname));
assert.equal((await fetch(base+'/api/health').then(r=>r.json())).reviewOnly,true);
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const results=[];
try{
 for(const delta of [false,true]){
  const context=await browser.newContext({viewport:{width:600,height:600}});
  let delayedScript=null;
  await context.route('**/*',async route=>{
   const u=new URL(route.request().url());if(u.origin!==base)return route.abort();
   if(u.pathname==='/public/js/app-config.js')return route.fulfill({contentType:'text/javascript',body:'window.DCC_DELTA_SYNC_ENABLED='+delta+';'});
   if(u.pathname==='/api/sync/bootstrap'){
    const dayState=await fetch(base+'/api/state/day').then(r=>r.json());
    const blocks=await fetch(base+'/api/blocks?date='+dayState.date).then(r=>r.json());
    const globals=(await fetch(base+'/api/blocks?type=block').then(r=>r.json())).filter(b=>!b.date);
    return route.fulfill({json:{date:dayState.date,workspaceId:'synthetic-history',cursor:1,blocks,globals,dayState}});
   }
   if(u.pathname==='/api/sync/pull')return route.fulfill({json:{blocks:[],deletedBlockIds:[],cursor:1,hasMore:false}});
   if(u.pathname===delayedScript)await new Promise(resolve=>setTimeout(resolve,800));
   return route.continue();
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const ready=async()=>{await page.waitForLoadState('load');await page.waitForFunction(()=>!document.querySelector('#api-loading'));await page.locator('[data-collapse-action="expand"]').click();};
  const rows=()=>page.locator('#list-view .it-list-item').evaluateAll(es=>es.map(e=>({id:e.dataset.id,done:e.classList.contains('done')})));
  await page.goto(base+'/?device=glasses');await ready();
  const expected=await rows();assert.ok(expected.some(row=>row.done));
  for(const [script,width] of [['block-store.js',600],['task-library.js',375],['block-store.js',1440]]){
   delayedScript=null;
   await page.setViewportSize({width,height:width===375?812:600});
   await page.getByRole('link',{name:'Full app',exact:true}).click();await ready();
   assert.deepEqual(await rows(),expected);
   delayedScript='/public/js/'+script;
   await page.goBack();await ready();
   assert.deepEqual(await rows(),expected,'history must retain exact task IDs/order/completed state despite late '+script);
   assert.equal(await page.locator('.glasses-nav').count(),1);
   assert.equal(await page.locator('#queue-pill button').count(),5);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   results.push({delta,script,width,rows:expected.length});
  }
  assert.deepEqual(errors,[]);await context.close();
 }
 console.log(JSON.stringify({passed:true,results,hardware:false}));
}finally{await browser.close();}
