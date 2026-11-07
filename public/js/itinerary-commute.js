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

  // Saved places can supply an icon key and a color through the same location object.
  const locationIcons = new Map([
    ["pin", "M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0ZM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"],
    ["home", "m3 11 9-8 9 8M5 10v11h5v-6h4v6h5V10"],
    ["work", "M3 8h18v12H3zM8 8V4h8v4M3 13h18"]
  ]);

  window.mountItineraryLocation = (card, task, openDetails) => {
    const title = card.querySelector(".it-list-title-row > .ttl");
    if (!title || !task._blockId || !window.DCC_ACCOUNT_CONTEXT?.userId) return;
    const location = task.taskLocation;
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

  function legSnapshot(legs) {
    return JSON.stringify(legs || [], (_, value) => {
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
    original.href = href;
    original.target = "_blank";
    original.rel = "noopener noreferrer";
    const request = new AbortController();
    const accountId = window.DCC_ACCOUNT_CONTEXT?.userId;
    let objectUrl;
    dialog.addEventListener("close", () => {
      request.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      dialog.remove();
    }, { once: true });
    dialog.showModal();
    if (!asset.id) return;
    try {
      const response = await fetch(href, { cache: "no-store", signal: request.signal });
      if (!response.ok) throw new Error("Attachment preview could not be loaded.");
      const blob = await response.blob();
      if (!dialog.open || accountId !== window.DCC_ACCOUNT_CONTEXT?.userId) return;
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
    const destination = destinationOf(task.taskLocation);
    const suggested = destination ? suggestedCommuteOrigin(blockId) : "";
    let draft, origin, review, saveRoute;
    if (destination) {
      draft = append(panel, "details");
      append(draft, "summary", "Plan commute");
      append(draft, "p", "To " + destination);
      origin = field(draft, "From", "input");
      origin.maxLength = 180;
      origin.value = task.commuteEndpoints?.origin || suggested;
      origin.placeholder = "Starting point";
      if (suggested) {
        append(draft, "p", "Previous stop: " + suggested);
        button(draft, "Use previous stop", () => {
          origin.value = suggested;
          updateDirections();
        });
      }
      const directions = directionsLink(draft, "Review route in Google Maps");
      function updateDirections() {
        directions.href = directionsUrl(destination, origin.value.trim());
      }
      origin.addEventListener("input", updateDirections);
      updateDirections();
      append(draft, "p", "Review directions, then save the route or add a leg below.");
      saveRoute = button(draft, "Save route endpoints", () => save(legs, draftEndpoints()));
      const saved = task.commuteEndpoints;
      if (saved && (saved.destination !== destination || (saved.usedPreviousStop && saved.origin !== suggested))) {
        review = append(panel, "p", "Review route: the location or previous stop has changed.");
      }
    } else if (task.commuteEndpoints) {
      append(panel, "p", "Review route: the task location was removed.");
    }
    const legsContainer = append(panel, "div");
    legsContainer.className = "it-commute-legs";
    const status = append(panel, "p");
    status.setAttribute("role", "status");
    let savedLegs = legSnapshot(task.incomingCommute);
    let legs = (task.incomingCommute || []).map((leg, index) => ({
      ...leg,
      id: leg.id || "planned-" + index,
      assets: legAssets(leg)
    }));

    function draftEndpoints() {
      const from = origin.value.trim();
      return { origin: from, destination, usedPreviousStop: Boolean(suggested && from === suggested) };
    }

    function updateSummary() {
      if (saveRoute) saveRoute.hidden = !legs.length;
      addButton.textContent = legs.length ? "Add leg" : "Save commute";
      summary.textContent = legs.length ? "Commute · " + legs.length + (legs.length === 1 ? " leg" : " legs") : "Add commute";
    }

    async function save(next, endpoints) {
      panel.inert = true;
      try {
        const result = await writeTask(blockId, props => {
          if (legSnapshot(props.incomingCommute) !== savedLegs) {
            throw new Error("The saved legs changed. Reopen Task Details before editing them.");
          }
          if (endpoints && destinationOf(props.taskLocation) !== endpoints.destination) {
            throw new Error("The task location changed. Reopen Task Details to plan from the new location.");
          }
          return {
            ...props,
            incomingCommute: next,
            commuteEndpoints: next.length ? endpoints || props.commuteEndpoints || null : null
          };
        });
        savedLegs = legSnapshot(next);
        if (endpoints) review?.remove();
        legs = next;
        status.textContent = result?._savePending ? "Saved locally. Waiting to sync." : "";
        updateSummary();
        drawLegs();
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
    add.addEventListener("submit", async event => {
      event.preventDefault();
      const endpoints = draft?.open ? draftEndpoints() : undefined;
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
      } catch (error) {
        status.textContent = error.message || "Could not save location.";
      } finally {
        submit.disabled = false;
      }
    });
    refresh(block.properties);
  };

  window.mountItineraryCommute = (card, task) => {
    if (!task._blockId || !window.DCC_ACCOUNT_CONTEXT?.userId) return;
    const legs = task.incomingCommute || [];
    if (legs.length) {
      const topper = document.createElement("div");
      topper.className = "it-commute-topper";
      append(topper, "strong", "Getting there");
      append(topper, "span", legs.map(leg => leg.mode).join(" → "));
      const minutes = legs.reduce((total, leg) => total + (leg.minutes || 0), 0);
      append(topper, "span", legs.some(leg => leg.minutes == null) ? "Time pending" : minutes + " min").className = "it-commute-time";
      const route = append(topper, "div");
      route.className = "it-commute-cards";
      const attachmentBase = "/api/tasks/" + encodeURIComponent(task._blockId) + "/attachments";
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
      card.prepend(topper);
    }
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
