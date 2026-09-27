(function () {
  const root = document.getElementById("meeting-reviews-root");
  const badge = document.getElementById("meeting-reviews-badge");
  if (!root || !badge) return;
  const REVIEW_LAYOUT = "split";
  root.dataset.layout = REVIEW_LAYOUT;

  let items = [];
  let filter = "ready";
  let selectedId = null;
  let bundle = null;
  let detailRequest = 0;
  let editingAction = false;
  let refreshQueued = false;

  const esc = window.DCC.esc;
  const url = (id, suffix = "") => "/api/meetings/" + encodeURIComponent(id) + suffix;
  const toast = (message, type) => window.DCC && DCC.toast && DCC.toast(message, type);

  async function request(path, method = "GET", data) {
    return DCC.api(path, { method, body: data, errorLabel: "Meeting review unavailable" });
  }

  function summaryHtml(markdown) {
    const source = String(markdown || "");
    if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(source));
    return "<p>" + esc(source).replace(/\n/g, "<br>") + "</p>";
  }

  function dateLabel(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return "";
    return new Date(value + "T12:00:00").toLocaleDateString(undefined, {
      month: "short", day: "numeric", year: "numeric",
    });
  }

  function renderQueue() {
    const counts = { ready: 0, waiting: 0, reviewed: 0 };
    items.forEach(item => { if (counts[item.status] !== undefined) counts[item.status]++; });
    badge.textContent = counts.ready;
    badge.style.display = counts.ready ? "" : "none";
    const visible = items.filter(item => item.status === filter);
    if (!visible.some(item => item.id === selectedId)) {
      selectedId = visible.length ? visible[0].id : null;
      bundle = null;
    }
    root.innerHTML = '<div class="mr-heading"><div><h2>Meeting Reviews</h2>' +
      '<p>Review each meeting before its actions become tasks.</p></div></div>' +
      '<div class="mr-filters" role="tablist" aria-label="Meeting review status">' +
      [["ready", "Ready"], ["waiting", "Waiting for notes"], ["reviewed", "Reviewed"]]
        .map(([key, label]) => '<button type="button" role="tab" data-mr-filter="' + key +
          '" aria-selected="' + (filter === key) + '" class="' + (filter === key ? "active" : "") +
          '">' + label + ' <span>' + counts[key] + '</span></button>').join("") + '</div>' +
      '<div class="mr-layout"><div class="mr-list" aria-label="Meetings">' +
      (visible.length ? visible.map(item => '<button type="button" class="mr-meeting' +
        (item.id === selectedId ? " selected" : "") + '" data-mr-id="' + esc(item.id) + '">' +
        '<span class="mr-meeting-date">' + esc(dateLabel(item.date)) + '</span>' +
        '<strong>' + esc(item.title) + '</strong><span class="mr-meeting-meta">' +
        (item.status === "waiting" ? "Recap pending" : item.actionCount + " proposed action" +
        (item.actionCount === 1 ? "" : "s")) + '</span></button>').join("") :
        '<p class="mr-empty">' + (filter === "ready" ? "No meetings need review." :
          filter === "waiting" ? "No meetings are waiting for notes." : "No reviewed meetings yet.") + '</p>') +
      '</div><div class="mr-detail" id="mr-detail" aria-live="polite"></div></div>';
    if (selectedId && filter !== "waiting") loadDetail(selectedId);
    else renderDetail();
  }

  function actionHtml(action, meeting) {
    const status = action.status || "proposed";
    const active = status === "proposed" || status === "approved";
    const citation = action.citation || {};
    const offset = citation.startOffset == null ? action.start : citation.startOffset;
    const source = meeting.dashboardRef && Number.isFinite(Number(offset)) && offset != null
      ? '<a href="/meetings/' + encodeURIComponent(meeting.id) + '/dashboard?t=' +
        encodeURIComponent(offset) + '" target="_blank" rel="noopener">View source</a>' : "";
    return '<div class="mr-action" data-mr-action="' + esc(action.id) + '">' +
      '<div class="mr-action-main"><span class="mr-action-text">' + esc(action.text || action.title) + '</span>' +
      '<span class="mr-action-meta">' + esc(action.owner === "other" ? "Other owner" : "Drake") +
      (source ? " · " + source : "") + '</span></div>' +
      (active ? '<div class="mr-action-controls">' +
        (status === "proposed" ? '<button type="button" data-mr-edit="' + esc(action.id) + '">Edit</button>' : "") +
        (action.owner === "other" ? '<span class="mr-owner-note">Owner: other</span>' :
          '<button type="button" class="primary" data-mr-add="' + esc(action.id) + '">Add as task</button>') +
        '<button type="button" data-mr-dismiss="' + esc(action.id) + '">Dismiss</button></div>' :
        '<span class="mr-action-settled">' + (status === "placed" ? "Added as task" : "Dismissed") + '</span>') +
      '</div>';
  }

  function renderDetail() {
    const host = document.getElementById("mr-detail");
    if (!host) return;
    const item = items.find(row => row.id === selectedId);
    if (!item) { host.innerHTML = '<p class="mr-empty">Choose a meeting.</p>'; return; }
    if (item.status === "waiting") {
      host.innerHTML = '<h3>' + esc(item.title) + '</h3><p class="mr-subline">' +
        esc(dateLabel(item.date)) + '</p><div class="mr-note">The recap has not arrived yet. ' +
        'The meeting sweep will retry when notes become available.</div>' +
        '<button type="button" data-mr-open>Add notes or transcript</button>';
      return;
    }
    if (!bundle || bundle.meeting.id !== selectedId) {
      host.innerHTML = '<p class="mr-empty">Loading review…</p>';
      return;
    }
    const meeting = bundle.meeting;
    const actions = bundle.proposedActions || [];
    const unresolved = actions.filter(action => ["proposed", "approved"].includes(action.status)).length;
    const summary = bundle.summary || {};
    const summaryContent = summary.markdown ? summaryHtml(summary.markdown) :
      (window.DOMPurify ? DOMPurify.sanitize(summary.html || "") : summaryHtml(""));
    host.innerHTML = '<div class="mr-detail-head"><div><h3>' + esc(meeting.title) + '</h3>' +
      '<p class="mr-subline">' + esc(dateLabel(meeting.date)) + '</p></div>' +
      '<button type="button" data-mr-open>Open full recap</button></div>' +
      '<section class="mr-summary"><h4>Summary and decisions</h4><div class="mr-prose">' +
      summaryContent + '</div></section>' +
      '<section class="mr-actions"><h4>Proposed actions <span>' + actions.length + '</span></h4>' +
      (actions.length ? actions.map(action => actionHtml(action, meeting)).join("") :
        '<p class="mr-empty">No action items were captured.</p>') + '</section>' +
      (item.status === "ready" ? '<div class="mr-finish"><span>' +
        (unresolved ? "Decide " + unresolved + " action" + (unresolved === 1 ? "" : "s") + " to finish." :
          "Every action has a decision.") + '</span><button type="button" class="primary" data-mr-finish' +
        (unresolved ? " disabled" : "") + '>Finish review</button></div>' :
        '<div class="mr-finish"><span>Reviewed</span></div>');
  }

  async function loadDetail(id) {
    const requestId = ++detailRequest;
    bundle = null;
    renderDetail();
    try {
      const result = await request(url(id, "/automation"));
      if (requestId !== detailRequest || selectedId !== id) return;
      bundle = result;
      renderDetail();
    } catch (error) {
      const host = document.getElementById("mr-detail");
      if (host && requestId === detailRequest) host.innerHTML = '<p class="mr-error">' + esc(error.message) + '</p>';
    }
  }

  async function refresh() {
    try {
      const result = await request("/api/meetings/reviews");
      items = Array.isArray(result.items) ? result.items : [];
      if (editingAction) { refreshQueued = true; return; }
      refreshQueued = false;
      renderQueue();
    } catch (error) {
      if (editingAction) { toast(error.message, "error"); return; }
      const message = navigator.onLine === false
        ? "Meeting Reviews need a connection. Your local tasks remain available."
        : error.message;
      root.innerHTML = '<p class="mr-error">' + esc(message) + '</p>';
    }
  }

  root.addEventListener("click", async event => {
    const filterButton = event.target.closest("[data-mr-filter]");
    if (filterButton) { editingAction = false; filter = filterButton.dataset.mrFilter; selectedId = null; bundle = null; renderQueue(); return; }
    const meetingButton = event.target.closest("[data-mr-id]");
    if (meetingButton) { editingAction = false; selectedId = meetingButton.dataset.mrId; bundle = null; renderQueue(); return; }
    const open = event.target.closest("[data-mr-open]");
    if (open && window.openPrepModal) {
      const meeting = bundle && bundle.meeting || items.find(row => row.id === selectedId);
      if (!meeting) return;
      openPrepModal({ id: meeting.id, title: meeting.title,
        start: meeting.start, end: meeting.end }, { defaultTab: "recap", forceRecap: true });
      return;
    }
    if (!bundle) return;
    const actionId = event.target.closest("[data-mr-edit],[data-mr-add],[data-mr-dismiss]");
    const finish = event.target.closest("[data-mr-finish]");
    try {
      if (finish) {
        await request(url(selectedId, "/review/finish"), "POST", {});
        toast("Meeting review finished", "success");
        await refresh();
      } else if (actionId) {
        const id = actionId.dataset.mrEdit || actionId.dataset.mrAdd || actionId.dataset.mrDismiss;
        const action = (bundle.proposedActions || []).find(row => row.id === id);
        if (!action) return;
        if (actionId.dataset.mrAdd) {
          if (action.owner === "other") return;
          if (!window.scheduleRecapAction) throw new Error("Task scheduler unavailable");
          scheduleRecapAction(selectedId, action, actionId, new Map(), async () => { await refresh(); });
        } else if (actionId.dataset.mrDismiss) {
          await request(url(selectedId, "/actions/" + encodeURIComponent(id) + "/dismiss"), "POST", {});
          await refresh();
        } else {
          const row = actionId.closest(".mr-action");
          const label = row.querySelector(".mr-action-text");
          const input = document.createElement("input");
          input.className = "mr-edit-input";
          input.value = action.text || action.title || "";
          input.setAttribute("aria-label", "Edit proposed action");
          editingAction = true;
          label.replaceWith(input);
          input.focus(); input.select();
          let saving = false;
          const save = async () => {
            if (!input.isConnected || saving) return;
            saving = true;
            try {
              await request(url(selectedId, "/actions/" + encodeURIComponent(id)), "PATCH", { text: input.value });
              editingAction = false;
              await refresh();
            } catch (error) { saving = false; toast(error.message, "error"); input.focus(); }
          };
          input.addEventListener("keydown", e => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              editingAction = false;
              renderDetail();
              if (refreshQueued) refresh();
            }
          });
          input.addEventListener("blur", save, { once: true });
        }
      }
    } catch (error) { toast(error.message, "error"); }
  });

  window.DCC = window.DCC || {};
  DCC.MeetingReviews = { refresh };
  DCC.tabs.register("meeting-reviews", refresh);
  window.addEventListener("online", refresh);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && document.querySelector('.tab[data-tab="meeting-reviews"]')?.classList.contains("active")) refresh();
  });
  refresh();
})();
