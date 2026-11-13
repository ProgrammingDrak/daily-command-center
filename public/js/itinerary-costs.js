(function () {
  const Costs = window.DCC.TaskCosts;

  function append(parent, tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    parent.append(node);
    return node;
  }

  function action(parent, label, handler) {
    const node = append(parent, "button", label);
    node.type = "button";
    node.onclick = handler;
    return node;
  }

  function field(parent, label, value, options = {}) {
    const node = append(append(parent, "label", label), "input");
    Object.assign(node, options);
    node.value = value ?? "";
    return node;
  }

  function categoryField(parent, label, value, listId) {
    const input = field(parent, label, value, { maxLength: 120, placeholder: "Select or type a category" });
    input.setAttribute("list", listId);
    return input;
  }

  function readCosts(raw) {
    try { return Costs.transactions(raw); }
    catch (_) { return []; }
  }

  function heading(entries) {
    const total = Costs.summary(entries);
    return "Transactions" + (total ? " · " + total : "");
  }

  function receipt(parent, url) {
    if (!url) return;
    const link = append(parent, "a", "Receipt or confirmation ↗");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }

  function amountText(amount, currency) {
    if (amount === undefined) return "";
    const precision = Costs.digits(currency);
    return (amount / 10 ** precision).toFixed(precision);
  }

  function renderList(parent, entries, onEdit, editingId) {
    if (!entries.length) return;
    const titles = append(parent, "div", "", "it-transaction-row it-transaction-head");
    for (const label of ["Merchant", "Category", "Amount"]) append(titles, "span", label);
    for (const entry of entries) {
      const row = append(parent, "details", "", "it-transaction");
      const summary = append(row, "summary", "", "it-transaction-row");
      const description = append(summary, "span");
      append(description, "strong", entry.merchant);
      if (entry.date) append(description, "small", entry.date);
      append(summary, "span", entry.category || "Split · " + entry.splits.length);
      if (entry.id === editingId) row.open = true;
      const amount = entry.amountMinor === undefined ? "Confirmation" : Costs.format(entry.amountMinor, entry.currency);
      append(summary, "strong", amount, "it-transaction-amount");
      const body = append(row, "div", "", "it-transaction-detail");
      for (const line of entry.splits || []) {
        const split = append(body, "div", "", "it-transaction-split");
        const label = append(split, "span", line.name);
        append(label, "small", line.category);
        append(split, "strong", Costs.format(line.amountMinor, entry.currency), "it-transaction-amount");
        receipt(split, line.receiptUrl);
      }
      if (entry.note) append(body, "p", entry.note);
      receipt(body, entry.receiptUrl);
      if (onEdit) action(body, "Edit transaction", () => onEdit(entry));
    }
  }

  function renderForm(panel, entry, entries, defaultDate, submit, cancel) {
    const form = append(panel, "form", "", "it-cost-form");
    form.noValidate = true;
    append(form, "strong", entry ? "Edit row" : "New row");
    const fields = append(form, "div", "", "it-cost-inline-fields");
    const merchant = field(fields, "Merchant", entry?.merchant, { maxLength: 120, placeholder: "Merchant" });
    const suggestions = append(form, "datalist");
    suggestions.id = "it-cost-categories-" + crypto.randomUUID();
    const categories = new Set(Costs.categories);
    for (const other of entries) {
      if (other.category) categories.add(other.category);
      for (const line of other.splits || []) categories.add(line.category);
    }
    for (const category of categories) append(suggestions, "option").value = category;
    const category = categoryField(fields, "Category", entry?.category, suggestions.id);
    category.placeholder = "Category";
    const amount = field(fields, "Amount", amountText(entry?.amountMinor, entry?.currency), { inputMode: "decimal", maxLength: 16, placeholder: "0" });
    const currency = append(append(form, "label", "Currency"), "select");
    currency.setAttribute("aria-label", "Currency");
    for (const code of Costs.currencies) append(currency, "option", code).value = code;
    currency.value = entry?.currency || entries[0]?.currency || "USD";
    const splitToggle = field(form, "Split into items", "yes", { type: "checkbox", checked: Boolean(entry?.splits) });
    splitToggle.parentElement.className = "it-cost-checkbox";
    const group = append(form, "div", "", "it-cost-form");
    const rows = append(group, "div", "", "it-cost-form");
    const balance = append(group, "p");
    balance.setAttribute("aria-live", "polite");
    const splits = new Map();

    function updateBalance() {
      try {
        const sum = [...splits.values()].reduce((total, line) => total + Costs.parseAmount(line.price.value || "0", currency.value), 0);
        const remainder = amount.value.trim() ? Costs.parseAmount(amount.value, currency.value) - sum : 0;
        balance.textContent = amount.value.trim()
          ? remainder < 0 ? "Over by " + Costs.format(-remainder, currency.value)
            : remainder > 0 ? "Left to assign · " + Costs.format(remainder, currency.value) : "Splits match the total"
          : "Split total · " + Costs.format(sum, currency.value);
      } catch (_) { balance.textContent = ""; }
    }

    const add = action(group, "Add split", () => addSplit().focus());
    function addSplit(line) {
      const row = append(rows, "fieldset", "", "it-transaction");
      append(row, "legend", "Split item");
      const name = field(row, "Item name", line?.name, { maxLength: 120 });
      const price = field(row, "Item amount", amountText(line?.amountMinor, entry?.currency), { inputMode: "decimal", maxLength: 16 });
      const itemCategory = categoryField(row, "Item category", line?.category || category.value, suggestions.id);
      const linkBox = append(row, "details");
      append(linkBox, "summary", "Item receipt link");
      const link = field(linkBox, "Item receipt URL", line?.receiptUrl, { type: "url", maxLength: 4096 });
      splits.set(row, { name, price, category: itemCategory, link });
      action(row, "Remove split", () => {
        splits.delete(row);
        row.remove();
        add.disabled = false;
        updateBalance();
        add.focus();
      });
      add.disabled = splits.size >= Costs.maxItems;
      updateBalance();
      return name;
    }
    function toggleSplits() {
      category.parentElement.hidden = splitToggle.checked;
      group.hidden = !splitToggle.checked;
      if (splitToggle.checked && !splits.size) addSplit();
    }
    for (const line of entry?.splits || []) addSplit(line);
    splitToggle.onchange = toggleSplits;
    toggleSplits();
    form.addEventListener("input", updateBalance);
    const extra = append(form, "details");
    extra.open = Boolean(entry?.receiptUrl || entry?.note);
    append(extra, "summary", "Receipt, date, or note");
    const extraFields = append(extra, "div", "", "it-cost-extra");
    const date = field(extraFields, "Date", entry ? entry.date : defaultDate, { type: "date" });
    const link = field(extraFields, "Receipt or confirmation URL", entry?.receiptUrl, { type: "url", maxLength: 4096, placeholder: "https://" });
    const note = append(append(extraFields, "label", "Note"), "textarea");
    note.rows = 2;
    note.maxLength = 1000;
    note.value = entry?.note || "";
    const controls = append(form, "div", "", "it-cost-fields");
    append(controls, "button", "Save transaction", "it-cost-save").type = "submit";
    action(controls, "Cancel", cancel);
    const status = append(form, "p");
    status.setAttribute("role", "status");
    const transactionId = entry?.id || crypto.randomUUID();
    form.onsubmit = async event => {
      event.preventDefault();
      form.inert = true;
      try {
        const data = {
          id: transactionId, merchant: merchant.value.trim(), currency: currency.value,
          date: date.value, note: note.value.trim(), receiptUrl: link.value.trim()
        };
        if (amount.value.trim()) data.amountMinor = Costs.parseAmount(amount.value, currency.value);
        if (splitToggle.checked) {
          data.splits = [...splits.values()].map(line => ({
            name: line.name.value, category: line.category.value, receiptUrl: line.link.value.trim(),
            amountMinor: Costs.parseAmount(line.price.value, currency.value)
          }));
          data.amountMinor ??= data.splits.reduce((sum, line) => sum + line.amountMinor, 0);
        } else {
          data.category = category.value.trim();
        }
        await submit(data);
      } catch (error) {
        status.textContent = error.message || "Could not save the transaction.";
      } finally {
        form.inert = false;
      }
    };
    merchant.focus();
  }

  function mountEditor(host, entries, save, defaultDate) {
    const section = append(host, "details", "", "it-costs");
    const title = append(section, "summary");
    const panel = append(section, "div", "", "it-cost-panel");
    const filters = append(panel, "div");
    const list = append(panel, "div", "", "it-cost-list");
    const editor = append(panel, "div", "", "it-cost-editor");
    const controls = append(panel, "div");
    const status = append(panel, "p", "", "it-cost-status");
    status.setAttribute("role", "status");
    let category = "";
    let editing = false;
    let editingId;
    let openedId;
    const add = save && action(controls, "Add row", () => edit());

    function renderRows() {
      list.replaceChildren();
      const visible = entries.filter(entry => !category || entry.category === category ||
        entry.splits?.some(line => line.category === category));
      if (!visible.length) append(list, "p", category ? "No matching transactions." : "No transactions yet.");
      renderList(list, visible, save && !editing && edit, openedId);
    }
    function render(resetFocus) {
      title.textContent = heading(entries);
      filters.replaceChildren();
      if (entries.length) {
        const select = append(append(filters, "label", "Filter by category"), "select");
        select.setAttribute("aria-label", "Filter by category");
        append(select, "option", "All categories").value = "";
        const categories = new Set(entries.flatMap(entry => entry.category ? [entry.category] : entry.splits.map(line => line.category)));
        if (!categories.has(category)) category = "";
        for (const name of [...categories].sort()) append(select, "option", name).value = name;
        select.value = category;
        select.disabled = editing;
        select.onchange = () => {
          category = select.value;
          renderRows();
        };
      }
      renderRows();
      if (add) add.hidden = editing || entries.length >= Costs.maxTransactions;
      if (resetFocus) (list.querySelector("details[open] > summary") || (add && !add.hidden && add) || title).focus();
    }
    function closeEditor() {
      editing = false;
      openedId = editingId;
      editor.replaceChildren();
      render(true);
    }
    function edit(entry) {
      editing = true;
      editingId = entry?.id;
      openedId = editingId;
      status.textContent = "";
      render();
      renderForm(editor, entry, entries, defaultDate, async data => {
        const next = Costs.validate(entry ? entries.map(old => old.id === entry.id ? data : old) : [...entries, data]);
        const result = await save(next, entries);
        entries = next;
        editingId = data.id;
        category = "";
        status.textContent = result?._savePending ? "Saved locally. Waiting to sync." : "Transaction saved.";
        closeEditor();
      }, closeEditor);
    }
    render();
    return section;
  }

  function mountPreview(host, entries) {
    const detail = append(host, "details", "", "it-cost-preview");
    append(detail, "summary", heading(entries));
    renderList(detail, entries);
    return detail;
  }

  window.DCC.ItineraryCosts = { mountEditor, mountPreview };

  function writer(blockId, refresh) {
    return async (next, saved) => {
      const baseline = JSON.stringify(saved);
      const result = await enqueueRowPropsWrite(blockId, props => {
        if (JSON.stringify(readCosts(props.taskCosts)) !== baseline) {
          throw new Error("The saved transactions changed. Reopen the ledger before editing.");
        }
        return { ...props, taskCosts: next };
      }, { _reportSaveStatus: true }, { rejectOnError: true });
      refresh?.(next);
      return result;
    };
  }

  window.mountTaskCosts = (host, blockId, task) => {
    host.replaceChildren();
    if (!blockId || !window.DCC_ACCOUNT_CONTEXT?.userId) return;
    const block = window.blockStore.get(blockId);
    if (!block && !task) return;
    const entries = readCosts(block ? block.properties.taskCosts : task.taskCosts);
    const archived = typeof viewMode !== "undefined" && viewMode === "archive";
    mountEditor(host, entries, !archived && writer(blockId, () => {
      if (typeof buildListView === "function") buildListView();
    }), block?.date);
  };

  window.mountItineraryCosts = (card, task) => {
    const blockId = task._blockId;
    if (!blockId || !window.DCC_ACCOUNT_CONTEXT?.userId) return;
    const cached = window.blockStore.get(blockId);
    const entries = readCosts(cached ? cached.properties.taskCosts : task.taskCosts);
    const archived = typeof viewMode !== "undefined" && viewMode === "archive";
    if (archived && !entries.length) return;
    const detail = mountEditor(card, entries, !archived && writer(blockId), cached?.date);
    detail.classList.add("it-cost-preview");
    detail.addEventListener("click", event => event.stopPropagation());
    detail.addEventListener("dragstart", event => event.preventDefault());
  };
})();
