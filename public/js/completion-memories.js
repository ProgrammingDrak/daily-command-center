(() => {
  const endpoint = "/api/completion-memories";
  const deviceKey = "dcc-memory-device";
  const nameKey = "dcc-memory-device-name";
  let database;

  function localStore(mode, operation) {
    database ||= new Promise((resolve, reject) => {
      const request = indexedDB.open("dcc-completion-photos", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("photos");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(error => {
      database = null;
      throw error;
    });
    return database.then(db => new Promise((resolve, reject) => {
      const transaction = db.transaction("photos", mode);
      const request = operation(transaction.objectStore("photos"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
    }));
  }

  async function resize(image, edge) {
    const scale = Math.min(1, edge / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not save this photo")), "image/jpeg", 0.82);
    });
  }

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function button(text, action, primary = false) {
    const element = node("button", text, primary ? "memory-primary" : "");
    element.type = "button";
    element.onclick = action;
    return element;
  }

  function dialog(title, sheet = false) {
    const element = node("dialog", "", sheet ? "memory-dialog memory-sheet" : "memory-dialog");
    const heading = node("h2", title);
    heading.id = "memory-" + crypto.randomUUID();
    element.setAttribute("aria-labelledby", heading.id);
    const header = node("header");
    header.append(heading, button("Close", () => element.close()));
    const body = node("div", "", "memory-body");
    const status = node("p", "", "memory-status");
    status.setAttribute("role", "status");
    const urls = new Set();
    element.append(header, body, status);
    document.body.append(element);
    element.addEventListener("close", () => {
      urls.forEach(url => URL.revokeObjectURL(url));
      element.remove();
    });
    element.showModal();
    return {
      element, body, status,
      clear(container) {
        for (const img of container.querySelectorAll("img")) {
          URL.revokeObjectURL(img.src);
          urls.delete(img.src);
        }
        container.replaceChildren();
      },
      image(blob, description) {
        const img = node("img");
        img.src = URL.createObjectURL(blob);
        urls.add(img.src);
        img.alt = description;
        return img;
      },
    };
  }

  const list = () => DCC.api(endpoint, { cache: "no-store" });
  const save = (entry, change) => DCC.api(endpoint, {
    method: "POST",
    headers: { "x-dcc-memory": "1" },
    body: { blockId: entry.block_id, revision: entry.revision, ...change },
  });

  function defaultDeviceName() {
    const agent = navigator.userAgent;
    const platform = navigator.userAgentData?.platform || navigator.platform || "";
    if (/iPhone/i.test(agent)) return "iPhone";
    if (/iPad/i.test(agent) || (/Mac/i.test(platform) && navigator.maxTouchPoints > 1)) return "iPad";
    if (/Android/i.test(agent + platform)) return /Mobile/i.test(agent) ? "Android phone" : "Android tablet";
    if (/Windows|Win32/i.test(platform + agent)) return "Windows PC";
    if (/CrOS/i.test(agent)) return "Chromebook";
    if (/Mac/i.test(platform + agent)) return "Mac";
    if (/Linux/i.test(platform + agent)) return "Linux computer";
    return "This browser";
  }

  function upload(entry, afterSave) {
    const view = dialog("Add photos", true);
    const pending = [];
    const previews = node("div", "", "memory-grid");
    const pickerRow = node("div", "", "memory-actions");
    let deviceId = localStorage.getItem(deviceKey);
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      localStorage.setItem(deviceKey, deviceId);
    }
    const device = node("input");
    device.maxLength = 80;
    device.placeholder = "For example, Drake’s iPhone";
    const suggestedName = defaultDeviceName() + " " + deviceId.slice(0, 6).toUpperCase();
    device.value = localStorage.getItem(nameKey) || suggestedName;
    const deviceLabel = node("label", "Device name");
    deviceLabel.append(device);
    const submit = button("Add photos", add, true);
    const capacity = 10 - (entry.photos?.length || 0);

    function render() {
      view.clear(previews);
      for (const item of pending) {
        const tile = node("div", "", "memory-preview");
        tile.append(view.image(item.file, "Selected photo"), button("Remove photo", async () => {
          if (item.stored) await localStore("readwrite", store => store.delete(item.id));
          pending.splice(pending.indexOf(item), 1);
          render();
        }));
        previews.append(tile);
      }
      submit.textContent = pending.length === 1 ? "Add 1 photo" : pending.length ? "Add " + pending.length + " photos" : "Add photos";
      submit.disabled = !pending.length;
    }

    async function add() {
      const deviceName = device.value.trim();
      if (!deviceName) {
        view.status.textContent = "Enter a name so you can find these photos from another device.";
        device.focus();
        return;
      }
      const controls = Array.from(view.element.querySelectorAll("button, input"));
      controls.forEach(control => { control.disabled = true; });
      const keepOpen = event => event.preventDefault();
      view.element.addEventListener("cancel", keepOpen);
      localStorage.setItem(nameKey, deviceName);
      let latest;
      try {
        for (const item of [...pending]) {
          view.status.textContent = "Saving photo…";
          if (!item.stored) {
            const bitmap = await createImageBitmap(item.file);
            try {
              const image = await resize(bitmap, 2048);
              const thumb = await resize(bitmap, 384);
              await localStore("readwrite", store => store.put({ image, thumb }, item.id));
              item.stored = true;
            } finally { bitmap.close(); }
          }
          latest = await save(entry, { photo: { id: item.id, deviceId, deviceName } });
          pending.shift();
        }
        view.element.close();
        afterSave(latest);
      } catch (error) {
        view.status.textContent = error.message + ". You can retry the remaining photos.";
        if (latest) afterSave(latest);
      } finally {
        view.element.removeEventListener("cancel", keepOpen);
        controls.forEach(control => { control.disabled = false; });
        render();
      }
    }

    for (const [label, source] of [["Camera", "camera"], ["Photo library", "library"], ["Browse files", "files"]]) {
      const input = node("input");
      input.type = "file";
      // An unrestricted input opens the system file browser on mobile.
      if (source !== "files") input.accept = "image/*";
      input.multiple = source !== "camera";
      if (source === "camera") input.setAttribute("capture", "environment");
      input.hidden = true;
      input.onchange = () => {
        const files = [...input.files];
        const slots = Math.max(0, capacity - pending.length);
        const images = files.filter(file => file.type.startsWith("image/") ||
          (!file.type && /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(file.name)));
        const allowed = images.filter(file => file.size <= 25 * 1024 * 1024);
        for (const file of allowed.slice(0, slots)) pending.push({ id: crypto.randomUUID(), file });
        input.value = "";
        const notices = [];
        if (files.length !== images.length) notices.push("Choose image files.");
        if (images.length !== allowed.length) notices.push("Choose photos under 25 MB.");
        if (allowed.length > slots) notices.push("Up to 10 photos per collection.");
        view.status.textContent = notices.join(" ");
        render();
      };
      pickerRow.append(button(label, () => input.click()), input);
    }
    view.body.append(node("p", "Photos stay in this browser on this device."), deviceLabel, previews, pickerRow, submit);
    render();
  }

  async function tile(view, photo, onSelect) {
    const copy = await localStore("readonly", store => store.get(photo.id)).catch(() => null);
    const label = photo.deviceId === localStorage.getItem(deviceKey)
      ? "Photo no longer available"
      : "Photo not available on this device. Available on " + photo.deviceName + ".";
    const control = button(copy ? "" : label, () => onSelect(copy));
    control.className = "memory-tile";
    if (copy) control.append(view.image(copy.thumb, "View photo"));
    return control;
  }

  function photoViewer(entry, photo, copy, afterRemove, fromPhotosTab = false) {
    const view = dialog(entry.title);
    const remove = button("Remove photo", async () => {
      remove.disabled = true;
      try {
        const saved = await save(entry, { remove: photo.id });
        await localStore("readwrite", store => store.delete(photo.id)).catch(() => {});
        view.element.close();
        afterRemove(saved);
      } catch (error) {
        view.status.textContent = error.message;
        remove.disabled = false;
      }
    });
    view.body.append(
      copy ? view.image(copy.image, "Task photo") : node("p", photo.deviceId === localStorage.getItem(deviceKey)
        ? "Photo no longer available" : "Photo not available on this device. Available on " + photo.deviceName + "."),
      remove
    );
    if (!fromPhotosTab) view.body.append(
      node("p", String(entry.completed_on).slice(0, 10)),
      button("View task", () => { view.element.close(); detail(entry); })
    );
  }

  function detail(initial) {
    const view = dialog(initial.title);
    let entry = initial;
    async function render(saved) {
      entry = saved;
      const photos = node("div", "", "memory-grid");
      const reflection = node("textarea");
      reflection.defaultValue = entry.reflection || "";
      reflection.placeholder = "What did I think of doing this task?";
      reflection.setAttribute("aria-label", "Reflection");
      reflection.maxLength = 10000;
      const submit = button("Save reflection", async () => {
        submit.disabled = true;
        reflection.disabled = true;
        try {
          entry = await save(entry, { reflection: reflection.value });
          reflection.defaultValue = entry.reflection;
          view.status.textContent = "Reflection saved.";
        } catch (error) { view.status.textContent = error.message; }
        finally { submit.disabled = false; reflection.disabled = false; }
      }, true);
      const previous = view.body.querySelector("textarea");
      if (previous && previous.value !== previous.defaultValue) reflection.value = previous.value;
      view.clear(view.body);
      view.body.append(
        node("p", "Completed · " + String(entry.completed_on || "").slice(0, 10), "memory-completed"),
        node("h3", "Photos"), photos,
        button("Add photos", () => upload(entry, render)),
        node("h3", "Reflection"), reflection, submit
      );
      for (const photo of entry.photos || []) {
        photos.append(await tile(view, photo, copy => photoViewer(entry, photo, copy, render)));
      }
    }
    view.status.textContent = "Loading task…";
    list().then(rows => {
      view.status.textContent = "";
      return render(rows.find(row => row.block_id === initial.block_id && row.revision === initial.revision) || initial);
    }).catch(error => { view.status.textContent = error.message; });
  }

  function gallery() {
    const view = dialog("All Photos");
    const months = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
    async function render() {
      view.status.textContent = "Loading photos…";
      try {
        const entries = await list();
        view.clear(view.body);
        let month;
        let grid;
        for (const entry of entries.filter(row => row.revision !== "task-photos" && row.photos.length)) {
          const key = String(entry.completed_on).slice(0, 7);
          if (key !== month) {
            month = key;
            grid = node("div", "", "memory-grid memory-gallery");
            view.body.append(node("h3", months.format(new Date(key + "-01T00:00:00Z"))), grid);
          }
          for (const photo of entry.photos) {
            grid.append(await tile(view, photo, copy => photoViewer(entry, photo, copy, render)));
          }
        }
        view.status.textContent = month ? "" : "Photos you add to completed tasks will appear here.";
      } catch (error) { view.status.textContent = error.message; }
    }
    render();
  }

  function fromTask(row) {
    const p = row?.properties;
    if (!p || row.type === "legacy_task" || !(p.done || p.status === "done" || p.completedAt)) return null;
    return {
      block_id: row.id,
      revision: p._completionRevision || p.completedAt || "original",
      title: p.title || "Completed task",
      completed_on: p.completedAt || row.date,
      photos: [],
    };
  }

  function mountTaskPhotos(host, blockId, title, readOnly) {
    const taskEntry = { block_id: blockId, revision: "task-photos", title, photos: [] };
    const grid = node("div", "", "memory-grid");
    const status = node("p", "", "memory-status");
    status.setAttribute("role", "status");
    const urls = new Set();
    let live = true;
    let entries = [];
    const add = button("Add photos", () => upload(entries.find(row => row.revision === taskEntry.revision) || taskEntry, refresh));
    add.hidden = readOnly;
    host.replaceChildren(grid, status, add);
    const clear = () => {
      urls.forEach(url => URL.revokeObjectURL(url));
      urls.clear();
      grid.replaceChildren();
    };
    const view = { image(blob, alt) {
      const img = node("img");
      img.src = URL.createObjectURL(blob);
      urls.add(img.src);
      img.alt = alt;
      return img;
    } };
    async function refresh() {
      if (!live || !blockId) return;
      add.disabled = true;
      status.textContent = "Loading photos…";
      try {
        entries = (await list()).filter(row => row.block_id === blockId);
        if (!live) return;
        clear();
        for (const entry of entries) {
          for (const photo of entry.photos) {
            const control = await tile(view, photo, copy => {
              if (readOnly) {
                const preview = dialog(title);
                preview.body.append(copy ? preview.image(copy.image, "Task photo") : node("p", control.textContent));
              } else photoViewer(entry, photo, copy, refresh, true);
            });
            if (!live) { clear(); return; }
            grid.append(control);
          }
        }
        status.textContent = grid.childElementCount ? "" : "No photos yet.";
        add.disabled = false;
      } catch (error) {
        if (live) status.textContent = error.message;
      }
    }
    if (!blockId) { add.disabled = true; status.textContent = "Save this task before adding photos."; }
    const refreshDone = refresh();
    return {
      pick() { if (!readOnly && blockId) refreshDone.then(() => { if (live && !add.disabled) add.click(); }); },
      destroy() { live = false; clear(); host.replaceChildren(); },
    };
  }

  DCC.CompletionMemories = {
    mountTaskPhotos,
    bindTask(target, task, blockId) {
      const entry = task && blockId && fromTask({
        id: blockId, date: task.date,
        properties: { ...task, _completionRevision: task.completionRevision || task._completionRevision },
      });
      target.replaceChildren();
      if (entry) target.append(button("Photos & reflection", () => detail(entry)));
    },
  };
  document.getElementById("completion-photo-gallery").addEventListener("click", gallery);
  window.addEventListener("task-completion-confirmed", event => {
    if (event.detail?.replayed) return;
    const entry = fromTask(event.detail?.task);
    if (entry) DCC.toast("Task completed", "success", 8000, { label: "Add photos", onClick: () => upload(entry, detail) });
  });
})();
