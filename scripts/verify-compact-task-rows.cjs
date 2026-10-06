/* global document, window, __dirname, console, process */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try {
    for (const width of [1440, 1024, 390]) {
      const page = await browser.newPage({viewport:{width,height:900}});
      await page.setContent('<style>' + ['tokens','dashboard','ui-optimization'].map(name => fs.readFileSync(path.join(root,'public/css/'+name+'.css'),'utf8')).join('\n') + '</style><div id="rows" class="it-list-view"></div>');
      await page.addScriptTag({path:path.join(root,'public/js/itinerary-card.js')});
      await page.evaluate(() => {
        const mount = document.getElementById('rows');
        for (const variant of ['meeting','task','sub','done']) {
          const row = window.renderItineraryListRow({id:variant,title:'Example '+variant}, {
            done:variant==='done',extraClass:variant==='sub'?'sub':'',
            onOpen:()=>{window.opened=true;},onComplete:()=>{},onDuration:()=>{},onAdd:()=>{},durationLabel:'30m',
            titleExtrasHtml:variant==='meeting'?'<button class="card-tags-toggle">1</button>':'<button class="pet-privacy-toggle it-list-privacy public"><span>PUBLIC</span></button>',
            metaHtml:'<span class="tag">TASK</span><span>9:00 AM – 9:30 AM</span>'
          });
          mount.appendChild(row);
        }
      });
      const sizes = await page.locator('.it-list-item').evaluateAll(rows => rows.map(row => ({id:row.dataset.id,height:row.getBoundingClientRect().height,title:row.querySelector('.it-list-title-row').getBoundingClientRect().height,meta:row.querySelector('.it-list-meta').getBoundingClientRect().height})));
      if (width>760) {
        for (const row of sizes.filter(row=>row.id!=='done')) { assert.ok(row.height<=68,JSON.stringify(row));assert.ok(row.title<=24,JSON.stringify(row));assert.ok(row.meta<=24,JSON.stringify(row)); }
        assert.ok(sizes.find(row=>row.id==='done').height<=24,JSON.stringify(sizes));
      } else {
        assert.ok(await page.locator('.btn-duration').first().evaluate(button=>button.getBoundingClientRect().height>=44));
        assert.ok(await page.locator('.pet-privacy-toggle').first().evaluate(button=>button.getBoundingClientRect().height>=44));
      }
      await page.getByRole('button',{name:'Open task details: Example task',exact:true}).focus();
      await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.opened),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
      await page.screenshot({path:'/tmp/dcc-compact-rows-'+width+'.png'});
      console.log('PASS compact task rows '+width+'px',JSON.stringify(sizes));
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
