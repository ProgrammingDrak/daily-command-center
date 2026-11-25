/* global InkStore, InkArchive, InkSync, InkStrokes, JournalDrafts */
(function () {
  "use strict";
  const DEFAULT_LAYOUT = "shelf";
  const COLORS = {
    journals: "#36564f",
    slate: "#344b68",
    moss: "#36564f",
    clay: "#6a4f47",
    plum: "#544868",
    ink: "#30394c",
    sand: "#756446"
  };
  const root = document.getElementById("library-root"),
    live = document.getElementById("library-status");
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  let owner = null,
    drafts = null,
    notebooks = [],
    journals = [],
    active = null,
    entry = null,
    frame = null;
  let pendingTimer,
    syncTimer,
    syncing = null,
    saving = null,
    version = 0,
    savedVersion = 0,
    loadRequest = 0;
  let retry = 0,
    blocked = false,
    localFailure = false,
    attaching = false,
    filter = "all",
    search = "";
  let localLabel = "Opening local storage",
    remoteLabel = "Checking vault";
  const DCC = (window.DCC = window.DCC || {});
  DCC.esc = esc;
  async function api(url, options = {}) {
    const res = await fetch(url, { credentials: "same-origin", cache: "no-store", ...options });
    const data = await res.json().catch(() => ({ error: `Invalid server response (${res.status})` }));
    if (!res.ok) {
      const error = Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
      if ([401, 403].includes(res.status)) {
        blocked = true;
        remoteLabel = "Sign in required";
        status();
      }
      throw error;
    }
    return data;
  }
  DCC.api = api;
  DCC.toast = (message) => {
    live.textContent = message;
  };
  const json = (method, body) => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const path = (slug) => "/api/vault/node/" + slug.split("/").map(encodeURIComponent).join("/");
  const today = () => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return `${values.year}-${values.month}-${values.day}`;
  };
  const dateLabel = (date) =>
    new Date(date + "T12:00:00").toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric"
    });
  const isBusy = () => !!entry?.isBusy() || !!frame || attaching;
  function status() {
    const text = [localLabel, remoteLabel].filter(Boolean).join(" · ");
    root.querySelector("[data-status]")?.replaceChildren(document.createTextNode(text));
    live.textContent = text;
  }
  function scheduleSync(delay = 8000) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncJournals().catch((error) => notify(error)), delay);
  }
  function notify(error) {
    remoteLabel = error.status === 409 ? "Conflict: local draft kept" : error.message;
    status();
  }
  async function flush() {
    clearTimeout(pendingTimer);
    if (attaching) {
      live.textContent = "Wait for the attachment upload before leaving this entry";
      return false;
    }
    if (entry?.isBusy()) {
      pendingTimer = setTimeout(flush, 700);
      return false;
    }
    while (saving) await saving;
    if (!active || !entry || version === savedVersion) return !localFailure;
    const target = version;
    const snapshot = { ...active, body: entry.readCommitted() };
    saving = drafts.edit(snapshot);
    try {
      const stored = await saving;
      if (active?.slug === stored.slug) active = { ...stored };
      savedVersion = target;
      localFailure = false;
      localLabel = version === savedVersion ? "Saved locally" : "Saving locally";
      if (stored.conflict) {
        remoteLabel = "Conflict: local draft kept";
        renderConflict();
      }
      status();
      scheduleSync();
      return true;
    } catch (error) {
      localFailure = true;
      localLabel = "Local save failed. Keep this page open";
      status();
      return false;
    } finally {
      saving = null;
      if (version !== savedVersion && !localFailure) pendingTimer = setTimeout(flush, 700);
    }
  }
  function changed() {
    version++;
    localLabel = "Saving locally";
    remoteLabel = active?.conflict ? "Conflict: local draft kept" : "Waiting to sync";
    status();
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(flush, 700);
    scheduleSync();
  }
  async function syncJournals() {
    if (blocked || !drafts || syncing) return syncing;
    if (isBusy()) {
      scheduleSync(4000);
      return;
    }
    if (!navigator.onLine) {
      remoteLabel = "Offline. Changes stay on this device";
      status();
      scheduleSync(30000);
      return;
    }
    syncing = (async () => {
      for (let record of (await drafts.list()).filter((r) => r.dirty && !r.conflict)) {
        if (isBusy()) {
          scheduleSync(4000);
          break;
        }
        try {
          remoteLabel = "Syncing to vault";
          status();
          // Verify the account again before a write, including after offline resume.
          const me = await api("/api/me");
          const currentOwner = String(me.workspaceId || (me.userId ? `user-${me.userId}` : ""));
          if (currentOwner !== owner) {
            blocked = true;
            throw new Error("Account changed. Reopen Library before syncing");
          }
          if (record.pendingCreate) {
            const daily = await api("/api/vault/daily", json("POST", { date: record.frontmatter.date }));
            if (!daily.created && (daily.node.body || "").trim())
              throw Object.assign(new Error("A journal for this date exists in the vault. Your local draft is kept."), {
                status: 409
              });
            record = await drafts.setBase(record.slug, daily.node.hash);
          }
          if (!record.hash) throw new Error("Journal has no verified vault version. Local copy kept");
          const result = await api(
            path(record.slug),
            json("PUT", {
              frontmatter: record.frontmatter,
              body: record.body,
              expectedHash: record.hash,
              message: `journal ${record.slug}`
            })
          );
          const saved = await drafts.acknowledge(record.slug, record.revision, result.hash);
          if (active?.slug === saved?.slug) active = { ...saved };
          remoteLabel = saved?.dirty ? "Newer changes waiting to sync" : "Synced to vault";
          retry = 0;
          status();
        } catch (error) {
          if (error.status === 409) {
            const kept = await drafts.markConflict(record.slug, error.message);
            if (active?.slug === record.slug) active = kept;
            notify(error);
            renderConflict();
            continue;
          }
          notify(error);
          scheduleSync([30000, 120000, 600000, 1800000][Math.min(retry++, 3)]);
          break;
        }
      }
      const remaining = (await drafts.list()).filter((r) => r.dirty);
      if (!remaining.length && !blocked) {
        remoteLabel = "Synced to vault";
        status();
      }
    })();
    try {
      return await syncing;
    } finally {
      syncing = null;
    }
  }
  async function refresh() {
    notebooks = await InkStore.listNotebooks();
    let records = await drafts.list();
    journals = records.map((r) => ({ slug: r.slug, frontmatter: r.frontmatter, dirty: r.dirty, conflict: r.conflict }));
    if (navigator.onLine && !blocked) {
      try {
        const nodes = await api("/api/vault/nodes?type=journal");
        if (!Array.isArray(nodes)) throw new Error("Journal list unavailable");
        const merged = new Map(journals.map((n) => [n.slug, n]));
        for (const node of nodes)
          if (String(node.slug).startsWith("journal/") && !node.sensitive)
            merged.set(node.slug, { ...node, ...(merged.get(node.slug) || {}) });
        journals = [...merged.values()];
      } catch (error) {
        notify(error);
      }
    }
    journals.sort((a, b) => String(b.frontmatter?.date || b.slug).localeCompare(String(a.frontmatter?.date || a.slug)));
  }
  function download(content, name, type) {
    const url = URL.createObjectURL(new Blob([content], { type })),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function exportNotebooks() {
    try {
      const archive = InkArchive.build(await InkStore.exportEntries());
      download(InkArchive.serialize(archive), InkArchive.filename(archive, "library"), "application/json");
    } catch (error) {
      notify(error);
    }
  }
  async function shelf() {
    if (!(await flush())) return;
    loadRequest++;
    entry?.destroy();
    entry = null;
    active = null;
    version = 0;
    savedVersion = 0;
    if (frame) {
      frame.remove();
      frame = null;
    }
    await refresh();
    const u = new URL(location.href);
    u.search = "";
    history.replaceState({}, "", u);
    root.innerHTML = `<div class="lr-head"><div><div class="lr-eyebrow">Daily Command Center</div><h1>Library</h1><p class="lr-sub">Your days, your ideas, a place for both.</p></div><button class="lr-button primary" data-create>+ Notebook</button></div>
      <div class="lr-toolbar"><div class="lr-tabs" role="tablist" aria-label="Library filter"><button role="tab" data-filter="all" aria-selected="true">All notebooks</button><button role="tab" data-filter="journal" aria-selected="false">Journals</button><button role="tab" data-filter="notebook" aria-selected="false">Notebooks</button></div><input class="lr-search" type="search" aria-label="Search notebooks" placeholder="Find a notebook…"></div>
      <div data-shelf></div><div class="lr-actions lr-export-actions"><button class="lr-button" data-export-books>Export notebooks</button><button class="lr-button" data-import-books>Import notebooks</button><input type="file" data-import-file accept="application/json,.json" hidden><button class="lr-button" data-sync>Sync now</button><span class="lr-sub" data-status></span></div>`;
    root.querySelector("[data-create]").onclick = () => document.getElementById("library-dialog").showModal();
    root.querySelector("[data-export-books]").onclick = exportNotebooks;
    root.querySelector("[data-import-books]").onclick = () => root.querySelector("[data-import-file]").click();
    root.querySelector("[data-import-file]").onchange = async (event) => {
      const file = event.target.files[0];
      event.target.value = "";
      if (!file) return;
      try {
        if (file.size > 50 * 1024 * 1024) throw new Error("Archive is too large");
        const archive = InkArchive.parse(await file.text());
        const planned = InkArchive.plan(archive, { existingIds: await InkStore.notebookIds(), uid: InkStore.uid });
        await InkStore.importNotebooks(planned);
        await shelf();
        notebookSync.nudge();
        DCC.toast("Imported notebooks. Existing books were preserved");
      } catch (error) {
        notify(error);
      }
    };
    root.querySelector("[data-sync]").onclick = () => {
      blocked = false;
      syncJournals().catch(notify);
      notebookSync.nudge(0);
    };
    root.querySelectorAll("[data-filter]").forEach(
      (button) =>
        (button.onclick = () => {
          filter = button.dataset.filter;
          root
            .querySelectorAll("[data-filter]")
            .forEach((b) => b.setAttribute("aria-selected", String(b.dataset.filter === filter)));
          paintShelf();
        })
    );
    root.querySelector(".lr-search").value = search;
    root.querySelector(".lr-search").oninput = (event) => {
      search = event.target.value;
      paintShelf();
    };
    root
      .querySelectorAll("[data-filter]")
      .forEach((b) => b.setAttribute("aria-selected", String(b.dataset.filter === filter)));
    paintShelf();
    status();
  }
  function paintShelf() {
    const books = [
      {
        id: "journals",
        title: "Journals",
        kind: "journal",
        cover: "journals",
        description: `${journals.length} daily entries`
      },
      ...notebooks.map((n) => ({ ...n, kind: "notebook", description: "Notebook" }))
    ];
    const visible = books.filter(
      (b) => (filter === "all" || b.kind === filter) && b.title.toLowerCase().includes(search.toLowerCase())
    );
    const host = root.querySelector("[data-shelf]");
    if (!host) return;
    host.innerHTML = visible.length
      ? `<div class="lr-shelf" data-layout="${DEFAULT_LAYOUT}">${visible.map((b) => `<button class="lr-book" data-open="${esc(b.id)}" aria-label="Open ${esc(b.title)}"><div class="lr-cover" style="--book-color:${COLORS[b.cover] || COLORS.slate}"><div class="lr-cover-top">${b.kind === "journal" ? "Daily journal" : "Notebook"}</div><div><div class="lr-cover-name">${esc(b.title)}</div><div class="lr-cover-note">${b.kind === "journal" ? "Your days, together" : "A place to think"}</div></div><span aria-hidden="true">▤</span></div><div class="lr-book-meta"><strong class="lr-book-title">${esc(b.title)}</strong><small>${esc(b.description)}</small></div></button>`).join("")}</div>`
      : '<div class="lr-empty"><h2>No matching notebooks</h2><p>Try another title, or create a notebook.</p></div>';
    host.querySelectorAll("[data-open]").forEach(
      (button) =>
        (button.onclick = () => {
          if (button.dataset.open === "journals") openJournals().catch(notify);
          else openNotebook(button.dataset.open).catch(notify);
        })
    );
  }
  async function openNotebook(id) {
    if (!(await flush())) return;
    entry?.destroy();
    entry = null;
    active = null;
    const nb = notebooks.find((n) => n.id === id);
    if (!nb) throw new Error("Notebook unavailable");
    root.innerHTML = `<nav class="lr-breadcrumb"><button data-library>Library</button><span>/ ${esc(nb.title)}</span></nav><iframe class="lr-notebook-frame" title="${esc(nb.title)} notebook" src="/library/notebook?notebook=${encodeURIComponent(id)}"></iframe>`;
    frame = root.querySelector("iframe");
    live.textContent = "";
    root.querySelector("[data-library]").onclick = async () => {
      try {
        if (frame?.contentWindow?.InkApp?.isBusy()) return;
        if (frame?.contentWindow?.InkApp && !(await frame.contentWindow.InkApp.savePage())) return;
        await shelf();
        notebookSync.nudge();
      } catch (error) {
        notify(error);
      }
    };
    const u = new URL(location.href);
    u.searchParams.set("notebook", id);
    history.replaceState({}, "", u);
  }
  async function getJournal(slug) {
    const local = await drafts.read(slug);
    if (local?.dirty || !navigator.onLine) {
      if (!local) throw new Error("Open this journal online once to keep an offline copy");
      return local;
    }
    try {
      return await drafts.cache(await api(path(slug)));
    } catch (error) {
      if ([401, 403].includes(error.status) || !local) throw error;
      notify(error);
      return local;
    }
  }
  async function openJournals(slug) {
    if (!(await flush())) return;
    const request = ++loadRequest;
    const target = slug || journals[0]?.slug;
    if (!target) {
      await createDay(today());
      return;
    }
    const record = await getJournal(target);
    if (request !== loadRequest) return;
    entry?.destroy();
    entry = null;
    active = record;
    version = 0;
    savedVersion = 0;
    root.innerHTML = `<nav class="lr-breadcrumb"><button data-library>Library</button><span>/ Journals</span></nav><div data-conflict></div><div class="lr-workspace"><aside class="lr-outline"><h2>Journals</h2><p class="lr-sub">Your days, together</p><button class="lr-button" data-today>Open today</button><div class="lr-month">Daily entries</div>${journals.map((n) => `<button class="lr-entry" data-entry="${esc(n.slug)}" aria-current="${n.slug === target}">${esc(n.frontmatter?.date || n.slug.split("/").pop())}${n.dirty ? "<span>Local changes waiting</span>" : ""}</button>`).join("")}</aside><section class="lr-editor"><select class="lr-mobile-date" aria-label="Journal date">${journals.map((n) => `<option value="${esc(n.slug)}" ${n.slug === target ? "selected" : ""}>${esc(n.frontmatter?.date || n.slug)}</option>`).join("")}</select><div class="lr-editor-head"><div><div class="lr-eyebrow">Daily entry</div><h2>${esc(record.frontmatter?.date ? dateLabel(record.frontmatter.date) : record.frontmatter?.title || target)}</h2><div class="lr-caption" data-status></div></div><div class="lr-actions"><button class="lr-button" data-save>Save</button><button class="lr-button" data-attach>Attach</button><button class="lr-button" data-export-entry>Export entry</button><button class="lr-button lr-today-mobile" data-new-day>Today</button></div></div><div data-format class="lr-actions"></div><div data-cover class="memory-story-cover"></div><div data-text class="memory-inline-story"></div><input data-file type="file" hidden></section></div>`;
    const upload = async (file) => {
      if (attaching) throw new Error("Wait for the current attachment");
      attaching = true;
      try {
        const form = new FormData();
        form.append("file", file, file.name);
        form.append("slug", target);
        return await api("/api/vault/attach", { method: "POST", body: form });
      } finally {
        attaching = false;
      }
    };
    const attach = async (file) => {
      const source = entry;
      try {
        const result = await upload(file);
        if (entry !== source) return;
        source.insert(result.markdown || `![${file.name.replace(/[\[\]]/g, "")} ](${result.ref})`);
        changed();
      } catch (error) {
        notify(error);
      }
    };
    entry = DCC.CompletionMemories.mountJournalEntry(
      root.querySelector("[data-cover]"),
      root.querySelector("[data-text]"),
      record.body,
      { notebook: true, onChange: changed, onAttachment: attach, onNotebookImage: upload,
        // Minimizing the full-screen sketchbook saves locally now, not after the debounce.
        onSketchMinimize: () => { flush(); } }
    );
    entry.mountFormatting(root.querySelector("[data-format]"));
    const dateControl = document.createElement("input");
    dateControl.type = "date";
    dateControl.className = "lr-date-input";
    dateControl.setAttribute("aria-label", "Open journal date");
    dateControl.value = record.frontmatter?.date || today();
    dateControl.onchange = () => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateControl.value)) createDay(dateControl.value).catch(notify);
    };
    root.querySelector("[data-format]").prepend(dateControl);
    const text = root.querySelector("[data-text]");
    text.setAttribute("role", "textbox");
    text.setAttribute("aria-label", "Journal text");
    text.setAttribute("aria-multiline", "true");
    root.querySelector("[data-collapse]").click();
    root.querySelector("[data-library]").onclick = () => shelf().catch(notify);
    root
      .querySelectorAll("[data-entry]")
      .forEach((b) => (b.onclick = () => openJournals(b.dataset.entry).catch(notify)));
    root.querySelector(".lr-mobile-date").onchange = (e) => openJournals(e.target.value).catch(notify);
    root.querySelector("[data-today]").onclick = root.querySelector("[data-new-day]").onclick = () =>
      createDay(today()).catch(notify);
    root.querySelector("[data-save]").onclick = async () => {
      if (await flush()) await syncJournals();
    };
    root.querySelector("[data-export-entry]").onclick = async () => {
      if (await flush())
        download(entry.readCommitted(), (record.frontmatter?.date || "journal") + ".md", "text/markdown");
    };
    root.querySelector("[data-attach]").onclick = () => root.querySelector("[data-file]").click();
    root.querySelector("[data-file]").onchange = (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (file) attach(file);
    };
    localLabel = record.dirty ? "Saved locally" : "Local copy ready";
    remoteLabel = record.conflict ? "Conflict: local draft kept" : record.dirty ? "Waiting to sync" : "Synced to vault";
    status();
    renderConflict();
    DCC.CompletionMemories.loadDayPhotos(record.frontmatter?.date)
      .then((photos) => {
        if (request === loadRequest) entry?.setPhotos(photos);
      })
      .catch(() => {});
    const u = new URL(location.href);
    u.searchParams.set("journal", target);
    history.replaceState({}, "", u);
    scheduleSync();
  }
  async function createDay(date) {
    if (!(await flush())) return;
    const slug = `journal/${date.slice(0, 4)}/${date}`;
    let record = await drafts.read(slug);
    if (!record) {
      if (navigator.onLine) {
        const daily = await api("/api/vault/daily", json("POST", { date }));
        record = await drafts.cache(daily.node);
      } else
        record = await drafts.put({
          slug,
          frontmatter: { type: "journal", title: date, date },
          body: "",
          hash: null,
          pendingCreate: true,
          dirty: true,
          revision: 1,
          updated: Date.now()
        });
    }
    await refresh();
    await openJournals(record.slug);
  }
  function renderConflict() {
    const host = root.querySelector("[data-conflict]");
    if (!host) return;
    host.replaceChildren();
    if (!active?.conflict) {
      if (active?.localConflicts?.length) {
        const notice = document.createElement("div");
        notice.className = "lr-notice";
        notice.textContent = "Earlier copies are kept on this device.";
        active.localConflicts.forEach((copy, index) => {
          const button = document.createElement("button");
          button.className = "lr-button";
          button.textContent = `Download earlier copy ${index + 1}`;
          button.onclick = () => download(copy.body, `journal-copy-${index + 1}.md`, "text/markdown");
          notice.append(button);
        });
        host.append(notice);
      }
      return;
    }
    host.innerHTML =
      '<div class="lr-notice" data-kind="conflict"><span>Your local draft is safe. The vault has a different version.</span><button class="lr-button" data-export-conflict>Download local draft</button><button class="lr-button" data-vault-copy>Read vault version</button></div>';
    host.querySelector("[data-export-conflict]").onclick = async () => {
      await flush();
      download(entry.readCommitted(), "journal-local-draft.md", "text/markdown");
    };
    for (const [index, copy] of (active.localConflicts || []).entries()) {
      const button = document.createElement("button");
      button.className = "lr-button";
      button.textContent = `Download other local copy ${index + 1}`;
      button.onclick = () => download(copy.body, `journal-local-copy-${index + 1}.md`, "text/markdown");
      host.querySelector(".lr-notice").append(button);
    }
    host.querySelector("[data-vault-copy]").onclick = async () => {
      try {
        if (!(await flush())) return;
        const slug = active.slug,
          revision = active.revision;
        const remote = await api(path(active.slug));
        const dialog = document.createElement("dialog");
        dialog.className = "lr-dialog";
        const title = document.createElement("h2");
        title.textContent = "Vault version";
        const pre = document.createElement("pre");
        pre.className = "lr-remote-copy";
        pre.textContent = remote.body;
        const close = document.createElement("button");
        close.className = "lr-button";
        close.textContent = "Close";
        close.onclick = () => {
          dialog.close();
          dialog.remove();
        };
        const useLocal = document.createElement("button");
        useLocal.className = "lr-button primary";
        useLocal.textContent = "Use local draft; keep a copy of this version";
        useLocal.onclick = async () => {
          try {
            if (active?.slug !== slug || !(await flush()) || active.revision !== revision)
              throw new Error("The draft changed. Close this dialog and review again");
            const resolved = await drafts.resolve(slug, revision, remote);
            if (!resolved) throw new Error("A newer local edit needs review");
            active = resolved;
            dialog.close();
            dialog.remove();
            renderConflict();
            await syncJournals();
          } catch (error) {
            notify(error);
          }
        };
        dialog.append(title, pre, useLocal, close);
        document.body.append(dialog);
        dialog.showModal();
      } catch (error) {
        notify(error);
      }
    };
  }
  let notebookSync;
  let warmTimer;
  async function warmJournals() {
    clearTimeout(warmTimer);
    if (blocked || !navigator.onLine || !drafts) return;
    for (const note of journals) {
      if (isBusy()) {
        warmTimer = setTimeout(warmJournals, 4000);
        return;
      }
      try {
        const cached = await drafts.read(note.slug);
        if (!cached || (!cached.dirty && note.hash && cached.hash !== note.hash))
          await drafts.cache(await api(path(note.slug)));
      } catch {
        return;
      }
    }
  }
  async function boot() {
    try {
      const key = "mycelium-ink-owner";
      try {
        const me = await api("/api/me");
        owner = String(me.workspaceId || (me.userId ? `user-${me.userId}` : ""));
        if (!owner) throw Object.assign(new Error("Account identity unavailable"), { status: 502 });
        localStorage.setItem(key, owner);
      } catch (error) {
        if (error.status) throw error;
        owner = localStorage.getItem(key);
        if (!owner) throw error;
      }
      InkStore.configureOwner(owner);
      await InkStore.open();
      drafts = JournalDrafts.create(owner);
      await drafts.list();
      notebookSync = InkSync.create({
        store: InkStore,
        strokes: InkStrokes,
        isBusy,
        onStatus: (s) => {
          if (!active && !frame) {
            remoteLabel =
              s.state === "clean"
                ? "Synced to vault"
                : s.state === "error"
                  ? s.message || "Offline"
                  : "Syncing notebooks";
            status();
          }
        }
      });
      notebookSync.start();
      await refresh();
      localLabel = "Local Library ready";
      remoteLabel = navigator.onLine ? "Vault connected" : "Offline";
      const url = new URL(location.href),
        requestedJournal = url.searchParams.get("journal"),
        requestedBook = url.searchParams.get("notebook");
      if (requestedJournal && requestedJournal.startsWith("journal/")) await openJournals(requestedJournal);
      else if (requestedBook && notebooks.some((n) => n.id === requestedBook)) await openNotebook(requestedBook);
      else await shelf();
      const dialog = document.getElementById("library-dialog");
      dialog.querySelector("[data-cancel]").onclick = () => dialog.close();
      dialog.querySelector("form").onsubmit = async (event) => {
        event.preventDefault();
        try {
          const title = dialog.querySelector("input").value.trim();
          if (!title) return;
          const nb = await InkStore.createNotebook(title, "slate");
          dialog.close();
          await refresh();
          await openNotebook(nb.id);
        } catch (error) {
          notify(error);
        }
      };
      scheduleSync(1000);
      // Warm only this account's journal sources, while no pen owns input.
      warmTimer = setTimeout(warmJournals, 8000);
      if ("serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.register("/ink-sw.js");
        const offer = () => {
          if (!registration.waiting) return;
          const update = document.createElement("button");
          update.className = "lr-button lr-update";
          update.textContent = "App update ready. Reload when saved";
          update.onclick = async () => {
            if (isBusy() || !(await flush())) return;
            registration.waiting?.postMessage({ type: "ACTIVATE_LIBRARY_UPDATE" });
            navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
          };
          document.body.append(update);
        };
        offer();
        registration.addEventListener("updatefound", () =>
          registration.installing?.addEventListener("statechange", offer)
        );
      }
      navigator.storage?.persist?.().catch(() => {});
    } catch (error) {
      root.innerHTML = `<div class="lr-empty"><h1>Library could not open</h1><p>${esc(error.message)}</p><a class="lr-button" href="/">Return to DCC</a></div>`;
    }
  }
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== frame?.contentWindow) return;
    if (event.data?.type === "dcc-library:back")
      shelf()
        .then(() => notebookSync.nudge())
        .catch(notify);
  });
  window.addEventListener("online", () => {
    blocked = false;
    retry = 0;
    scheduleSync(500);
    warmTimer = setTimeout(warmJournals, 5000);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flush();
    else scheduleSync(1000);
  });
  window.addEventListener("pagehide", () => flush());
  window.addEventListener("beforeunload", (event) => {
    if ((active && version !== savedVersion) || localFailure || attaching || frame?.contentWindow?.InkApp?.isDirty()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  document.addEventListener("DOMContentLoaded", boot);
})();
