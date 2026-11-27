// game-hud.js — the small, always-visible Mochi chip (sparks today, streak,
// rest days) and the "Mochi's plan" panel (3 asks, minimum day, weekend trip).
// Data comes from GET /api/game/summary. The HUD refreshes when the server
// sends a `game-changed` SSE event, when a work session changes, when the tab
// becomes visible, and once a minute as a fallback. When today's XP goes up it
// shows a short, calm "+N XP" float. prefers-reduced-motion skips the motion.
/* global window, document */
(function () {
  "use strict";
  var DCC = window.DCC;
  if (!DCC || typeof DCC.api !== "function") return;

  var hud = document.getElementById("game-hud");
  if (!hud) return;
  var panel = null;
  var last = null;
  var inflight = null;
  var timer = null;

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  // Rest days: each one keeps the streak safe on a missed day. Drawn as moons.
  function heartsHtml(lives) {
    var out = "";
    for (var i = 0; i < lives.max; i++) {
      out += '<span class="game-heart' + (i < lives.left ? "" : " is-empty") + '" aria-hidden="true">☾</span>';
    }
    return out;
  }
  var pet = null;
  function petHtml(mood) {
    return window.DCCMochiArt ? '<span class="game-pet">' + window.DCCMochiArt.svg({ mood: mood || "happy", hat: pet && pet.accessory, color: pet && pet.color }) + "</span>" : "";
  }

  function render(s) {
    var label = s.todayXp + " sparks today, " + s.streak.current + " day streak, " + s.lives.left + " of " + s.lives.max + " rest days left";
    hud.setAttribute("aria-label", label + ". Open Mochi's plan.");
    hud.title = label;
    hud.innerHTML = petHtml() +
      '<span class="game-xp"><span aria-hidden="true">★</span> <b data-game-xp>' + s.todayXp + "</b></span>" +
      '<span class="game-streak"><b>' + s.streak.current + "</b> " + (s.streak.current === 1 ? "day" : "days") + "</span>" +
      '<span class="game-lives">' + heartsHtml(s.lives) + "</span>";
  }

  function floatGain(points) {
    if (!(points > 0) || reducedMotion()) return;
    var el = document.createElement("span");
    el.className = "game-gain";
    el.textContent = "+" + points + " sparks";
    el.setAttribute("aria-hidden", "true");
    hud.appendChild(el);
    hud.classList.add("game-hud--gain");
    window.setTimeout(function () { el.remove(); hud.classList.remove("game-hud--gain"); }, 1400);
  }

  function announce(points) {
    var live = document.getElementById("game-hud-live");
    if (live && points > 0) live.textContent = "+" + points + " sparks for Mochi";
  }

  async function refresh() {
    if (inflight) return inflight;
    inflight = (async function () {
      try {
        if (!pet) { try { var ps = await DCC.api("/api/pet-home/state"); pet = (ps && ps.home && ps.home.pet) || {}; } catch (_p) { pet = {}; } }
        var s = await DCC.api("/api/game/summary", { errorLabel: "Could not load game summary" });
        var gained = last && last.today === s.today ? s.todayXp - last.todayXp : 0;
        var prevXp = last ? last.todayXp : s.todayXp;
        render(s);
        if (gained > 0) {
          var xpEl = hud.querySelector("[data-game-xp]");
          if (xpEl && window.Celebrate && typeof window.Celebrate.countNumber === "function" && !reducedMotion()) {
            window.Celebrate.countNumber(xpEl, prevXp, s.todayXp, { duration: 700 });
          }
          floatGain(gained);
          announce(gained);
        }
        last = s;
        if (panel && !panel.hidden) renderPanel();
      } catch (_e) {
        hud.classList.add("game-hud--offline");
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function soon() {
    window.clearTimeout(timer);
    timer = window.setTimeout(refresh, 300);
  }

  // ── Today panel ──

  function todayCandidates() {
    var store = window.blockStore, model = DCC.TaskModel;
    if (!store || typeof store.getByType !== "function" || !last) return [];
    return store.getByType("block").filter(function (row) {
      var p = row.properties || {};
      if (row.deleted_at || row.date !== last.today || !p.title) return false;
      if (model && typeof model.isTaskRow === "function" && !model.isTaskRow(row)) return false;
      return true;
    }).sort(function (a, b) {
      return String((a.properties || {}).start || "99:99").localeCompare(String((b.properties || {}).start || "99:99"));
    });
  }

  function selectHtml(index, current, rows) {
    var opts = '<option value="">— none —</option>';
    var seen = false;
    rows.forEach(function (row) {
      var p = row.properties || {};
      if (row.id === current) seen = true;
      opts += '<option value="' + esc(row.id) + '"' + (row.id === current ? " selected" : "") + ">" +
        esc((p.start ? p.start + " · " : "") + p.title) + "</option>";
    });
    if (current && !seen) {
      var b = (last.intentions.big3 || []).find(function (x) { return x.id === current; });
      opts += '<option value="' + esc(current) + '" selected>' + esc(b ? b.title : current) + "</option>";
    }
    return '<label class="game-big3-row"><span>' + (index + 1) + '</span><select data-big3="' + index + '">' + opts + "</select></label>";
  }

  function renderPanel() {
    if (!panel || !last) return;
    var s = last, t = s.tier, it = s.intentions;
    var ids = (it.big3 || []).map(function (b) { return b.id; });
    var rows = todayCandidates();
    var progress = t.next ? Math.round(((s.weekXp - t.min) / (t.next.min - t.min)) * 100) : 100;
    var doneList = (it.big3 || []).map(function (b) {
      return '<li class="' + (b.done ? "is-done" : "") + '">' + (b.done ? "✓ " : "○ ") + esc(b.title) + "</li>";
    }).join("");
    panel.innerHTML =
      '<div class="game-panel-head"><h3 id="game-panel-title">Mochi\'s plan</h3><button type="button" class="game-panel-close" data-game-close aria-label="Close">&times;</button></div>' +
      '<p class="game-panel-stats">' + s.streak.current + " day streak (best " + s.streak.best + ") · " +
        s.lives.left + " of " + s.lives.max + " rest days left · rest days refill Monday</p>" +
      '<div class="game-tier"><div class="game-tier-line"><b>Weekend trip: ' + esc(t.label) + "</b><span>" + s.weekXp + " sparks this week" +
        (t.next ? " · " + t.next.xpToGo + " to " + esc(t.next.label) : "") + "</span></div>" +
        '<div class="game-tier-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + progress + '"><span style="width:' + Math.max(0, Math.min(100, progress)) + '%"></span></div></div>' +
      '<section class="game-section"><h4>Mochi\'s 3 asks</h4>' +
        (doneList ? '<ul class="game-big3-status">' + doneList + "</ul>" : "") +
        '<p class="game-hint">Pick up to 3 tasks that make today a win. Finish all 3 for a big bonus.</p>' +
        [0, 1, 2].map(function (i) { return selectHtml(i, ids[i] || "", rows); }).join("") +
      "</section>" +
      '<section class="game-section"><h4>Minimum day</h4>' +
        '<p class="game-hint">The smallest thing that still counts the day. Check it off to keep the streak.</p>' +
        '<input type="text" maxlength="280" data-minimum-text placeholder="e.g. 10 minutes on the top task" value="' + esc(it.minimumDay) + '">' +
        '<label class="game-check"><input type="checkbox" data-minimum-done' + (it.minimumDayDone ? " checked" : "") + "> Done</label>" +
      "</section>" +
      '<div class="game-panel-actions"><span class="game-panel-status" data-game-status role="status"></span><button type="button" class="game-save" data-game-save>Save</button></div>';
  }

  function status(text) {
    var el = panel && panel.querySelector("[data-game-status]");
    if (el) el.textContent = text;
  }

  async function save() {
    var big3 = Array.prototype.map.call(panel.querySelectorAll("[data-big3]"), function (el) { return el.value; }).filter(Boolean);
    var minimumDay = panel.querySelector("[data-minimum-text]").value;
    try {
      status("Saving…");
      await DCC.api("/api/game/intentions/" + last.today, { method: "PUT", body: { big3: big3, minimumDay: minimumDay } });
      status("Saved");
      window.dispatchEvent(new CustomEvent("dcc:game-intentions-changed"));
      refresh();
    } catch (e) {
      status("");
      DCC.toast(e.message || "Could not save intentions");
    }
  }

  async function toggleMinimum(done) {
    try {
      await DCC.api("/api/game/intentions/" + last.today + "/minimum-day", { method: "POST", body: { done: done } });
      window.dispatchEvent(new CustomEvent("dcc:game-intentions-changed"));
      refresh();
    } catch (e) {
      DCC.toast(e.message || "Could not update minimum day");
    }
  }

  function openPanel() {
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "game-panel";
      panel.id = "game-panel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-labelledby", "game-panel-title");
      panel.hidden = true;
      document.body.appendChild(panel);
      panel.addEventListener("click", function (e) {
        if (e.target.closest("[data-game-close]")) closePanel();
        else if (e.target.closest("[data-game-save]")) save();
      });
      panel.addEventListener("change", function (e) {
        if (e.target.matches("[data-minimum-done]")) toggleMinimum(e.target.checked);
      });
      panel.addEventListener("keydown", function (e) { if (e.key === "Escape") closePanel(); });
    }
    panel.hidden = false;
    hud.setAttribute("aria-expanded", "true");
    renderPanel();
    refresh();
    var first = panel.querySelector("select, input, button");
    if (first) first.focus();
  }

  function closePanel() {
    if (!panel) return;
    panel.hidden = true;
    hud.setAttribute("aria-expanded", "false");
    hud.focus();
  }

  hud.addEventListener("click", function () {
    if (panel && !panel.hidden) closePanel(); else openPanel();
  });
  document.addEventListener("click", function (e) {
    if (panel && !panel.hidden && !panel.contains(e.target) && !hud.contains(e.target)) closePanel();
  });
  document.addEventListener("game-changed", soon);
  window.addEventListener("dcc:work-session-changed", soon);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) soon(); });
  window.setInterval(function () { if (!document.hidden) refresh(); }, 60000);

  window.DCCGameHud = { refresh: refresh, open: openPanel, close: closePanel };
  refresh();
})();
