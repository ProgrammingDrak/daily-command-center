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

  // ── legacy aliases (migration bridge) ──────────────────────────────────
  // Existing call sites keep working; consumer-migration PRs move them to
  // DCC.* and these aliases eventually retire with tag-manager/persistence.
  window.escHtml = window.escHtml || DCC.esc;
  window.showToast = window.showToast || DCC.toast;
})();
