// ======== BUDGET BATTLE PASS ========
// Sequential monthly spending tiers ("stones") instead of a single spend-vs-
// budget thermometer. Month-start lock-in (decision #1): the pool is set once
// at the top of the month; completing (or manually closing) a tier unlocks
// the next one in order. Under-spending a tier just closes it "under budget"
// — no rollover currency (decision #2). Going over the total monthly pool
// carries the overage into next month's pass as carry_debt, deducted
// automatically server-side when the next pass is created (decision #3).
(function () {
  let _month = null;
  let _pass = null;
  let _tiers = [];
  let _templates = [];
  let _expandedTierId = null;
  let _draftTiers = [];
  let _templateDropdown = null;
  let _savingTemplate = false;

  function esc(s) {
    if (s == null) return "";
    return (typeof escHtml === "function" ? escHtml(String(s)) : String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));
  }
  function fmtUSD(n) {
    const v = Math.round((Number(n) || 0) * 100) / 100;
    return "$" + v.toFixed(2);
  }
  function currentMonthStr() {
    const raw = (window.__DCC_STATE__ && window.__DCC_STATE__.date) || (typeof viewDate !== "undefined" && viewDate);
    const d = raw ? new Date(raw + "T12:00:00") : new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }
  function monthLabel(month) {
    const [y, m] = String(month || "").split("-").map(Number);
    if (!y || !m) return month || "";
    return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }
  function blankTierRow() {
    return { title: "", category: "", cap: "", tags: [] };
  }

  async function loadBudgetPass(month) {
    _month = month || currentMonthStr();
    try {
      const res = await fetch("/api/budget/pass?month=" + encodeURIComponent(_month));
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      _pass = data.pass || null;
      _tiers = (data.tiers || []).slice().sort((a, b) => a.sort_order - b.sort_order);
      _expandedTierId = (_tiers.find(t => (t.properties || {}).status === "active") || {}).id || null;
      if (!_pass && !_draftTiers.length) _draftTiers = [blankTierRow()];
    } catch (e) {
      _pass = null; _tiers = [];
      if (typeof showToast === "function") showToast("Could not load budget pass: " + (e.message || e), "error");
    }
    renderBudgetPass();
  }

  async function loadTemplates() {
    try {
      const res = await fetch("/api/budget/templates");
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      _templates = data.items || [];
    } catch (e) { _templates = []; }
  }

  // ── Render ──

  function renderBudgetPass() {
    const root = document.getElementById("budget-pass-root");
    if (!root) return;
    root.innerHTML = '<div class="bpp-root" id="bpp-inner"></div>';
    const inner = document.getElementById("bpp-inner");
    if (!_pass) renderSetup(inner);
    else renderPass(inner);
  }

  function renderSetup(root) {
    const templateOptions = [{ value: "", label: "Blank layout" }].concat(
      _templates.map(t => ({ value: String(t.id), label: (t.properties || {}).title || "Untitled", description: ((t.properties || {}).tiers || []).length + " tiers" }))
    );
    root.innerHTML =
      '<div class="bpp-header"><div>' +
        '<div class="bpp-month">Set up ' + esc(monthLabel(_month)) + '</div>' +
        '<div class="bpp-pool">No budget pass yet for this month.</div>' +
      '</div></div>' +
      '<div class="bpp-setup">' +
        '<div class="bpp-setup-grid">' +
          '<label class="bpp-field">Monthly pool<input type="number" min="0" step="1" id="bpp-pool-input" placeholder="e.g. 680"></label>' +
          '<div class="bpp-field">Start from template<div id="bpp-template-dd"></div></div>' +
        '</div>' +
        '<div class="bpp-tier-rows" id="bpp-tier-rows"></div>' +
        '<div class="bpp-setup-actions">' +
          '<button type="button" class="bpp-btn" id="bpp-add-tier">+ Add tier</button>' +
          '<div style="display:flex;gap:8px">' +
            '<button type="button" class="bpp-btn" id="bpp-save-template">Save as template</button>' +
            '<button type="button" class="bpp-btn primary" id="bpp-create-pass">Create pass</button>' +
          '</div>' +
        '</div>' +
        (_savingTemplate ?
          '<div class="bpp-spend-row"><input type="text" id="bpp-template-name" placeholder="Template name" autofocus>' +
            '<button type="button" class="bpp-btn primary" id="bpp-template-confirm">Save</button>' +
            '<button type="button" class="bpp-btn" id="bpp-template-cancel">Cancel</button></div>'
          : '') +
      '</div>';

    renderTierRows(document.getElementById("bpp-tier-rows"));

    const poolInput = document.getElementById("bpp-pool-input");
    poolInput.addEventListener("input", () => { poolInput.dataset.dirty = "1"; });

    _templateDropdown = new window.DccDropdown(document.getElementById("bpp-template-dd"), {
      options: templateOptions, value: "", placeholder: "Blank layout",
      onChange: (value) => {
        const tpl = _templates.find(t => String(t.id) === value);
        _draftTiers = tpl ? (tpl.properties.tiers || []).map(t => ({ title: t.title || "", category: t.category || "", cap: t.cap != null ? String(t.cap) : "", tags: t.tags || [] })) : [blankTierRow()];
        renderTierRows(document.getElementById("bpp-tier-rows"));
      }
    });

    document.getElementById("bpp-add-tier").addEventListener("click", () => {
      _draftTiers.push(blankTierRow());
      renderTierRows(document.getElementById("bpp-tier-rows"));
    });
    document.getElementById("bpp-save-template").addEventListener("click", () => {
      _savingTemplate = true;
      renderSetup(root);
    });
    if (_savingTemplate) {
      document.getElementById("bpp-template-confirm").addEventListener("click", saveAsTemplate);
      document.getElementById("bpp-template-cancel").addEventListener("click", () => { _savingTemplate = false; renderSetup(root); });
    }
    document.getElementById("bpp-create-pass").addEventListener("click", createPass);
  }

  function renderTierRows(mount) {
    if (!mount) return;
    mount.innerHTML = _draftTiers.map((t, i) =>
      '<div class="bpp-tier-row" data-index="' + i + '">' +
        '<input type="text" data-field="title" placeholder="Category name (e.g. Restaurants)" value="' + esc(t.title) + '">' +
        '<input type="text" data-field="category" placeholder="Tag / category" value="' + esc(t.category) + '">' +
        '<input type="number" min="0" step="1" data-field="cap" placeholder="$ cap" value="' + esc(t.cap) + '">' +
        '<button type="button" class="bpp-tier-remove" data-index="' + i + '" title="Remove tier">&times;</button>' +
      '</div>'
    ).join("");
    mount.querySelectorAll("input").forEach(inp => {
      inp.addEventListener("input", () => {
        const row = inp.closest(".bpp-tier-row");
        const idx = Number(row.dataset.index);
        _draftTiers[idx][inp.dataset.field] = inp.value;
      });
    });
    mount.querySelectorAll(".bpp-tier-remove").forEach(btn => {
      btn.addEventListener("click", () => {
        _draftTiers.splice(Number(btn.dataset.index), 1);
        if (!_draftTiers.length) _draftTiers.push(blankTierRow());
        renderTierRows(mount);
      });
    });
  }

  async function saveAsTemplate() {
    const nameInput = document.getElementById("bpp-template-name");
    const title = nameInput ? nameInput.value.trim() : "";
    if (!title) { if (typeof showToast === "function") showToast("Name the template first", "error"); return; }
    const tiers = _draftTiers.filter(t => t.title.trim()).map(t => ({ title: t.title.trim(), category: t.category, cap: Number(t.cap) || 0, tags: t.tags || [] }));
    if (!tiers.length) { if (typeof showToast === "function") showToast("Add at least one tier first", "error"); return; }
    try {
      const res = await fetch("/api/budget/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, tiers }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      _savingTemplate = false;
      await loadTemplates();
      renderBudgetPass();
      if (typeof showToast === "function") showToast("Template saved", "success");
    } catch (e) { if (typeof showToast === "function") showToast("Could not save template: " + (e.message || e), "error"); }
  }

  async function createPass() {
    const poolInput = document.getElementById("bpp-pool-input");
    const pool = Number(poolInput && poolInput.value);
    if (!Number.isFinite(pool) || pool < 0) { if (typeof showToast === "function") showToast("Enter a valid pool amount", "error"); return; }
    const tiers = _draftTiers.filter(t => t.title.trim()).map(t => ({ title: t.title.trim(), category: t.category, cap: Number(t.cap) || 0, tags: t.tags || [] }));
    if (!tiers.length) { if (typeof showToast === "function") showToast("Add at least one tier", "error"); return; }
    try {
      const res = await fetch("/api/budget/pass", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month: _month, pool, tiers }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      _draftTiers = [];
      await loadBudgetPass(_month);
      if (typeof showToast === "function") showToast("Budget pass created", "success");
    } catch (e) { if (typeof showToast === "function") showToast("Could not create pass: " + (e.message || e), "error"); }
  }

  // ── Active pass view ──

  function renderPass(root) {
    const p = _pass.properties || {};
    const effectivePool = Number(p.pool || 0) - Number(p.carry_debt || 0);
    root.innerHTML =
      '<div class="bpp-header"><div>' +
        '<div class="bpp-month">' + esc(monthLabel(p.month)) + '</div>' +
        '<div class="bpp-pool">' + fmtUSD(effectivePool) + ' to allocate' + (p.carry_debt ? ' (after carry debt)' : '') + '</div>' +
      '</div>' +
      (p.status === "complete" ? '<div class="bpp-header-actions"><button type="button" class="bpp-btn primary" id="bpp-next-month">Start next month</button></div>' : '') +
      '</div>' +
      (Number(p.carry_debt || 0) > 0 ? '<div class="bpp-debt-banner">&#9888; ' + fmtUSD(p.carry_debt) + ' carry debt from last month deducted</div>' : '') +
      '<div class="bpp-path" id="bpp-path"></div>' +
      '<div id="bpp-panel-mount"></div>' +
      (p.status === "complete" ? '<div class="bpp-celebrate"><h3>Pass complete &#127881;</h3><p>Every tier is closed for ' + esc(monthLabel(p.month)) + '.</p></div>' : '');

    renderStones(document.getElementById("bpp-path"));
    renderPanel(document.getElementById("bpp-panel-mount"));

    const nextBtn = document.getElementById("bpp-next-month");
    if (nextBtn) nextBtn.addEventListener("click", startNextMonth);
  }

  function stoneStateClass(status) {
    if (status === "completed") return "completed";
    if (status === "active") return "active";
    return "queued";
  }

  function renderStones(mount) {
    if (!mount) return;
    mount.innerHTML = _tiers.map((tier, i) => {
      const props = tier.properties || {};
      const state = stoneStateClass(props.status);
      const clickable = state === "completed" || state === "active";
      const icon = state === "completed" ? "&#10003;" : (i + 1);
      const connector = i > 0 ? '<div class="bpp-connector' + (_tiers[i - 1].properties.status === "completed" ? " filled" : "") + '"></div>' : "";
      return connector +
        '<div class="bpp-stone-wrap"><div class="bpp-stone ' + state + (clickable ? " clickable" : "") + '" data-tier-id="' + tier.id + '">' +
          '<div class="bpp-stone-circle">' + icon + '</div>' +
          '<div class="bpp-stone-name">' + esc(props.title) + '</div>' +
          '<div class="bpp-stone-amt">' + fmtUSD(props.spent) + ' / ' + fmtUSD(props.cap) + '</div>' +
        '</div></div>';
    }).join("");
    mount.querySelectorAll(".bpp-stone.clickable").forEach(el => {
      el.addEventListener("click", () => {
        const id = el.dataset.tierId;
        _expandedTierId = _expandedTierId === id ? null : id;
        renderPanel(document.getElementById("bpp-panel-mount"));
      });
    });
  }

  function renderPanel(mount) {
    if (!mount) return;
    const tier = _tiers.find(t => t.id === _expandedTierId);
    if (!tier) { mount.innerHTML = ""; return; }
    const props = tier.properties || {};
    const remaining = Number(props.cap || 0) - Number(props.spent || 0);
    const isActive = props.status === "active";
    const transactions = props.transactions || [];
    mount.innerHTML =
      '<div class="bpp-panel">' +
        '<div class="bpp-panel-head">' +
          '<div class="bpp-panel-title">' + esc(props.title) + '</div>' +
          '<div class="bpp-panel-remaining' + (remaining < 0 ? " over" : "") + '">' + fmtUSD(props.spent) + ' of ' + fmtUSD(props.cap) +
            (remaining >= 0 ? ' &middot; <b>' + fmtUSD(remaining) + '</b> left' : ' &middot; <b>' + fmtUSD(-remaining) + '</b> over') + '</div>' +
        '</div>' +
        (isActive ?
          '<div class="bpp-spend-row">' +
            '<input type="number" min="0.01" step="0.01" id="bpp-spend-amount" placeholder="Amount">' +
            '<input type="text" id="bpp-spend-note" placeholder="Note (optional)">' +
            '<button type="button" class="bpp-btn primary" id="bpp-spend-submit">Log spending</button>' +
            '<button type="button" class="bpp-btn danger" id="bpp-tier-close">Close tier</button>' +
          '</div>'
          : '<div class="bpp-panel-remaining">Closed ' + (props.completed_at ? new Date(props.completed_at).toLocaleDateString() : "") + '</div>') +
        (transactions.length ?
          '<div class="bpp-tx-list">' + transactions.slice().reverse().map(tx =>
            '<div class="bpp-tx"><span>' + esc(tx.note || "Spend") + '</span><b>' + fmtUSD(tx.amount) + '</b></div>'
          ).join("") + '</div>'
          : '') +
      '</div>';

    if (isActive) {
      document.getElementById("bpp-spend-submit").addEventListener("click", () => logSpend(tier.id));
      document.getElementById("bpp-spend-note").addEventListener("keydown", e => { if (e.key === "Enter") logSpend(tier.id); });
      document.getElementById("bpp-spend-amount").addEventListener("keydown", e => { if (e.key === "Enter") logSpend(tier.id); });
      document.getElementById("bpp-tier-close").addEventListener("click", () => closeTier(tier.id));
    }
  }

  // ── Actions ──

  async function logSpend(tierId) {
    const amountInput = document.getElementById("bpp-spend-amount");
    const noteInput = document.getElementById("bpp-spend-note");
    const amount = Number(amountInput && amountInput.value);
    if (!Number.isFinite(amount) || amount <= 0) { if (typeof showToast === "function") showToast("Enter a valid amount", "error"); return; }
    try {
      const res = await fetch("/api/budget/tier/" + tierId + "/spend", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, note: noteInput ? noteInput.value.trim() : "" })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const data = await res.json();
      if (data.unlockedNext) _expandedTierId = data.unlockedNext.id;
      await loadBudgetPass(_month);
      if (data.passCompleted && typeof celebrate === "function") celebrate();
    } catch (e) { if (typeof showToast === "function") showToast("Could not log spend: " + (e.message || e), "error"); }
  }

  async function closeTier(tierId) {
    try {
      const res = await fetch("/api/budget/tier/" + tierId + "/complete", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const data = await res.json();
      if (data.unlockedNext) _expandedTierId = data.unlockedNext.id;
      await loadBudgetPass(_month);
    } catch (e) { if (typeof showToast === "function") showToast("Could not close tier: " + (e.message || e), "error"); }
  }

  function startNextMonth() {
    const [y, m] = _month.split("-").map(Number);
    const d = new Date(y, m, 1); // JS month index m == next month (m is 1-indexed current)
    const next = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    _pass = null;
    _draftTiers = _tiers.map(t => ({ title: t.properties.title, category: t.properties.category, cap: String(t.properties.cap), tags: t.properties.tags || [] }));
    loadBudgetPass(next);
  }

  async function init() {
    await loadTemplates();
    await loadBudgetPass(currentMonthStr());
  }

  document.addEventListener("DOMContentLoaded", init);
  window.loadBudgetPass = loadBudgetPass;
  window.renderBudgetPass = renderBudgetPass;
})();
