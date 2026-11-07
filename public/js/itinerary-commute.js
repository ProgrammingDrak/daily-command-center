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
    const summary = append(row, "summary", "Getting there · + Add commute");
    const panel = append(row, "div");
    const legsContainer = append(panel, "div");
    legsContainer.className = "it-commute-legs";
    const status = append(panel, "p");
    status.setAttribute("role", "status");
    let legs = (task.incomingCommute || []).map((leg, index) => ({
      ...leg,
      id: leg.id || "planned-" + index,
      assets: leg.assets || (/^https:\/\//i.test(leg.url || "") ? [{ kind: "Link", url: leg.url }] : [])
    }));

    function updateSummary() {
      const minutes = legs.reduce((total, leg) => total + (leg.minutes || 0), 0);
      const duration = [Math.floor(minutes / 60) && Math.floor(minutes / 60) + " hr", minutes % 60 && minutes % 60 + " min"].filter(Boolean).join(" ");
      summary.textContent = legs.length
        ? "Getting there · " + (legs.some(leg => leg.minutes == null) ? "Time pending" : duration) + " · " + legs.map(leg => leg.mode).join(" + ")
        : "Getting there · + Add commute";
    }

    async function save(next) {
      panel.inert = true;
      try {
        const block = window.blockStore.get(blockId);
        if (!block) throw new Error("Task is unavailable. Refresh DCC and retry.");
        const result = await window.blockStore.updateBlock(blockId, {
          ...block.properties, incomingCommute: next
        }, { _reportSaveStatus: true });
        if (result?._savePending) {
          status.textContent = "DCC will retry syncing this edit.";
          return false;
        }
        legs = next;
        status.textContent = "";
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
        append(section, "summary", (index + 1) + ". " + leg.mode + (leg.minutes == null ? "" : " · " + leg.minutes + " min"));
        const change = assets => save(legs.map((item, i) => i === index ? { ...item, assets } : item));
        for (const [assetIndex, asset] of leg.assets.entries()) {
          const entry = append(section, "div");
          append(entry, "span", asset.kind + " · ");
          if (asset.id) {
            const link = append(entry, "a", asset.filename);
            link.href = attachmentBase + "/" + encodeURIComponent(asset.id) + "/download";
          }
          else {
            const link = append(entry, "a", asset.url);
            link.href = asset.url;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
          }
          const remove = button(entry, "Unlink", () => change(leg.assets.filter((_, i) => i !== assetIndex)));
          remove.setAttribute("aria-label", "Unlink " + asset.kind + " " + (asset.filename || asset.url));
        }

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
    add.hidden = true;
    const mode = field(add, "Travel mode", "select");
    ["Walk", "Train", "Car", "Bus", "Subway", "Plane", "Bike", "Ferry", "Other"].forEach(label => append(mode, "option", label));
    const duration = field(add, "Minutes", "input");
    duration.type = "number";
    duration.min = "1";
    duration.max = "1440";
    duration.placeholder = "Unknown";
    append(add, "button", "Add leg");
    add.addEventListener("submit", async event => {
      event.preventDefault();
      if (await save([...legs, { id: crypto.randomUUID(), mode: mode.value, minutes: duration.value ? Number(duration.value) : null, assets: [] }])) {
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

  window.mountItineraryCommute = (card, task) => {
    if (!task._blockId || !window.DCC_ACCOUNT_CONTEXT?.userId) return;
    const route = render(task);
    card.prepend(route);
    route.addEventListener("dragstart", event => event.preventDefault());
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
