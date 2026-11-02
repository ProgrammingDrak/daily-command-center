// Installation is always user initiated. This module never writes account or task state.
(function () {
  "use strict";
  let deferredPrompt = null;
  let installed = false;
  let prompting = false;
  let dialog = null;
  const displayModes = ["standalone", "minimal-ui", "fullscreen"].map((mode) =>
    window.matchMedia("(display-mode: " + mode + ")"));

  function isInstalled() {
    return installed || navigator.standalone === true || displayModes.some((mode) => mode.matches);
  }

  function refresh() {
    const button = document.getElementById("dcc-install");
    if (!button) return;
    button.textContent = isInstalled() ? "DCC is installed" : "Install DCC";
    button.disabled = prompting;
  }

  function guidance() {
    if (isInstalled()) return {
      title: "DCC is installed",
      body: "<p>You’re using DCC in its app window. Open it from your Home Screen, Dock, or app launcher next time.</p>"
    };
    const ua = navigator.userAgent || "";
    const appleMobile = /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const inApp = /FBAN|FBAV|Instagram|Line\/|MicroMessenger|Slack|Teams|wv\)/i.test(ua);
    const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Chromium|Android/.test(ua);
    if (appleMobile) return {
      title: "Add DCC to your Home Screen",
      body: (inApp || !safari ? "<p>Open this same DCC address in Safari first, then follow these steps.</p>" : "") +
        "<ol><li>In Safari, tap <strong>Share</strong> (the square with an upward arrow). It may be inside the More menu.</li>" +
        "<li>Choose <strong>Add to Home Screen</strong>. Scroll down if needed; if it’s missing, check <strong>Edit Actions</strong>.</li>" +
        "<li>Turn on <strong>Open as Web App</strong> if shown, then tap <strong>Add</strong>.</li></ol>" +
        "<p>Launch DCC from the new Home Screen icon. You may need to sign in again.</p>"
    };
    if (inApp) return {
      title: "Open DCC in your browser",
      body: "<p>This in-app browser may not support installation. Open this same DCC address in Safari, Chrome, or Edge, then choose Install DCC again.</p>"
    };
    if (/Macintosh|MacIntel/.test(ua + navigator.platform) && safari) return {
      title: "Add DCC to your Dock",
      body: "<p>In Safari on a supported Mac, choose <strong>File → Add to Dock</strong>, then <strong>Add</strong>. You may need to sign in again in the app.</p>"
    };
    return {
      title: "Install DCC from your browser",
      body: "<p>A native install prompt isn’t available right now. If your browser offers an install icon in the address bar or <strong>Install app</strong> / <strong>Add to Home Screen</strong> in its menu, use that option.</p>" +
        "<p>If no install option appears, try Chrome or Edge on desktop or Android, or Safari on iPhone or iPad. You can keep using DCC in this browser.</p>"
    };
  }

  function show(message) {
    const view = guidance();
    const status = message ? "<p role=\"status\">" + message + "</p>" : "";
    dialog = window.DCC.overlay.open({
      kind: "modal",
      title: view.title,
      body: status + view.body,
      anchor: document.getElementById("dcc-settings-button"),
      actions: [{ label: "Done", kind: "primary" }],
      onClose: () => { dialog = null; }
    });
  }

  async function open() {
    if (prompting) return;
    document.getElementById("dcc-settings-wrap")?.classList.remove("open");
    document.getElementById("dcc-settings-button")?.setAttribute("aria-expanded", "false");
    document.getElementById("dcc-settings-menu")?.setAttribute("aria-hidden", "true");
    if (!deferredPrompt || isInstalled()) { show(); return; }
    const event = deferredPrompt;
    deferredPrompt = null; // Native prompt events are single use, including dismissal or failure.
    prompting = true;
    refresh();
    try {
      await event.prompt();
      const choice = await event.userChoice;
      if (isInstalled()) show();
      else if (choice?.outcome === "accepted") show("Install request accepted. Follow your browser’s instructions to finish, then open DCC from its app icon.");
      else show("Installation was dismissed. You can revisit Install DCC from Settings whenever you want.");
    } catch (_error) {
      show("The browser couldn’t open its install prompt. You can try its install menu instead.");
    } finally {
      prompting = false;
      refresh();
    }
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    if (!isInstalled()) deferredPrompt = event;
    refresh();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferredPrompt = null;
    refresh();
    if (dialog) dialog.update({ ...guidance(), actions: [{ label: "Done", kind: "primary" }] });
  });
  // Let DCC/browser navigation own history. Back dismisses an open guide without adding entries.
  window.addEventListener("popstate", () => dialog?.close("navigation"));
  displayModes.forEach((mode) => mode.addEventListener("change", refresh));
  document.getElementById("dcc-install")?.addEventListener("click", open);
  refresh();
})();
