#!/usr/bin/env node
// smoke.mjs — headless smoke test for the DCC frontend.
//
// Boots nothing itself: point it at a running server (default localhost:3987).
// Logs in, loads the app, and asserts the load-bearing invariants this
// overhaul established:
//   - window.DCC core is present (esc/api/toast/dates/modal/sheet/tabs)
//   - every top-bar tab activates and its panel renders
//   - the DCC.modal / DCC.sheet primitives open and close
//   - no unexpected console errors from application assets
//   - no horizontal overflow at 375px on any tab
//
// Uses the gstack `browse` daemon over its CLI (already how we dogfood).
// Run:  node scripts/smoke.mjs [baseURL] [user] [pass]
// Exits non-zero on the first failed assertion. This is the scripted version
// of the manual QA-CHECKLIST preamble — run it before merging any UI PR.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] || "http://localhost:3987";
const USER = process.argv[3] || "drake";
const PASS = process.argv[4] || "clever123";
const TABS = ["schedule", "pet-home", "budget"];
// A FRONTEND smoke test guards frontend health: uncaught JS exceptions and
// failed loads of real static assets. HTTP-status/transport errors on API and
// SSE endpoints (404s on dead routes, SSE reconnect 401s/ERR_* in a headless
// session) are backend/transport concerns, out of scope here — so we count an
// error only if it names a real /public/ asset OR looks like a JS exception.
const APP_ERROR_RX = /\/public\/|TypeError|ReferenceError|SyntaxError|is not defined|is not a function|Uncaught/;

const B = [
  join(process.cwd(), ".claude/skills/gstack/browse/dist/browse"),
  join(homedir(), ".claude/skills/gstack/browse/dist/browse"),
].find(existsSync);
if (!B) { console.error("SMOKE: browse binary not found (gstack)."); process.exit(2); }

let failures = 0;
const br = (...a) => execFileSync(B, a, { encoding: "utf8" }).trim();
const js = (expr) => br("js", expr);
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); failures++; }
}

console.log(`SMOKE: ${BASE}`);
br("goto", `${BASE}/login`);
const loggedIn = js(
  `fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},` +
  `body:JSON.stringify({username:'${USER}',password:'${PASS}'})}).then(r=>r.json()).then(j=>String(!!j.ok))`
);
check("login", loggedIn === "true", loggedIn);
br("goto", `${BASE}/`);
br("wait", "--load");

// core present
const core = js(
  "['esc','api','toast'].every(k=>typeof window.DCC[k]==='function') && " +
  "typeof DCC.dates.todayKey==='function' && typeof DCC.modal==='function' && " +
  "typeof DCC.sheet==='function' && !!DCC.tabs"
);
check("DCC core present", core === "true", core);

// every tab activates + renders
br("viewport", "375x812");
for (const tab of TABS) {
  js(`(document.querySelector('[data-tab="${tab}"]')||{}).click?.();'x'`);
  const active = js(
    `(()=>{const c=document.getElementById('tab-${tab}');` +
    `return c && c.classList.contains('active') ? 'active' : 'inactive';})()`
  );
  check(`tab ${tab} activates`, active === "active", active);
  const rendered = js(`(document.getElementById('tab-${tab}')?.textContent.trim().length||0) > 10`);
  check(`tab ${tab} renders`, rendered === "true");
  const overflow = js("document.documentElement.scrollWidth > window.innerWidth");
  check(`tab ${tab} no h-overflow @375`, overflow === "false", overflow);
}

// Count visibility is covered in catch-up's unit tests. Expose the real pill
// here only long enough to measure the complete mobile CSS cascade and geometry.
js("document.querySelector('[data-tab=schedule]')?.click();'x'");
const looseEndsMobile = js(
  "(()=>{const p=document.getElementById('loose-ends-pill'),n=document.getElementById('date-nav');" +
  "if(!p||!n)return null;const h=p.hidden;p.hidden=false;const b=p.getBoundingClientRect(),nb=n.getBoundingClientRect();" +
  "const ob=[...n.children].filter(c=>c!==p&&getComputedStyle(c).display!=='none').map(c=>c.getBoundingClientRect().bottom);" +
  "const r={visible:getComputedStyle(p).display!=='none'&&b.width>0&&b.height>0,insideViewport:b.left>=0&&b.right<=window.innerWidth,dedicatedRow:b.top>=Math.max(...ob),fullWidth:b.width>=nb.width-1,touchHeight:b.height>=44};" +
  "p.hidden=h;return JSON.stringify(r)})()"
);
const looseEndsMobileResult = looseEndsMobile ? JSON.parse(looseEndsMobile) : null;
check("Loose Ends mobile pill is visible in its own full-width row", !!looseEndsMobileResult && Object.values(looseEndsMobileResult).every(Boolean), looseEndsMobile);

// budget tank renders from the live API (not just an error card): aquarium
// present and /api/budget/state answers with a usage block
js(`(document.querySelector('[data-tab="budget"]')||{}).click?.();'x'`);
await new Promise((r) => setTimeout(r, 1200));
check("budget aquarium renders", js("!!document.querySelector('.bt-aquarium')") === "true");
const budgetState = js(
  "fetch('/api/budget/state').then(r=>r.json()).then(j=>String(!!(j.usage && j.settings && Array.isArray(j.blocks) && j.constants?.bank_units_per_point===1 && j.constants?.bank_unit_cents>=1)))"
);
check("GET /api/budget/state shape", budgetState === "true", budgetState);
check("Money Changer uses Bank Units", js("document.querySelector('.bt-changer')?.textContent.includes('1 pt = 1 Bank Unit')") === "true");
js("document.querySelector('[data-act=add-block]')?.click();const i=document.querySelector('[data-field=description]');if(i){i.value='Dinner for me and Fae';i.dispatchEvent(new Event('input',{bubbles:true}))};'x'");
check("planned purchase auto-categorizes", js("document.querySelector('[data-role=auto-category]')?.textContent.includes('Dining')") === "true");
js("document.querySelector('[data-act=cancel-block]')?.click();'x'");
check("Slots is not a top-level tab", js("!document.querySelector('[data-tab=slots]')") === "true");
check("Feeling lucky launcher renders", js("!!document.querySelector('[data-act=open-casino]')") === "true");
js("document.querySelector('[data-act=open-casino]')?.click();'x'");
check("casino opens inside Budget", js("!document.getElementById('budget-casino').hidden && document.getElementById('budget-home').hidden") === "true");
check("all casino sections remain", js("document.querySelectorAll('#budget-casino .slot-section-tab').length===5") === "true");
check("all casino sections activate", js("[...document.querySelectorAll('#budget-casino .slot-section-tab')].every(b=>{b.click();return document.querySelector('[data-slot-section-panel='+b.dataset.slotSection+']')?.classList.contains('active')})") === "true");
js("document.querySelector('[data-slot-section=machine]')?.click();'x'");
check("casino no h-overflow @375", js("document.documentElement.scrollWidth > window.innerWidth") === "false");
js("document.getElementById('budget-casino-back')?.click();'x'");
check("casino returns to Money Changer", js("document.getElementById('budget-casino').hidden && !document.getElementById('budget-home').hidden") === "true");

// overlay primitives open + close
js("window.__smk=DCC.modal({title:'smoke',body:'x',actions:[{label:'ok',kind:'primary'}]});'x'");
check("modal opens", js("!!document.querySelector('.dcc-modal')") === "true");
js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));'x'");
await new Promise((r) => setTimeout(r, 400));
check("modal closes on Escape", js("!document.querySelector('.dcc-modal')") === "true");

// console errors (minus the known-allowlisted 404s)
const errs = br("console", "--errors");
const unexpected = errs
  .split("\n")
  .filter((l) => /\[error\]/.test(l))
  .filter((l) => APP_ERROR_RX.test(l));
check("no app-code console errors", unexpected.length === 0, unexpected.slice(0, 3).join(" ; "));

console.log(failures ? `\nSMOKE FAILED (${failures})` : "\nSMOKE PASSED");
process.exit(failures ? 1 : 0);
