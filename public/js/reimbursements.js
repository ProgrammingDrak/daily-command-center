(function () {
  "use strict";

  const METHODS = [
    ["bank_transfer", "Bank transfer"],
    ["credit_card", "Credit card"],
    ["debit_card", "Debit card"],
    ["cash", "Cash"],
    ["venmo", "Venmo"],
    ["zelle", "Zelle"],
    ["paypal", "PayPal"],
    ["cash_app", "Cash App"],
    ["apple_cash", "Apple Cash"],
    ["other", "Other"],
  ];
  let _items = [];
  let _active = false;
  let _formOpen = false;
  let _loading = false;
  let _filter = "open";
  let _participantSeq = 2;

  const esc = (value) => window.DCC.esc(value);
  const money = (value) => new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format((Number(value) || 0) / 100);
  const methodName = (value) => (METHODS.find((method) => method[0] === value) || [null, "Other"])[1];
  const methodOptions = (selected) => METHODS.map((method) =>
    '<option value="' + method[0] + '"' + (method[0] === selected ? " selected" : "") + ">" + method[1] + "</option>"
  ).join("");

  async function api(method, url, body) {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  function setSections(view) {
    const home = document.getElementById("budget-home");
    const casino = document.getElementById("budget-casino");
    const tracker = document.getElementById("budget-reimbursements");
    const tankButton = document.getElementById("budget-tank-section-btn");
    const trackerButton = document.getElementById("budget-reimbursements-section-btn");
    const reimbursements = view === "reimbursements";
    if (home) home.hidden = reimbursements;
    if (casino) casino.hidden = true;
    if (tracker) tracker.hidden = !reimbursements;
    if (tankButton) {
      tankButton.classList.toggle("active", !reimbursements);
      tankButton.setAttribute("aria-pressed", String(!reimbursements));
    }
    if (trackerButton) {
      trackerButton.classList.toggle("active", reimbursements);
      trackerButton.setAttribute("aria-pressed", String(reimbursements));
    }
  }

  function showTank() {
    _active = false;
    setSections("tank");
    if (window.Budget && typeof Budget.render === "function") Budget.render();
  }

  function showTracker() {
    _active = true;
    setSections("reimbursements");
    load();
  }

  function visibleItems() {
    return _items.filter((item) => {
      if (_filter === "open") return item.status !== "settled";
      if (_filter === "receivable") return item.balanceKind === "receivable" && item.status !== "settled";
      if (_filter === "payable") return item.balanceKind === "payable" && item.status !== "settled";
      if (_filter === "settled") return item.status === "settled";
      return true;
    });
  }

  function summaryHtml() {
    const receivable = _items
      .filter((item) => item.balanceKind === "receivable")
      .reduce((sum, item) => sum + item.outstandingCents, 0);
    const payable = _items
      .filter((item) => item.balanceKind === "payable")
      .reduce((sum, item) => sum + item.outstandingCents, 0);
    const settled = _items.filter((item) => item.status === "settled").length;
    return '<div class="rb-summary">' +
      '<article><span>People owe you</span><strong>' + money(receivable) + '</strong></article>' +
      '<article><span>You owe</span><strong>' + money(payable) + '</strong></article>' +
      '<article><span>Settled</span><strong>' + settled + '</strong></article>' +
      '</div>';
  }

  function participantRow(person, item) {
    const label = person.isSelf && item.viewerRole === "owner" ? "Your share" : person.name;
    const lastPayment = person.payments && person.payments[person.payments.length - 1];
    const paymentText = person.status === "included"
      ? "Included in the original split"
      : lastPayment
      ? money(person.paidCents) + " paid via " + methodName(lastPayment.method) + (lastPayment.methodDetail ? ": " + lastPayment.methodDetail : "")
      : money(person.paidCents) + " paid of " + money(person.shareCents);
    const action = person.status === "included"
      ? '<span class="rb-paid-chip">Included</span>'
      : person.status === "paid"
      ? '<span class="rb-paid-chip">Paid</span>'
      : '<button class="rb-link" data-act="open-payment" data-id="' + esc(item.id) + '" data-participant="' + esc(person.id) + '" type="button">Record payment</button>';
    return '<div class="rb-person">' +
      '<div><strong>' + esc(label) + '</strong>' +
      '<span>' + esc(paymentText) + '</span></div>' +
      '<div><b>' + money(person.outstandingCents) + '</b>' + action + '</div>' +
      '</div>';
  }

  function paymentForm(item, participant) {
    const label = participant.isSelf && item.viewerRole === "owner" ? "you" : participant.name;
    return '<form class="rb-payment-form" data-payment-form data-id="' + esc(item.id) + '" data-participant="' + esc(participant.id) + '" hidden>' +
      '<strong>Record a payment from ' + esc(label) + '</strong>' +
      '<div class="rb-form-grid rb-form-grid--payment">' +
      '<label>Amount<input name="amount" type="number" min="0.01" step="0.01" value="' + (participant.outstandingCents / 100).toFixed(2) + '" required></label>' +
      '<label>Payment method<select name="method">' + methodOptions(item.repayToMethod || "venmo") + '</select></label>' +
      '<label>Account or detail<input name="methodDetail" maxlength="160" placeholder="Optional"></label>' +
      '<label>Note<input name="note" maxlength="500" placeholder="Optional"></label>' +
      '</div><div class="rb-form-actions"><button class="rb-primary" type="submit">Save payment</button>' +
      '<button class="rb-secondary" data-act="cancel-payment" type="button">Cancel</button></div>' +
      '<div class="rb-form-status" role="status"></div></form>';
  }

  function cardHtml(item) {
    const settled = item.status === "settled";
    const status = settled
      ? '<span class="rb-status rb-status--settled">All paid</span>'
      : '<span class="rb-status rb-status--open">' + money(item.outstandingCents) + ' outstanding</span>';
    const perspective = item.balanceKind === "receivable" ? "You are owed" : "You owe";
    const people = item.participants || [];
    const shareActions = item.viewerRole === "owner"
      ? (item.shareUrl
        ? '<button class="rb-secondary" data-act="copy-link" data-url="' + esc(item.shareUrl) + '" type="button">' + (item.direction === "owed_to_me" ? "Copy payment link" : "Copy tracking link") + '</button>' +
          '<button class="rb-link rb-link--danger" data-act="disable-share" data-id="' + esc(item.id) + '" type="button">Disable link</button>'
        : '<button class="rb-secondary" data-act="rotate-share" data-id="' + esc(item.id) + '" type="button">Create payment link</button>')
      : "";
    const archive = item.viewerRole === "owner"
      ? '<button class="rb-link" data-act="archive" data-id="' + esc(item.id) + '" type="button">Archive</button>'
      : "";
    const source = methodName(item.paidViaMethod) + (item.paidViaDetail ? ": " + item.paidViaDetail : "");
    const repay = methodName(item.repayToMethod) + (item.repayToDetail ? ": " + item.repayToDetail : "");
    return '<article class="rb-card' + (settled ? " rb-card--settled" : "") + '">' +
      '<header><div><span class="rb-eyebrow">' + perspective + '</span><h3>' + esc(item.title) + '</h3></div>' + status + '</header>' +
      '<div class="rb-card-meta"><span>Total ' + money(item.totalCents) + '</span>' +
      (item.purchaseDate ? '<span>' + esc(String(item.purchaseDate).slice(0, 10)) + '</span>' : "") +
      '<span>Paid using ' + esc(source) + '</span><span>Repay using ' + esc(repay) + '</span></div>' +
      (item.detail ? '<p>' + esc(item.detail) + '</p>' : "") +
      '<div class="rb-people">' + people.map((person) => participantRow(person, item)).join("") + '</div>' +
      people.map((person) => ["paid", "included"].includes(person.status) ? "" : paymentForm(item, person)).join("") +
      '<footer>' + shareActions + archive + '</footer></article>';
  }

  function formParticipantRow(index) {
    return '<div class="rb-split-person" data-split-person>' +
      '<label>Name<input data-field="name" maxlength="120" placeholder="Person ' + index + '"></label>' +
      '<label>Email <span>optional</span><input data-field="email" type="email" maxlength="320" placeholder="Links their DCC account"></label>' +
      '<label class="rb-split-value" hidden><span data-split-label>Share</span><input data-field="value" type="number" min="0" step="0.01"></label>' +
      '<button class="rb-icon" data-act="remove-person" type="button" aria-label="Remove person">&times;</button>' +
      '</div>';
  }

  function createFormHtml() {
    const today = new Date().toLocaleDateString("en-CA");
    return '<form class="rb-create" id="rb-create-form">' +
      '<div class="rb-create-head"><div><span class="rb-eyebrow">New reimbursement</span><h3>Who paid?</h3></div>' +
      '<button class="rb-icon" data-act="close-form" type="button" aria-label="Close form">&times;</button></div>' +
      '<div class="rb-direction" role="radiogroup" aria-label="Who paid">' +
      '<label><input type="radio" name="direction" value="owed_to_me" checked><span>I paid</span></label>' +
      '<label><input type="radio" name="direction" value="i_owe"><span>Someone paid for me</span></label></div>' +
      '<div class="rb-form-grid">' +
      '<label>Expense<input name="title" maxlength="160" placeholder="Dinner, tickets, hotel" required></label>' +
      '<label>Total expense<input name="total" type="number" min="0.01" step="0.01" required></label>' +
      '<label>Date<input name="purchaseDate" type="date" value="' + today + '"></label>' +
      '<label>How it was paid<select name="paidViaMethod">' + methodOptions("credit_card") + '</select></label>' +
      '<label>Bank, card, or account<input name="paidViaDetail" maxlength="160" placeholder="Chase Sapphire, Venmo"></label>' +
      '<label>How to repay<select name="repayToMethod">' + methodOptions("venmo") + '</select></label>' +
      '<label>Repayment account<input name="repayToDetail" maxlength="160" placeholder="@handle, email, bank"></label>' +
      '<label class="rb-full">Note<textarea name="detail" maxlength="2000" placeholder="Optional details"></textarea></label>' +
      '</div>' +
      '<section data-paid-by-me>' +
      '<div class="rb-split-head"><div><h4>Split the expense</h4><p>Include yourself or assign only repayable shares.</p></div>' +
      '<label class="rb-check"><input name="includeSelf" type="checkbox" checked> Include me</label></div>' +
      '<div class="rb-split-modes"><label><input type="radio" name="splitMode" value="equal" checked> Even split</label>' +
      '<label><input type="radio" name="splitMode" value="percentage"> Percentages</label>' +
      '<label><input type="radio" name="splitMode" value="amount"> Exact amounts</label></div>' +
      '<div class="rb-split-self" data-self-row><span>Your share</span><label class="rb-split-value" hidden><span data-split-label>Share</span><input name="selfValue" type="number" min="0" step="0.01"></label></div>' +
      '<div id="rb-split-people">' + formParticipantRow(1) + formParticipantRow(2) + '</div>' +
      '<button class="rb-secondary" data-act="add-person" type="button">Add person</button>' +
      '<div class="rb-split-preview" id="rb-split-preview">Enter the total to preview shares.</div>' +
      '</section>' +
      '<section data-someone-paid hidden><div class="rb-form-grid">' +
      '<label>Who paid?<input name="counterpartyName" maxlength="120" placeholder="Name"></label>' +
      '<label>Their email <span>optional</span><input name="counterpartyEmail" type="email" maxlength="320" placeholder="Links their DCC account"></label>' +
      '<label>Your share<input name="owed" type="number" min="0.01" step="0.01"></label>' +
      '</div></section>' +
      '<div class="rb-form-actions"><button class="rb-primary" type="submit">Create reimbursement</button>' +
      '<button class="rb-secondary" data-act="close-form" type="button">Cancel</button></div>' +
      '<div class="rb-form-status" role="status"></div></form>';
  }

  function render() {
    const root = document.getElementById("reimbursement-root");
    if (!root) return;
    const items = visibleItems();
    root.innerHTML = '<div class="rb-topline"><div><span class="rb-eyebrow">Budget</span>' +
      '<h2 id="reimbursement-title">Reimbursement tracker</h2>' +
      '<p>Track shared costs, repayments, and money you owe.</p></div>' +
      '<button class="rb-primary" data-act="open-form" type="button">Add reimbursement</button></div>' +
      summaryHtml() +
      '<nav class="rb-filters" aria-label="Reimbursement filters">' +
      [["open", "Open"], ["receivable", "Owed to me"], ["payable", "I owe"], ["settled", "Settled"], ["all", "All"]]
        .map((filter) => '<button class="' + (_filter === filter[0] ? "active" : "") + '" data-filter="' + filter[0] + '" type="button">' + filter[1] + '</button>').join("") +
      '</nav>' +
      (_formOpen ? createFormHtml() : "") +
      '<div class="rb-list">' + (items.length
        ? items.map(cardHtml).join("")
        : '<div class="rb-empty"><strong>No reimbursements here.</strong><span>Add one or choose another filter.</span></div>') + '</div>';
    if (_formOpen) refreshCreateForm();
  }

  function updateBadge() {
    const badge = document.getElementById("budget-reimbursement-badge");
    if (!badge) return;
    const count = _items.filter((item) => item.status !== "settled").length;
    badge.hidden = count === 0;
    badge.textContent = String(count);
  }

  async function load() {
    if (_loading) return;
    _loading = true;
    const root = document.getElementById("reimbursement-root");
    if (root && !_items.length) root.innerHTML = '<div class="rb-loading">Loading reimbursements…</div>';
    try {
      const data = await api("GET", "/api/reimbursements");
      _items = data.reimbursements || [];
      updateBadge();
      if (_active) render();
    } catch (error) {
      if (root && _active) root.innerHTML = '<div class="rb-empty rb-empty--error"><strong>Could not load reimbursements.</strong><span>' + esc(error.message) + '</span></div>';
    } finally {
      _loading = false;
    }
  }

  function refreshCreateForm() {
    const form = document.getElementById("rb-create-form");
    if (!form) return;
    const direction = form.elements.direction.value;
    const splitMode = form.elements.splitMode.value;
    const includeSelf = form.elements.includeSelf.checked;
    form.querySelector("[data-paid-by-me]").hidden = direction !== "owed_to_me";
    form.querySelector("[data-someone-paid]").hidden = direction !== "i_owe";
    form.querySelector("[data-self-row]").hidden = !includeSelf;
    form.querySelectorAll(".rb-split-value").forEach((field) => { field.hidden = splitMode === "equal"; });
    form.querySelectorAll("[data-split-label]").forEach((label) => {
      label.textContent = splitMode === "percentage" ? "Percent" : "Amount";
    });
    form.querySelectorAll("[data-field=value], [name=selfValue]").forEach((input) => {
      input.step = splitMode === "percentage" ? "0.01" : "0.01";
      input.placeholder = splitMode === "percentage" ? "%" : "$";
    });
    previewSplit(form);
  }

  function previewSplit(form) {
    const preview = form.querySelector("#rb-split-preview");
    if (!preview || form.elements.direction.value !== "owed_to_me") return;
    const totalCents = Math.round(Number(form.elements.total.value || 0) * 100);
    const people = Array.from(form.querySelectorAll("[data-split-person]"));
    const count = people.length + (form.elements.includeSelf.checked ? 1 : 0);
    if (!totalCents || !count) {
      preview.textContent = "Enter the total to preview shares.";
      preview.classList.remove("error");
      return;
    }
    const mode = form.elements.splitMode.value;
    if (mode === "equal") {
      preview.textContent = count + " shares of about " + money(Math.floor(totalCents / count)) + ".";
      preview.classList.remove("error");
      return;
    }
    const values = [];
    if (form.elements.includeSelf.checked) values.push(Number(form.elements.selfValue.value || 0));
    people.forEach((row) => values.push(Number(row.querySelector("[data-field=value]").value || 0)));
    const sum = values.reduce((value, part) => value + part, 0);
    const target = mode === "percentage" ? 100 : totalCents / 100;
    preview.textContent = (mode === "percentage" ? sum.toFixed(2) + "% of 100%" : "$" + sum.toFixed(2) + " of $" + target.toFixed(2));
    preview.classList.toggle("error", Math.abs(sum - target) > 0.005);
  }

  function collectCreatePayload(form) {
    const direction = form.elements.direction.value;
    const splitMode = form.elements.splitMode.value;
    const participants = Array.from(form.querySelectorAll("[data-split-person]")).map((row) => ({
      name: row.querySelector("[data-field=name]").value.trim(),
      email: row.querySelector("[data-field=email]").value.trim(),
      value: splitMode === "amount"
        ? Math.round(Number(row.querySelector("[data-field=value]").value || 0) * 100)
        : Number(row.querySelector("[data-field=value]").value || 0),
    })).filter((person) => person.name || person.email || person.value);
    return {
      direction,
      title: form.elements.title.value,
      totalCents: Math.round(Number(form.elements.total.value || 0) * 100),
      purchaseDate: form.elements.purchaseDate.value,
      paidViaMethod: form.elements.paidViaMethod.value,
      paidViaDetail: form.elements.paidViaDetail.value,
      repayToMethod: form.elements.repayToMethod.value,
      repayToDetail: form.elements.repayToDetail.value,
      detail: form.elements.detail.value,
      splitMode,
      includeSelf: form.elements.includeSelf.checked,
      selfValue: splitMode === "amount"
        ? Math.round(Number(form.elements.selfValue.value || 0) * 100)
        : Number(form.elements.selfValue.value || 0),
      participants,
      counterpartyName: form.elements.counterpartyName.value,
      counterpartyEmail: form.elements.counterpartyEmail.value,
      owedCents: Math.round(Number(form.elements.owed.value || 0) * 100),
    };
  }

  async function copyLink(url, button) {
    const full = new URL(url, location.origin).href;
    try {
      await navigator.clipboard.writeText(full);
      const old = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = old; }, 1200);
    } catch (error) {
      window.prompt("Copy this payment link", full);
    }
  }

  function bind() {
    const tank = document.getElementById("budget-tank-section-btn");
    const tracker = document.getElementById("budget-reimbursements-section-btn");
    if (tank && !tank.dataset.bound) {
      tank.dataset.bound = "1";
      tank.addEventListener("click", showTank);
    }
    if (tracker && !tracker.dataset.bound) {
      tracker.dataset.bound = "1";
      tracker.addEventListener("click", showTracker);
    }
    const root = document.getElementById("reimbursement-root");
    if (!root || root.dataset.bound) return;
    root.dataset.bound = "1";
    root.addEventListener("click", async (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      const action = button.dataset.act;
      if (button.dataset.filter) {
        _filter = button.dataset.filter;
        render();
        return;
      }
      if (action === "open-form") { _formOpen = true; render(); return; }
      if (action === "close-form") { _formOpen = false; render(); return; }
      if (action === "add-person") {
        _participantSeq += 1;
        root.querySelector("#rb-split-people").insertAdjacentHTML("beforeend", formParticipantRow(_participantSeq));
        refreshCreateForm();
        return;
      }
      if (action === "remove-person") {
        const rows = root.querySelectorAll("[data-split-person]");
        if (rows.length > 1) button.closest("[data-split-person]").remove();
        refreshCreateForm();
        return;
      }
      if (action === "copy-link") { await copyLink(button.dataset.url, button); return; }
      if (action === "open-payment") {
        const form = root.querySelector('[data-payment-form][data-id="' + CSS.escape(button.dataset.id) + '"][data-participant="' + CSS.escape(button.dataset.participant) + '"]');
        if (form) form.hidden = false;
        return;
      }
      if (action === "cancel-payment") { button.closest("[data-payment-form]").hidden = true; return; }
      try {
        if (action === "archive") {
          if (!confirm("Archive this reimbursement?")) return;
          await api("DELETE", "/api/reimbursements/" + encodeURIComponent(button.dataset.id));
        } else if (action === "disable-share") {
          await api("DELETE", "/api/reimbursements/" + encodeURIComponent(button.dataset.id) + "/share");
        } else if (action === "rotate-share") {
          const result = await api("POST", "/api/reimbursements/" + encodeURIComponent(button.dataset.id) + "/share/rotate", {});
          await copyLink(result.url, button);
        } else {
          return;
        }
        await load();
      } catch (error) {
        window.DCC.toast(error.message || "Could not update reimbursement", "error");
      }
    });
    root.addEventListener("change", (event) => {
      if (event.target.closest("#rb-create-form")) refreshCreateForm();
    });
    root.addEventListener("input", (event) => {
      const form = event.target.closest("#rb-create-form");
      if (form) previewSplit(form);
    });
    root.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target;
      const status = form.querySelector(".rb-form-status");
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      status.textContent = "";
      try {
        if (form.id === "rb-create-form") {
          await api("POST", "/api/reimbursements", collectCreatePayload(form));
          _formOpen = false;
        } else if (form.matches("[data-payment-form]")) {
          await api("POST", "/api/reimbursements/" + encodeURIComponent(form.dataset.id) + "/payments", {
            participantId: form.dataset.participant,
            amountCents: Math.round(Number(form.elements.amount.value || 0) * 100),
            method: form.elements.method.value,
            methodDetail: form.elements.methodDetail.value,
            note: form.elements.note.value,
          });
        }
        await load();
      } catch (error) {
        status.textContent = error.message || "Could not save reimbursement.";
        status.className = "rb-form-status error";
      } finally {
        submit.disabled = false;
      }
    });
    document.addEventListener("reimbursement-changed", load);
  }

  function activate() {
    bind();
    if (_active) showTracker();
    else {
      setSections("tank");
      load();
    }
  }

  bind();
  setInterval(() => {
    const visibleForm = document.querySelector("#budget-reimbursements form:not([hidden])");
    if (_active && !document.hidden && !visibleForm) load();
  }, 15000);
  window.Reimbursements = {
    activate,
    show: showTracker,
    reload: load,
    isActive: () => _active,
  };
  load();
})();
