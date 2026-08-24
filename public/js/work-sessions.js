// DCC-native work sessions. This is deliberately a thin UI over the canonical
// /api/blocks/:id/work lifecycle. Slack reactions call the same server domain.
(function () {
  "use strict";

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
    });
  }

  function policy(task) {
    return window.TaskTypes ? window.TaskTypes.rule(task || "task", "actualTimeMode") : "work_sessions";
  }

  // Completion is projected into manualDone immediately, before the canonical
  // row response replaces the task object's older status/startedAt fields. The
  // dock must honor that same source or a just-completed task remains visibly
  // active until the next server refresh.
  function isTaskDone(task) {
    if (!task) return false;
    if (typeof isDone === "function" && isDone(task)) return true;
    return task.status === "done" || task.done === true || task.completed === true || !!task.completedAt;
  }

  function blockFor(task) {
    if (!task || !window.blockStore) return null;
    if (task._blockId && window.blockStore.get(task._blockId)) return window.blockStore.get(task._blockId);
    var anchor = typeof taskAnchorById === "function" ? taskAnchorById(task.id) : null;
    if (anchor && anchor.blockId) return window.blockStore.get(anchor.blockId) || null;
    var rows = window.blockStore.getByType ? window.blockStore.getByType("block") : [];
    return rows.find(function (row) {
      var p = row.properties || {};
      return row.id === task.id || p.local_id === task.id;
    }) || null;
  }

  function isWorkTaskBlock(block) {
    var model = window.DCC && window.DCC.TaskModel;
    var props = (block && block.properties) || {};
    return !!(block && model) && (model.foldsIntoItinerary(block)
      || (model.isTaskRow(block) && props.kind === "backlog"));
  }

  function actionButtonHtml(task, done) {
    if (!task || done || policy(task) !== "work_sessions" || !isWorkTaskBlock(blockFor(task))) return "";
    var active = !!task.startedAt;
    return '<button class="work-action-btn ' + (active ? "pause" : "start") + '" data-work-task="' + esc(task.id) + '" data-work-action="' + (active ? "pause" : "start") + '" title="' + (active ? "Pause and save this work session" : "Start tracking work") + '">' + (active ? "Pause" : "Start") + "</button>";
  }

  function itineraryActionButtonsHtml(task, done) {
    var primary = actionButtonHtml(task, done);
    if (!primary) return "";
    if (!task.startedAt) return primary;
    return '<span class="work-itinerary-actions">' + primary +
      '<button class="work-action-btn complete" data-work-task="' + esc(task.id) + '" data-work-complete="true" title="Complete this task and save the active work session">Complete</button></span>';
  }

  async function act(task, action) {
    var block = blockFor(task);
    if (!block || !window.blockStore || typeof window.blockStore.workAction !== "function") {
      if (typeof showToast === "function") showToast("This task is not ready for work tracking", "error");
      return null;
    }
    var result = await window.blockStore.workAction(block.id, action, { actor: "dcc" });
    if (result && result.block && window.DCC && window.DCC.TaskModel) {
      var fresh = window.DCC.TaskModel.fromBlock(result.block, { deriveEnd: true });
      Object.assign(task, fresh);
    }
    refresh();
    if (typeof render === "function") render("schedule");
    return result;
  }

  function findTask(id) {
    var pools = [];
    if (typeof scheduled !== "undefined" && Array.isArray(scheduled)) pools.push(scheduled);
    if (typeof backlog !== "undefined" && Array.isArray(backlog)) pools.push(backlog);
    for (var i = 0; i < pools.length; i++) {
      var hit = pools[i].find(function (task) { return String(task.id) === String(id); });
      if (hit) return hit;
    }
    if (window.blockStore && window.blockStore.getByType) {
      var row = window.blockStore.getByType("block").find(function (block) {
        var p = block.properties || {};
        return String(block.id) === String(id) || String(p.local_id || "") === String(id);
      });
      if (row) return window.DCC && window.DCC.TaskModel ? window.DCC.TaskModel.fromBlock(row, { deriveEnd: true }) : { ...(row.properties || {}), id: (row.properties || {}).local_id || row.id, _blockId: row.id };
    }
    return null;
  }

  function elapsedLabel(startedAt) {
    var start = Date.parse(startedAt || "");
    if (!Number.isFinite(start)) return "";
    var seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    return (hours ? hours + "h " : "") + minutes + "m";
  }

  function activeTasks() {
    var pools = [];
    if (typeof scheduled !== "undefined" && Array.isArray(scheduled)) pools.push(scheduled);
    if (typeof backlog !== "undefined" && Array.isArray(backlog)) pools.push(backlog);
    if (window.blockStore && window.blockStore.getByType) {
      var cached = window.blockStore.getByType("block").filter(isWorkTaskBlock).map(function (row) {
        return window.DCC && window.DCC.TaskModel ? window.DCC.TaskModel.fromBlock(row, { deriveEnd: true }) : { ...(row.properties || {}), id: (row.properties || {}).local_id || row.id, _blockId: row.id };
      });
      pools.push(cached);
    }
    var seen = new Set();
    return pools.flat().filter(function (task) {
      if (!task || seen.has(String(task.id))) return false;
      seen.add(String(task.id));
      return isWorkTaskBlock(blockFor(task)) && policy(task) === "work_sessions" && !!task.startedAt && !isTaskDone(task);
    });
  }

  function availableTasks() {
    var pools = [];
    if (typeof scheduled !== "undefined" && Array.isArray(scheduled)) pools.push(scheduled);
    if (typeof backlog !== "undefined" && Array.isArray(backlog)) pools.push(backlog);
    if (window.blockStore && window.blockStore.getByType) {
      pools.push(window.blockStore.getByType("block").filter(isWorkTaskBlock).map(function (row) {
        return window.DCC && window.DCC.TaskModel ? window.DCC.TaskModel.fromBlock(row, { deriveEnd: true }) : { ...(row.properties || {}), id: (row.properties || {}).local_id || row.id, _blockId: row.id };
      }));
    }
    var seen = new Set();
    return pools.flat().filter(function (task) {
      if (!task || !task.id || seen.has(String(task.id))) return false;
      seen.add(String(task.id));
      return isWorkTaskBlock(blockFor(task)) && policy(task) === "work_sessions" && !isTaskDone(task) && !task.deleted_at;
    }).sort(function (a, b) {
      if (!!a.startedAt !== !!b.startedAt) return a.startedAt ? -1 : 1;
      return String(a.start || "99:99").localeCompare(String(b.start || "99:99")) || String(a.title || "").localeCompare(String(b.title || ""));
    });
  }

  function closePicker() {
    var overlay = document.getElementById("work-picker-overlay");
    if (overlay) overlay.remove();
  }

  function openPicker() {
    closePicker();
    var tasks = availableTasks();
    var overlay = document.createElement("div");
    overlay.id = "work-picker-overlay";
    overlay.className = "work-picker-overlay";
    overlay.innerHTML = '<div class="work-picker" role="dialog" aria-modal="true" aria-labelledby="work-picker-title"><div class="work-picker-head"><div><h3 id="work-picker-title">Start work</h3><p>Choose any open task. More than one can run at once.</p></div><button type="button" data-work-picker-close aria-label="Close">&times;</button></div><input class="work-picker-search" type="search" placeholder="Find a task" aria-label="Find a task"><div class="work-picker-list"></div></div>';
    document.body.appendChild(overlay);
    var list = overlay.querySelector(".work-picker-list");
    var search = overlay.querySelector(".work-picker-search");
    function draw() {
      var query = String(search.value || "").trim().toLowerCase();
      var matches = tasks.filter(function (task) { return !query || String(task.title || "").toLowerCase().includes(query); });
      list.innerHTML = matches.length ? matches.map(function (task) {
        var active = !!task.startedAt;
        return '<button type="button" class="work-picker-row" data-work-picker-task="' + esc(task.id) + '"><span><strong>' + esc(task.title || "Task") + '</strong><small>' + (active ? "Active " + elapsedLabel(task.startedAt) : (task.start ? esc(task.start) : "Open task")) + '</small></span><b>' + (active ? "Pause" : "Start") + '</b></button>';
      }).join("") : '<div class="work-history-empty">No matching open tasks.</div>';
    }
    draw();
    search.addEventListener("input", draw);
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay || event.target.closest("[data-work-picker-close]")) { closePicker(); return; }
      var row = event.target.closest("[data-work-picker-task]");
      if (!row) return;
      var task = findTask(row.dataset.workPickerTask);
      if (!task) return;
      act(task, task.startedAt ? "pause" : "start").then(closePicker);
    });
    search.focus();
  }

  function refresh() {
    var dock = document.getElementById("active-work-dock");
    if (!dock) return;
    var active = activeTasks();
    dock.hidden = !active.length;
    dock.innerHTML = active.length ? '<div class="active-work-head"><span>Active work</span><span>' + active.length + " running</span></div>" + active.map(function (task) {
      var total = Number(task.actualMinutes) || 0;
      return '<div class="active-work-row"><span class="active-work-dot"></span><span class="active-work-title">' + esc(task.title || "Task") + '</span><span class="active-work-time">' + elapsedLabel(task.startedAt) + (total ? " · " + total + "m saved" : "") + '</span><button class="work-action-btn pause" data-work-task="' + esc(task.id) + '" data-work-action="pause">Pause</button><button class="work-action-btn complete" data-work-task="' + esc(task.id) + '" data-work-complete="true">Complete</button><button class="work-detail-btn" data-work-task="' + esc(task.id) + '" data-work-open="true">Details</button></div>';
    }).join("") : "";
  }

  // The rows the open history section is currently showing, so the reallocate
  // click has the full time_entry to hand over without a second fetch.
  var _historyRows = [];

  function fmtWhen(iso) {
    var date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  async function renderHistory(blockId) {
    var section = document.getElementById("am-work-history-section");
    var target = document.getElementById("am-work-history");
    var actions = document.getElementById("am-work-actions");
    if (!section || !target) return;
    section.style.display = "none";
    target.innerHTML = "";
    if (actions) actions.innerHTML = "";
    if (!blockId) return;
    try {
      var response = await fetch("/api/blocks/" + encodeURIComponent(blockId) + "/work");
      if (!response.ok) throw new Error("Unable to load work history");
      var data = await response.json();
      if (typeof _addModalBlockId !== "undefined" && _addModalBlockId && String(_addModalBlockId) !== String(blockId)) return;
      var sessions = data.sessions || [];
      var detailTask = window.DCC && window.DCC.TaskModel ? window.DCC.TaskModel.fromBlock(data.block, { deriveEnd: true }) : (data.block.properties || {});
      var detailDone = detailTask.status === "done" || !!detailTask.completedAt;
      if (actions) actions.innerHTML = actionButtonHtml(detailTask, detailDone) + (!detailDone ? '<button class="work-action-btn complete" data-work-task="' + esc(detailTask.id) + '" data-work-complete="true">Complete</button>' : "");
      var rawProps = (data.block && data.block.properties) || {};
      var planned = Number(rawProps.estimatedMinutes || rawProps.durationMinutes || rawProps.duration) || 0;
      var sessionSeconds = sessions.reduce(function (sum, row) { return sum + (Number((row.properties || {}).durSec) || 0); }, 0);
      var actual = Number(detailTask.actualMinutes) || (sessionSeconds ? Math.max(1, Math.round(sessionSeconds / 60)) : 0);
      var summary = '<div class="work-history-summary"><span>Planned <strong>' + (planned ? planned + "m" : "not set") + '</strong></span><span>Actual <strong>' + (actual ? actual + "m" : "not recorded") + '</strong></span>' + (detailTask.startedAt ? '<span class="work-live">Active ' + elapsedLabel(detailTask.startedAt) + '</span>' : "") + '</div>';
      section.style.display = "";
      if (!sessions.length) {
        var missingWindow = detailDone && policy(detailTask) === "planned_window";
        target.innerHTML = summary + '<div class="work-history-empty">' + (missingWindow ? "No timed meeting window was available." : "No work sessions yet.") + '</div>';
        return;
      }
      // Grouped by LOGICAL session, but the reallocate button is per ROW, because
      // a row is what the server moves: a session that crossed midnight is two
      // rows on two days, and "move this session" would be ambiguous. One part
      // gets a plain button; several get one button each, labelled by part.
      var groups = new Map();
      sessions.forEach(function (row) {
        var id = (row.properties || {}).workSessionId || row.id;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(row);
      });
      _historyRows = sessions.slice();
      target.innerHTML = summary + Array.from(groups.values()).map(function (rows) {
        var parts = rows.map(function (row) { return row.properties || {}; });
        var first = parts[0] || {};
        var last = parts[parts.length - 1] || first;
        var seconds = parts.reduce(function (sum, p) { return sum + (Number(p.durSec) || 0); }, 0);
        var minutes = Math.max(1, Math.round(seconds / 60));
        var badge = first.estimated ? '<span class="work-estimated">Estimated</span>' : "";
        var from = first.startedBy || first.actor || "dcc";
        var to = last.endedBy || last.actor || from;
        var moveButtons = window.DCCTimeReallocate ? '<div class="work-realloc-set">' + rows.map(function (row, i) {
          return '<button type="button" class="work-realloc" data-time-entry="' + esc(row.id) + '">'
            + (rows.length > 1 ? "Move part " + (i + 1) : "Move or split") + '</button>';
        }).join("") + '</div>' : "";
        return '<div class="work-history-row"><div><strong>' + fmtWhen(first.startedAt) + '</strong><span> to ' + fmtWhen(last.endedAt) + '</span></div><div>' + minutes + "m " + badge + '</div><small>' + esc(from === to ? from : from + " to " + to) + "</small>" + moveButtons + "</div>";
      }).join("");
    } catch (error) {
      section.style.display = "";
      target.innerHTML = '<div class="work-history-empty">Work history is temporarily unavailable.</div>';
    }
  }

  document.addEventListener("click", function (event) {
    var move = event.target.closest && event.target.closest(".work-realloc[data-time-entry]");
    if (move) {
      event.preventDefault();
      event.stopPropagation();
      var entry = _historyRows.find(function (row) { return String(row.id) === String(move.dataset.timeEntry); });
      if (!entry || !window.DCCTimeReallocate) return;
      var owner = (entry.properties || {}).blockId;
      window.DCCTimeReallocate.open({
        entry: entry,
        taskTitle: (entry.properties || {}).taskTitle,
        onSaved: function () {
          if (owner) renderHistory(owner);
          refresh();
          if (typeof render === "function") render("schedule");
        },
      });
      return;
    }
    var button = event.target.closest && event.target.closest("[data-work-task]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    var task = findTask(button.dataset.workTask);
    if (!task) return;
    if (button.dataset.workOpen === "true") {
      if (typeof openAddModal === "function") openAddModal(task.id, task.title || "Task");
      return;
    }
    if (button.dataset.workComplete === "true") {
      if (typeof toggleDone === "function") {
        var completion = toggleDone(task.id);
        refresh();
        Promise.resolve(completion).finally(refresh);
      }
      return;
    }
    act(task, button.dataset.workAction || (task.startedAt ? "pause" : "start"));
  });

  setInterval(refresh, 10000);
  document.addEventListener("DOMContentLoaded", refresh);
  window.DCCWorkSessions = { actionButtonHtml: actionButtonHtml, itineraryActionButtonsHtml: itineraryActionButtonsHtml, act: act, refresh: refresh, renderHistory: renderHistory, policy: policy, openPicker: openPicker };
})();
