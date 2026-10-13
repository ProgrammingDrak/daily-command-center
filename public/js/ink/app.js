// Mycelium Ink — app wiring.
//
// Shelf -> notebook -> page. The rule everything here follows: the pen is never
// blocked. Saving is debounced and local, syncing happens in the background, and
// no user action waits on the network.

(function () {
  "use strict";

  const S = window.InkStrokes;
  const Store = window.InkStore;
  const Canvas = window.InkCanvas;
  const Archive = window.InkArchive;

  // Ink colours and nib sizes. Both lists live here and nowhere else, so the
  // whole palette swaps from this block.
  const COLORS = ["#1b1b2f", "#2f6fb0", "#b0402f", "#2f7a4f", "#8a5aa8"];
  const HIGHLIGHTS = ["#ffe66d", "#a8e6a1", "#9fd6ff", "#ffc2e0"];
  const IMPLEMENTS = ["ballpoint", "fineliner", "fountain", "pencil", "mechanical", "marker", "highlighter", "brush", "calligraphy"];
  const HINTS = {
    ballpoint: "Smooth rounded ink with a restrained pressure response.",
    fineliner: "A uniform, precise line, independent of pressure.",
    fountain: "A directional nib with moderate pressure variation.",
    pencil: "Graphite grain with pressure-controlled darkness and width.",
    mechanical: "Fine graphite with a fixed width and pressure-controlled darkness.",
    marker: "Broad opaque ink with a chisel nib.",
    highlighter: "One translucent layer per stroke. Separate strokes darken where they overlap.",
    brush: "A flexible brush pen with a strong pressure response, from hairlines to broad marks.",
    calligraphy: "A flat nib: line width follows direction and nib angle.",
  };
  let preferences = {};
  try { preferences = JSON.parse(localStorage.getItem("mycelium-ink-tools") || "{}") || {}; } catch { /* optional preferences */ }
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
  function toolSettings(name) {
    const prior = preferences[name] || {}, spec = S.toolSpec(name);
    return { color: /^#[0-9a-f]{6}$/i.test(prior.color) ? prior.color : name === "highlighter" ? HIGHLIGHTS[0] : COLORS[0],
      size: Math.max(0.6, Math.min(48, Number(prior.size) || spec.sizes[1])),
      angle: Math.max(0, Math.min(170, Number.isFinite(prior.angle) ? prior.angle : 45)) };
  }
  const COVERS = ["slate", "moss", "clay", "plum", "ink", "sand"];
  const BOOK_ACTION_ICON = "⋮";
  const SAVE_DEBOUNCE_MS = 700;

  const $ = (id) => document.getElementById(id);
  const el = {
    shelf: $("shelf"), books: $("books"), shelfEmpty: $("shelfEmpty"),
    shelfSub: $("shelfSub"), shelfStatus: $("shelfStatus"),
    writer: $("writer"), nbName: $("nbName"), stage: $("stage"), wrap: $("wrap"),
    base: $("base"), live: $("live"),
    penBtn: $("penBtn"), hlBtn: $("hlBtn"), eraseBtn: $("eraseBtn"),
    swatches: $("swatches"), sizes: $("sizes"),
    widthRange: $("widthRange"), widthLabel: $("widthLabel"),
    brushDlg: $("brushDlg"), brushChoices: $("brushChoices"), brushClose: $("brushClose"), brushHint: $("brushHint"),
    nibControl: $("nibControl"), nibAngle: $("nibAngle"), nibLabel: $("nibLabel"),
    paperDlg: $("paperDlg"), paperBtn: $("paperBtn"), paperChoices: $("paperChoices"), paperClose: $("paperClose"),
    paperTint: $("paperTint"), paperSpacing: $("paperSpacing"), paperMargin: $("paperMargin"), fingerBtn: $("fingerBtn"),
    undoBtn: $("undoBtn"), redoBtn: $("redoBtn"), backBtn: $("backBtn"),
    prevBtn: $("prevBtn"), nextBtn: $("nextBtn"), addPageBtn: $("addPageBtn"),
    delPageBtn: $("delPageBtn"), pgLabel: $("pgLabel"), syncStatus: $("syncStatus"),
    newDlg: $("newDlg"), newTitle: $("newTitle"), newCreate: $("newCreate"),
    newCancel: $("newCancel"), coverPicks: $("coverPicks"),
    bookDlg: $("bookDlg"), bookTitle: $("bookTitle"), bookSave: $("bookSave"),
    bookCancel: $("bookCancel"), bookDelete: $("bookDelete"),
    bookMenu: $("bookMenu"), bookMenuOpen: $("bookMenuOpen"),
    bookMenuRename: $("bookMenuRename"), bookMenuDelete: $("bookMenuDelete"),
    bookMenuExport: $("bookMenuExport"),
    deleteBookDlg: $("deleteBookDlg"), deleteBookMessage: $("deleteBookMessage"),
    deleteBookCancel: $("deleteBookCancel"), deleteBookConfirm: $("deleteBookConfirm"),
    exportAllBtn: $("exportAllBtn"), importBtn: $("importBtn"), importFile: $("importFile"),
    archiveDlg: $("archiveDlg"), archiveTitle: $("archiveTitle"),
    archiveMessage: $("archiveMessage"), archiveClose: $("archiveClose"),
  };

  let ink = null;
  let sync = null;
  let current = { notebook: null, pages: [], index: 0 };
  let newCover = COVERS[0];
  let saveTimer = null;
  let localStatus = "";
  let remoteStatus = "";
  let serverBuildLabel = "";
  let menuNotebook = null;
  let menuTrigger = null;

  // /api/health reports the server commit, which can differ from cached app
  // assets. Offline, the shelf omits this server label.
  async function loadServerBuildLabel() {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) return;
      const health = await res.json();
      if (health && health.revision) serverBuildLabel = `server build ${String(health.revision).slice(0, 7)}`;
    } catch { /* offline; the label is a convenience, not a requirement */ }
  }
  let editingNotebook = null;
  let deletingNotebook = null;

  const coverColor = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(`--cover-${name}`).trim() || "#47506b";

  // ── shelf ──────────────────────────────────────────────────────────────────

  async function renderShelf() {
    closeBookMenu();
    const books = await Store.listNotebooks();
    el.books.innerHTML = "";

    for (const nb of books) {
      const pages = await Store.listPages(nb.id);
      const unsynced = pages.filter((p) => p.dirty === 1 && p.data).length;
      const wrap = document.createElement("div");
      wrap.className = "book-wrap";
      const card = document.createElement("button");
      card.className = "book";
      card.innerHTML = `
        <span class="spine" style="background-color:${coverColor(nb.cover)}">
          ${unsynced ? '<span class="badge" title="not synced yet"></span>' : ""}
          <span class="count">${pages.length} ${pages.length === 1 ? "page" : "pages"}</span>
        </span>
        <span class="title"></span>
        <span class="meta">${relTime(nb.updated)}</span>`;
      card.querySelector(".title").textContent = nb.title;
      card.addEventListener("click", () => openNotebook(nb.id));
      card.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        showBookMenu(nb, null, { x: event.clientX, y: event.clientY });
      });
      const actions = document.createElement("button");
      actions.className = "book-actions";
      actions.textContent = BOOK_ACTION_ICON;
      actions.setAttribute("aria-label", `Actions for ${nb.title}`);
      actions.setAttribute("aria-haspopup", "menu");
      actions.setAttribute("aria-expanded", "false");
      actions.setAttribute("aria-controls", "bookMenu");
      actions.addEventListener("click", (event) => {
        event.stopPropagation();
        showBookMenu(nb, actions);
      });
      wrap.append(card, actions);
      el.books.appendChild(wrap);
    }

    const add = document.createElement("button");
    add.className = "book new-book";
    add.innerHTML = '<span class="spine">+</span><span class="title">New notebook</span><span class="meta">&nbsp;</span>';
    add.addEventListener("click", openNewDialog);
    el.books.appendChild(add);

    el.shelfEmpty.classList.toggle("hidden", books.length > 0);
    const st = await Store.stats();
    el.shelfSub.textContent = [
      books.length ? `${books.length} notebook${books.length === 1 ? "" : "s"}` : "",
      // This is the server build. Cached app assets may be older.
      "ink-v8",
      serverBuildLabel,
    ].filter(Boolean).join(" · ");
    el.shelfStatus.textContent = st.unsynced ? `${st.unsynced} page${st.unsynced === 1 ? "" : "s"} to sync` : "";
    el.shelfStatus.className = "status" + (st.unsynced ? "" : " ok");
  }

  function closeBookMenu({ restoreFocus = false } = {}) {
    el.bookMenu.classList.add("hidden");
    if (menuTrigger) menuTrigger.setAttribute("aria-expanded", "false");
    if (restoreFocus && menuTrigger) menuTrigger.focus();
    menuNotebook = null;
    menuTrigger = null;
  }

  function showBookMenu(notebook, trigger, point = null) {
    const isSameOpenMenu = menuNotebook && menuNotebook.id === notebook.id && !el.bookMenu.classList.contains("hidden");
    closeBookMenu();
    if (isSameOpenMenu && trigger) return;
    menuNotebook = notebook;
    menuTrigger = trigger;
    if (trigger) trigger.setAttribute("aria-expanded", "true");
    el.bookMenu.classList.remove("hidden");
    const rect = trigger ? trigger.getBoundingClientRect() : null;
    const left = point ? point.x : rect.left;
    const top = point ? point.y : rect.bottom + 5;
    const menuRect = el.bookMenu.getBoundingClientRect();
    el.bookMenu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - menuRect.width - 8))}px`;
    el.bookMenu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - menuRect.height - 8))}px`;
    el.bookMenuOpen.focus();
  }

  function openBookDialog(notebook) {
    closeBookMenu();
    editingNotebook = notebook;
    el.bookTitle.value = notebook.title;
    el.bookDlg.showModal();
    setTimeout(() => el.bookTitle.focus(), 40);
  }

  async function requestNotebookDeletion(notebook) {
    closeBookMenu();
    deletingNotebook = notebook;
    const pages = await Store.listPages(notebook.id);
    const pageLabel = `${pages.length} ${pages.length === 1 ? "page" : "pages"}`;
    el.deleteBookMessage.textContent = `Delete “${notebook.title}” and its ${pageLabel}? This cannot be undone.`;
    el.deleteBookDlg.showModal();
  }

  document.addEventListener("click", (event) => {
    if (!el.bookMenu.classList.contains("hidden") && !el.bookMenu.contains(event.target)) closeBookMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el.bookMenu.classList.contains("hidden")) closeBookMenu({ restoreFocus: true });
  });
  el.shelf.addEventListener("scroll", () => closeBookMenu());
  el.bookMenu.addEventListener("click", (event) => event.stopPropagation());
  el.bookMenuOpen.addEventListener("click", async () => {
    const notebook = menuNotebook;
    closeBookMenu();
    if (notebook) await openNotebook(notebook.id);
  });
  el.bookMenuRename.addEventListener("click", () => {
    if (menuNotebook) openBookDialog(menuNotebook);
  });
  el.bookMenuDelete.addEventListener("click", () => {
    if (menuNotebook) requestNotebookDeletion(menuNotebook);
  });

  function relTime(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 90) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  function openNewDialog() {
    el.newTitle.value = "";
    newCover = COVERS[0];
    renderCoverPicks();
    el.newDlg.showModal();
    setTimeout(() => el.newTitle.focus(), 40);
  }

  function renderCoverPicks() {
    el.coverPicks.innerHTML = "";
    for (const c of COVERS) {
      const b = document.createElement("button");
      b.className = "cover-pick" + (c === newCover ? " on" : "");
      b.style.background = coverColor(c);
      b.addEventListener("click", (e) => { e.preventDefault(); newCover = c; renderCoverPicks(); });
      el.coverPicks.appendChild(b);
    }
  }

  el.newCancel.addEventListener("click", () => el.newDlg.close());
  el.newCreate.addEventListener("click", async () => {
    const title = el.newTitle.value.trim() || "Untitled";
    el.newDlg.close();
    const nb = await Store.createNotebook(title, newCover);
    await openNotebook(nb.id);
  });
  el.newTitle.addEventListener("keydown", (e) => { if (e.key === "Enter") el.newCreate.click(); });

  // ── writer ─────────────────────────────────────────────────────────────────

  async function openNotebook(id) {
    const nb = await Store.getNotebook(id);
    if (!nb) return;
    current.notebook = nb;
    current.pages = await Store.listPages(id);
    if (!current.pages.length) current.pages = [await Store.addPage(id, 0)];
    current.index = 0;

    el.nbName.textContent = nb.title;
    el.shelf.classList.add("hidden");
    el.writer.classList.add("on");

    if (!ink) {
      ink = Canvas.create({ base: el.base, live: el.live, wrap: el.wrap, onChange: onInkChange, fingerDraw: "off", onNavigate: goPage });
      buildToolbar();
    }
    await loadPage(0);
    // Layout must run after the writer is visible, or the wrap measures zero.
    requestAnimationFrame(() => ink.layout());
  }

  async function loadPage(i) {
    const rec = current.pages[i];
    if (!rec) return;
    current.index = i;
    ink.loadPage(S.deserialize(rec.data));
    updatePager();
    updateHistoryButtons();
    updatePaperLabel();
  }

  function updatePager() {
    el.pgLabel.textContent = `Page ${current.index + 1} of ${current.pages.length}`;
    el.prevBtn.disabled = current.index === 0;
    el.nextBtn.disabled = current.index >= current.pages.length - 1;
    el.delPageBtn.disabled = current.pages.length <= 1;
  }

  function updateHistoryButtons() {
    el.undoBtn.disabled = !ink.canUndo();
    el.redoBtn.disabled = !ink.canRedo();
  }

  function onInkChange() {
    updateHistoryButtons();
    updatePaperLabel();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePage, SAVE_DEBOUNCE_MS);
    setStatus({ state: "unsaved" });
  }

  let saving = null;
  let navigating = false;
  async function savePage() {
    clearTimeout(saveTimer);
    while (saving) await saving;
    if (!ink || !ink.isDirty()) return true;
    const rec = current.pages[current.index];
    if (!rec) return false;
    const revision = ink.state.revision;
    const serialized = S.serialize(ink.getPage());
    let successful = false;
    saving = (async () => {
      try {
        const saved = await Store.savePage(rec.id, serialized);
        if (!saved) throw new Error("Page was not saved");
        const index = current.pages.findIndex(p => p.id === rec.id);
        if (index >= 0) current.pages[index] = saved;
        // Input can continue while IndexedDB writes. Acknowledging an older save
        // must never clear the dirty flag for newer ink or a new paper setting.
        if (current.pages[current.index]?.id === rec.id && ink.state.revision === revision) ink.clearDirty();
        setStatus({ state: ink.isDirty() ? "unsaved" : "saved" });
        if (sync) sync.nudge();
        successful = true;
      } catch (e) {
        localStatus = "Local save failed — keep this notebook open";
        setStatus({ state: "error", message: e.message });
      }
    })();
    try { await saving; } finally { saving = null; }
    return successful;
  }

  async function goPage(delta) {
    if (ink.isPenDown() || navigating) return;
    const next = current.index + delta;
    if (next < 0 || next >= current.pages.length) return;
    navigating = true;
    try { if (await savePage()) await loadPage(next); } finally { navigating = false; }
  }

  el.prevBtn.addEventListener("click", () => goPage(-1));
  el.nextBtn.addEventListener("click", () => goPage(1));

  el.addPageBtn.addEventListener("click", async () => {
    if (ink.isPenDown() || navigating) return;
    if (!await savePage()) return;
    const paper = ink.getPage().paper;
    const page = await Store.addPage(current.notebook.id, current.pages.length);
    current.pages.push(page);
    await loadPage(current.pages.length - 1);
    if (paper) ink.setPaper(paper);
  });

  el.delPageBtn.addEventListener("click", async () => {
    if (current.pages.length <= 1) return;
    if (!confirm(`Delete page ${current.index + 1}? This cannot be undone.`)) return;
    const rec = current.pages[current.index];
    await Store.deletePage(rec.id);
    current.pages = await Store.listPages(current.notebook.id);
    await loadPage(Math.min(current.index, current.pages.length - 1));
  });

  el.backBtn.addEventListener("click", async () => {
    if (ink.isPenDown() || navigating) return;
    if (!await savePage()) return;
    el.writer.classList.remove("on");
    el.shelf.classList.remove("hidden");
    await renderShelf();
    // Closing the notebook is a real pause, so this is a good moment to drain
    // the queue. Still nudged rather than forced, so it lands after the shelf
    // has painted instead of hitching the transition.
    if (sync) sync.nudge(1200);
  });

  el.nbName.addEventListener("click", () => openBookDialog(current.notebook));
  el.bookCancel.addEventListener("click", () => { editingNotebook = null; el.bookDlg.close(); });
  el.bookSave.addEventListener("click", async () => {
    if (!editingNotebook) return;
    const nb = await Store.renameNotebook(editingNotebook.id, el.bookTitle.value);
    editingNotebook = null;
    el.bookDlg.close();
    if (!nb) return;
    if (el.writer.classList.contains("on") && current.notebook && current.notebook.id === nb.id) {
      current.notebook = nb;
      el.nbName.textContent = nb.title;
    } else {
      await renderShelf();
    }
  });
  el.bookDelete.addEventListener("click", () => {
    if (!editingNotebook) return;
    const notebook = editingNotebook;
    editingNotebook = null;
    el.bookDlg.close();
    requestNotebookDeletion(notebook);
  });
  el.deleteBookCancel.addEventListener("click", () => {
    deletingNotebook = null;
    el.deleteBookDlg.close();
  });
  el.deleteBookConfirm.addEventListener("click", async () => {
    if (!deletingNotebook) return;
    const notebook = deletingNotebook;
    deletingNotebook = null;
    await Store.deleteNotebook(notebook.id);
    el.deleteBookDlg.close();
    if (current.notebook && current.notebook.id === notebook.id) {
      current.notebook = null;
      current.pages = [];
      el.writer.classList.remove("on");
      el.shelf.classList.remove("hidden");
    }
    await renderShelf();
  });

  // ── archive ────────────────────────────────────────────────────────────────

  function showArchiveResult(title, message, warn) {
    el.archiveTitle.textContent = title;
    el.archiveMessage.textContent = message;
    el.archiveMessage.className = "note" + (warn ? " warn" : "");
    el.archiveDlg.showModal();
  }

  el.archiveClose.addEventListener("click", () => el.archiveDlg.close());

  function downloadArchive(archive, label) {
    const blob = new Blob([Archive.serialize(archive)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = Archive.filename(archive, label);
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking immediately can cancel the download on some browsers, so let the
    // current task finish first.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return a.download;
  }

  async function exportNotebooks(ids, label) {
    // A debounced save could still be pending, and exporting a backup that is
    // missing the last thing written would be the worst possible bug here.
    const saved = await savePage();
    if (!saved) throw new Error("The latest page could not be saved. Keep the notebook open and retry export.");
    const entries = await Store.exportEntries(ids);
    if (!entries.length) {
      showArchiveResult("Export", "There is nothing to export yet.", true);
      return;
    }
    const archive = Archive.build(entries);
    const pages = archive.notebooks.reduce((n, nb) => n + nb.pages.length, 0);
    const name = downloadArchive(archive, label);
    const books = `${archive.notebooks.length} notebook${archive.notebooks.length === 1 ? "" : "s"}`;
    showArchiveResult("Exported", `${books}, ${pages} page${pages === 1 ? "" : "s"}, saved as ${name}. Keep it somewhere other than this device.`);
  }

  el.exportAllBtn.addEventListener("click", async () => {
    el.exportAllBtn.disabled = true;
    try { await exportNotebooks(null, "shelf"); }
    catch (e) { showArchiveResult("Export failed", String((e && e.message) || e), true); }
    finally { el.exportAllBtn.disabled = false; }
  });

  el.bookMenuExport.addEventListener("click", async () => {
    const notebook = menuNotebook;
    closeBookMenu();
    if (!notebook) return;
    try { await exportNotebooks([notebook.id], notebook.title); }
    catch (e) { showArchiveResult("Export failed", String((e && e.message) || e), true); }
  });

  el.importBtn.addEventListener("click", () => {
    // Reset first: picking the same file twice in a row fires no change event
    // otherwise, and a restore that silently does nothing is alarming.
    el.importFile.value = "";
    el.importFile.click();
  });

  el.importFile.addEventListener("change", async () => {
    const file = el.importFile.files && el.importFile.files[0];
    if (!file) return;
    el.importBtn.disabled = true;
    // Everything before the first write can fail safely. Once writing starts the
    // honest answer changes, and claiming "nothing changed" after a half-written
    // restore would send someone away from a shelf they needed to look at.
    let writing = false;
    try {
      const archive = Archive.parse(await file.text());
      const planned = Archive.plan(archive, {
        existingIds: await Store.notebookIds(),
        uid: Store.uid,
      });
      if (!planned.length) {
        showArchiveResult("Import", "That archive has no notebooks in it.", true);
        return;
      }
      writing = true;
      await Store.importNotebooks(planned);
      const sum = Archive.summarize(planned);
      const parts = [`${sum.notebooks} notebook${sum.notebooks === 1 ? "" : "s"}, ${sum.pages} page${sum.pages === 1 ? "" : "s"}.`];
      if (sum.collided) {
        parts.push(`${sum.collided} already existed here and came in as a separate copy rather than replacing what you have.`);
      }
      parts.push("Everything imported will sync to the vault on its own.");
      showArchiveResult("Imported", parts.join(" "));
      await renderShelf();
      // Nudged, not forced: a restored archive can be dozens of pages, and
      // rendering every one of them right now would freeze the shelf that was
      // just drawn. They are marked dirty, so they go on their own.
      if (sync) sync.nudge(1500);
    } catch (e) {
      const after = writing
        ? " Part of that archive may already be on the shelf — check it before importing again."
        : " Nothing on this device was changed.";
      showArchiveResult("Import failed", `${String((e && e.message) || e)}${after}`, true);
      if (writing) await renderShelf();
    } finally {
      el.importBtn.disabled = false;
      el.importFile.value = "";
    }
  });

  // ── toolbar ────────────────────────────────────────────────────────────────

  let selectedImplement = "ballpoint";
  function rememberTool() {
    if (ink.state.tool === "eraser") return;
    preferences[selectedImplement] = { color: ink.state.color, size: ink.state.size, angle: ink.state.style.angle };
    try { localStorage.setItem("mycelium-ink-tools", JSON.stringify(preferences)); } catch { /* drawing works without preference storage */ }
  }
  function selectTool(name) {
    if (ink.isPenDown()) return;
    ink.setTool(name);
    if (name !== "eraser") {
      selectedImplement = name;
      const settings = toolSettings(name);
      ink.setColor(settings.color); ink.setSize(settings.size); ink.setStyle({ angle: settings.angle });
    }
    el.penBtn.textContent = `${S.toolSpec(selectedImplement).label} ▾`;
    el.penBtn.classList.toggle("on", name !== "eraser");
    el.hlBtn.classList.toggle("on", name === "highlighter");
    el.eraseBtn.classList.toggle("on", name === "eraser");
    for (const btn of [el.penBtn, el.hlBtn, el.eraseBtn]) btn.setAttribute("aria-pressed", btn.classList.contains("on"));
    renderSwatches(); renderSizes();
  }
  function renderSwatches() {
    const list = selectedImplement === "highlighter" ? HIGHLIGHTS : COLORS;
    el.swatches.innerHTML = "";
    for (const color of list) {
      const b = document.createElement("button");
      b.className = "swatch" + (color === ink.state.color ? " on" : "");
      b.style.background = color;
      b.setAttribute("aria-label", `Ink color ${color}`); b.setAttribute("aria-pressed", color === ink.state.color);
      b.disabled = ink.state.tool === "eraser";
      b.addEventListener("click", () => { ink.setColor(color); rememberTool(); renderSwatches(); });
      el.swatches.appendChild(b);
    }
  }
  function renderSizes() {
    const eraser = ink.state.tool === "eraser";
    const sizes = eraser ? [6, 12, 24] : S.toolSpec(selectedImplement).sizes;
    const active = eraser ? ink.state.eraserRadius : ink.state.size;
    el.sizes.innerHTML = "";
    for (const size of sizes) {
      const b = document.createElement("button");
      b.className = "size-dot" + (size === active ? " on" : "");
      b.setAttribute("aria-label", `${eraser ? "Eraser radius" : "Stroke width"} ${size}`);
      b.setAttribute("aria-pressed", size === active);
      b.innerHTML = `<i style="width:${Math.min(20, Math.max(3, size * 1.3))}px;height:${Math.min(20, Math.max(3, size * 1.3))}px"></i>`;
      b.addEventListener("click", () => {
        if (eraser) ink.state.eraserRadius = size; else { ink.setSize(size); rememberTool(); }
        renderSizes();
      });
      el.sizes.appendChild(b);
    }
    el.widthRange.value = active;
    el.widthRange.setAttribute("aria-label", eraser ? "Eraser radius" : "Stroke width");
    el.widthLabel.textContent = active.toFixed(1);
  }
  function brushPreview(canvas, name) {
    canvas.width = 320; canvas.height = 96;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff9eb"; ctx.fillRect(0, 0, 320, 96);
    const settings = toolSettings(name);
    const stroke = S.newStroke(name, settings.color, settings.size * 1.5, settings);
    for (let i = 0; i < 64; i++) S.addPoint(stroke, 22 + i * 4.3, 48 + Math.sin(i / 7) * 17,
      0.1 + Math.sin(i / 63 * Math.PI) * 0.85, 0);
    S.drawStroke(ctx, stroke);
  }
  function renderBrushes() {
    el.brushChoices.innerHTML = "";
    for (const name of IMPLEMENTS) {
      const b = document.createElement("button"); b.className = "picker-card";
      b.setAttribute("aria-pressed", ink.state.tool === name);
      const canvas = document.createElement("canvas"), label = document.createElement("span");
      label.textContent = S.toolSpec(name).label;
      canvas.setAttribute("aria-hidden", "true"); brushPreview(canvas, name);
      b.append(canvas, label);
      b.addEventListener("click", () => { selectTool(name); renderBrushes(); });
      el.brushChoices.appendChild(b);
    }
    const nib = !!S.toolSpec(selectedImplement).nib;
    el.nibControl.classList.toggle("hidden", !nib);
    el.nibAngle.value = ink.state.style.angle;
    el.nibLabel.textContent = `${ink.state.style.angle}°`;
    el.brushHint.textContent = HINTS[selectedImplement];
  }
  function updatePaperLabel() {
    const paper = S.normalizePaper(ink.getPage().paper);
    el.paperBtn.textContent = `Paper: ${S.PAPERS.find(p => p.id === paper.type).label} ▾`;
  }
  function renderPaperChoices() {
    const paper = S.normalizePaper(ink.getPage().paper);
    el.paperTint.value = paper.tint; el.paperSpacing.value = paper.spacing; el.paperMargin.checked = paper.margin;
    const spacingUsed = ["ruled-narrow", "ruled", "ruled-wide", "dots", "grid", "engineering", "cornell", "music", "checklist", "handwriting", "isometric"].includes(paper.type);
    el.paperSpacing.disabled = !spacingUsed;
    el.paperMargin.disabled = !paper.type.startsWith("ruled");
    el.paperChoices.innerHTML = "";
    for (const preset of S.PAPERS) {
      const b = document.createElement("button"); b.className = "picker-card";
      b.setAttribute("aria-pressed", paper.type === preset.id);
      const canvas = document.createElement("canvas"), label = document.createElement("span");
      canvas.width = 170; canvas.height = 220; canvas.setAttribute("aria-hidden", "true");
      S.drawPaper(canvas.getContext("2d"), { w: S.PAGE_W, h: S.PAGE_H,
        paper: { ...paper, type: preset.id, spacing: preset.id === paper.type ? paper.spacing : preset.spacing } }, { scale: 170 / S.PAGE_W });
      label.textContent = preset.label; b.append(canvas, label);
      b.addEventListener("click", () => { ink.setPaper({ ...paper, type: preset.id, spacing: preset.spacing }); renderPaperChoices(); });
      el.paperChoices.appendChild(b);
    }
  }
  function buildToolbar() {
    el.penBtn.addEventListener("click", () => { if (!ink.isPenDown()) { renderBrushes(); el.brushDlg.showModal(); } });
    el.brushClose.addEventListener("click", () => el.brushDlg.close());
    el.hlBtn.addEventListener("click", () => selectTool("highlighter"));
    el.eraseBtn.addEventListener("click", () => selectTool("eraser"));
    el.widthRange.addEventListener("input", () => {
      const value = Number(el.widthRange.value);
      if (ink.state.tool === "eraser") ink.state.eraserRadius = value; else { ink.setSize(value); rememberTool(); }
      renderSizes();
    });
    el.nibAngle.addEventListener("input", () => {
      ink.setStyle({ angle: Number(el.nibAngle.value) }); rememberTool(); renderBrushes();
    });
    el.paperBtn.addEventListener("click", () => { if (!ink.isPenDown()) { renderPaperChoices(); el.paperDlg.showModal(); } });
    el.paperClose.addEventListener("click", () => el.paperDlg.close());
    for (const field of [el.paperTint, el.paperSpacing, el.paperMargin]) field.addEventListener("change", () => {
      ink.setPaper({ ...S.normalizePaper(ink.getPage().paper), tint: el.paperTint.value,
        spacing: Number(el.paperSpacing.value), margin: el.paperMargin.checked }); renderPaperChoices();
    });
    el.fingerBtn.addEventListener("click", () => {
      const on = ink.state.fingerDraw !== "on";
      ink.setFingerDraw(on ? "on" : "off");
      el.fingerBtn.textContent = `Finger draw: ${on ? "on" : "off"}`; el.fingerBtn.setAttribute("aria-pressed", on);
      el.fingerBtn.title = on ? "Fingers draw ink; turn off to navigate with swipes" : "Pencil and mouse draw; fingers swipe between pages";
    });
    el.undoBtn.addEventListener("click", () => { if (!ink.isPenDown()) { ink.undo(); updateHistoryButtons(); } });
    el.redoBtn.addEventListener("click", () => { if (!ink.isPenDown()) { ink.redo(); updateHistoryButtons(); } });
    selectTool("ballpoint");
  }

  document.addEventListener("keydown", (e) => {
    if (!el.writer.classList.contains("on") || document.querySelector("dialog[open]") || e.target.matches("input, select, textarea") || ink.isPenDown()) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) ink.redo(); else ink.undo();
      updateHistoryButtons();
    } else if (e.key === "ArrowRight") goPage(1);
    else if (e.key === "ArrowLeft") goPage(-1);
  });

  // ── status ─────────────────────────────────────────────────────────────────

  function setStatus(s) {
    if (s.state === "unsaved") localStatus = "Saving locally";
    else if (s.state === "saved") localStatus = "Saved locally";
    else if (s.state === "clean") remoteStatus = "Synced";
    else if (s.state === "syncing") remoteStatus = `Syncing ${s.pending || ""}`.trim();
    else if (s.state === "error") remoteStatus = s.message === "offline" ? "Offline" : (s.message || "Needs attention");
    const label = [localStatus, remoteStatus].filter(Boolean).join(" · ");
    el.syncStatus.textContent = label;
    el.syncStatus.setAttribute("aria-label", label || "Notebook save status");
    el.syncStatus.className = "status" + (s.state === "error" ? " warn" : s.state === "clean" ? " ok" : "");
  }

  // Losing a page because the tab closed mid-debounce would be unforgivable, so
  // flush synchronously-ish on the way out as well as on the timer.
  window.addEventListener("pagehide", () => { savePage(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) savePage(); });

  // ── boot ───────────────────────────────────────────────────────────────────

  (async function boot() {
    try {
      const ownerStorageKey = "mycelium-ink-owner";
      let owner = null;
      try {
        const response = await fetch("/api/me", { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) throw Object.assign(new Error(`identity ${response.status}`), { status: response.status });
        const me = await response.json();
        owner = String(me.workspaceId || (me.userId ? `user-${me.userId}` : "")).trim();
        if (!owner) throw new Error("identity response had no owner");
        localStorage.setItem(ownerStorageKey, owner);
      } catch (e) {
        // Offline reopening uses the last verified owner. An online 401/403
        // never falls back, so switching accounts cannot expose another store.
        if (!e.status) owner = localStorage.getItem(ownerStorageKey);
        if (!owner) throw e;
      }
      Store.configureOwner(owner);
      await Store.open();
    } catch (e) {
      el.shelfEmpty.classList.remove("hidden");
      el.shelfEmpty.textContent = `The private local notebook could not open (${e.message}). Sign in once online before using it offline.`;
      return;
    }
    sync = window.InkSync.create({
      store: Store,
      strokes: S,
      onStatus: setStatus,
      // `ink` is created lazily when a notebook opens, so this is read at call
      // time rather than captured.
      isBusy: () => !!(ink && ink.isPenDown()),
    });
    await loadServerBuildLabel();
    await renderShelf();
    sync.start();
  })();
})();
