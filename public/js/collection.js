// Searchable, sortable collection with inferred columns and filter values.
(function () {
  "use strict";
  const DCC = (window.DCC = window.DCC || {});

  const PREFERRED = ["title", "name", "username", "status", "role", "created_at", "timestamp", "updated_at", "id"];
  const isScalar = (value) => value == null || ["string", "number", "boolean"].includes(typeof value);
  const label = (key) => String(key).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const valueText = (value) => value == null || value === "" ? "—" : typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
  const displayValue = (value) => {
    const raw = valueText(value);
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
    }
    return raw;
  };

  function inferColumns(rows) {
    const seen = new Set();
    rows.forEach((row) => Object.keys(row || {}).forEach((key) => {
      if (!key.startsWith("_") && isScalar(row[key])) seen.add(key);
    }));
    return Array.from(seen).sort((a, b) => {
      const ai = PREFERRED.indexOf(a), bi = PREFERRED.indexOf(b);
      if (ai >= 0 || bi >= 0) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
      return a.localeCompare(b);
    });
  }

  function readState(key) {
    if (!key) return {};
    try { return JSON.parse(localStorage.getItem("dcc:collection:" + key) || "{}"); }
    catch (_) { return {}; }
  }

  function writeState(key, state) {
    if (!key) return;
    try { localStorage.setItem("dcc:collection:" + key, JSON.stringify(state)); }
    catch (_) {}
  }

  function mount(root, options) {
    if (!root) throw new Error("DCC.collection.mount requires a root element");
    const opts = options || {};
    let rows = Array.isArray(opts.rows) ? opts.rows.slice() : [];
    const stored = readState(opts.stateKey);
    const params = new URLSearchParams(location.search);
    const state = {
      query: opts.urlKey && params.has(opts.urlKey) ? params.get(opts.urlKey) : (stored.query || ""),
      sortKey: stored.sortKey || "",
      sortDirection: stored.sortDirection === "desc" ? "desc" : "asc",
      filterKey: stored.filterKey || "",
      filterValue: stored.filterValue || "",
      columns: Array.isArray(stored.columns) ? stored.columns : null
    };

    root.classList.add("dcc-collection");
    root.innerHTML =
      '<div class="dcc-collection-tools">' +
        '<label class="dcc-collection-search"><span>Search</span><input type="search" placeholder="Search records"></label>' +
        '<label><span>Filter</span><select data-collection-filter-key><option value="">Any field</option></select></label>' +
        '<label><span>Value</span><select data-collection-filter-value><option value="">All values</option></select></label>' +
        '<span class="dcc-collection-count" aria-live="polite"></span>' +
      '</div>' +
      '<div class="dcc-collection-scroll"><table><thead></thead><tbody></tbody></table></div>' +
      '<div class="dcc-collection-empty" hidden>No matching records.</div>';

    const search = root.querySelector("input[type=search]");
    const filterKey = root.querySelector("[data-collection-filter-key]");
    const filterValue = root.querySelector("[data-collection-filter-value]");
    search.value = state.query;

    function columns() {
      const inferred = inferColumns(rows);
      const saved = state.columns && state.columns.filter((key) => inferred.includes(key));
      return saved && saved.length ? saved : inferred;
    }

    function distinct(key) {
      return Array.from(new Set(rows.map((row) => valueText(row[key])))).sort((a, b) => a.localeCompare(b));
    }

    function syncFilterOptions() {
      const keys = columns().filter((key) => distinct(key).length <= 20);
      filterKey.innerHTML = '<option value="">Any field</option>' + keys.map((key) =>
        '<option value="' + DCC.esc(key) + '">' + DCC.esc(label(key)) + '</option>'
      ).join("");
      if (keys.includes(state.filterKey)) filterKey.value = state.filterKey;
      else { state.filterKey = ""; state.filterValue = ""; }
      const values = state.filterKey ? distinct(state.filterKey) : [];
      filterValue.innerHTML = '<option value="">All values</option>' + values.map((value) =>
        '<option value="' + DCC.esc(value) + '">' + DCC.esc(value) + '</option>'
      ).join("");
      if (values.includes(state.filterValue)) filterValue.value = state.filterValue;
    }

    function filteredRows() {
      const query = state.query.trim().toLowerCase();
      const keys = columns();
      const filtered = rows.filter((row) => {
        if (state.filterKey && state.filterValue && valueText(row[state.filterKey]) !== state.filterValue) return false;
        return !query || keys.some((key) => valueText(row[key]).toLowerCase().includes(query));
      });
      if (!state.sortKey) return filtered;
      const direction = state.sortDirection === "desc" ? -1 : 1;
      return filtered.sort((a, b) => valueText(a[state.sortKey]).localeCompare(valueText(b[state.sortKey]), undefined, { numeric: true }) * direction);
    }

    function save() {
      writeState(opts.stateKey, state);
      if (opts.urlKey) {
        const url = new URL(location.href);
        if (state.query) url.searchParams.set(opts.urlKey, state.query);
        else url.searchParams.delete(opts.urlKey);
        history.replaceState(null, "", url);
      }
    }

    function render() {
      const keys = columns();
      syncFilterOptions();
      const visible = filteredRows();
      const head = root.querySelector("thead");
      const body = root.querySelector("tbody");
      head.innerHTML = '<tr>' + keys.map((key) => {
        const active = state.sortKey === key;
        const mark = active ? (state.sortDirection === "asc" ? " ↑" : " ↓") : "";
        return '<th scope="col"><button type="button" data-sort="' + DCC.esc(key) + '" aria-sort="' +
          (active ? (state.sortDirection === "asc" ? "ascending" : "descending") : "none") + '">' + DCC.esc(label(key) + mark) + '</button></th>';
      }).join("") + '</tr>';
      body.innerHTML = visible.map((row) => '<tr>' + keys.map((key) =>
        '<td data-label="' + DCC.esc(label(key)) + '">' + DCC.esc(displayValue(row[key])) + '</td>'
      ).join("") + '</tr>').join("");
      root.querySelector(".dcc-collection-count").textContent = visible.length + " of " + rows.length;
      root.querySelector(".dcc-collection-empty").hidden = visible.length !== 0;
      root.querySelector(".dcc-collection-scroll").hidden = visible.length === 0;
      head.querySelectorAll("[data-sort]").forEach((button) => button.addEventListener("click", () => {
        if (state.sortKey === button.dataset.sort) state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
        else { state.sortKey = button.dataset.sort; state.sortDirection = "asc"; }
        save(); render();
      }));
    }

    search.addEventListener("input", () => { state.query = search.value; save(); render(); });
    filterKey.addEventListener("change", () => { state.filterKey = filterKey.value; state.filterValue = ""; save(); render(); });
    filterValue.addEventListener("change", () => { state.filterValue = filterValue.value; save(); render(); });

    render();
    return {
      root,
      state,
      update(nextRows) { rows = Array.isArray(nextRows) ? nextRows.slice() : []; render(); },
      reset() { state.query = ""; state.sortKey = ""; state.filterKey = ""; state.filterValue = ""; search.value = ""; save(); render(); }
    };
  }

  DCC.collection = { mount, inferColumns };
})();
