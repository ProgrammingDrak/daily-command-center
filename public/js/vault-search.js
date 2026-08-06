// Mycelium vault — search, quick-switcher, saved views, orphans (Phase B5).
//
// One module over the server's pure-JS MiniSearch index (routes/vault.js):
//   • the header search box -> a results dropdown (full-text, infinite-scroll);
//   • ⌘K / Ctrl-K -> a quick-switcher overlay (title/alias jump) that works from
//     ANY tab and switches to the Mycelium tab on open;
//   • saved-view chips persisted in the repo (.mycelium/views.json), plus a
//     built-in "Today + recent" default;
//   • an Orphans chip listing link-less notes.
//
// The tab (vault-tab.js) owns node state + the view surfaces, so it hands us a
// small bridge: openSlug (switch tab + open a note), captureView / applyView
// (current explorer/timeline state), and esc. All sensitivity gating is enforced
// server-side (a locked session's index never returns sensitive rows), so this
// module renders whatever the endpoints return without a second guess.

(function () {
  let B = null;                 // bridge from vault-tab
  const esc = (s) => (B && B.esc ? B.esc(s) : String(s == null ? "" : s));

  // Built-in default view — always first, not deletable. Its chip opens a live
  // most-recently-modified list (today's edits sort to the top), rendered in the
  // results dropdown; it is NOT an explorer/timeline surface, so it's handled
  // specially (see the chip wiring), not through applyView.
  const DEFAULT_VIEW = { id: "__default", name: "Today + recent", icon: "🕑", builtin: true };
  let savedViews = [];          // from /api/vault/views (user views only)

  // ── Search box + results dropdown ──
  let searchSeq = 0;            // guards out-of-order responses
  let curQuery = "";
  let curOffset = 0, curTotal = 0, curLoading = false, curMode = "search";

  function els() {
    return {
      input: document.getElementById("vault-search-input"),
      clear: document.getElementById("vault-search-clear"),
      results: document.getElementById("vault-search-results"),
      views: document.getElementById("vault-views"),
    };
  }

  function debounce(fn, ms) {
    let t;
    return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
  }

  function hideResults() {
    const { results } = els();
    if (results) { results.hidden = true; results.innerHTML = ""; }
    curMode = "search";
  }

  function rowHtml(r) {
    const emoji = r.sensitive ? "🔒" : ((window.DCC && window.DCC.vaultTypeEmoji && window.DCC.vaultTypeEmoji[r.type]) || "📄");
    // Snippet AND summary arrive HTML-escaped from the server; inject as-is (no
    // re-escape, or you get visible &amp;quot; in the UI).
    //
    // The summary leads when there is one: the snippet tells you WHERE your term
    // matched, the summary tells you whether the note is worth opening at all. Both
    // show when both exist, summary first, because that is the reading order that
    // answers "is this the one?" fastest.
    const sum = r.summary ? `<div class="vault-sr-sum">${r.summary}</div>` : "";
    const snip = r.snippet ? `<div class="vault-sr-snip">${r.snippet}</div>` : "";
    return `<div class="vault-sr-row" data-slug="${esc(r.slug)}" role="option" tabindex="-1">
      <span class="vault-sr-emoji">${emoji}</span>
      <span class="vault-sr-main">
        <span class="vault-sr-title">${esc(r.title)}</span>
        <span class="vault-sr-path">${esc(r.slug)}</span>
        ${sum}
        ${snip}
      </span>
    </div>`;
  }

  function wireRows(container) {
    container.querySelectorAll(".vault-sr-row").forEach((row) => {
      row.addEventListener("click", () => {
        const slug = row.dataset.slug;
        hideResults();
        const { input } = els();
        if (input) input.blur();
        if (B && B.openSlug) B.openSlug(slug);
      });
    });
  }

  async function runSearch(reset) {
    const { input, results } = els();
    if (!input || !results) return;
    const q = input.value.trim();
    if (!q) { hideResults(); return; }
    if (reset) { curQuery = q; curOffset = 0; curTotal = 0; curMode = "search"; }
    if (curLoading) return;
    curLoading = true;
    const seq = ++searchSeq;
    try {
      const r = await fetch(`/api/vault/search?q=${encodeURIComponent(q)}&limit=20&offset=${curOffset}`);
      const data = await r.json();
      if (seq !== searchSeq) return; // a newer query already fired
      curTotal = data.total || 0;
      results.hidden = false;
      const rowsHtml = (data.results || []).map(rowHtml).join("");
      if (reset) {
        const head = `<div class="vault-sr-head">${curTotal} match${curTotal === 1 ? "" : "es"}${data.tookMs != null ? ` · ${data.tookMs}ms` : ""}</div>`;
        results.innerHTML = head + (rowsHtml || `<div class="vault-sr-empty">No notes match “${esc(q)}”.</div>`);
      } else {
        results.insertAdjacentHTML("beforeend", rowsHtml);
      }
      wireRows(results);
      curOffset += (data.results || []).length;
    } catch (e) {
      results.hidden = false;
      results.innerHTML = `<div class="vault-sr-empty">Search error.</div>`;
    } finally {
      curLoading = false;
    }
  }

  // Infinite scroll: fetch the next page when the dropdown nears its bottom.
  // Dispatches by the active dropdown mode (search vs recent; orphans is single-shot).
  function onResultsScroll(e) {
    const el = e.target;
    if (curLoading || curOffset >= curTotal) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) {
      if (curMode === "search") runSearch(false);
      else if (curMode === "recent") showRecent(false);
    }
  }

  // ── Recent notes ("Today + recent" default view) ──
  // Most-recently-modified first (server list() is mtime-desc), paginated so the
  // dropdown infinite-scrolls like search. Reuses the results dropdown + rows.
  async function showRecent(reset) {
    const { results, input } = els();
    if (!results) return;
    if (reset) { if (input) input.value = ""; curMode = "recent"; curOffset = 0; curTotal = 0; }
    if (curLoading) return;
    curLoading = true;
    try {
      const r = await fetch(`/api/vault/recent?limit=20&offset=${curOffset}`);
      const data = await r.json();
      curTotal = data.total || 0;
      results.hidden = false;
      const rows = (data.results || []).map((n) => rowHtml({ slug: n.slug, title: n.title, type: n.type, sensitive: n.sensitive, snippet: "" })).join("");
      if (reset) {
        results.innerHTML = `<div class="vault-sr-head">Recent · ${curTotal} note${curTotal === 1 ? "" : "s"}</div>` +
          (rows || `<div class="vault-sr-empty">No notes yet.</div>`);
      } else {
        results.insertAdjacentHTML("beforeend", rows);
      }
      wireRows(results);
      curOffset += (data.results || []).length;
    } catch (e) {
      results.hidden = false;
      results.innerHTML = `<div class="vault-sr-empty">Could not load recent notes.</div>`;
    } finally {
      curLoading = false;
    }
  }

  // ── Orphans (reuses the results dropdown as a node list) ──
  async function showOrphans() {
    const { results, input } = els();
    if (!results) return;
    if (input) input.value = "";
    curMode = "orphans";
    results.hidden = false;
    results.innerHTML = `<div class="vault-sr-head">Loading orphans…</div>`;
    try {
      const r = await fetch("/api/vault/orphans");
      const data = await r.json();
      const list = data.orphans || [];
      const head = `<div class="vault-sr-head">${list.length} orphan${list.length === 1 ? "" : "s"} · no links in or out</div>`;
      results.innerHTML = head + (list.length
        ? list.map((o) => rowHtml({ slug: o.slug, title: o.title, type: o.type, sensitive: o.sensitive, snippet: "" })).join("")
        : `<div class="vault-sr-empty">No orphans — every note is connected. 🎉</div>`);
      wireRows(results);
    } catch (e) {
      results.innerHTML = `<div class="vault-sr-empty">Could not load orphans.</div>`;
    }
  }

  // ── Quick-switcher (⌘K) ──
  let swItems = [];
  let swActive = -1;
  let swSeq = 0;

  function switcherEls() {
    return {
      overlay: document.getElementById("vault-switcher-overlay"),
      input: document.getElementById("vault-switcher-input"),
      results: document.getElementById("vault-switcher-results"),
    };
  }

  function openSwitcher() {
    const { overlay, input, results } = switcherEls();
    if (!overlay) return;
    overlay.hidden = false;
    swItems = []; swActive = -1;
    if (results) results.innerHTML = `<div class="vault-sw-hint">Type to jump. ↑↓ to move, ↵ to open, Esc to close.</div>`;
    if (input) { input.value = ""; setTimeout(() => input.focus(), 10); }
  }
  function closeSwitcher() {
    const { overlay } = switcherEls();
    if (overlay) overlay.hidden = true;
    swItems = []; swActive = -1;
  }
  function switcherOpen() { const o = document.getElementById("vault-switcher-overlay"); return o && !o.hidden; }

  function renderSwitcher() {
    const { results } = switcherEls();
    if (!results) return;
    if (!swItems.length) { results.innerHTML = `<div class="vault-sw-hint">No matches.</div>`; return; }
    results.innerHTML = swItems.map((r, i) => {
      const emoji = r.sensitive ? "🔒" : ((window.DCC && window.DCC.vaultTypeEmoji && window.DCC.vaultTypeEmoji[r.type]) || "📄");
      return `<div class="vault-sw-row${i === swActive ? " active" : ""}" data-i="${i}" role="option">
        <span class="vault-sw-emoji">${emoji}</span>
        <span class="vault-sw-title">${esc(r.title)}</span>
        <span class="vault-sw-path">${esc(r.slug)}</span>
      </div>`;
    }).join("");
    results.querySelectorAll(".vault-sw-row").forEach((row) => {
      row.addEventListener("click", () => openIndex(parseInt(row.dataset.i, 10)));
      row.addEventListener("mousemove", () => { swActive = parseInt(row.dataset.i, 10); paintActive(); });
    });
  }
  function paintActive() {
    const { results } = switcherEls();
    if (!results) return;
    results.querySelectorAll(".vault-sw-row").forEach((row, i) => row.classList.toggle("active", i === swActive));
    const active = results.querySelector(".vault-sw-row.active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }
  function openIndex(i) {
    const r = swItems[i];
    if (!r) return;
    closeSwitcher();
    if (B && B.openSlug) B.openSlug(r.slug);
  }

  const runSwitcher = debounce(async function () {
    const { input } = switcherEls();
    if (!input) return;
    const q = input.value.trim();
    if (!q) { swItems = []; swActive = -1; renderSwitcher(); return; }
    const seq = ++swSeq;
    try {
      const r = await fetch(`/api/vault/search?q=${encodeURIComponent(q)}&mode=title&limit=12`);
      const data = await r.json();
      if (seq !== swSeq) return;
      swItems = data.results || [];
      swActive = swItems.length ? 0 : -1;
      renderSwitcher();
    } catch (e) { /* leave prior list */ }
  }, 90);

  // ── Saved views ──
  function allViews() { return [DEFAULT_VIEW, ...savedViews]; }

  function renderViews() {
    const { views } = els();
    if (!views) return;
    views.innerHTML = allViews().map((v) => {
      const del = v.builtin ? "" : `<span class="vault-chip-x" data-del="${esc(v.id)}" title="Delete view">×</span>`;
      const icon = v.icon ? `<span class="vault-chip-icon">${esc(v.icon)}</span>` : "";
      const tip = v.builtin ? "Recent notes" : `${esc(v.surface)} · double-click to rename`;
      return `<span class="vault-chip vault-view-chip" data-view="${esc(v.id)}" title="${tip}">${icon}<span class="vault-chip-label">${esc(v.name)}</span>${del}</span>`;
    }).join("");
    views.querySelectorAll(".vault-view-chip").forEach((chip) => {
      chip.addEventListener("click", (e) => {
        if (e.target.classList.contains("vault-chip-x")) return;
        // The built-in default opens the live recent-notes list, not a surface.
        if (chip.dataset.view === "__default") showRecent(true);
        else applyViewById(chip.dataset.view);
      });
      chip.addEventListener("dblclick", () => renameView(chip.dataset.view));
    });
    views.querySelectorAll(".vault-chip-x").forEach((x) =>
      x.addEventListener("click", (e) => { e.stopPropagation(); deleteView(x.dataset.del); }));
  }

  function applyViewById(id) {
    const v = allViews().find((x) => x.id === id);
    if (v && B && B.applyView) B.applyView(v);
  }

  async function loadViews() {
    try {
      const r = await fetch("/api/vault/views");
      const data = await r.json();
      savedViews = (data.views || []).filter((v) => v && v.name);
    } catch { savedViews = []; }
    renderViews();
  }

  async function putViews() {
    try {
      const r = await fetch("/api/vault/views", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ views: savedViews }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "save failed");
      savedViews = data.views || savedViews;
      renderViews();
      return true;
    } catch (e) {
      if (window.DCC) window.DCC.toast("Could not save view", "error");
      return false;
    }
  }

  function saveCurrentView() {
    if (!B || !B.captureView) return;
    const name = (window.prompt("Name this view:") || "").trim();
    if (!name) return;
    const snap = B.captureView();
    savedViews.push({ name: name.slice(0, 60), icon: "", surface: snap.surface, query: snap.query || {}, sort: snap.sort || "" });
    putViews().then((ok) => { if (ok && window.DCC) window.DCC.toast(`Saved view “${name}”`); });
  }

  function renameView(id) {
    const v = savedViews.find((x) => x.id === id);
    if (!v) return; // builtin/default not renamable
    const name = (window.prompt("Rename view:", v.name) || "").trim();
    if (!name) return;
    v.name = name.slice(0, 60);
    putViews();
  }

  function deleteView(id) {
    const v = savedViews.find((x) => x.id === id);
    if (!v) return;
    if (!window.confirm(`Delete the “${v.name}” view?`)) return;
    savedViews = savedViews.filter((x) => x.id !== id);
    putViews();
  }

  // ── Public API + wiring ──
  const debouncedSearch = debounce(() => runSearch(true), 140);

  function init(bridge) {
    B = bridge || {};
    const { input, clear, results } = els();
    if (input) {
      input.addEventListener("input", () => {
        if (clear) clear.style.display = input.value ? "block" : "none";
        debouncedSearch();
      });
      input.addEventListener("focus", () => { if (input.value.trim() && curMode === "search") runSearch(true); });
      input.addEventListener("keydown", (e) => { if (e.key === "Escape") { hideResults(); input.blur(); } });
    }
    if (clear) clear.addEventListener("click", () => { if (input) { input.value = ""; clear.style.display = "none"; input.focus(); } hideResults(); });
    if (results) results.addEventListener("scroll", onResultsScroll);

    // Close the results dropdown on an outside click.
    document.addEventListener("click", (e) => {
      const wrap = document.querySelector(".vault-search-wrap");
      if (wrap && !wrap.contains(e.target)) hideResults();
    });

    const saveBtn = document.getElementById("vault-saveview-btn");
    if (saveBtn) saveBtn.addEventListener("click", saveCurrentView);
    const orphansChip = document.getElementById("vault-orphans-chip");
    if (orphansChip) orphansChip.addEventListener("click", () => {
      const { results } = els();
      if (curMode === "orphans" && results && !results.hidden) hideResults(); else showOrphans();
    });

    // Quick-switcher: ⌘K / Ctrl-K opens from ANY tab.
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        if (switcherOpen()) closeSwitcher(); else openSwitcher();
      }
    });
    const swi = switcherEls();
    if (swi.input) {
      swi.input.addEventListener("input", runSwitcher);
      swi.input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); closeSwitcher(); return; }
        if (e.key === "ArrowDown") { e.preventDefault(); if (swItems.length) { swActive = (swActive + 1) % swItems.length; paintActive(); } }
        else if (e.key === "ArrowUp") { e.preventDefault(); if (swItems.length) { swActive = (swActive - 1 + swItems.length) % swItems.length; paintActive(); } }
        else if (e.key === "Enter") { e.preventDefault(); if (swActive >= 0) openIndex(swActive); }
      });
    }
    if (swi.overlay) swi.overlay.addEventListener("click", (e) => { if (e.target === swi.overlay) closeSwitcher(); });

    loadViews();
  }

  // Re-pull saved views after an external change (SSE) so a view saved on another
  // device shows up. Search results are always live (fetched on demand).
  function refresh() { loadViews(); }

  window.VaultSearch = { init, refresh, openSwitcher, closeSwitcher, hideResults };
})();
