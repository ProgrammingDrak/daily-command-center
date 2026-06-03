// ======== CLOCK ========
let _cachedTzStr = null;
let _lastTzMinute = -1;
let _lastClockText = "";
function updateClock(){
  const d=new Date(),h=d.getHours(),m=d.getMinutes(),ap=h>=12?"PM":"AM",h12=h>12?h-12:h||12;
  const clockText=h12+":"+String(m).padStart(2,"0")+" "+ap;
  // Only update DOM if text changed (every minute, not every second)
  if(clockText!==_lastClockText){
    _lastClockText=clockText;
    document.getElementById("clock").textContent=clockText;
    if (viewMode === "today") {
      document.getElementById("date-label").textContent=d.toLocaleDateString("en-US",{weekday:"long",year:"numeric",month:"long",day:"numeric"});
    }
  }
  // Cache timezone string — recalculate once per minute, not every second
  if(m!==_lastTzMinute){
    _lastTzMinute=m;
    try{const tz=Intl.DateTimeFormat().resolvedOptions().timeZone;const abbr=d.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();_cachedTzStr=abbr+" ("+tz.split("/").pop().replace(/_/g," ")+")"}catch(e){_cachedTzStr="Local Time"}
    document.getElementById("tz-label").textContent=_cachedTzStr;
    // PIN 1: re-render once per minute so the pinned-active aging color
    // (blue \u2192 yellow \u2192 red) stays fresh without user interaction.
    // No-op when nothing is pinned.
    if(typeof getPinnedActiveId==="function"&&getPinnedActiveId()&&typeof render==="function"){
      render();
    }
  }
  const timeStr=h12+":"+String(m).padStart(2,"0")+ap.toLowerCase();
  // Only update the live time indicator on today's page — not on historical pages
  const _isToday=window.__state&&window.__state.date===new Date().toISOString().split("T")[0];
  const nowEl=document.querySelector(".tl-now-time");if(nowEl&&_isToday)nowEl.textContent=timeStr;
}

// ======== DATE NAVIGATION ========
// All dates that have viewable data
function getNavigableDates() {
  const dates = new Set(__archiveDates);
  if (__todayDate) dates.add(__todayDate);
  if (__tomorrowDate) dates.add(__tomorrowDate);
  return [...dates].sort();
}

function dateToDisplay(dateStr) {
  // Parse YYYY-MM-DD and format for display
  const parts = dateStr.split("-");
  const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  return d.toLocaleDateString("en-US", {weekday:"long", year:"numeric", month:"long", day:"numeric"});
}

function updateDateNav() {
  const label = document.getElementById("date-label");
  const badge = document.getElementById("dn-badge");
  const todayBtn = document.getElementById("dn-today-btn");
  const tomorrowBtn = document.getElementById("dn-tomorrow-btn");

  if (viewDate) {
    label.textContent = dateToDisplay(viewDate);
  }

  // Badge
  if (viewMode === "tomorrow") {
    badge.textContent = "TOMORROW";
    badge.className = "dn-badge tomorrow";
    badge.style.display = "";
  } else if (viewMode === "future") {
    badge.textContent = "PLANNED";
    badge.className = "dn-badge tomorrow";
    badge.style.display = "";
  } else if (viewMode === "archive") {
    badge.textContent = "ARCHIVE";
    badge.className = "dn-badge archive";
    badge.style.display = "";
  } else {
    badge.style.display = "none";
  }

  // Quick buttons
  todayBtn.style.display = (viewMode !== "today") ? "" : "none";
  tomorrowBtn.style.display = (__tomorrowDate && viewMode !== "tomorrow") ? "" : "none";
}

function navDate(direction) {
  const dates = getNavigableDates();
  if (!dates.length) return;
  const idx = dates.indexOf(viewDate);
  const newIdx = idx + direction;
  if (newIdx >= 0 && newIdx < dates.length) {
    switchToDate(dates[newIdx]);
  }
}

// ── Date Picker (calendar popup) ──
let dpMonth = null; // currently displayed month {year, month}

function toggleDatePicker() {
  const drop = document.getElementById("date-picker-drop");
  if (drop.style.display !== "none") {
    drop.style.display = "none";
    return;
  }
  // Initialize to viewDate's month
  const parts = (viewDate || __todayDate || new Date().toISOString().slice(0,10)).split("-");
  dpMonth = { year: parseInt(parts[0]), month: parseInt(parts[1]) - 1 };
  renderDatePicker();
  drop.style.display = "";
}

function renderDatePicker() {
  const drop = document.getElementById("date-picker-drop");
  const yr = dpMonth.year, mo = dpMonth.month;
  const monthName = new Date(yr, mo, 1).toLocaleDateString("en-US", {month:"long", year:"numeric"});

  const firstDay = new Date(yr, mo, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(yr, mo + 1, 0).getDate();
  const daysInPrev = new Date(yr, mo, 0).getDate();

  const navigable = new Set(getNavigableDates());

  let html = '<div class="dp-header">';
  html += '<button onclick="dpNav(-1)">&lsaquo;</button>';
  html += '<span>' + monthName + '</span>';
  html += '<button onclick="dpNav(1)">&rsaquo;</button>';
  html += '</div>';
  html += '<div class="dp-grid">';
  ["Su","Mo","Tu","We","Th","Fr","Sa"].forEach(d => html += '<div class="dp-dow">' + d + '</div>');

  // Previous month trailing days
  for (let i = firstDay - 1; i >= 0; i--) {
    const day = daysInPrev - i;
    const prevMo = mo === 0 ? 11 : mo - 1;
    const prevYr = mo === 0 ? yr - 1 : yr;
    const ds = prevYr + "-" + String(prevMo + 1).padStart(2,"0") + "-" + String(day).padStart(2,"0");
    const cls = ["dp-day","other-month"];
    if (navigable.has(ds)) cls.push("has-data");
    html += '<div class="' + cls.join(" ") + '" onclick="dpSelect(\'' + ds + '\')">' + day + '</div>';
  }

  // Current month days
  for (let day = 1; day <= daysInMonth; day++) {
    const ds = yr + "-" + String(mo + 1).padStart(2,"0") + "-" + String(day).padStart(2,"0");
    const cls = ["dp-day"];
    if (navigable.has(ds)) cls.push("has-data");
    if (ds === __todayDate) cls.push("today");
    if (ds === viewDate) cls.push("active");
    if (ds === __tomorrowDate && window.__DCC_TOMORROW__) cls.push("tomorrow-plan");
    html += '<div class="' + cls.join(" ") + '" onclick="dpSelect(\'' + ds + '\')">' + day + '</div>';
  }

  // Next month leading days (fill to 42 cells)
  const totalCells = firstDay + daysInMonth;
  const remaining = (totalCells % 7 === 0) ? 0 : 7 - (totalCells % 7);
  for (let day = 1; day <= remaining; day++) {
    const nextMo = mo === 11 ? 0 : mo + 1;
    const nextYr = mo === 11 ? yr + 1 : yr;
    const ds = nextYr + "-" + String(nextMo + 1).padStart(2,"0") + "-" + String(day).padStart(2,"0");
    const cls = ["dp-day","other-month"];
    if (navigable.has(ds)) cls.push("has-data");
    html += '<div class="' + cls.join(" ") + '" onclick="dpSelect(\'' + ds + '\')">' + day + '</div>';
  }

  html += '</div>';
  drop.innerHTML = html;
}

function dpNav(dir) {
  dpMonth.month += dir;
  if (dpMonth.month > 11) { dpMonth.month = 0; dpMonth.year++; }
  if (dpMonth.month < 0) { dpMonth.month = 11; dpMonth.year--; }
  renderDatePicker();
}

function dpSelect(dateStr) {
  document.getElementById("date-picker-drop").style.display = "none";
  switchToDate(dateStr);
}

// Close date picker on outside click
document.addEventListener("click", function(e) {
  const drop = document.getElementById("date-picker-drop");
  const btn = document.getElementById("dn-date-btn");
  if (drop && drop.style.display !== "none" && !drop.contains(e.target) && !btn.contains(e.target)) {
    drop.style.display = "none";
  }
});

// Initialize date nav on load
(function initDateNav() {
  updateDateNav();
})();
