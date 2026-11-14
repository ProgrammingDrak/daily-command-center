(() => {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const view = $("#view");
  const dialog = $("#editor");
  const feedback = $("#feedback");
  const status = $("#editor-status");
  const P = window.WishlistPricing;
  const stages = ["Idea", "Researching", "Comparing", "Ready to Decide", "Decided", "On Hold"];
  const sections = ["Overview", "Criteria", "Options", "Compare", "Research", "Decision / Next Actions"];
  const images = ["image/png", "image/jpeg", "image/webp"];
  const actions = new Map();
  let current, files = [], selected, section = 0, cards = true, busy = false, storage = false, fileError;
  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const base = id => "/api/wishlists" + (id ? "/" + encodeURIComponent(id) : "");
  const page = id => "/wishlists?id=" + encodeURIComponent(id);
  const fileUrl = (id, file) => base(id) + "/attachments/" + encodeURIComponent(file);
  const amount = (value, currency) => value == null ? "" : [currency, value].filter(Boolean).join(" ");
  const active = () => files.filter(file => !file.removed && !file.pending);
  const name = option => option ? [option.title, option.variant].filter(Boolean).join(" · ") : "Unavailable";
  const choices = records => records.map(record => [record.id, name(record)]);
  const find = (kind, id) => current[kind].find(record => record.id === id);
  const check = (option, criterion) => current.assessments.find(item => item.optionId === option.id && item.criterionId === criterion.id);
  const checkName = item => item ? name(find("options", item.optionId)) + " · " + name(find("criteria", item.criterionId)) : "Unavailable";

  async function api(url, method = "GET", body, headers = {}) {
    const options = { method, headers };
    if (body instanceof FormData) options.body = body;
    else if (body !== undefined) {
      options.headers = { ...headers, "Content-Type": "application/json", "X-DCC-Wishlist": "1" };
      options.body = JSON.stringify(body);
    }
    const response = await fetch(url, options);
    const result = await response.json().catch(() => null);
    if (!response.ok || result === null) throw new Error(result?.error || "The request could not be confirmed. Try again.");
    return result;
  }

  function button(label, run, attrs = "") {
    const id = crypto.randomUUID();
    actions.set(id, run);
    return '<button type="button" data-action="' + id + '" ' + attrs + '>' + esc(label) + "</button>";
  }
  const primary = 'class="primary"';
  function bar(title, controls = "") {
    return '<div class="bar"><h2>' + esc(title) + '</h2><div class="actions">' + controls + "</div></div>";
  }
  function link(url, label = "Open source") {
    return url && /^https?:\/\//i.test(url) ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + "</a>" : "";
  }
  function facts(entries) {
    const visible = entries.filter(([, value]) => value != null && value !== "");
    return visible.length ? "<dl>" + visible.map(([label, value]) => "<div><dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd></div>").join("") + "</dl>" : "";
  }

  const title = ["title", "Title", "text", null, true];
  const note = (key, label) => [key, label, "textarea"];
  const select = (key, label, values, required = false) => [key, label, "select", values, required];
  const date = (key, label) => [key, label, "date"];
  const money = (key, label) => [key, label, "money"];
  const overviewFields = () => [
    title, select("stage", "Research stage", stages, true), ["category", "Category"], ["useCases", "Use cases"],
    note("want", "What I want"), note("why", "Why I want it"), note("problem", "Problem to solve"),
    money("budget", "Preferred budget"), ["currency", "Budget currency", "currency"], money("targetPrice", "Target price"), money("maximum", "Maximum"),
    date("neededBy", "Needed by"), date("reviewOn", "Review date"), select("favoriteId", "Favorite", choices(current.options)),
    select("coverId", "Card image", active().filter(file => images.includes(file.mime)).map(file => [file.id, file.filename])),
    note("questions", "Open questions"), note("nextAction", "Next action"),
  ];
  const criteriaFields = [
    title, select("importance", "Importance", ["Must-have", "Important", "Nice-to-have"], true),
    ["desired", "Desired value or threshold"], ["units", "Units"], ["scope", "Scope"], note("description", "Description"), note("notes", "Notes"),
  ];
  const optionFields = [
    ["title", "Option name", "text", null, true], select("kind", "Option type", ["Product", "Service", "Prototype", "Concept", "DIY", "Inspiration"], true),
    ["maker", "Maker"], ["model", "Model"], ["version", "Version"], ["variant", "Variant"], ["url", "Link", "url"],
    select("status", "Status", ["Considering", "Shortlisted", "Rejected", "Selected"], true), note("reason", "Reason for status"),
    note("description", "Description"), note("specifications", "Specifications"), note("pros", "Pros"), note("cons", "Cons"),
    note("concerns", "Concerns"), note("questions", "Open questions"),
  ];
  const checkFields = [
    ["actual", "Actual value"], select("verdict", "Result", ["Unverified", "Meets", "Partly meets", "Fails", "Not applicable"], true),
    ["url", "Evidence link", "url"], date("checkedOn", "Checked on"), note("notes", "Notes"),
  ];
  const offerFields = [
    ["title", "Seller", "text", null, true], ["url", "Offer link", "url"], ["variant", "Exact variant"], ["condition", "Condition"],
    ["availability", "Availability"], ["location", "Location"], money("price", "Price"), ["currency", "Currency", "currency"],
    money("shipping", "Shipping"), money("taxes", "Taxes"), money("discount", "Discount"), money("extras", "Required extras"),
    ["estimated", "Includes estimated amounts", "checkbox"], date("checkedOn", "Price and availability checked"),
    note("returns", "Return policy"), note("warranty", "Warranty"), ["delivery", "Delivery estimate"],
  ];
  const researchFields = () => [
    title, select("kind", "Source type", ["Manufacturer claim", "Independent review", "My observation", "Inference"]),
    ["source", "Source name"], ["url", "Source link", "url"], date("checkedOn", "Source or observation date"), note("notes", "Notes and findings"),
    select("criterionId", "Criterion", choices(current.criteria)), select("optionId", "Option", choices(current.options)),
    select("offerId", "Offer", current.offers.map(item => [item.id, item.title + " · " + name(find("options", item.optionId))])),
    select("assessmentId", "Assessment", current.assessments.map(item => [item.id, checkName(item)])),
    select("attachmentId", "Private file", active().map(file => [file.id, file.filename])),
  ];
  const decisionFields = [
    select("outcome", "Outcome", ["Purchased", "Built", "Kept what I have", "Decided against it"]), date("decisionOn", "Decision date"),
    note("rationale", "Why I chose this"), note("alternatives", "Rejected alternatives"), note("compromises", "Compromises"), note("uncertainties", "Remaining uncertainties"),
  ];

  function field([key, label, type = "text", options, required], value) {
    const attr = ' name="' + key + '"' + (required ? " required" : "");
    let control;
    if (type === "select") {
      control = "<select" + attr + ">" + (required ? "" : '<option value="">Choose if known</option>') + options.map(option => {
        const [id, label] = Array.isArray(option) ? option : [option, option];
        return '<option value="' + esc(id) + '"' + (id === value ? " selected" : "") + ">" + esc(label) + "</option>";
      }).join("") + "</select>";
    } else if (type === "textarea") control = "<textarea" + attr + ' maxlength="8000">' + esc(value) + "</textarea>";
    else if (type === "checkbox") control = '<input type="checkbox"' + attr + (value ? " checked" : "") + ">";
    else {
      const config = { money: ' inputmode="decimal" pattern="[0-9]{1,15}([.][0-9]{1,6})?"', currency: ' maxlength="3" pattern="[a-zA-Z]{3}" placeholder="ISO code"' };
      control = '<input type="' + (config[type] ? "text" : type) + '"' + attr + (config[type] || "")
        + (key === "title" ? ' maxlength="300"' : "") + ' value="' + esc(value) + '">';
    }
    return '<label class="' + (type === "textarea" ? "wide" : "") + '"><span>' + esc(label) + "</span>" + control + "</label>";
  }

  function open(heading, html) {
    $("#editor-title").textContent = heading;
    $("#editor-body").innerHTML = html;
    status.textContent = "";
    if (!dialog.open) dialog.showModal();
    $("#editor-body input, #editor-body select, #editor-body textarea, #editor-body button")?.focus();
  }

  async function submit(run) {
    const controls = [...dialog.querySelectorAll("button, input, select, textarea")];
    busy = true;
    controls.forEach(node => { node.disabled = true; });
    status.textContent = "Saving…";
    try { await run(); }
    catch (error) { status.textContent = error.message; }
    finally { busy = false; controls.forEach(node => { node.disabled = false; }); }
  }

  function saved(message = "Saved") {
    dialog.close();
    feedback.textContent = message;
    renderDetail(true);
  }

  function editor(heading, fields, values, save, help = "") {
    open(heading, '<form><div class="editor-fields">' + fields.map(spec => field(spec, values[spec[0]])).join("")
      + "</div>" + (help ? '<p class="muted">' + esc(help) + "</p>" : "")
      + '<div class="editor-actions"><button type="submit" class="primary">Save</button></div></form>');
    let previous = "", mutationId;
    $("#editor-body form").onsubmit = event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const data = Object.fromEntries(fields.map(([key, , type]) => {
        const value = String(form.get(key) || "").trim();
        return [key, type === "checkbox" ? form.has(key) : (type === "currency" ? value.toUpperCase() : value) || null];
      }));
      const fingerprint = JSON.stringify(data);
      if (fingerprint !== previous) mutationId = crypto.randomUUID();
      previous = fingerprint;
      void submit(() => save(data, mutationId));
    };
  }

  async function write(kind, record, data, mutationId) {
    const isOverview = kind === "overview";
    const id = record?.id || mutationId;
    const endpoint = base(current.id) + (isOverview ? "" : "/" + kind + "/" + id);
    const result = await api(endpoint, isOverview ? "PATCH" : "PUT", { mutationId, revision: record?.revision || 0, data });
    if (isOverview) Object.assign(current, result);
    else if (record) current[kind] = current[kind].map(item => item.id === id ? result : item);
    else if (!current[kind].some(item => item.id === id)) current[kind].push(result);
    if (kind === "offers" || kind === "tasks" || result.duplicate) {
      try { current = await api(base(current.id)); }
      catch { return "Saved. Refresh to see the latest details."; }
    }
    return "Saved";
  }
  function edit(heading, kind, fields, record, defaults = {}, help = "") {
    editor(heading, fields, record || defaults, async (data, id) => saved(await write(kind, record, { ...defaults, ...data }, id)), help);
  }
  function editCheck(option, criterion) {
    edit("Check " + criterion.title, "assessments", checkFields, check(option, criterion), { optionId: option.id, criterionId: criterion.id, verdict: "Unverified" });
  }
  function editOffer(option, offer) {
    edit(offer ? "Edit offer" : "Add seller offer", "offers", offerFields, offer, { optionId: option.id }, "Leave unknown costs blank. Enter 0 for a confirmed zero cost or discount.");
  }
  function createWishlist() {
    editor("New Wishlist", [title], {}, async (data, id) => {
      const result = await api(base(), "POST", { id, title: data.title });
      window.location.assign(page(result.id));
    });
  }
  function taskPicker(convert) {
    open(convert ? "Convert a DCC task" : "Link a DCC task",
      (convert ? "<p>Conversion removes the task from active work and keeps its notes, history, and files in the Wishlist.</p>" : "")
      + '<form><label>Task title<input name="query" required></label><div class="editor-actions"><button>Find tasks</button></div></form><div id="task-results" class="stack"></div>');
    let version = 0;
    $("#editor-body form").onsubmit = async event => {
      event.preventDefault();
      const request = ++version;
      const results = $("#task-results");
      results.textContent = "Searching…";
      try {
        const query = new FormData(event.currentTarget).get("query");
        const matches = await api(base() + "/task-choices?q=" + encodeURIComponent(query));
        if (request !== version || !results.isConnected) return;
        results.innerHTML = matches.map(task => {
          const id = crypto.randomUUID();
          return '<div class="record"><h3>' + esc(task.title) + '</h3><p class="muted">' + esc(task.date || "Unscheduled") + "</p>"
            + button(convert ? "Convert this task" : "Link this task", () => {
              if (!convert) return submit(async () => saved(await write("tasks", null, { taskId: task.id }, id)));
              open("Confirm task conversion", "<p>Convert <strong>" + esc(task.title) + "</strong> to a Wishlist?</p>"
                + button("Convert to Wishlist", () => submit(async () => {
                  const result = await api(base(), "POST", { id, taskId: task.id });
                  window.location.assign(page(result.id));
                }), primary));
            }) + "</div>";
        }).join("") || "<p>No matching tasks.</p>";
      } catch (error) {
        if (request === version) results.textContent = error.message;
      }
    };
  }

  function renderList(list) {
    view.innerHTML = '<div class="bar"><h1>Wishlists</h1><div class="actions">' + button("Convert a task", () => taskPicker(true))
      + button("New Wishlist", createWishlist, primary) + '</div></div><div class="filters">'
      + field(["query", "Search Wishlists", "search"]) + field(select("stage", "Research stage", [["", "All stages"], ...stages], true), "")
      + '<button type="button" id="layout" aria-pressed="false">Compact list</button></div><div id="results"></div>';
    const paint = () => {
      const query = $("[name=query]").value.trim().toLowerCase();
      const stage = $("[name=stage]").value;
      const matches = list.filter(item => (!stage || item.stage === stage) && [item.title, item.category, item.favorite, item.nextAction]
        .some(value => String(value || "").toLowerCase().includes(query)));
      $("#layout").setAttribute("aria-pressed", String(!cards));
      $("#results").className = cards ? "cards" : "list";
      $("#results").innerHTML = matches.map(item => '<article class="card"><a href="' + page(item.id) + '">'
        + (cards && item.coverId ? '<img alt="" loading="lazy" src="' + fileUrl(item.id, item.coverId) + '/preview">' : "")
        + '<div class="card-copy"><h2>' + esc(item.title) + '</h2><p class="pill">' + esc(item.stage || "Idea") + "</p>"
        + (item.budget != null ? '<p class="muted">Budget ' + esc(amount(item.budget, item.currency)) + "</p>" : "")
        + (item.favorite ? "<p>Favorite · " + esc(item.favorite) + "</p>" : "") + (item.nextAction ? "<p>Next · " + esc(item.nextAction) + "</p>" : "") + "</div></a></article>").join("")
        || (list.length ? "<p>No Wishlists match these filters.</p>" : "<p>Start a Wishlist with a title. Add research whenever you’re ready.</p>");
    };
    $("[name=query]").oninput = paint;
    $("[name=stage]").onchange = paint;
    $("#layout").onclick = () => { cards = !cards; paint(); };
    paint();
  }

  function renderDetail(restoreFocus = false) {
    actions.clear();
    const render = [overview, criteria, options, compare, research, decision][section];
    view.innerHTML = '<a class="back" href="/wishlists">← All Wishlists</a><div class="bar"><div><h1>' + esc(current.title)
      + '</h1><p class="pill">' + esc(current.stage || "Idea") + "</p></div>" + button("Quick capture", () => capture(), primary)
      + '</div><nav class="detail-nav" aria-label="Wishlist sections">' + sections.map((label, index) => button(label, () => {
        section = index;
        renderDetail(true);
      }, index === section ? 'aria-current="page"' : "")).join("") + '</nav><section aria-label="' + sections[section] + '">' + render() + "</section>";
    if (restoreFocus) view.querySelector('[aria-current="page"]').focus({ preventScroll: true });
  }

  function overview() {
    const item = current;
    const favorite = find("options", item.favoriteId);
    const summary = facts([["What I want", item.want], ["Why I want it", item.why], ["Problem to solve", item.problem], ["Category", item.category],
      ["Use cases", item.useCases], ["Budget", amount(item.budget, item.currency)], ["Target", amount(item.targetPrice, item.currency)],
      ["Maximum", amount(item.maximum, item.currency)], ["Needed by", item.neededBy], ["Review on", item.reviewOn],
      ["Favorite", favorite && name(favorite)], ["Open questions", item.questions], ["Next action", item.nextAction]]);
    return '<div class="panel">' + bar("Overview", button("Edit overview", () => edit("Edit overview", "overview", overviewFields(), current)))
      + (summary || '<p class="muted">Add what you’re looking for, a budget, or the next step when you’re ready.</p>') + "</div>" + originalTask();
  }

  function originalTask() {
    if (!current.original) return "";
    const { properties: p, date, timeEntries, operations } = current.original;
    const segments = timeEntries.map(entry => {
      const props = entry.properties;
      return "<li>" + esc([String(entry.date || "").slice(0, 10), props.title, props.start, props.end,
        props.minutes == null ? "" : props.minutes + " min"].filter(Boolean).join(" · ")) + "</li>";
    }).join("");
    return '<details class="panel"><summary>Original DCC task and history</summary>'
      + facts([["Date", date?.slice(0, 10)], ["Status", p.status], ["Details", p.detail], ["Notes", p.notes || p.note || p.description],
        ["Completed", p.completedAt], ["Elapsed minutes", p.elapsedMinutes]])
      + (segments ? "<h3>Time entries</h3><ul>" + segments + "</ul>" : "")
      + (operations?.length ? "<h3>Recent task history</h3><ul>" + operations.map(item =>
        "<li>" + esc(item.timestamp.slice(0, 10) + " · " + item.action) + "</li>").join("") + "</ul>" : "")
      + '<details><summary>Original task record</summary><pre>'  + esc(JSON.stringify(p, null, 2)) + "</pre></details></details>";
  }

  function criteria() {
    return bar("Criteria", button("Add criterion", () => edit("Add criterion", "criteria", criteriaFields, null, { importance: "Important" }), primary))
      + '<div class="record-grid">' + (current.criteria.map(item => '<article class="record"><div class="bar"><h3>' + esc(item.title) + "</h3>"
        + button("Edit", () => edit("Edit criterion", "criteria", criteriaFields, item), 'aria-label="Edit ' + esc(item.title) + '"')
        + '</div><span class="pill">' + esc(item.importance) + "</span>" + facts([["Description", item.description], ["Desired value", [item.desired, item.units].filter(Boolean).join(" ")],
          ["Scope", item.scope], ["Notes", item.notes]]) + evidence("criterionId", item.id) + "</article>").join("") || "<p>Add what each option should meet.</p>") + "</div>";
  }

  function warningText(warning) {
    return warning ? '<p class="' + (warning.startsWith("Failed") ? "hard" : "warn") + '">' + esc(warning) + "</p>" : "";
  }

  function prices(offer) {
    const total = P.total(offer);
    let price = "Price unknown";
    if (total !== null) price = (offer.estimated ? "Estimated total " : "Total ") + amount(total, offer.currency);
    else if (offer.price != null) price = (offer.estimated ? "Estimated " : "Listed ") + amount(offer.price, offer.currency) + " · total unknown";
    return "<p>" + esc(name(offer) + " · " + price) + "</p>" + (offer.availability ? "<p>" + esc(offer.availability) + "</p>" : "")
      + (P.stale(offer.checkedOn) ? '<p class="warn">' + (offer.checkedOn ? "May be stale · " + esc(offer.checkedOn) : "Check date unknown") + "</p>"
        : '<p class="muted">Checked ' + esc(offer.checkedOn) + "</p>");
  }

  function offerCard(option, offer) {
    const history = current.offerHistory.filter(entry => entry.offerId === offer.id);
    return '<div class="record">' + prices(offer) + button("Edit offer", () => editOffer(option, offer))
      + facts([["Condition", offer.condition], ["Location", offer.location], ["Listed price", offer.price], ["Shipping", offer.shipping], ["Taxes", offer.taxes],
        ["Discount", offer.discount], ["Required extras", offer.extras], ["Returns", offer.returns], ["Warranty", offer.warranty], ["Delivery", offer.delivery]])
      + link(offer.url, "View offer") + evidence("offerId", offer.id)
      + (history.length ? "<details><summary>Price and availability history</summary>" + history.map(entry => prices(entry.data)
        + '<p class="muted">Recorded ' + esc(entry.recordedAt.slice(0, 10)) + "</p>").join("") + "</details>" : "") + "</div>";
  }

  const tradeoffs = option => facts([["Pros", option.pros], ["Cons", option.cons], ["Concerns", option.concerns], ["Questions", option.questions], ["Reason", option.reason]]);
  function options() {
    return bar("Options", button("Add option", () => edit("Add option", "options", optionFields, null, { kind: "Product", status: "Considering" }), primary))
      + (current.options.map(option => {
        const offers = current.offers.filter(item => item.optionId === option.id);
        const warnings = current.criteria.map(criterion => {
          const warning = P.requirement(criterion, check(option, criterion));
          return warningText(warning && warning + " · " + criterion.title);
        }).join("");
        return '<article class="record"><div class="bar"><div><h3>' + esc(name(option)) + '</h3><p class="muted">'
          + esc(option.kind + " · " + (option.status || "Considering") + (offers.length ? "" : " · No seller offers recorded")) + "</p></div>"
          + button("Edit option", () => edit("Edit option", "options", optionFields, option)) + "</div>" + warnings
          + facts([["Maker", option.maker], ["Model", option.model], ["Version", option.version], ["Description", option.description], ["Specifications", option.specifications]])
          + tradeoffs(option) + link(option.url) + evidence("optionId", option.id)
          + "<details><summary>Criteria checks (" + current.criteria.length + ')</summary><div class="stack">'
          + (current.criteria.map(criterion => '<div class="bar"><span>' + esc(criterion.title + " · " + (check(option, criterion)?.verdict || "Unverified"))
            + "</span>" + button("Edit check", () => editCheck(option, criterion), 'aria-label="Edit check for ' + esc(criterion.title) + '"') + "</div>").join("")
            || "<p>Add criteria before checking this option.</p>") + "</div></details>"
          + "<details><summary>Seller offers (" + offers.length + ')</summary><div class="stack">'
          + button("Add seller offer", () => editOffer(option)) + offers.map(offer => offerCard(option, offer)).join("") + "</div></details></article>";
      }).join("") || "<p>Add a candidate, prototype, or idea to compare.</p>");
  }
  function fileLink(id) {
    if (!id) return "";
    const file = active().find(item => item.id === id);
    return file ? ' <a href="' + fileUrl(current.id, id) + '/download">' + esc(file.filename) + "</a>" : ' <span class="muted">File unavailable</span>';
  }

  function evidence(key, id) {
    return current.research.filter(item => item[key] === id).map(item => '<div><strong>' + esc(item.title) + "</strong>"
      + facts([["Source type", item.kind], ["Source", item.source], ["Date", item.checkedOn], ["Finding", item.notes]])
      + link(item.url) + fileLink(item.attachmentId) + "</div>").join("");
  }

  function compare() {
    if (!current.options.length) return "<h2>Compare</h2><p>Add an option to start comparing.</p>";
    selected ??= new Set(current.options.slice(0, 3).map(item => item.id));
    const columns = current.options.filter(item => selected.has(item.id));
    const controls = current.options.map(item => button(name(item), () => {
      if (selected.has(item.id)) selected.delete(item.id);
      else selected.add(item.id);
      renderDetail();
      view.querySelector('[data-option="' + item.id + '"]').focus();
    }, 'data-option="' + item.id + '" aria-pressed="' + selected.has(item.id) + '"')).join("");
    function row(label, cell, details = "") {
      return '<tr><th scope="row">' + esc(label) + (details ? '<p class="muted">' + esc(details) + "</p>" : "") + "</th>"
        + columns.map(item => "<td>" + cell(item) + "</td>").join("") + "</tr>";
    }
    const rows = current.criteria.map(criterion => row(criterion.title, option => {
      const result = check(option, criterion);
      return "<strong>" + esc(result?.verdict || "Unverified") + "</strong>" + warningText(P.requirement(criterion, result))
        + facts([["Actual", result?.actual], ["Checked", result?.checkedOn], ["Notes", result?.notes]]) + link(result?.url, "Assessment evidence")
        + (result ? evidence("assessmentId", result.id) : "") + "<p>" + button("Edit check", () => editCheck(option, criterion),
          'aria-label="Edit ' + esc(criterion.title) + ' for ' + esc(name(option)) + '"') + "</p>";
    }, [criterion.importance, criterion.scope, [criterion.desired, criterion.units].filter(Boolean).join(" ")].filter(Boolean).join(" · "))).join("");
    return bar("Compare") + '<div class="actions" role="group" aria-label="Options to compare">' + controls + "</div>"
      + (columns.length ? '<p class="muted">Scroll across to compare options. Prices use the seller’s currency.</p>'
        + '<div class="table-scroll" tabindex="0" role="region" aria-label="Side-by-side comparison"><table><caption>Criteria, prices, and trade-offs</caption><thead><tr><th scope="col">Criteria</th>'
        + columns.map(item => '<th scope="col">' + esc(name(item)) + '<p class="muted">' + esc(item.kind) + "</p></th>").join("")
        + "</tr></thead><tbody>" + rows
        + row("Seller offers", option => current.offers.filter(item => item.optionId === option.id)
          .map(offer => prices(offer) + link(offer.url, "Seller link") + evidence("offerId", offer.id)).join("") || "No seller offers recorded")
        + row("Trade-offs", option => tradeoffs(option) || "No notes")
        + row("Option evidence", option => evidence("optionId", option.id) || "No linked evidence") + "</tbody></table></div>"
        : "<p>Select an option to compare.</p>");
  }

  function fileCard(file) {
    const url = fileUrl(current.id, file.id);
    return '<div class="record"><h3>' + esc(file.filename) + "</h3>"
      + (file.pending ? '<p class="muted">Upload incomplete</p>' : "")
      + (file.removed ? '<p class="muted">Removed</p>' : "")
      + (!file.pending && !file.removed && images.includes(file.mime) ? '<img class="photo" alt="' + esc(file.filename) + '" loading="lazy" src="' + url + '/preview">' : "")
      + '<div class="actions">' + (!file.pending && !file.removed ? fileLink(file.id) : "")
      + button(file.removed ? "Restore file" : "Remove file", async () => {
        try {
          await api(file.removed ? url + "/restore" : url, file.removed ? "POST" : "DELETE", undefined, { "X-DCC-Attachment": "1" });
          file.removed = !file.removed;
          feedback.textContent = file.removed ? "File removed" : "File restored";
          renderDetail(true);
        } catch (error) { feedback.textContent = error.message; }
      }) + "</div></div>";
  }

  function research() {
    return bar("Research", button("Add research", () => edit("Add research", "research", researchFields()), primary) + button("Add file", () => capture(true)))
      + (current.research.map(item => '<article class="record"><div class="bar"><h3>' + esc(item.title) + "</h3>"
        + button("Edit research", () => edit("Edit research", "research", researchFields(), item)) + "</div>"
        + facts([["Type", item.kind], ["Source", item.source], ["Date", item.checkedOn], ["Notes", item.notes],
          ["Criterion", find("criteria", item.criterionId)?.title], ["Option", item.optionId && name(find("options", item.optionId))],
          ["Seller", find("offers", item.offerId)?.title], ["Assessment", item.assessmentId && checkName(find("assessments", item.assessmentId))]])
        + link(item.url) + fileLink(item.attachmentId) + "</article>").join("") || '<p class="muted">Add a source, note, or file.</p>')
      + '<details class="panel"><summary>Private files (' + active().length + ')</summary><div class="stack">'
      + (fileError ? "<p>" + esc(fileError) + "</p>" : "") + (files.map(fileCard).join("") || "<p>No files uploaded.</p>") + "</div></details>";
  }

  function capture(fileFirst = false) {
    open(fileFirst ? "Add a private file" : "Quick capture", '<form><div class="editor-fields">'
      + (fileFirst ? "" : field(["title", "Title"]) + field(["url", "Link", "url"]) + field(note("notes", "Thought or finding")))
      + '<label class="wide">Photo or document<input name="file" type="file" accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.md,.csv"' + (fileFirst ? " required" : "") + '></label>'
      + '</div><p class="muted">' + (storage ? "Files up to 10 MB." : "Private file storage is currently unavailable.")
      + '</p><div class="editor-actions"><button class="primary">Save capture</button></div></form>');
    const formNode = $("#editor-body form");
    let fileId, uploaded, mutationId, previous;
    formNode.elements.file.onchange = () => { fileId = null; uploaded = false; };
    formNode.onsubmit = event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const file = form.get("file");
      const hasFile = Boolean(file?.size);
      const notes = String(form.get("notes") || "").trim();
      const url = String(form.get("url") || "").trim();
      const label = String(form.get("title") || "").trim();
      if (!label && !notes && !url && !hasFile) { status.textContent = "Add a thought, link, or file."; return; }
      void submit(async () => {
        if (hasFile && !uploaded) {
          const upload = new FormData();
          upload.append("file", file);
          fileId ||= crypto.randomUUID();
          const result = await api(base(current.id) + "/attachments", "POST", upload, { "X-DCC-Attachment": "1", "X-Upload-Id": fileId });
          files = [...files.filter(item => item.id !== result.id), result];
          uploaded = true;
        }
        const data = { title: (label || (hasFile && file.name) || notes.split("\n")[0] || url).slice(0, 300),
          url: url || null, notes: notes || null, attachmentId: hasFile ? fileId : null };
        const fingerprint = JSON.stringify(data);
        if (fingerprint !== previous) mutationId = crypto.randomUUID();
        previous = fingerprint;
        const message = await write("research", null, data, mutationId);
        section = 4;
        saved(message);
      });
    };
  }

  function addTask() {
    editor("Create an unscheduled next-action task", [title, note("notes", "Link notes")], {}, async (data, id) => {
      const result = await api(base(current.id) + "/next-task", "POST", { ...data, id });
      current.tasks = [...current.tasks.filter(item => item.id !== result.id), result];
      saved("Next-action task created");
    });
  }

  function decision() {
    const selected = current.options.filter(item => item.status === "Selected");
    const decided = current.stage === "Decided";
    const change = () => editor(decided ? "Reopen research" : "Mark decided",
      decided ? [select("stage", "Research stage", stages.filter(stage => stage !== "Decided"), true)] : decisionFields,
      decided ? { stage: "Researching" } : current,
      async (data, id) => saved(await write("overview", current, decided ? data : { ...data, stage: "Decided" }, id)));
    return '<div class="panel">' + bar("Decision", button("Edit decision", () => edit("Edit decision", "overview", decisionFields, current))
      + button(decided ? "Reopen research" : "Mark decided", change))
      + facts([["Outcome", current.outcome], ["Date", current.decisionOn], ["Rationale", current.rationale], ["Alternatives", current.alternatives],
        ["Compromises", current.compromises], ["Uncertainties", current.uncertainties]])
      + "<h3>Selected options</h3>" + (selected.length ? "<ul>" + selected.map(item => "<li>" + esc(name(item) + (item.reason ? " · " + item.reason : "")) + "</li>").join("") + "</ul>"
        : "<p>Choose Selected on any option you want to keep.</p>") + '</div><div class="panel">' + bar("Next actions", button("Link a task", () => taskPicker(false)) + button("Create a task", addTask))
      + (current.nextAction ? "<p>" + esc(current.nextAction) + "</p>" : "")
      + (current.tasks.map(item => '<div class="record"><h3>' + esc(item.task?.title || "Task unavailable") + "</h3>"
        + facts([["Scheduled", item.task?.date], ["Status", item.task?.status], ["Notes", item.notes]])
        + button("Edit link notes", () => edit("Edit link notes", "tasks", [note("notes", "Notes")], item)) + "</div>").join("") || "<p>No linked tasks.</p>") + "</div>";
  }

  document.addEventListener("click", event => {
    const control = event.target.closest("button[data-action]");
    if (control && !busy) actions.get(control.dataset.action)?.();
  });
  $("#close-editor").onclick = () => dialog.close();
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });

  async function start() {
    try {
      const id = new URLSearchParams(window.location.search).get("id");
      if (!id) return renderList(await api(base()));
      current = await api(base(id));
      try {
        const result = await api(base(id) + "/attachments");
        files = result.files;
        storage = result.configured;
      } catch (error) { fileError = error.message; }
      renderDetail();
    } catch (error) {
      view.innerHTML = '<h1>Wishlists</h1><p role="alert">' + esc(error.message) + '</p><a href="/wishlists">All Wishlists</a>';
    } finally {
      view.removeAttribute("aria-busy");
    }
  }
  void start();
})();
