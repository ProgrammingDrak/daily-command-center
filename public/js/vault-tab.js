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
  // The one per-type icon map. Published on window.DCC so the timeline view
  // (vault-timeline.js) reads the SAME source and the two never drift.
  const TYPE_EMOJI = {
    person: "👤", project: "🗂️", idea: "💡", note: "📝", fleeting: "💭",
    book: "📖", reading: "📚", recipe: "🍳", trip: "✈️", workout: "🏃",
    journal: "📔", goal: "🎯", campaign: "🎲", character: "🎭", moment: "📸",
    therapy: "🫂", medical: "🩺", meeting: "🗓️", habit: "🔁", media: "🎬",
    quote: "💬", event: "📅", place: "📍", money: "💰", contact: "👤",
    album: "🖼️", worknote: "🧷", doc: "📄", piece: "✍️", world: "🌍",
    session: "⚔️", budget: "💰", maintenance: "🔧", locked: "🔒", untyped: "📄",
  };
  if (window.DCC) window.DCC.vaultTypeEmoji = TYPE_EMOJI;

  // Path authoritative — mirrors CONVENTIONS.md sensitive set. Body stays hidden
  // behind a locked placeholder until B2's PIN gate.
  const SENSITIVE_PREFIXES = ["health/therapy/", "health/moments/", "health/medical/", "journal/private/"];

  let selectedSlug = null;
  let allNodes = [];         // full list from /api/vault/nodes (unfiltered)
  let activeType = "";       // from the type <select>
  const collapsed = new Set(); // folder paths the user has collapsed
  let tagColors = {};        // tag -> hex, from /api/vault/ontology
  let unmappedColor = "#9ca3af";
  let unlock = { unlocked: false, pinConfigured: false }; // sensitive PIN gate (B2), from /api/vault/status
  let viewMode = "explorer"; // "explorer" (tree + reading) | "timeline" (B4a signature)

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
    const unlockUI = unlock.pinConfigured
      ? `<form class="vault-unlock" id="vault-unlock-form">
           <input type="password" id="vault-pin" class="vault-pin-input" placeholder="PIN" inputmode="numeric" autocomplete="off">
           <button type="submit" class="vault-ed-btn primary" id="vault-unlock-go">Unlock</button>
         </form>
         <div class="vault-unlock-note">Unlocks all sensitive notes for 30 minutes, this session only.</div>`
      : `<div style="font-size:12.5px;margin-top:6px">Its contents stay locked (no PIN configured on this server).</div>`;
    el.innerHTML = `
      <div class="vault-title"><span class="emoji">🔒</span><span>${esc(title)}</span></div>
      <div class="vault-path">${esc(node.slug)}.md</div>
      <div style="padding:34px;text-align:center;border:1px dashed var(--border);border-radius:10px;color:var(--text-muted);margin-top:8px">
        <div style="font-size:30px;margin-bottom:10px">🔒</div>
        <div style="font-size:14px;color:var(--text)">This note lives in a sensitive folder.</div>
        ${unlockUI}
      </div>`;
    const form = el.querySelector("#vault-unlock-form");
    if (form) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const pin = el.querySelector("#vault-pin").value;
        await doUnlock(pin, node.slug);
      });
      setTimeout(() => { const p = el.querySelector("#vault-pin"); if (p) p.focus(); }, 20);
    }
  }

  async function doUnlock(pin, slugToOpen) {
    try {
      const r = await fetch("/api/vault/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
      if (r.status === 401) { window.DCC.toast("Incorrect PIN", "error"); return; }
      if (!r.ok) { window.DCC.toast("Unlock unavailable", "error"); return; }
      unlock.unlocked = true;
      window.DCC.toast("Sensitive notes unlocked for 30 minutes");
      loadList();
      refreshTimeline();
      if (slugToOpen) loadDetail(slugToOpen);
    } catch (e) { window.DCC.toast("Unlock failed", "error"); }
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
        bodyHtml = window.DOMPurify.sanitize(window.marked.parse(source), { ADD_ATTR: ["data-slug", "target", "data-media-hash", "data-media-alt"] });
      } catch (e) {
        bodyHtml = `<pre style="white-space:pre-wrap">${esc(node.body || "")}</pre>`;
      }
    } else if (source) {
      bodyHtml = `<pre style="white-space:pre-wrap">${esc(node.body || "")}</pre>`;
    }

    el.innerHTML = `
      <div class="vault-detail-bar"><button class="vault-edit-btn" id="vault-edit-btn" type="button" title="Edit this note">✏️ Edit</button></div>
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
    const editBtn = el.querySelector("#vault-edit-btn");
    if (editBtn && window.VaultEditor) editBtn.onclick = () => window.VaultEditor.openEdit(node);
    upgradeMedia(el, node);
    wireLinkClicks(el);
  }

  // ── Rich media (Phase B3) ──
  // Swap the server-emitted `.vault-media` placeholders for real elements, using
  // node.media (built server-side from the manifests). img/audio/video/iframe by
  // kind; cloud-only tiers that aren't provisioned yet degrade to a placeholder.
  function upgradeMedia(container, node) {
    const media = (node && node.media) || {};
    const bodyEl = container.querySelector(".vault-body-md");
    const phs = Array.from(container.querySelectorAll(".vault-media[data-media-hash]"));
    // An album node with several members flows its media as a thumbnail grid.
    if (bodyEl && phs.length > 1 && node && node.frontmatter && node.frontmatter.type === "album") {
      bodyEl.classList.add("vault-album");
    }
    phs.forEach((ph) => {
      const hex = ph.getAttribute("data-media-hash");
      const alt = ph.getAttribute("data-media-alt") || "";
      ph.replaceWith(buildMediaEl(hex, alt, media[hex]));
    });
  }

  function mediaUrl(hex, variant) {
    return `/api/vault/media/${encodeURIComponent(hex)}${variant ? "?variant=" + variant : ""}`;
  }

  function mediaPlaceholder(icon, text) {
    const d = document.createElement("div");
    d.className = "vault-media-ph";
    d.innerHTML = `<span class="ic">${icon}</span><span></span>`;
    d.lastChild.textContent = text;
    return d;
  }

  function wrapFigure(el, caption) {
    const fig = document.createElement("figure");
    fig.className = "vault-figure";
    fig.appendChild(el);
    if (caption) { const fc = document.createElement("figcaption"); fc.textContent = caption; fig.appendChild(fc); }
    return fig;
  }

  function buildMediaEl(hex, alt, meta) {
    if (!meta || meta.missing) return mediaPlaceholder("⚠️", alt || "media not found");
    if (meta.locked) return mediaPlaceholder("🔒", "locked media");
    if (!meta.available) {
      const label = alt || meta.filename || "media";
      const cloudOnly = meta.tiers && meta.tiers.cold && !meta.tiers.warm && !meta.tiers.lowres;
      return cloudOnly
        ? mediaPlaceholder("❄️", `${label} — in deep freeze (restore via CLI)`)
        : mediaPlaceholder("☁️", `${label} — stored in cloud (not yet provisioned)`);
    }
    const caption = alt && alt !== meta.filename ? alt : "";
    if (meta.kind === "image") {
      const img = document.createElement("img");
      img.className = "vault-img"; img.loading = "lazy";
      img.alt = alt || meta.filename || ""; img.src = mediaUrl(hex, "auto");
      img.addEventListener("click", () => openLightbox(mediaUrl(hex, "auto"), img.alt));
      return wrapFigure(img, caption);
    }
    if (meta.kind === "audio") {
      const a = document.createElement("audio");
      a.className = "vault-audio"; a.controls = true; a.preload = "metadata"; a.src = mediaUrl(hex, "auto");
      return wrapFigure(a, caption);
    }
    if (meta.kind === "video") {
      const t = meta.tiers || {};
      const noteEl = (text) => { const n = document.createElement("div"); n.className = "vault-media-note"; n.textContent = text; return n; };
      // Only stream when a genuinely playable tier exists (original or the R2
      // 720p derivative). A lowres-only video is a JPEG poster, not a source.
      if (t.inline || t.lfs || t.warm) {
        const v = document.createElement("video");
        v.className = "vault-video"; v.controls = true; v.preload = "metadata"; v.src = mediaUrl(hex, "auto");
        if (t.lowres) v.poster = mediaUrl(hex, "lowres");
        const fig = wrapFigure(v, caption);
        if (t.cold) fig.appendChild(noteEl("Full-res original in deep freeze; restore via CLI."));
        return fig;
      }
      const label = caption || meta.filename || "video";
      if (t.lowres) {
        const img = document.createElement("img");
        img.className = "vault-img"; img.loading = "lazy"; img.alt = label; img.src = mediaUrl(hex, "lowres");
        const fig = wrapFigure(img, caption);
        fig.appendChild(noteEl(t.cold ? "Video in deep freeze; restore via CLI to play." : "Video stored in cloud (not yet provisioned)."));
        return fig;
      }
      return mediaPlaceholder(t.cold ? "❄️" : "☁️", `${label} — ${t.cold ? "in deep freeze (restore via CLI)" : "stored in cloud (not yet provisioned)"}`);
    }
    if (meta.kind === "pdf") {
      const frame = document.createElement("iframe");
      frame.className = "vault-pdf"; frame.src = mediaUrl(hex, "auto");
      frame.setAttribute("title", alt || meta.filename || "PDF");
      const fig = wrapFigure(frame, caption);
      const dl = document.createElement("a");
      dl.className = "vault-media-dl"; dl.href = mediaUrl(hex, "original");
      dl.target = "_blank"; dl.rel = "noopener noreferrer";
      dl.textContent = `Open ${meta.filename || "PDF"} ↗`;
      fig.appendChild(dl);
      return fig;
    }
    // Generic file -> a download link.
    const a = document.createElement("a");
    a.className = "vault-file"; a.href = mediaUrl(hex, "original");
    a.target = "_blank"; a.rel = "noopener noreferrer";
    a.textContent = `📎 ${meta.filename || alt || "file"}`;
    return a;
  }

  function openLightbox(src, alt) {
    let box = document.getElementById("vault-lightbox");
    if (!box) {
      box = document.createElement("div");
      box.id = "vault-lightbox"; box.className = "vault-lightbox";
      box.addEventListener("click", closeLightbox);
      document.body.appendChild(box);
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });
    }
    box.innerHTML = "";
    const img = document.createElement("img");
    img.src = src; img.alt = alt || "";
    box.appendChild(img);
    box.style.display = "flex";
  }
  function closeLightbox() {
    const box = document.getElementById("vault-lightbox");
    if (box) { box.style.display = "none"; box.innerHTML = ""; }
  }

  // ── View mode: Explorer (tree + reading) <-> Timeline (B4a) ──
  // Timeline mode stacks the signature timeline above the SAME reading pane, so
  // clicking a dot renders that note below without leaving the timeline. CSS
  // (#vault-body.tl-mode) does the layout flip; this just toggles the class,
  // updates the segmented control, and renders the active view.
  function setView(mode) {
    viewMode = mode === "timeline" ? "timeline" : "explorer";
    const body = document.getElementById("vault-body");
    if (body) body.classList.toggle("tl-mode", viewMode === "timeline");
    document.querySelectorAll("#vault-viewtoggle .vault-vbtn").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === viewMode));
    if (viewMode === "timeline") { if (window.VaultTimeline) window.VaultTimeline.render(); }
    else renderTree();
  }

  // The timeline endpoint's payload changes on any write or unlock, so drop its
  // cache and re-render when we're looking at it.
  function refreshTimeline() {
    if (!window.VaultTimeline) return;
    window.VaultTimeline.invalidate();
    if (viewMode === "timeline") window.VaultTimeline.render();
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
      unlock.unlocked = !!data.sensitiveUnlocked;
      unlock.pinConfigured = !!data.pinConfigured;
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
    // Sensitive notes: show the locked placeholder (with the Unlock affordance)
    // unless this session is PIN-unlocked — then fetch and render like any note.
    if (isSensitive(slug) && !unlock.unlocked) {
      const cached = allNodes.find((n) => n.slug === slug) || { slug, frontmatter: {} };
      renderSensitivePlaceholder(cached);
      return;
    }
    try {
      const r = await fetch(`/api/vault/node/${encodeURIComponent(slug).replace(/%2F/g, "/")}`);
      if (r.status === 403) { // unlock expired between list and fetch
        unlock.unlocked = false;
        const cached = allNodes.find((n) => n.slug === slug) || { slug, frontmatter: {} };
        renderSensitivePlaceholder(cached);
        return;
      }
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
    if (viewMode === "timeline") refreshTimeline();
  }

  // After a write (capture/new/edit/daily): refresh list+status, then select the
  // written node. Skips the ontology reload on purpose — it's an O(all-nodes)
  // server loop and one write rarely changes the tag palette; a brand-new tag
  // shows in the unmapped gray until the next Refresh/tab-open (both reload it).
  async function afterWrite(slug) {
    await Promise.all([loadStatus(), loadList()]);
    if (slug) { selectedSlug = slug; renderTree(); loadDetail(slug); }
    refreshTimeline();
  }

  async function openDaily() {
    try {
      const r = await fetch("/api/vault/daily", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "daily note failed");
      await afterWrite(d.slug);
      window.DCC.toast(d.created ? "Created today's journal" : "Opened today's journal");
    } catch (e) { window.DCC.toast(e.message, "error"); }
  }

  const vaultTabActive = () => { const t = document.getElementById("tab-vault"); return t && t.classList.contains("active"); };

  if (window.DCC && DCC.tabs) DCC.tabs.register("vault", refreshAll);

  // ── Wiring ──
  document.addEventListener("DOMContentLoaded", function () {
    // Hand the editor its data bridge (the tab owns the node list + tag colors).
    if (window.VaultEditor) window.VaultEditor.init({
      getNodes: () => allNodes,
      getTagColors: () => tagColors,
      getUnmapped: () => unmappedColor,
      onSaved: (slug) => afterWrite(slug),
    });

    // Timeline (B4a): clicking a dot loads that note into the reading pane below.
    if (window.VaultTimeline) window.VaultTimeline.init({
      onSelect: (slug) => { selectedSlug = slug; loadDetail(slug); },
    });

    // Explorer <-> Timeline segmented control.
    document.querySelectorAll("#vault-viewtoggle .vault-vbtn").forEach((b) =>
      b.addEventListener("click", () => setView(b.dataset.view)));

    const typeFilter = document.getElementById("vault-type-filter");
    if (typeFilter) typeFilter.addEventListener("change", () => { activeType = typeFilter.value; renderTree(); });

    const captureBtn = document.getElementById("vault-capture-btn");
    if (captureBtn) captureBtn.addEventListener("click", () => window.VaultEditor && window.VaultEditor.openCapture());
    const newBtn = document.getElementById("vault-new-btn");
    if (newBtn) newBtn.addEventListener("click", () => window.VaultEditor && window.VaultEditor.openNew());
    const dailyBtn = document.getElementById("vault-daily-btn");
    if (dailyBtn) dailyBtn.addEventListener("click", openDaily);

    const refreshBtn = document.getElementById("vault-refresh-btn");
    if (refreshBtn) refreshBtn.addEventListener("click", refreshAll);

    const flushBtn = document.getElementById("vault-flush-btn");
    if (flushBtn) flushBtn.addEventListener("click", flushNow);

    // `j` opens today's journal — only inside the vault tab, not while typing or
    // with the editor open.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "j" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!vaultTabActive()) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const ov = document.getElementById("vault-editor-overlay");
      if (ov && ov.classList.contains("open")) return;
      e.preventDefault(); openDaily();
    });

    document.addEventListener("vault-changed", () => {
      loadStatus();
      loadList();
      if (selectedSlug) loadDetail(selectedSlug);
      refreshTimeline();
    });
    document.addEventListener("vault-sync-status", (e) => {
      setStatusPill((e.detail && e.detail.status) || "unknown");
    });

    // PWA share_target landed a note in inbox/ then redirected here.
    try {
      const p = new URLSearchParams(location.search);
      if (p.get("vault_share") === "ok") {
        window.DCC.toast("Shared to your vault inbox");
        const btn = document.getElementById("vault-tab-btn");
        if (btn) btn.click();
        history.replaceState(null, "", location.pathname);
      } else if (p.get("vault_share") === "err") {
        window.DCC.toast("Share failed to save", "error");
        history.replaceState(null, "", location.pathname);
      }
    } catch {}

    loadOntology().then(loadStatus).then(loadList);
  });
})();
