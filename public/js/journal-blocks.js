// Notion-style block editing for the journal's markdown text surface.
// The host owns rendering (markdown -> HTML) and serialization (HTML ->
// markdown); this layer only shapes blocks: markdown shortcuts, a "/" menu,
// per-block handles to insert or drag, task checkboxes, and markdown paste.
// Every structural change fires an "input" event so the host saves it.
(function () {
  "use strict";

  const TYPES = [
    { id: "p", label: "Text", icon: "¶", keys: "text paragraph" },
    { id: "h1", label: "Heading 1", icon: "H1", keys: "heading title h1 #" },
    { id: "h2", label: "Heading 2", icon: "H2", keys: "heading subtitle h2 ##" },
    { id: "h3", label: "Heading 3", icon: "H3", keys: "heading h3 ###" },
    { id: "ul", label: "Bulleted list", icon: "•", keys: "bullet list unordered -" },
    { id: "ol", label: "Numbered list", icon: "1.", keys: "numbered list ordered 1." },
    { id: "todo", label: "To-do list", icon: "☐", keys: "todo task checkbox check []" },
    { id: "quote", label: "Quote", icon: "❝", keys: "quote blockquote >" },
    { id: "code", label: "Code", icon: "</>", keys: "code snippet ```" },
    { id: "hr", label: "Divider", icon: "—", keys: "divider line rule hr ---" }
  ];
  // Typed at the start of a plain block, then a space.
  const SPACE_SHORTCUTS = { "#": "h1", "##": "h2", "###": "h3", "-": "ul", "*": "ul", "+": "ul",
    "1.": "ol", "[]": "todo", "[ ]": "todo", ">": "quote" };
  const BLOCK_SELECTOR = "p, div, h1, h2, h3, h4, h5, h6, li, blockquote, pre";
  const PLAIN = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE"]);

  function looksLikeMarkdown(text) {
    return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s?|```|---\s*$|- \[[ xX]\]\s)/.test(text) || /\n\s*\n/.test(text);
  }

  function enhance(root, { placeholder = "Type '/' for commands" } = {}) {
    if (!root || root.dataset.blocks === "on") return () => {};
    root.dataset.blocks = "on";
    root.classList.add("jb-root");
    const changed = () => root.dispatchEvent(new Event("input", { bubbles: true }));
    const selection = () => window.getSelection();

    // ── helpers ──
    function caretRange() {
      const sel = selection();
      if (!sel.rangeCount) return null;
      const range = sel.getRangeAt(0);
      return root.contains(range.startContainer) ? range : null;
    }
    function currentBlock() {
      const range = caretRange();
      if (!range) return null;
      let node = range.startContainer;
      if (node === root) {
        node = root.childNodes[range.startOffset] || root.childNodes[range.startOffset - 1] || null;
        if (!node) return null;
      }
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      const block = element?.closest(BLOCK_SELECTOR);
      if (block && root.contains(block) && block !== root) return block;
      // Bare text directly in the root: give it a paragraph.
      let top = node;
      while (top && top.parentNode !== root) top = top.parentNode;
      if (!top) return null;
      const p = document.createElement("p");
      root.insertBefore(p, top);
      p.append(top);
      placeCaret(p, true);
      return p;
    }
    function textBeforeCaret(block) {
      const range = caretRange();
      if (!range) return "";
      const before = document.createRange();
      before.selectNodeContents(block);
      before.setEnd(range.startContainer, range.startOffset);
      return before.toString().replace(/ /g, " ");
    }
    function placeCaret(element, atEnd = false) {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(!atEnd);
      const sel = selection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    function ensureContent(element) {
      if (!element.textContent && !element.querySelector("br, img, input, hr")) element.append(document.createElement("br"));
      return element;
    }
    function deletePrefix(block, length) {
      // Remove the first `length` characters of the block's text (the shortcut).
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let left = length;
      while (left > 0 && walker.nextNode()) {
        const text = walker.currentNode;
        const cut = Math.min(left, text.data.length);
        text.data = text.data.slice(cut);
        left -= cut;
      }
    }
    function liftFromList(li) {
      // Split the list around `li` and return a paragraph holding its content.
      const list = li.parentElement;
      const after = list.cloneNode(false);
      while (li.nextSibling) after.append(li.nextSibling);
      const p = document.createElement("p");
      for (const child of [...li.childNodes]) if (!(child.nodeType === 1 && child.matches('input[type="checkbox"]'))) p.append(child);
      li.remove();
      list.after(p);
      if (after.children.length) p.after(after);
      if (!list.children.length) list.remove();
      return p;
    }
    function makeList(kind) {
      const list = document.createElement(kind === "ol" ? "ol" : "ul");
      if (kind === "todo") list.className = "contains-task-list";
      return list;
    }
    function listKind(list) {
      if (!list) return null;
      if (list.tagName === "OL") return "ol";
      return list.classList.contains("contains-task-list") || list.querySelector(':scope > li > input[type="checkbox"]') ? "todo" : "ul";
    }

    // Turn `block` into `type`, keeping its inline content. Returns the element
    // that should receive the caret.
    function convert(block, type) {
      if (block.tagName === "LI") block = liftFromList(block);
      if (block.tagName === "PRE") {
        const p = document.createElement("p");
        p.textContent = block.textContent;
        block.replaceWith(p);
        block = p;
      }
      if (type === "hr") {
        const hr = document.createElement("hr");
        const next = document.createElement("p");
        next.append(...block.childNodes);
        block.replaceWith(hr);
        hr.after(ensureContent(next));
        return next;
      }
      if (type === "code") {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = block.textContent || "";
        pre.append(code);
        block.replaceWith(pre);
        if (!code.textContent) code.append(document.createElement("br"));
        return code;
      }
      if (type === "ul" || type === "ol" || type === "todo") {
        const li = document.createElement("li");
        if (type === "todo") {
          li.className = "task-list-item";
          const box = document.createElement("input");
          box.type = "checkbox";
          li.append(box, " ");
        }
        li.append(...block.childNodes);
        ensureContent(li);
        const previous = block.previousElementSibling;
        if (previous && /^(UL|OL)$/.test(previous.tagName) && listKind(previous) === type) {
          previous.append(li);
          block.remove();
        } else {
          const list = makeList(type);
          list.append(li);
          block.replaceWith(list);
        }
        return li;
      }
      const tag = { p: "p", h1: "h1", h2: "h2", h3: "h3", quote: "blockquote" }[type] || "p";
      const element = document.createElement(tag);
      element.append(...block.childNodes);
      block.replaceWith(ensureContent(element));
      return element;
    }

    function apply(block, type) {
      const target = convert(block, type);
      const box = target.querySelector?.(':scope > input[type="checkbox"]');
      if (box) {
        // Type after the checkbox, never before it.
        const caret = document.createRange();
        const after = box.nextSibling;
        if (after?.nodeType === Node.TEXT_NODE) caret.setStart(after, after.data.length);
        else caret.setStartAfter(box);
        caret.collapse(true);
        selection().removeAllRanges();
        selection().addRange(caret);
      } else placeCaret(target, type !== "hr" && !!target.textContent.trim());
      changed();
      updatePlaceholder();
      return target;
    }

    // ── markdown shortcuts ──
    function onInput(event) {
      if (event.isComposing) return;
      const data = event.data;
      if (event.inputType !== "insertText" || !data) { updatePlaceholder(); return; }
      const block = currentBlock();
      if (!block) return;
      const before = textBeforeCaret(block);
      if (data === "/" && /(^|\s)\/$/.test(before)) { openMenu(block); return; }
      if (menu.open) { filterMenu(); return; }
      if (!PLAIN.has(block.tagName) && block.tagName !== "LI") return;
      if (data === " " && block.tagName !== "LI") {
        const trigger = before.slice(0, -1);
        const type = SPACE_SHORTCUTS[trigger];
        if (type && !(type === block.tagName.toLowerCase())) {
          deletePrefix(block, before.length);
          apply(block, type);
          return;
        }
      }
      if (data === " " && block.tagName === "LI" && /^\[ ?\] $/.test(before) && !block.querySelector('input[type="checkbox"]')) {
        // "[] " inside a bullet turns it into a to-do.
        deletePrefix(block, before.length);
        apply(block, "todo");
        return;
      }
      if (data === "-" && before === "---" && block.tagName !== "LI") { deletePrefix(block, 3); apply(block, "hr"); return; }
      if (data === "`" && before === "```" && block.tagName !== "LI") { deletePrefix(block, 3); apply(block, "code"); return; }
      inlineShortcut(data);
      updatePlaceholder();
    }

    // **bold**, *italic*, `code`, ~~strike~~ as you close them.
    function inlineShortcut(data) {
      if (!"*_`~".includes(data)) return;
      const range = caretRange();
      if (!range || range.startContainer.nodeType !== Node.TEXT_NODE || range.startContainer.parentElement.closest("pre, code")) return;
      const text = range.startContainer, upto = text.data.slice(0, range.startOffset);
      const rules = [[/\*\*([^*\n]+)\*\*$/, "strong"], [/__([^_\n]+)__$/, "strong"], [/~~([^~\n]+)~~$/, "s"],
        [/(?:^|[^*])\*([^*\n]+)\*$/, "em", "*"], [/(?:^|[^_\w])_([^_\n]+)_$/, "em", "_"], [/`([^`\n]+)`$/, "code"]];
      for (const [pattern, tag, single] of rules) {
        const match = pattern.exec(upto);
        if (!match) continue;
        const inner = match[1];
        const markerLength = single ? 1 : tag === "code" ? 1 : 2;
        const start = range.startOffset - inner.length - markerLength * 2;
        if (start < 0) continue;
        const tail = text.splitText(range.startOffset);
        text.data = text.data.slice(0, start);
        const element = document.createElement(tag);
        element.textContent = inner;
        text.after(element);
        // A spacer keeps typing outside the new inline element.
        const spacer = document.createTextNode("​");
        element.after(spacer);
        const caret = document.createRange();
        caret.setStart(spacer, 1);
        caret.collapse(true);
        const sel = selection();
        sel.removeAllRanges();
        sel.addRange(caret);
        if (!tail.data) tail.remove();
        changed();
        return;
      }
    }

    // ── keys ──
    function onKeyDown(event) {
      if (menu.open) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          moveActive(event.key === "ArrowDown" ? 1 : -1);
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          chooseActive();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeMenu();
          return;
        }
      }
      const block = currentBlock();
      if (!block) return;
      if (event.key === "Enter" && !event.shiftKey && block.tagName === "PRE") {
        event.preventDefault();
        const lines = block.textContent.split("\n");
        // Enter on an empty last line leaves the code block.
        if (textBeforeCaret(block) === block.textContent && lines.length > 1 && lines[lines.length - 1] === "") {
          const code = block.querySelector("code") || block, last = code.lastChild;
          if (last?.nodeType === Node.TEXT_NODE && last.data.endsWith("\n")) last.data = last.data.slice(0, -1);
          const p = ensureContent(document.createElement("p"));
          block.after(p);
          placeCaret(p);
          changed();
          return;
        }
        document.execCommand("insertText", false, "\n");
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && block.tagName === "LI" && caretRange()?.collapsed) {
        event.preventDefault();
        const box = block.querySelector(':scope > input[type="checkbox"]');
        const own = [...block.childNodes].filter(child => child !== box && !(child.nodeType === 1 && /^(UL|OL)$/.test(child.tagName)));
        if (!own.map(child => child.textContent).join("").replace(/[\s\u200b]/g, "")) {
          // Enter on an empty item leaves the list, like a notes app.
          const p = liftFromList(block);
          ensureContent(p);
          placeCaret(p);
        } else {
          // Split at the caret; a to-do continues as an unchecked to-do.
          const range = caretRange();
          const tail = document.createRange();
          tail.setStart(range.startContainer, range.startOffset);
          tail.setEndAfter(block.lastChild);
          const moved = tail.extractContents();
          const next = document.createElement("li");
          if (box) {
            next.className = "task-list-item";
            const fresh = document.createElement("input");
            fresh.type = "checkbox";
            next.append(fresh, " ");
          }
          next.append(moved);
          ensureContent(next);
          ensureContent(block);
          block.after(next);
          const caret = document.createRange();
          const first = [...next.childNodes].find(child => !(child.nodeType === 1 && child.matches('input[type="checkbox"]')) && !(child.nodeType === 3 && child.data === " "));
          if (first) caret.setStartBefore(first); else caret.setStart(next, next.childNodes.length);
          caret.collapse(true);
          const sel = selection();
          sel.removeAllRanges();
          sel.addRange(caret);
        }
        changed();
        updatePlaceholder();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && /^H[1-6]$|^BLOCKQUOTE$/.test(block.tagName) &&
          textBeforeCaret(block) === block.textContent.replace(/ /g, " ")) {
        // Enter at the end of a heading or quote continues with plain text.
        event.preventDefault();
        const p = ensureContent(document.createElement("p"));
        block.after(p);
        placeCaret(p);
        changed();
        updatePlaceholder();
        return;
      }
      if (event.key === "Backspace" && textBeforeCaret(block) === "" && caretRange()?.collapsed &&
          /^H[1-6]$|^BLOCKQUOTE$|^PRE$/.test(block.tagName)) {
        event.preventDefault();
        apply(block, "p");
        placeCaret(root.contains(block) ? block : currentBlock() || root, false);
        return;
      }
      if (event.key === "Tab" && block.tagName === "LI") {
        event.preventDefault();
        document.execCommand(event.shiftKey ? "outdent" : "indent");
        changed();
      }
    }

    // ── "/" menu ──
    const menu = { el: null, open: false, block: null, items: [], active: 0, anchor: null };
    function openMenu(block) {
      closeMenu();
      const range = caretRange();
      if (!range) return;
      menu.block = block;
      menu.anchor = { node: range.startContainer, offset: range.startOffset - 1 };
      menu.el = document.createElement("div");
      menu.el.className = "jb-menu";
      menu.el.setAttribute("role", "listbox");
      menu.el.setAttribute("aria-label", "Insert block");
      menu.el.dataset.dccLayer = "above";
      document.body.append(menu.el);
      menu.open = true;
      filterMenu();
    }
    function menuQuery() {
      const range = caretRange();
      if (!range || !menu.anchor || range.startContainer !== menu.anchor.node || range.startOffset <= menu.anchor.offset) return null;
      const text = menu.anchor.node.data ?? "";
      if (text[menu.anchor.offset] !== "/") return null;
      return text.slice(menu.anchor.offset + 1, range.startOffset);
    }
    function filterMenu() {
      const query = menuQuery();
      if (query === null || /\s{2}|\n/.test(query)) { closeMenu(); return; }
      const words = query.toLowerCase().trim();
      menu.items = TYPES.filter(type => !words || (type.label + " " + type.keys).toLowerCase().includes(words));
      if (!menu.items.length) { closeMenu(); return; }
      menu.active = Math.min(menu.active, menu.items.length - 1);
      menu.el.replaceChildren(...menu.items.map((type, n) => {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "jb-option";
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(n === menu.active));
        option.innerHTML = `<span class="jb-icon" aria-hidden="true"></span><span></span>`;
        option.firstChild.textContent = type.icon;
        option.lastChild.textContent = type.label;
        option.addEventListener("mousedown", event => event.preventDefault());
        option.addEventListener("click", () => { menu.active = n; chooseActive(); });
        return option;
      }));
      const rect = (caretRange()?.getBoundingClientRect()) || menu.block.getBoundingClientRect();
      const top = rect.bottom + 6, height = Math.min(menu.el.scrollHeight || 320, 320);
      menu.el.style.left = `${Math.max(8, Math.min(window.innerWidth - 248, rect.left))}px`;
      menu.el.style.top = `${top + height > window.innerHeight ? Math.max(8, rect.top - height - 6) : top}px`;
    }
    function moveActive(step) {
      menu.active = (menu.active + step + menu.items.length) % menu.items.length;
      menu.el.querySelectorAll(".jb-option").forEach((option, n) => option.setAttribute("aria-selected", String(n === menu.active)));
      menu.el.children[menu.active]?.scrollIntoView({ block: "nearest" });
    }
    function chooseActive() {
      const type = menu.items[menu.active];
      const query = menuQuery();
      const { block, anchor } = menu;
      closeMenu();
      if (!type || query === null || !root.contains(block)) return;
      // Remove "/query", then convert an empty block or add the new block below.
      const text = anchor.node;
      text.data = text.data.slice(0, anchor.offset) + text.data.slice(anchor.offset + 1 + query.length);
      if (!block.textContent.replace(/[\s​]/g, "")) {
        block.replaceChildren();
        apply(block, type.id);
      } else {
        const fresh = document.createElement("p");
        (block.tagName === "LI" ? block.closest("ul, ol") : block).after(fresh);
        apply(fresh, type.id);
      }
    }
    function closeMenu() {
      menu.el?.remove();
      menu.el = null;
      menu.open = false;
      menu.active = 0;
    }

    // ── block handle: insert or drag ──
    const handle = document.createElement("div");
    handle.className = "jb-handle";
    handle.innerHTML = '<button type="button" data-jb-add aria-label="Add block below" title="Add block below">+</button><button type="button" data-jb-grip aria-label="Drag to move block" title="Drag to move">⋮⋮</button>';
    handle.hidden = true;
    document.body.append(handle);
    let hovered = null, drag = null;
    function handleTarget(element) {
      const block = element?.closest?.("li, " + BLOCK_SELECTOR + ", hr, details");
      if (!block || !root.contains(block) || block === root) return null;
      if (block.tagName === "LI") return block;
      let top = block;
      while (top.parentElement && top.parentElement !== root) top = top.parentElement;
      return top.parentElement === root ? top : null;
    }
    function showHandle(block) {
      hovered = block;
      if (!block || root.contentEditable !== "true") { handle.hidden = true; return; }
      const rect = block.getBoundingClientRect(), rootRect = root.getBoundingClientRect();
      handle.hidden = false;
      handle.style.top = `${rect.top + Math.min(rect.height / 2, 14) - 14}px`;
      // Sit just outside the text column, measured so it never covers content.
      handle.style.left = `${Math.max(4, rootRect.left - handle.offsetWidth - 6)}px`;
    }
    root.addEventListener("mousemove", event => { if (!drag) showHandle(handleTarget(event.target)); });
    root.addEventListener("mouseleave", event => { if (!drag && !handle.contains(event.relatedTarget)) handle.hidden = true; });
    handle.addEventListener("mouseleave", event => { if (!drag && !root.contains(event.relatedTarget)) handle.hidden = true; });
    handle.addEventListener("mousedown", event => event.preventDefault());
    handle.querySelector("[data-jb-add]").addEventListener("click", () => {
      if (!hovered || !root.contains(hovered)) return;
      const fresh = ensureContent(document.createElement(hovered.tagName === "LI" ? "li" : "p"));
      hovered.after(fresh);
      placeCaret(fresh);
      document.execCommand("insertText", false, "/");
    });
    const grip = handle.querySelector("[data-jb-grip]");
    const marker = document.createElement("div");
    marker.className = "jb-drop";
    grip.addEventListener("pointerdown", event => {
      if (!hovered || !root.contains(hovered)) return;
      event.preventDefault();
      grip.setPointerCapture?.(event.pointerId);
      drag = { block: hovered, target: null, before: true };
      hovered.classList.add("jb-dragging");
      document.body.append(marker);
    });
    grip.addEventListener("pointermove", event => {
      if (!drag) return;
      const siblings = [...drag.block.parentElement.children].filter(child => child !== drag.block);
      let target = null, before = true;
      for (const sibling of siblings) {
        const rect = sibling.getBoundingClientRect();
        if (event.clientY < rect.top + rect.height / 2) { target = sibling; before = true; break; }
        target = sibling;
        before = false;
      }
      drag.target = target;
      drag.before = before;
      if (!target) return;
      const rect = target.getBoundingClientRect();
      marker.style.left = `${rect.left}px`;
      marker.style.width = `${rect.width}px`;
      marker.style.top = `${(before ? rect.top : rect.bottom) - 1}px`;
    });
    function endDrag() {
      if (!drag) return;
      const { block, target, before } = drag;
      drag = null;
      block.classList.remove("jb-dragging");
      marker.remove();
      if (target && root.contains(target)) {
        if (before) target.before(block);
        else target.after(block);
        changed();
      }
      showHandle(block);
    }
    grip.addEventListener("pointerup", endDrag);
    grip.addEventListener("pointercancel", endDrag);

    // ── checkboxes, placeholder, structure ──
    function prepare() {
      for (const box of root.querySelectorAll('input[type="checkbox"]')) {
        box.disabled = false;
        box.contentEditable = "false";
        box.setAttribute("aria-label", "Done");
      }
    }
    root.addEventListener("click", event => {
      const box = event.target.closest?.('input[type="checkbox"]');
      if (!box || !root.contains(box)) return;
      // Persist the checked state in markup so serialization sees it.
      box.toggleAttribute("checked", box.checked);
      box.closest("li")?.classList.toggle("is-done", box.checked);
      changed();
    });
    function updatePlaceholder() {
      for (const element of root.querySelectorAll(".jb-empty")) element.classList.remove("jb-empty");
      const block = document.activeElement === root ? currentBlockQuiet() : null;
      const lone = root.children.length === 1 && root.firstElementChild;
      for (const candidate of new Set([block, lone])) {
        if (candidate && !candidate.textContent.replace(/​/g, "") && !candidate.querySelector("img, hr, input, details")) {
          candidate.classList.add("jb-empty");
          candidate.dataset.placeholder = candidate === lone && candidate !== block ? "Start writing…" : placeholder;
        }
      }
    }
    function currentBlockQuiet() {
      const range = caretRange();
      if (!range) return null;
      const node = range.startContainer;
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      const block = element?.closest(BLOCK_SELECTOR);
      return block && block !== root && root.contains(block) ? block : null;
    }
    function ensureBlock() {
      if (!root.firstElementChild && !root.textContent.trim()) {
        root.replaceChildren(ensureContent(document.createElement("p")));
      }
    }
    function onFocus() {
      try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* older engines */ }
      ensureBlock();
      prepare();
      updatePlaceholder();
    }
    const observer = new MutationObserver(() => prepare());
    observer.observe(root, { childList: true, subtree: true });
    const onSelection = () => {
      if (!root.contains(selection().anchorNode)) return;
      updatePlaceholder();
      if (menu.open) filterMenu();
      // Touch screens have no hover: follow the caret.
      if (!drag && matchMedia("(hover: none)").matches) showHandle(handleTarget(currentBlockQuiet()));
    };
    root.addEventListener("input", onInput);
    root.addEventListener("keydown", onKeyDown);
    root.addEventListener("focus", onFocus);
    root.addEventListener("blur", () => { closeMenu(); setTimeout(updatePlaceholder); });
    document.addEventListener("selectionchange", onSelection);
    const onScroll = () => { handle.hidden = true; if (menu.open) filterMenu(); };
    window.addEventListener("scroll", onScroll, true);
    prepare();
    updatePlaceholder();

    return function destroy() {
      observer.disconnect();
      closeMenu();
      handle.remove();
      marker.remove();
      document.removeEventListener("selectionchange", onSelection);
      window.removeEventListener("scroll", onScroll, true);
      root.removeEventListener("input", onInput);
      root.removeEventListener("keydown", onKeyDown);
      root.removeEventListener("focus", onFocus);
      delete root.dataset.blocks;
    };
  }

  // Paste: markdown becomes blocks; plain text stays plain. Returns true when handled.
  function pasteText(text) {
    if (!text || !looksLikeMarkdown(text) || !window.marked || !window.DOMPurify) return false;
    // Code blocks take the text literally.
    const anchor = window.getSelection()?.anchorNode;
    const at = anchor && (anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement);
    if (at?.closest("pre, code")) return false;
    document.execCommand("insertHTML", false, window.DOMPurify.sanitize(window.marked.parse(text)));
    return true;
  }

  window.JournalBlocks = { enhance, pasteText, looksLikeMarkdown, TYPES };
})();
