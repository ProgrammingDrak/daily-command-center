// Mycelium vault editor (Phase B2) — the write path for the tab.
//
// One modal serves three flows: zero-friction Capture (a fleeting inbox note),
// New (type picker -> template-prefilled form), and Edit (pencil on the reading
// pane, with an optimistic-lock hash). Free-string ontology tag picker, people
// autocomplete over person nodes, a body textarea with a markdown Preview
// toggle, `[[` wikilink autocomplete, and paste/drop/pick attachments that ride
// the gate-v2 /api/vault/attach route. Saves via POST /api/vault/create (new) or
// PUT /api/vault/node/* (edit, 409 on a stale hash). No build step.
//
// The tab owns the data; it hands us accessors via VaultEditor.init(). We fetch
// our own schema/templates (editor-specific) and call onSaved(slug) to refresh.

(function () {
  const esc = (s) => window.DCC.esc(s);
  const toast = (m, t) => (window.DCC && window.DCC.toast ? window.DCC.toast(m, t || "success") : void 0);

  let ctx = { getNodes: () => [], getTagColors: () => ({}), getUnmapped: () => "#9ca3af", onSaved: () => {} };
  let schemaCache = null;
  let overlay = null;
  let st = null; // current form state

  async function loadSchema() {
    if (schemaCache) return schemaCache;
    try { const r = await fetch("/api/vault/schema"); schemaCache = r.ok ? await r.json() : { types: [] }; }
    catch { schemaCache = { types: [] }; }
    return schemaCache;
  }
  function typeDef(schema, type) { return (schema.types || []).find((t) => t.type === type); }
  function todayIso() { return new Date().toISOString().slice(0, 10); }

  // ── overlay shell ──
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "vault-editor-overlay";
    overlay.className = "vault-ed-overlay";
    overlay.innerHTML = `<div class="vault-ed-card" role="dialog" aria-modal="true"><div class="vault-ed-inner"></div></div>`;
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", (e) => { if (overlay && overlay.classList.contains("open") && e.key === "Escape") close(); });
    document.body.appendChild(overlay);
    return overlay;
  }
  function inner() { return overlay.querySelector(".vault-ed-inner"); }
  function open() { ensureOverlay().classList.add("open"); }
  function close() { if (overlay) overlay.classList.remove("open"); st = null; }

  // ── Capture (fleeting) ──
  function openCapture() {
    ensureOverlay();
    inner().innerHTML = `
      <div class="vault-ed-head"><span class="vault-ed-title">Quick capture</span>
        <button class="vault-ed-x" type="button" aria-label="Close">×</button></div>
      <div class="vault-ed-hint">Dump the thought. It lands in <code>inbox/</code> as a fleeting note — file it later.</div>
      <input class="vault-ed-input" id="cap-title" placeholder="Optional title" autocomplete="off">
      <textarea class="vault-ed-body" id="cap-text" placeholder="What's on your mind?" rows="6"></textarea>
      <div class="vault-ed-foot"><button class="vault-ed-btn ghost" id="cap-cancel" type="button">Cancel</button>
        <button class="vault-ed-btn primary" id="cap-save" type="button">Capture</button></div>`;
    open();
    const text = inner().querySelector("#cap-text");
    setTimeout(() => text.focus(), 30);
    inner().querySelector(".vault-ed-x").onclick = close;
    inner().querySelector("#cap-cancel").onclick = close;
    const save = async () => {
      const body = text.value.trim();
      const title = inner().querySelector("#cap-title").value.trim();
      if (!body && !title) { toast("Nothing to capture", "error"); return; }
      try {
        const r = await fetch("/api/vault/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: body, title }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "capture failed");
        toast("Captured to inbox"); close(); ctx.onSaved(d.slug);
      } catch (e) { toast(e.message, "error"); }
    };
    inner().querySelector("#cap-save").onclick = save;
    // Cmd/Ctrl+Enter saves.
    text.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save(); });
  }

  // ── New: type picker then form ──
  async function openNew(type) {
    const schema = await loadSchema();
    if (!type) return pickType(schema);
    let tpl = { frontmatter: { type }, body: "" };
    try { const r = await fetch("/api/vault/template/" + encodeURIComponent(type)); if (r.ok) tpl = await r.json(); } catch {}
    const fm = Object.assign({}, tpl.frontmatter || {}, { type });
    if (!fm.date && (fm.date === "" || "date" in fm)) fm.date = todayIso();
    buildForm({ mode: "new", type, slug: null, hash: null, frontmatter: fm, body: tpl.body || "" });
  }

  function pickType(schema) {
    ensureOverlay();
    // Quick-creatable types only: hide placeholder-dir (dnd sessions, meetings)
    // and external-writer types. Common types float to the top.
    const TOP = ["fleeting", "note", "idea", "journal", "person", "worknote", "workout", "book", "project", "goal", "recipe", "trip", "budget"];
    const usable = (schema.types || []).filter((t) => !t.needsPath && !t.external);
    usable.sort((a, b) => {
      const ia = TOP.indexOf(a.type), ib = TOP.indexOf(b.type);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.type.localeCompare(b.type);
    });
    inner().innerHTML = `
      <div class="vault-ed-head"><span class="vault-ed-title">New note</span>
        <button class="vault-ed-x" type="button" aria-label="Close">×</button></div>
      <div class="vault-ed-hint">Pick a type — it decides where the note lives.</div>
      <div class="vault-ed-typegrid">${usable.map((t) =>
        `<button class="vault-ed-type${t.sensitive ? " sensitive" : ""}" data-type="${esc(t.type)}">
           ${t.sensitive ? "🔒 " : ""}${esc(t.type)}</button>`).join("")}</div>`;
    open();
    inner().querySelector(".vault-ed-x").onclick = close;
    inner().querySelectorAll(".vault-ed-type").forEach((b) => { b.onclick = () => openNew(b.dataset.type); });
  }

  // ── Edit ──
  function openEdit(node) {
    const fm = Object.assign({}, node.frontmatter || {});
    buildForm({ mode: "edit", type: fm.type || "note", slug: node.slug, hash: node.hash, frontmatter: fm, body: node.body || "" });
  }

  // ── The form ──
  function buildForm(s) {
    st = s;
    st.tags = Array.isArray(st.frontmatter.tags) ? st.frontmatter.tags.slice() : (st.frontmatter.tags ? [st.frontmatter.tags] : []);
    st.people = normalizePeople(st.frontmatter.people);
    ensureOverlay();
    const title = st.frontmatter.title || "";
    const date = st.frontmatter.date || st.frontmatter.created || "";
    const sensitiveType = !!(schemaCache && typeDef(schemaCache, st.type) && typeDef(schemaCache, st.type).sensitive);
    inner().innerHTML = `
      <div class="vault-ed-head">
        <span class="vault-ed-title">${st.mode === "edit" ? "Edit" : "New"} <span class="vault-ed-type-badge">${sensitiveType ? "🔒 " : ""}${esc(st.type)}</span></span>
        <button class="vault-ed-x" type="button" aria-label="Close">×</button>
      </div>
      ${st.mode === "edit" ? `<div class="vault-ed-slug">${esc(st.slug)}.md</div>` : ""}
      <div class="vault-ed-row"><input class="vault-ed-input" id="ed-title" placeholder="Title" value="${esc(title)}" autocomplete="off"></div>
      <div class="vault-ed-row two">
        <label class="vault-ed-field"><span>Date</span><input class="vault-ed-input" id="ed-date" type="date" value="${esc(String(date).slice(0, 10))}"></label>
      </div>
      <div class="vault-ed-row"><span class="vault-ed-lbl">Tags</span><div id="ed-tags" class="vault-ed-tags"></div></div>
      <div class="vault-ed-row"><span class="vault-ed-lbl">People</span><div id="ed-people" class="vault-ed-tags"></div></div>
      <div class="vault-ed-bodybar">
        <button class="vault-ed-tab-btn active" id="ed-write" type="button">Write</button>
        <button class="vault-ed-tab-btn" id="ed-preview" type="button">Preview</button>
        <span class="vault-ed-spacer"></span>
        <button class="vault-ed-attach" id="ed-attach" type="button" title="Attach image (paste or drop works too)">📎 Attach</button>
        <input type="file" id="ed-file" accept="image/*" hidden>
      </div>
      <textarea class="vault-ed-body" id="ed-body" rows="12" placeholder="Write in Markdown. Type [[ to link a note.">${esc(st.body)}</textarea>
      <div class="vault-ed-preview" id="ed-prev" hidden></div>
      <div class="vault-ed-foot">
        <span class="vault-ed-status" id="ed-status"></span>
        <button class="vault-ed-btn ghost" id="ed-cancel" type="button">Cancel</button>
        <button class="vault-ed-btn primary" id="ed-save" type="button">${st.mode === "edit" ? "Save" : "Create"}</button>
      </div>`;
    open();
    wireForm();
    setTimeout(() => inner().querySelector("#ed-title").focus(), 30);
  }

  function normalizePeople(v) {
    const list = Array.isArray(v) ? v : v ? [v] : [];
    return list.map((p) => {
      const m = String(p).match(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/);
      if (m) return { slug: m[1].trim(), name: (m[2] || m[1].split("/").pop()).trim() };
      return { slug: String(p), name: String(p).split("/").pop() };
    });
  }

  function wireForm() {
    const q = (sel) => inner().querySelector(sel);
    q(".vault-ed-x").onclick = close;
    q("#ed-cancel").onclick = close;

    renderTagPicker();
    renderPeoplePicker();

    // Body tabs: write / preview
    const body = q("#ed-body"), prev = q("#ed-prev");
    q("#ed-write").onclick = () => { q("#ed-write").classList.add("active"); q("#ed-preview").classList.remove("active"); body.hidden = false; prev.hidden = true; };
    q("#ed-preview").onclick = () => {
      q("#ed-preview").classList.add("active"); q("#ed-write").classList.remove("active");
      body.hidden = true; prev.hidden = false;
      let html = "";
      try { html = window.DOMPurify.sanitize(window.marked.parse(body.value || "*(empty)*")); }
      catch { html = "<pre>" + esc(body.value) + "</pre>"; }
      prev.innerHTML = html;
    };

    // Attach: button, paste, drop
    q("#ed-attach").onclick = () => q("#ed-file").click();
    q("#ed-file").onchange = (e) => { const f = e.target.files && e.target.files[0]; if (f) uploadAttachment(f); e.target.value = ""; };
    body.addEventListener("paste", (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const it of items) { if (it.kind === "file") { const f = it.getAsFile(); if (f) { e.preventDefault(); uploadAttachment(f); return; } } }
    });
    const card = overlay.querySelector(".vault-ed-card");
    card.addEventListener("dragover", (e) => { e.preventDefault(); card.classList.add("drag"); });
    card.addEventListener("dragleave", () => card.classList.remove("drag"));
    card.addEventListener("drop", (e) => {
      e.preventDefault(); card.classList.remove("drag");
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) uploadAttachment(f);
    });

    wireWikilinkAutocomplete(body);
    q("#ed-save").onclick = save;
  }

  // ── Tag picker (free ontology strings) ──
  function renderTagPicker() {
    const host = inner().querySelector("#ed-tags");
    const colors = ctx.getTagColors() || {};
    const unmapped = ctx.getUnmapped();
    const chip = (t) => {
      const c = colors[t] || unmapped;
      return `<span class="vault-ed-chip" style="background:${esc(c)}22;color:${esc(c)}">${esc(t)}<button data-t="${esc(t)}" class="chip-x" aria-label="remove">×</button></span>`;
    };
    host.innerHTML = st.tags.map(chip).join("") + `<input class="vault-ed-chipinput" id="ed-tag-in" placeholder="+ tag" autocomplete="off">`;
    host.querySelectorAll(".chip-x").forEach((b) => b.onclick = () => { st.tags = st.tags.filter((x) => x !== b.dataset.t); renderTagPicker(); });
    const input = host.querySelector("#ed-tag-in");
    const add = (val) => { const v = String(val || "").trim().replace(/^#/, ""); if (v && !st.tags.includes(v)) st.tags.push(v); renderTagPicker(); inner().querySelector("#ed-tag-in").focus(); };
    // Build the tag universe once here, not inside the per-keystroke itemsFn
    // (the vault grows for life; flatMap+Set every keystroke would churn).
    const tagUniverse = Array.from(new Set(ctx.getNodes().flatMap((n) => {
      const t = n.frontmatter && n.frontmatter.tags; return Array.isArray(t) ? t : t ? [t] : [];
    })));
    attachSuggest(input, () => tagUniverse.filter((t) => !st.tags.includes(t)), add);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(input.value); } });
  }

  // ── People picker (person nodes -> people: [[people/slug|Name]]) ──
  function renderPeoplePicker() {
    const host = inner().querySelector("#ed-people");
    host.innerHTML = st.people.map((p) =>
      `<span class="vault-ed-chip person">${esc(p.name)}<button data-s="${esc(p.slug)}" class="chip-x" aria-label="remove">×</button></span>`).join("") +
      `<input class="vault-ed-chipinput" id="ed-people-in" placeholder="+ person" autocomplete="off">`;
    host.querySelectorAll(".chip-x").forEach((b) => b.onclick = () => { st.people = st.people.filter((x) => x.slug !== b.dataset.s); renderPeoplePicker(); });
    const input = host.querySelector("#ed-people-in");
    const people = ctx.getNodes().filter((n) => (n.frontmatter && n.frontmatter.type) === "person");
    const add = (slug, name) => { if (slug && !st.people.some((p) => p.slug === slug)) st.people.push({ slug, name: name || slug.split("/").pop() }); renderPeoplePicker(); inner().querySelector("#ed-people-in").focus(); };
    attachSuggest(input,
      () => people.map((n) => ({ slug: n.slug, name: (n.frontmatter && n.frontmatter.title) || n.slug.split("/").pop() }))
        .filter((p) => !st.people.some((x) => x.slug === p.slug)),
      (item) => add(item.slug, item.name),
      (item) => item.name + "  ·  " + item.slug);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); const v = input.value.trim(); if (v) add("people/" + slugifyLocal(v), v); } });
  }

  // MUST stay byte-identical to routes/vault.js `slugify` (no build step means we
  // can't share it). It builds people-link targets (people/<slug>); if it drifts
  // from the server, a long/empty name yields a different slug than the person
  // node the server later creates, and the wikilink silently dangles. Mirror = the
  // .slice(0,80) cap + the "untitled" empty fallback too.
  function slugifyLocal(s) { return String(s).toLowerCase().trim().replace(/['"]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "untitled"; }

  // Generic suggestion dropdown for a chip input. itemsFn returns strings or
  // {slug,name} objects; label optional; onPick(item).
  function attachSuggest(input, itemsFn, onPick, labelFn) {
    let dd = null;
    const closeDD = () => { if (dd) { dd.remove(); dd = null; } };
    const render = () => {
      closeDD();
      const q = input.value.trim().toLowerCase();
      const all = itemsFn();
      const items = all.filter((it) => (typeof it === "string" ? it : it.name + " " + it.slug).toLowerCase().includes(q)).slice(0, 8);
      if (!items.length) return;
      dd = document.createElement("div");
      dd.className = "vault-ed-suggest";
      items.forEach((it) => {
        const el = document.createElement("div");
        el.className = "vault-ed-suggest-item";
        el.textContent = typeof it === "string" ? it : (labelFn ? labelFn(it) : it.name);
        el.onmousedown = (e) => { e.preventDefault(); onPick(it); closeDD(); };
        dd.appendChild(el);
      });
      input.parentNode.appendChild(dd);
    };
    input.addEventListener("input", render);
    input.addEventListener("focus", render);
    input.addEventListener("blur", () => setTimeout(closeDD, 120));
  }

  // ── Wikilink autocomplete: `[[` in the body opens a node picker ──
  function wireWikilinkAutocomplete(body) {
    let dd = null;
    const closeDD = () => { if (dd) { dd.remove(); dd = null; } };
    // Project the node list once per editor open, not per keystroke.
    const proj = ctx.getNodes().map((n) => ({ slug: n.slug, title: (n.frontmatter && n.frontmatter.title) || n.slug.split("/").pop() }));
    body.addEventListener("input", () => {
      const caret = body.selectionStart;
      const upto = body.value.slice(0, caret);
      const m = upto.match(/\[\[([^\]\n]*)$/); // an open [[ with no closing ]] yet
      if (!m) return closeDD();
      const q = m[1].toLowerCase();
      const nodes = proj
        .filter((n) => (n.slug + " " + n.title).toLowerCase().includes(q))
        .slice(0, 8);
      closeDD();
      if (!nodes.length) return;
      dd = document.createElement("div");
      dd.className = "vault-ed-suggest wl";
      nodes.forEach((n) => {
        const el = document.createElement("div");
        el.className = "vault-ed-suggest-item";
        el.innerHTML = `<strong>${esc(n.title)}</strong> <span class="sl">${esc(n.slug)}</span>`;
        el.onmousedown = (e) => {
          e.preventDefault();
          const link = n.title && n.title !== n.slug ? `[[${n.slug}|${n.title}]]` : `[[${n.slug}]]`;
          const start = caret - m[0].length;
          body.value = body.value.slice(0, start) + link + body.value.slice(caret);
          const pos = start + link.length;
          body.focus(); body.setSelectionRange(pos, pos);
          closeDD();
        };
        dd.appendChild(el);
      });
      // position under the textarea (simple: below the body box)
      body.parentNode.appendChild(dd);
      const r = body.getBoundingClientRect(), pr = body.parentNode.getBoundingClientRect();
      dd.style.top = (r.bottom - pr.top - 4) + "px";
      dd.style.left = "0px";
    });
    body.addEventListener("blur", () => setTimeout(closeDD, 120));
  }

  // ── Attachments ──
  async function uploadAttachment(file) {
    const statusEl = inner().querySelector("#ed-status");
    if (statusEl) statusEl.textContent = "Uploading " + (file.name || "attachment") + "…";
    const fd = new FormData();
    fd.append("file", file, file.name || "attachment");
    if (st && st.slug) fd.append("slug", st.slug); // sensitive routing when editing a sensitive node
    try {
      const r = await fetch("/api/vault/attach", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "attach failed");
      insertAtCaret(inner().querySelector("#ed-body"), `\n![${(d.filename || "image").replace(/[[\]]/g, "")}](${d.ref})\n`);
      if (statusEl) statusEl.textContent = d.band === "lfs" ? "Attached (LFS)" : "Attached";
      setTimeout(() => { if (statusEl) statusEl.textContent = ""; }, 2500);
    } catch (e) {
      if (statusEl) statusEl.textContent = "";
      toast(e.message, "error");
    }
  }
  function insertAtCaret(ta, text) {
    const s = ta.selectionStart || ta.value.length, e = ta.selectionEnd || ta.value.length;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    const pos = s + text.length; ta.focus(); ta.setSelectionRange(pos, pos);
  }

  // ── Save ──
  async function save() {
    const q = (sel) => inner().querySelector(sel);
    const title = q("#ed-title").value.trim();
    const date = q("#ed-date").value.trim();
    const bodyText = q("#ed-body").value;
    const saveBtn = q("#ed-save"); saveBtn.disabled = true;

    const fm = Object.assign({}, st.frontmatter);
    fm.type = st.type;
    if (title) fm.title = title; else delete fm.title;
    if (date) fm.date = date; else if (st.type !== "fleeting") delete fm.date;
    if (st.tags.length) fm.tags = st.tags; else delete fm.tags;
    if (st.people.length) fm.people = st.people.map((p) => `[[${p.slug}|${p.name}]]`); else delete fm.people;

    try {
      let res, data;
      if (st.mode === "edit") {
        res = await fetch("/api/vault/node/" + st.slug.split("/").map(encodeURIComponent).join("/"), {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ frontmatter: fm, body: bodyText, expectedHash: st.hash, message: `update ${st.slug}` }),
        });
        data = await res.json();
        if (res.status === 409) { saveBtn.disabled = false; toast("This note changed elsewhere — reload before saving", "error"); return; }
        if (!res.ok) throw new Error(data.error || "save failed");
        toast("Saved"); close(); ctx.onSaved(st.slug);
      } else {
        res = await fetch("/api/vault/create", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: st.type, title, frontmatter: fm, body: bodyText }),
        });
        data = await res.json();
        if (!res.ok) throw new Error(data.error || "create failed");
        toast("Created " + data.slug); close(); ctx.onSaved(data.slug);
      }
    } catch (e) { saveBtn.disabled = false; toast(e.message, "error"); }
  }

  window.VaultEditor = {
    init(c) { ctx = Object.assign(ctx, c || {}); },
    openCapture, openNew, openEdit,
  };
})();
