/* global window, document, ClipboardEvent, DataTransfer, File, __dirname, Buffer, console, innerWidth, _snEditors, _snEditorIsEmpty, _snPruneEmpty, renderStickyNotesList */
const process = require("node:process");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const express = require("express");
const { chromium } = require("playwright-core");
const { createFixtureDb } = require("./task-attachment-test-db.cjs");
const { createStore } = require("../task-attachment-store");
const root = path.resolve(__dirname, "..");
(async () => {
  const fixture = await createFixtureDb();
  const objects = new Map(); let failName = true;
  const storage = { configured: true, async put(key, bytes) { if (bytes.toString().includes("fail once") && failName) { failName = false; throw new Error("Fixture failure"); } objects.set(key, Buffer.from(bytes)); }, async get(key) { return objects.get(key); } };
  const app = express(); app.use(express.json());
  app.use((req,_res,next)=>{req.session={userId:1};req.workspaceId="ws-1";next();});
  require("../routes/task-attachments")(app,{ taskAttachmentStore: createStore({pool:fixture.pool,storage}) });
  app.use('/public',express.static(path.join(root,'public')));
  app.get('/',(_req,res)=>res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/css/task-sources.css"><style>body{background:#20242b;color:#ddd;font:14px system-ui}a{color:#aac9ff}button,input{font:inherit}.nb-content{min-height:40px}#notes{border:1px solid #666;padding:8px}</style><div id="notes"></div><script>window.DCC_ACCOUNT_CONTEXT={userId:1,workspaceId:'ws-1'}</script><script src="/public/js/task-attachments.js"></script><script src="/public/js/task-sources.js"></script><script src="/public/js/block-editor.js"></script><script>window.controls=window.DCC.TaskAttachments.mount(document.getElementById('notes'),'task');window.editor=createBlockEditor(document.getElementById('notes'),[{type:'paragraph',content:'Fictional task Notes'}],{stableImagesOnly:true,onAttachmentFile:f=>window.controls.add(f)});</script>`));
  const server = await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const browser = await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try {
    for (const width of [1280,390]) {
      await fixture.pool.query('DELETE FROM task_attachments'); objects.clear(); failName=true;
      const page = await browser.newPage({viewport:{width,height:900}}), errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.waitForFunction(()=>document.querySelector('.task-file-panel input') !== null);
      await page.locator('input[type=file]').setInputFiles([
        {name:'success.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic success')},
        {name:'retry.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic fail once')},
      ]);
      await page.waitForFunction(()=>document.querySelector('.task-file-panel [role=status]').textContent.includes('1 failed'));
      assert.equal(await page.getByRole('link',{name:'Download private file: success.txt'}).count(),1);
      assert.equal(await page.getByRole('link',{name:'Download private file: retry.txt'}).count(),0);
      await page.getByRole('button',{name:'Retry failed files'}).click();
      await page.waitForFunction(()=>document.querySelector('.task-file-panel [role=status]').textContent==='Private files saved');
      assert.equal(await page.getByRole('link',{name:/Download private file:/}).count(),2);
      // Reload after acknowledgement: no local JSON/data URL is necessary to recover originals.
      await page.reload(); await page.getByRole('link',{name:'Download private file: retry.txt'}).waitFor();
      page.on('dialog',dialog=>dialog.accept());
      await page.getByRole('button',{name:'Remove: success.txt',exact:true}).click();
      await page.getByRole('button',{name:'Undo removal: success.txt',exact:true}).waitFor();
      assert.equal(await page.getByRole('link',{name:'Download private file: success.txt'}).count(),0);
      await page.getByRole('button',{name:'Undo removal: success.txt',exact:true}).click();
      await page.getByRole('link',{name:'Download private file: success.txt'}).waitFor();
      // A real image paste now uses the same private binary upload, never a data URL.
      await page.locator('.nb-content').evaluate(el=>{const dt=new DataTransfer();dt.items.add(new File([new Uint8Array([137,80,78,71,13,10,26,10,0])],'paste.png',{type:'image/png'}));el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));});
      await page.getByRole('link',{name:'Download private file: paste.png'}).waitFor();
      assert.equal(await page.locator('.nb-attachment').count(),0);
      const downloadPromise=page.waitForEvent('download'); await page.getByRole('link',{name:'Download private file: retry.txt'}).click();
      const download=await downloadPromise; assert.equal(download.suggestedFilename(),'retry.txt'); assert.equal(fs.readFileSync(await download.path(),'utf8'),'Synthetic fail once');
      await page.context().setOffline(true);
      await page.locator('input[type=file]').setInputFiles({name:'offline.txt',mimeType:'text/plain',buffer:Buffer.from('Offline fixture')});
      await page.waitForFunction(()=>document.querySelector('.task-file-panel [role=status]').textContent.includes('1 failed'));
      await page.context().setOffline(false); await page.getByRole('button',{name:'Retry failed files'}).click();
      await page.getByRole('link',{name:'Download private file: offline.txt'}).waitFor();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      assert.equal(await page.getByRole('button',{name:'Remove: success.txt',exact:true}).evaluate(el=>el.getBoundingClientRect().height>=44),true);
      await page.getByRole('link',{name:'Download private file: success.txt'}).focus(); assert.equal(await page.evaluate(()=>document.activeElement.tagName),'A');
      // Account-switch protection also guards the controls on a stale open view.
      await page.evaluate(()=>{window.DCC_ACCOUNT_CONTEXT={userId:2,workspaceId:'ws-2'};});
      await page.getByRole('link',{name:'Download private file: success.txt'}).click();
      assert.match(await page.locator('.task-file-panel [role=status]').textContent(),/Account changed/);
      await page.evaluate(()=>{window.DCC_ACCOUNT_CONTEXT={userId:1,workspaceId:'ws-1'};document.body.insertAdjacentHTML('beforeend','<div id="sn-list"></div><div id="sn-task-list"></div><div id="sn-overlay"></div>');
        const row={id:'quick-note',type:'block',properties:{tags:['pinned'],html:'',text:'',blocks:[]},created_at:'2026-10-08T00:00:00Z',updated_at:'2026-10-08T00:00:00Z'};
        window.USE_BLOCKSTORE={stickyNotes:true};window.deletedNoteIds=[];window.loadNotes=()=>({});window.updateSnBadge=()=>{};
        window.blockStore={getByType:type=>type==='block'?[row]:[],get:id=>id===row.id?row:null,updateBlockDebounced:(_id,props)=>{row.properties=props;},deleteBlock:async id=>{window.deletedNoteIds.push(id);}};
      });
      const features=fs.readFileSync(path.join(root,'public/js/features.js'),'utf8');
      await page.addScriptTag({content:features.slice(features.indexOf('// ======== STICKY NOTES ========'),features.indexOf('function newStickyNote()'))});
      await page.evaluate(()=>renderStickyNotesList());
      const note=page.locator('#sn-list');
      await note.locator('input[type=file]').setInputFiles({name:'note-only.txt',mimeType:'text/plain',buffer:Buffer.from('Fictional independent note original')});
      await note.getByRole('link',{name:'Download private file: note-only.txt'}).waitFor();
      assert.equal(await page.evaluate(()=>_snEditors.get('quick-note').isEmpty()),true);
      assert.equal(await page.evaluate(()=>_snEditorIsEmpty(_snEditors.get('quick-note'))),false);
      await page.evaluate(()=>_snPruneEmpty());assert.deepEqual(await page.evaluate(()=>window.deletedNoteIds),[]);
      await page.evaluate(()=>renderStickyNotesList());await note.getByRole('link',{name:'Download private file: note-only.txt'}).waitFor();
      await note.getByRole('button',{name:'Remove: note-only.txt',exact:true}).click();await note.getByRole('button',{name:'Undo removal: note-only.txt',exact:true}).waitFor();
      await page.evaluate(()=>_snPruneEmpty());assert.deepEqual(await page.evaluate(()=>window.deletedNoteIds),[]);
      await note.getByRole('button',{name:'Undo removal: note-only.txt',exact:true}).click();await note.getByRole('link',{name:'Download private file: note-only.txt'}).waitFor();
      const noteDownloadPromise=page.waitForEvent('download');await note.getByRole('link',{name:'Download private file: note-only.txt'}).click();const noteDownload=await noteDownloadPromise;
      assert.equal(fs.readFileSync(await noteDownload.path(),'utf8'),'Fictional independent note original');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      assert.deepEqual(errors,[]);
      await page.screenshot({path:'/tmp/dcc-attachments-'+width+'.png'}); await page.close();
      console.log('PASS '+width+'px: private upload, partial failure/retry, reload, removal/undo, image paste, byte-exact download, offline retry, account guard, keyboard, independent Quick Note files and safe empty-note pruning');
    }
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); await fixture.cleanup(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
