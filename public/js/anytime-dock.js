// anytime-dock.js — the Anytime surface: a corner pill that expands into a
// checklist of work with no time inside it.
//
// NON-MODAL ON PURPOSE, and the reason is load-bearing: features.js
// `_anyModalOpen()` makes `render()` defer app-wide while any of six overlay
// classes is `.open`. A persistent panel reusing one of those class names would
// freeze every surface in the app for as long as it stayed open. Every class
// here is `.anytime-*`, and the shape is copied from `.feedback-panel`, the one
// existing panel that is deliberately backdrop-free.
//
// The model lives in anytime-store.js. This file only renders it and writes
// through it, so the window and streak math stays testable with no DOM.
(function () {
  "use strict";

  // ── the one design knob ──
  // Which collapsed-pill treatment the dock wears. Four were built and compared
  // side by side; "capsule" won because it shows the actual fraction, which is
  // the number that matters at a glance, while staying under 90px.
  // Swap for "ring" | "pips" | "bar" and the CSS follows. One line.
  const DOCK_STYLE = "capsule";

  const DCC = (window.DCC = window.DCC || {});
  const esc = () => DCC.esc;

  const CK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>';
  const PENCIL_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
  const CLOCK_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

  let _open = false;
  let _pulsing = false;

  function A() { return DCC.Anytime || null; }
  function dockEl() { return document.getElementById("anytime-dock"); }
  function panelEl() { return document.getElementById("anytime-panel"); }

  // ── labels ──

  function periodLabel(mins) {
    if (mins >= 1440) return "Today";
    if (mins === 60) return "This hour";
    if (mins === 30) return "This half hour";
    if (mins % 60 === 0) return "Every " + (mins / 60) + "h";
    return "Every " + mins + " min";
  }
  function fmtClock(minutes) {
    const a = A();
    return DCC.dates ? DCC.dates.fmtTime(a.hhmm(minutes)) : a.hhmm(minutes);
  }
  function fmtGap(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    if (m < 60) return m + "m";
    const h = Math.floor(m / 60);
    return h + "h" + (m % 60 ? " " + (m % 60) + "m" : "");
  }

  // ── the view model ──
  // One place derives everything both the pill and the panel need, so the two
  // can never disagree about what is due.
  function viewModel() {
    const a = A();
    if (!a || typeof a.list !== "function") return null;
    const defs = a.list();
    if (!defs.length) return { defs: [], rows: [], open: 0, lead: null, nudging: false };
    const ctx = a.context();
    // Roll shut anything that lapsed while this tab slept, then read back.
    const settled = a.settle(defs, ctx);
    const state = a.readState();

    const rows = settled.map(s => {
      const def = s.def;
      const entry = a.readEntry(state, def.id);
      const progress = a.progressFor(def, entry, s.windowKey);
      const resetMin = a.windowResetMinutes(def, ctx.minutesOfDay, ctx.dayStartMin);
      const active = a.isActiveAt(def, ctx.minutesOfDay, ctx.dowIndex);
      let nudgeIn = null;
      if (def.nudgeEveryMin && !progress.done && active) {
        const stamped = entry.lastNudgeAt ? Date.parse(entry.lastNudgeAt) : NaN;
        const anchor = Math.max(a.windowStartMs(def, ctx), Number.isFinite(stamped) ? stamped : 0);
        nudgeIn = anchor + def.nudgeEveryMin * 60000 - ctx.nowMs;
      }
      return {
        def: def, entry: entry, progress: progress, windowKey: s.windowKey,
        resetMin: resetMin, active: active, nudgeIn: nudgeIn,
        streak: a.streakFrom(def.history, ctx.todayStr),
        due: a.nudgeDue(def, entry, ctx)
      };
    });

    const openRows = rows.filter(r => !r.progress.done && r.active);
    // The pill speaks for one item: whatever is being nudged, else whatever is
    // furthest from its target.
    const lead = openRows.slice().sort((x, y) =>
      (y.due - x.due) || (y.progress.remaining - x.progress.remaining))[0] || rows[0] || null;
    return {
      defs: defs, rows: rows, ctx: ctx,
      open: openRows.length,
      lead: lead,
      nudging: rows.some(r => r.due)
    };
  }

  // ── the collapsed pill ──

  function renderDock(vm) {
    const el = dockEl();
    if (!el) return;
    const e = esc();
    // Nobody who has never made an anytime task should see corner chrome.
    if (!vm || !vm.defs.length) { el.style.display = "none"; el.innerHTML = ""; return; }
    el.style.display = "";
    el.className = "anytime-dock anytime-dock--" + DOCK_STYLE
      + (vm.nudging || _pulsing ? " nudging" : "")
      + (vm.open === 0 ? " done" : "")
      + (_open ? " panel-open" : "");

    const lead = vm.lead;
    const p = lead ? lead.progress : { n: 0, target: 1 };
    const pct = p.target ? Math.min(1, p.n / p.target) : 0;
    el.style.setProperty("--anytime-p", String(pct));
    const glyph = (lead && lead.def.icon) || "○";
    const badge = vm.open > 1
      ? '<span class="anytime-dock-badge">' + vm.open + "</span>" : "";
    const pips = lead && lead.def.target <= 8
      ? Array.from({ length: lead.def.target }, (_, i) =>
          '<i class="anytime-pip' + (i < p.n ? " on" : "") + '"></i>').join("")
      : "";

    el.innerHTML =
      '<span class="anytime-dock-ring" aria-hidden="true"></span>' +
      '<span class="anytime-dock-top">' +
        '<span class="anytime-dock-glyph" aria-hidden="true">' + e(glyph) + "</span>" +
        '<span class="anytime-dock-frac">' + p.n + "/" + p.target + "</span>" +
      "</span>" +
      '<span class="anytime-dock-pips" aria-hidden="true">' + pips + "</span>" +
      '<span class="anytime-dock-track" aria-hidden="true"><span class="anytime-dock-fill"></span></span>' +
      badge;

    const label = vm.open === 0
      ? "Anytime tasks, all done"
      : (vm.open + " anytime task" + (vm.open === 1 ? "" : "s") + " open"
         + (lead ? ": " + lead.def.title + " " + p.n + " of " + p.target : ""));
    el.setAttribute("aria-label", label);
    el.setAttribute("aria-expanded", _open ? "true" : "false");
    el.setAttribute("title", label);
  }

  // ── the expanded panel ──

  function rowHtml(r) {
    const e = esc();
    const d = r.def, p = r.progress;
    const stepper = d.target > 1
      ? '<button type="button" class="anytime-step anytime-minus" data-act="minus"' +
          (p.n > 0 ? "" : " disabled") + ' aria-label="One less">&minus;</button>' +
        '<button type="button" class="anytime-step anytime-plus" data-act="plus"' +
          (p.done ? " disabled" : "") + ' aria-label="One more">+</button>'
      : "";
    const streak = r.streak > 0
      ? '<span class="anytime-chip anytime-streak" title="' + r.streak +
        ' day streak">🔥 ' + r.streak + "</span>" : "";
    // A finished row says nothing about nudges: it is done, and the cadence is no
    // longer information the reader needs.
    let hint = "";
    if (p.done) hint = "";
    else if (!r.active) hint = "Off right now";
    else if (r.nudgeIn != null) hint = r.nudgeIn <= 0 ? "Nudging" : "Nudge in " + fmtGap(r.nudgeIn);
    else if (!d.nudgeEveryMin) hint = "No nudge";

    return '<div class="anytime-row' + (p.done ? " is-done" : "") +
        (r.active ? "" : " is-off") + '" data-id="' + e(d.id) + '">' +
      '<button type="button" class="chk anytime-chk' + (p.done ? " on" : "") +
        '" data-act="chk" aria-pressed="' + (p.done ? "true" : "false") +
        '" aria-label="' + e(d.title) + ', ' + p.n + " of " + p.target + '">' + CK_SVG + "</button>" +
      '<span class="anytime-row-glyph" aria-hidden="true">' + e(d.icon || "") + "</span>" +
      '<span class="anytime-row-main">' +
        '<span class="anytime-row-title">' + e(d.title) + "</span>" +
        (hint ? '<span class="anytime-row-hint">' + CLOCK_SVG + "<span>" + e(hint) + "</span></span>" : "") +
      "</span>" +
      streak +
      '<span class="anytime-row-count">' + p.n + "/" + p.target +
        (d.unit ? ' <em>' + e(d.unit) + "</em>" : "") + "</span>" +
      stepper +
      '<button type="button" class="anytime-icon-btn" data-act="edit" aria-label="Edit ' +
        e(d.title) + '">' + PENCIL_SVG + "</button>" +
      "</div>";
  }

  function groupHtml(vm) {
    const e = esc();
    // Group by window length so a header can name one reset time honestly.
    const buckets = new Map();
    vm.rows.forEach(r => {
      const key = r.def.periodMinutes;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(r);
    });
    // Longest window first: the day frames the hour, not the other way round.
    return [...buckets.keys()].sort((a, b) => b - a).map(mins => {
      const rows = buckets.get(mins);
      const reset = rows[0].resetMin;
      const head = periodLabel(mins) +
        (reset == null ? "" : ' <em>resets ' + e(fmtClock(reset)) + "</em>");
      const hit = rows.filter(r => r.progress.done).length;
      // "0/1" next to a row reading "0/3" reads as a second target fraction. This
      // is a rows-done count, so it says done, and only when there is more than
      // one row for it to summarise.
      const count = rows.length > 1
        ? '<span class="anytime-group-count">' + hit + " of " + rows.length + " done</span>"
        : "";
      return '<div class="anytime-group">' +
        '<div class="anytime-group-head"><span>' + head + "</span>" + count + "</div>" +
        rows.map(rowHtml).join("") + "</div>";
    }).join("");
  }

  function renderPanel(vm) {
    const el = panelEl();
    if (!el) return;
    const body = el.querySelector(".anytime-panel-body");
    if (!body) return;
    if (!vm || !vm.rows.length) {
      body.innerHTML = '<div class="anytime-empty">Nothing here yet.<br>' +
        "Anytime tasks have a target but no time: three bottles of water today, " +
        "a hundred pushups this hour.</div>";
      return;
    }
    body.innerHTML = groupHtml(vm);
  }

  // ── render ──

  let _vm = null;
  // `opts.preserveFocus` is the per-minute tick saying "refresh the numbers, but
  // not at the cost of yanking focus out of a checklist someone is working".
  function buildAnytime(opts) {
    try {
      _vm = viewModel();
      renderDock(_vm);
      const panel = panelEl();
      const focusInside = !!(opts && opts.preserveFocus && panel
        && document.activeElement && panel.contains(document.activeElement));
      if (_open && !focusInside) renderPanel(_vm);
    } catch (err) {
      // A broken dock must never take the itinerary down with it.
      console.warn("[anytime] render failed:", err && err.message ? err.message : err);
    }
  }

  // ── open / close ──

  function openPanel() {
    const el = panelEl();
    if (!el || _open) return;
    _open = true;
    buildAnytime();
    el.classList.add("open");
    el.setAttribute("aria-hidden", "false");
    const dock = dockEl();
    if (dock) dock.setAttribute("aria-expanded", "true");
    const first = el.querySelector(".anytime-chk, .anytime-add-title");
    if (first && first.focus) setTimeout(() => first.focus(), 0);
  }
  function closePanel(restoreFocus) {
    const el = panelEl();
    if (!el || !_open) return;
    _open = false;
    el.classList.remove("open");
    el.setAttribute("aria-hidden", "true");
    const dock = dockEl();
    if (dock) {
      dock.setAttribute("aria-expanded", "false");
      dock.classList.remove("panel-open");
      if (restoreFocus && dock.focus) dock.focus();
    }
  }
  function togglePanel() { if (_open) closePanel(true); else openPanel(); }

  // Opened from the nudge, so the pulse has served its purpose.
  function openFromNudge() { setPulse(false); openPanel(); }

  function setPulse(on) {
    _pulsing = !!on;
    const el = dockEl();
    if (el) el.classList.toggle("nudging", !!on || !!(_vm && _vm.nudging));
  }

  // Where the pet should stop. Falls back to the corner when the dock is hidden.
  function anchorPoint() {
    const el = dockEl();
    if (el && el.style.display !== "none" && typeof el.getBoundingClientRect === "function") {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return { x: window.innerWidth - 90, y: window.innerHeight - 90 };
  }

  // ── the add / edit form ──

  function formBody(def) {
    const a = A(), e = esc();
    const d = def || a.normalizeDef({ properties: { title: "", periodMinutes: 1440 } });
    const periods = a.PERIOD_CHOICES.map(p =>
      '<option value="' + p + '"' + (p === d.periodMinutes ? " selected" : "") + ">" +
      e(periodLabel(p).replace(/^This /, "Every ").replace(/^Today$/, "Once a day")) + "</option>").join("");
    const nudges = [0, 15, 20, 30, 45, 60, 90, 120, 180, 240].map(n =>
      '<option value="' + n + '"' + ((d.nudgeEveryMin || 0) === n ? " selected" : "") + ">" +
      (n === 0 ? "Never" : "Every " + fmtGap(n * 60000)) + "</option>").join("");
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, i) =>
      '<label class="anytime-day"><input type="checkbox" class="anytime-f-day" value="' + i + '"' +
      (d.activeDays.indexOf(i) !== -1 ? " checked" : "") + "><span>" + label + "</span></label>").join("");

    return '<div class="anytime-form">' +
      '<label class="anytime-field anytime-field--grow"><span>What</span>' +
        '<input type="text" class="anytime-f-title anytime-add-title" maxlength="80" placeholder="Drink water" value="' + e(d.title) + '"></label>' +
      '<label class="anytime-field anytime-field--tiny"><span>Icon</span>' +
        '<input type="text" class="anytime-f-icon" maxlength="4" placeholder="💧" value="' + e(d.icon) + '"></label>' +
      '<label class="anytime-field anytime-field--tiny"><span>How many</span>' +
        '<input type="number" class="anytime-f-target" min="1" max="99" value="' + d.target + '"></label>' +
      '<label class="anytime-field"><span>Unit</span>' +
        '<input type="text" class="anytime-f-unit" maxlength="24" placeholder="bottles" value="' + e(d.unit) + '"></label>' +
      '<label class="anytime-field"><span>Window</span><select class="anytime-f-period">' + periods + "</select></label>" +
      '<label class="anytime-field"><span>Nudge me</span><select class="anytime-f-nudge">' + nudges + "</select></label>" +
      '<label class="anytime-field"><span>Not before</span>' +
        '<input type="time" class="anytime-f-from" value="' + (d.activeFrom == null ? "" : e(a.hhmm(d.activeFrom))) + '"></label>' +
      '<label class="anytime-field"><span>Not after</span>' +
        '<input type="time" class="anytime-f-until" value="' + (d.activeUntil == null ? "" : e(a.hhmm(d.activeUntil))) + '"></label>' +
      '<div class="anytime-field anytime-field--full"><span>Days (none means every day)</span>' +
        '<div class="anytime-days">' + days + "</div></div>" +
      "</div>";
  }

  function readForm(root) {
    const val = sel => { const el = root.querySelector(sel); return el ? el.value : ""; };
    const days = [...root.querySelectorAll(".anytime-f-day")]
      .filter(cb => cb.checked).map(cb => Number(cb.value));
    return {
      title: val(".anytime-f-title"),
      icon: val(".anytime-f-icon"),
      unit: val(".anytime-f-unit"),
      target: Number(val(".anytime-f-target")) || 1,
      periodMinutes: Number(val(".anytime-f-period")) || 1440,
      nudgeEveryMin: Number(val(".anytime-f-nudge")) || null,
      activeFrom: val(".anytime-f-from") || null,
      activeUntil: val(".anytime-f-until") || null,
      activeDays: days
    };
  }

  function openForm(def) {
    const a = A();
    if (!a || typeof DCC.modal !== "function") return;
    let handle = null;
    const actions = [{
      label: def ? "Save" : "Add",
      kind: "primary",
      onClick: () => {
        const patch = readForm(handle.el);
        if (!String(patch.title || "").trim()) {
          DCC.toast("Give it a name first", "error", 3000);
          return false;   // keeps the form open
        }
        const p = def ? a.update(def.id, patch) : a.create(patch);
        p.then(() => buildAnytime())
         .catch(err => DCC.toast(err && err.message ? err.message : "That did not save", "error"));
        return true;
      }
    }];
    if (def) {
      actions.unshift({
        label: "Delete",
        onClick: () => {
          a.remove(def.id).then(() => buildAnytime())
            .catch(err => DCC.toast(err && err.message ? err.message : "That did not delete", "error"));
          return true;
        }
      });
    }
    handle = DCC.modal({
      title: def ? "Edit anytime task" : "New anytime task",
      body: formBody(def),
      actions: actions
    });
  }

  // ── wiring ──

  function onRowClick(ev) {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    const row = btn.closest(".anytime-row");
    if (!row) return;
    const a = A();
    const id = row.getAttribute("data-id");
    const entry = _vm && _vm.rows.filter(r => r.def.id === id)[0];
    if (!a || !entry) return;
    if (!a.onTodayView()) {
      DCC.toast("Switch back to today to check these off", "info", 4000);
      return;
    }
    const act = btn.getAttribute("data-act");
    if (act === "edit") { openForm(entry.def); return; }
    // A one-target row is an ordinary checkbox: click on, click off. A
    // multi-target row counts up, and the minus button is how you step back, so
    // one stray click never wipes three bottles of water.
    let delta = 1;
    if (act === "minus") delta = -1;
    else if (act === "chk" && entry.progress.done) delta = entry.def.target === 1 ? -1 : 0;
    if (!delta) return;
    a.check(entry.def, delta);
    buildAnytime();
  }

  function wire() {
    const dock = dockEl(), panel = panelEl();
    if (dock) {
      dock.addEventListener("click", () => { setPulse(false); togglePanel(); });
    }
    if (panel) {
      panel.addEventListener("click", onRowClick);
      const close = panel.querySelector(".anytime-panel-close");
      if (close) close.addEventListener("click", () => closePanel(true));
      const add = panel.querySelector(".anytime-panel-add");
      if (add) add.addEventListener("click", () => openForm(null));
    }
    document.addEventListener("keydown", ev => {
      // Only claim Escape when nothing louder is on screen.
      if (ev.key !== "Escape" || !_open) return;
      if (document.querySelector(".dcc-overlay.open")) return;
      closePanel(true);
    });
    window.addEventListener("dcc:data-ready", buildAnytime);
    document.addEventListener("blocks-changed", buildAnytime);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { wire(); buildAnytime(); });
  } else { wire(); buildAnytime(); }

  window.buildAnytime = buildAnytime;
  window.dccOpenAnytime = openFromNudge;
  window.dccCloseAnytime = closePanel;
  DCC.AnytimeDock = {
    build: buildAnytime,
    open: openFromNudge,
    close: closePanel,
    toggle: togglePanel,
    anchorPoint: anchorPoint,
    setPulse: setPulse,
    isOpen: () => _open,
    viewModel: () => _vm,
    DOCK_STYLE: DOCK_STYLE
  };
})();
