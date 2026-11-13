(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DCC.TaskCosts = api;
})(typeof self !== "undefined" ? self : this, function () {
  const categories = ["Food", "Gas", "Transit", "Shopping", "Lodging", "Entertainment", "Other"];
  const maxTransactions = 100;
  const currencies = Intl.supportedValuesOf("currency");
  const maxMinor = 999999999999;
  const maxItems = 30;

  function digits(currency) {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
  }

  function parseAmount(text, currency) {
    const precision = digits(currency);
    const [whole, fraction = ""] = text.trim().split(/[.,]/);
    if (!/^\d+(?:[.,]\d+)?$/.test(text.trim()) || fraction.length > precision) {
      throw new Error("Enter a nonnegative " + currency + " amount with up to " + precision + " decimal places.");
    }
    const amount = Number(whole + fraction.padEnd(precision, "0"));
    return checkAmount(amount);
  }

  function checkAmount(amount) {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > maxMinor) {
      throw new Error("Enter a smaller nonnegative amount.");
    }
    return amount;
  }

  function checkLink(link) {
    if (link == null || link === "") return "";
    if (typeof link === "string" && link.length <= 4096 && !/[\u0000-\u0020\u007f]/.test(link)) {
      const url = URL.canParse(link) && new URL(link);
      if (url && ["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
    }
    throw new Error("Enter a valid HTTP or HTTPS receipt or confirmation link.");
  }

  function legacyTotal(cost) {
    return cost.items ? cost.items.reduce((sum, item) => sum + item.amountMinor, 0) : cost.amountMinor;
  }

  function validateLegacy(costs) {
    if (costs === null) return null;
    if (!costs || typeof costs !== "object" || Array.isArray(costs)) throw new Error("Invalid task costs.");
    const result = {};
    for (const key of Object.keys(costs)) {
      const cost = costs[key];
      if (!["task", "commute"].includes(key) || !cost || !currencies.includes(cost.currency)) {
        throw new Error("Choose a valid currency for each cost.");
      }
      const receiptUrl = checkLink(cost.receiptUrl);
      const clean = { currency: cost.currency, ...(receiptUrl && { receiptUrl }) };
      if (Object.hasOwn(cost, "items")) {
        if (Object.hasOwn(cost, "amountMinor") || !Array.isArray(cost.items) || !cost.items.length || cost.items.length > maxItems) {
          throw new Error("Enter between 1 and " + maxItems + " items or use one overall amount.");
        }
        clean.items = cost.items.map(item => {
          const name = typeof item?.name === "string" ? item.name.trim() : "";
          if (!name || name.length > 120) throw new Error("Enter a name for each item.");
          const receiptUrl = checkLink(item.receiptUrl);
          return { name, amountMinor: checkAmount(item.amountMinor), ...(receiptUrl && { receiptUrl }) };
        });
        checkAmount(legacyTotal(clean));
      } else if (Object.hasOwn(cost, "amountMinor")) {
        clean.amountMinor = checkAmount(cost.amountMinor);
      } else if (!receiptUrl) {
        throw new Error("Enter an amount or add a receipt or confirmation link.");
      }
      result[key] = clean;
    }
    return Object.keys(result).length ? result : null;
  }

  function format(amount, currency) {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, currencyDisplay: "code" })
      .format(amount / 10 ** digits(currency));
  }

  function cleanText(value, label, max = 120) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
      throw new Error("Enter " + label + " (" + max + " characters max).");
    }
    return value.trim();
  }

  function validate(costs) {
    if (!Array.isArray(costs)) return validateLegacy(costs);
    if (costs.length > maxTransactions) throw new Error("A task can have up to 100 transactions.");
    const ids = new Set();
    return costs.map(entry => {
      const id = cleanText(entry?.id, "a transaction ID");
      if (ids.has(id)) throw new Error("Each transaction needs a unique ID.");
      ids.add(id);
      const { currency } = entry;
      if (!currencies.includes(currency)) throw new Error("Choose a valid currency.");
      const merchant = cleanText(entry.merchant, "a merchant or description");
      const receiptUrl = checkLink(entry.receiptUrl);
      const note = entry.note ? cleanText(entry.note, "a note", 1000) : "";
      const date = entry.date || "";
      if (date && (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) {
        throw new Error("Enter a valid date.");
      }
      const clean = { id, currency, merchant, ...(date && { date }), ...(note && { note }), ...(receiptUrl && { receiptUrl }) };
      if (Object.hasOwn(entry, "amountMinor")) clean.amountMinor = checkAmount(entry.amountMinor);
      else if (!receiptUrl) throw new Error("Enter an amount or link a confirmation.");
      if (entry.splits === undefined) {
        clean.category = cleanText(entry.category, "a category");
      } else {
        if (Object.hasOwn(entry, "category")) throw new Error("Assign categories to the split lines.");
        if (!Array.isArray(entry.splits) || !entry.splits.length || entry.splits.length > maxItems) {
          throw new Error("Add between 1 and " + maxItems + " split lines.");
        }
        clean.splits = entry.splits.map(line => {
          const receiptUrl = checkLink(line?.receiptUrl);
          return {
            name: cleanText(line?.name, "an item name"),
            category: cleanText(line.category, "a category"),
            amountMinor: checkAmount(line.amountMinor),
            ...(receiptUrl && { receiptUrl })
          };
        });
        if (clean.splits.reduce((sum, line) => sum + line.amountMinor, 0) !== clean.amountMinor) {
          throw new Error("Split amounts must add up to the transaction amount.");
        }
      }
      return clean;
    });
  }

  function transactions(costs) {
    const clean = validate(costs ?? null);
    if (Array.isArray(clean)) return clean;
    return Object.entries(clean || {}).map(([key, cost]) => {
      const commute = key === "commute";
      const category = commute ? "Transit" : "Other";
      const amountMinor = legacyTotal(cost);
      return {
        id: "legacy-" + key, merchant: commute ? "Travel expense" : "Expense", currency: cost.currency,
        ...(amountMinor !== undefined && { amountMinor }),
        ...(cost.receiptUrl && { receiptUrl: cost.receiptUrl }),
        ...(cost.items ? { splits: cost.items.map(item => ({ ...item, category })) } : { category })
      };
    });
  }

  function applyChange(current, change) {
    if (!change || !Array.isArray(change.before) || !Array.isArray(change.after)) {
      throw new Error("Invalid transaction change.");
    }
    const before = JSON.stringify(validate(change.before));
    const after = validate(change.after);
    const latest = validate(transactions(current));
    const snapshot = JSON.stringify(latest);
    if (snapshot === JSON.stringify(after)) return undefined;
    if (snapshot !== before) {
      const error = new Error("Transactions changed elsewhere. Reload the itinerary before editing.");
      error.statusCode = 409;
      error.publicCode = "TASK_COSTS_CONFLICT";
      throw error;
    }
    return after;
  }

  function summary(entries) {
    const amounts = new Map();
    for (const { currency, amountMinor } of entries) {
      if (amountMinor !== undefined) amounts.set(currency, (amounts.get(currency) || 0) + amountMinor);
    }
    return [...amounts].map(([currency, amount]) => format(amount, currency)).join(" + ");
  }

  return { categories, currencies, maxItems, maxTransactions, digits, parseAmount, validate, transactions, applyChange, format, summary };
});
