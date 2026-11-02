/* global window, document, sessionStorage, FormData */
// Review answers use the same account transaction as the remote MCP tools.
(function () {
  "use strict";
  const DCC = (window.DCC = window.DCC || {});
  const esc = (value) => DCC.esc(value);
  const labels = {
    done: "Done",
    still_working: "Still working",
    drop: "Drop it",
    step_done: "Progress made → next iteration"
  };
  const message = (result) =>
    result.saveStatus === "verified_saved"
      ? "Saved and verified in DCC."
      : result.saveStatus === "stale_conflict"
        ? "The task changed after this decision. Review its current state before another change."
        : "Save not yet verified. Retry this exact decision to check it safely.";
  // Account-local pending envelopes survive modal close/reload. No auto-dispatch:
  // resuming always displays the prior decision before a user presses Retry.
  const account = window.DCC_ACCOUNT_CONTEXT;
  if (!account?.userId || !account.workspaceId) return;
  const key = () => "dcc-reconciliation:" + account.workspaceId + ":" + account.userId;
  // Keep storage per tab. Server ownership/version checks also fence every replay.
  function journal() {
    try {
      return JSON.parse(sessionStorage.getItem(key()) || "{}");
    } catch {
      return {};
    }
  }
  function saveJournal(value) {
    sessionStorage.setItem(key(), JSON.stringify(value));
  }
  async function open(anchor, date) {
    let review = null,
      busy = false,
      closed = false,
      status = "",
      form = null,
      pending = journal().pending || null,
      last = journal().last || null;
    const modal = DCC.modal({
      title: "Did these happen?",
      anchor,
      body: "Loading unfinished tasks…",
      onClose: () => {
        closed = true;
      }
    });
    const draw = () => {
      if (closed) return;
      const body = document.createElement("div");
      body.className = "completion-review";
      body.innerHTML =
        "<p>Confirm what happened. Progress can finish an iteration while its next step keeps the goal open.</p>" +
        '<p role="status" aria-live="polite">' +
        esc(status) +
        "</p>" +
        (pending
          ? "<p>A previous decision still needs verification. Retry it before making another choice.</p><button data-retry " +
            (busy ? "disabled" : "") +
            ">Retry saved decision</button>"
          : "") +
        (last && !pending ? "<button data-undo " + (busy ? "disabled" : "") + ">Undo last saved choice</button>" : "") +
        (!review
          ? ""
          : review.candidates
              .map(
                (item) =>
                  '<section class="completion-review-item"><h3>' +
                  esc(item.title) +
                  "</h3><p>" +
                  esc(item.date || "Unscheduled") +
                  "</p><div>" +
                  item.choices
                    .map(
                      (choice) =>
                        '<button data-task="' +
                        esc(item.taskId) +
                        '" data-choice="' +
                        choice +
                        '" ' +
                        (busy || pending ? "disabled" : "") +
                        ">" +
                        labels[choice] +
                        "</button>"
                    )
                    .join(" ") +
                  "</div></section>"
              )
              .join("") || "<p>No more tasks in this review.</p>") +
        (form
          ? "<form data-outcome><h3>" +
            esc(form.item.title) +
            "</h3>" +
            (form.choice === "drop"
              ? "<p>" + esc(form.item.dropConsequence) + "</p>"
              : '<label>What got done?<textarea name="outcome" maxlength="2000" required></textarea></label>') +
            (form.choice === "step_done"
              ? '<label>Completed iteration title<input name="completedTitle" maxlength="200" value="' +
                esc(form.item.title) +
                '" required></label><label>Next task title<input name="nextTitle" maxlength="200" required></label><label>What remains?<textarea name="remaining" maxlength="2000" required></textarea></label>'
              : "") +
            '<button type="submit" ' +
            (busy ? "disabled" : "") +
            ">" +
            (form.choice === "drop" ? "Drop this occurrence" : "Save outcome") +
            '</button> <button type="button" data-cancel>Cancel</button></form>'
          : "");
      body.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (!button || busy) return;
        if (button.hasAttribute("data-retry")) {
          void send();
          return;
        }
        if (button.hasAttribute("data-undo")) {
          void undo();
          return;
        }
        if (button.hasAttribute("data-cancel")) {
          form = null;
          draw();
          return;
        }
        if (!button.dataset.choice || pending) return;
        const item = review.candidates.find((row) => row.taskId === button.dataset.task);
        if (button.dataset.choice === "still_working") {
          void choose(item, "still_working", {});
          return;
        }
        form = { item, choice: button.dataset.choice };
        draw();
      });
      body.querySelector("[data-outcome]")?.addEventListener("submit", (event) => {
        event.preventDefault();
        if (busy || pending) return;
        const data = new FormData(event.target),
          fields = form.choice === "drop" ? {} : { outcome: data.get("outcome") };
        if (form.choice === "step_done") {
          fields.completedTitle = data.get("completedTitle");
          fields.nextStep = { title: data.get("nextTitle"), summary: data.get("remaining") };
        }
        void choose(form.item, form.choice, fields);
      });
      modal.update({
        title: "Did these happen?",
        body,
        actions: [{ label: "Refresh review", keepOpen: true, onClick: () => !busy && !pending && load() }]
      });
    };
    async function load() {
      busy = true;
      draw();
      try {
        review = await DCC.api(
          "/api/working-queue/completion-review" + (date ? "?date=" + encodeURIComponent(date) : "")
        );
      } catch (e) {
        status = "Review unavailable: " + (e.message || "Sign in or reconnect.");
      } finally {
        busy = false;
        draw();
      }
    }
    async function choose(item, choice, fields) {
      if (busy || pending) return;
      if (window.blockStore?.hasPendingWrites?.()) {
        status = "Wait for your task edits to finish saving, then refresh this review.";
        draw();
        return;
      }
      pending = {
        action: "reconcile",
        sourceEventId: "review:" + crypto.randomUUID(),
        expectedRevision: review.revision,
        at: new Date().toISOString(),
        taskId: item.taskId,
        reconciliation: { choice, expectedTaskVersion: item.expectedTaskVersion, reviewDate: review.date, ...fields }
      };
      try {
        saveJournal({ pending, last });
      } catch {
        pending = null;
        status = "Could not preserve this decision for safe retry. Nothing was sent.";
        draw();
        return;
      }
      await send();
    }
    async function send() {
      if (busy || !pending) return;
      busy = true;
      status = "Saving…";
      draw();
      try {
        const result = await DCC.api("/api/working-queue", { method: "POST", body: pending });
        status = message(result);
        if (result.saveStatus === "verified_saved") {
          last = {
            sourceEventId: pending.sourceEventId,
            taskId: pending.taskId,
            undoable: pending.reconciliation.choice !== "undo"
          };
          // get the version from server-provided verification, not a browser hash.
          last.expectedTaskVersion = result.reconciliation.versions[pending.taskId];
          if (!last.undoable) last = null;
          window.blockStore?.acceptWorkRotation?.(result.verifiedTasks || result.affectedTasks || []);
          pending = null;
          form = null;
          saveJournal({ last });
          try {
            review = await DCC.api(
              "/api/working-queue/completion-review" + (date ? "?date=" + encodeURIComponent(date) : "")
            );
          } catch (e) {
            status += " Review refresh unavailable: " + e.message;
          }
        } else if (result.saveStatus === "stale_conflict") {
          pending = null;
          saveJournal({ last });
          form = null;
        }
      } catch (e) {
        // A transport error can happen after commit. Preserve the exact command.
        status =
          "Save not verified: " +
          (e.message || "connection interrupted") +
          ". Retry the saved decision; do not assume it failed.";
        if ([400, 403, 404, 409].includes(e.status)) {
          status =
            e.status === 409
              ? "Task changed. Refresh and review before submitting a new decision."
              : "Decision was not saved: " + e.message;
          pending = null;
          form = null;
          saveJournal({ last });
        }
      } finally {
        busy = false;
        draw();
      }
    }
    async function undo() {
      if (!last || busy || pending) return;
      pending = {
        action: "reconcile",
        sourceEventId: "review-undo:" + crypto.randomUUID(),
        expectedRevision: review.revision,
        at: new Date().toISOString(),
        taskId: last.taskId,
        reconciliation: {
          choice: "undo",
          expectedTaskVersion: last.expectedTaskVersion,
          undoEventId: last.sourceEventId
        }
      };
      try {
        saveJournal({ pending, last });
      } catch {
        pending = null;
        status = "Could not preserve undo for retry. Nothing was sent.";
        draw();
        return;
      }
      await send();
    }
    await load();
  }
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-completion-review]");
    if (button) void open(button, button.dataset.reviewDate || undefined);
  });
  function summaryHtml(task) {
    const lines = [];
    if (task.completionOutcome) lines.push("<p><strong>Accomplished:</strong> " + esc(task.completionOutcome) + "</p>");
    if (task.remainingWork) lines.push("<p><strong>Remaining:</strong> " + esc(task.remainingWork) + "</p>");
    if (task.originalGoal)
      lines.push(
        "<p><strong>Goal:</strong> " +
          esc(task.originalGoal) +
          (task.goalComplete === false ? " — continues in the linked next iteration" : "") +
          "</p>"
      );
    return lines.length ? '<section class="task-iteration-summary">' + lines.join("") + "</section>" : "";
  }
  DCC.TaskReconciliation = { open, summaryHtml };
})();
