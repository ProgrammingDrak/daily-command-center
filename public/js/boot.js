// ======== ASYNC BOOT: FETCH FROM API + COLD-START RESTORATION ========
(async function boot() {
  const loadEl = document.createElement('div');
  loadEl.id = 'api-loading';
  loadEl.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:var(--accent);color:white;text-align:center;padding:6px;font-size:12px;font-weight:600;letter-spacing:0.5px';
  loadEl.textContent = 'Loading data from API...';
  document.body.prepend(loadEl);

  try {
    // Fetch all data endpoints in parallel
    const [syncBootstrap, legacyDayState, upcoming, archives, tomorrow, local, brainRecent, brainGlobals, prepFiles] = await Promise.all([
      window.DCC_DELTA_SYNC_ENABLED
        ? fetch('/api/sync/bootstrap').then(r => r.ok ? r.json() : null).catch(() => null)
        : Promise.resolve(null),
      window.DCC_DELTA_SYNC_ENABLED
        ? Promise.resolve(null)
        : fetch('/api/state/day').then(r => r.json()).catch(() => null),
      fetch('/api/state/upcoming').then(r => r.json()).catch(() => []),
      fetch('/api/state/archives').then(r => r.json()).catch(() => ({})),
      fetch('/api/state/tomorrow').then(r => r.json()).catch(() => null),
      fetch('/api/state/local').then(r => r.json()).catch(() => null),
      fetch('/api/brain/recent').then(r => r.json()).catch(() => ({})),
      fetch('/api/brain/globals').then(r => r.json()).catch(() => ({})),
      fetch('/api/prep').then(r => r.json()).catch(() => ({})),
    ]);
    const dayState = (syncBootstrap && syncBootstrap.dayState) || legacyDayState;
    window.__DCC_SYNC_BOOTSTRAP__ = syncBootstrap;

    // Populate window globals (same shape the rest of the app expects)
    window.__DCC_STATE__ = dayState;
    window.__DCC_UPCOMING__ = upcoming;
    window.__DCC_ARCHIVES__ = archives;
    window.__DCC_TOMORROW__ = tomorrow;
    window.__DCC_LOCAL__ = local;
    window.__SECOND_BRAIN__ = brainRecent;
    window.__SECOND_BRAIN_GLOBALS__ = brainGlobals;
    window.__PREP_FILES__ = prepFiles;

    // Re-initialize state from fetched data
    __state = window.__DCC_STATE__ || null;
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
    __todayDate = (window.__DCC_STATE__ && window.__DCC_STATE__.date) || null;
    __tomorrowDate = (window.__DCC_TOMORROW__ && window.__DCC_TOMORROW__.date) || null;
    __archiveDates = window.__DCC_ARCHIVES__ ? Object.keys(window.__DCC_ARCHIVES__).sort() : [];
    if (typeof initKeys === 'function') initKeys();

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
      if (window.DCC_DELTA_SYNC_ENABLED && window.__DCC_SYNC_BOOTSTRAP__) {
        window.blockStore.hydrateSyncSnapshot(window.__DCC_SYNC_BOOTSTRAP__);
      } else {
        await window.blockStore.loadDay(viewDate);
        await window.blockStore.loadGlobals();
      }
      // Build the global tag index so tag-aware scheduling can resolve ancestors
      if (typeof buildTagIndex === 'function') {
        window.__TAGS__ = buildTagIndex([...window.blockStore.getByType('tag'),...window.blockStore.getByType('block').filter(b=>(b.properties||{}).name&&(b.properties||{}).color!==undefined)]);
      }
      console.log('[BlockStore] Loaded blocks for', viewDate, window.blockStore.debug());
    } catch(e) { console.warn("[BlockStore] Load failed (non-fatal):", e); }
  }

  // Reload persisted UI state AFTER blockstore cache is populated —
  // blockstore-backed features (addedTasks, etc.) need loadDay() to complete first
  if (typeof reloadPersistedEdits === 'function') reloadPersistedEdits();

  // (Phase 6 cleanup) Removed legacy hydrateFromStorage/hydrateGlobals gate.
  // BlockStore.loadDay() above is the single source of state hydration now.

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
  if (typeof loadResponsibilities === 'function') loadResponsibilities();
  if (typeof loadTaskMenus === 'function') loadTaskMenus();
  if (typeof loadTaskGroups === 'function') loadTaskGroups();
  if (typeof buildDelegated === 'function') buildDelegated();
  if (typeof updateStats === 'function') updateStats();
  if (typeof updateDateNav === 'function') updateDateNav();
  if (typeof initCatchUp === 'function') initCatchUp();
  window.dispatchEvent(new CustomEvent('dcc:data-ready', { detail: { date: viewDate } }));
  // Refresh stats every 60s to keep "Block Ends" current
  setInterval(() => { if(typeof updateStats === 'function') updateStats(); }, 60000);
})();

updateClock();
setInterval(updateClock, 1000);
