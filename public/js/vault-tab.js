// Vault tab (Phase 1) — read-only viewer for the markdown vault.
// Shows a list of nodes filtered by type and a detail panel with
// frontmatter + body + backlinks. Auto-refreshes on SSE vault-changed
// events so edits from Obsidian sync in live.

(function () {
  const STATUS_LABELS = {
    syncing: { text: "syncing", color: "var(--accent)" },
    synced: { text: "synced", color: "var(--green, #10b981)" },
    "local-only": { text: "local only", color: "var(--amber, #f59e0b)" },
    offline: { text: "offline", color: "var(--text-muted)" },
    "auth-expired": { text: "auth expired", color: "var(--red, #ef4444)" },
    conflict: { text: "conflict", color: "var(--red, #ef4444)" },
    disabled: { text: "local vault", color: "var(--text-muted)" },
    unknown: { text: "unknown", color: "var(--text-muted)" },
  };

  let selectedSlug = null;
  let cachedList = [];

  function escapeHtml(s) { return window.DCC.esc(s); } // delegates to core.js

  function setStatusPill(status) {
    const pill = document.getElementById("vault-status-pill");
    if (!pill) return;
    const label = STATUS_LABELS[status] || STATUS_LABELS.unknown;
    pill.textContent = label.text;
    pill.style.color = label.color;
    pill.style.borderColor = label.color;
  }

  function renderList(nodes) {
    cachedList = nodes;
    const el = document.getElementById("vault-list");
    if (!el) return;
    const badge = document.getElementById("vault-count");
    if (badge) {
      badge.textContent = nodes.length;
      badge.style.display = nodes.length > 0 ? "" : "none";
    }
    if (!nodes.length) {
      el.innerHTML = '<div style="padding:16px;color:var(--text-muted)">No nodes. Create one in Obsidian or via the API.</div>';
      return;
    }
    el.innerHTML = nodes.map((n) => {
      const fm = n.frontmatter || {};
      const title = fm.title || n.slug.split("/").pop();
      const type = fm.type || "untyped";
      const subtype = fm.subtype ? ` · ${escapeHtml(fm.subtype)}` : "";
      const when = fm.scheduled_at || fm.created || "";
      const isSelected = n.slug === selectedSlug ? "background:var(--bg-elev)" : "";
      return `<div class="vault-row" data-slug="${escapeHtml(n.slug)}" style="padding:8px 12px;border-bottom:1px solid var(--border);cursor:pointer;${isSelected}">
        <div style="font-weight:500">${escapeHtml(title)}</div>
        <div style="color:var(--text-muted);font-size:10px;margin-top:2px">${escapeHtml(type)}${subtype} ${when ? " · " + escapeHtml(String(when)) : ""}</div>
        <div style="color:var(--text-muted);font-size:10px;font-family:monospace">${escapeHtml(n.slug)}</div>
      </div>`;
    }).join("");
    el.querySelectorAll(".vault-row").forEach((row) => {
      row.addEventListener("click", () => {
        selectedSlug = row.dataset.slug;
        renderList(cachedList);
        loadDetail(selectedSlug);
      });
    });
  }

  function renderFrontmatterTable(fm) {
    const keys = Object.keys(fm || {});
    if (!keys.length) return '<div style="color:var(--text-muted)">(empty)</div>';
    return '<table style="border-collapse:collapse;width:100%;font-size:11px;margin-bottom:12px">' +
      keys.map((k) => {
        const v = fm[k];
        const display = typeof v === "object" ? JSON.stringify(v) : String(v);
        return `<tr><td style="padding:4px 8px;color:var(--text-muted);vertical-align:top;width:140px">${escapeHtml(k)}</td><td style="padding:4px 8px;font-family:monospace">${escapeHtml(display)}</td></tr>`;
      }).join("") +
      "</table>";
  }

  function renderBacklinks(backlinks) {
    if (!backlinks || !backlinks.length) return '<div style="color:var(--text-muted);font-size:11px">No backlinks yet.</div>';
    return '<ul style="margin:0;padding-left:16px;font-size:11px">' +
      backlinks.map((b) => `<li><code>${escapeHtml(b.source)}</code> <span style="color:var(--text-muted)">(${escapeHtml(b.type)})</span></li>`).join("") +
      "</ul>";
  }

  function renderOutlinks(outlinks) {
    if (!outlinks || !outlinks.length) return '<div style="color:var(--text-muted);font-size:11px">No outgoing links.</div>';
    return '<ul style="margin:0;padding-left:16px;font-size:11px">' +
      outlinks.map((l) => `<li>→ <code>${escapeHtml(l.target)}</code> <span style="color:var(--text-muted)">(${escapeHtml(l.type)})</span></li>`).join("") +
      "</ul>";
  }

  function renderDetail(node) {
    const el = document.getElementById("vault-detail");
    if (!el) return;
    if (!node) {
      el.innerHTML = '<div style="color:var(--text-muted)">Select a node from the list.</div>';
      return;
    }
    const fm = node.frontmatter || {};
    const title = fm.title || node.slug.split("/").pop();
    el.innerHTML = `
      <div style="margin-bottom:8px;font-size:14px;font-weight:600">${escapeHtml(title)}</div>
      <div style="color:var(--text-muted);font-family:monospace;font-size:10px;margin-bottom:12px">${escapeHtml(node.slug)}.md</div>

      <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">FRONTMATTER</div>
      ${renderFrontmatterTable(fm)}

      <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">BODY</div>
      <pre style="background:var(--bg-elev);padding:8px;border-radius:4px;white-space:pre-wrap;font-size:11px;max-height:300px;overflow-y:auto">${escapeHtml(node.body || "")}</pre>

      <div style="display:flex;gap:16px;margin-top:12px">
        <div style="flex:1">
          <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">BACKLINKS (${(node.backlinks || []).length})</div>
          ${renderBacklinks(node.backlinks)}
        </div>
        <div style="flex:1">
          <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">OUTLINKS (${(node.outlinks || []).length})</div>
          ${renderOutlinks(node.outlinks)}
        </div>
      </div>
    `;
  }

  async function loadStatus() {
    try {
      const r = await fetch("/api/vault/status");
      if (!r.ok) throw new Error("status " + r.status);
      const data = await r.json();
      setStatusPill((data.sync && data.sync.status) || "unknown");
      const summary = document.getElementById("vault-summary");
      if (summary) {
        const v = data.vault || {};
        if (v.totalNodes != null) {
          summary.textContent = `${v.totalNodes} nodes · ${v.totalEdges} edges`;
        } else {
          summary.textContent = "vault not ready";
        }
      }
    } catch (e) {
      setStatusPill("unknown");
    }
  }

  async function loadList() {
    const typeFilter = document.getElementById("vault-type-filter");
    const type = typeFilter ? typeFilter.value : "";
    const url = type ? `/api/vault/nodes?type=${encodeURIComponent(type)}` : "/api/vault/nodes";
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error("list " + r.status);
      const nodes = await r.json();
      renderList(nodes);
    } catch (e) {
      const el = document.getElementById("vault-list");
      if (el) el.innerHTML = `<div style="padding:16px;color:var(--red, #ef4444)">Error: ${escapeHtml(e.message)}</div>`;
    }
  }

  async function loadDetail(slug) {
    if (!slug) { renderDetail(null); return; }
    try {
      const r = await fetch(`/api/vault/node/${encodeURIComponent(slug).replace(/%2F/g, "/")}`);
      if (r.status === 404) { renderDetail(null); return; }
      if (!r.ok) throw new Error("detail " + r.status);
      const node = await r.json();
      renderDetail(node);
    } catch (e) {
      const el = document.getElementById("vault-detail");
      if (el) el.innerHTML = `<div style="color:var(--red, #ef4444)">Error: ${escapeHtml(e.message)}</div>`;
    }
  }

  async function flushNow() {
    try {
      const r = await fetch("/api/vault/flush", { method: "POST" });
      const data = await r.json();
      setStatusPill((data && data.status) || "unknown");
    } catch (e) {
      setStatusPill("offline");
    }
  }

  function refreshAll() {
    loadStatus();
    loadList();
    if (selectedSlug) loadDetail(selectedSlug);
  }

  // ── Wiring ──
  document.addEventListener("DOMContentLoaded", function () {
    const btn = document.getElementById("vault-tab-btn");
    if (btn) btn.addEventListener("click", refreshAll);

    const typeFilter = document.getElementById("vault-type-filter");
    if (typeFilter) typeFilter.addEventListener("change", loadList);

    const refreshBtn = document.getElementById("vault-refresh-btn");
    if (refreshBtn) refreshBtn.addEventListener("click", refreshAll);

    const flushBtn = document.getElementById("vault-flush-btn");
    if (flushBtn) flushBtn.addEventListener("click", flushNow);

    // SSE updates
    document.addEventListener("vault-changed", (e) => {
      loadList();
      if (selectedSlug && e.detail && e.detail.slug === selectedSlug) loadDetail(selectedSlug);
    });
    document.addEventListener("vault-sync-status", (e) => {
      setStatusPill((e.detail && e.detail.status) || "unknown");
    });

    // Initial fetch so the badge reflects node count even before first tab click
    loadStatus();
    loadList();
  });
})();
