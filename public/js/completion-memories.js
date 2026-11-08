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
    element.addEventListener("keydown", event => {
      if (event.key === "Escape") event.stopPropagation();
    });
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

  function upload(getEntry, afterSave, inlineView) {
    const view = inlineView || dialog("Add photos", true);
    const pending = [];
    let disposed = false;
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


    function render() {
      if (disposed) return;
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
          latest = await save(getEntry(), { photo: { id: item.id, deviceId, deviceName } });
          pending.shift();
        }
        if (!inlineView) view.element.close();
        else view.status.textContent = "Photos added.";
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
        const slots = Math.max(0, 10 - (getEntry().photos?.length || 0) - pending.length);
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
    return () => { disposed = true; view.clear(previews); };
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
        button("Add photos", () => upload(() => entry, render)),
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

  function momentTime(photo) {
    const time = photo.moment?.time;
    if (time) return new Date("2000-01-01T" + time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return photo.addedAt ? new Date(photo.addedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "Time unknown";
  }

  function openMoment(entry, photo, copy, title, readOnly, refresh) {
    const details = photo.moment || {};
    const view = dialog(details.title || title);
    view.element.classList.add("memory-moment-card");
    view.body.append(
      copy ? view.image(copy.image, details.title || "Task photo") : node("p", "Photo unavailable here. Check " + photo.deviceName + "."),
      node("p", momentTime(photo) + " · " + String(entry.completed_on || "").slice(0, 10), "memory-moment-meta"),
      node("p", details.note || "No moment notes yet.", "memory-moment-note"),
      node("p", [details.location, "Stored on " + photo.deviceName].filter(Boolean).join(" · "), "memory-moment-meta")
    );
    if (readOnly) return;
    const actions = node("div", "", "memory-actions");
    actions.append(button("Edit moment", () => {
      const fields = [
        ["Title", "title", "text", 120],
        ["Time", "time", "time"],
        ["Location", "location", "text", 120],
        ["Notes", "note", "textarea", 2000],
      ].map(([label, key, type, limit]) => {
        const field = node(type === "textarea" ? "textarea" : "input");
        if (type !== "textarea") field.type = type;
        if (limit) field.maxLength = limit;
        field.value = details[key] || "";
        const wrapper = node("label", label);
        wrapper.append(field);
        return { key, field, wrapper };
      });
      const submit = button("Save moment", async () => {
        submit.disabled = true;
        try {
          await save(entry, { moment: { id: photo.id, ...Object.fromEntries(fields.map(({ key, field }) => [key, field.value])) } });
          view.element.close();
          refresh();
        } catch (error) {
          view.status.textContent = error.message;
          submit.disabled = false;
        }
      }, true);
      actions.replaceWith(...fields.map(({ wrapper }) => wrapper), submit);
      fields[0].field.focus();
    }), button("Photo options", () => {
      view.element.close();
      photoViewer(entry, photo, copy, refresh, true);
    }));
    view.body.append(actions);
  }

  function foldInlinePhoto(tile, label) {
    const details = node("details", "", "memory-inline-photo");
    details.contentEditable = "false";
    details.append(node("summary", label), tile);
    return details;
  }

  function mountJournalEntry(cover, prev, initial, { readOnly = false, onAttachment } = {}) {
    let photos = [], dirty = false, cleanup;
    const normalize = markdown => markdown
      .replace(/\[\[photo:([0-9a-f-]{36})\]\]/gi, "[Photo](#dcc-photo-$1)")
      .replace(/\(media:sha256:([a-f0-9]{12,64})\)/gi, "(/api/vault/media/$1)");
    const read = () => dirty ? journalMarkdown(prev) : initial;
    function keepCleanup(clear) {
      const previous = cleanup;
      cleanup = () => { previous?.(); clear(); };
    }
    function paintCover() {
      keepCleanup(renderDayStory(cover, node("div"), photos, normalize(read())));
    }
    function paint() {
      cleanup?.();
      cleanup = renderDayStory(cover, prev, photos, normalize(initial));
      if (!initial.trim()) prev.replaceChildren();
    }
    if (!readOnly) prev.contentEditable = "true";
    let cursor;
    const rememberCursor = () => {
      const selection = window.getSelection();
      if (selection.rangeCount && prev.contains(selection.getRangeAt(0).commonAncestorContainer)) {
        cursor = selection.getRangeAt(0).cloneRange();
      }
    };
    for (const event of ["input", "keyup", "pointerup", "blur"]) prev.addEventListener(event, rememberCursor);
    prev.addEventListener("input", () => { dirty = true; });
    const restoreCursor = () => {
      prev.focus();
      const selection = window.getSelection();
      if (!cursor || !prev.contains(cursor.commonAncestorContainer)) {
        cursor = document.createRange();
        cursor.selectNodeContents(prev);
        cursor.collapse(false);
      }
      selection.removeAllRanges();
      selection.addRange(cursor);
    };
    function insert(markdown) {
      const fragment = document.createElement("div");
      const tempCover = document.createElement("div");
      const source = normalize(markdown);
      keepCleanup(renderDayStory(tempCover, fragment, photos, source));
      restoreCursor();
      cursor.deleteContents();
      const content = document.createDocumentFragment();
      content.append(...fragment.childNodes);
      const tail = document.createElement("br");
      content.append(tail);
      cursor.insertNode(content);
      cursor.setStartAfter(tail);
      cursor.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(cursor);
      dirty = true;
      if (source.includes("/api/vault/media/")) paintCover();
    }
    function formatEntry(format) {
      restoreCursor();
      if (format === "heading") document.execCommand("formatBlock", false, "h2");
      else document.execCommand(format === "list" ? "insertUnorderedList" : format);
      dirty = true;
      rememberCursor();
    }
    function mountFormatting(host) {
      for (const [label, format] of [["Bold", "bold"], ["Italic", "italic"], ["Heading", "heading"], ["List", "list"]]) {
        const control = button(label, () => formatEntry(format));
        control.className = "vault-ed-tab-btn";
        host.append(control);
      }
    }
    if (!readOnly) prev.addEventListener("paste", event => {
      event.preventDefault();
      const clipboard = event.clipboardData;
      const file = clipboard?.files[0] || Array.from(clipboard?.items || [])
        .find(item => item.kind === "file")?.getAsFile();
      if (file) {
        if (onAttachment) onAttachment(file);
        else DCC.toast("Use Add photos to attach a photo to this task", "info");
        return;
      }
      const text = clipboard?.getData("text/plain") || "";
      if (/^\[[^\n]+\]\(#dcc-(?:card-|photo-)/.test(text)) insert(text);
      else document.execCommand("insertText", false, text);
    });
    paint();
    return {
      read, insert, mountFormatting,
      setPhotos(next) {
        photos = next;
        if (!dirty && !prev.contains(document.activeElement)) paint();
        else paintCover();
      },
      destroy() { cleanup?.(); },
    };
  }

  function journalMarkdown(element) {
    const serialize = node => {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent.split(/(\[\[[^\]\n]+\]\])/g).map((part, index) =>
          index % 2 ? part : part.replace(/[\\`*_\[\]<>]/g, "\\$&")
        ).join("");
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      if (node.dataset.journalMarkdown) return node.dataset.journalMarkdown;
      const text = Array.from(node.childNodes, serialize).join("");
      switch (node.tagName) {
        case "BR": return "\n";
        case "P": case "DIV": return text + "\n\n";
        case "B": case "STRONG": return `**${text}**`;
        case "I": case "EM": return `*${text}*`;
        case "H1": case "H2": case "H3": case "H4": case "H5": case "H6":
          return "\n" + "#".repeat(Number(node.tagName[1])) + " " + text + "\n\n";
        case "UL": case "OL":
          return "\n" + Array.from(node.children, (item, index) =>
            (node.tagName === "OL" ? (index + 1) + ". " : "- ") + serialize(item).trim()
          ).join("\n") + "\n\n";
        case "A": return `[${text}](${node.getAttribute("href") || ""})`;
        case "IMG": return `![${node.alt}](${node.getAttribute("src") || ""})`;
        case "SPAN": case "LI": return text;
        default: return node.outerHTML;
      }
    };
    return Array.from(element.childNodes, serialize).join("").trim();
  }

  function mountTaskPhotos(host, blockId, title, readOnly) {
    const taskEntry = { block_id: blockId, revision: "task-photos", title, photos: [] };
    const gallery = node("section", "", "memory-task-gallery");
    gallery.setAttribute("aria-label", "Task photos");
    const galleryHeader = node("div", "", "memory-task-gallery-header");
    const cover = node("div", "", "memory-story-cover");
    const status = node("p", "", "memory-status");
    status.setAttribute("role", "status");
    const urls = new Set();
    let live = true;
    let entries = [];
    const picker = node("div", "", "memory-inline-picker");
    picker.id = "memory-picker-" + crypto.randomUUID();
    picker.hidden = true;
    const togglePicker = button("+ Add photos", () => {
      picker.hidden = !picker.hidden;
      togglePicker.setAttribute("aria-expanded", String(!picker.hidden));
      togglePicker.textContent = picker.hidden ? "+ Add photos" : "Hide photo options";
    });
    togglePicker.setAttribute("aria-controls", picker.id);
    togglePicker.setAttribute("aria-expanded", "false");
    togglePicker.disabled = true;
    togglePicker.hidden = readOnly;
    galleryHeader.append(node("h3", "Photos"), togglePicker);
    gallery.append(cover, galleryHeader, status, picker);
    const pickerStatus = node("p", "", "memory-status");
    pickerStatus.setAttribute("role", "status");
    let clearPicker;
    const story = node("div", "", "memory-inline-story vault-ed-preview vault-ed-journal-surface");
    story.setAttribute("role", "textbox");
    story.setAttribute("aria-label", "Task journal");
    story.setAttribute("aria-multiline", "true");
    story.dataset.placeholder = "What was this task like?";
    const tools = node("div", "", "vault-ed-bodybar vault-ed-formatbar");
    let moments = [];
    const insert = button("Insert photo", () => {
      const view = dialog("Insert a task photo");
      const grid = node("div", "", "memory-grid");
      for (const moment of moments) {
        const choice = button(moment.label, () => {
          view.element.close();
          editor.insert(`[Photo](#dcc-photo-${moment.id})`);
        });
        choice.className = "memory-tile";
        if (moment.copy) choice.prepend(view.image(moment.copy.thumb, ""));
        grid.append(choice);
      }
      view.body.append(grid);
    });
    insert.className = "vault-ed-tab-btn";
    tools.hidden = true;
    let editor;
    const journalStatus = node("p", "", "memory-status");
    journalStatus.setAttribute("role", "status");
    let journalEntry;
    const saveJournal = button("Save journal", async () => {
      saveJournal.disabled = true;
      try {
        journalEntry = await save(journalEntry, { reflection: editor.read() });
        journalStatus.textContent = "Journal saved.";
      } catch (error) {
        journalStatus.textContent = error.message;
      } finally {
        if (live) {
          saveJournal.disabled = false;
        }
      }
    }, true);
    saveJournal.hidden = readOnly;
    saveJournal.disabled = true;
    host.replaceChildren(gallery, node("h3", "Task journal", "memory-story-heading"), tools, story, saveJournal, journalStatus);
    const clear = () => {
      urls.forEach(url => URL.revokeObjectURL(url));
      urls.clear();
      editor?.destroy();
    };
    const view = { clear(container) {
      for (const img of container.querySelectorAll("img")) {
        URL.revokeObjectURL(img.src);
        urls.delete(img.src);
      }
      container.replaceChildren();
    }, image(blob, alt) {
      const img = node("img");
      img.src = URL.createObjectURL(blob);
      urls.add(img.src);
      img.alt = alt;
      return img;
    } };
    async function refresh() {
      if (!live || !blockId) return;
      status.textContent = "Loading photos…";
      try {
        entries = (await list()).filter(row => row.block_id === blockId);
        if (!live) return;
        if (!journalEntry) {
          journalEntry = entries.find(row => row.revision === taskEntry.revision && row.reflection)
            || entries.find(row => row.revision !== taskEntry.revision && row.reflection)
            || taskEntry;
          editor = mountJournalEntry(cover, story, journalEntry.reflection || "", { readOnly });
          if (!readOnly) {
            editor.mountFormatting(tools);
            tools.append(insert);
          }
          tools.hidden = readOnly;
          saveJournal.disabled = readOnly;
        }
        const loaded = await loadJournalPhotos(entries, readOnly, refresh);
        if (!live) return;
        moments = loaded;
        editor.setPhotos(moments);
        insert.hidden = !moments.length;
        status.textContent = moments.length ? "" : "No photos yet.";
        if (!readOnly && !clearPicker) {
          clearPicker = upload(
            () => entries.find(row => row.revision === taskEntry.revision) || taskEntry,
            refresh,
            { ...view, element: picker, body: picker, status: pickerStatus }
          );
          picker.append(pickerStatus);
          togglePicker.disabled = false;
        }
      } catch (error) {
        if (live) status.textContent = error.message;
      }
    }
    if (!blockId) status.textContent = "Save this task before adding photos.";
    refresh();
    return {
      destroy() { live = false; clearPicker?.(); clear(); host.replaceChildren(); },
    };
  }

  async function loadDayPhotos(date) {
    const entries = await list();
    return loadJournalPhotos(entries.filter(entry => String(entry.completed_on).slice(0, 10) === date), true);
  }

  function loadJournalPhotos(entries, readOnly, refresh) {
    return Promise.all(entries.flatMap(entry => entry.photos.map(async photo => ({
      id: photo.id,
      label: momentTime(photo) + " – " + (photo.moment?.title || entry.title),
      copy: await localStore("readonly", store => store.get(photo.id)).catch(() => null),
      open(copy) { openMoment(entry, photo, copy, entry.title, readOnly, refresh); },
    }))));
  }

  function renderDayStory(cover, body, photos, markdown) {
    const attachments = new Map();
    body.innerHTML = window.DOMPurify.sanitize(window.marked.parse(markdown || "*No journal entry yet.*"));
    for (const image of body.querySelectorAll("img")) {
      const src = image.getAttribute("src");
      if (!src?.startsWith("/api/vault/media/")) continue;
      const label = image.alt || "Journal photo";
      attachments.set(src, {
        label, src,
        open() {
          const view = dialog(label);
          const full = node("img");
          full.src = src;
          full.alt = label;
          view.body.append(full);
        },
      });
    }
    const all = [...photos, ...attachments.values()];
    const byId = new Map(photos.map(photo => [photo.id, photo]));
    const urls = [];
    function control(photo, imageView, action) {
      const tile = button("", action || (() => photo.open(photo.copy)));
      tile.className = "memory-tile";
      tile.setAttribute("aria-label", photo.label);
      if (photo.copy && imageView) tile.append(imageView.image(photo.copy.thumb, ""));
      else if (photo.copy || photo.src) {
        const image = node("img");
        image.alt = "";
        image.src = photo.src || URL.createObjectURL(photo.copy.thumb);
        if (!photo.src) urls.push(image.src);
        tile.append(image);
      } else tile.append(node("span", "Photo on another device"));
      tile.append(node("span", photo.label, "memory-photo-overlay"));
      return tile;
    }
    for (const link of body.querySelectorAll('a[href^="#dcc-photo-"]')) {
      const photo = byId.get(link.getAttribute("href").slice("#dcc-photo-".length));
      if (photo) {
        const tile = control(photo);
        const fold = foldInlinePhoto(tile, photo.label);
        fold.dataset.journalMarkdown = `[Day photo](#dcc-photo-${photo.id})`;
        link.replaceWith(fold);
      }
    }
    for (const image of body.querySelectorAll("img")) {
      const photo = attachments.get(image.getAttribute("src"));
      if (photo) {
        const tile = control(photo);
        const hash = photo.src.split("/").pop();
        const fold = foldInlinePhoto(tile, photo.label);
        fold.dataset.journalMarkdown = `![${photo.label.replace(/[\[\]]/g, "")}](media:sha256:${hash})`;
        image.replaceWith(fold);
      }
    }
    cover.replaceChildren();
    const featured = all.find(photo => photo.copy || photo.src) || all[0];
    if (featured) {
      const tile = control(featured, null, () => {
        const view = dialog("Photos from this day");
        const grid = node("div", "", "memory-grid memory-entry-gallery");
        grid.append(...all.map(photo => control(photo, view)));
        view.body.append(grid);
      });
      tile.setAttribute("aria-label", "View day gallery, " + all.length + " photos");
      tile.append(node("span", "View gallery · " + all.length, "memory-gallery-badge"));
      cover.append(tile);
    }
    return () => urls.forEach(url => URL.revokeObjectURL(url));
  }

  async function pickDayPhoto(date, onPick) {
    const view = dialog("Link a photo from " + date);
    view.status.textContent = "Loading photos…";
    try {
      const entries = await list();
      const grid = node("div", "", "memory-grid");
      for (const entry of entries) {
        if (String(entry.completed_on).slice(0, 10) !== date) continue;
        for (const photo of entry.photos) {
          const control = await tile(view, photo, () => {
            view.element.close();
            onPick(photo.id);
          });
          if (!view.element.open) return;
          control.setAttribute("aria-label", "Link photo from " + entry.title);
          control.append(node("span", entry.title));
          grid.append(control);
        }
      }
      view.body.append(grid);
      view.status.textContent = grid.childElementCount ? "" : "No task photos for this day.";
    } catch (error) {
      view.status.textContent = error.message;
    }
  }

  document.addEventListener("click", async event => {
    const link = event.target.closest('a[href^="#dcc-photo-"]');
    const id = link?.getAttribute("href").slice("#dcc-photo-".length);
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
    event.preventDefault();
    const view = dialog("Day photo");
    view.status.textContent = "Loading photo…";
    try {
      const entry = (await list()).find(row => row.photos.some(photo => photo.id === id));
      const photo = entry?.photos.find(item => item.id === id);
      const copy = photo && await localStore("readonly", store => store.get(id));
      if (!view.element.open) return;
      if (copy) view.body.append(view.image(copy.image, "Day photo"));
      view.status.textContent = copy ? "" : photo
        ? "Photo unavailable here. Check " + photo.deviceName + "."
        : "This photo is no longer available.";
    } catch (error) {
      view.status.textContent = error.message;
    }
  });

  function cardMarkdown(title, kind, id) {
    const label = title.replace(/[\\[\]\r\n]/g, " ");
    return `[${label}](#dcc-card-${kind}:${encodeURIComponent(id).replace(/[()]/g, char => char === "(" ? "%28" : "%29")})`;
  }

  async function copyCard(title, kind, id) {
    try {
      await navigator.clipboard.writeText(cardMarkdown(title, kind, id));
      DCC.toast("Card copied. Paste it into a journal.", "success");
    } catch (error) {
      DCC.toast("Could not copy card: " + error.message, "error");
    }
  }

  async function showDayTasks(host, date, onInsert) {
    const status = node("p", date ? "Loading completed tasks…" : "Set a date to see completed tasks.");
    host.replaceChildren(status);
    if (!date) return;
    try {
      const [blocks, memories] = await Promise.all([
        DCC.api("/api/blocks?date=" + encodeURIComponent(date)),
        list(),
      ]);
      if (status.parentNode !== host) return;
      const completed = blocks.filter(row => DCC.TaskModel.isTaskRow(row) && fromTask(row));
      if (!completed.length) {
        status.textContent = "No completed tasks for this day.";
        return;
      }
      const cards = node("div", "", "journal-task-cards");
      for (const row of completed) {
        const entry = fromTask(row);
        const entries = memories.filter(memory => memory.block_id === row.id);
        const photos = entries.some(memory => memory.photos.length);
        const journal = entries.some(memory => memory.reflection?.trim());
        const card = node("article", "", "journal-task-card");
        card.append(
          button(entry.title, () => openCard("task", row.id, entry.title, { editTask: true })),
          node("p", [photos && "Photos", journal && "Journal"].filter(Boolean).join(" · ") || "Completed"),
          button("Copy card", () => copyCard(entry.title, "task", row.id))
        );
        if (onInsert) card.append(button("Insert in journal", () => onInsert(cardMarkdown(entry.title, "task", row.id))));
        cards.append(card);
      }
      host.replaceChildren(cards);
    } catch (error) {
      status.textContent = error.message;
    }
  }

  async function openCard(kind, id, title, { editTask = false } = {}) {
    const view = dialog(title);
    try {
      if (kind === "task") {
        const task = await DCC.api("/api/blocks/" + encodeURIComponent(id));
        if (!view.element.open) return;
        if (!DCC.TaskModel.isTaskRow(task)) throw new Error("Task unavailable");
        const photos = mountTaskPhotos(view.body, task.id, task.properties.title || title, !editTask);
        view.element.addEventListener("close", photos.destroy, { once: true });
        return;
      }
      const journal = await DCC.api("/api/vault/node/" + id.split("/").map(encodeURIComponent).join("/"));
      if (!view.element.open) return;
      if (journal.frontmatter?.type !== "journal") throw new Error("Journal unavailable");
      const cover = node("div", "", "memory-story-cover");
      const story = node("div", "", "memory-inline-story");
      view.body.append(cover, story);
      const editor = mountJournalEntry(cover, story, journal.body || "", { readOnly: true });
      view.element.addEventListener("close", editor.destroy, { once: true });
      const date = String(journal.frontmatter.date || "").slice(0, 10);
      if (date) {
        const photos = await loadDayPhotos(date);
        if (view.element.open) editor.setPhotos(photos);
      }
    } catch (error) {
      view.status.textContent = error.message;
    }
  }

  document.addEventListener("click", event => {
    const link = event.target.closest('a[href^="#dcc-card-"]');
    const match = link?.getAttribute("href").match(/^#dcc-card-(task|journal):(.+)$/);
    if (!match) return;
    event.preventDefault();
    try { openCard(match[1], decodeURIComponent(match[2]), link.textContent); }
    catch { DCC.toast("Invalid journal card", "error"); }
  });

  DCC.CompletionMemories = {
    mountTaskPhotos,
    pickDayPhoto,
    loadDayPhotos,
    mountJournalEntry,
    showDayTasks,
    copyCard,
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
    if (entry) DCC.toast("Task completed", "success", 8000, { label: "Add photos", onClick: () => upload(() => entry, detail) });
  });
})();
