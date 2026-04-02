// ======== ASYNC BOOT: FETCH FROM API + COLD-START RESTORATION ========
(async function boot() {
  const loadEl = document.createElement('div');
  loadEl.id = 'api-loading';
  loadEl.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:var(--accent);color:white;text-align:center;padding:6px;font-size:12px;font-weight:600;letter-spacing:0.5px';
  loadEl.textContent = 'Loading data from API...';
  document.body.prepend(loadEl);

  try {
    // Fetch all data endpoints in parallel
    const [dayState, upcoming, archives, tomorrow, local, brainRecent, brainGlobals, engrams, tags, prepFiles, paLog] = await Promise.all([
      fetch('/api/state/day').then(r => r.json()).catch(() => null),
      fetch('/api/state/upcoming').then(r => r.json()).catch(() => []),
      fetch('/api/state/archives').then(r => r.json()).catch(() => ({})),
      fetch('/api/state/tomorrow').then(r => r.json()).catch(() => null),
      fetch('/api/state/local').then(r => r.json()).catch(() => null),
      fetch('/api/brain/recent').then(r => r.json()).catch(() => ({})),
      fetch('/api/brain/globals').then(r => r.json()).catch(() => ({})),
      fetch('/api/brain/engrams').then(r => r.json()).catch(() => ({ index: {}, taxonomy: {}, cooccurrence: {} })),
      fetch('/api/brain/tags').then(r => r.json()).catch(() => ({})),
      fetch('/api/prep').then(r => r.json()).catch(() => ({})),
      fetch('/api/pa-log').then(r => r.json()).catch(() => ({ html: '<div style="color:var(--text-muted);padding:24px">Could not load PA log.</div>' })),
    ]);

    // Populate window globals (same shape the rest of the app expects)
    window.__PA_STATE__ = dayState;
    window.__PA_UPCOMING__ = upcoming;
    window.__PA_ARCHIVES__ = archives;
    window.__PA_TOMORROW__ = tomorrow;
    window.__PA_LOCAL__ = local;
    window.__SECOND_BRAIN__ = brainRecent;
    window.__SECOND_BRAIN_GLOBALS__ = brainGlobals;
    window.__ENGRAM_INDEX__ = engrams.index || {};
    window.__ENGRAM_TAXONOMY__ = engrams.taxonomy || {};
    window.__ENGRAM_COOCCURRENCE__ = engrams.cooccurrence || {};
    window.__PA_TAGS__ = tags;
    window.__PREP_FILES__ = prepFiles;

    // Inject PA log HTML
    const paLogEl = document.getElementById('pa-log-content');
    if (paLogEl && paLog.html) paLogEl.innerHTML = paLog.html;

    // Re-initialize state from fetched data
    __state = window.__PA_STATE__ || null;
    __data = transformState(__state);
    INIT_SCHED = __data.sched;
    INIT_CONSIDER = __data.consider;
    INIT_BACKLOG = __data.bklog;
    INIT_TRIAGE = __data.triageItems;
    INIT_NOTIFICATIONS = __data.notifications;
    viewDate = __state ? __state.date : null;

    // Reset live copies — state.js initializes these synchronously before API data arrives
    scheduled = JSON.parse(JSON.stringify(INIT_SCHED));
    consider = JSON.parse(JSON.stringify(INIT_CONSIDER));
    backlog = JSON.parse(JSON.stringify(INIT_BACKLOG));

    // Re-derive date constants and archive index
    __todayDate = (window.__PA_STATE__ && window.__PA_STATE__.date) || null;
    __tomorrowDate = (window.__PA_TOMORROW__ && window.__PA_TOMORROW__.date) || null;
    __archiveDates = window.__PA_ARCHIVES__ ? Object.keys(window.__PA_ARCHIVES__).sort() : [];
    if (typeof initKeys === 'function') initKeys();

    // Re-populate one-time objects that ran at load time with empty data
    const cats = (window.__ENGRAM_TAXONOMY__ && window.__ENGRAM_TAXONOMY__.categories) || [];
    cats.forEach(c => { ENGRAM_COLORS[c.id] = c.color; ENGRAM_ICONS[c.id] = c.icon; });
    if (window.__PREP_FILES__) {
      Object.entries(window.__PREP_FILES__).forEach(([k,v]) => { PREP_REGISTRY[k] = v; PREP_REGISTRY["meeting-prep/" + k] = v; });
    }

    console.log('[API Boot] All data loaded from API', {
      date: dayState?.date,
      upcoming: upcoming?.length,
      archives: Object.keys(archives).length,
      prepFiles: Object.keys(prepFiles).length,
    });

    loadEl.textContent = 'Data loaded!';
    loadEl.style.background = 'var(--green)';
    setTimeout(() => loadEl.remove(), 1200);
  } catch (e) {
    console.error('[API Boot] Failed to load data:', e);
    loadEl.textContent = 'API load failed -- using cached data';
    loadEl.style.background = 'var(--red)';
    setTimeout(() => loadEl.remove(), 3000);
  }

  // Load BlockStore data for today (primary data source)
  if (window.blockStore && viewDate) {
    try {
      await window.blockStore.loadDay(viewDate);
      await window.blockStore.loadGlobals();
      console.log('[BlockStore] Loaded blocks for', viewDate, window.blockStore.debug());
    } catch(e) { console.warn("[BlockStore] Load failed (non-fatal):", e); }
  }

  // Reload persisted UI state AFTER blockstore cache is populated —
  // blockstore-backed features (addedTasks, etc.) need loadDay() to complete first
  if (typeof reloadPersistedEdits === 'function') reloadPersistedEdits();

  // Legacy hydration fallback — only needed if any USE_BLOCKSTORE flags are off
  if (window.USE_BLOCKSTORE && !Object.values(window.USE_BLOCKSTORE).every(v => v)) {
    try {
      await hydrateFromStorage();
      await hydrateGlobals();
    } catch(e) { console.warn("[Second Brain] Hydration error (non-fatal):", e); }
  }

  // Midnight date boundary: check every 60s if the date rolled over
  setInterval(() => {
    const now = new Date();
    const todayStr = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
    if (__todayDate && todayStr !== __todayDate && viewMode === 'today') {
      console.log('[Boot] Date rolled over to', todayStr, '— refreshing...');
      location.reload();
    }
  }, 60000);

  // Trigger initial render with the loaded data
  if (typeof render === 'function') render();
  if (typeof buildTriage === 'function') buildTriage();
  if (typeof buildNotifications === 'function') buildNotifications();
  if (typeof buildUpcomingBoard === 'function') buildUpcomingBoard();
  if (typeof buildLifeSection === 'function') buildLifeSection();
  if (typeof buildReportCard === 'function') buildReportCard();
  if (typeof updateStats === 'function') updateStats();
  if (typeof updateDateNav === 'function') updateDateNav();
})();

updateClock();
setInterval(updateClock, 1000);

// ======== RESTORE POMODORO STATE ========
(function(){
  const saved = loadPomoState();
  if (!saved || !saved.title) return;
  // Restore core state
  pomoState.title = saved.title;
  pomoState.workMin = saved.workMin || 25;
  pomoState.mode = saved.mode || "work";
  pomoState.total = saved.total || 25*60;
  pomoState.remaining = saved.remaining || 0;
  pomoState.sessions = saved.sessions || 0;
  pomoState.soundOn = saved.soundOn !== false;
  pomoState.sessionLog = saved.sessionLog || [];
  pomoState.taskTime = saved.taskTime || {};
  pomoState.taskDone = saved.taskDone || false;
  pomoState.stackedSessions = saved.stackedSessions || {};
  // Show the timer UI (hide empty state, show active)
  const emptyEl = document.getElementById("pomo-empty");
  const activeEl = document.getElementById("pomo-active");
  if (emptyEl) emptyEl.style.display = "none";
  if (activeEl) activeEl.style.display = "block";
  document.getElementById("pomo-title").textContent = saved.title;
  const modeWork = document.querySelector('.pomo-mode[data-pm="work"]');
  if (modeWork) modeWork.textContent = "Focus (" + pomoState.workMin + "m)";
  document.querySelectorAll(".pomo-mode").forEach(function(b){ b.classList.toggle("active", b.dataset.pm === pomoState.mode); });
  const ph = document.getElementById("pomo-phase");
  if (ph) ph.textContent = pomoState.mode === "work" ? "Focus" : pomoState.mode === "short" ? "Short Break" : "Long Break";
  for (var i = 0; i < 4; i++) { var d = document.getElementById("pd" + i); if (d) d.className = i < pomoState.sessions ? "pomo-dot filled" : "pomo-dot"; }
  document.getElementById("pomo-sound").textContent = "Sound: " + (pomoState.soundOn ? "On" : "Off");
  // If timer was running, account for elapsed time during reload
  if (saved.running && saved.savedAt) {
    var elapsed = Math.floor((Date.now() - saved.savedAt) / 1000);
    pomoState.remaining = Math.max(0, pomoState.remaining - elapsed);
    pomoState.running = true;
    pomoState.startedAt = Date.now();
    pomoState.iv = setInterval(pomoTick, 1000);
  } else {
    pomoState.running = false;
  }
  pomoPaint();
  pomoUpdateStartBtn();
  updateTimerBadge();
  pomoRenderReport();
  buildMiniSchedule();buildSideConsider();buildSideBacklog();buildSideDone();
})();

