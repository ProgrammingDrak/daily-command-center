// core.js — the shared frontend core. Loaded FIRST in index.html so every
// other script can rely on window.DCC at parse time (the old escHtml lived in
// tag-manager.js, loaded AFTER half its would-be consumers — that ordering
// hazard is why ~15 files grew their own copies).
//
// Convention (see ARCHITECTURE.md "Frontend conventions"): common helpers live
// HERE on the DCC namespace, following the urgency.js single-source pattern.
// Never reimplement these per tab. Adding a helper? It needs 2+ real consumers.
//
// Pure additive module: defines window.DCC and (for migration) keeps the
// legacy global aliases pointing at the canonical implementations.
(function () {
  "use strict";

  const DCC = (window.DCC = window.DCC || {});

  // ── esc ────────────────────────────────────────────────────────────────
  // Canonical HTML-escaper (all five entities; null/undefined -> "").
  // Strict superset of every per-file esc()/gbEsc() copy.
  DCC.esc = function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  // ── icons ──────────────────────────────────────────────────────────────
  // Inline SVG glyphs shared by more than one surface. The calendar was copied
  // verbatim into schedule-tab.js and itinerary-card.js, and the catch-up modals
  // wanted a third — the point at which a duplicated string becomes a drift
  // hazard. One copy, here, where every file can read it at parse time.
  DCC.icons = {
    calendar: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>'
  };

  // ── safeUrl ────────────────────────────────────────────────────────────
  // Scheme-allowlist for URLs that came from OUTSIDE the app (sweep packets,
  // meeting artifacts): anything not http(s)/mailto renders as no link at all,
  // so a javascript: href can never reach an anchor. Was a local const in
  // triage.js's card builder; the catch-up modal renders the same sweep URLs.
  // .trim() so this is a true superset of the per-file copies it is meant to absorb
  // (glymphatic-brief.js's gbSafeUrl trims, because its refs are reconstructed from
  // comms and arrive with leading whitespace); without it, repointing that copy would
  // silently stop rendering links that render today.
  DCC.safeUrl = function safeUrl(u) {
    u = String(u == null ? "" : u).trim();
    return /^(https?:|mailto:)/i.test(u) ? u : "";
  };

  // Allowlist AND attribute-escape in one call. safeUrl only checks the scheme, so a
  // swept URL like `https://x.test/a" onmouseover="alert(1)` passes it and then breaks
  // out of the href it is interpolated into. Two call sites disagreeing about whose job
  // the escaping is, is exactly the drift consolidating this was meant to prevent, so
  // the safe form is the one with the short name.
  DCC.safeUrlAttr = function safeUrlAttr(u) { return DCC.esc(DCC.safeUrl(u)); };

  // ── dateButtonHtml ─────────────────────────────────────────────────────
  // Markup for the row-level calendar button, in the same class the itinerary
  // rows use so it inherits their hover/tooltip styling. Built as a string
  // because callers assemble whole rows via innerHTML; wire it up after with
  // DCC.wireDateButton.
  DCC.dateButtonHtml = function dateButtonHtml(cls, label) {
    label = DCC.esc(label || "Pick a day");
    return '<button class="btn-schedule ' + DCC.esc(cls || "") + '" data-tooltip="' + label +
      '" aria-label="' + label + '">' + DCC.icons.calendar + '</button>';
  };

  // ── wireDateButton ─────────────────────────────────────────────────────
  // The calendar button on a row: click -> the shared anchored day picker
  // (schedule-popover.js). Rows in the catch-up modals are not entries in
  // scheduled[], so mode "reschedule" would silently bail — they go through the
  // "pick" contract and own the write, exactly like delegated.js's follow-ups.
  // opts: {header, actionLabel, onPick(dateStr)}.
  DCC.wireDateButton = function wireDateButton(btn, opts) {
    if (!btn || !opts || typeof btn.addEventListener !== "function") return;
    btn.addEventListener("click", function (e) {
      if (e && typeof e.stopPropagation === "function") e.stopPropagation();
      if (typeof window.openDatePickPopover !== "function") return;
      window.openDatePickPopover(btn, {
        header: opts.header || "Move to…",
        actionLabel: opts.actionLabel || "Move",
        onPick: opts.onPick
      });
    });
  };

  // ── api ────────────────────────────────────────────────────────────────
  // Fetch wrapper: JSON in/out, normalized errors. Superset of the per-tab
  // api() clones (todo-share/punishments/slots/pet-home differed only in the
  // fallback error string — pass {errorLabel} for that).
  DCC.api = async function api(path, opts = {}) {
    const { errorLabel, ...fetchOpts } = opts;
    if (fetchOpts.body && typeof fetchOpts.body !== "string") {
      fetchOpts.body = JSON.stringify(fetchOpts.body);
      fetchOpts.headers = { "Content-Type": "application/json", ...(fetchOpts.headers || {}) };
    }
    const res = await fetch(path, fetchOpts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || errorLabel || "Request failed");
    return data;
  };

  // ── toast ──────────────────────────────────────────────────────────────
  // The real implementation (moved from persistence.js, which now forwards
  // here). Collapses the 7 per-file `toast()` shims.
  DCC.toast = function toast(message, type = "error", duration = 5000, action = null) {
    if (duration && typeof duration === "object") {
      action = duration;
      duration = 5000;
    }
    const container = document.getElementById("toast-container");
    if (!container) return;
    const el = document.createElement("div");
    el.className = "toast toast--" + type;
    const text = document.createElement("span");
    text.textContent = message;
    el.appendChild(text);
    if (action && typeof action.onClick === "function") {
      const actionBtn = document.createElement("button");
      actionBtn.type = "button";
      actionBtn.className = "toast-action";
      actionBtn.textContent = action.label || "Undo";
      actionBtn.addEventListener("click", () => {
        el.remove();
        action.onClick();
      });
      el.appendChild(actionBtn);
    }
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "toast-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => el.remove());
    el.appendChild(closeBtn);
    container.appendChild(el);
    if (duration > 0) setTimeout(() => el.remove(), duration);
  };

  // ── dates ──────────────────────────────────────────────────────────────
  // Only helpers that had 2+ independent copies.
  DCC.dates = {
    // App-local "today" key: prefers the boot-derived __todayDate (server
    // timezone) over the browser clock, same as the day-review copy.
    todayKey() {
      return (typeof window.__todayDate === "string" && window.__todayDate)
        || new Date().toISOString().slice(0, 10);
    },
    // "HH:MM" (24h) -> "h:MM am/pm"; passes through anything unparseable.
    fmtTime(value) {
      if (!value) return "";
      const m = String(value).match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return value;
      let h = Number(m[1]);
      const ampm = h >= 12 ? "pm" : "am";
      h = h % 12 || 12;
      return h + ":" + m[2] + " " + ampm;
    },
    // ISO timestamp -> "3h ago" / "just now".
    timeAgo(iso) {
      try {
        const ms = Date.now() - new Date(iso).getTime();
        const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
        if (d > 0) return d + "d ago";
        if (h > 0) return h + "h ago";
        if (m > 0) return m + "m ago";
        return "just now";
      } catch {
        return "";
      }
    },
    // "YYYY-MM-DD" +/- n days -> "YYYY-MM-DD" (UTC-noon anchor avoids DST edges).
    addDays(dateStr, n) {
      const d = new Date(dateStr + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    },
  };

  // ── updateBadge ────────────────────────────────────────────────────────
  // Count badge: set text (99+ cap), hide at zero. Lifted from features.js
  // _setSmallTaskBadge; also duplicated in engrams.js and delegated.js.
  DCC.updateBadge = function updateBadge(id, count) {
    const badge = typeof id === "string" ? document.getElementById(id) : id;
    if (!badge) return;
    badge.textContent = count > 99 ? "99+" : String(count || 0);
    badge.style.display = count ? "" : "none";
  };

  // Number fields often use zero as their empty calculation value. When a
  // person starts typing, replace that zero instead of appending to it.
  function isReplaceableZeroNumberInput(target) {
    return Boolean(
      target &&
      target.tagName === "INPUT" &&
      target.type === "number" &&
      !target.disabled &&
      !target.readOnly &&
      !target.hasAttribute("data-keep-leading-zero") &&
      String(target.value).trim() !== "" &&
      Number(target.value) === 0
    );
  }

  function selectZeroNumberInput(target) {
    if (!isReplaceableZeroNumberInput(target)) return;
    try { target.select(); } catch (_) {}
  }

  document.addEventListener("focusin", function (event) {
    selectZeroNumberInput(event.target);
  });
  document.addEventListener("pointerup", function (event) {
    selectZeroNumberInput(event.target);
  });
  document.addEventListener("beforeinput", function (event) {
    if (!String(event.inputType || "").startsWith("insert")) return;
    if (isReplaceableZeroNumberInput(event.target)) event.target.value = "";
  });

  // ── legacy aliases (migration bridge) ──────────────────────────────────
  // Existing call sites keep working; consumer-migration PRs move them to
  // DCC.* and these aliases eventually retire with tag-manager/persistence.
  window.escHtml = window.escHtml || DCC.esc;
  window.showToast = window.showToast || DCC.toast;
})();
