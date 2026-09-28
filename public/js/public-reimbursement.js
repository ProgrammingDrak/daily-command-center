(function () {
  "use strict";

  const root = document.getElementById("reimbursement-share-root");
  const token = location.pathname.split("/").filter(Boolean).pop();
  let data = null;
  let signedIn = false;
  let selectedId = null;
  const METHODS = [
    ["bank_transfer", "Bank transfer"], ["credit_card", "Credit card"],
    ["debit_card", "Debit card"], ["cash", "Cash"], ["venmo", "Venmo"],
    ["zelle", "Zelle"], ["paypal", "PayPal"], ["cash_app", "Cash App"],
    ["apple_cash", "Apple Cash"], ["other", "Other"],
  ];
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
  const money = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((Number(value) || 0) / 100);
  const methodName = (value) => (METHODS.find((method) => method[0] === value) || [null, "Other"])[1];
  const methodOptions = (selected) => METHODS.map((method) => '<option value="' + method[0] + '"' + (method[0] === selected ? " selected" : "") + ">" + method[1] + "</option>").join("");

  async function request(method, url, body) {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || response.statusText);
    return result;
  }

  function providerUrl(person) {
    if (!data.repayToDetail || !person) return null;
    const detail = data.repayToDetail.trim();
    const amount = (person.outstandingCents / 100).toFixed(2);
    const note = encodeURIComponent(data.title);
    if (data.repayToMethod === "venmo") {
      return "https://venmo.com/?txn=pay&recipients=" + encodeURIComponent(detail.replace(/^@/, "")) + "&amount=" + amount + "&note=" + note;
    }
    if (data.repayToMethod === "paypal") {
      return "https://paypal.me/" + encodeURIComponent(detail.replace(/^@/, "")) + "/" + amount;
    }
    if (data.repayToMethod === "cash_app") {
      return "https://cash.app/$" + encodeURIComponent(detail.replace(/^\$/, "")) + "/" + amount;
    }
    return null;
  }

  function render() {
    const counterpartyFlow = data.direction === "i_owe";
    const people = counterpartyFlow
      ? (data.participants || []).slice(0, 1)
      : (data.participants || []).filter((person) => !person.isSelf);
    const selected = (data.participants || []).find((person) => person.id === selectedId) || null;
    const paid = data.status === "settled";
    const repayment = methodName(data.repayToMethod) + (data.repayToDetail ? ": " + data.repayToDetail : "");
    const provider = counterpartyFlow ? null : providerUrl(selected);
    root.innerHTML = '<section class="share-card">' +
      '<span class="eyebrow">From ' + esc(data.ownerName) + '</span>' +
      '<h1>' + esc(data.title) + '</h1>' +
      '<span class="status' + (paid ? " paid" : "") + '">' + (paid ? "Everyone has paid" : money(data.outstandingCents) + " still outstanding") + '</span>' +
      (data.detail ? '<p>' + esc(data.detail) + '</p>' : "") +
      '<div class="totals"><div><span>Expense</span><strong>' + money(data.totalCents) + '</strong></div>' +
      '<div><span>Paid back</span><strong>' + money(data.paidCents) + '</strong></div>' +
      '<div><span>Still due</span><strong>' + money(data.outstandingCents) + '</strong></div></div>' +
      '<div class="instructions"><strong>Repayment details</strong><p>' + esc(repayment) + '</p></div>' +
      (people.length ? '<h2>' + (counterpartyFlow ? "Did you pay for this?" : "Which person are you?") + '</h2><div class="people">' + people.map((person) => {
        const available = counterpartyFlow ? data.counterpartyAvailable : person.available;
        const label = counterpartyFlow ? data.counterpartyName : person.name;
        return '<button class="person' + (person.id === selectedId ? " selected" : "") + '" data-person="' + esc(person.id) + '"' + (available ? "" : " disabled") + ' type="button">' +
          '<div><strong>' + esc(label) + '</strong><span>' + (available ? (person.status === "paid" ? "Paid" : money(person.paidCents) + " recorded") : "Linked DCC account required") + '</span></div>' +
          '<b>' + money(person.outstandingCents) + '</b></button>';
      }).join("") + '</div>' : "") +
      '<section class="payment" id="share-payment"' + (selected ? "" : " hidden") + '>' +
      '<h2>' + (selected && selected.status === "paid" ? "This share is paid" : (counterpartyFlow ? "Record repayment" : "Pay your share")) + '</h2>' +
      (selected && selected.status !== "paid" ?
        '<p>' + (counterpartyFlow ? "The remaining repayment is " : "Your remaining share is ") + '<strong>' + money(selected.outstandingCents) + '</strong>.</p>' +
        '<div class="actions">' + (provider ? '<a class="pay-link" href="' + esc(provider) + '" target="_blank" rel="noopener">Open ' + esc(methodName(data.repayToMethod)) + '</a>' : "") +
        (signedIn && !(counterpartyFlow ? data.counterpartyAccountBound : selected.accountBound) ? '<button class="secondary" data-act="claim" type="button">Add this to my DCC</button>' : "") + '</div>' +
        '<form id="share-payment-form"><div class="form-grid"><label>Amount<input name="amount" type="number" min="0.01" step="0.01" value="' + (selected.outstandingCents / 100).toFixed(2) + '" required></label>' +
        '<label>How you paid<select name="method">' + methodOptions(data.repayToMethod) + '</select></label>' +
        '<label>Account or confirmation<input name="methodDetail" maxlength="160" placeholder="Optional"></label>' +
        '<label>Note<input name="note" maxlength="500" placeholder="Optional"></label></div>' +
        '<div class="actions"><button type="submit">' + (counterpartyFlow ? "I received this payment" : "I sent this payment") + '</button></div>' +
        '<p class="fine">' + (counterpartyFlow ? "This records repayment received." : "This records repayment. Your payment provider transfers the money.") + '</p>' +
        '<div class="form-status" role="status"></div></form>'
        : '<p>Nothing remains due for this share.</p>') + '</section>' +
      (!signedIn ? '<p class="fine">Sign in to show this balance inside your DCC account.</p>' : "") +
      '</section>';
  }

  async function load() {
    try {
      const result = await request("GET", "/api/public/reimbursements/" + encodeURIComponent(token));
      data = result.reimbursement;
      signedIn = result.signedIn;
      selectedId = data.viewerParticipantId || (data.viewerIsCounterparty ? data.participants[0]?.id : selectedId);
      render();
    } catch (error) {
      root.innerHTML = '<section class="share-card share-error"><strong>This reimbursement link is unavailable.</strong><p>' + esc(error.message) + '</p></section>';
    }
  }

  root.addEventListener("click", async (event) => {
    const person = event.target.closest("[data-person]");
    if (person) {
      selectedId = person.dataset.person;
      render();
      return;
    }
    const button = event.target.closest("[data-act=claim]");
    if (!button) return;
    button.disabled = true;
    try {
      await request("POST", "/api/public/reimbursements/" + encodeURIComponent(token) + "/claim", {
        participantId: data.direction === "i_owe" ? "counterparty" : selectedId,
      });
      await load();
    } catch (error) {
      button.disabled = false;
      alert(error.message || "Could not link this reimbursement.");
    }
  });

  root.addEventListener("submit", async (event) => {
    if (event.target.id !== "share-payment-form") return;
    event.preventDefault();
    const form = event.target;
    const status = form.querySelector(".form-status");
    const button = form.querySelector("button");
    button.disabled = true;
    status.textContent = "";
    try {
      await request("POST", "/api/public/reimbursements/" + encodeURIComponent(token) + "/payments", {
        participantId: selectedId,
        amountCents: Math.round(Number(form.elements.amount.value || 0) * 100),
        method: form.elements.method.value,
        methodDetail: form.elements.methodDetail.value,
        note: form.elements.note.value,
      });
      await load();
    } catch (error) {
      status.className = "form-status error";
      status.textContent = error.message || "Could not record payment.";
      button.disabled = false;
    }
  });

  load();
})();
