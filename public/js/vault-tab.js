// Mycelium vault tab (Phase B1) — read-only viewer for the markdown vault.
//
// Obsidian-style: a collapsible folder tree (explorer) on the left, a Notion-
// style reading pane on the right — big title, a Properties block, rendered
// markdown (marked + DOMPurify) with click-through [[wikilinks]], soft-tinted
// ontology tag pills, and an Obsidian "Linked mentions" panel with context
// snippets. Auto-refreshes on SSE vault-changed so Obsidian edits sync in live.
// Nodes under the four sensitive dirs render a locked placeholder (PIN in B2).

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

  // Notion-style per-type icon. Sensitive nodes always show the lock.
  const TYPE_EMOJI = {
    person: "👤", project: "🗂️", idea: "💡", note: "📝", fleeting: "💭",
    book: "📖", reading: "📚", recipe: "🍳", trip: "✈️", workout: "🏃",
    journal: "📔", goal: "🎯", campaign: "🎲", character: "🎭", moment: "📸",
    therapy: "🫂", medical: "🩺", meeting: "🗓️", habit: "🔁", media: "🎬",
    quote: "💬", event: "📅", place: "📍", money: "💰", contact: "👤",
    untyped: "📄",
  };

  // Path authoritative — mirrors CONVENTIONS.md sensitive set. Body stays hidden
  // behind a locked placeholder until B2's PIN gate.
  const SENSITIVE_PREFIXES = ["health/therapy/", "health/moments/", "health/medical/", "journal/private/"];

  let selectedSlug = null;
  let allNodes = [];         // full list from /api/vault/nodes (unfiltered)
  let activeType = "";       // from the type <select>
  const collapsed = new Set(); // folder paths the user has collapsed
  let tagColors = {};        // tag -> hex, from /api/vault/ontology
  let unmappedColor = "#9ca3af";

  const esc = (s) => window.DCC.esc(s); // delegates to core.js
  const isSensitive = (slug) => SENSITIVE_PREFIXES.some((p) => (slug + "/").startsWith(p) || slug.startsWith(p));
  const typeOf = (n) => (n.frontmatter && n.frontmatter.type) || "untyped";
  const emojiFor = (n) => (isSensitive(n.slug) ? "🔒" : (TYPE_EMOJI[typeOf(n)] || "📄"));
  const titleOf = (n) => (n.frontmatter && n.frontmatter.title) || n.slug.split("/").pop();

  function setStatusPill(status) {
    const pill = document.getElementById("vault-status-pill");
    if (!pill) return;
    const label = STATUS_LABELS[status] || STATUS_LABELS.unknown;
    pill.textContent = label.text;
    pill.style.color = label.color;
    pill.style.borderColor = label.color;
  }

  // ── Explorer: folder tree ──

  function buildTree(nodes) {
    const root = { name: "", path: "", folders: new Map(), files: [] };
    for (const n of nodes) {
      const parts = n.slug.split("/");
      const file = parts.pop();
      let cur = root, acc = "";
      for (const p of parts) {
        acc = acc ? acc + "/" + p : p;
        if (!cur.folders.has(p)) cur.folders.set(p, { name: p, path: acc, folders: new Map(), files: [] });
        cur = cur.folders.get(p);
      }
      cur.files.push({ node: n, name: file });
    }
    return root;
  }

  function renderTreeNode(node, depth) {
    let html = "";
    const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const f of folders) {
      const isCollapsed = collapsed.has(f.path);
      const pad = 8 + depth * 14;
      html += `<div class="vtree-row vtree-folder" data-folder="${esc(f.path)}" style="padding-left:${pad}px">
        <span class="vtree-chevron${isCollapsed ? " collapsed" : ""}">▶</span>
        <span class="vtree-label">${esc(f.name)}</span>
      </div>`;
      if (!isCollapsed) html += renderTreeNode(f, depth + 1);
    }
    const files = node.files.slice().sort((a, b) => titleOf(a.node).localeCompare(titleOf(b.node)));
    for (const f of files) {
      const pad = 8 + depth * 14 + 14; // align past the chevron column
      const active = f.node.slug === selectedSlug ? " active" : "";
      html += `<div class="vtree-row vtree-file${active}" data-slug="${esc(f.node.slug)}" style="padding-left:${pad}px" title="${esc(f.node.slug)}">
        <span class="vtree-emoji">${emojiFor(f.node)}</span>
        <span class="vtree-label">${esc(titleOf(f.node))}</span>
      </div>`;
    }
    return html;
  }

  function renderTree() {
    const el = document.getElementById("vault-tree");
    if (!el) return;
    const nodes = allNodes.filter((n) => !activeType || typeOf(n) === activeType);
    if (!nodes.length) {
      el.innerHTML = '<div style="padding:14px;color:var(--text-muted);font-size:12px">No notes match.</div>';
      return;
    }
    el.innerHTML = renderTreeNode(buildTree(nodes), 0);
    el.querySelectorAll(".vtree-folder").forEach((row) => {
      row.addEventListener("click", () => {
        const p = row.dataset.folder;
        if (collapsed.has(p)) collapsed.delete(p); else collapsed.add(p);
        renderTree();
      });
    });
    el.querySelectorAll(".vtree-file").forEach((row) => {
      row.addEventListener("click", () => { selectedSlug = row.dataset.slug; renderTree(); loadDetail(selectedSlug); });
    });
  }

  function populateTypeFilter() {
    const sel = document.getElementById("vault-type-filter");
    if (!sel) return;
    const types = Array.from(new Set(allNodes.map(typeOf))).sort();
    const current = sel.value;
    sel.innerHTML = '<option value="">All types</option>' +
      types.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
    // Keep activeType in lockstep with the control. If the selected type's last
    // node vanished (e.g. an SSE refresh after a delete), the option is gone;
    // reset BOTH the dropdown and activeType, or renderTree would keep filtering
    // by the stale type and show an empty tree while the control reads "All types".
    if (types.includes(current)) {
      sel.value = current;
    } else {
      sel.value = "";
      activeType = "";
    }
  }

  // ── Reading pane ──

  function tagPills(tags) {
    const list = Array.isArray(tags) ? tags : tags ? [tags] : [];
    if (!list.length) return "";
    return `<div class="vault-tags">` + list.map((t) => {
      const color = tagColors[t] || unmappedColor;
      return `<span class="vault-tag" style="background:${esc(color)}22;color:${esc(color)}">${esc(t)}</span>`;
    }).join("") + `</div>`;
  }

  function propsBlock(fm) {
    const keys = Object.keys(fm || {}).filter((k) => !["title", "tags", "_parseError"].includes(k));
    const fmt = (v) => {
      if (Array.isArray(v)) return v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
      if (v && typeof v === "object") return Object.entries(v).map(([k, x]) => `${k}: ${x}`).join(" · ");
      return String(v);
    };
    const rows = keys.map((k) => {
      const v = fm[k];
      if (v == null || v === "") return "";
      return `<div class="vault-prop"><span class="k">${esc(k)}</span><span class="v">${esc(fmt(v))}</span></div>`;
    }).filter(Boolean).join("");
    return rows ? `<div class="vault-props">${rows}</div>` : "";
  }

  function renderBacklinks(backlinks) {
    if (!backlinks || !backlinks.length) return '<div style="color:var(--text-muted);font-size:13px">No linked mentions yet.</div>';
    return backlinks.map((b) => {
      const ctx = b.context;
      const ctxHtml = ctx && ctx.text
        ? `<div class="ctx">${ctx.field ? `<em>${esc(ctx.field)}:</em> ` : ""}${esc(ctx.text)}</div>`
        : "";
      const label = titleForSlug(b.source);
      return `<div class="vault-bl"><span class="src" data-slug="${esc(b.source)}">${esc(label)}</span>${ctxHtml}</div>`;
    }).join("");
  }

  function renderOutlinks(outlinks) {
    if (!outlinks || !outlinks.length) return '<div style="color:var(--text-muted);font-size:13px">No outgoing links.</div>';
    return outlinks.map((l) => {
      const exists = allNodes.some((n) => n.slug === l.target);
      const label = exists ? titleForSlug(l.target) : l.target;
      const inner = exists
        ? `<span class="src" data-slug="${esc(l.target)}">${esc(label)}</span>`
        : `<span class="dead">${esc(label)}</span>`;
      return `<div class="vault-outlink">${inner} <span style="color:var(--text-muted);font-size:11px">(${esc(l.type)})</span></div>`;
    }).join("");
  }

  function titleForSlug(slug) {
    const n = allNodes.find((x) => x.slug === slug);
    return n ? titleOf(n) : slug;
  }

  function wireLinkClicks(container) {
    if (!container) return;
    container.querySelectorAll("a.wikilink:not(.dangling), .src[data-slug]").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const slug = a.dataset.slug;
        if (!slug) return;
        selectedSlug = slug;
        renderTree();
        loadDetail(slug);
      });
    });
    container.querySelectorAll('a[href^="http"]').forEach((a) => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
  }

  function renderSensitivePlaceholder(node) {
    const el = document.getElementById("vault-detail");
    if (!el) return;
    const fm = (node && node.frontmatter) || {};
    const title = fm.title || (node && node.slug ? node.slug.split("/").pop() : "Locked");
    el.innerHTML = `
      <div class="vault-title"><span class="emoji">🔒</span><span>${esc(title)}</span></div>
      <div class="vault-path">${esc(node.slug)}.md</div>
      <div style="padding:34px;text-align:center;border:1px dashed var(--border);border-radius:10px;color:var(--text-muted);margin-top:8px">
        <div style="font-size:30px;margin-bottom:10px">🔒</div>
        <div style="font-size:14px;color:var(--text)">This note lives in a sensitive folder.</div>
        <div style="font-size:12.5px;margin-top:6px">Its contents stay locked. Unlock arrives in a later phase.</div>
      </div>`;
  }

  function renderDetail(node) {
    const el = document.getElementById("vault-detail");
    if (!el) return;
    if (!node) { el.innerHTML = '<div class="vault-empty">Select a note from the explorer.</div>'; return; }
    const fm = node.frontmatter || {};
    const title = fm.title || node.slug.split("/").pop();

    let bodyHtml = '<div style="color:var(--text-muted)">(empty)</div>';
    const source = node.renderedBody != null ? node.renderedBody : node.body;
    if (source && window.marked && window.DOMPurify) {
      try {
        bodyHtml = window.DOMPurify.sanitize(window.marked.parse(source), { ADD_ATTR: ["data-slug", "target"] });
      } catch (e) {
        bodyHtml = `<pre style="white-space:pre-wrap">${esc(node.body || "")}</pre>`;
      }
    } else if (source) {
      bodyHtml = `<pre style="white-space:pre-wrap">${esc(node.body || "")}</pre>`;
    }

    el.innerHTML = `
      <div class="vault-title"><span class="emoji">${emojiFor(node)}</span><span>${esc(title)}</span></div>
      <div class="vault-path">${esc(node.slug)}.md</div>
      ${tagPills(fm.tags)}
      ${propsBlock(fm)}
      <div class="vault-body-md">${bodyHtml}</div>
      <hr class="vault-hr">
      <div class="vault-section-h">Linked mentions (${(node.backlinks || []).length})</div>
      ${renderBacklinks(node.backlinks)}
      <div class="vault-section-h">Outgoing links (${(node.outlinks || []).length})</div>
      ${renderOutlinks(node.outlinks)}
    `;
    wireLinkClicks(el);
  }

  // ── Data loading ──

  async function loadOntology() {
    try {
      const r = await fetch("/api/vault/ontology");
      if (!r.ok) return;
      const data = await r.json();
      tagColors = data.tagColors || {};
      if (data.unmapped) unmappedColor = data.unmapped;
    } catch (e) { /* colors are best-effort */ }
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
        summary.textContent = v.totalNodes != null ? `${v.totalNodes} notes · ${v.totalEdges} links` : "vault not ready";
      }
    } catch (e) { setStatusPill("unknown"); }
  }

  async function loadList() {
    try {
      const r = await fetch("/api/vault/nodes");
      if (!r.ok) throw new Error("list " + r.status);
      allNodes = await r.json();
      populateTypeFilter();
      renderTree();
    } catch (e) {
      const el = document.getElementById("vault-tree");
      if (el) el.innerHTML = `<div style="padding:14px;color:var(--red, #ef4444)">Error: ${esc(e.message)}</div>`;
    }
  }

  async function loadDetail(slug) {
    if (!slug) { renderDetail(null); return; }
    if (isSensitive(slug)) {
      const cached = allNodes.find((n) => n.slug === slug) || { slug, frontmatter: {} };
      renderSensitivePlaceholder(cached);
      return;
    }
    try {
      const r = await fetch(`/api/vault/node/${encodeURIComponent(slug).replace(/%2F/g, "/")}`);
      if (r.status === 404) { renderDetail(null); return; }
      if (!r.ok) throw new Error("detail " + r.status);
      renderDetail(await r.json());
    } catch (e) {
      const el = document.getElementById("vault-detail");
      if (el) el.innerHTML = `<div style="color:var(--red, #ef4444)">Error: ${esc(e.message)}</div>`;
    }
  }

  async function flushNow() {
    try {
      const r = await fetch("/api/vault/flush", { method: "POST" });
      const data = await r.json();
      setStatusPill((data && data.status) || "unknown");
    } catch (e) { setStatusPill("offline"); }
  }

  async function refreshAll() {
    await loadOntology();
    await Promise.all([loadStatus(), loadList()]);
    if (selectedSlug) loadDetail(selectedSlug);
  }

  if (window.DCC && DCC.tabs) DCC.tabs.register("vault", refreshAll);

  // ── Wiring ──
  document.addEventListener("DOMContentLoaded", function () {
    const typeFilter = document.getElementById("vault-type-filter");
    if (typeFilter) typeFilter.addEventListener("change", () => { activeType = typeFilter.value; renderTree(); });

    const refreshBtn = document.getElementById("vault-refresh-btn");
    if (refreshBtn) refreshBtn.addEventListener("click", refreshAll);

    const flushBtn = document.getElementById("vault-flush-btn");
    if (flushBtn) flushBtn.addEventListener("click", flushNow);

    document.addEventListener("vault-changed", () => {
      loadStatus();
      loadList();
      if (selectedSlug) loadDetail(selectedSlug);
    });
    document.addEventListener("vault-sync-status", (e) => {
      setStatusPill((e.detail && e.detail.status) || "unknown");
    });

    loadOntology().then(loadStatus).then(loadList);
  });
})();
