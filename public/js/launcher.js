// One responsive quick-add composer. Supporting utilities live in Utilities.
(function () {
  "use strict";
  const launcher = document.getElementById("dcc-launcher");
  const button = document.getElementById("dcc-launcher-btn");
  const compose = document.getElementById("dcc-compose");
  const scrim = document.getElementById("dcc-scrim");
  const bar = document.getElementById("task-add-launcher");
  if (!launcher || !button || !compose || !bar) return;

  let open = false;

  function setPageInert(next) {
    if (!document.body || !document.body.children) return;
    Array.from(document.body.children).forEach((node) => {
      if (node === launcher || node === scrim || node.tagName === "SCRIPT") return;
      if (next) {
        node.dataset.dccQuickAddWasInert = node.inert ? "1" : "0";
        node.inert = true;
      } else if (Object.prototype.hasOwnProperty.call(node.dataset, "dccQuickAddWasInert")) {
        node.inert = node.dataset.dccQuickAddWasInert === "1";
        delete node.dataset.dccQuickAddWasInert;
      }
    });
  }

  function focusableControls() {
    return Array.from(launcher.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'))
      .filter((node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden");
  }

  function setOpen(next, restoreFocus) {
    open = !!next;
    compose.classList.toggle("open", open);
    compose.setAttribute("aria-hidden", open ? "false" : "true");
    button.setAttribute("aria-expanded", open ? "true" : "false");
    if (scrim) scrim.classList.toggle("open", open);
    if (open) {
      setPageInert(true);
      const input = bar.querySelector(".tab-title");
      if (input) setTimeout(() => input.focus(), 0);
    } else {
      setPageInert(false);
      if (restoreFocus) button.focus();
    }
  }

  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "dcc-compose");
  button.addEventListener("click", () => setOpen(!open, open));
  if (scrim) scrim.addEventListener("click", () => setOpen(false, true));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && open) {
      const controls = focusableControls();
      if (!controls.length) {
        event.preventDefault();
        compose.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !launcher.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      setOpen(false, true);
    }
  });
  bar.addEventListener("dcc:launcher-submit-success", () => setOpen(false, true));
})();
