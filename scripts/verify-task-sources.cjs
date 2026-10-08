// Globals below are supplied by Node or by the synthetic browser fixture.
/* global ClipboardEvent, DataTransfer, File, __dirname, console, createBlockEditor, document, failSave: writable, innerWidth, process, stored: writable, taskEntry, window */
const fs=require('fs');const assert=require('assert/strict');
const {chromium}=require('playwright-core');
const root=require('path').resolve(__dirname,'..');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{for(const width of [1280,390]){
 const page=await browser.newPage({viewport:{width,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const html=fs.readFileSync(root+'/index.html','utf8');const section=html.slice(html.indexOf('<div id="am-source-references"'),html.indexOf('<details class="am-disclosure"><summary>Task settings'));
 await page.setContent('<style>'+fs.readFileSync(root+'/public/css/task-sources.css','utf8')+'</style>'+section);
 await page.addScriptTag({path:root+'/public/js/task-sources.js'});
 await page.addScriptTag({path:root+'/public/js/block-editor.js'});
 const code=fs.readFileSync(root+'/public/js/features.js','utf8');const rail=code.slice(code.indexOf('  // One provenance rail'),code.indexOf('  // Load notes into block editor'));
 await page.evaluate(rail=>{
  window.taskEntry={source_id:'https://clever.slack.com/archives/C1/p1',sourceReferences:[{kind:'file',name:'Private original.pdf',url:'https://drive.google.com/file/d/private/view'}]};
  window._addModalBlockId='a';window._addModalTaskId='task-a';window.stored={...taskEntry,title:'Preserved',slack_ts:'1'};window.failSave=false;
  window.DCC.taskSourceUrl=t=>t.source_id;
  window.enqueueRowPropsWrite=async(id,merge)=>{const next=merge(stored);if(failSave)throw new Error('Access revoked');stored=next;return {properties:next};};
  eval(rail);
  window.editor=createBlockEditor(document.getElementById('am-notes-block-editor'),[{type:'paragraph',content:'Synthetic notes'}],{stableImagesOnly:true,onAttachmentError:m=>document.getElementById('am-source-status').textContent=m});
 },rail);
 assert.equal(await page.locator('.task-source-pill').count(),2);
 assert.equal(await page.locator('.task-source-remove').count(),1);
 await page.locator('input[name=url]').fill('https://example.com/image.png');await page.locator('input[name=name]').fill('Original image.png');await page.locator('select').selectOption('image');await page.getByRole('button',{name:'Attach link'}).click();
 await page.waitForFunction(()=>stored.sourceReferences.length===2);assert.equal(await page.evaluate(()=>stored.slack_ts),'1');
 await page.getByRole('button',{name:'Remove source reference: Original image.png',exact:true}).click();await page.waitForFunction(()=>stored.sourceReferences.length===1);
 await page.evaluate(()=>failSave=true);await page.locator('input[name=url]').fill('https://example.com/denied');await page.locator('input[name=name]').fill('Denied');await page.getByRole('button',{name:'Attach link'}).click();await page.waitForFunction(()=>document.getElementById('am-source-status').textContent==='Access revoked');assert.equal(await page.evaluate(()=>stored.sourceReferences.length),1);
 await page.locator('.nb-content').evaluate(el=>{const dt=new DataTransfer();dt.items.add(new File(['png'],'new.png',{type:'image/png'}));el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));});
 assert.match(await page.locator('#am-source-status').textContent(),/uploads are not configured/);assert.equal(await page.locator('.nb-attachment').count(),0);
 await page.locator('.task-source-pill').first().focus();assert.equal(await page.evaluate(()=>document.activeElement.tagName),'A');await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.tagName),'A');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.equal(await page.locator('.task-source-pill').first().evaluate(el=>el.getBoundingClientRect().height>=44),true);
 assert.deepEqual(errors,[]);
 await page.screenshot({path:'/tmp/dcc-sources-'+width+'.png'});await page.close();console.log('PASS synthetic Notes UI '+width+'px: attach, remove, preserved Slack, failed save, blocked upload, keyboard, no overflow');
}}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
