// Mycelium vault — resurfacing + weekly review panel (Phase B6).
//
// The phase that closes the loop: capture → organize → RESURFACE → connect →
// have ideas. One overlay with three stacked cards:
//   • Resurfaced — a weighted sample of notes worth re-seeing (GET /resurface),
//     each with WHY it came back + its timeline-thread neighbors;
//   • Inbox — the fleeting notes waiting to be filed, oldest first, with
//     one-action Promote / Merge into… / Archive;
//   • This week — the digest summary (orphans, unlinked suggestions, backlog)
//     with "Save this week's review" (POST /digest → notes/reviews/<week>.md).
//
// The tab (vault-tab.js) owns node state + surfaces; it hands us a small bridge:
// openSlug (switch tab + open a note) and linkMention (wire an unlinked mention).
// Promote defers to window.VaultEditor.openPromote. All sensitivity gating is
// server-side (a locked session's endpoints never return sensitive content).

(function () {
  let B = null;
  const esc = (s) => (B && B.esc ? B.esc(s) : String(s == null ? "" : s));
  const toast = (m, t) => (window.DCC && window.DCC.toast ? window.DCC.toast(m, t || "success") : void 0);
  const emojiFor = (type, sensitive) => (sensitive ? "🔒" : ((window.DCC && window.DCC.vaultTypeEmoji && window.DCC.vaultTypeEmoji[type]) || "📄"));
  const enc = (s) => encodeURIComponent(s).replace(/%2F/g, "/");

  function els() {
    return {
      overlay: document.getElementById("vault-review-overlay"),
      body: document.getElementById("vault-review-body"),
    };
  }
  function isOpen() { const o = document.getElementById("vault-review-overlay"); return o && !o.hidden; }

  function open() {
    const { overlay } = els();
    if (!overlay) return;
    overlay.hidden = false;
    render();
  }
  function close() {
    const { overlay } = els();
    if (overlay) overlay.hidden = true;
  }

  // Open a note and drop the overlay so the reading pane is visible behind it.
  function go(slug) {
    close();
    if (B && B.openSlug) B.openSlug(slug);
  }

  async function render() {
    const { body } = els();
    if (!body) return;
    body.innerHTML = `
      <section class="vault-rv-card" id="vault-rv-resurface"><div class="vault-rv-h">🔮 Resurfaced <span class="vault-rv-sub">notes worth re-seeing</span></div><div class="vault-rv-loading">Loading…</div></section>
      <section class="vault-rv-card" id="vault-rv-inbox"><div class="vault-rv-h">📥 Inbox <span class="vault-rv-sub">file the fleeting notes</span></div><div class="vault-rv-loading">Loading…</div></section>
      <section class="vault-rv-card" id="vault-rv-digest"><div class="vault-rv-h">🗓️ This week <span class="vault-rv-sub">orphans · unlinked · backlog</span></div><div class="vault-rv-loading">Loading…</div></section>`;
    renderResurface();
    renderInbox();
    renderDigest();
  }

  function reasonChips(reasons) {
    return (reasons || []).map((r) => `<span class="vault-rv-why vault-rv-why-${esc(r.kind)}">${esc(r.note)}</span>`).join("");
  }

  async function renderResurface() {
    const host = document.getElementById("vault-rv-resurface");
    if (!host) return;
    try {
      const r = await fetch("/api/vault/resurface?n=5");
      const data = await r.json();
      const picks = data.picks || [];
      const rows = picks.length ? picks.map((p) => {
        // excerpt arrives HTML-escaped from the server; neighbors/titles esc here.
        const neigh = (p.neighbors || []).map((n) =>
          `<span class="vault-rv-neighbor" data-slug="${esc(n.slug)}" title="${esc(n.slug)}">${emojiFor(n.type, false)} ${esc(n.title)}</span>`).join("");
        return `<div class="vault-rv-row">
          <div class="vault-rv-main">
            <div class="vault-rv-title" data-slug="${esc(p.slug)}"><span class="vault-rv-emoji">${emojiFor(p.type, p.sensitive)}</span>${esc(p.title)}</div>
            <div class="vault-rv-why-row">${reasonChips(p.reasons)}</div>
            ${p.excerpt ? `<div class="vault-rv-snip">${p.excerpt}</div>` : ""}
            ${neigh ? `<div class="vault-rv-neighbors">connects to ${neigh}</div>` : ""}
          </div>
        </div>`;
      }).join("") : `<div class="vault-rv-empty">Nothing to resurface yet — the vault is still young.</div>`;
      host.innerHTML = `<div class="vault-rv-h">🔮 Resurfaced <span class="vault-rv-sub">${picks.length} of ${data.pool || 0} · this day's pick</span></div>${rows}`;
      host.querySelectorAll(".vault-rv-title[data-slug], .vault-rv-neighbor[data-slug]").forEach((el) =>
        el.addEventListener("click", () => go(el.dataset.slug)));
    } catch { host.innerHTML = `<div class="vault-rv-h">🔮 Resurfaced</div><div class="vault-rv-empty">Could not load.</div>`; }
  }

  async function renderInbox() {
    const host = document.getElementById("vault-rv-inbox");
    if (!host) return;
    try {
      const r = await fetch("/api/vault/inbox");
      const data = await r.json();
      const items = data.items || [];
      const head = `<div class="vault-rv-h">📥 Inbox <span class="vault-rv-sub">${items.length} to file · oldest first</span></div>`;
      if (!items.length) {
        host.innerHTML = head + `<div class="vault-rv-empty vault-rv-celebrate">🎉 Inbox zero. Nothing waiting to be filed.</div>`;
        return;
      }
      host.innerHTML = head + items.map((it) => `
        <div class="vault-rv-inbox-row" data-slug="${esc(it.slug)}">
          <div class="vault-rv-main">
            <div class="vault-rv-title" data-slug="${esc(it.slug)}"><span class="vault-rv-emoji">💭</span>${esc(it.title)}</div>
            ${it.excerpt ? `<div class="vault-rv-snip">${it.excerpt}</div>` : ""}
            <div class="vault-rv-merge" hidden></div>
          </div>
          <div class="vault-rv-actions">
            <button class="vault-rv-act promote" data-act="promote" type="button" title="Give it a type and move it out of the inbox">Promote</button>
            <button class="vault-rv-act merge" data-act="merge" type="button" title="Append it to an existing note">Merge…</button>
            <button class="vault-rv-act archive" data-act="archive" type="button" title="Remove from inbox (fleeting notes are ephemeral)">Archive</button>
          </div>
        </div>`).join("");
      host.querySelectorAll(".vault-rv-title[data-slug]").forEach((el) =>
        el.addEventListener("click", () => go(el.dataset.slug)));
      host.querySelectorAll(".vault-rv-inbox-row").forEach((row) => {
        const slug = row.dataset.slug;
        row.querySelector('[data-act="promote"]').addEventListener("click", () => promote(slug));
        row.querySelector('[data-act="merge"]').addEventListener("click", () => toggleMerge(row, slug));
        row.querySelector('[data-act="archive"]').addEventListener("click", () => archive(slug));
      });
    } catch { host.innerHTML = `<div class="vault-rv-h">📥 Inbox</div><div class="vault-rv-empty">Could not load.</div>`; }
  }

  async function renderDigest() {
    const host = document.getElementById("vault-rv-digest");
    if (!host) return;
    try {
      const r = await fetch("/api/vault/digest");
      const d = await r.json();
      const orphans = d.orphans || { count: 0, top: [] };
      const unlinked = d.unlinked || [];
      const orphanList = orphans.top.length
        ? orphans.top.map((o) => `<span class="vault-rv-pill" data-slug="${esc(o.slug)}">${emojiFor(o.type, false)} ${esc(o.title)}</span>`).join("")
        : `<span class="vault-rv-muted">none 🎉</span>`;
      const unlinkedRows = unlinked.length
        ? unlinked.map((s) => `
          <div class="vault-rv-ul-row">
            <div class="vault-rv-ul-main">
              <span class="vault-rv-pill" data-slug="${esc(s.target.slug)}">${esc(s.target.title)}</span>
              <span class="vault-rv-muted">in</span>
              <span class="vault-rv-pill" data-slug="${esc(s.source.slug)}">${esc(s.source.title)}</span>
              ${s.snippet ? `<div class="vault-rv-snip">${s.snippet}</div>` : ""}
            </div>
            <button class="vault-rv-act link" data-src="${esc(s.source.slug)}" data-tgt="${esc(s.target.slug)}" type="button" title="Insert a [[wikilink]]">Link it</button>
          </div>`).join("")
        : `<div class="vault-rv-muted">No pending unlinked mentions.</div>`;
      const savedBtn = d.saved
        ? `<button class="vault-rv-savebtn" id="vault-rv-openreview" data-slug="${esc(d.slug)}" type="button">Open this week's review note ↗</button>`
        : "";
      host.innerHTML = `
        <div class="vault-rv-h">🗓️ ${esc(d.week || "This week")} <span class="vault-rv-sub">${d.saved ? "review saved" : "not saved yet"}</span></div>
        <div class="vault-rv-metric"><span class="vault-rv-metric-k">Orphans (${orphans.count})</span><div class="vault-rv-pills">${orphanList}</div></div>
        <div class="vault-rv-metric"><span class="vault-rv-metric-k">Unlinked suggestions</span><div class="vault-rv-ul">${unlinkedRows}</div></div>
        <div class="vault-rv-metric"><span class="vault-rv-metric-k">Inbox backlog</span> <span>${d.inboxBacklog || 0} fleeting note${d.inboxBacklog === 1 ? "" : "s"}</span></div>
        <div class="vault-rv-digest-foot">
          <button class="vault-rv-savebtn primary" id="vault-rv-save" type="button">${d.saved ? "Regenerate this week's review" : "Save this week's review"}</button>
          ${savedBtn}
        </div>`;
      host.querySelectorAll(".vault-rv-pill[data-slug]").forEach((el) => el.addEventListener("click", () => go(el.dataset.slug)));
      host.querySelectorAll(".vault-rv-act.link").forEach((b) =>
        b.addEventListener("click", async () => {
          b.disabled = true;
          if (B && B.linkMention) await B.linkMention(b.dataset.src, b.dataset.tgt);
          renderDigest();
        }));
      const saveBtn = host.querySelector("#vault-rv-save");
      if (saveBtn) saveBtn.addEventListener("click", saveReview);
      const openReview = host.querySelector("#vault-rv-openreview");
      if (openReview) openReview.addEventListener("click", () => go(openReview.dataset.slug));
    } catch { host.innerHTML = `<div class="vault-rv-h">🗓️ This week</div><div class="vault-rv-empty">Could not load.</div>`; }
  }

  // ── Inbox actions ──
  async function promote(slug) {
    try {
      const r = await fetch(`/api/vault/node/${enc(slug)}`);
      if (!r.ok) throw new Error("load");
      const node = await r.json();
      if (!window.VaultEditor) return;
      // The editor opens on top; when it saves it deletes the source inbox note
      // and fires vault-changed, which re-renders this panel's inbox card.
      window.VaultEditor.openPromote({ title: (node.frontmatter && node.frontmatter.title) || "", body: node.body || "", fromSlug: slug });
    } catch { toast("Could not open that note", "error"); }
  }

  function toggleMerge(row, slug) {
    const box = row.querySelector(".vault-rv-merge");
    if (!box) return;
    if (!box.hidden) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = `<input class="vault-rv-merge-in" type="search" placeholder="Merge into… (search a note)" autocomplete="off"><div class="vault-rv-merge-results"></div>`;
    const input = box.querySelector(".vault-rv-merge-in");
    const results = box.querySelector(".vault-rv-merge-results");
    let seq = 0;
    input.addEventListener("input", async () => {
      const q = input.value.trim();
      if (!q) { results.innerHTML = ""; return; }
      const my = ++seq;
      try {
        const r = await fetch(`/api/vault/search?q=${encodeURIComponent(q)}&mode=title&limit=8`);
        const data = await r.json();
        if (my !== seq) return;
        results.innerHTML = (data.results || []).filter((x) => x.slug !== slug).map((x) =>
          `<div class="vault-rv-merge-hit" data-slug="${esc(x.slug)}">${emojiFor(x.type, x.sensitive)} ${esc(x.title)} <span class="vault-rv-muted">${esc(x.slug)}</span></div>`).join("");
        results.querySelectorAll(".vault-rv-merge-hit").forEach((hit) =>
          hit.addEventListener("click", () => mergeInto(slug, hit.dataset.slug)));
      } catch { results.innerHTML = ""; }
    });
    setTimeout(() => input.focus(), 20);
  }

  async function mergeInto(sourceSlug, targetSlug) {
    try {
      const [sr, tr] = await Promise.all([fetch(`/api/vault/node/${enc(sourceSlug)}`), fetch(`/api/vault/node/${enc(targetSlug)}`)]);
      if (!sr.ok || !tr.ok) throw new Error("load");
      const src = await sr.json();
      const tgt = await tr.json();
      const srcTitle = (src.frontmatter && src.frontmatter.title) || sourceSlug.split("/").pop();
      const appended = (tgt.body || "").replace(/\s*$/, "") + `\n\n## From inbox: ${srcTitle}\n\n${src.body || ""}\n`;
      const put = await fetch(`/api/vault/node/${enc(targetSlug)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frontmatter: tgt.frontmatter, body: appended, expectedHash: tgt.hash, message: `merge ${sourceSlug} -> ${targetSlug}` }),
      });
      if (put.status === 409) { toast("That note changed — reopen and retry", "error"); return; }
      if (!put.ok) throw new Error("put");
      await fetch(`/api/vault/node/${enc(sourceSlug)}`, { method: "DELETE" });
      toast("Merged into " + targetSlug);
      renderInbox(); renderDigest();
    } catch { toast("Could not merge", "error"); }
  }

  async function archive(slug) {
    if (!window.confirm("Remove this fleeting note from the inbox? (It won't be kept.)")) return;
    try {
      const r = await fetch(`/api/vault/node/${enc(slug)}`, { method: "DELETE" });
      if (!r.ok) throw new Error("delete");
      toast("Archived");
      renderInbox(); renderDigest();
    } catch { toast("Could not archive", "error"); }
  }

  async function saveReview() {
    const btn = document.getElementById("vault-rv-save");
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    try {
      const r = await fetch("/api/vault/digest", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "save failed");
      toast("Saved " + d.slug);
      renderDigest();
    } catch (e) { toast(e.message, "error"); if (btn) { btn.disabled = false; btn.textContent = "Save this week's review"; } }
  }

  // ── Public API + wiring ──
  function init(bridge) {
    B = bridge || {};
    const openBtn = document.getElementById("vault-review-btn");
    if (openBtn) openBtn.addEventListener("click", () => (isOpen() ? close() : open()));
    const { overlay } = els();
    if (overlay) {
      const x = document.getElementById("vault-review-close");
      if (x) x.addEventListener("click", close);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    }
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen()) { e.preventDefault(); close(); } });
    // A write elsewhere (a promote save, an external edit) invalidates the panel.
    document.addEventListener("vault-changed", () => { if (isOpen()) render(); });
  }

  window.VaultReview = { init, open, close };
})();
