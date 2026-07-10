// ======== DCC DROPDOWN ========
// A reusable, accessible custom dropdown. Styled with the shared DCC CSS
// variables (--card, --border, --accent, etc.) so it matches everywhere it's
// dropped in. Vanilla JS, no external libraries — same as the rest of the app.
//
// Usage:
//   const dd = new DccDropdown(containerEl, {
//     options: [{ value:"default", label:"Default", description:"..." }, ...],
//     value: "default",
//     placeholder: "Select…",
//     onChange: (value, option) => { ... }
//   });
//   dd.setOptions(nextOptions);
//   dd.setValue("other");
//   dd.getValue();
//   dd.destroy();
(function () {
  function esc(s) {
    if (s == null) return "";
    return (typeof escHtml === "function" ? escHtml(String(s)) : String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));
  }

  let _openInstance = null;
  let _uid = 0;

  class DccDropdown {
    constructor(container, opts) {
      this.container = typeof container === "string" ? document.querySelector(container) : container;
      if (!this.container) throw new Error("DccDropdown: container not found");
      this.options = Array.isArray(opts && opts.options) ? opts.options : [];
      this.value = opts && opts.value !== undefined ? opts.value : null;
      this.placeholder = (opts && opts.placeholder) || "Select…";
      this.onChange = (opts && opts.onChange) || function () {};
      this._id = "dcc-dd-" + (++_uid);
      this._open = false;
      this._activeIndex = -1;
      this._onDocClick = this._onDocClick.bind(this);
      this._onDocKey = this._onDocKey.bind(this);
      this._render();
    }

    _findOption(value) {
      return this.options.find(o => o.value === value) || null;
    }

    _render() {
      const selected = this._findOption(this.value);
      this.container.classList.add("dcc-dd");
      this.container.innerHTML =
        '<button type="button" class="dcc-dd-trigger" id="' + this._id + '-trigger" ' +
          'aria-haspopup="listbox" aria-expanded="false" aria-controls="' + this._id + '-panel">' +
          '<span class="dcc-dd-trigger-label">' + esc(selected ? selected.label : this.placeholder) + '</span>' +
          '<span class="dcc-dd-caret" aria-hidden="true">&#9662;</span>' +
        '</button>' +
        '<div class="dcc-dd-panel" id="' + this._id + '-panel" role="listbox" hidden></div>';

      this.triggerEl = this.container.querySelector(".dcc-dd-trigger");
      this.panelEl = this.container.querySelector(".dcc-dd-panel");
      this.triggerEl.addEventListener("click", (e) => { e.stopPropagation(); this.toggle(); });
      this.triggerEl.addEventListener("keydown", (e) => this._onTriggerKey(e));
      this._renderPanel();
    }

    _renderPanel() {
      if (!this.options.length) {
        this.panelEl.innerHTML = '<div class="dcc-dd-empty">No options</div>';
        return;
      }
      this.panelEl.innerHTML = this.options.map((o, i) => (
        '<div class="dcc-dd-option' + (o.value === this.value ? " selected" : "") + '" ' +
          'role="option" data-index="' + i + '" data-value="' + esc(o.value) + '" ' +
          'aria-selected="' + (o.value === this.value ? "true" : "false") + '" tabindex="-1">' +
          '<span class="dcc-dd-option-label">' + esc(o.label) + '</span>' +
          (o.description ? '<span class="dcc-dd-option-desc">' + esc(o.description) + '</span>' : '') +
        '</div>'
      )).join("");
      this.panelEl.querySelectorAll(".dcc-dd-option").forEach(el => {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          this._select(Number(el.dataset.index));
        });
        el.addEventListener("mouseenter", () => this._setActive(Number(el.dataset.index), false));
      });
    }

    _setActive(index, scrollIntoView) {
      this._activeIndex = index;
      this.panelEl.querySelectorAll(".dcc-dd-option").forEach((el, i) => {
        el.classList.toggle("active", i === index);
      });
      if (scrollIntoView) {
        const el = this.panelEl.querySelector('.dcc-dd-option[data-index="' + index + '"]');
        if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
      }
    }

    _select(index) {
      const opt = this.options[index];
      if (!opt) return;
      this.value = opt.value;
      this.close();
      this._render();
      this.triggerEl.focus();
      this.onChange(this.value, opt);
    }

    open() {
      if (this._open || !this.options.length) return;
      if (_openInstance && _openInstance !== this) _openInstance.close();
      this._open = true;
      _openInstance = this;
      this.panelEl.hidden = false;
      this.triggerEl.setAttribute("aria-expanded", "true");
      const selIndex = Math.max(0, this.options.findIndex(o => o.value === this.value));
      this._setActive(selIndex, true);
      document.addEventListener("click", this._onDocClick, true);
      document.addEventListener("keydown", this._onDocKey, true);
    }

    close() {
      if (!this._open) return;
      this._open = false;
      if (_openInstance === this) _openInstance = null;
      this.panelEl.hidden = true;
      this.triggerEl.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", this._onDocClick, true);
      document.removeEventListener("keydown", this._onDocKey, true);
    }

    toggle() { this._open ? this.close() : this.open(); }

    _onDocClick(e) {
      if (!this.container.contains(e.target)) this.close();
    }

    _onTriggerKey(e) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (!this._open) this.open(); else this._moveActive(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (!this._open) this.open(); else this._moveActive(-1);
      } else if (e.key === "Escape") {
        this.close();
      }
    }

    _onDocKey(e) {
      if (!this._open) return;
      if (e.key === "ArrowDown") { e.preventDefault(); this._moveActive(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); this._moveActive(-1); }
      else if (e.key === "Enter") { e.preventDefault(); if (this._activeIndex >= 0) this._select(this._activeIndex); }
      else if (e.key === "Escape") { e.preventDefault(); this.close(); this.triggerEl.focus(); }
      else if (e.key === "Tab") { this.close(); }
    }

    _moveActive(delta) {
      const len = this.options.length;
      if (!len) return;
      let next = this._activeIndex + delta;
      if (next < 0) next = len - 1;
      if (next >= len) next = 0;
      this._setActive(next, true);
    }

    setOptions(options) {
      this.options = Array.isArray(options) ? options : [];
      this._renderPanel();
      this._render();
    }

    setValue(value) {
      this.value = value;
      this._render();
    }

    getValue() { return this.value; }

    destroy() {
      this.close();
      this.container.innerHTML = "";
      this.container.classList.remove("dcc-dd");
    }
  }

  window.DccDropdown = DccDropdown;
})();
