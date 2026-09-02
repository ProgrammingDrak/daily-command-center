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

  // Ink colours and nib sizes. Both lists live here and nowhere else, so the
  // whole palette swaps from this block.
  const COLORS = ["#1b1b2f", "#2f6fb0", "#b0402f", "#2f7a4f", "#8a5aa8"];
  const HIGHLIGHTS = ["#ffe66d", "#a8e6a1", "#9fd6ff", "#ffc2e0"];
  const SIZES = [1.6, 2.6, 4.2, 7];
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
    undoBtn: $("undoBtn"), redoBtn: $("redoBtn"), backBtn: $("backBtn"),
    prevBtn: $("prevBtn"), nextBtn: $("nextBtn"), addPageBtn: $("addPageBtn"),
    delPageBtn: $("delPageBtn"), pgLabel: $("pgLabel"), syncStatus: $("syncStatus"),
    newDlg: $("newDlg"), newTitle: $("newTitle"), newCreate: $("newCreate"),
    newCancel: $("newCancel"), coverPicks: $("coverPicks"),
    bookDlg: $("bookDlg"), bookTitle: $("bookTitle"), bookSave: $("bookSave"),
    bookCancel: $("bookCancel"), bookDelete: $("bookDelete"),
    bookMenu: $("bookMenu"), bookMenuOpen: $("bookMenuOpen"),
    bookMenuRename: $("bookMenuRename"), bookMenuDelete: $("bookMenuDelete"),
    deleteBookDlg: $("deleteBookDlg"), deleteBookMessage: $("deleteBookMessage"),
    deleteBookCancel: $("deleteBookCancel"), deleteBookConfirm: $("deleteBookConfirm"),
  };

  let ink = null;
  let sync = null;
  let current = { notebook: null, pages: [], index: 0 };
  let newCover = COVERS[0];
  let saveTimer = null;
  let localStatus = "";
  let remoteStatus = "";
  let menuNotebook = null;
  let menuTrigger = null;
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
    el.shelfSub.textContent = books.length
      ? `${books.length} notebook${books.length === 1 ? "" : "s"}`
      : "";
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
      ink = Canvas.create({ base: el.base, live: el.live, wrap: el.wrap, onChange: onInkChange });
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
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePage, SAVE_DEBOUNCE_MS);
    setStatus({ state: "unsaved" });
  }

  async function savePage() {
    clearTimeout(saveTimer);
    if (!ink || !ink.isDirty()) return;
    const rec = current.pages[current.index];
    if (!rec) return;
    const serialized = S.serialize(ink.getPage());
    const saved = await Store.savePage(rec.id, serialized);
    if (saved) current.pages[current.index] = saved;
    ink.clearDirty();
    setStatus({ state: "saved" });
    if (sync) sync.syncNow();
  }

  async function goPage(delta) {
    const next = current.index + delta;
    if (next < 0 || next >= current.pages.length) return;
    await savePage();
    await loadPage(next);
  }

  el.prevBtn.addEventListener("click", () => goPage(-1));
  el.nextBtn.addEventListener("click", () => goPage(1));

  el.addPageBtn.addEventListener("click", async () => {
    await savePage();
    const page = await Store.addPage(current.notebook.id, current.pages.length);
    current.pages.push(page);
    await loadPage(current.pages.length - 1);
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
    await savePage();
    el.writer.classList.remove("on");
    el.shelf.classList.remove("hidden");
    await renderShelf();
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

  // ── toolbar ────────────────────────────────────────────────────────────────

  function buildToolbar() {
    const tools = { pen: el.penBtn, highlighter: el.hlBtn, eraser: el.eraseBtn };
    function selectTool(name) {
      ink.setTool(name);
      for (const [k, btn] of Object.entries(tools)) btn.classList.toggle("on", k === name);
      renderSwatches();
    }
    for (const [name, btn] of Object.entries(tools)) btn.addEventListener("click", () => selectTool(name));

    function renderSwatches() {
      const list = ink.state.tool === "highlighter" ? HIGHLIGHTS : COLORS;
      el.swatches.innerHTML = "";
      // Switching tools keeps its own last colour rather than carrying a pen
      // colour into the highlighter, where it would be nearly invisible.
      if (!list.includes(ink.state.color)) ink.setColor(list[0]);
      for (const c of list) {
        const b = document.createElement("button");
        b.className = "swatch" + (c === ink.state.color ? " on" : "");
        b.style.background = c;
        b.addEventListener("click", () => { ink.setColor(c); renderSwatches(); });
        el.swatches.appendChild(b);
      }
    }

    el.sizes.innerHTML = "";
    for (const size of SIZES) {
      const b = document.createElement("button");
      b.className = "size-dot" + (size === ink.state.size ? " on" : "");
      b.innerHTML = `<i style="width:${Math.max(3, size * 1.7)}px;height:${Math.max(3, size * 1.7)}px"></i>`;
      b.addEventListener("click", () => {
        ink.setSize(size);
        [...el.sizes.children].forEach((c, i) => c.classList.toggle("on", SIZES[i] === size));
      });
      el.sizes.appendChild(b);
    }

    el.undoBtn.addEventListener("click", () => { ink.undo(); updateHistoryButtons(); });
    el.redoBtn.addEventListener("click", () => { ink.redo(); updateHistoryButtons(); });
    selectTool("pen");
  }

  document.addEventListener("keydown", (e) => {
    if (!el.writer.classList.contains("on")) return;
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
    sync = window.InkSync.create({ store: Store, strokes: S, onStatus: setStatus });
    await renderShelf();
    sync.start();
  })();
})();
