// ======== SHARED TIME / DATE PICKER ========
// ONE picker for the whole app. iOS-style scroll-wheel for times, a clean month
// grid for dates. Everything else in the app talks to it two ways:
//
//   1. openTimeWheel(value, anchor, onPick, opts)  -> "HH:MM" 24h in / out
//      openDateCal  (value, anchor, onPick, opts)  -> "YYYY-MM-DD" in / out
//
//   2. Auto-enhancement: every <input type="time"> and <input type="date"> in
//      the DOM (now or added later) is transparently upgraded to open this
//      picker. The original element is preserved as a hidden input so existing
//      code that reads `.value` or listens for `change`/`input` keeps working
//      unchanged. Opt out with data-tw-skip; suppress the visible button (when
//      an external control is the trigger) with data-tw-trigger="hidden".
//
// Time format is canonical "HH:MM" (24h) everywhere, matching pt()/fmt()/f12()
// in state.js. There is no second copy of this logic anywhere in the app.
(function () {
  "use strict";

  var ITEM_H = 40;          // px per wheel row
  var VISIBLE = 5;          // rows visible in a column (odd -> one centered)
  var PAD = ((VISIBLE - 1) / 2) * ITEM_H;

  // --- format helpers (reuse the app's canonical ones when present) ----------
  function toMinutes(v) {
    if (typeof pt === "function") return pt(v);
    var m = String(v || "").match(/(\d{1,2}):(\d{2})/);
    return m ? (+m[1]) * 60 + (+m[2]) : 0;
  }
  function toHHMM(mins) {
    if (typeof fmt === "function") return fmt(((mins % 1440) + 1440) % 1440);
    mins = ((mins % 1440) + 1440) % 1440;
    return String(Math.floor(mins / 60)).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0");
  }
  function label12(hhmm) {
    if (typeof f12 === "function") return f12(hhmm);
    var mins = toMinutes(hhmm), h = Math.floor(mins / 60) % 24, m = mins % 60;
    return (h % 12 || 12) + ":" + String(m).padStart(2, "0") + " " + (h >= 12 ? "PM" : "AM");
  }

  // --- shared overlay --------------------------------------------------------
  var overlay = null, card = null, onClose = null;
  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "tw-overlay";
    card = document.createElement("div");
    card.className = "tw-pop";
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && overlay.classList.contains("open")) close();
    });
    card.addEventListener("click", function (e) { e.stopPropagation(); });
  }
  function position(anchor) {
    // Mobile / no anchor -> bottom sheet. Desktop -> float near the anchor.
    var sheet = window.innerWidth <= 560 || !anchor;
    card.classList.toggle("sheet", sheet);
    if (sheet) { card.style.left = ""; card.style.top = ""; return; }
    var r = anchor.getBoundingClientRect();
    // Measure after paint, then clamp into the viewport.
    requestAnimationFrame(function () {
      var w = card.offsetWidth, h = card.offsetHeight, M = 8;
      var left = Math.min(Math.max(M, r.left), window.innerWidth - w - M);
      var top = r.bottom + 6;
      if (top + h > window.innerHeight - M) top = Math.max(M, r.top - h - 6);
      card.style.left = left + "px";
      card.style.top = top + "px";
    });
  }
  function open(anchor, closeCb) {
    ensureOverlay();
    onClose = closeCb || null;
    overlay.classList.add("open");
    position(anchor);
  }
  function close() {
    if (!overlay) return;
    overlay.classList.remove("open");
    var cb = onClose; onClose = null;
    if (cb) cb();
  }

  // --- one scroll-wheel column ----------------------------------------------
  // values: array of {label, v}. Returns an object exposing the selected index.
  function makeColumn(values, selectedIdx, onSettle) {
    var col = document.createElement("div");
    col.className = "tw-col";
    col.tabIndex = 0;
    var inner = document.createElement("div");
    inner.className = "tw-col-inner";
    values.forEach(function (item, i) {
      var opt = document.createElement("div");
      opt.className = "tw-opt";
      opt.textContent = item.label;
      opt.addEventListener("click", function () { go(i, true); });
      inner.appendChild(opt);
    });
    col.appendChild(inner);

    var current = selectedIdx;
    function paint() {
      var kids = inner.children;
      for (var i = 0; i < kids.length; i++) kids[i].classList.toggle("sel", i === current);
    }
    function go(i, smooth) {
      i = Math.max(0, Math.min(values.length - 1, i));
      col.scrollTo({ top: i * ITEM_H, behavior: smooth ? "smooth" : "auto" });
    }
    var settleT = null;
    col.addEventListener("scroll", function () {
      if (settleT) clearTimeout(settleT);
      settleT = setTimeout(function () {
        var i = Math.round(col.scrollTop / ITEM_H);
        i = Math.max(0, Math.min(values.length - 1, i));
        if (i !== current) { current = i; paint(); if (onSettle) onSettle(values[i].v, i); }
      }, 90);
    });
    col.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); go(current + 1, true); }
      else if (e.key === "ArrowUp") { e.preventDefault(); go(current - 1, true); }
    });

    paint();
    // Initial scroll position (no smooth) once laid out.
    requestAnimationFrame(function () { col.scrollTop = current * ITEM_H; });

    return {
      el: col,
      get value() { return values[current].v; },
      get index() { return current; },
      set: function (i) { current = i; paint(); go(i, false); }
    };
  }

  // --- TIME WHEEL ------------------------------------------------------------
  function openTimeWheel(value, anchor, onPick, opts) {
    opts = opts || {};
    var step = opts.minuteStep || 1;
    ensureOverlay();
    card.className = "tw-pop tw-time";

    var mins = toMinutes(value || "09:00");
    var h24 = Math.floor(mins / 60) % 24, mm = mins % 60;
    mm = Math.round(mm / step) * step; if (mm > 59) mm = 60 - step;
    var h12 = h24 % 12 || 12, isPM = h24 >= 12;

    var hours = [], minutes = [], ampm = [{ label: "AM", v: 0 }, { label: "PM", v: 1 }];
    for (var h = 1; h <= 12; h++) hours.push({ label: String(h), v: h });
    for (var m = 0; m < 60; m += step) minutes.push({ label: String(m).padStart(2, "0"), v: m });

    var head = document.createElement("div");
    head.className = "tw-head";

    function compute() {
      var hv = colH.value, mv = colM.value, pm = colA.value === 1;
      var hr = pm ? (hv === 12 ? 12 : hv + 12) : (hv === 12 ? 0 : hv);
      return toHHMM(hr * 60 + mv);
    }
    function refreshHead() { head.textContent = label12(compute()); }

    var wheels = document.createElement("div");
    wheels.className = "tw-wheels";
    var colH = makeColumn(hours, h12 - 1, refreshHead);
    var colon = document.createElement("div"); colon.className = "tw-colon"; colon.textContent = ":";
    var colM = makeColumn(minutes, Math.round(mm / step), refreshHead);
    var colA = makeColumn(ampm, isPM ? 1 : 0, refreshHead);
    wheels.appendChild(colH.el); wheels.appendChild(colon);
    wheels.appendChild(colM.el); wheels.appendChild(colA.el);

    var band = document.createElement("div"); band.className = "tw-band";
    wheels.appendChild(band);

    var actions = document.createElement("div");
    actions.className = "tw-actions";
    var nowBtn = document.createElement("button");
    nowBtn.type = "button"; nowBtn.className = "tw-now"; nowBtn.textContent = "Now";
    nowBtn.addEventListener("click", function () {
      var d = new Date(), nh = d.getHours(), nm = d.getMinutes();
      nm = Math.round(nm / step) * step; if (nm > 59) nm = 60 - step;
      colH.set((nh % 12 || 12) - 1); colM.set(Math.round(nm / step)); colA.set(nh >= 12 ? 1 : 0);
      setTimeout(refreshHead, 120);
    });
    var spacer = document.createElement("div"); spacer.style.flex = "1";
    var cancel = document.createElement("button");
    cancel.type = "button"; cancel.className = "tw-btn"; cancel.textContent = "Cancel";
    cancel.addEventListener("click", close);
    var ok = document.createElement("button");
    ok.type = "button"; ok.className = "tw-btn tw-btn-primary"; ok.textContent = "Set";
    ok.addEventListener("click", function () {
      var v = compute();
      close();
      if (onPick) onPick(v);
    });
    actions.appendChild(nowBtn); actions.appendChild(spacer);
    actions.appendChild(cancel); actions.appendChild(ok);

    card.innerHTML = "";
    card.appendChild(head); card.appendChild(wheels); card.appendChild(actions);
    refreshHead();
    open(anchor);
  }

  // --- DATE CALENDAR ---------------------------------------------------------
  function pad2(n) { return String(n).padStart(2, "0"); }
  function isoOf(y, m, d) { return y + "-" + pad2(m + 1) + "-" + pad2(d); }
  function parseISO(s) {
    var m = String(s || "").match(/(\d{4})-(\d{2})-(\d{2})/);
    var d = new Date();
    if (m) return { y: +m[1], m: +m[2] - 1, d: +m[3] };
    return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() };
  }
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];
  var DOW = ["S", "M", "T", "W", "T", "F", "S"];

  function openDateCal(value, anchor, onPick, opts) {
    opts = opts || {};
    ensureOverlay();
    card.className = "tw-pop tw-cal";

    var sel = parseISO(value);
    var now = new Date();
    var todayISO = isoOf(now.getFullYear(), now.getMonth(), now.getDate());
    var view = { y: sel.y, m: sel.m };
    var selISO = isoOf(sel.y, sel.m, sel.d);

    function render() {
      card.innerHTML = "";
      var head = document.createElement("div");
      head.className = "tw-cal-head";
      var prev = document.createElement("button");
      prev.type = "button"; prev.className = "tw-cal-nav"; prev.innerHTML = "&lsaquo;";
      prev.addEventListener("click", function () { view.m--; if (view.m < 0) { view.m = 11; view.y--; } render(); });
      var title = document.createElement("div");
      title.className = "tw-cal-title"; title.textContent = MONTHS[view.m] + " " + view.y;
      var next = document.createElement("button");
      next.type = "button"; next.className = "tw-cal-nav"; next.innerHTML = "&rsaquo;";
      next.addEventListener("click", function () { view.m++; if (view.m > 11) { view.m = 0; view.y++; } render(); });
      head.appendChild(prev); head.appendChild(title); head.appendChild(next);

      var dow = document.createElement("div");
      dow.className = "tw-cal-dow";
      DOW.forEach(function (d) { var s = document.createElement("span"); s.textContent = d; dow.appendChild(s); });

      var grid = document.createElement("div");
      grid.className = "tw-cal-grid";
      var first = new Date(view.y, view.m, 1).getDay();
      var days = new Date(view.y, view.m + 1, 0).getDate();
      for (var i = 0; i < first; i++) grid.appendChild(document.createElement("span"));
      for (var d = 1; d <= days; d++) {
        (function (day) {
          var iso = isoOf(view.y, view.m, day);
          var cell = document.createElement("button");
          cell.type = "button";
          cell.className = "tw-cal-day" + (iso === selISO ? " sel" : "") + (iso === todayISO ? " today" : "");
          cell.textContent = day;
          cell.addEventListener("click", function () { close(); if (onPick) onPick(iso); });
          grid.appendChild(cell);
        })(d);
      }

      var actions = document.createElement("div");
      actions.className = "tw-actions";
      var todayBtn = document.createElement("button");
      todayBtn.type = "button"; todayBtn.className = "tw-now"; todayBtn.textContent = "Today";
      todayBtn.addEventListener("click", function () { close(); if (onPick) onPick(todayISO); });
      var spacer = document.createElement("div"); spacer.style.flex = "1";
      var cancel = document.createElement("button");
      cancel.type = "button"; cancel.className = "tw-btn"; cancel.textContent = "Cancel";
      cancel.addEventListener("click", close);
      actions.appendChild(todayBtn); actions.appendChild(spacer); actions.appendChild(cancel);

      card.appendChild(head); card.appendChild(dow); card.appendChild(grid); card.appendChild(actions);
    }
    render();
    open(anchor);
  }

  // --- auto-enhancement of native inputs -------------------------------------
  function prettyDate(iso) {
    var p = parseISO(iso);
    var d = new Date(p.y, p.m, p.d);
    return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  }
  function enhance(input) {
    if (input.__tw || input.hasAttribute("data-tw-skip")) return;
    var isDate = input.type === "date";
    input.__tw = true;
    var ph = input.getAttribute("placeholder") || (isDate ? "Pick a date" : "Set time");
    var hiddenTrigger = input.getAttribute("data-tw-trigger") === "hidden";

    // Preserve the element (and its id/classes/value) as a hidden field so all
    // existing `.value` reads and change listeners keep working untouched.
    input.type = "hidden";

    var btn = null;
    if (!hiddenTrigger) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tw-field" + (isDate ? " tw-field-date" : " tw-field-time");
      input.parentNode.insertBefore(btn, input.nextSibling);
      btn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); input.__twOpen(); });
    }

    input.__twRender = function () {
      if (!btn) return;
      var v = input.value;
      btn.textContent = v ? (isDate ? prettyDate(v) : label12(v)) : ph;
      btn.classList.toggle("tw-empty", !v);
    };
    input.__twOpen = function (anchorOverride) {
      var open = isDate ? openDateCal : openTimeWheel;
      open(input.value || (isDate ? "" : "09:00"), anchorOverride || btn || input, function (v) {
        input.value = v;
        input.__twRender();
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };
    input.__twRender();
  }
  function scan(root) {
    (root || document).querySelectorAll('input[type="time"],input[type="date"]').forEach(enhance);
  }
  function boot() {
    scan(document);
    var mo = new MutationObserver(function (muts) {
      muts.forEach(function (mut) {
        mut.addedNodes.forEach(function (n) {
          if (n.nodeType !== 1) return;
          if (n.matches && n.matches('input[type="time"],input[type="date"]')) enhance(n);
          else if (n.querySelectorAll) scan(n);
        });
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // --- public API ------------------------------------------------------------
  window.openTimeWheel = openTimeWheel;
  window.openDateCal = openDateCal;
  window.TimePicker = { openTime: openTimeWheel, openDate: openDateCal, enhance: enhance, scan: scan, close: close };
})();
