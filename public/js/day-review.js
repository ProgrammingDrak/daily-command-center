// ======== DAY REVIEW ========
// Game-styled, time-stamped review of a single day: the SCHEDULED plan rendered
// as translucent "ghost" blocks on a time grid, with the ACTUAL time spent
// overlaid as solid, glowing fills. Becomes the past-day (archive) view.
//
// Why this exists: the legacy Actual view renders from the in-memory `scheduled`
// array, which is empty for past days (it is hydrated from a dcc_state snapshot
// that only exists for a handful of days). This view instead sources the plan
// DIRECTLY from blockStore (the durable source of truth), so every past day
// populates. Actual time comes from `time_entry` blocks (timer / pomodoro /
// manual), with graceful fallback to legacy `_sessions` / pomodoro taskTime.
(function () {
  "use strict";

  const HOUR_HEIGHT = 58;   // px per hour on the grid
  const EDGE_PAD_MIN = 30;  // breathing room above first / below last block

  // ── small utils (reuse globals from state.js / data.js where available) ──
  function esc(s) { return escHtml(s); } // shared escaper in tag-manager.js
  function toMin(v) { return (typeof pt === "function") ? pt(v) : 0; }            // "HH:MM" / ISO / "9:00 AM" -> minutes
  function fmtClock(min) { return (typeof f12 === "function") ? f12((typeof fmt === "function") ? fmt(((min % 1440) + 1440) % 1440) : min) : (min + "m"); }
  function fmtDur(min) { return (typeof ms === "function") ? ms(Math.max(0, Math.round(min))) : Math.round(min) + "m"; }
  function evColor(ev) {
    const tagC = (typeof taskTagColor === "function") ? taskTagColor(ev) : null;
    if (tagC) return tagC;
    return (typeof cfg === "function") ? cfg(ev.type).color : "#a78bfa";
  }
  function normTitle(t) { return String(t || "").trim().toLowerCase(); }
  function todayStr() { return (typeof __todayDate === "string" && __todayDate) || new Date().toISOString().slice(0, 10); }

  // ── gather the planned items for a date ──
  // Today: prefer the live `scheduled` array (carries manual edits). Other days:
  // read straight from the blockStore day cache (loaded by switchToDate).
  function gatherPlanned(dateStr) {
    const isToday = dateStr === todayStr();
    if (isToday && typeof scheduled !== "undefined" && Array.isArray(scheduled) && scheduled.length) {
      return scheduled
        .filter(ev => !(typeof isDeleted === "function" && isDeleted(ev)))
        // A task rescheduled (pushed) away no longer lives on this day, so it
        // doesn't belong in its planned-vs-actual retrospective. Every other
        // schedule view filters these; without it, rescheduling from the Actual
        // view looked like it did nothing (the card stayed put). (Ported from the
        // superseded buildActualView fix in PR #108.)
        .filter(ev => !(typeof isPushed === "function" && isPushed(ev)))
        .filter(ev => ev && ev.start)
        .map(ev => ({
          id: ev.id, _blockId: ev._blockId || ev.id, title: ev.title || "(untitled)",
          type: ev.type || "task", start: ev.start, end: ev.end || ev.start,
          source: ev.source || "manual", tags: Array.isArray(ev.tags) ? ev.tags : [],
          done: (typeof isDone === "function") ? isDone(ev) : false,
          meetingBlockId: ev.meetingBlockId || ev.block_id || null
        }))
        .sort((a, b) => toMin(a.start) - toMin(b.start));
    }
    const bs = window.blockStore;
    if (!bs) return [];
    const pool = []
      .concat(bs.getByType("block") || [])
      .concat(bs.getByType("schedule_item") || [])
      .concat(bs.getByType("added_task") || []);
    const seen = new Set();
    const out = [];
    for (const b of pool) {
      const p = b.properties || {};
      if (!p.start) continue;
      if (b.date && b.date !== dateStr) continue;   // only this day's blocks
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      out.push({
        id: b.id, _blockId: b.id, title: p.title || "(untitled)",
        type: p.type || "task", start: p.start, end: p.end || p.start,
        source: p.source || "manual", tags: Array.isArray(p.tags) ? p.tags : [],
        done: !!p.done,
        meetingBlockId: p.meetingBlockId || p.block_id || null,
        gcal_event_id: p.gcal_event_id || null
      });
    }
    out.sort((a, b) => toMin(a.start) - toMin(b.start));
    return out;
  }

  // ── match a time_entry to a planned event ──
  function entryMatchesEvent(entryProps, ev) {
    if (!entryProps) return false;
    if (entryProps.blockId) {
      if (entryProps.blockId === ev.id) return true;
      if (ev.meetingBlockId && entryProps.blockId === ev.meetingBlockId) return true;
    }
    if (entryProps.taskTitle && normTitle(entryProps.taskTitle) === normTitle(ev.title)) return true;
    return false;
  }

  // segments [{startMin|null, durMin, source}] for an event, from time_entry blocks
  // (preferred) with fallback to legacy _sessions / pomodoro taskTime.
  function actualSegmentsFor(ev, ctx) {
    const segs = [];
    for (const te of ctx.timeEntries) {
      const p = te.properties || {};
      if (!entryMatchesEvent(p, ev)) continue;
      const durMin = (p.durSec || 0) / 60;
      const startMin = p.start ? toMin(p.start) : null;
      segs.push({ startMin, durMin, source: p.source || "manual", _id: te.id });
    }
    if (segs.length) return segs;
    // Legacy fallbacks (read-only, no ids — not editable as time_entry)
    const sess = ctx.sessions[ev.id];
    if (Array.isArray(sess) && sess.length) {
      return sess.map(s => ({ startMin: s.start ? toMin(s.start) : null, durMin: s.durationMin || 0, source: "legacy", _id: null }));
    }
    const pomoSec = ctx.pomoTaskTime[ev.title];
    if (pomoSec) return [{ startMin: null, durMin: pomoSec / 60, source: "legacy", _id: null }];
    return [];
  }

  // greedy column assignment so overlapping plan blocks sit side-by-side
  function assignColumns(events) {
    const sorted = events.map((ev, i) => ({ ev, i, s: toMin(ev.start), e: Math.max(toMin(ev.end), toMin(ev.start) + 5) }))
      .sort((a, b) => a.s - b.s || a.e - b.e);
    const active = []; // {col, end}
    let maxCol = 0;
    for (const node of sorted) {
      for (let k = active.length - 1; k >= 0; k--) if (active[k].end <= node.s) active.splice(k, 1);
      const used = new Set(active.map(a => a.col));
      let col = 0; while (used.has(col)) col++;
      node.col = col; active.push({ col, end: node.e });
      maxCol = Math.max(maxCol, col);
    }
    const cols = maxCol + 1;
    const byId = {};
    sorted.forEach(n => { byId[n.ev.id] = { col: n.col, cols }; });
    return byId;
  }

  // ── build the per-day model ──
  function buildModel(dateStr) {
    const planned = gatherPlanned(dateStr);
    const ctx = {
      timeEntries: (window.blockStore && window.blockStore.getTimeEntries) ? window.blockStore.getTimeEntries(dateStr) : [],
      sessions: (typeof loadSessions === "function") ? (loadSessions() || {}) : {},
      pomoTaskTime: (typeof pomoState !== "undefined" && pomoState && pomoState.taskTime) ? pomoState.taskTime : {},
      done: (typeof loadDoneState === "function") ? loadDoneState() : { ids: [], at: {} }
    };
    const doneIds = new Set((ctx.done.ids || []));
    const rows = planned.map(ev => {
      const segs = actualSegmentsFor(ev, ctx);
      const actualMin = segs.reduce((s, x) => s + (x.durMin || 0), 0);
      const plannedMin = Math.max(0, toMin(ev.end) - toMin(ev.start));
      const done = ev.done || doneIds.has(ev.id);
      const doneAtTs = (ctx.done.at || {})[ev.id] || null;
      return { ev, segs, actualMin, plannedMin, done, doneAtTs,
        startMin: toMin(ev.start), endMin: Math.max(toMin(ev.end), toMin(ev.start) + 5),
        editable: ev.source !== "gcal" || true /* allow logging time on anything */ };
    });
    // unscheduled actual time (time_entry / pomo with no matching plan block)
    const matchedTitles = new Set(planned.map(p => normTitle(p.title)));
    const extras = [];
    const seenExtra = new Set();
    // Every title that has a real time_entry. A time_entry is authoritative over
    // the legacy pomoTaskTime accumulator, so the pomo fallback below must skip
    // any title already covered here — otherwise a pomo session that wrote a
    // time_entry (keyed by blockId) AND incremented pomoTaskTime (keyed by title)
    // gets counted twice in the HUD's unscheduled-time total.
    const titlesWithEntries = new Set();
    for (const te of ctx.timeEntries) {
      const p = te.properties || {};
      if (p.taskTitle) titlesWithEntries.add(normTitle(p.taskTitle));
      const matched = planned.some(ev => entryMatchesEvent(p, ev));
      if (matched) continue;
      const key = (p.blockId || normTitle(p.taskTitle) || te.id);
      if (!seenExtra.has(key)) { seenExtra.add(key); extras.push({ title: p.taskTitle || "(untracked)", min: 0, blockId: p.blockId || null }); }
      const ex = extras.find(x => (x.blockId && x.blockId === p.blockId) || normTitle(x.title) === normTitle(p.taskTitle));
      if (ex) ex.min += (p.durSec || 0) / 60;
    }
    Object.entries(ctx.pomoTaskTime || {}).forEach(([title, sec]) => {
      if (matchedTitles.has(normTitle(title))) return;
      if (titlesWithEntries.has(normTitle(title))) return;
      if (seenExtra.has(normTitle(title))) return;
      extras.push({ title, min: sec / 60, blockId: null });
    });
    return { dateStr, rows, extras, ctx };
  }

  // ── render ──
  function buildDayReview(dateStr) {
    const wrap = document.getElementById("actual-view");
    if (!wrap) return;
    dateStr = dateStr || (typeof viewDate !== "undefined" && viewDate) || todayStr();
    const model = buildModel(dateStr);
    wrap.innerHTML = "";

    const root = document.createElement("div");
    root.className = "dr-root";
    root.appendChild(renderHUD(model));

    if (!model.rows.length) {
      const empty = document.createElement("div");
      empty.className = "dr-empty";
      empty.innerHTML = "No scheduled items recorded for this day.";
      root.appendChild(empty);
      wrap.appendChild(root);
      return;
    }

    // grid bounds
    let lo = Math.min.apply(null, model.rows.map(r => r.startMin));
    let hi = Math.max.apply(null, model.rows.map(r => r.endMin));
    model.rows.forEach(r => r.segs.forEach(s => {
      if (s.startMin != null) { lo = Math.min(lo, s.startMin); hi = Math.max(hi, s.startMin + s.durMin); }
    }));
    const gridStart = Math.max(0, Math.floor((lo - EDGE_PAD_MIN) / 60) * 60);
    const gridEnd = Math.min(1440, Math.ceil((hi + EDGE_PAD_MIN) / 60) * 60);
    const minsToY = m => ((m - gridStart) / 60) * HOUR_HEIGHT;
    const gridHeight = minsToY(gridEnd);

    const grid = document.createElement("div");
    grid.className = "dr-grid";
    grid.style.height = gridHeight + "px";

    // hour lines + labels
    for (let h = gridStart; h <= gridEnd; h += 60) {
      const y = minsToY(h);
      const line = document.createElement("div");
      line.className = "dr-hourline";
      line.style.top = y + "px";
      line.innerHTML = '<span class="dr-hourlabel">' + fmtClock(h) + '</span>';
      grid.appendChild(line);
    }

    const cols = assignColumns(model.rows.map(r => r.ev));
    const LANE_LEFT = 64; // px gutter for hour labels

    model.rows.forEach(r => {
      const ev = r.ev;
      const color = evColor(ev);
      const ci = cols[ev.id] || { col: 0, cols: 1 };
      const widthPct = 100 / ci.cols;
      const leftCalc = "calc(" + LANE_LEFT + "px + (100% - " + LANE_LEFT + "px) * " + (ci.col / ci.cols) + ")";
      const blockWidth = "calc((100% - " + LANE_LEFT + "px) * " + (widthPct / 100) + " - 8px)";
      const top = minsToY(r.startMin);
      const height = Math.max(20, minsToY(r.endMin) - top);

      // ghost (planned) block
      const ghost = document.createElement("div");
      ghost.className = "dr-block" + (r.done ? " done" : "") + (r.actualMin > 0 ? " has-actual" : "");
      ghost.style.cssText = "top:" + top + "px;height:" + height + "px;left:" + leftCalc + ";width:" + blockWidth + ";--dr-color:" + color + ";";

      const statusBadge = r.done
        ? '<span class="dr-badge done">DONE</span>'
        : (r.actualMin > 0 ? '' : '<span class="dr-badge missed">no actual</span>');
      let diff = "";
      if (r.actualMin > 0 && r.plannedMin > 0) {
        const d = Math.round(r.actualMin - r.plannedMin);
        if (d > 2) diff = '<span class="dr-diff over">+' + fmtDur(d) + '</span>';
        else if (d < -2) diff = '<span class="dr-diff under">-' + fmtDur(Math.abs(d)) + '</span>';
        else diff = '<span class="dr-diff match">on target</span>';
      }
      ghost.innerHTML =
        '<div class="dr-block-head">' +
          '<span class="dr-block-title">' + esc(ev.title) + '</span>' +
          statusBadge +
        '</div>' +
        '<div class="dr-block-meta">' +
          '<span>' + fmtClock(r.startMin) + (r.plannedMin ? ' · ' + fmtDur(r.plannedMin) : '') + '</span>' +
          (r.actualMin > 0 ? '<span class="dr-actual-amt">actual ' + fmtDur(r.actualMin) + '</span>' : '') +
          diff +
        '</div>' +
        '<button class="dr-addtime" data-block-id="' + esc(ev.id) + '" data-title="' + esc(ev.title) + '" title="Add / edit actual time">+ time</button>';

      // solid actual fills (positioned by their own time; fall back to planned start)
      let stackBase = r.startMin;
      r.segs.forEach(seg => {
        const segStart = (seg.startMin != null) ? seg.startMin : stackBase;
        const segH = Math.max(4, (seg.durMin / 60) * HOUR_HEIGHT);
        stackBase = segStart + seg.durMin;
        const fill = document.createElement("div");
        fill.className = "dr-fill" + (seg.source === "pomo" ? " pomo" : "") + (seg.source === "legacy" ? " legacy" : "");
        fill.style.cssText = "top:" + minsToY(segStart) + "px;height:" + segH + "px;left:" + leftCalc + ";width:" + blockWidth + ";--dr-color:" + color + ";";
        fill.title = (seg.startMin != null ? fmtClock(segStart) + " · " : "") + fmtDur(seg.durMin) + (seg.source ? " (" + seg.source + ")" : "");
        grid.appendChild(fill);
      });

      grid.appendChild(ghost);
    });

    root.appendChild(grid);

    // unscheduled work
    if (model.extras.length) {
      const ex = document.createElement("div");
      ex.className = "dr-extras";
      ex.innerHTML = '<div class="dr-extras-head">Unscheduled work</div>' +
        model.extras.map(x => '<div class="dr-extra-row"><span>' + esc(x.title) + '</span><b>' + fmtDur(x.min) + '</b></div>').join("");
      root.appendChild(ex);
    }

    wrap.appendChild(root);

    // wire add/edit-time buttons (interactive even in archive read-only mode)
    root.querySelectorAll(".dr-addtime").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        editTimeEntries(btn.dataset.blockId, btn.dataset.title, dateStr, btn);
      });
    });
  }

  // ── HUD ──
  function renderHUD(model) {
    const hud = document.createElement("div");
    hud.className = "dr-hud";
    const planned = model.rows.length;
    const doneCount = model.rows.filter(r => r.done).length;
    const pct = planned ? Math.round((doneCount / planned) * 100) : 0;
    const plannedMin = model.rows.reduce((s, r) => s + r.plannedMin, 0);
    const actualMin = model.rows.reduce((s, r) => s + r.actualMin, 0) + model.extras.reduce((s, x) => s + x.min, 0);
    const dispDate = (function () {
      const p = String(model.dateStr).split("-");
      try { return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }); }
      catch (e) { return model.dateStr; }
    })();
    hud.innerHTML =
      '<div class="dr-hud-date">' + dispDate + '</div>' +
      '<div class="dr-hud-stats">' +
        statCard(pct + '%', 'completed', 'accent') +
        statCard(doneCount + '/' + planned, 'tasks done', '') +
        statCard(fmtDur(actualMin), 'time tracked', 'green') +
        statCard(fmtDur(plannedMin), 'planned', 'muted') +
      '</div>' +
      '<div class="dr-hud-meter"><span style="width:' + pct + '%"></span></div>';
    return hud;
  }
  function statCard(big, label, tone) {
    return '<div class="dr-stat ' + (tone || '') + '"><div class="dr-stat-big">' + big + '</div><div class="dr-stat-label">' + label + '</div></div>';
  }

  // ── manual / retroactive time entry editor ──
  // Opens a small inline panel listing actual-time segments for a task on a date.
  // Add / edit / delete segments; saves them as source:"manual" time_entry blocks.
  function editTimeEntries(blockId, taskTitle, dateStr, anchorEl) {
    closeEditor();
    const bs = window.blockStore;
    if (!bs || !bs.getTimeEntries) { if (typeof showToast === "function") showToast("Time tracking unavailable", "error"); return; }
    const existing = bs.getTimeEntries(dateStr)
      .filter(te => {
        const p = te.properties || {};
        return p.source === "manual" && (p.blockId === blockId || (taskTitle && normTitle(p.taskTitle) === normTitle(taskTitle)));
      })
      .sort((a, b) => toMin((a.properties || {}).start) - toMin((b.properties || {}).start));

    const panel = document.createElement("div");
    panel.className = "dr-editor";
    panel.id = "dr-editor";

    function rowHtml(startHHMM, endHHMM, id) {
      return '<div class="dr-ed-row" data-id="' + esc(id || "") + '">' +
        '<input type="time" class="dr-ed-start" value="' + esc(startHHMM || "") + '">' +
        '<span class="dr-ed-dash">to</span>' +
        '<input type="time" class="dr-ed-end" value="' + esc(endHHMM || "") + '">' +
        '<button class="dr-ed-del" title="Remove segment">&times;</button>' +
      '</div>';
    }
    function isoToHHMM(iso) {
      if (!iso) return "";
      const m = toMin(iso);
      return String(Math.floor(m / 60) % 24).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
    }

    const rowsHtml = existing.length
      ? existing.map(te => { const p = te.properties || {}; return rowHtml(isoToHHMM(p.start), isoToHHMM(p.end), te.id); }).join("")
      : rowHtml("", "", "");

    panel.innerHTML =
      '<div class="dr-ed-title">Actual time · ' + esc(taskTitle) + '</div>' +
      '<div class="dr-ed-rows">' + rowsHtml + '</div>' +
      '<button class="dr-ed-add">+ add segment</button>' +
      '<div class="dr-ed-actions">' +
        '<button class="dr-ed-cancel">Cancel</button>' +
        '<button class="dr-ed-save">Save</button>' +
      '</div>';

    document.body.appendChild(panel);
    positionEditor(panel, anchorEl);

    panel.querySelector(".dr-ed-add").addEventListener("click", () => {
      const rows = panel.querySelector(".dr-ed-rows");
      const tmp = document.createElement("div"); tmp.innerHTML = rowHtml("", "", "");
      rows.appendChild(tmp.firstChild);
      bindDelButtons(panel);
    });
    bindDelButtons(panel);
    panel.querySelector(".dr-ed-cancel").addEventListener("click", closeEditor);
    panel.querySelector(".dr-ed-save").addEventListener("click", async () => {
      await saveSegments(panel, blockId, taskTitle, dateStr, existing);
      closeEditor();
      buildDayReview(dateStr);
    });
    setTimeout(() => document.addEventListener("mousedown", outsideClose, true), 0);
  }

  function bindDelButtons(panel) {
    panel.querySelectorAll(".dr-ed-del").forEach(b => {
      b.onclick = () => { const row = b.closest(".dr-ed-row"); if (row) row.remove(); };
    });
  }
  function outsideClose(e) {
    const panel = document.getElementById("dr-editor");
    if (panel && !panel.contains(e.target) && !(e.target.closest && e.target.closest(".dr-addtime"))) closeEditor();
  }
  function closeEditor() {
    const p = document.getElementById("dr-editor");
    if (p) p.remove();
    document.removeEventListener("mousedown", outsideClose, true);
  }
  function positionEditor(panel, anchorEl) {
    if (!anchorEl) { panel.style.cssText += "left:50%;top:120px;transform:translateX(-50%);"; return; }
    const r = anchorEl.getBoundingClientRect();
    const top = Math.min(window.innerHeight - 240, r.bottom + 6);
    const left = Math.min(window.innerWidth - 280, Math.max(8, r.left));
    panel.style.left = left + "px";
    panel.style.top = (top + window.scrollY) + "px";
  }

  async function saveSegments(panel, blockId, taskTitle, dateStr, existing) {
    const bs = window.blockStore;
    const rows = [...panel.querySelectorAll(".dr-ed-row")];
    const kept = new Set();
    const ops = [];
    for (const row of rows) {
      const s = row.querySelector(".dr-ed-start").value;
      const en = row.querySelector(".dr-ed-end").value;
      const id = row.dataset.id;
      if (!s || !en) continue;
      let sMin = toMin(s), eMin = toMin(en);
      if (eMin <= sMin) eMin += 1440; // past-midnight
      const durSec = (eMin - sMin) * 60;
      const startIso = dateStr + "T" + s + ":00";
      const endIso = dateStr + "T" + en + ":00";
      if (id) {
        kept.add(id);
        const block = bs.get(id);
        const props = { ...(block ? block.properties : {}), blockId, taskTitle, start: startIso, end: endIso, durSec, source: "manual" };
        ops.push(bs.updateBlock(id, props));
      } else {
        ops.push(bs.logTimeEntry({ blockId, taskTitle, start: startIso, end: endIso, durSec, source: "manual", date: dateStr }));
      }
    }
    // delete removed
    for (const te of existing) { if (!kept.has(te.id)) ops.push(bs.deleteBlock(te.id)); }
    await Promise.all(ops);
    if (typeof showToast === "function") showToast("Actual time saved", "ok");
  }

  // expose
  window.buildDayReview = buildDayReview;
  window.editTimeEntries = editTimeEntries;
})();
