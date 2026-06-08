/**
 * punishments.js — Punishments Wheel UI (flat weighted mirror of slots.js)
 *
 * A "Punishments" sub-tab inside the Slots tab. One flat list of punishments,
 * each with a "chances" weight; odds shown as chances ÷ total. A manual owed
 * counter ("I messed up") is paid down by spinning. Money punishments move the
 * shared bank balance.
 *
 * Self-wired: attaches its own click handlers and loads on DOMContentLoaded, so
 * it does not depend on slots.js internals. Panel show/hide is already handled
 * by slots.js applySlotSection() via the generic [data-slot-section-panel].
 */
(function () {
  let state = null;          // last /api/punishment/state payload
  let editingId = null;      // id being edited, or null for create
  let isSpinning = false;

  async function api(path, opts) {
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Punishment request failed");
    return data;
  }
  function postJSON(path, body) {
    return api(path, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  function toast(msg, kind) {
    if (typeof window.showToast === "function") window.showToast(msg, kind);
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function el(id) { return document.getElementById(id); }
  function dollars(cents) { return "$" + (Math.abs(Number(cents) || 0) / 100).toFixed(2); }

  async function load() {
    try {
      state = await api("/api/punishment/state");
      render();
    } catch (e) {
      console.error("Failed to load punishments", e);
    }
  }

  function render() {
    if (!state) return;
    renderOwed();
    renderPartner();
    renderList();
    renderQueue();
  }

  function renderOwed() {
    const owed = Number(state.owed) || 0;
    if (el("punish-owed-num")) el("punish-owed-num").textContent = owed;
    if (el("punish-bank")) el("punish-bank").textContent = dollars(state.bankBalanceCents);
    if (el("punish-monthly")) el("punish-monthly").textContent = dollars(state.monthlyGoalCents);
    const spinBtn = el("punish-spin-btn");
    if (spinBtn) {
      const canSpin = owed > 0 && (state.punishments || []).some((p) => p.active && (Number(p.chance_shares) || 0) > 0);
      spinBtn.disabled = isSpinning || !canSpin;
      spinBtn.textContent = isSpinning ? "Spinning…" : (owed > 0 ? `Spin the wheel (${owed})` : "Nothing owed");
    }
  }

  function renderPartner() {
    const linked = el("punish-partner-linked");
    const setup = el("punish-partner-setup");
    const p = state.partner;
    if (linked && setup) {
      if (p) {
        linked.hidden = false;
        setup.hidden = true;
        if (el("punish-partner-name")) el("punish-partner-name").textContent = p.username || "your partner";
        if (el("punish-partner-bank")) el("punish-partner-bank").textContent = dollars(p.bankBalanceCents);
        if (el("punish-partner-monthly")) el("punish-partner-monthly").textContent = dollars(p.monthlyGoalCents);
      } else {
        linked.hidden = true;
        setup.hidden = false;
      }
    }
  }

  function partnerMode() {
    const checked = document.querySelector('input[name="punish-partner-mode"]:checked');
    return checked ? checked.value : "create";
  }
  function syncPartnerMode() {
    const pwField = document.querySelector('[data-punish-field="password"]');
    if (pwField) pwField.style.display = partnerMode() === "link" ? "none" : "";
  }

  async function savePartner() {
    const mode = partnerMode();
    const username = el("punish-partner-username") ? el("punish-partner-username").value.trim() : "";
    const password = el("punish-partner-password") ? el("punish-partner-password").value : "";
    if (!username) { toast("Enter a partner username", "error"); return; }
    try {
      await postJSON("/api/punishment/partner", { mode, username, password });
      if (el("punish-partner-password")) el("punish-partner-password").value = "";
      await load();
      toast("Partner linked");
    } catch (e) { toast(e.message || "Could not link partner", "error"); }
  }

  async function unlinkPartner() {
    if (!window.confirm("Unlink this partner? Money punishments will stop paying them.")) return;
    try {
      await api("/api/punishment/partner", { method: "DELETE" });
      await load();
    } catch (e) { toast(e.message || "Failed", "error"); }
  }

  function oddsText(p) {
    const chances = Number(p.chance_shares) || 0;
    const pct = p.active ? (Number(p.odds) || 0) * 100 : 0;
    if (!p.active) return chances + " chances · inactive";
    return chances + " chances · ~" + (pct < 1 && pct > 0 ? pct.toFixed(1) : Math.round(pct)) + "%";
  }

  function cardHtml(p) {
    const money = (Number(p.bank_delta_cents) || 0) !== 0
      ? `<span class="punish-chip money">${esc(dollars(p.bank_delta_cents))}</span>` : "";
    return (
      `<div class="slot-reward-row slot-reward-card ${p.active ? "" : "locked"}" data-id="${p.id}">` +
        `<div class="slot-reward-main">` +
          `<div class="slot-reward-title">${esc(p.title)}</div>` +
          `<div class="slot-reward-meta">` +
            `<span>${esc(oddsText(p))}</span>` + money +
            (p.times_landed ? `<span class="punish-chip">landed ${p.times_landed}×</span>` : "") +
          `</div>` +
        `</div>` +
        `<div class="slot-reward-actions">` +
          `<button class="slot-mini punish-edit" data-id="${p.id}">Edit</button>` +
          `<button class="slot-mini danger punish-delete" data-id="${p.id}">Delete</button>` +
        `</div>` +
      `</div>`
    );
  }

  function renderList() {
    const list = el("punish-list");
    if (!list) return;
    const items = state.punishments || [];
    list.innerHTML = items.length
      ? items.map(cardHtml).join("")
      : `<div class="reward-review-empty">No punishments yet. Add a few so the wheel has teeth.</div>`;
    list.querySelectorAll(".punish-edit").forEach((btn) =>
      btn.addEventListener("click", () => openForm(findPunishment(btn.dataset.id))));
    list.querySelectorAll(".punish-delete").forEach((btn) =>
      btn.addEventListener("click", () => del(btn.dataset.id)));
  }

  function renderQueue() {
    const wrap = el("punish-queue-wrap");
    const queue = el("punish-queue");
    if (!wrap || !queue) return;
    const pending = (state.spins || []).filter((s) => s.status === "pending");
    if (!pending.length) { wrap.hidden = true; queue.innerHTML = ""; return; }
    wrap.hidden = false;
    queue.innerHTML = pending.map((s) => {
      const snap = s.punishment_snapshot || {};
      const money = (Number(s.bank_delta_cents) || 0) !== 0
        ? ` · paid ${esc(dollars(s.bank_delta_cents))}` : "";
      return (
        `<div class="punish-queue-row" data-id="${s.id}">` +
          `<div class="punish-queue-title">${esc(snap.title || "Punishment")}${money}</div>` +
          `<button class="slot-mini punish-done" data-id="${s.id}">Mark done</button>` +
        `</div>`
      );
    }).join("");
    queue.querySelectorAll(".punish-done").forEach((btn) =>
      btn.addEventListener("click", () => markDone(btn.dataset.id)));
  }

  function findPunishment(id) {
    return (state.punishments || []).find((p) => String(p.id) === String(id)) || null;
  }

  // ── Owe + spin ──
  async function owe() {
    try {
      await postJSON("/api/punishment/owe", { count: 1 });
      await load();
    } catch (e) { toast(e.message || "Failed", "error"); }
  }

  async function spin() {
    if (isSpinning) return;
    isSpinning = true;
    renderOwed();
    const resultEl = el("punish-result");
    if (resultEl) { resultEl.textContent = "Spinning…"; resultEl.classList.add("spinning"); }
    try {
      const res = await postJSON("/api/punishment/spin");
      const snap = (res.spin && res.spin.punishment_snapshot) || (res.punishment || {});
      const title = snap.title || (res.punishment && res.punishment.title) || "Punishment";
      const delta = Number(res.spin && res.spin.bank_delta_cents) || 0;
      const partnerName = res.partner && res.partner.username;
      if (resultEl) {
        resultEl.classList.remove("spinning");
        let money = "";
        if (delta !== 0) {
          const label = partnerName ? `${dollars(delta)} → ${partnerName}` : `${dollars(delta)} from your bank`;
          money = ` <span class="punish-chip money">${esc(label)}</span>`;
        }
        resultEl.innerHTML = `<span class="punish-result-label">You got:</span> <b>${esc(title)}</b>` + money;
      }
      await load();
    } catch (e) {
      if (resultEl) { resultEl.classList.remove("spinning"); resultEl.textContent = e.message || "Spin failed"; }
      toast(e.message || "Spin failed", "error");
    } finally {
      isSpinning = false;
      renderOwed();
    }
  }

  async function markDone(id) {
    try {
      await postJSON(`/api/punishment/spins/${id}/done`);
      await load();
    } catch (e) { toast(e.message || "Failed", "error"); }
  }

  // ── Editor form ──
  function openForm(p) {
    editingId = p ? p.id : null;
    const form = el("punish-form");
    if (!form) return;
    form.style.display = "";
    if (el("punish-form-heading")) el("punish-form-heading").textContent = p ? "Edit punishment" : "New punishment";
    if (el("punish-form-title")) el("punish-form-title").value = p ? p.title : "";
    if (el("punish-form-chances")) el("punish-form-chances").value = p ? (Number(p.chance_shares) || 0) : 10;
    if (el("punish-form-amount")) el("punish-form-amount").value = p && p.bank_delta_cents ? (Math.abs(p.bank_delta_cents) / 100) : "";
    if (el("punish-form-active")) el("punish-form-active").checked = p ? p.active !== false : true;
    if (el("punish-form-notes")) el("punish-form-notes").value = p ? (p.notes || "") : "";
    updateOddsHint();
    const t = el("punish-form-title");
    if (t) t.focus();
  }

  function closeForm() {
    editingId = null;
    const form = el("punish-form");
    if (form) form.style.display = "none";
  }

  // Mirror of slots.js updateOddsHint: chances ÷ Σ active chances (excluding the
  // row being edited, plus the value currently typed) → live percentage.
  function updateOddsHint() {
    const note = el("punish-form-odds-note");
    if (!note) return;
    const typed = Math.max(0, parseInt(el("punish-form-chances") && el("punish-form-chances").value, 10) || 0);
    let othersTotal = 0;
    (state && state.punishments || []).forEach((p) => {
      if (!p.active) return;
      if (editingId != null && String(p.id) === String(editingId)) return;
      othersTotal += Number(p.chance_shares) || 0;
    });
    const total = othersTotal + typed;
    if (typed <= 0 || total <= 0) { note.textContent = "Odds = chances ÷ total."; return; }
    const pct = (typed / total) * 100;
    note.textContent = `~${pct < 1 ? pct.toFixed(1) : Math.round(pct)}% of spins (${typed} of ${total}).`;
  }

  async function save() {
    const payload = {
      title: el("punish-form-title") ? el("punish-form-title").value : "",
      chance_shares: el("punish-form-chances") ? el("punish-form-chances").value : 0,
      amount_dollars: el("punish-form-amount") ? el("punish-form-amount").value : 0,
      active: el("punish-form-active") ? el("punish-form-active").checked : true,
      notes: el("punish-form-notes") ? el("punish-form-notes").value : "",
    };
    const path = editingId ? `/api/punishment/punishments/${editingId}` : "/api/punishment/punishments";
    const method = editingId ? "PUT" : "POST";
    try {
      await api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const wasEdit = !!editingId;
      closeForm();
      await load();
      toast(wasEdit ? "Punishment updated" : "Punishment added");
    } catch (e) {
      toast(e.message || "Save failed", "error");
    }
  }

  async function del(id) {
    if (!window.confirm("Delete this punishment?")) return;
    try {
      await api(`/api/punishment/punishments/${id}`, { method: "DELETE" });
      await load();
    } catch (e) { toast(e.message || "Delete failed", "error"); }
  }

  function wire() {
    // Render whenever the Punishments sub-tab is opened (slots.js handles the
    // panel visibility; we just refresh data).
    document.querySelectorAll('.slot-section-tab[data-slot-section="punishments"]').forEach((btn) =>
      btn.addEventListener("click", () => { if (!state) load(); else render(); }));
    if (el("punish-owe-btn")) el("punish-owe-btn").addEventListener("click", owe);
    if (el("punish-spin-btn")) el("punish-spin-btn").addEventListener("click", spin);
    if (el("punish-add-btn")) el("punish-add-btn").addEventListener("click", () => openForm(null));
    if (el("punish-save-btn")) el("punish-save-btn").addEventListener("click", save);
    if (el("punish-cancel-btn")) el("punish-cancel-btn").addEventListener("click", closeForm);
    if (el("punish-close-form")) el("punish-close-form").addEventListener("click", closeForm);
    if (el("punish-form-chances")) el("punish-form-chances").addEventListener("input", updateOddsHint);
    if (el("punish-partner-save")) el("punish-partner-save").addEventListener("click", savePartner);
    if (el("punish-partner-unlink")) el("punish-partner-unlink").addEventListener("click", unlinkPartner);
    document.querySelectorAll('input[name="punish-partner-mode"]').forEach((r) =>
      r.addEventListener("change", syncPartnerMode));
    syncPartnerMode();
    // A spin, owe, edit, or a partner's wheel paying into your bank broadcasts
    // punishment-changed over SSE. Refresh an already-open panel so owed/balance
    // stay live across tabs and partners (mirrors rewards-queue's slot-changed).
    document.addEventListener("punishment-changed", () => { if (state) load(); });
    load();
  }

  window.Punishments = { load, render };
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
