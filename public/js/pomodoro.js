/* global window, document, localStorage, navigator, crypto, setInterval, clearInterval */
(function () {
  "use strict";
  const DCC = window.DCC,
    M = window.DCCPomodoroModel,
    account = window.DCC_ACCOUNT_CONTEXT;
  if (!DCC || !M || !account?.userId || !account.workspaceId) return;
  const key = "dcc-pomodoro:" + account.workspaceId + ":" + account.userId;
  function read() {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    let p;
    try {
      p = JSON.parse(raw);
    } catch (_e) {
      throw new Error("Saved focus plan is invalid. It has been preserved; restore browser storage before continuing.");
    }
    if (!M.valid(p))
      throw new Error("Saved focus plan is invalid. It has been preserved; restore browser storage before continuing.");
    return p;
  }
  function open(task) {
    let plan;
    try {
      plan = read();
    } catch (e) {
      DCC.toast(e.message, "error");
      return;
    }
    let saved = plan;
    if (!plan || ["complete", "cancelled"].includes(plan.status)) {
      if (!task) {
        DCC.toast("Bring a task to Foreground before creating a Pomodoro.", "info");
        return;
      }
      // Creation is persisted with the first explicit save/start, inside the same lock.
      plan = M.create(task, crypto.randomUUID());
    }
    const body = document.createElement("div");
    body.className = "dcc-pomodoro";
    body.innerHTML =
      "<p><strong>" +
      DCC.esc(plan.title) +
      '</strong></p><p>Four 20-minute focus sections. Set all objectives now, or set each before starting it. Saved on this browser/device only. Save objectives before closing; unsaved edits are discarded.</p><p class="pomodoro-clock" data-clock></p><p data-phase role="status" aria-live="polite"></p><div data-objectives></div><div class="pomodoro-actions"><button type="button" data-focus-action="save">Save objectives</button><button type="button" data-focus-action="start">Start section</button><button type="button" data-focus-action="pause">Pause</button><button type="button" data-focus-action="next">Next section</button></div><details><summary>End this plan early</summary><label><input type="checkbox" data-end-confirm> End the remaining focus sections. The task stays unchanged.</label><button type="button" data-focus-action="end">End plan</button></details><p role="status" data-error></p><p class="wq-time">The timer keeps its deadline when this dialog closes or this device sleeps. It stops after each section. Elapsed time is a focus cue; it does not record work or complete the task.</p>';
    const inputs = body.querySelector("[data-objectives]");
    for (let i = 0; i < 4; i++) {
      const label = document.createElement("label");
      label.textContent = "Section " + (i + 1) + " · 20 minutes";
      const input = document.createElement("textarea");
      input.maxLength = 500;
      input.rows = 2;
      input.value = plan.objectives[i];
      input.dataset.section = i;
      input.setAttribute("aria-label", "Section " + (i + 1) + " objective");
      input.placeholder = "Targeted objective";
      label.append(input);
      inputs.append(label);
    }
    let busy = false,
      stale = false;
    const error = body.querySelector("[data-error]");
    function paint() {
      const now = Date.now(),
        done = M.elapsed(plan, now),
        complete = ["complete", "cancelled"].includes(plan.status),
        ms = M.remaining(plan, now),
        seconds = Math.ceil(ms / 1000);
      body.querySelector("[data-clock]").textContent = complete
        ? plan.status === "cancelled"
          ? "Plan ended"
          : "4 of 4 sections finished"
        : Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
      const phase = complete
        ? plan.status === "cancelled"
          ? "Plan ended early"
          : "Plan complete"
        : done
          ? "Section " + (plan.section + 1) + " timer finished"
          : "Section " + (plan.section + 1) + " of 4 · " + plan.status;
      const status = body.querySelector("[data-phase]");
      if (status.textContent !== phase) status.textContent = phase;
      inputs.querySelectorAll("textarea").forEach((input, i) => {
        input.disabled = busy || stale || complete || i < plan.section;
      });
      body.querySelectorAll("[data-focus-action]").forEach((button) => {
        const a = button.dataset.focusAction;
        button.disabled =
          busy ||
          stale ||
          complete ||
          (a === "start" && !["ready", "paused"].includes(plan.status)) ||
          (a === "pause" && (plan.status !== "running" || done)) ||
          (a === "next" && !done);
        if (a === "start")
          button.textContent = plan.status === "paused" ? "Resume section" : "Start section " + (plan.section + 1);
        if (a === "next") button.textContent = plan.section === 3 ? "Finish plan" : "Prepare next section";
      });
    }
    body.addEventListener("click", async (event) => {
      const action = event.target.closest("[data-focus-action]")?.dataset.focusAction;
      if (!action || busy || stale) return;
      if (action === "end" && !body.querySelector("[data-end-confirm]").checked) {
        error.textContent = "Confirm ending the remaining sections first.";
        return;
      }
      const objectives = Array.from(inputs.querySelectorAll("textarea"), (input) => input.value);
      busy = true;
      paint();
      error.textContent = "";
      try {
        if (!navigator.locks?.request)
          throw new Error("This browser cannot safely coordinate focus timers across tabs. Use a current browser.");
        await navigator.locks.request(key, () => {
          const current = read();
          if (current?.id !== saved?.id || current?.revision !== saved?.revision) {
            stale = true;
            throw new Error(
              "The focus plan changed in another tab. Close and reopen to load it; your unsaved objectives remain here."
            );
          }
          const next = M.change(plan, action, objectives, Date.now());
          localStorage.setItem(key, JSON.stringify(next));
          plan = next;
          saved = next;
        });
      } catch (e) {
        error.textContent = "Could not save: " + e.message;
      } finally {
        busy = false;
        paint();
      }
    });
    function storage(event) {
      if (event.key !== key && event.key !== null) return;
      stale = true;
      error.textContent =
        "Focus plan changed in another tab. Close and reopen to load it. Unsaved objectives remain here.";
      paint();
    }
    window.addEventListener("storage", storage);
    const timer = setInterval(paint, 500);
    paint();
    DCC.overlay.open({
      kind: "modal",
      title: "🍅 Pomodoro",
      body,
      canClose: () => !busy,
      returnFocus: () => document.querySelector('[data-queue-action="pomodoro"]'),
      onClose: () => {
        clearInterval(timer);
        window.removeEventListener("storage", storage);
      },
      actions: [{ label: "Close" }]
    });
  }
  function label() {
    try {
      const p = read();
      if (!p || ["complete", "cancelled"].includes(p.status)) return "🍅";
      if (M.elapsed(p, Date.now())) return "🍅 Section finished";
      const seconds = Math.ceil(M.remaining(p, Date.now()) / 1000);
      return (
        "🍅 " +
        (p.section + 1) +
        "/4 · " +
        (p.status === "ready"
          ? "Ready"
          : p.status === "paused"
            ? "Paused"
            : Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0"))
      );
    } catch (_e) {
      return "🍅 Needs attention";
    }
  }
  function updateButton() {
    document.querySelectorAll('[data-queue-action="pomodoro"]').forEach((button) => {
      button.textContent = label();
      button.setAttribute("aria-label", "Create or open Pomodoro focus plan · " + button.textContent);
    });
  }
  setInterval(updateButton, 1000);
  window.DCCPomodoro = { open, label };
})();
