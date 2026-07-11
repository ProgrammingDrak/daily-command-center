// ======== CARRYOVER REVIEW ========
// On the first load of a new day, scan the most recent prior archived day
// for unfinished, user-actionable tasks and prompt the user to roll each
// into today's backlog, reschedule it, or drop it.

(function(){
  // Fixed-time types (meeting/oneone/ooo/break) come from the TASK_TYPES registry
  // via TaskTypes.isFixed so this can't drift; the residual literals are raw
  // calendar block types that never became first-class registry types.
  const SKIP_RAW = new Set(["focus","focus_time","free_time","prep"]);
  function skipType(type){
    if(window.TaskTypes&&typeof window.TaskTypes.isFixed==="function"&&window.TaskTypes.isFixed(type))return true;
    return SKIP_RAW.has(type);
  }
  const REVIEWED_PREFIX = "pa-carryover-reviewed-";

  function prettyDate(iso){
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US",{weekday:"long",month:"short",day:"numeric"});
  }

  function priorDoneSet(priorDay){
    const out = new Set();
    try {
      const raw = localStorage.getItem("pa-done-" + priorDay);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && Array.isArray(obj.ids)) obj.ids.forEach(id => out.add(id));
      }
    } catch (e) {}
    return out;
  }

  function extractUncheckedTasks(priorState, priorDay){
    if (!priorState || !priorState.schedule || !Array.isArray(priorState.schedule.timeline)) return [];
    const done = priorDoneSet(priorDay);
    return priorState.schedule.timeline
      .filter(t => !skipType(t.type))
      .filter(t => !t.completed && !done.has(t.id))
      .map(t => {
        const start = t.start ? new Date(t.start) : null;
        const end = t.end ? new Date(t.end) : null;
        const durMin = (start && end && !isNaN(start) && !isNaN(end))
          ? Math.max(1, Math.round((end - start) / 60000))
          : (t.estimated_minutes || 30);
        return {
          id: t.id,
          title: t.label || "Untitled",
          durMin,
          priority: t.priority || "Medium",
          source: t.source || "manual",
          notionUrl: t.source === "notion" && t.source_id
            ? "https://www.notion.so/" + String(t.source_id).replace(/-/g,"")
            : ""
        };
      });
  }

  function markReviewed(){
    try { localStorage.setItem(REVIEWED_PREFIX + __todayDate, "1"); } catch (e) {}
  }

  // ── Actions ──
  function actBacklog(item, priorDay){
    if (typeof backlog === "undefined") return;
    const entry = {
      id: "carry-" + (typeof nextId !== "undefined" ? nextId++ : Date.now()),
      title: item.title,
      type: "task",
      durMin: item.durMin,
      meta: "Carried over from " + prettyDate(priorDay) + " · " + ms(item.durMin),
      detail: "",
      source: item.source,
      notionUrl: item.notionUrl
    };
    backlog.push(entry);
    if (typeof persistBacklogItem === "function") persistBacklogItem(entry);
    if (typeof log === "function") log("created","carry","Carried over: "+item.title);
    if (typeof render === "function") render();
  }

  function actSchedule(item){
    if (typeof insertTaskNow === "function") {
      insertTaskNow(item.title, item.durMin);
    }
  }

  function actDrop(item){
    if (typeof log === "function") log("dropped","carry","Dropped carryover: "+item.title);
  }

  // ── Modal ──
  function ensureModal(){
    let overlay = document.getElementById("carryover-overlay");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "carryover-overlay";
    overlay.id = "carryover-overlay";
    overlay.innerHTML = `
      <div class="carryover">
        <div class="carryover-hdr">
          <h3 id="carryover-title">Carryover review</h3>
          <button class="pvb-close" id="carryover-close">&times;</button>
        </div>
        <div class="carryover-body">
          <div class="carryover-hint" id="carryover-hint"></div>
          <div class="carryover-list" id="carryover-list"></div>
        </div>
        <div class="carryover-footer">
          <button class="carryover-skip" id="carryover-skip">Skip remaining</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });
    overlay.querySelector("#carryover-close").addEventListener("click", closeModal);
    overlay.querySelector("#carryover-skip").addEventListener("click", closeModal);
    return overlay;
  }

  function closeModal(){
    const overlay = document.getElementById("carryover-overlay");
    if (overlay) overlay.classList.remove("open");
    markReviewed();
  }

  function openModal(priorDay, items){
    const overlay = ensureModal();
    const titleEl = overlay.querySelector("#carryover-title");
    const hintEl = overlay.querySelector("#carryover-hint");
    const listEl = overlay.querySelector("#carryover-list");
    titleEl.textContent = "Carryover from " + prettyDate(priorDay);
    hintEl.textContent = items.length + " unfinished task" + (items.length === 1 ? "" : "s") + " — choose what to do with each.";
    listEl.innerHTML = "";

    items.forEach(item => {
      const row = document.createElement("div");
      row.className = "carryover-row";
      row.innerHTML = `
        <div class="carryover-row-info">
          <div class="carryover-row-title"></div>
          <div class="carryover-row-meta">${ms(item.durMin)}${item.priority ? " · " + item.priority : ""}</div>
        </div>
        <div class="carryover-row-actions">
          <button class="carryover-btn carryover-btn-backlog">To Backlog and Ideas</button>
          <button class="carryover-btn carryover-btn-schedule">For Today</button>
          <button class="carryover-btn carryover-btn-drop">Drop</button>
        </div>`;
      row.querySelector(".carryover-row-title").textContent = item.title;
      const removeRow = () => {
        row.remove();
        if (!listEl.children.length) closeModal();
      };
      row.querySelector(".carryover-btn-backlog").addEventListener("click", () => { actBacklog(item, priorDay); removeRow(); });
      row.querySelector(".carryover-btn-schedule").addEventListener("click", () => { actSchedule(item); removeRow(); });
      row.querySelector(".carryover-btn-drop").addEventListener("click", () => { actDrop(item); removeRow(); });
      listEl.appendChild(row);
    });

    overlay.classList.add("open");
  }

  // ── Entry point ──
  async function initCarryoverReview(){
    if (typeof __todayDate === "undefined" || !__todayDate) return;
    if (typeof __archiveDates === "undefined" || !__archiveDates || !__archiveDates.length) return;
    if (typeof viewMode !== "undefined" && viewMode && viewMode !== "today") return;
    try { if (localStorage.getItem(REVIEWED_PREFIX + __todayDate)) return; } catch (e) {}

    // Most recent archived date strictly before today
    const sorted = [...__archiveDates].sort();
    let priorDay = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i] < __todayDate) { priorDay = sorted[i]; break; }
    }
    if (!priorDay) { markReviewed(); return; }

    let priorState;
    try {
      const res = await fetch("/api/state/day?date=" + encodeURIComponent(priorDay));
      priorState = await res.json();
    } catch (e) { return; }

    const unchecked = extractUncheckedTasks(priorState, priorDay);
    if (!unchecked.length) { markReviewed(); return; }
    openModal(priorDay, unchecked);
  }

  window.initCarryoverReview = initCarryoverReview;
})();
