# Phase 2.75 — Timer Button Rework

**Status:** Plan approved, ready to implement. Not started.

**Branch:** main (implement on a new feature branch)

---

## Context

The timer panel needs four button changes. These were designed and planned in a prior Claude session. Implement exactly as specified below.

---

## Change 1: ✓ Complete Button — Timer Keeps Running, Log on Task Switch

**Behavior:**
- Click ✓ → mark current task done immediately (toggleDone) → open task picker
- Timer keeps running the whole time (no pause)
- All elapsed time accumulates on the previous task while the picker is open
- When user picks a new task → log total elapsed time to previous task → transition

**Implementation uses a `_pomoCompleteHook` bridge variable** because `openPomodoro()` calls `pomoSetMode()` which clears `pomoState.startedAt` — we must capture startedAt before that happens.

### Step A — Add hook variable to top of `public/js/prep.js`
```js
let _pomoCompleteHook = null; // { prevTitle, capturedStart } — set by ✓, consumed by openPomodoro
```

### Step B — Replace ✓ click handler in `public/js/prep.js` (~line 88)
```js
document.getElementById("pomo-task-check").addEventListener("click",(e)=>{
  e.stopPropagation(); // don't trigger task card's openTaskPicker
  const task = scheduled.find(s=>s.title===pomoState.title && !s.nested);
  if(task) toggleDone(task.id);
  _pomoCompleteHook = { prevTitle: pomoState.title, capturedStart: pomoState.startedAt };
  openTaskPicker();
});
```

### Step C — Fire hook at top of `openPomodoro()` in `public/js/prep.js` (~line 39)
```js
function openPomodoro(title, durMin){
  if(_pomoCompleteHook){
    const {prevTitle, capturedStart} = _pomoCompleteHook;
    _pomoCompleteHook = null;
    if(capturedStart && prevTitle && prevTitle !== title){
      const elapsed = Math.round((Date.now() - capturedStart) / 1000);
      if(elapsed >= 60) pomoLogSession(prevTitle, elapsed, pomoState.mode);
    }
  }
  clearInterval(pomoState.iv);
  // ... rest of original openPomodoro unchanged ...
}
```

### Step D — Clear hook on picker dismiss in `public/js/sidebar.js` (`closeTaskPicker`)
```js
function closeTaskPicker(){
  _pomoCompleteHook = null;
  document.getElementById("pomo-picker-overlay").classList.remove("open");
}
```

---

## Change 2: ⚡ Lightning Complete Button

A new amber bolt button on the task card for instant, no-modal complete. Timer keeps running.

### HTML — `index.html`, inside `.pomo-task-card` after `#pomo-task-check` (~line 518)
```html
<div class="ptc-lightning" id="pomo-task-lightning" title="Quick complete">
  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="13,2 3,14 12,14 11,22 21,10 12,10"/></svg>
</div>
```

### JS — `public/js/prep.js`, after the pomo-task-check handler
```js
document.getElementById("pomo-task-lightning").addEventListener("click",(e)=>{
  e.stopPropagation();
  const task=scheduled.find(s=>s.title===pomoState.title && !s.nested);
  if(task) toggleDone(task.id);
  showToast("✓ "+pomoState.title+" completed");
  savePomoState();
});
```

### CSS — `public/css/dashboard.css`, near `.ptc-check` styles
```css
.ptc-lightning{width:20px;height:20px;border-radius:4px;background:rgba(251,191,36,0.15);border:1px solid rgba(251,191,36,0.3);color:rgb(251,191,36);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.12s}
.ptc-lightning:hover{background:rgba(251,191,36,0.28);border-color:rgba(251,191,36,0.6)}
```

---

## Change 3: Stop Button (replaces Reset)

Resets the timer and asks inline "Done with [task]?" instead of silently resetting.

### HTML — `index.html`

1. Change `id="pomo-reset"` → `id="pomo-stop"`, text "Reset" → "Stop" (~line 535)
2. Add `id="pomo-secondary"` to the `.pomo-secondary` div (~line 534)
3. Add the inline confirmation block after `pomo-secondary`:

```html
<div id="pomo-stop-confirm" style="display:none;text-align:center;margin-bottom:6px">
  <div class="pomo-stop-q" id="pomo-stop-q">Done with this task?</div>
  <div style="display:flex;gap:6px;justify-content:center;margin-top:6px">
    <button class="pomo-sec-btn accent" id="pomo-stop-yes">Yes, complete it</button>
    <button class="pomo-sec-btn" id="pomo-stop-no">No, keep it</button>
  </div>
</div>
```

### JS — `public/js/prep.js`, replace the `pomo-reset` handler (~line 74)
```js
document.getElementById("pomo-stop").addEventListener("click",()=>{
  clearInterval(pomoState.iv); pomoState.running=false; pomoState.startedAt=null;
  pomoSetMode(pomoState.mode); updateTimerBadge(); savePomoState();
  document.getElementById("pomo-stop-q").textContent='Done with "'+pomoState.title+'"?';
  document.getElementById("pomo-secondary").style.display="none";
  document.getElementById("pomo-stop-confirm").style.display="block";
});
document.getElementById("pomo-stop-yes").addEventListener("click",()=>{
  const task=scheduled.find(s=>s.title===pomoState.title && !s.nested);
  if(task) toggleDone(task.id);
  showToast("✓ "+pomoState.title+" completed");
  document.getElementById("pomo-stop-confirm").style.display="none";
  document.getElementById("pomo-secondary").style.display="flex";
});
document.getElementById("pomo-stop-no").addEventListener("click",()=>{
  document.getElementById("pomo-stop-confirm").style.display="none";
  document.getElementById("pomo-secondary").style.display="flex";
});
```

### CSS — `public/css/dashboard.css`
```css
.pomo-sec-btn.accent{background:rgba(59,130,246,0.15);border-color:var(--accent);color:var(--accent-light)}
.pomo-sec-btn.accent:hover{background:rgba(59,130,246,0.28)}
.pomo-stop-q{font-size:11px;color:var(--text);font-weight:500}
```

---

## Change 4: "I Got Distracted" Button

Small red button below secondary row. Pauses timer, opens modal to log distraction with elapsed time pre-filled.

### HTML — `index.html`

Add after `pomo-stop-confirm`, above `.pomo-dots`:
```html
<button class="pomo-distracted-btn" id="pomo-distracted">⚡ I got distracted</button>
```

Add distraction modal alongside the other modals in index.html (near `task-completion-modal-overlay`):
```html
<div class="completion-modal-overlay" id="distraction-modal-overlay">
  <div class="completion-modal">
    <div class="completion-modal-hdr">
      <h3>Log Distraction</h3>
      <button class="completion-modal-close" id="distraction-modal-close">&times;</button>
    </div>
    <div class="completion-modal-body" style="padding:16px">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">Timer paused. What pulled you away?</div>
      <input type="text" id="distraction-note" placeholder="e.g. Slack, phone call, urgent request..."
        style="width:100%;box-sizing:border-box;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:12px;color:var(--text);margin-bottom:10px">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">Time lost</div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
        <input type="number" id="distraction-mins" min="1" max="120" value="5"
          style="width:60px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:12px;color:var(--text)">
        <span style="font-size:12px;color:var(--text-muted)">minutes</span>
      </div>
    </div>
    <div class="completion-actions">
      <button class="secondary" id="distraction-cancel">Cancel</button>
      <button class="primary" id="distraction-log-resume">Log &amp; Resume</button>
      <button class="secondary" id="distraction-log-stop">Log &amp; Stop</button>
    </div>
  </div>
</div>
```

### JS — `public/js/timer.js`, add new function (near the end of the timer module)
```js
function openDistractionModal(){
  const elapsedMin = pomoState.startedAt
    ? Math.max(1, Math.round((Date.now()-pomoState.startedAt)/60000))
    : 5;
  document.getElementById("distraction-mins").value=elapsedMin;
  document.getElementById("distraction-note").value="";
  document.getElementById("distraction-modal-overlay").classList.add("open");
}
```

### JS — `public/js/prep.js`, add after pomo-stop-no handler
```js
document.getElementById("pomo-distracted").addEventListener("click",()=>{
  if(pomoState.running){
    clearInterval(pomoState.iv); pomoState.running=false; pomoState.startedAt=null;
    pomoUpdateStartBtn(); updateTimerBadge(); savePomoState();
  }
  openDistractionModal();
});

function closeDistractionModal(){ document.getElementById("distraction-modal-overlay").classList.remove("open"); }
function logDistraction(){
  const note=document.getElementById("distraction-note").value.trim()||"Distraction";
  const mins=parseInt(document.getElementById("distraction-mins").value)||5;
  pomoState.sessionLog.unshift({
    title:"[Distracted] "+note,
    durSec:mins*60, type:"distraction",
    time:new Date().toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"})
  });
  pomoRenderReport(); savePomoState();
}

document.getElementById("distraction-modal-close").addEventListener("click",closeDistractionModal);
document.getElementById("distraction-cancel").addEventListener("click",closeDistractionModal);
document.getElementById("distraction-log-resume").addEventListener("click",()=>{
  logDistraction(); closeDistractionModal();
  pomoState.iv=setInterval(pomoTick,1000); pomoState.running=true; pomoState.startedAt=Date.now();
  pomoUpdateStartBtn(); updateTimerBadge(); savePomoState();
});
document.getElementById("distraction-log-stop").addEventListener("click",()=>{
  logDistraction(); closeDistractionModal();
});
```

### CSS — `public/css/dashboard.css`
```css
.pomo-distracted-btn{display:block;width:100%;margin:4px 0 6px;padding:5px 0;border-radius:6px;border:1px solid rgba(239,68,68,0.25);background:rgba(239,68,68,0.08);color:var(--red);font-size:10px;font-weight:600;cursor:pointer;transition:all 0.12s;text-align:center}
.pomo-distracted-btn:hover{background:rgba(239,68,68,0.18);border-color:rgba(239,68,68,0.5)}
```

---

## Files to Modify

| File | Change |
|------|--------|
| `index.html` | ⚡ btn in task card; Stop btn + id on secondary div + stop-confirm block; distracted btn; distraction modal |
| `public/js/prep.js` | ✓ handler (hook + toggleDone + openTaskPicker); ⚡ handler; stop/yes/no handlers; distracted + distraction modal handlers; `_pomoCompleteHook` var; hook at top of `openPomodoro` |
| `public/js/sidebar.js` | `closeTaskPicker` clears `_pomoCompleteHook` |
| `public/js/timer.js` | `openDistractionModal()` function |
| `public/css/dashboard.css` | `.ptc-lightning`, `.pomo-sec-btn.accent`, `.pomo-stop-q`, `.pomo-distracted-btn` |

---

## QA Checklist

- [ ] Click ✓ while timer running → task marked done, task picker opens, timer keeps ticking
- [ ] Pick new task from picker → elapsed time (startedAt to now) logged to previous task in session log
- [ ] Click ✓ then dismiss picker → task stays done, nothing logged, timer keeps running
- [ ] Click ✓ while timer stopped → task marked done, picker opens, no time logged on switch
- [ ] Click ⚡ → task marked done, toast, timer keeps running, no modal opens
- [ ] Click ⚡ while running → same as above, timer uninterrupted
- [ ] Click Stop → timer resets, inline "Done with [task]?" appears, secondary buttons hide
- [ ] Click "Yes, complete it" → task done, confirmation hides, secondary buttons return
- [ ] Click "No, keep it" → confirmation hides, secondary buttons return, task unchanged
- [ ] Click "I got distracted" while running → timer pauses, distraction modal opens, elapsed minutes pre-filled
- [ ] Log & Resume → distraction in session log, timer resumes
- [ ] Log & Stop → distraction in session log, timer stays paused
- [ ] Cancel distraction modal → nothing logged
