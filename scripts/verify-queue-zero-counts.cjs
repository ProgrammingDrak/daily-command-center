/* global document, window, updateBadge, syncCounts, syncIndicator, getComputedStyle, __dirname, console, process */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'..');
const source=file=>fs.readFileSync(path.join(root,file),'utf8');
const slice=(file,start,end)=>{const s=source(file),at=s.indexOf(start);assert.ok(at>=0);return s.slice(at,s.indexOf(end,at));};
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
  const index=source('index.html'),at=index.indexOf('<div class="queue-pill"'),capsule=index.slice(at,index.indexOf('</div>',at)+6);
  for(const width of [1440,1024,760,480,390,320]){
   const page=await browser.newPage({viewport:{width,height:900}});
   await page.setContent('<style>'+['tokens','dashboard','ui-optimization'].map(n=>source('public/css/'+n+'.css')).join('\n')+'</style><div class="header"><div><h1>Daily Command Center</h1><div class="date-nav" id="date-nav"><button>Today</button>'+capsule+'</div></div><div>Clock</div></div>');
   await page.addScriptTag({content:'const TRIAGE_LABEL="Triage",UNSCHEDULED_LABEL="Unscheduled",LABEL="Whenever";window._lastCount=0;'+slice('public/js/whenever.js','  function setText(','  // Rebuilding a list')+slice('public/js/delegated.js','  function updateBadge(','  // Plain-text nudge')+slice('public/js/catch-up.js','  function syncIndicator(','  function setIndicatorCount(')});
   for(const count of [0,3,99]){
    await page.evaluate(count=>{syncCounts(count,count,count);updateBadge(count);window._lastCount=count;syncIndicator();document.getElementById('loose-ends-pill').hidden=false;},count);
    const badges=await page.locator('.queue-seg-count').evaluateAll(nodes=>nodes.map(n=>({count:n.textContent,visible:getComputedStyle(n).display!=='none'&&n.getBoundingClientRect().width>0,clipped:n.scrollWidth>n.clientWidth,label:n.parentElement.getAttribute('aria-label')})));
    assert.equal(badges.length,5);
    for(const badge of badges){assert.equal(badge.count,String(count));assert.equal(badge.visible,true);assert.equal(badge.clipped,false);assert.ok(badge.label.includes(String(count)),JSON.stringify(badge));}
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
   }
   await page.evaluate(()=>{syncCounts(0,0,0);updateBadge(0);window._lastCount=0;syncIndicator();document.getElementById('loose-ends-pill').hidden=false;});
   await page.screenshot({path:'/tmp/dcc-zero-pills-'+width+'.png'});
   console.log('PASS queue zero/count labels '+width+'px: five visible badges, 0/3/99, no clipping/overflow');
   await page.close();
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
