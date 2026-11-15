(function () {
  function append(parent, tag, text) {
    const element = document.createElement(tag);
    element.textContent = text || "";
    parent.appendChild(element);
    return element;
  }

  function button(parent, label, action) {
    const element = append(parent, "button", label);
    element.type = "button";
    element.addEventListener("click", action);
    return element;
  }

  function field(parent, label, tag) {
    return append(append(parent, "label", label + " "), tag);
  }

  function directionsLink(parent, label) {
    const link = append(parent, "a", label);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  }

  function directionsUrl(destination, origin) {
    const url = new URL("https://www.google.com/maps/dir/");
    url.searchParams.set("api", "1");
    url.searchParams.set("destination", destination);
    if (origin) url.searchParams.set("origin", origin);
    return url.href;
  }

  function navigationUrl(value) {
    if (!value || value.length > 4096) return null;
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  }

  function linkedEndpoints(url) {
    if (!url) return {};
    const params = url.searchParams;
    if (url.hostname === "maps.apple.com") {
      return {
        origin: params.get("source") || params.get("saddr"),
        destination: params.get("destination") || params.get("daddr")
      };
    }
    if (["google.com", "www.google.com", "maps.google.com"].includes(url.hostname)) {
      const [, , , from, to] = url.pathname.split("/");
      const decode = part => {
        if (!part || /^[@!]|^data=/.test(part)) return "";
        try {
          return decodeURIComponent(part.replace(/\+/g, " "));
        } catch {
          return "";
        }
      };
      const isDirections = url.pathname.startsWith("/maps/dir/");
      return {
        origin: params.get("origin") || params.get("saddr") || (isDirections && decode(from)),
        destination: params.get("destination") || params.get("daddr") || (isDirections && decode(to))
      };
    }
    return {};
  }

  function drawRouteLinks(parent, route) {
    parent.replaceChildren();
    const original = typeof route?.url === "string" ? navigationUrl(route.url) : null;
    if (original) directionsLink(parent, "Open saved link").href = original.href;
    if (!route?.destination) return;
    directionsLink(parent, "Google Maps").href = directionsUrl(route.destination, route.origin);
    if (!route.origin) return;
    const apple = new URL("https://maps.apple.com/directions");
    apple.searchParams.set("source", route.origin);
    apple.searchParams.set("destination", route.destination);
    directionsLink(parent, "Apple Maps").href = apple.href;
  }

  // Saved places can supply an icon key and a color through the same location object.
  const locationIcons = new Map([
    ["pin", "M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0ZM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"],
    ["home", "m3 11 9-8 9 8M5 10v11h5v-6h4v6h5V10"],
    ["work", "M3 8h18v12H3zM8 8V4h8v4M3 13h18"]
  ]);

  window.mountItineraryLocation = (card, task, openDetails) => {
    const title = card.querySelector(".it-list-title-row > .ttl");
    if (!title || !task._blockId || !window.DCC_ACCOUNT_CONTEXT?.userId) return;
    const cached = window.blockStore.get(task._blockId);
    const location = cached ? cached.properties.taskLocation : task.taskLocation;
    const destination = destinationOf(location);
    const control = document.createElement(destination ? "a" : "button");
    control.className = "it-location-pin";
    const label = destination ? "Directions to " + (location.label || destination) : "Add task location";
    control.title = destination || "Location unknown";
    control.setAttribute("aria-label", label);
    if (destination) {
      control.dataset.known = "true";
      control.href = directionsUrl(destination);
      control.target = "_blank";
      control.rel = "noopener noreferrer";
      if (/^#[0-9a-f]{6}$/i.test(location.color || "")) control.style.color = location.color;
    } else {
      control.type = "button";
    }
    const icon = destination && locationIcons.has(location.icon) ? location.icon : "pin";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", locationIcons.get(icon));
    svg.append(path);
    control.append(svg);
    control.addEventListener("click", event => {
      event.stopPropagation();
      if (!destination) {
        openDetails();
        document.querySelector(".it-task-location input")?.focus();
      }
    });
    control.addEventListener("dragstart", event => event.preventDefault());
    title.after(control);
  };

  function destinationOf(location) {
    return location?.address || location?.label || "";
  }

  function writeTask(blockId, merge) {
    return enqueueRowPropsWrite(blockId, merge, { _reportSaveStatus: true }, { rejectOnError: true });
  }

  function snapshot(value) {
    return JSON.stringify(value, (_, value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
    });
  }

  function legAssets(leg) {
    return leg.assets || (/^https:\/\//i.test(leg.url || "") ? [{ kind: "Link", url: leg.url }] : []);
  }

  function appendAsset(parent, asset, attachmentBase) {
    const label = asset.kind + " · " + (asset.filename || asset.url);
    if (!asset.id && !/^https?:\/\//i.test(asset.url || "")) return;
    const link = append(parent, "a", label);
    link.href = asset.id ? attachmentBase + "/" + encodeURIComponent(asset.id) + "/download" : asset.url;
    link.addEventListener("click", event => {
      event.preventDefault();
      previewAsset(asset, link.href);
    });
  }

  async function previewAsset(asset, href) {
    const dialog = append(document.body, "dialog");
    dialog.className = "it-commute-preview";
    const heading = append(dialog, "h2", asset.filename || asset.kind);
    heading.id = "commute-preview-" + crypto.randomUUID();
    dialog.setAttribute("aria-labelledby", heading.id);
    button(dialog, "Close preview", () => dialog.close());
    const status = append(dialog, "p", asset.id ? "Loading attachment…" : "Open this link at its original provider.");
    status.setAttribute("role", "status");
    const original = append(dialog, "a", asset.id ? "Download original" : "Open original link");
    if (asset.id) {
      original.hidden = true;
      original.download = asset.filename || "attachment";
    } else {
      original.href = href;
      original.target = "_blank";
      original.rel = "noopener noreferrer";
    }
    const request = new AbortController();
    const accountId = window.DCC_ACCOUNT_CONTEXT?.userId;
    let objectUrl;
    let downloadUrl;
    dialog.addEventListener("close", () => {
      request.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      dialog.remove();
    }, { once: true });
    dialog.showModal();
    if (!asset.id) return;
    try {
      const response = await fetch(href, { cache: "no-store", signal: request.signal });
      if (!response.ok) throw new Error("Attachment preview could not be loaded.");
      const blob = await response.blob();
      if (!dialog.open || accountId !== window.DCC_ACCOUNT_CONTEXT?.userId) return;
      downloadUrl = URL.createObjectURL(blob);
      original.href = downloadUrl;
      original.hidden = false;
      const extension = asset.filename?.split(".").pop().toLowerCase();
      const imageTypes = new Map([["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["gif", "image/gif"], ["webp", "image/webp"]]);
      const imageType = imageTypes.get(extension);
      if (imageType || extension === "pdf") {
        objectUrl = URL.createObjectURL(blob.slice(0, blob.size, imageType || "application/pdf"));
        const preview = append(dialog, imageType ? "img" : "iframe");
        if (imageType) preview.alt = asset.filename;
        else {
          preview.title = asset.filename;
          preview.setAttribute("sandbox", "");
        }
        preview.src = objectUrl;
      } else if (["txt", "md", "csv"].includes(extension)) {
        const content = await blob.text();
        if (dialog.open && accountId === window.DCC_ACCOUNT_CONTEXT?.userId) append(dialog, "pre", content);
      } else {
        status.textContent = "Preview is unavailable for this file type.";
        return;
      }
      status.textContent = "";
    } catch (error) {
      if (!request.signal.aborted) status.textContent = error.message;
    }
  }

  function legTitle(leg, index) {
    return (index + 1) + ". " + leg.mode + " · " + (leg.minutes == null ? "Time pending" : leg.minutes + " min");
  }

  function render(task) {
    const blockId = task._blockId;
    const attachmentBase = "/api/tasks/" + encodeURIComponent(blockId) + "/attachments";
    const uploadIds = new WeakMap();
    async function upload(file) {
      if (!uploadIds.has(file)) uploadIds.set(file, crypto.randomUUID());
      const body = new FormData();
      body.append("file", file);
      const response = await fetch(attachmentBase, {
        method: "POST",
        headers: { "X-DCC-Attachment": "1", "X-Upload-Id": uploadIds.get(file) },
        body
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Upload failed");
      return result;
    }
    const row = document.createElement("details");
    row.className = "it-commute";
    const summary = append(row, "summary", "Add commute");
    const panel = append(row, "div");
    panel.className = "it-commute-panel";
    const taskDestination = destinationOf(task.taskLocation);
    const suggested = suggestedCommuteOrigin(blockId);
    let savedRoute = task.commuteEndpoints || null;
    const savedLinks = append(panel, "div");
    savedLinks.className = "it-commute-route-links";
    const draft = append(panel, "details");
    const draftSummary = append(draft, "summary");
    const routeForm = append(draft, "form");
    routeForm.className = "it-commute-route-form";
    const routeLink = field(routeForm, "Navigation link", "input");
    routeLink.type = "url";
    routeLink.maxLength = 4096;
    routeLink.placeholder = "Paste a maps link";
    const origin = field(routeForm, "From", "input");
    origin.maxLength = 180;
    origin.placeholder = "Starting point";
    const destination = field(routeForm, "To", "input");
    destination.maxLength = 180;
    destination.placeholder = "Destination";
    let imported;
    function resetRouteForm() {
      routeLink.value = savedRoute?.url || "";
      routeLink.setCustomValidity("");
      origin.value = savedRoute?.origin ?? suggested;
      destination.value = savedRoute?.destination ?? taskDestination;
      imported = linkedEndpoints(navigationUrl(routeLink.value));
    }
    resetRouteForm();
    if (suggested) button(routeForm, "Use previous stop", () => {
      origin.value = suggested;
      updateDirections();
    });
    append(routeForm, "button", "Save route");
    const removeRoute = button(routeForm, "Remove route", async () => {
      if (await save(legs, null)) {
        resetRouteForm();
        updateDirections();
        routeLink.focus();
      }
    });
    const draftLinks = append(draft, "div");
    draftLinks.className = "it-commute-route-links";
    const review = append(panel, "p");
    function updateDirections() {
      drawRouteLinks(draftLinks, {
        url: routeLink.value.trim(),
        origin: origin.value.trim(),
        destination: destination.value.trim()
      });
    }
    function importRouteLink() {
      const parsed = navigationUrl(routeLink.value.trim());
      routeLink.setCustomValidity(routeLink.value && !parsed ? "Enter an http:// or https:// link." : "");
      if (parsed) {
        const linked = linkedEndpoints(parsed);
        for (const [key, input] of [["origin", origin], ["destination", destination]]) {
          if (linked[key] && linked[key].length <= input.maxLength) input.value = linked[key];
          else if (input.value === imported[key]) input.value = "";
        }
        imported = linked;
      }
      updateDirections();
    }
    routeLink.addEventListener("input", importRouteLink);
    routeLink.addEventListener("dragover", event => {
      if (event.dataTransfer.types.includes("text/uri-list")) event.preventDefault();
    });
    routeLink.addEventListener("drop", event => {
      const link = event.dataTransfer.getData("text/uri-list").split(/\r?\n/).find(line => line && !line.startsWith("#"));
      if (!link) return;
      event.preventDefault();
      routeLink.value = link;
      importRouteLink();
    });
    origin.addEventListener("input", updateDirections);
    destination.addEventListener("input", updateDirections);
    updateDirections();
    routeForm.addEventListener("submit", async event => {
      event.preventDefault();
      const endpoints = draftEndpoints();
      if (!endpoints.url && !(endpoints.origin && endpoints.destination)) {
        status.textContent = "Paste a navigation link or enter both From and To.";
        return;
      }
      if (await save(legs, endpoints)) {
        draft.open = false;
        draftSummary.focus();
      }
    });
    const legsContainer = append(panel, "div");
    legsContainer.className = "it-commute-legs";
    const status = append(panel, "p");
    status.setAttribute("role", "status");
    let savedLegs = snapshot(task.incomingCommute || []);
    let legs = (task.incomingCommute || []).map((leg, index) => ({
      ...leg,
      id: leg.id || "planned-" + index,
      assets: legAssets(leg)
    }));

    function draftEndpoints() {
      const from = origin.value.trim();
      const to = destination.value.trim();
      const url = navigationUrl(routeLink.value.trim())?.href;
      return {
        origin: from,
        destination: to,
        usedPreviousStop: Boolean(suggested && from === suggested),
        ...(url ? { url } : {}),
        usesTaskLocation: Boolean(taskDestination && to === taskDestination)
      };
    }

    function updateSummary() {
      clearButton.hidden = !legs.length;
      addButton.textContent = legs.length || savedRoute ? "Add leg" : "Save commute";
      summary.textContent = legs.length ? "Commute · " + legs.length + (legs.length === 1 ? " leg" : " legs") : savedRoute ? "Commute" : "Add commute";
      draftSummary.textContent = savedRoute ? "Edit route" : "Plan commute";
      removeRoute.hidden = !savedRoute;
      drawRouteLinks(savedLinks, savedRoute);
      const locationChanged = savedRoute && (savedRoute.usesTaskLocation || (!savedRoute.url && !("usesTaskLocation" in savedRoute))) &&
        savedRoute.destination !== taskDestination;
      const previousStopChanged = savedRoute?.usedPreviousStop && savedRoute.origin !== suggested;
      review.textContent = locationChanged || previousStopChanged ? "Review route: the location or previous stop has changed." : "";
      review.hidden = !review.textContent;
    }

    async function save(next, endpoints) {
      panel.inert = true;
      try {
        const result = await writeTask(blockId, props => {
          if (snapshot(props.incomingCommute || []) !== savedLegs) {
            throw new Error("The saved legs changed. Reopen Task Details before editing them.");
          }
          if (endpoints !== undefined && snapshot(props.commuteEndpoints || null) !== snapshot(savedRoute)) {
            throw new Error("The saved route changed. Reopen Task Details before editing it.");
          }
          if (endpoints?.usesTaskLocation && destinationOf(props.taskLocation) !== endpoints.destination) {
            throw new Error("The task location changed. Reopen Task Details to plan from the new location.");
          }
          return {
            ...props,
            incomingCommute: next,
            commuteEndpoints: endpoints === undefined ? props.commuteEndpoints || null : endpoints
          };
        });
        savedLegs = snapshot(next);
        savedRoute = result?.properties ? result.properties.commuteEndpoints || null :
          endpoints === undefined ? savedRoute : endpoints;
        legs = next;
        status.textContent = result?._savePending ? "Saved locally. Waiting to sync." : "";
        updateSummary();
        drawLegs();
        for (const card of document.querySelectorAll('[data-commute-task="' + CSS.escape(blockId) + '"]')) {
          updateTopper(card, blockId, legs, savedRoute);
        }
        if (typeof refoldTaskStateFromBlockCache === "function") refoldTaskStateFromBlockCache();
        return true;
      } catch (error) {
        status.textContent = error.message || "Could not save the commute.";
        return false;
      } finally {
        panel.inert = false;
      }
    }

    function drawLegs() {
      const openLegs = new Set(Array.from(legsContainer.children).filter(section => section.open).map(section => section.dataset.legId));
      legsContainer.replaceChildren();
      legs.forEach((leg, index) => {
        const section = append(legsContainer, "details");
        section.className = "it-commute-leg";
        section.dataset.legId = leg.id;
        section.open = openLegs.has(leg.id);
        append(section, "summary", legTitle(leg, index));
        const change = assets => save(legs.map((item, i) => i === index ? { ...item, assets } : item));
        leg.assets.forEach((asset, assetIndex) => {
          const entry = append(section, "div");
          appendAsset(entry, asset, attachmentBase);
          const remove = button(entry, "Unlink", () => change(leg.assets.filter((_, i) => i !== assetIndex)));
          remove.setAttribute("aria-label", "Unlink " + asset.kind + " " + (asset.filename || asset.url));
        });

        const notesForm = append(section, "form");
        const notes = field(notesForm, "Leg notes", "textarea");
        notes.value = leg.notes || "";
        notes.maxLength = 4000;
        append(notesForm, "button", "Save notes");
        notesForm.addEventListener("submit", event => {
          event.preventDefault();
          save(legs.map((item, i) => i === index ? { ...item, notes: notes.value.trim() } : item));
        });

        const form = append(section, "form");
        const kind = field(form, "Attachment type", "select");
        ["Receipt", "Reservation", "Link", "Ticket screenshot"].forEach(label => append(kind, "option", label));
        const file = field(form, "File", "input");
        file.type = "file";
        file.required = true;
        const url = field(form, "URL", "input");
        url.type = "url";
        function selectType() {
          const isLink = kind.value === "Link";
          url.parentElement.hidden = !isLink;
          file.parentElement.hidden = isLink;
          url.required = isLink;
          file.required = !isLink;
          file.accept = kind.value === "Ticket screenshot" ? "image/*" : "";
        }
        selectType();
        kind.addEventListener("change", selectType);
        append(form, "button", "Add attachment");
        form.addEventListener("submit", async event => {
          event.preventDefault();
          const asset = { kind: kind.value };
          if (kind.value === "Link") {
            const parsed = new URL(url.value);
            if (!["https:", "http:"].includes(parsed.protocol)) {
              status.textContent = "Enter a web link starting with https:// or http://.";
              return;
            }
            asset.url = parsed.href;
          } else {
            const selected = file.files[0];
            if (!selected || selected.size > 10 * 1024 * 1024 ||
                (kind.value === "Ticket screenshot" && !selected.type.startsWith("image/"))) {
              status.textContent = "Choose a file up to 10 MB. Ticket screenshots must be images.";
              return;
            }
            panel.inert = true;
            try {
              const uploaded = await upload(selected);
              asset.id = uploaded.id;
              asset.filename = uploaded.filename;
            } catch (error) {
              status.textContent = error.message || "Could not upload the attachment.";
              return;
            } finally {
              panel.inert = false;
            }
          }
          await change([...leg.assets, asset]);
        });
        button(section, "Remove leg", () => {
          if (leg.assets.length && !window.confirm("Remove this leg and unlink its attachments? Uploaded files will remain in task files.")) return;
          save(legs.filter((_, i) => i !== index));
        });
      });
    }

    const add = append(panel, "form");
    add.className = "it-commute-add";
    add.hidden = true;
    const mode = field(add, "Travel mode", "select");
    ["Walk", "Train", "Car", "Bus", "Subway", "Plane", "Bike", "Ferry", "Other"].forEach(label => append(mode, "option", label));
    const duration = field(add, "Minutes", "input");
    duration.type = "number";
    duration.min = "1";
    duration.max = "1440";
    duration.placeholder = "Optional";
    const addButton = append(add, "button", legs.length ? "Add leg" : "Save commute");
    addButton.type = "submit";
    const clearButton = button(add, "Clear commute", async () => {
      if (!window.confirm("Clear the commute route and all legs? Uploaded files will remain in task files.")) return;
      if (await save([], null)) {
        resetRouteForm();
        updateDirections();
        mode.focus();
      }
    });
    add.addEventListener("submit", async event => {
      event.preventDefault();
      const endpoints = draft.open && !savedRoute && !routeLink.value && taskDestination && destination.value.trim()
        ? draftEndpoints() : undefined;
      if (await save([...legs, { id: crypto.randomUUID(), mode: mode.value, minutes: duration.value ? Number(duration.value) : null, assets: [] }], endpoints)) {
        add.reset();
        mode.focus();
      }
    });

    if (blockId && window.DCC_ACCOUNT_CONTEXT?.userId) {
      add.hidden = false;
      updateSummary();
      drawLegs();
    }
    return row;
  }

  window.mountTaskCommute = (host, blockId) => {
    const block = blockId && window.DCC_ACCOUNT_CONTEXT?.userId && window.blockStore.get(blockId);
    if (!host) return;
    host.replaceChildren();
    if (!block) return;
    const location = block.properties.taskLocation;
    const form = append(host, "form");
    form.className = "it-task-location";
    append(form, "strong", "Location");
    const name = field(form, "Place name", "input");
    name.value = location?.label || "";
    name.maxLength = 180;
    const address = field(form, "Address", "input");
    address.value = location?.address || "";
    address.maxLength = 180;
    const submit = append(form, "button", "Save location");
    const directions = directionsLink(form, "Directions");
    const status = append(form, "p");
    status.setAttribute("role", "status");
    const commute = append(host, "div");

    function refresh(props) {
      const destination = destinationOf(props.taskLocation);
      directions.hidden = !destination;
      directions.href = destination ? directionsUrl(destination) : "";
      commute.replaceChildren(render({ ...props, _blockId: blockId }));
    }

    form.addEventListener("submit", async event => {
      event.preventDefault();
      const label = name.value.trim();
      const street = address.value.trim();
      submit.disabled = true;
      try {
        const result = await writeTask(blockId, props => ({
          ...props, taskLocation: label || street ? { ...props.taskLocation, label, address: street } : null
        }));
        status.textContent = result?._savePending ? "Saved locally. Waiting to sync." : label || street ? "Location saved." : "Location cleared.";
        if (form.isConnected) refresh(window.blockStore.get(blockId).properties);
        if (typeof buildListView === "function") buildListView();
      } catch (error) {
        status.textContent = error.message || "Could not save location.";
      } finally {
        submit.disabled = false;
      }
    });
    refresh(block.properties);
  };

  function updateTopper(card, blockId, legs, savedRoute) {
    const previous = card.querySelector(":scope > .it-commute-topper");
    if (!legs.length && !savedRoute) {
      previous?.remove();
      return;
    }
    const topper = document.createElement("details");
    topper.className = "it-commute-topper";
    const minutes = legs.reduce((total, leg) => total + (leg.minutes || 0), 0);
    const label = !legs.length ? "Commute route" : legs.some(leg => leg.minutes == null)
      ? "Commute · Time pending"
      : minutes + " Minute commute";
    append(topper, "summary", label).className = "it-commute-handle";
    const routeLinks = append(topper, "div");
    routeLinks.className = "it-commute-route-links";
    drawRouteLinks(routeLinks, savedRoute);
    const route = append(topper, "div");
    route.className = "it-commute-cards";
    const attachmentBase = "/api/tasks/" + encodeURIComponent(blockId) + "/attachments";
    legs.forEach((leg, index) => {
      const section = append(route, "details");
      section.className = "it-commute-leg";
      append(section, "summary", legTitle(leg, index));
      const body = append(section, "div");
      body.className = "it-commute-card-body";
      if (leg.notes) append(body, "p", leg.notes);
      for (const asset of legAssets(leg)) appendAsset(body, asset, attachmentBase);
      if (!body.childElementCount) append(body, "p", "No notes or attachments yet.");
    });
    topper.addEventListener("click", event => event.stopPropagation());
    topper.addEventListener("dragstart", event => event.preventDefault());
    topper.open = previous?.open || false;
    if (previous) previous.replaceWith(topper);
    else card.prepend(topper);
  }

  window.mountItineraryCommute = (card, task) => {
    if (!task._blockId || !window.DCC_ACCOUNT_CONTEXT?.userId) return;
    card.dataset.commuteTask = task._blockId;
    updateTopper(card, task._blockId, task.incomingCommute || [], task.commuteEndpoints);
    const links = append(card.querySelector(".it-list-main") || card, "div");
    links.className = "it-arrival-links";
    for (const entry of task.arrivalLinks || []) {
      if (typeof entry?.url !== "string" || !/^https:\/\//i.test(entry.url)) continue;
      const link = append(links, "a", entry.label || "Open link");
      link.href = entry.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    if (!links.childElementCount) links.remove();
  };
})();
