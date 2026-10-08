(function () {
  "use strict";
  const esc = value => DCC.esc(value);
  const sync = () => window.DCCCommitmentSync;
  let records = [], pending = [], selected = null, loadSequence = 0;
  const roleCopy = {
    viewer: "Read this commitment and its history",
    helper: "Comment and help with this commitment",
    coach: "Comment, request a check-in, and challenge progress",
    manager: "Coach and record outcome reviews",
  };
  function message(value, error = false) {
    const el = document.getElementById("commitment-message");
    el.textContent = value; el.classList.toggle("error", error);
  }
  function render() {
    const day = document.getElementById("commitment-date").value;
    const today = records.filter(r => r.committed_date === day || r.role === "invited");
    const list = document.getElementById("commitment-list");
    list.innerHTML = today.length ? today.map(r => '<button class="commitment-card" type="button" data-commitment="' + esc(r.id) + '" aria-pressed="' + (selected === r.id) + '"><strong>' + esc(r.title) + '</strong><span>' + esc(r.ownerName || "You") + ' · ' + esc(r.role === "invited" ? "Invitation to be " + r.invitedRole : r.status + " · " + r.role) + '</span>' + (pending.some(p => p.commitmentId === r.id) ? '<small>Saved here · waiting for server</small>' : '') + '</button>').join("") : '<p class="social-empty">No commitments for this day. Choose one outcome worth sharing.</p>';
    const detail = document.getElementById("commitment-detail");
    const r = records.find(r => r.id === selected);
    if (!r) { detail.innerHTML = '<p class="social-empty">Open a commitment to see its outcome, people, and history.</p>'; }
    else if (r.role === "invited") {
      detail.innerHTML = '<h3>' + esc(r.title) + '</h3><p>' + esc(r.ownerName) + ' invited you as ' + esc(r.invitedRole) + '. ' + esc(roleCopy[r.invitedRole]) + '.</p><p>Acceptance gives access to this commitment, not the owner’s private daily list.</p><div class="commitment-actions"><button data-invite-answer="accept" type="button" class="social-btn primary">Accept invitation</button><button data-invite-answer="decline" type="button" class="social-btn">Decline</button></div>';
    } else {
      const actions = Object.entries({ comment: "Comment / offer help", check_in: "Request a check-in", challenge: "Challenge progress", review: "Review outcome", complete: "Mark my commitment complete", blocked: "Record a blocker", reopen: "Reopen with explanation", renegotiate: "Renegotiate my date" }).filter(([kind]) => r.capabilities?.[kind] || (["blocked","reopen"].includes(kind) && r.capabilities?.complete));
      const busy = pending.some(p => p.commitmentId === r.id);
      detail.innerHTML = '<h3>' + esc(r.title) + '</h3><p class="commitment-meta">Accountable: ' + esc(r.ownerName) + ' · ' + esc(r.committed_date) + ' · ' + esc(r.time_zone) + ' · ' + esc(r.status) + '</p><h4>Done means</h4><p class="commitment-text">' + esc(r.definition_done) + '</p>' + (r.check_in_at ? '<p>Check-in: ' + esc(new Date(r.check_in_at).toLocaleString()) + '</p>' : '') + (r.evidence ? '<h4>Completion evidence</h4><p class="commitment-text">' + esc(r.evidence) + '</p>' : '') +
        (actions.length ? '<form id="commitment-action-form"><fieldset' + (busy ? ' disabled' : '') + '><legend>Next action</legend><label>Action<select name="kind">' + actions.map(([k,v]) => '<option value="' + k + '">' + v + '</option>').join('') + '</select></label><label>Explanation or evidence<textarea name="note" required maxlength="2000" rows="3" placeholder="What changed, what would help, or how was the outcome met?"></textarea></label><div class="commitment-action-date" hidden><label>New commitment date<input name="committedDate" type="date" value="' + esc(r.committed_date) + '"></label></div><div class="commitment-checkin" hidden><label>Check-in time (your device timezone)<input name="at" type="datetime-local"></label></div><div class="commitment-verdict" hidden><label>Outcome<select name="verdict"><option value="met">Met</option><option value="partial">Partially met</option><option value="missed">Missed</option></select></label></div><button class="social-btn primary" type="submit">Save action</button></fieldset></form>' : '') +
        '<h4>People on this commitment</h4><ul class="commitment-members"><li>' + esc(r.ownerName) + ' · accountable owner</li>' + (r.members || []).map(m => '<li>' + esc(m.username) + ' · ' + esc(m.role) + ' · ' + esc(m.state) + (r.capabilities?.manage ? ' <button class="social-btn" data-member-revoke="' + m.user_id + '" type="button">Revoke</button>' : '') + '</li>').join('') + '</ul>' +
        (r.capabilities?.manage ? '<details><summary>Invite someone to this commitment</summary><form id="commitment-invite-form"><fieldset' + (busy ? ' disabled' : '') + '><label>Exact username or email<input name="person" required maxlength="120" autocomplete="off"></label><label>Permission<select name="role">' + Object.entries(roleCopy).map(([k,v]) => '<option value="' + k + '">' + k + ' — ' + esc(v) + '</option>').join('') + '</select></label><p>They must accept. This shares only the outcome, definition, evidence, people and history shown here.</p><button class="social-btn" type="submit">Send invitation</button></fieldset></form></details>' : '') +
        '<h4>Commitment history</h4><ol class="commitment-history">' + (r.events || []).map(e => '<li><strong>' + esc(e.actor_name) + ' · ' + esc(e.kind.replace(/_/g," ")) + '</strong><time>' + esc(new Date(e.created_at).toLocaleString()) + '</time><p class="commitment-text">' + esc([e.detail.note, e.detail.evidence, e.detail.verdict, e.detail.beforeDate && e.detail.beforeDate + ' → ' + e.detail.date, e.detail.username && e.detail.username + ' · ' + e.detail.role].filter(Boolean).join("\n")) + '</p></li>').join('') + '</ol>';
    }
    document.getElementById("commitment-pending").innerHTML = pending.length ? '<h4>Pending changes (' + pending.length + ')</h4><p>Conflicts stay here for review. Export before discarding anything you need.</p>' + pending.map(p => '<div class="commitment-pending-item"><strong>' + esc(p.body.kind || p.body.title || 'New commitment') + '</strong><p class="commitment-text">' + esc(p.body.note || p.body.evidence || '') + '</p><span>' + esc(p.error || 'Saved here · waiting to sync') + '</span>' + (p.status === 409 ? '<p>This changed elsewhere. Export your text, discard the pending change, and submit it again after reviewing the latest version.</p>' : [401,403,404].includes(p.status) ? '<p>Access changed. Your pending text is kept for export. Retrying does not restore access.</p>' : '') + '<div class="commitment-actions">' + (p.error ? '<button class="social-btn" type="button" data-pending-retry="' + p.actionId + '">Retry same action</button>' : '') + '<button class="social-btn" type="button" data-pending-discard="' + p.actionId + '">Discard pending change</button></div></div>').join('') : '';
  }
  async function load(remote = true) {
    if (!sync()) { message("Sign in and reload to use commitments.", true); return; }
    const shell = document.getElementById("commitment-workspace");
    const sequence = ++loadSequence;
    shell.setAttribute("aria-busy", "true");
    try {
      const next = await (remote ? sync().refresh() : sync().cached());
      const nextPending = await sync().pending();
      if (sequence !== loadSequence) return;
      // An in-flight refresh must not erase a draft the user began while it was
      // loading. A removed permission still clears the visible shared record.
      const typing = shell.contains(document.activeElement) && document.activeElement.matches("input,textarea,select");
      if (remote && typing && (!selected || next.some(r => r.id === selected))) return;
      records = next; pending = nextPending; render();
      const status = sync().summary;
      message(status.attention ? "A pending change needs your review." : status.remoteError ? "Offline. Saved work will sync when you reconnect." : status.pending ? "Saved on this device. Waiting for server acknowledgement." : "Up to date across devices.", status.attention);
    } catch (e) { message(e.message, true); }
    finally { if (sequence === loadSequence) shell.removeAttribute("aria-busy"); }
  }

  async function act(body) {
    const r = records.find(r => r.id === selected);
    await sync().queue(r, body);
    message("Saved on this device. Waiting for server acknowledgement.");
    await load(false);
  }
  function bind() {
    const shell = document.getElementById("commitment-workspace");
    if (!shell) return;
    document.getElementById("commitment-date").value = DCC.dates.todayKey();
    document.getElementById("commitment-date").dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector('#commitment-create-form [name="committedDate"]').value = DCC.dates.todayKey();
    document.querySelector('#commitment-create-form [name="committedDate"]').dispatchEvent(new Event("change", { bubbles: true }));
    shell.addEventListener("change", e => {
      if (e.target.id === "commitment-date") return render();
      if (e.target.name === "kind") {
        shell.querySelector('[name="note"]').required = e.target.value !== "complete";
        shell.querySelector('[name="at"]').required = e.target.value === "check_in";
        shell.querySelector('.commitment-action-date').hidden = e.target.value !== "renegotiate";
        shell.querySelector('.commitment-checkin').hidden = e.target.value !== "check_in";
        shell.querySelector('.commitment-verdict').hidden = e.target.value !== "review";
      }
    });
    shell.addEventListener("submit", async e => {
      e.preventDefault(); const form = e.target;
      if (form.dataset.saving) return;
      form.dataset.saving = "1";
      const body = Object.fromEntries(new FormData(form));
      try {
        if (form.id === "commitment-create-form") {
          body.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const id = crypto.randomUUID();
          await sync().queue({ id, title: body.title, definition_done: body.definitionDone, committed_date: body.committedDate, time_zone: body.timeZone, ownerName: "You", role: "owner", revision: 0, status: "open", capabilities: {}, members: [], events: [] }, body, true);
          selected = id; document.getElementById("commitment-date").value = body.committedDate;
          form.reset(); form.closest('details').open = false;
          form.querySelector('[name="committedDate"]').value = DCC.dates.todayKey();
          await load(false); message("Saved here. Your private daily tasks were not shared.");
        } else if (form.id === "commitment-invite-form") {
          const person = await DCC.api("/api/social/users/lookup?q=" + encodeURIComponent(body.person));
          await act({ kind: "invite", userId: person.user?.id || person.id, role: body.role });
        } else {
          if (body.kind === "complete") { body.evidence = body.note; delete body.note; }
          if (body.kind === "check_in") {
            if (!body.at) throw new Error("Choose a check-in time");
            body.at = new Date(body.at).toISOString();
          } else delete body.at;
          await act(body);
        }
      } catch (err) { message(err.message, true); }
      finally { delete form.dataset.saving; }
    });
    shell.addEventListener("click", async e => {
      const button = e.target.closest("button"); if (!button) return;
      try {
        if (button.dataset.commitment) { selected = button.dataset.commitment; return render(); }
        if (button.dataset.inviteAnswer) return await act({ kind: button.dataset.inviteAnswer });
        if (button.dataset.memberRevoke) return await act({ kind: "revoke", userId: Number(button.dataset.memberRevoke) });
        if (button.id === "commitment-refresh") {
          button.disabled = true;
          try { await sync().flush(); await load(); }
          finally { button.disabled = false; }
          return;
        }
        if (button.dataset.pendingRetry) { await sync().retry(button.dataset.pendingRetry); return await load(false); }
        if (button.dataset.pendingDiscard) {
          if (confirm("Discard this pending change? Export first if you need to keep its text.")) { await sync().discard(button.dataset.pendingDiscard); await load(false); }
        }
        if (button.id === "commitment-export") {
          const blob = new Blob([JSON.stringify({ account: window.DCC_ACCOUNT_CONTEXT, actions: await sync().pending() }, null, 2)], { type: "application/json" });
          const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "pending-commitments.json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }
      } catch (err) { message(err.message, true); }
    });
    // Refresh on explicit navigation; background sync must not erase a draft.
    document.querySelector('[data-social-tab="commitments"]')?.addEventListener("click", () => load());
    window.addEventListener("dcc:commitments", () => {
      if (!shell.contains(document.activeElement)) void load(false);
    });
    void load();
  }
  document.addEventListener("DOMContentLoaded", bind);
})();
