// Explicit preview and confirmation only. No timer performs nightly moves.
(function () {
  "use strict";
  const DCC = window.DCC = window.DCC || {};
  const esc = value => DCC.esc(value);
  async function read(selectedIds, days) {
    return DCC.api("/api/review-tomorrow/preview", { method: "POST", body: { selectedIds, days } });
  }
  function summary(plan) {
    const selected = plan.items.filter(item => item.included);
    return selected.filter(item => item.placement.kind === "timed").length + " scheduled · " +
      selected.filter(item => item.placement.kind === "unplanned").length + " to Unscheduled · " +
      plan.items.filter(item => item.held).length + " held for manual review";
  }
  async function open(anchor) {
    let plan = null, busy = false, closed = false, selection = null, days = 14, message = "";
    const modal = DCC.modal({ title: "Review tomorrow", anchor, body: '<p role="status">Loading unfinished work and tomorrow’s appointments…</p>', onClose: () => { closed = true; } });
    modal.el.classList.add("review-tomorrow-modal");
    const draw = () => {
      if (closed) return;
      const body = document.createElement("div");
      body.innerHTML = '<p>Move selected unfinished tasks through ' + esc(plan.sourceDate) + ' to <strong>' + esc(plan.targetDate) + '</strong>. Work hours: ' + esc(plan.bounds.start) + '–' + esc(plan.bounds.end) + ' (' + esc(plan.timeZone) + ').</p>' +
        '<p>' + (plan.days === null ? 'All dated unfinished work is included.' : 'Includes today and the previous ' + (plan.days - 1) + ' days. Choose Include older work to expand the review.') + '</p>' +
        '<p>Existing appointments keep their times. High priority goes first, then older work and shorter tasks. Subtasks move with their parent.</p>' +
        '<p class="review-summary" role="status">' + esc(message || summary(plan)) + '</p>' +
        (plan.truncated ? '<p role="alert">The 2,000-row safety limit was reached. No moves can be confirmed from this incomplete preview. Use individual task scheduling to reduce the pool.</p>' : "") +
        '<div class="review-table-scroll"><table class="review-table"><thead><tr><th scope="col">Move</th><th scope="col">Task</th><th scope="col">From</th><th scope="col">Priority</th><th scope="col">Minutes</th><th scope="col">Tomorrow</th></tr></thead><tbody>' +
        plan.items.map(item => '<tr><td><label class="review-check"><input type="checkbox" data-review-id="' + esc(item.id) + '" aria-label="Move ' + esc(item.title) + '" ' + (item.included ? "checked " : "") + (item.held || busy ? "disabled" : "") + '></label></td><td>' + esc(item.title) + (item.subtreeCount > 1 ? '<small>' + (item.subtreeCount - 1) + ' nested tasks</small>' : '') + '</td><td>' + esc(item.sourceDate) + '</td><td>' + esc(item.priority) + '</td><td>' + esc(item.duration ?? "—") + '</td><td>' + esc(item.held || (item.placement ? item.placement.kind === "timed" ? item.placement.start + '–' + item.placement.end : 'Unscheduled — ' + item.overflowReason : 'Keep on original date')) + '</td></tr>').join("") +
        '</tbody></table></div>' + (!plan.items.length ? '<p>No unfinished dated work to move.</p>' : '') +
        '<p>Unscheduled tasks retain their durations and can be placed later. Held tasks stay on their original date. Review again when plans change.</p>';
      body.addEventListener("change", async event => {
        if (!event.target.matches("[data-review-id]") || busy) return;
        selection = [...body.querySelectorAll("[data-review-id]:checked")].map(el => el.dataset.reviewId);
        await refresh();
      });
      modal.update({ title: "Review tomorrow", body, actions: [
        { label: "Close", onClick: () => modal.close() },
        { label: days === 14 ? "Include older work" : "Last 14 days", keepOpen: true, onClick: () => { if (!busy) { days = days === 14 ? "all" : 14; selection = null; return refresh(); } } },
        { label: "Refresh preview", keepOpen: true, onClick: () => !busy && refresh() },
        { label: busy ? "Working…" : "Confirm selected moves", kind: "primary", keepOpen: true, onClick: confirm },
      ] });
      modal.el.querySelectorAll(".dcc-overlay-actions button").forEach((button, index) => { if (index) button.disabled = busy || (index === 3 && (plan.truncated || !plan.items.some(i => i.included))); });
    };
    async function refresh() {
      busy = true;
      if (plan) draw();
      try { plan = await read(selection, days); message = ""; }
      catch (e) { message = "Preview unavailable: " + (e.message || "Try again"); if (!plan) modal.update({ title: "Review tomorrow", body: '<p role="alert">' + esc(message) + '</p>', actions: [{ label: "Retry", keepOpen: true, onClick: refresh }] }); }
      finally { busy = false; if (plan) { if (message) plan.truncated = true; draw(); } }
    }
    async function confirm() {
      if (busy || !plan || plan.truncated) return false;
      busy = true; draw();
      let moved = 0;
      const movedSourceDates = new Set();
      try {
        selection = plan.items.filter(item => item.included).map(item => item.id);
        const fresh = await read(selection, days);
        if (fresh.fingerprint !== plan.fingerprint) { plan = fresh; message = "The plan changed. Review the updated preview and confirm again."; return false; }
        for (const item of plan.items.filter(item => item.included)) {
          if (closed) break;
          await window.blockStore.rescheduleBlock(item.id, plan.targetDate, { fromDate: item.sourceDate, placement: item.placement, userSetStart: false, reviewGuard: item.reviewGuard });
          moved++; movedSourceDates.add(item.sourceDate);
        }
        message = moved + " task groups moved to " + plan.targetDate + ".";
        DCC.toast?.(message, "info");
        if (!closed) { plan = await read([], days); selection = []; }
      } catch (e) {
        message = moved + " task groups moved. Stopped: " + (e.message || "Refresh and try again") + ". Refresh the preview before continuing.";
        plan.truncated = true;
        DCC.toast?.(message, "info");
      } finally {
        if (moved && DCC.Carryover) {
          DCC.Carryover.recollect();
          movedSourceDates.forEach(date => DCC.Carryover.recollect(date));
          await DCC.Carryover.refoldViewedDay(typeof viewDate !== "undefined" && viewDate ? viewDate : window.__todayDate).catch(() => {});
          window.render?.("schedule");
        }
        busy = false; draw();
      }
      return false;
    }
    await refresh();
  }
  DCC.ReviewTomorrow = { open };
  document.getElementById("dcc-review-tomorrow")?.addEventListener("click", event => {
    document.getElementById("dcc-settings-wrap")?.classList.remove("open");
    document.getElementById("dcc-settings-button")?.setAttribute("aria-expanded", "false");
    document.getElementById("dcc-settings-menu")?.setAttribute("aria-hidden", "true");
    // Let a mobile More sheet finish closing before the shared modal opens.
    const anchor = event.currentTarget;
    window.setTimeout(() => open(anchor).catch(e => DCC.toast?.(e.message)), 0);
  });
})();
