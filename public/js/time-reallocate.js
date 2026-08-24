// Tracked time is TRANSFERRABLE and SPLITTABLE.
//
// One dialog for both, because the server treats them as one mechanic (see
// POST /api/time-entries/:id/reallocate): a segment's seconds are re-divided
// among destination tasks, and the total is conserved. Moving is a one-piece
// reallocation. Splitting is a two-piece one. "The first 20m was actually
// onboarding" is a two-piece one whose remainder stays put.
//
// The LAST piece always takes the remainder, on the server and here, so the
// arithmetic cannot drift between the two: every piece but the last gets a
// minutes input, and the last one just reports what is left. No arrangement of
// inputs can invent or lose tracked time, which is the whole point — this dialog
// re-attributes work, it never edits how long it took. Trimming a segment's
// length is still Day Review's "+ time" editor.
//
// Entry points call open({ entry, onSaved }). Both of today's callers
// (work-sessions.js work history, day-review.js actual fills) hand over the
// time_entry row they already have.
(function () {
  "use strict";

  var MAX_PIECES = 12;
  var overlay = null;
  var state = null;

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
    });
  }

  function api(path, opts) {
    if (window.DCC && typeof window.DCC.api === "function") return window.DCC.api(path, opts);
    var options = opts || {};
    if (options.body && typeof options.body !== "string") {
      options.body = JSON.stringify(options.body);
      options.headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
    }
    return fetch(path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || "Request failed");
        return data;
      });
    });
  }

  function toast(message, kind) {
    if (typeof showToast === "function") showToast(message, kind || "ok");
    else if (window.DCC && typeof window.DCC.toast === "function") window.DCC.toast(message, kind || "ok");
  }

  function minutesOf(entry) {
    var sec = Number((entry.properties || {}).durSec) || 0;
    return Math.max(1, Math.round(sec / 60));
  }

  function fmtMinutes(min) {
    if (min < 60) return min + "m";
    var h = Math.floor(min / 60);
    var m = min % 60;
    return m ? h + "h " + m + "m" : h + "h";
  }

  function clockOf(entry) {
    var props = entry.properties || {};
    var raw = props.startedAt || props.start || "";
    var stamp = props.endedAt || props.end || "";
    function label(value) {
      if (!value) return "";
      if (typeof pt === "function" && typeof f12 === "function" && typeof fmt === "function") {
        return f12(fmt(((pt(value) % 1440) + 1440) % 1440));
      }
      var match = String(value).match(/(\d{2}):(\d{2})/);
      return match ? match[1] + ":" + match[2] : "";
    }
    var from = label(raw);
    var to = label(stamp);
    return from && to ? from + " to " + to : from || "";
  }

  function dayLabel(dateStr) {
    if (!dateStr) return "";
    var parts = String(dateStr).split("-");
    try {
      return new Date(+parts[0], +parts[1] - 1, +parts[2])
        .toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    } catch (e) { return dateStr; }
  }

  // ── the destination task list ───────────────────────────────────────────────
  // In-memory pools first: those are the titles Drake is actually looking at, and
  // they include tasks already checked off (moving time onto finished work is the
  // common case). GET /api/tasks/open then widens it to open work from earlier
  // days, which is what a segment on a past date usually wants.
  function poolTasks() {
    var out = [];
    [
      typeof scheduled !== "undefined" && Array.isArray(scheduled) ? scheduled : null,
      typeof backlog !== "undefined" && Array.isArray(backlog) ? backlog : null,
    ].forEach(function (pool) {
      if (!pool) return;
      pool.forEach(function (task) {
        if (!task || !task.id || task._deleted) return;
        out.push({
          id: String(task._blockId || task.id),
          title: task.title || "Task",
          when: task.start || (task.kind === "backlog" ? "Backlog" : ""),
          done: typeof isDone === "function" ? !!isDone(task) : task.status === "done",
        });
      });
    });
    return out;
  }

  async function loadChoices() {
    var seen = new Map();
    function add(task) {
      if (!task || !task.id) return;
      var key = String(task.id);
      if (!seen.has(key)) seen.set(key, task);
    }
    poolTasks().forEach(add);
    try {
      var today = (window.blockStore && window.blockStore.getCurrentDate && window.blockStore.getCurrentDate())
        || new Date().toISOString().slice(0, 10);
      var before = new Date(today + "T12:00:00Z");
      before.setUTCDate(before.getUTCDate() + 1);
      var payload = await api("/api/tasks/open?before=" + before.toISOString().slice(0, 10) + "&days=180&limit=400");
      (payload.rows || []).forEach(function (row) {
        var props = row.properties || {};
        if (row.type === "day_root" || row.type === "time_entry") return;
        add({ id: String(row.id), title: props.title || "Task", when: row.date || props.start || "", done: false });
      });
    } catch (e) {
      // A cold or failing pool read must not block a move onto a task that is
      // already in memory, which is most of them.
      console.warn("[time-reallocate] open-task pool unavailable:", e && e.message);
    }
    return Array.from(seen.values());
  }

  // ── pieces ─────────────────────────────────────────────────────────────────
  function remainingMinutes() {
    var stated = state.pieces.slice(0, -1).reduce(function (sum, piece) {
      return sum + (Number(piece.minutes) || 0);
    }, 0);
    return state.totalMinutes - stated;
  }

  function destinationLabel(piece) {
    if (piece.newTitle) return "New task: " + piece.newTitle;
    if (!piece.taskId) return "";
    if (piece.taskId === state.originTaskId) return (state.originTitle || "This task") + " (stays here)";
    return piece.taskTitle || "Chosen task";
  }

  function pieceRowHtml(piece, index) {
    var last = index === state.pieces.length - 1;
    var rest = remainingMinutes();
    var label = destinationLabel(piece);
    return '<div class="treallo-piece' + (last ? " last" : "") + '" data-piece="' + index + '">' +
      '<div class="treallo-piece-len">' +
        (last
          ? '<span class="treallo-rest' + (rest < 1 ? " bad" : "") + '">' + (rest < 1 ? "nothing left" : fmtMinutes(rest)) + '</span><small>the rest</small>'
          : '<input type="number" min="1" step="1" max="' + (state.totalMinutes - 1) + '" value="' + esc(piece.minutes) + '" data-piece-minutes="' + index + '" aria-label="Minutes for piece ' + (index + 1) + '"><small>minutes</small>') +
      '</div>' +
      '<button type="button" class="treallo-target' + (label ? " chosen" : "") + '" data-piece-pick="' + index + '">' +
        (label ? esc(label) : "Choose a task") +
      '</button>' +
      (state.pieces.length > 1 && !last
        ? '<button type="button" class="treallo-drop" data-piece-drop="' + index + '" aria-label="Remove this piece">&times;</button>'
        : '<span class="treallo-drop-spacer"></span>') +
    '</div>';
  }

  function bodyHtml() {
    var rest = remainingMinutes();
    return '<div class="treallo-pieces">' + state.pieces.map(pieceRowHtml).join("") + '</div>' +
      (state.pieces.length < MAX_PIECES
        ? '<button type="button" class="treallo-add" data-treallo-add>+ Split off another piece</button>'
        : '') +
      (rest < 1 ? '<div class="treallo-warn">Give the earlier pieces less time. The last piece has to keep at least a minute.</div>' : '');
  }

  function renderBody() {
    var body = overlay.querySelector(".treallo-body");
    // The picker's redraw closes over DOM this replaces, so it stops being a
    // valid callback the moment the body goes back to the piece list.
    state.redrawPicker = null;
    body.innerHTML = bodyHtml();
    overlay.querySelector(".treallo-actions").hidden = false;
    var save = overlay.querySelector("[data-treallo-save]");
    var ready = remainingMinutes() >= 1 && state.pieces.every(function (piece) { return !!piece.taskId || !!piece.newTitle; });
    var onlyOrigin = state.pieces.length === 1 && state.pieces[0].taskId === state.originTaskId;
    save.disabled = state.saving || !ready || onlyOrigin;
    save.textContent = state.saving ? "Saving…" : (state.pieces.length > 1 ? "Split it up" : "Move it");
  }

  // ── the task picker pane ───────────────────────────────────────────────────
  function renderPicker(index) {
    var body = overlay.querySelector(".treallo-body");
    overlay.querySelector(".treallo-actions").hidden = true;
    body.innerHTML =
      '<div class="treallo-picker">' +
        '<div class="treallo-picker-head">' +
          '<button type="button" class="treallo-back" data-treallo-back>&larr; Back</button>' +
          '<span>Send piece ' + (index + 1) + ' to</span>' +
        '</div>' +
        '<input class="work-picker-search" type="search" placeholder="Find a task, or type a new one" aria-label="Find a task">' +
        '<div class="treallo-picker-list"></div>' +
      '</div>';
    var search = body.querySelector(".work-picker-search");
    var list = body.querySelector(".treallo-picker-list");

    function draw() {
      var query = String(search.value || "").trim();
      var lower = query.toLowerCase();
      var matches = state.choices.filter(function (task) {
        return !lower || String(task.title || "").toLowerCase().indexOf(lower) !== -1;
      }).slice(0, 60);
      var html = "";
      if (query.length >= 2) {
        html += '<button type="button" class="treallo-row new" data-treallo-new="1">' +
          '<span><strong>Create "' + esc(query) + '"</strong><small>A new task on this day, holding this time</small></span><b>New</b></button>';
      }
      if (state.originTaskId) {
        html += '<button type="button" class="treallo-row" data-treallo-choose="' + esc(state.originTaskId) + '">' +
          '<span><strong>' + esc(state.originTitle || "This task") + '</strong><small>Leave this piece where it is</small></span><b>Stay</b></button>';
      }
      html += matches.length
        ? matches.map(function (task) {
          if (state.originTaskId && String(task.id) === String(state.originTaskId)) return "";
          return '<button type="button" class="treallo-row" data-treallo-choose="' + esc(task.id) + '">' +
            '<span><strong>' + esc(task.title) + '</strong><small>' + esc(task.when || "Open task") + (task.done ? " · done" : "") + '</small></span><b>Move</b></button>';
        }).join("")
        : (state.loadingChoices ? '<div class="work-history-empty">Loading tasks…</div>' : '<div class="work-history-empty">No matching task. Type a name to create one.</div>');
      list.innerHTML = html;
    }
    draw();
    state.redrawPicker = draw;

    search.addEventListener("input", draw);
    list.addEventListener("click", function (event) {
      var choose = event.target.closest("[data-treallo-choose]");
      if (choose) {
        var id = choose.dataset.trealloChoose;
        var hit = state.choices.find(function (task) { return String(task.id) === String(id); });
        state.pieces[index].taskId = id;
        state.pieces[index].taskTitle = hit ? hit.title : (id === state.originTaskId ? state.originTitle : "Chosen task");
        state.pieces[index].newTitle = "";
        state.redrawPicker = null;
        renderBody();
        return;
      }
      if (event.target.closest("[data-treallo-new]")) {
        state.pieces[index].newTitle = String(search.value || "").trim();
        state.pieces[index].taskId = "";
        state.pieces[index].taskTitle = "";
        state.redrawPicker = null;
        renderBody();
      }
    });
    search.focus();
  }

  // ── save ───────────────────────────────────────────────────────────────────
  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "realloc-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  }

  async function save() {
    if (state.saving) return;
    state.saving = true;
    renderBody();
    var rest = remainingMinutes();
    var parts = state.pieces.map(function (piece, index) {
      var part = {};
      // Minutes are sent for every piece but the last; the server recomputes the
      // last one from the remainder either way, so the two never disagree.
      if (index !== state.pieces.length - 1) part.minutes = Number(piece.minutes) || 0;
      if (piece.newTitle) part.newTask = { title: piece.newTitle };
      else part.taskId = piece.taskId;
      return part;
    });
    // One id per PLAN, not per click. Retrying the same submission after a
    // timeout has to be recognised as the same operation server-side (the piece
    // that stays keeps the source row, so a second acceptance would split it
    // again); changing the pieces has to read as a new one.
    var planKey = JSON.stringify(parts);
    if (state.planKey !== planKey) { state.planKey = planKey; state.actionId = uuid(); }
    try {
      var result = await api("/api/time-entries/" + encodeURIComponent(state.entry.id) + "/reallocate", {
        method: "POST",
        body: {
          parts: parts,
          actionId: state.actionId,
          _clientId: (window.blockStore && window.blockStore.CLIENT_ID) || undefined,
        },
      });
      await refreshDate(state.entry.date);
      var moved = state.pieces.length > 1
        ? "Split " + fmtMinutes(state.totalMinutes) + " across " + state.pieces.length + " tasks"
        : "Moved " + fmtMinutes(rest);
      toast(moved, "ok");
      var callback = state.onSaved;
      var payload = result;
      close();
      if (typeof callback === "function") callback(payload);
    } catch (error) {
      state.saving = false;
      if (overlay) renderBody();
      toast((error && error.message) || "Could not move that time", "error");
    }
  }

  // Both caches feed a different surface: the day cache is what the itinerary and
  // today's Day Review read, the range cache is what a past day reads. Refresh
  // whichever one owns the segment's date so the numbers move in one step
  // instead of on the next navigation.
  async function refreshDate(dateStr) {
    var bs = window.blockStore;
    if (!bs || !dateStr) return;
    try {
      var current = bs.getCurrentDate ? bs.getCurrentDate() : null;
      if (current && String(dateStr) === String(current)) {
        await bs.loadDay(dateStr);
      } else {
        if (bs.invalidateRangeCache) bs.invalidateRangeCache(dateStr);
        if (bs.loadDateRange) await bs.loadDateRange(dateStr, dateStr);
      }
    } catch (e) {
      console.warn("[time-reallocate] refresh failed:", e && e.message);
    }
  }

  // ── shell ──────────────────────────────────────────────────────────────────
  function close() {
    if (overlay) overlay.remove();
    overlay = null;
    state = null;
    document.removeEventListener("keydown", onKey, true);
  }

  function onKey(event) {
    if (event.key === "Escape") { event.stopPropagation(); close(); }
  }

  function open(options) {
    options = options || {};
    var entry = options.entry;
    if (!entry || !entry.id) { toast("That tracked time is not loaded yet", "error"); return; }
    if (!(Number((entry.properties || {}).durSec) > 0)) { toast("That segment has no tracked time to move", "error"); return; }
    close();

    var props = entry.properties || {};
    state = {
      entry: entry,
      totalMinutes: minutesOf(entry),
      originTaskId: props.blockId ? String(props.blockId) : "",
      originTitle: options.taskTitle || props.taskTitle || "This task",
      pieces: [{ minutes: "", taskId: "", taskTitle: "", newTitle: "" }],
      choices: [],
      loadingChoices: true,
      saving: false,
      onSaved: options.onSaved || null,
      redrawPicker: null,
      planKey: null,
      actionId: null,
    };

    overlay = document.createElement("div");
    overlay.className = "work-picker-overlay treallo-overlay";
    overlay.innerHTML =
      '<div class="work-picker treallo" role="dialog" aria-modal="true" aria-labelledby="treallo-title">' +
        '<div class="work-picker-head">' +
          '<div><h3 id="treallo-title">Move or split this time</h3>' +
          '<p>' + esc([dayLabel(entry.date), clockOf(entry), fmtMinutes(state.totalMinutes) + " tracked"].filter(Boolean).join(" · ")) + '</p></div>' +
          '<button type="button" data-treallo-close aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="treallo-body"></div>' +
        '<div class="treallo-actions">' +
          '<button type="button" data-treallo-cancel>Cancel</button>' +
          '<button type="button" class="treallo-save" data-treallo-save>Move it</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    renderBody();

    overlay.addEventListener("click", function (event) {
      if (event.target === overlay || event.target.closest("[data-treallo-close]") || event.target.closest("[data-treallo-cancel]")) { close(); return; }
      if (event.target.closest("[data-treallo-back]")) { renderBody(); return; }
      if (event.target.closest("[data-treallo-save]")) { save(); return; }
      if (event.target.closest("[data-treallo-add]")) {
        // The new piece becomes the last one, so the piece that used to absorb the
        // remainder now needs an explicit length. Seed it with half of what is
        // left, which is the split people reach for first.
        var rest = remainingMinutes();
        var tail = state.pieces[state.pieces.length - 1];
        tail.minutes = Math.max(1, Math.floor(rest / 2));
        state.pieces.push({ minutes: "", taskId: "", taskTitle: "", newTitle: "" });
        renderBody();
        return;
      }
      var drop = event.target.closest("[data-piece-drop]");
      if (drop) {
        state.pieces.splice(Number(drop.dataset.pieceDrop), 1);
        if (!state.pieces.length) state.pieces.push({ minutes: "", taskId: "", taskTitle: "", newTitle: "" });
        renderBody();
        return;
      }
      var pick = event.target.closest("[data-piece-pick]");
      if (pick) renderPicker(Number(pick.dataset.piecePick));
    });

    overlay.addEventListener("input", function (event) {
      var field = event.target.closest("[data-piece-minutes]");
      if (!field) return;
      var index = Number(field.dataset.pieceMinutes);
      state.pieces[index].minutes = field.value;
      // Only the derived readouts change while typing, so the input keeps focus
      // and the caret instead of being rebuilt under the user's hands.
      var rest = remainingMinutes();
      var restEl = overlay.querySelector(".treallo-rest");
      if (restEl) {
        restEl.textContent = rest < 1 ? "nothing left" : fmtMinutes(rest);
        restEl.classList.toggle("bad", rest < 1);
      }
      var warn = overlay.querySelector(".treallo-warn");
      if (rest < 1 && !warn) renderBody();
      else if (rest >= 1 && warn) renderBody();
      else {
        var saveBtn = overlay.querySelector("[data-treallo-save]");
        var ready = rest >= 1 && state.pieces.every(function (piece) { return !!piece.taskId || !!piece.newTitle; });
        if (saveBtn) saveBtn.disabled = state.saving || !ready;
      }
    });

    document.addEventListener("keydown", onKey, true);

    loadChoices().then(function (choices) {
      if (!state) return;
      state.choices = choices;
      state.loadingChoices = false;
      if (typeof state.redrawPicker === "function") state.redrawPicker();
    });
  }

  window.DCCTimeReallocate = { open: open, close: close, refreshDate: refreshDate };
})();
