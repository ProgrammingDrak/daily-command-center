(() => {
  "use strict";
  // One-word swap: cards, list, notebook. All variants use identical records and actions.
  const DEFAULT_LAYOUT = "cards";
  const $ = (s) => document.querySelector(s),
    view = $("#view"),
    dialog = $("#editor");
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  const rich = (v) =>
    window.DOMPurify.sanitize(window.marked.parse(String(v || "")), {
      FORBID_TAGS: ["img", "iframe", "form", "input", "button"],
      FORBID_ATTR: ["style"]
    });
  const uuid = () => crypto.randomUUID();
  const endpoint = (id) => "/api/research/" + encodeURIComponent(id);
  const href = (id) => "/research?id=" + encodeURIComponent(id);
  const params = new URLSearchParams(location.search);
  const layout = ["cards", "list", "notebook"].includes(params.get("layout")) ? params.get("layout") : DEFAULT_LAYOUT;
  const labels = {
    idea: "Idea",
    research: "Research",
    requirement: "Requirement",
    product: "Product",
    wishlist: "Wishlist"
  };
  const lifecycle = ["Captured", "Exploring", "Researching", "Validating", "Active Project", "Paused", "Rejected"];
  const researchStates = ["Open", "In progress", "Awaiting decision", "Concluded", "Paused"];
  const purchaseStates = ["Considering", "Selected", "To Buy", "Ordered", "Owned", "Rejected", "Returned"];
  const allStatuses = [
    ...new Set([
      ...lifecycle,
      ...researchStates,
      ...purchaseStates,
      "Idea",
      "Comparing",
      "Ready to Decide",
      "Decided",
      "On Hold"
    ])
  ];
  const stateKey = (r) =>
    r.kind === "idea"
      ? "lifecycle"
      : r.kind === "research"
        ? "researchStatus"
        : ["product", "requirement"].includes(r.kind)
          ? "purchaseStatus"
          : "stage";
  const state = (r) => (r.archived ? "Archived" : r[stateKey(r)] || "Captured");
  const button = (label, action, extra = "") =>
    '<button type="button" data-act="' + action + '" ' + extra + ">" + esc(label) + "</button>";
  const options = (values, current) =>
    values
      .map((v) => {
        const [id, label] = Array.isArray(v) ? v : [v, v];
        return '<option value="' + esc(id) + '"' + (id === current ? " selected" : "") + ">" + esc(label) + "</option>";
      })
      .join("");
  const control = (key, label, type = "text", value = "", values) =>
    "<label>" +
    esc(label) +
    (type === "textarea"
      ? '<textarea aria-label="' + esc(label) + '" name="' + key + '">' + esc(value) + "</textarea>"
      : type === "select"
        ? '<select aria-label="' + esc(label) + '" name="' + key + '">' + options(values, value) + "</select>"
        : '<input aria-label="' +
          esc(label) +
          '" name="' +
          key +
          '" type="' +
          type +
          '" value="' +
          esc(value) +
          '"' +
          (key === "title" ? ' required maxlength="300"' : "") +
          ">") +
    "</label>";
  const date = (v) => (v ? new Date(v).toLocaleDateString() : "");
  const amount = (v, c) => (v == null ? "Unknown" : [c || "Currency unknown", v].join(" "));
  const external = (url, label) =>
    url && /^https?:\/\//i.test(url)
      ? '<a href="' + esc(url) + '" rel="noopener noreferrer" target="_blank">' + esc(label || url) + "</a>"
      : "";
  let api,
    current,
    tab = "all",
    offset = 0,
    nextOffset,
    records = [],
    searchVersion = 0;
  const actions = new Map();
  let actionRunning = false;
  const feedback = (message) => {
    $("#feedback").textContent = message;
  };
  function bind(name, run) {
    actions.set(name, run);
  }
  async function run(fn) {
    try {
      await fn();
    } catch (e) {
      feedback(e.message);
      if (dialog.open) $("#editor-status").textContent = e.message;
    }
  }
  document.addEventListener("click", (event) => {
    const b = event.target.closest("[data-act]");
    if (!b) return;
    const fn = actions.get(b.dataset.act);
    if (fn && !actionRunning)
      void run(async () => {
        actionRunning = true;
        view.inert = true;
        b.disabled = true;
        try {
          await fn();
        } finally {
          b.disabled = false;
          view.inert = false;
          actionRunning = false;
        }
      });
  });
  $("#close-editor").onclick = () => dialog.close();
  function form(title, html, save) {
    $("#editor-title").textContent = title;
    $("#editor-status").textContent = "";
    $("#editor-body").innerHTML =
      '<form class="ri-form">' +
      html +
      '<div class="actions"><button class="primary" type="submit">Save</button></div></form>';
    dialog.showModal();
    const node = $("#editor-body form");
    node.querySelector("input,textarea,select")?.focus();
    node.onsubmit = (e) => {
      e.preventDefault();
      const b = node.querySelector("[type=submit]");
      b.disabled = true;
      void run(async () => {
        try {
          await save(new FormData(node));
          dialog.close();
        } finally {
          b.disabled = false;
        }
      });
    };
  }
  async function save(data) {
    await api(endpoint(current.id), "PATCH", { mutationId: uuid(), revision: current.revision, data });
    await detail(current.id);
    feedback("Saved and synced");
  }
  function card(r) {
    return (
      '<article class="ri-card"><div><span class="kind">' +
      esc(labels[r.kind]) +
      '</span><h2><a href="' +
      href(r.id) +
      '">' +
      esc(r.title) +
      '</a></h2></div><p class="pill">' +
      esc(state(r)) +
      "</p><p>" +
      esc((r.description || r.objective || r.want || "").slice(0, 170)) +
      '</p><p class="ri-muted">' +
      esc([r.category, ...(r.tags || [])].filter(Boolean).join(" · ")) +
      '</p><small class="ri-muted">Updated ' +
      esc(date(r.updatedAt)) +
      (r.reviewOn ? " · Revisit " + esc(r.reviewOn) : "") +
      "</small></article>"
    );
  }
  function list() {
    actions.clear();
    current = null;
    view.innerHTML =
      '<h1>Research & Ideas</h1><p class="intro">Catch a possibility. Follow a question. Decide when you’re ready.</p><form class="capture"><input aria-label="Capture title" name="title" required maxlength="300" placeholder="An idea, a question, something worth exploring…"><select name="kind" aria-label="Capture type">' +
      options(Object.entries(labels).filter(([k]) => k !== "wishlist")) +
      '</select><button class="primary">Capture</button></form><nav class="ri-tabs" aria-label="Research views">' +
      [
        ["all", "All"],
        ["idea", "Ideas"],
        ["research", "Research"],
        ["items", "Wishlist / Items"],
        ["purchases", "Purchases"],
        ["archived", "Archived"]
      ]
        .map(([key, label]) => button(label, "tab-" + key, 'aria-pressed="' + (tab === key) + '"'))
        .join("") +
      '</nav><div class="ri-filters">' +
      control("query", "Search everything", "search") +
      control("category", "Category") +
      control("tag", "Tag") +
      control("sort", "Sort", "select", "recent", [
        ["recent", "Recent activity"],
        ["created", "Creation date"],
        ["priority", "Priority"]
      ]) +
      '<details><summary>Status filters</summary><div class="ri-filter-options">' +
      button("Add all", "status-all") +
      button("Remove all", "status-none") +
      allStatuses
        .map((v) => '<label><input type="checkbox" name="status" value="' + esc(v) + '" checked>' + esc(v) + "</label>")
        .join("") +
      '</div></details></div><div class="bar"><p id="result-count" aria-live="polite"></p>' +
      button("Unresolved questions", "questions") +
      button("Dormant ideas", "dormant") +
      '</div><div id="results" class="ri-list" data-layout="' +
      layout +
      '"></div>' +
      button("Load more", "more", "hidden");
    const capture = $(".capture");
    let captureId = uuid(),
      signature;
    capture.onsubmit = (e) => {
      e.preventDefault();
      void run(async () => {
        const f = new FormData(capture),
          body = { kind: f.get("kind"), title: f.get("title").trim() };
        if (JSON.stringify(body) !== signature) {
          captureId = uuid();
          signature = JSON.stringify(body);
        }
        capture.querySelector("button").disabled = true;
        try {
          await api("/api/research", "POST", { id: captureId, ...body });
          location.href = href(captureId);
        } finally {
          capture.querySelector("button").disabled = false;
        }
      });
    };
    for (const key of ["all", "idea", "research", "items", "purchases", "archived"])
      bind("tab-" + key, () => {
        tab = key;
        $$(".ri-tabs button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.act === "tab-" + key)));
        return search();
      });
    let timer;
    $$(".ri-filters input").forEach(
      (n) =>
        (n.oninput = () => {
          clearTimeout(timer);
          timer = setTimeout(() => void run(() => search()), 200);
        })
    );
    $("[name=sort]").onchange = () => void run(() => search());
    bind("status-all", () => {
      $$("[name=status]").forEach((n) => (n.checked = true));
      return search();
    });
    bind("status-none", () => {
      $$("[name=status]").forEach((n) => (n.checked = false));
      return search();
    });
    bind("more", () => search(true));
    bind("questions", () => history(true));
    bind("dormant", () => {
      tab = "idea";
      return search(false, true);
    });
    void run(() => search());
  }
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  async function search(more = false, dormant = false) {
    const version = ++searchVersion;
    if (!more) {
      offset = 0;
      records = [];
    }
    const statuses = $$("[name=status]:checked").map((n) => n.value);
    const body = {
      query: $("[name=query]").value,
      category: $("[name=category]").value,
      tag: $("[name=tag]").value,
      sort: $("[name=sort]").value,
      offset,
      archived: tab === "archived",
      purchases: tab === "purchases",
      kind: ["idea", "research", "items"].includes(tab) ? tab : "all",
      ...(statuses.length === allStatuses.length ? {} : { status: statuses })
    };
    if (dormant) {
      const d = new Date();
      d.setMonth(d.getMonth() - 3);
      body.dormantBefore = d.toISOString().slice(0, 10);
    }
    // Items include requirements, canonical products and unchanged legacy Wishlists.
    const result = await api("/api/research/search", "POST", body);
    if (version !== searchVersion || !$("#results")) return;
    records.push(...result.records);
    nextOffset = result.nextOffset;
    offset = nextOffset;
    const visible =
      tab === "items" ? records.filter((r) => ["wishlist", "requirement", "product"].includes(r.kind)) : records;
    $("#results").innerHTML = visible.map(card).join("") || "<p>No records match. Capture a title above to begin.</p>";
    $("#result-count").textContent = visible.length + " records" + (dormant ? " · untouched for three months" : "");
    $("[data-act=more]").hidden = nextOffset === null;
  }
  function edit() {
    const r = current,
      k = stateKey(r),
      states =
        r.kind === "idea"
          ? lifecycle
          : r.kind === "research"
            ? researchStates
            : ["product", "requirement"].includes(r.kind)
              ? purchaseStates
              : ["Idea", "Researching", "Comparing", "Ready to Decide", "Decided", "On Hold"];
    const common = [
      ["title", "Title"],
      ["description", "Description", "textarea"],
      [k, "Status", "select", states],
      ["category", "Category"],
      ["tags", "Tags, separated by commas"],
      ["priority", "Priority", "select", ["", "High", "Medium", "Low"]],
      ["reviewOn", "Optional revisit date", "date"],
      ["reviewedOn", "Last reviewed", "date"],
      ["sourceUrl", "Source link", "url"],
      ["notes", "Notes (Markdown)", "textarea"]
    ];
    const research = [
      ["objective", "Research question and objective", "textarea"],
      ["constraints", "Requirements and constraints", "textarea"],
      ["recommendation", "Recommendation", "textarea"]
    ];
    const product = [
      ["manufacturer", "Manufacturer"],
      ["model", "Model"],
      ["productUrl", "Product URL", "url"],
      ["vendor", "Observed vendor"],
      ["price", "Observed price"],
      ["currency", "Currency (ISO code)"],
      ["priceObservedOn", "Price observation date", "date"],
      ["specifications", "Specifications", "textarea"],
      ["pros", "Pros", "textarea"],
      ["cons", "Cons", "textarea"],
      ["comparisonNotes", "Comparison notes", "textarea"],
      ["purchasePrice", "Actual purchase price"],
      ["purchasedOn", "Purchase date", "date"],
      ["purchaseVendor", "Purchase vendor"],
      ["receipt", "Receipt link", "url"],
      ["warranty", "Warranty", "textarea"]
    ];
    const fields = [
      ...common,
      ...(r.kind === "research" ? research : []),
      ...(["product", "requirement"].includes(r.kind) ? product : []),
      ...(r.kind === "requirement"
        ? [
            ["quantity", "Quantity", "number"],
            ["estimatedUnitCost", "Estimated unit cost"]
          ]
        : [])
    ];
    const original = { ...r, tags: (r.tags || []).join(", ") };
    form(
      "Edit " + labels[r.kind].toLowerCase(),
      fields
        .map(([key, label, type, values]) => control(key, label, type || "text", original[key] ?? "", values))
        .join(""),
      async (f) => {
        const data = {};
        for (const [key] of fields) {
          const value = String(f.get(key)).trim();
          const normalized =
            key === "tags"
              ? value
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean)
              : key === "quantity"
                ? value
                  ? Number(value)
                  : null
                : value || null;
          if (JSON.stringify(normalized) !== JSON.stringify(key === "tags" ? r.tags || [] : (r[key] ?? null)))
            data[key] = normalized;
        }
        if (Object.keys(data).length) await save(data);
      }
    );
  }
  function addEntry() {
    let id = uuid(),
      mutationId = uuid(),
      fingerprint;
    form(
      "Add to the research trail",
      control("entryType", "Entry type", "select", "Note", [
        "Note",
        "Question",
        "Finding",
        "Evidence",
        "AI summary",
        "Decision",
        "Recommendation"
      ]) +
        control("title", "Title") +
        control("notes", "Details (Markdown)", "textarea") +
        control("source", "Source / attribution") +
        control("url", "Source URL", "url") +
        control("checkedOn", "Source / observation date", "date"),
      async (f) => {
        const data = Object.fromEntries([...f].map(([k, v]) => [k, String(v).trim() || null]));
        if (JSON.stringify(data) !== fingerprint) {
          id = uuid();
          mutationId = uuid();
          fingerprint = JSON.stringify(data);
        }
        await api(endpoint(current.id) + "/entries", "PUT", { id, mutationId, revision: 0, data });
        await detail(current.id);
      }
    );
  }
  async function detail(id) {
    const r = await api(endpoint(id));
    current = r;
    actions.clear();
    const isItem = ["requirement", "product"].includes(r.kind);
    view.innerHTML =
      '<a href="/research">← Research & Ideas</a><div class="bar"><div><p class="ri-muted">' +
      esc(labels[r.kind]) +
      "</p><h1>" +
      esc(r.title) +
      '</h1><p class="pill">' +
      esc(state(r)) +
      '</p></div><div class="actions">' +
      button("Edit", "edit") +
      button(r.archived ? "Restore" : "Archive", "archive") +
      '</div></div><p class="ri-muted">Created ' +
      esc(date(r.createdAt)) +
      " · Updated " +
      esc(date(r.updatedAt)) +
      (r.reviewOn ? " · Revisit " + esc(r.reviewOn) : "") +
      '</p><div class="ri-detail-grid"><section><div class="ri-panel"><div class="ri-rich">' +
      rich(r.description || r.want || "Add a description when you’re ready.") +
      rich(r.notes) +
      "</div>" +
      external(r.sourceUrl, "Original source") +
      (r.objective ? '<h3>Question and objective</h3><div class="ri-rich">' + rich(r.objective) + "</div>" : "") +
      (r.constraints
        ? '<h3>Requirements and constraints</h3><div class="ri-rich">' + rich(r.constraints) + "</div>"
        : "") +
      (r.recommendation ? '<h3>Recommendation</h3><div class="ri-rich">' + rich(r.recommendation) + "</div>" : "") +
      "</div>" +
      (isItem ? itemDetails(r) : "") +
      '<div class="ri-panel"><div class="bar"><h2>Research trail</h2>' +
      button("Add finding or question", "entry") +
      '</div><p class="ri-muted">Evidence, summaries, and decisions retain their authorship and dates.</p>' +
      r.entries
        .map(
          (e) =>
            '<article class="ri-entry" data-state="' +
            esc(e.state || "Open") +
            '"><small>' +
            esc(e.entryType) +
            " · " +
            esc(e.state || "Open") +
            " · " +
            esc(date(e.createdAt)) +
            "</small><h3>" +
            esc(e.title) +
            '</h3><div class="ri-rich">' +
            rich(e.notes) +
            "</div><p>" +
            esc(e.source || e.author || "") +
            "</p>" +
            external(e.url, "Source") +
            (e.checkedOn ? "<small>Observed " + esc(e.checkedOn) + "</small>" : "") +
            (e.state === "Superseded"
              ? ""
              : button(
                  e.entryType === "Question"
                    ? e.state === "Resolved"
                      ? "Reopen question"
                      : "Resolve question"
                    : "Mark superseded",
                  "entry-state-" + e.id
                )) +
            "</article>"
        )
        .join("") +
      (r.entries.length ? "" : "<p>No findings yet. Start with a question.</p>") +
      (r.entriesTruncated ? "<p>More entries are available in activity history.</p>" : "") +
      '</div><div class="ri-panel"><h2>Existing Wishlist detail</h2><p>' +
      [r.criteria.length + " criteria", r.options.length + " options", r.research.length + " research notes"].join(
        " · "
      ) +
      '</p><a href="/wishlists?id=' +
      esc(r.id) +
      '">Open criteria, options, offers, and comparisons</a></div></section><section><div class="ri-panel"><div class="bar"><h2>Connections</h2>' +
      button("Link existing", "link") +
      '</div><ul class="ri-links">' +
      r.links
        .map(
          (e) =>
            '<li><div><a href="' +
            esc(e.record.url) +
            '">' +
            esc(e.record.title) +
            "</a><small>" +
            esc(e.relation) +
            " · " +
            esc(labels[e.record.kind] || e.record.kind) +
            (e.details?.quantity ? " · Quantity " + esc(e.details.quantity) : "") +
            (e.details?.estimatedUnitCost != null
              ? " · Unit estimate " + esc(amount(e.details.estimatedUnitCost, e.details.currency))
              : "") +
            "</small></div>" +
            (e.id
              ? '<div class="actions">' +
                (!e.blockId ? button("Details", "link-details-" + e.id) : "") +
                button("Unlink", "unlink-" + e.id) +
                "</div>"
              : "") +
            "</li>"
        )
        .join("") +
      "</ul>" +
      button("Find related records", "suggest") +
      '</div><div class="ri-panel"><h2>Make it actionable</h2><p class="ri-muted">Only an explicit task becomes actionable DCC work.</p><div class="actions">' +
      button("Create task", "task") +
      (r.kind === "idea" ? button("Promote to project", "project") : "") +
      (isItem ? button("Create purchase task", "purchase-task") : "") +
      button("Mark reviewed", "reviewed") +
      '</div></div><div class="ri-panel"><h2>Photos and files</h2><div id="files">Loading files…</div><input id="upload" type="file" hidden accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.md,.csv">' +
      button("Add private file", "upload") +
      '</div><div class="ri-panel"><h2>History and questions</h2>' +
      button("Activity history", "activity") +
      button("Unresolved questions", "questions") +
      '</div></section></div><section id="comparisons"></section>';
    bind("edit", edit);
    bind("entry", addEntry);
    bind("archive", () => save({ archived: !r.archived }));
    bind("reviewed", () => save({ reviewedOn: new Date().toISOString().slice(0, 10) }));
    bind("link", () => linkPicker());
    bind("suggest", () => linkPicker(true));
    bind("activity", () => history(false));
    bind("questions", () => history(true));
    for (const e of r.entries)
      bind("entry-state-" + e.id, async () => {
        await api(endpoint(r.id) + "/entries", "PUT", {
          id: e.id,
          mutationId: uuid(),
          revision: e.revision,
          data: { state: e.entryType === "Question" ? (e.state === "Resolved" ? "Open" : "Resolved") : "Superseded" }
        });
        await detail(r.id);
      });
    for (const e of r.links)
      if (e.id && !e.blockId)
        bind("link-details-" + e.id, () => {
          form(
            "Relationship details",
            control("quantity", "Quantity", "number", e.details?.quantity || 1) +
              control("estimatedUnitCost", "Estimated unit cost", "text", e.details?.estimatedUnitCost || "") +
              control("currency", "Currency (ISO code)", "text", e.details?.currency || "") +
              control("notes", "Relationship notes", "textarea", e.details?.notes || ""),
            async (f) => {
              const data = { quantity: Number(f.get("quantity")) };
              for (const key of ["estimatedUnitCost", "currency", "notes"])
                if (f.get(key)) data[key] = String(f.get(key));
              await api("/api/research/links", "PUT", {
                id: e.id,
                mutationId: uuid(),
                revision: e.revision,
                fromId: e.fromId,
                toId: e.toId,
                relation: e.relation,
                data
              });
              await detail(r.id);
            }
          );
        });
    for (const e of r.links)
      if (e.id)
        bind("unlink-" + e.id, async () => {
          await api("/api/research/links", "PUT", {
            id: e.id,
            mutationId: uuid(),
            revision: e.revision,
            fromId: e.fromId,
            ...(e.toId ? { toId: e.toId } : { blockId: e.blockId }),
            relation: e.relation,
            active: false
          });
          await detail(r.id);
        });
    for (const action of ["task", "project", "purchase-task"])
      bind(action, () => {
        const request = { id: uuid(), mutationId: uuid(), action };
        form(
          action === "project" ? "Promote to a project" : "Create an undated task",
          control(
            "title",
            "Title",
            "text",
            (action === "purchase-task" ? "Buy " : action === "task" ? "Follow up: " : "") + r.title
          ),
          async (f) => {
            const result = await api(endpoint(r.id) + "/action", "POST", { ...request, title: f.get("title") });
            await detail(r.id);
            feedback("Created and linked. Open it under Connections.");
            return result;
          }
        );
      });
    bind("upload", () => $("#upload").click());
    $("#upload").onchange = () => void run(() => upload(r.id));
    void run(() => loadFiles(r.id));
    if (r.kind === "requirement") void run(() => compare(r));
    view.setAttribute("aria-busy", "false");
  }
  function itemDetails(r) {
    return (
      '<div class="ri-panel"><h2>Purchase research</h2><dl>' +
      [
        ["Manufacturer", r.manufacturer],
        ["Model", r.model],
        ["Vendor", r.vendor],
        ["Observed price", amount(r.price, r.currency)],
        ["Observation date", r.priceObservedOn || "Unknown"],
        ["Specifications", r.specifications],
        ["Pros", r.pros],
        ["Cons", r.cons],
        ["Comparison notes", r.comparisonNotes],
        ["Quantity", r.quantity],
        ["Estimated unit cost", r.estimatedUnitCost != null ? amount(r.estimatedUnitCost, r.currency) : ""],
        ["Actual price", r.purchasePrice != null ? amount(r.purchasePrice, r.currency) : ""],
        ["Purchased", r.purchasedOn],
        ["Purchase vendor", r.purchaseVendor],
        ["Warranty", r.warranty]
      ]
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => "<div><dt>" + esc(k) + "</dt><dd>" + esc(v) + "</dd></div>")
        .join("") +
      '</dl><p class="ri-muted">' +
      (window.WishlistPricing.stale(r.priceObservedOn)
        ? "Price needs rechecking."
        : "Recorded observation, not a live price.") +
      "</p>" +
      external(r.productUrl, "Product page") +
      " " +
      external(r.receipt, "Receipt") +
      "</div>"
    );
  }
  async function compare(r) {
    const candidates = r.links.filter((e) => e.relation === "candidate" && e.record.kind === "product");
    const products = candidates.map((e) => e.record);
    if (current?.id !== r.id) return;
    $("#comparisons").innerHTML =
      '<div class="ri-panel"><div class="bar"><h2>Product candidates</h2>' +
      button("Link product candidate", "candidate") +
      '</div><div class="ri-compare">' +
      products
        .map(
          (p) =>
            '<article><h3><a href="' +
            href(p.id) +
            '">' +
            esc(p.title) +
            "</a></h3><p>" +
            esc(state(p)) +
            "</p>" +
            itemDetails(p) +
            button("Select product", "select-" + p.id) +
            "</article>"
        )
        .join("") +
      "</div>" +
      (products.length ? "" : "<p>Link existing products or capture a product, then link it here.</p>") +
      "</div>";
    bind("candidate", () => linkPicker(false, "product"));
    for (const p of products)
      bind("select-" + p.id, async () => {
        await api(endpoint(p.id), "PATCH", {
          mutationId: uuid(),
          revision: p.revision,
          data: { purchaseStatus: "Selected" }
        });
        await detail(r.id);
      });
  }
  async function linkPicker(suggest = false, targetKind) {
    const r = current;
    form(
      suggest ? "Related records" : "Link an existing record",
      control("query", "Find by title", "search") +
        control("target", "Target type", "select", targetKind || "all", [
          ["all", "All records"],
          ["idea", "Ideas"],
          ["research", "Research"],
          ["requirement", "Requirements"],
          ["product", "Products"],
          ["task", "Tasks"],
          ["project", "Projects"]
        ]) +
        '<div id="link-results"></div>',
      async () => {}
    );
    $("#editor-body [type=submit]").hidden = true;
    let token = 0;
    async function find() {
      const v = ++token,
        kind = $("[name=target]").value,
        query = $("[name=query]").value;
      let choices;
      if (kind === "task") choices = await api("/api/research/task-choices?q=" + encodeURIComponent(query));
      else if (kind === "project")
        choices = (await api("/api/research/project-choices"))
          .filter((p) => String(p.properties.name).toLowerCase().includes(query.toLowerCase()))
          .map((p) => ({ id: p.id, title: p.properties.name }));
      else
        choices = (
          await api("/api/research/search", "POST", {
            kind,
            query,
            ...(suggest && r.category ? { category: r.category } : {})
          })
        ).records.filter((p) => p.id !== r.id && !r.links.some((e) => e.record.id === p.id));
      if (v !== token) return;
      $("#link-results").innerHTML =
        choices.map((p) => "<p>" + button(p.title, "pick-" + p.id) + "</p>").join("") ||
        "<p>No matches. Try another title or capture a new record first.</p>";
      for (const p of choices)
        bind("pick-" + p.id, async () => {
          const relation = ["task", "project"].includes(kind)
            ? kind
            : r.kind === "requirement" && p.kind === "product"
              ? "candidate"
              : p.kind === "research"
                ? "research"
                : p.kind === "requirement"
                  ? "requires"
                  : "related";
          await api("/api/research/links", "PUT", {
            id: uuid(),
            mutationId: uuid(),
            revision: 0,
            fromId: r.id,
            ...(["task", "project"].includes(kind) ? { blockId: p.id } : { toId: p.id }),
            relation
          });
          dialog.close();
          await detail(r.id);
        });
    }
    $("[name=query]").oninput = () => void run(find);
    $("[name=target]").onchange = () => void run(find);
    await find();
  }
  async function history(questions) {
    const path = "/api/research/activity?questions=" + questions + (current ? "&id=" + current.id : "");
    let next = 0;
    form(
      questions ? "Unresolved questions" : "Activity history",
      '<ul id="history-results" class="ri-history"></ul>' + button("Load more history", "history-more"),
      async () => {}
    );
    $("#editor-body [type=submit]").hidden = true;
    async function load() {
      const r = await api(path + "&offset=" + next);
      $("#history-results").insertAdjacentHTML(
        "beforeend",
        r.entries
          .map(
            (e) =>
              "<li><strong>" +
              esc(e.record_title) +
              "</strong><p>" +
              esc(e.data.title || e.kind || e.data.action) +
              "</p><small>" +
              esc(date(e.recorded_at || e.created_at)) +
              "</small><details><summary>Saved details</summary><pre>" +
              esc(JSON.stringify(e.data, null, 2)) +
              "</pre></details></li>"
          )
          .join("") || (next === 0 ? "<p>No entries found.</p>" : "")
      );
      next = r.nextOffset;
      $("[data-act=history-more]").hidden = next === null;
    }
    bind("history-more", load);
    await load();
  }
  async function loadFiles(id) {
    try {
      const response = await fetch("/api/wishlists/" + id + "/attachments");
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (current?.id !== id) return;
      $("#files").innerHTML =
        '<div class="ri-photos">' +
        result.files
          .filter((f) => !f.removed && !f.pending)
          .map(
            (f) =>
              '<a href="/api/wishlists/' +
              id +
              "/attachments/" +
              f.id +
              '/download">' +
              (f.mime.startsWith("image/")
                ? '<img alt="' + esc(f.filename) + '" src="/api/wishlists/' + id + "/attachments/" + f.id + '/preview">'
                : esc(f.filename)) +
              "</a>"
          )
          .join("") +
        '</div><p class="ri-muted">' +
        (result.configured ? "Private uploads up to 10 MB." : "Private file storage is unavailable.") +
        "</p>";
    } catch (e) {
      if (current?.id === id) $("#files").textContent = e.message;
    }
  }
  async function upload(id) {
    const input = $("#upload");
    if (!input.files[0]) return;
    const f = new FormData();
    f.append("file", input.files[0]);
    const r = await fetch("/api/wishlists/" + id + "/attachments", {
      method: "POST",
      headers: { "X-DCC-Attachment": "1", "X-Upload-Id": uuid() },
      body: f
    });
    const result = await r.json();
    if (!r.ok) throw new Error(result.error);
    await loadFiles(id);
  }
  async function blockView(id) {
    const result = await api("/api/research/blocks/" + encodeURIComponent(id));
    view.innerHTML =
      '<a href="/">← Tasks and projects</a><h1>Connected research</h1><div class="ri-list">' +
      result.links.map((e) => card(e.record)).join("") +
      '</div><a href="/research">Find research and link this task or project</a>';
    view.setAttribute("aria-busy", "false");
  }
  async function syncStatus() {
    const rows = await ResearchSync.pending(),
      state = ResearchSync.state;
    $("#sync-status").textContent =
      (state.localTime ? "Saved locally" : "Ready") +
      " · " +
      (rows.some((r) => r.value.rejected)
        ? "Needs attention"
        : rows.length
          ? rows.length + " waiting to sync"
          : state.conflict
            ? "Needs attention"
            : "Synced");
  }
  $("#sync-status").onclick = () =>
    void run(async () => {
      const rows = await ResearchSync.pending();
      form(
        "Local save and sync status",
        "<p>Latest local save: " +
          esc(ResearchSync.state.localTime || "None") +
          "</p><p>Latest server sync: " +
          esc(ResearchSync.state.latest || "None") +
          "</p><p>" +
          esc(ResearchSync.state.conflict || "No conflicts") +
          "</p>" +
          button("Sync now", "sync-now") +
          rows
            .map(
              (r) =>
                "<details><summary>Pending or rejected edit</summary><pre>" +
                esc(JSON.stringify(r.value.body, null, 2)) +
                "</pre>" +
                button("Discard this local edit", "discard-" + r.key) +
                "</details>"
            )
            .join(""),
        async () => {}
      );
      $("#editor-body [type=submit]").hidden = true;
      bind("sync-now", async () => {
        await ResearchSync.sync();
        await syncStatus();
        dialog.close();
      });
      for (const r of rows)
        bind("discard-" + r.key, async () => {
          await ResearchSync.discard(r.key);
          dialog.close();
          await syncStatus();
        });
    });
  window.addEventListener("research-sync", () => void syncStatus());
  (async () => {
    try {
      const response = await fetch("/api/me");
      const identity = await response.json();
      if (!response.ok || !identity.userId || !identity.workspaceId)
        throw new Error("Sign in to open Research & Ideas");
      if (identity.synthetic) {
        $("#environment").hidden = false;
        $("#environment").textContent = "Local review data";
      }
      api = await ResearchSync.init(identity);
      await syncStatus();
      if (params.get("id")) await detail(params.get("id"));
      else if (params.get("block")) await blockView(params.get("block"));
      else list();
      view.setAttribute("aria-busy", "false");
    } catch (e) {
      view.innerHTML =
        '<h1>Research & Ideas</h1><p role="alert">' +
        esc(e.message) +
        '</p><a href="/login?returnTo=%2Fresearch">Sign in</a>';
    }
  })();
})();
