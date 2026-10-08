// DCC-native work sessions. This is deliberately a thin UI over the canonical
// /api/blocks/:id/work lifecycle. Slack reactions call the same server domain.
(function () {
  "use strict";

  var CHECK_IN_MINUTES = 25;
  var MISSED_CHECK_IN_LIMIT = 2;
  var MAX_SESSION_MINUTES = 8 * 60;
  var BREAK_PROMPTS = [
    "Take two minutes for water and a stretch.",
    "Take two minutes to stand and look far away.",
    "Take two minutes to breathe and reset.",
    "Take two minutes to move your shoulders and hands.",
  ];
  var _promptedCheckIns = new Set();
  var _autoPausing = new Set();
  var _checkInTickRunning = false;

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
    if (anchor && anchor.blockId) {
      var anchored = window.blockStore.get(anchor.blockId);
      if (anchored) return anchored;
    }
    if (task.__unf && task.__unf.sourceBlock) return task.__unf.sourceBlock;
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

  async function act(task, action, options) {
    options = options || {};
    var block = blockFor(task);
    if (!block || !window.blockStore || typeof window.blockStore.workAction !== "function") {
      if (typeof showToast === "function") showToast("This task is not ready for work tracking", "error");
      return null;
    }
    var result = await window.blockStore.workAction(block.id, action, {
      actor: "dcc",
      at: options.at,
      actionId: options.actionId,
    });
    if (result && result.block && window.DCC && window.DCC.TaskModel) {
      var fresh = window.DCC.TaskModel.fromBlock(result.block, { deriveEnd: true });
      Object.assign(task, fresh);
      if (task.__unf) task.__unf.sourceBlock = result.block;
    }
    refresh();
    if (typeof render === "function") render("schedule");
    if (typeof _addModalBlockId !== "undefined" && String(_addModalBlockId) === String(block.id)) renderHistory(block.id);
    if (typeof window.dispatchEvent === "function" && typeof window.CustomEvent === "function") {
      window.dispatchEvent(new window.CustomEvent("dcc:work-session-changed", { detail: { id: task.id } }));
    }
    return result;
  }

  function checkInState(task, nowMs) {
    nowMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    var startedMs = Date.parse((task && task.startedAt) || "");
    if (!Number.isFinite(startedMs)) return { active: false, due: false, shouldAutoPause: false };
    var acknowledgedMs = Date.parse((task && task.workCheckInAt) || "");
    var anchorMs = Number.isFinite(acknowledgedMs) && acknowledgedMs >= startedMs && acknowledgedMs <= nowMs
      ? acknowledgedMs : startedMs;
    var cadenceMs = CHECK_IN_MINUTES * 60_000;
    var hardStopAtMs = startedMs + MAX_SESSION_MINUTES * 60_000;
    var missed = Math.max(0, Math.floor((nowMs - anchorMs) / cadenceMs));
    var autoPauseAtMs = Math.min(anchorMs + MISSED_CHECK_IN_LIMIT * cadenceMs, hardStopAtMs);
    var shouldAutoPause = nowMs >= autoPauseAtMs;
    var count = Math.max(0, Number((task && task.workCheckInCount) || 0));
    return {
      active: true,
      due: missed >= 1 && !shouldAutoPause,
      missed: Math.min(missed, MISSED_CHECK_IN_LIMIT),
      prompt: BREAK_PROMPTS[count % BREAK_PROMPTS.length],
      promptIndex: count % BREAK_PROMPTS.length,
      anchorMs: anchorMs,
      nextCheckInAtMs: anchorMs + cadenceMs,
      autoPauseAtMs: autoPauseAtMs,
      hardStopAtMs: hardStopAtMs,
      shouldAutoPause: shouldAutoPause,
    };
  }

  function checkInKey(task, state) {
    return String(task.id) + ":" + String(task.startedAt) + ":" + String(state.anchorMs);
  }

  function focusCheckIn(taskId) {
    var rows = document.querySelectorAll ? document.querySelectorAll("[data-work-checkin-task]") : [];
    var row = Array.from(rows).find(function (candidate) {
      return String(candidate.dataset.workCheckinTask) === String(taskId);
    });
    if (!row) return;
    if (typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    var button = row.querySelector && row.querySelector('[data-work-action="continue"]');
    if (button && typeof button.focus === "function") button.focus();
  }

  function deliverCheckIn(task, state) {
    var key = checkInKey(task, state);
    if (_promptedCheckIns.has(key)) return false;
    _promptedCheckIns.add(key);
    var text = (task.title || "Active work") + ": " + state.prompt;
    var pet = window.DCC && window.DCC.PetNudge;
    if (pet && typeof pet.deliverWorkCheckIn === "function") {
      pet.deliverWorkCheckIn(text, { open: function () { focusCheckIn(task.id); } }).catch(function () {});
    } else if (window.DCC && typeof window.DCC.toast === "function") {
      window.DCC.toast("Pet check-in: " + text, "info", 60000, {
        label: "Open",
        onClick: function () { focusCheckIn(task.id); },
      });
    }
    return true;
  }

  async function checkInTick(nowMs) {
    if (_checkInTickRunning) return false;
    _checkInTickRunning = true;
    try {
      var atMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
      var active = activeTasks();
      refresh(atMs);
      for (var i = 0; i < active.length; i++) {
        var task = active[i];
        var state = checkInState(task, atMs);
        if (state.shouldAutoPause) {
          var key = checkInKey(task, state) + ":auto";
          if (_autoPausing.has(key)) continue;
          _autoPausing.add(key);
          var pauseAt = new Date(state.autoPauseAtMs).toISOString();
          var safeTaskId = String(task.id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
          try {
            await act(task, "auto-pause", {
              at: pauseAt,
              actionId: "work-checkin-auto-pause:" + safeTaskId + ":" + state.autoPauseAtMs,
            });
            if (window.DCC && typeof window.DCC.toast === "function") {
              window.DCC.toast("Timer paused after two missed pet check-ins.", "info", 12000);
            }
          } catch (error) {
            _autoPausing.delete(key);
          }
          continue;
        }
        if (state.due) deliverCheckIn(task, state);
      }
      return true;
    } finally {
      _checkInTickRunning = false;
    }
  }

  function checkInHtml(task, nowMs) {
    var state = checkInState(task, nowMs);
    if (!state.due && !state.shouldAutoPause) return "";
    if (state.shouldAutoPause) {
      return '<div class="work-checkin work-checkin-pausing" data-work-checkin-task="' + esc(task.id) + '"><span class="work-checkin-pet" aria-hidden="true">🐾</span><span><strong>Safety pause</strong><small>Two pet check-ins were missed. Saving the timer at its safe cutoff.</small></span></div>';
    }
    return '<div class="work-checkin" data-work-checkin-task="' + esc(task.id) + '"><span class="work-checkin-pet" aria-hidden="true">🐾</span><span><strong>Pet check-in</strong><small>' + esc(state.prompt) + ' Pause, or continue working.</small></span><button class="work-action-btn pause" data-work-task="' + esc(task.id) + '" data-work-action="pause">Pause</button><button class="work-action-btn continue" data-work-task="' + esc(task.id) + '" data-work-action="continue">Continue</button></div>';
  }

  function findTask(id) {
    var carryover = window.DCC && window.DCC.Carryover;
    var carried = carryover && typeof carryover.get === "function" ? carryover.get(id) : null;
    if (carried) return carried;
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
    var carryover = window.DCC && window.DCC.Carryover;
    if (carryover && typeof carryover.rows === "function") pools.push(carryover.rows());
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
    var carryover = window.DCC && window.DCC.Carryover;
    if (carryover && typeof carryover.rows === "function") pools.push(carryover.rows());
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

  function refresh(nowMs) {
    var dock = document.getElementById("active-work-dock");
    if (!dock) return;
    var active = activeTasks();
    dock.hidden = !active.length;
    dock.innerHTML = active.length ? '<div class="active-work-head"><span>Active work</span><span>' + active.length + " running</span></div>" + active.map(function (task) {
      var total = Number(task.actualMinutes) || 0;
      return '<div class="active-work-row"><span class="active-work-dot"></span><span class="active-work-title">' + esc(task.title || "Task") + '</span><span class="active-work-time">' + elapsedLabel(task.startedAt) + (total ? " · " + total + "m saved" : "") + '</span><button class="work-action-btn pause" data-work-task="' + esc(task.id) + '" data-work-action="pause">Pause</button><button class="work-action-btn complete" data-work-task="' + esc(task.id) + '" data-work-complete="true">Complete</button><button class="work-detail-btn" data-work-task="' + esc(task.id) + '" data-work-open="true">Details</button>' + checkInHtml(task, nowMs) + '</div>';
    }).join("") : "";
  }

  // The rows the open history section is currently showing, so the reallocate
  // click has the full time_entry to hand over without a second fetch.
  var _historyRows = [];
  var _historyRequest = 0;

  function fmtWhen(iso) {
    var date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  async function renderHistory(blockId) {
    var request = ++_historyRequest;
    var section = document.getElementById("am-work-history-section");
    var target = document.getElementById("am-work-history");
    var actions = document.getElementById("am-work-actions");
    var timeSummary = document.getElementById('am-time-summary');
    if (timeSummary) timeSummary.innerHTML = '';
    if (!section || !target) return;
    section.style.display = "none";
    target.innerHTML = "";
    if (actions) actions.innerHTML = "";
    if (!blockId) return;
    try {
      var response = await fetch("/api/blocks/" + encodeURIComponent(blockId) + "/work");
      if (!response.ok) throw new Error("Unable to load work history");
      var data = await response.json();
      if (request !== _historyRequest) return;
      if (typeof _addModalBlockId !== "undefined" && _addModalBlockId && String(_addModalBlockId) !== String(blockId)) return;
      var sessions = data.sessions || [];
      var detailTask = window.DCC && window.DCC.TaskModel ? window.DCC.TaskModel.fromBlock(data.block, { deriveEnd: true }) : (data.block.properties || {});
      var detailDone = detailTask.status === "done" || !!detailTask.completedAt;
      if (actions) actions.innerHTML = actionButtonHtml(detailTask, detailDone) + (!detailDone ? '<button class="work-action-btn complete" data-work-task="' + esc(detailTask.id) + '" data-work-complete="true">Complete</button>' : "");
      if (typeof _amRenderExecutionContext === 'function') _amRenderExecutionContext(detailTask);
      var rawProps = (data.block && data.block.properties) || {};
      var planned = Number(rawProps.estimatedMinutes || rawProps.durationMinutes || rawProps.duration) || 0;
      var sessionSeconds = sessions.reduce(function (sum, row) { return sum + (Number((row.properties || {}).durSec) || 0); }, 0);
      var actual = Number(detailTask.actualMinutes) || (sessionSeconds ? Math.max(1, Math.round(sessionSeconds / 60)) : 0);
      var summary = '<div class="work-history-summary"><span>Planned <strong>' + (planned ? planned + "m" : "not set") + '</strong></span><span>Actual <strong>' + (actual ? actual + "m" : "not recorded") + '</strong></span>' + (detailTask.startedAt ? '<span class="work-live">Active ' + elapsedLabel(detailTask.startedAt) + '</span>' : "") + '</div>';
      if (timeSummary) { timeSummary.innerHTML = summary; summary = ''; }
      var checkIns = window.DCC && window.DCC.Waiting && window.DCC.Waiting.checkInHistoryForTask
        ? window.DCC.Waiting.checkInHistoryForTask(data.block) : "";
      summary += checkIns;
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
      if (request !== _historyRequest) return;
      section.style.display = "";
      target.innerHTML = '<div class="work-history-empty">Work history is temporarily unavailable.</div>';
      if (actions) actions.innerHTML = '<button type="button" class="work-action-btn" data-work-history-retry="' + esc(blockId) + '">Retry work controls</button>';
    } finally {
      if (request === _historyRequest && typeof _setAddModalControlsEditable === 'function' && typeof _addModalEditing !== 'undefined') {
        _setAddModalControlsEditable(document.querySelector('#add-modal-overlay .add-modal'), _addModalEditing);
      }
    }
  }

  document.addEventListener("click", function (event) {
    var retry = event.target.closest && event.target.closest('[data-work-history-retry]');
    if (retry) { renderHistory(retry.dataset.workHistoryRetry); return; }
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
    if (!button || button.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    var task = findTask(button.dataset.workTask);
    if (!task) return;
    if (button.dataset.workOpen === "true") {
      if (typeof openAddModal === "function") openAddModal(task.id, task.title || "Task");
      return;
    }
    if (button.dataset.workComplete === "true") {
      var completion;
      if (task.__unf && window.DCC && window.DCC.Carryover) {
        completion = window.DCC.Carryover.complete(task, window.DCC.Carryover.rows());
      } else if (typeof toggleDone === "function") {
        completion = toggleDone(task.id);
      }
      refresh();
      Promise.resolve(completion).then(function() {
        refresh();
        var block = blockFor(task);
        if (block && typeof _addModalBlockId !== 'undefined' && String(_addModalBlockId) === String(block.id)) renderHistory(block.id);
      }, function(error) { if (typeof showToast === 'function') showToast(error.message || 'Completion failed', 'error'); });
      return;
    }
    button.disabled = true;
    act(task, button.dataset.workAction || (task.startedAt ? "pause" : "start"))
      .catch(function(error) {
        if (typeof showToast === 'function') showToast(error.message || 'Work action failed. Try again.', 'error');
      }).finally(function() {
        if (button.isConnected) button.disabled = !!(button.closest('#add-modal-overlay') && typeof _addModalEditing !== 'undefined' && !_addModalEditing);
      });
  });

  setInterval(refresh, 10000);
  document.addEventListener("DOMContentLoaded", function () {
    refresh();
    checkInTick();
  });
  window.DCCWorkSessions = {
    actionButtonHtml: actionButtonHtml,
    itineraryActionButtonsHtml: itineraryActionButtonsHtml,
    act: act,
    refresh: refresh,
    renderHistory: renderHistory,
    cancelHistory: function() { ++_historyRequest; _historyRows = []; },
    policy: policy,
    openPicker: openPicker,
    checkInState: checkInState,
    checkInTick: checkInTick,
    checkInHtml: checkInHtml,
    CHECK_IN_MINUTES: CHECK_IN_MINUTES,
    MISSED_CHECK_IN_LIMIT: MISSED_CHECK_IN_LIMIT,
    MAX_SESSION_MINUTES: MAX_SESSION_MINUTES,
    BREAK_PROMPTS: BREAK_PROMPTS.slice(),
  };
})();
