// ======== SOCIAL ========
// The Social tab: friend requests, the friend list, the publish queue, and the
// feed. This is the FRONT of a back that already existed -- social-store.js has
// shipped friendships, the allowlist, opt-in feed posts and the friends-feed
// query for a long time, and nothing in the app could reach any of it.
//
// The one rule this UI exists to make visible: NOTHING is shared automatically.
// A completed task becomes a `hidden` post; it reaches the feed only when the
// owner presses Publish on that specific post. Work-sourced and private tasks
// never even reach the queue -- the server refuses to publish them, so offering
// the button would be a lie.
//
// Registers itself with DCC.tabs, same as the other tab modules.
(function () {
  "use strict";

  const esc = (v) => window.DCC.esc(v);
  const api = (path, options) => window.DCC.api(path, { ...(options || {}), errorLabel: "Social request failed" });
  const toast = (msg, type) => window.DCC.toast(msg, type);
  // core.js owns these two. ARCHITECTURE.md is explicit that shared helpers live
  // on window.DCC and are never reimplemented per tab, and core.js's own header
  // records that timeAgo and updateBadge were consolidated BECAUSE they had grown
  // per-file copies. A brand new module adding another makes that cleanup bigger.
  const relTime = (v) => (v ? window.DCC.dates.timeAgo(v) : "");

  let state = { publishable: [], requests: [], friends: [], feed: [], grants: [], granted: [] };
  const selectedPosts = new Set();
  // The viewer's own handle, for the "Your username" chip. Fetched once and kept:
  // a username does not change while the page is open, and the Social tab reloads
  // on every open.
  let myUsername = "";
  // The coach day view's own state, kept apart from the tab's: it is a different
  // person's data and must never be mistaken for the viewer's own.
  let coach = { ownerUserId: null, name: "", role: "none", date: "", capabilities: {} };
  // Monotonic token. openCoachDay mutates `coach` in two phases either side of an
  // await, so opening A then quickly B could land A's response last and render
  // A's tasks under B's title with A's role. A stale response is dropped instead.
  let coachRequestId = 0;
  let loading = false;
  let reloadQueued = false;

  function minutesLabel(post) {
    const actual = Number(post.actual_minutes) || 0;
    const planned = Number(post.estimated_minutes) || 0;
    if (actual && planned && actual !== planned) return actual + "m (planned " + planned + "m)";
    if (actual) return actual + "m";
    if (planned) return planned + "m";
    return "";
  }

  function metaLine(post) {
    const bits = [];
    const pts = Number(post.points_awarded) || 0;
    if (pts > 0) bits.push(pts + " pts");
    const mins = minutesLabel(post);
    if (mins) bits.push(mins);
    return bits.join(" &middot; ");
  }

  const ROLE_BLURB = {
    viewer: "can see your day",
    commenter: "can see your day and comment",
    coach: "can adjust points and assign tasks",
    manager: "can edit and delete your tasks"
  };

  function reconcileSelectedPosts() {
    const visibleIds = new Set(state.publishable.map(post => String(post.id)));
    for (const postId of selectedPosts) {
      if (!visibleIds.has(String(postId))) selectedPosts.delete(postId);
    }
  }

  // ── renderers ──────────────────────────────────────────────────────────────

  function renderPublishable() {
    const list = document.getElementById("social-publishable");
    const count = document.getElementById("social-publishable-count");
    if (!list) return;
    reconcileSelectedPosts();
    if (count) count.textContent = state.publishable.length ? state.publishable.length + " waiting" : "nothing waiting";
    if (!state.publishable.length) {
      list.innerHTML = '<div class="social-empty">Finish a task and it shows up here, private, until you publish it.</div>';
      return;
    }
    list.innerHTML = state.publishable.map(post =>
      '<div class="social-item">' +
        '<input class="social-select" type="checkbox" data-social-select="' + post.id + '"' + (selectedPosts.has(String(post.id)) ? " checked" : "") + ' aria-label="Select ' + esc(post.title_snapshot || "task") + '">' +
        '<div class="social-item-body">' +
          '<strong>' + esc(post.title_snapshot || "A task") + '</strong>' +
          '<span class="social-item-meta">' + metaLine(post) + '</span>' +
          '<input class="social-caption" data-caption-for="' + post.id + '" type="text" maxlength="280" placeholder="Say something about it (optional)">' +
          '<span class="social-scope">Visible to: Friends</span>' +
        '</div>' +
        '<div class="social-item-actions">' +
          '<button class="social-btn primary" data-publish="' + post.id + '" type="button">Publish</button>' +
          '<button class="social-btn" data-hide="' + post.id + '" type="button" title="Never show this one">Skip</button>' +
        '</div>' +
      '</div>').join("");
  }

  function renderRequests() {
    const list = document.getElementById("social-requests");
    const count = document.getElementById("social-requests-count");
    if (!list) return;
    if (count) count.textContent = state.requests.length || "none";
    if (!state.requests.length) {
      list.innerHTML = '<div class="social-empty">No pending requests.</div>';
      return;
    }
    list.innerHTML = state.requests.map(row =>
      '<div class="social-item">' +
        '<div class="social-item-body">' +
          '<strong>' + esc(row.requester_name || row.requester_username || ("User " + row.requester_id)) + '</strong>' +
          '<span class="social-item-meta">wants to be friends &middot; ' + esc(relTime(row.created_at)) + '</span>' +
        '</div>' +
        '<div class="social-item-actions">' +
          '<button class="social-btn primary" data-respond="' + row.requester_id + '" data-accept="1" type="button">Accept</button>' +
          '<button class="social-btn" data-respond="' + row.requester_id + '" data-accept="0" type="button">Decline</button>' +
        '</div>' +
      '</div>').join("");
  }

  function renderFriends() {
    const list = document.getElementById("social-friends");
    const count = document.getElementById("social-friends-count");
    if (!list) return;
    if (count) count.textContent = state.friends.length || "none";
    if (!state.friends.length) {
      list.innerHTML = '<div class="social-empty">No friends yet. Add someone by username or email above.</div>';
      return;
    }
    list.innerHTML = state.friends.map(row =>
      '<div class="social-item">' +
        '<div class="social-item-body">' +
          '<strong>' + esc(row.name || row.username || ("User " + row.friend_id)) + '</strong>' +
          '<span class="social-item-meta">friends since ' + esc(relTime(row.updated_at)) + '</span>' +
        '</div>' +
      '</div>').join("");
  }

  function renderFeed() {
    const list = document.getElementById("social-feed");
    const count = document.getElementById("social-feed-count");
    if (!list) return;
    if (count) count.textContent = state.feed.length || "quiet";
    if (!state.feed.length) {
      list.innerHTML = '<div class="social-empty">Nothing published yet, by you or your friends.</div>';
      return;
    }
    list.innerHTML = state.feed.map(post =>
      '<div class="social-item' + (post.is_own ? " own" : "") + '">' +
        '<div class="social-item-body">' +
          '<span class="social-feed-author">' + esc(post.author_name || "Someone") +
            (post.is_own ? ' <em>(you)</em>' : "") + '</span>' +
          '<strong>' + esc(post.title_snapshot || "A task") + '</strong>' +
          (post.caption ? '<p class="social-caption-text">' + esc(post.caption) + '</p>' : "") +
          '<span class="social-item-meta">' + metaLine(post) + ' &middot; ' + esc(relTime(post.published_at)) + '</span>' +
        '</div>' +
        (post.is_own
          ? '<div class="social-item-actions"><button class="social-btn" data-hide="' + post.id + '" type="button">Unpublish</button></div>'
          : "") +
      '</div>').join("");
  }

  function renderGrants() {
    const list = document.getElementById("social-grants");
    const count = document.getElementById("social-grants-count");
    if (!list) return;
    if (count) count.textContent = state.grants.length ? state.grants.length + " with access" : "nobody";
    if (!state.grants.length) {
      list.innerHTML = '<div class="social-empty">Nobody else can act on your day.</div>';
      return;
    }
    list.innerHTML = state.grants.map(g =>
      '<div class="social-item">' +
        '<div class="social-item-body">' +
          '<strong>' + esc(g.name || g.username) + '</strong>' +
          '<span class="social-item-meta">' +
            '<b class="social-role-pill role-' + esc(g.role) + '">' + esc(g.role) + '</b> ' +
            esc(ROLE_BLURB[g.role] || "") +
            (g.note ? ' &middot; ' + esc(g.note) : "") +
          '</span>' +
        '</div>' +
        '<div class="social-item-actions">' +
          '<select data-role-for="' + g.grantee_user_id + '" aria-label="Change role">' +
            ["viewer", "commenter", "coach", "manager"].map(r =>
              '<option value="' + r + '"' + (r === g.role ? " selected" : "") + '>' + r + '</option>').join("") +
          '</select>' +
          '<button class="social-btn" data-revoke="' + g.grantee_user_id + '" type="button">Revoke</button>' +
        '</div>' +
      '</div>').join("");
  }

  function renderGranted() {
    const list = document.getElementById("social-granted");
    const count = document.getElementById("social-granted-count");
    if (!list) return;
    if (count) count.textContent = state.granted.length || "none";
    if (!state.granted.length) {
      list.innerHTML = '<div class="social-empty">Nobody has given you access to their day.</div>';
      return;
    }
    list.innerHTML = state.granted.map(g =>
      '<div class="social-item">' +
        '<div class="social-item-body">' +
          '<strong>' + esc(g.name || g.username) + '</strong>' +
          '<span class="social-item-meta">you are their <b class="social-role-pill role-' + esc(g.role) + '">' + esc(g.role) + '</b></span>' +
        '</div>' +
        '<div class="social-item-actions">' +
          '<button class="social-btn primary" data-open-day="' + g.owner_user_id + '" data-owner-name="' + esc(g.name || g.username) + '" type="button">Open their day</button>' +
        '</div>' +
      '</div>').join("");
  }

  // Nothing else in the app tells you your own username, and a Google-signed-in
  // account never chose one (auth.js derives it from the email). Without this a
  // friend request is a guessing game in both directions.
  function renderMe() {
    const wrap = document.getElementById("social-you");
    const name = document.getElementById("social-you-name");
    if (!wrap || !name) return;
    if (!myUsername) { wrap.hidden = true; return; }
    name.textContent = myUsername;
    wrap.hidden = false;
  }

  async function copyMyUsername() {
    if (!myUsername) return;
    try {
      await navigator.clipboard.writeText(myUsername);
      toast("Username copied", "success");
    } catch (e) {
      // Clipboard is refused on an insecure origin and in some embedded views.
      // Say the name out loud instead of failing silently -- it is short enough
      // to read off a toast and type by hand.
      toast("Copy blocked here. Your username is " + myUsername, "info");
    }
  }

  function renderAll() {
    renderPublishable();
    renderRequests();
    renderFriends();
    renderFeed();
    renderGrants();
    renderGranted();
    renderMe();
    updateBadge();
  }

  // The badge counts things that WANT A DECISION from Drake -- pending friend
  // requests and completions waiting to be published or skipped. It deliberately
  // does not count feed items: somebody else's post is not a task.
  function updateBadge() {
    window.DCC.updateBadge("social-badge", state.requests.length + state.publishable.length);
  }

  // ── data ───────────────────────────────────────────────────────────────────

  async function load() {
    // A refresh asked for MID-FLIGHT is a refresh for data the in-flight read
    // cannot contain, so remember it rather than dropping it. Publishing one item
    // and skipping another in quick succession used to leave the skipped row
    // sitting in the queue until something else triggered a reload.
    if (loading) { reloadQueued = true; return; }
    loading = true;
    try {
      // Independent reads, so one slow or failing panel does not blank the rest.
      // A rejected panel keeps its previous contents rather than throwing the
      // whole tab away.
      const [publishable, requests, friends, feed, grants, granted, me] = await Promise.all([
        api("/api/social/feed/publishable").catch(() => state.publishable),
        api("/api/social/friends/requests").catch(() => state.requests),
        api("/api/social/friends").catch(() => state.friends),
        api("/api/social/feed").catch(() => state.feed),
        api("/api/access/grants").catch(() => state.grants),
        api("/api/access/granted-to-me").catch(() => state.granted),
        // Only on the first open: the handle cannot change under us, so later
        // reloads (publish, respond, revoke) must not pay for it again.
        myUsername ? Promise.resolve({ username: myUsername }) : api("/api/me").catch(() => ({}))
      ]);
      myUsername = (me && me.username) || myUsername;
      state = {
        publishable: publishable || [],
        requests: requests || [],
        friends: friends || [],
        feed: feed || [],
        grants: grants || [],
        granted: granted || []
      };
      renderAll();
    } finally {
      loading = false;
      if (reloadQueued) { reloadQueued = false; load(); }
    }
  }

  async function sendRequest() {
    const input = document.getElementById("social-lookup-input");
    const status = document.getElementById("social-lookup-status");
    const identifier = input ? input.value.trim() : "";
    if (!identifier) {
      if (status) {
        status.className = "social-status error";
        status.textContent = "Enter a username or email.";
      }
      return;
    }
    if (status) { status.textContent = ""; status.className = "social-status"; }
    try {
      // Two steps on purpose: the lookup gives a clear "no such user" before any
      // friendship row is written, so a typo does not create a pending request
      // against nobody.
      const user = await api("/api/social/users/lookup?q=" + encodeURIComponent(identifier));
      await api("/api/social/friends/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addresseeId: user.id })
      });
      if (input) input.value = "";
      if (status) { status.className = "social-status ok"; status.textContent = "Request sent to " + user.username + "."; }
      load();
    } catch (e) {
      if (status) { status.className = "social-status error"; status.textContent = e.message || "Could not send that request"; }
    }
  }

  async function respond(requesterId, accept) {
    try {
      await api("/api/social/friends/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requesterId: Number(requesterId), accept })
      });
      toast(accept ? "Friend added" : "Request declined", accept ? "success" : "info");
      load();
    } catch (e) { toast(e.message || "Could not respond", "error"); }
  }

  async function publish(postId) {
    const field = document.querySelector('[data-caption-for="' + postId + '"]');
    const caption = field ? field.value.trim() : "";
    selectedPosts.delete(String(postId));
    try {
      const result = await api("/api/social/feed/" + encodeURIComponent(postId) + "/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caption: caption || null })
      });
      // published:false means the server refused it, which for this endpoint means
      // the post is locked. Say that rather than showing a success toast for
      // something that did not happen.
      if (result && result.published === false) {
        toast("That one cannot be published (work or private task)", "error");
      } else {
        toast("Published to your friends", "success");
      }
      load();
    } catch (e) { toast(e.message || "Could not publish", "error"); }
  }

  async function hide(postId) {
    selectedPosts.delete(String(postId));
    try {
      await api("/api/social/feed/" + encodeURIComponent(postId) + "/hide", { method: "POST" });
      load();
    } catch (e) { toast(e.message || "Could not hide that", "error"); }
  }

  async function bulkDecision(action) {
    reconcileSelectedPosts();
    const ids = Array.from(selectedPosts);
    if (!ids.length) { toast("Select at least one item", "info"); return; }
    try {
      await Promise.all(ids.map(postId => action === "publish"
        ? api("/api/social/feed/" + encodeURIComponent(postId) + "/publish", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ caption: document.querySelector('[data-caption-for="' + postId + '"]')?.value.trim() || null })
          })
        : api("/api/social/feed/" + encodeURIComponent(postId) + "/hide", { method: "POST" })));
      selectedPosts.clear();
      toast(action === "publish" ? "Published selected items to friends" : "Skipped selected items", "success");
      load();
    } catch (e) { toast(e.message || "Could not update selected items", "error"); }
  }

  // ── access grants ──────────────────────────────────────────────────────────

  async function sendGrant() {
    const nameField = document.getElementById("social-grant-username");
    const roleField = document.getElementById("social-grant-role");
    const noteField = document.getElementById("social-grant-note");
    const status = document.getElementById("social-grant-status");
    const username = nameField ? nameField.value.trim() : "";
    if (status) { status.className = "social-status"; status.textContent = ""; }
    if (!username) {
      if (status) { status.className = "social-status error"; status.textContent = "Enter a username or email."; }
      return;
    }
    const role = roleField ? roleField.value : "viewer";
    // Confirm a WRITE role explicitly. Viewer and commenter are recoverable;
    // coach and manager can change what the owner's work is worth or delete it,
    // and a mistyped username should not hand that to a stranger silently.
    if ((role === "coach" || role === "manager") &&
        !confirm("Give " + username + " " + role + " access? They will be able to " +
                 (role === "manager" ? "edit and delete your tasks." : "adjust your points and assign you tasks."))) {
      return;
    }
    try {
      // Two steps, same as friend requests: the lookup gives a clear "no such
      // user" before any grant row exists, so a typo cannot create access for
      // somebody unintended.
      const user = await api("/api/social/users/lookup?q=" + encodeURIComponent(username));
      const result = await api("/api/access/grants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ granteeUserId: user.id, role: role, note: noteField ? noteField.value.trim() : "" })
      });
      if (nameField) nameField.value = "";
      if (noteField) noteField.value = "";
      if (status) {
        status.className = "social-status ok";
        status.textContent = result.previousRole
          ? user.username + " changed from " + result.previousRole + " to " + role + "."
          : user.username + " now has " + role + " access.";
      }
      load();
    } catch (e) {
      if (status) { status.className = "social-status error"; status.textContent = e.message || "Could not give access"; }
    }
  }

  async function changeRole(granteeUserId, role) {
    const entry = state.grants.find(g => String(g.grantee_user_id) === String(granteeUserId));
    const who = entry ? (entry.name || entry.username) : "this person";
    if ((role === "coach" || role === "manager") && !confirm("Give " + who + " " + role + " access? " + (role === "manager" ? "They can edit and delete tasks." : "They can adjust points and assign tasks."))) return load();
    try {
      // The note is preserved server-side when omitted (see access-store's
      // COALESCE); sending "" here would have erased the owner's own annotation
      // as a side effect of a role change.
      await api("/api/access/grants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ granteeUserId: Number(granteeUserId), role: role })
      });
      toast("Role changed to " + role, "success");
      load();
    } catch (e) { toast(e.message || "Could not change that role", "error"); load(); }
  }

  async function revokeGrant(granteeUserId) {
    const entry = state.grants.find(g => String(g.grantee_user_id) === String(granteeUserId));
    const who = entry ? (entry.name || entry.username) : "this person";
    // Revoking is instant and there is no suspend state, so it is worth one
    // confirm rather than an undo that does not exist.
    if (!confirm("Revoke " + who + "'s access? It stops immediately.")) return;
    try {
      await api("/api/access/grants/" + encodeURIComponent(granteeUserId), { method: "DELETE" });
      toast("Access revoked", "success");
      load();
    } catch (e) { toast(e.message || "Could not revoke that", "error"); }
  }

  // ── the coach day view ─────────────────────────────────────────────────────

  function coachRow(ev) {
    const time = [ev.start, ev.end].filter(Boolean).join("-");
    const points = Number(ev.points) || 0;
    const done = ev.completed || ev.status === "done";
    // Show that a number was already changed by someone other than the owner,
    // so a coach does not read a previous adjustment as the owner's estimate.
    // Only when it actually CHANGED. A no-op adjustment (77 -> 77) rendered
    // "77 pts was 77", which reads like a bug.
    const from = Number(ev.adjustedFrom);
    const adjusted = (ev.adjustedBy && Number.isFinite(from) && from !== points)
      ? ' <em class="coach-adjusted">was ' + from + '</em>' : "";
    // The adjust control appears only when the capability map says so. The server
    // re-checks on every request regardless: this is about not showing a control
    // that would fail, never about being the gate.
    const canAdjust = !!coach.capabilities.adjust_points;
    // _blockId is the durable row id TaskModel.fromBlock stamps; `id` may be a
    // local_id alias. The route accepts either, but prefer the row id.
    const id = ev._blockId || ev.id || "";
    return '<div class="coach-row' + (done ? " done" : "") + '">' +
      '<span class="coach-time">' + esc(time || "--") + '</span>' +
      '<span class="coach-title">' + esc(ev.label || ev.title || "Untitled") + '</span>' +
      '<span class="coach-points">' + (points ? points + ' pts' : '') + adjusted + '</span>' +
      (canAdjust && id
        ? '<span class="coach-adjust">' +
            '<input type="number" min="0" max="100000" value="' + points + '" data-points-for="' + esc(id) + '" aria-label="Points">' +
            '<button class="social-btn" data-save-points="' + esc(id) + '" type="button">Set</button>' +
          '</span>'
        : "") +
    '</div>';
  }

  async function openCoachDay(ownerUserId, name, date, keepMessage) {
    const modal = document.getElementById("coach-day-modal");
    if (!modal) return;
    const token = ++coachRequestId;
    coach.ownerUserId = Number(ownerUserId);
    coach.name = name || "";
    coach.date = date || "";
    modal.hidden = false;
    const status = document.getElementById("coach-day-status");
    const list = document.getElementById("coach-day-list");
    const title = document.getElementById("coach-day-title");
    if (title) title.textContent = coach.name ? coach.name + "'s day" : "Their day";
    // A caller that just finished a write passes its confirmation through, so
    // the reload does not wipe the only feedback the action gave.
    if (status) {
      status.className = keepMessage ? "social-status ok" : "social-status";
      status.textContent = keepMessage || "Loading...";
    }
    if (list) list.innerHTML = "";
    try {
      const base = "/api/coach/" + encodeURIComponent(coach.ownerUserId);
      const [caps, day] = await Promise.all([
        api(base + "/capabilities"),
        api(base + "/day" + (coach.date ? "?date=" + encodeURIComponent(coach.date) : ""))
      ]);
      // A newer open (or a close) superseded this one while it was in flight.
      if (token !== coachRequestId) return;
      coach.capabilities = (caps && caps.capabilities) || {};
      coach.role = (caps && caps.role) || "none";
      coach.date = day.date;
      const roleEl = document.getElementById("coach-day-role");
      const dateEl = document.getElementById("coach-day-date");
      if (roleEl) roleEl.textContent = coach.role;
      if (dateEl) dateEl.textContent = coach.date;
      // `tasks`, not state.schedule.timeline: the timeline is the materialized
      // plan and is empty on a day nobody planned, which showed a coach an empty
      // list while the owner had three tasks.
      const tasks = day.tasks || [];
      if (status && !keepMessage) status.textContent = "";
      if (list) {
        list.innerHTML = tasks.length
          ? tasks.map(coachRow).join("")
          : '<div class="social-empty">Nothing on this day.</div>';
      }
    } catch (e) {
      if (token !== coachRequestId) return;
      // A 403 here means the grant was revoked while the modal was open, which is
      // the expected outcome of an instant revoke rather than a bug. Say that.
      if (status) {
        status.className = "social-status error";
        status.textContent = e.message || "Could not load that day";
      }
      if (list) list.innerHTML = "";
    }
  }

  function shiftCoachDay(days) {
    if (!coach.ownerUserId) return;
    // todayKey(), not toISOString(): the latter is the UTC calendar date, so at
    // 7pm local "Today" opened tomorrow. todayKey prefers the server-derived date
    // and matches getTodayStr's timezone handling.
    const today = window.DCC.dates.todayKey();
    const next = days === 0 ? today : window.DCC.dates.addDays(coach.date || today, days);
    openCoachDay(coach.ownerUserId, coach.name, next);
  }

  async function savePoints(taskId) {
    const field = document.querySelector('[data-points-for="' + taskId + '"]');
    if (!field || !coach.ownerUserId) return;
    const raw = String(field.value || "").trim();
    const points = Number(raw);
    const status = document.getElementById("coach-day-status");
    // Number("") is 0, so clearing the box and pressing Set used to zero the task
    // with full attribution and no way to tell it from a cancel.
    if (raw === "" || !Number.isFinite(points)) {
      if (status) { status.className = "social-status error"; status.textContent = "Enter a number first."; }
      return;
    }
    try {
      const out = await api("/api/coach/" + encodeURIComponent(coach.ownerUserId) +
        "/tasks/" + encodeURIComponent(taskId) + "/points", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: points, reason: "" })
      });
      const message = out.previousPoints === out.points
        ? "Unchanged at " + out.points + " points."
        : "Points changed from " + out.previousPoints + " to " + out.points + ". " +
          coach.name + " can see it was you.";
      openCoachDay(coach.ownerUserId, coach.name, coach.date, message);
    } catch (e) {
      if (status) { status.className = "social-status error"; status.textContent = e.message || "Could not set that"; }
    }
  }

  function closeCoachDay() {
    // Bump the token so a response still in flight cannot repopulate a closed modal.
    coachRequestId++;
    const modal = document.getElementById("coach-day-modal");
    if (modal) modal.hidden = true;
    coach = { ownerUserId: null, name: "", role: "none", date: "", capabilities: {} };
  }

  // ── wiring ─────────────────────────────────────────────────────────────────

  function bind() {
    const send = document.getElementById("social-lookup-send");
    if (send) send.addEventListener("click", sendRequest);
    const input = document.getElementById("social-lookup-input");
    if (input) input.addEventListener("keydown", e => { if (e.key === "Enter") sendRequest(); });
    const copyMe = document.getElementById("social-you-copy");
    if (copyMe) copyMe.addEventListener("click", copyMyUsername);

    const shell = document.getElementById("tab-social");
    if (!shell) return;
    document.getElementById("social-bulk-publish")?.addEventListener("click", () => bulkDecision("publish"));
    document.getElementById("social-bulk-skip")?.addEventListener("click", () => bulkDecision("skip"));
    const grantSend = document.getElementById("social-grant-send");
    if (grantSend) grantSend.addEventListener("click", sendGrant);
    const grantName = document.getElementById("social-grant-username");
    if (grantName) grantName.addEventListener("keydown", e => { if (e.key === "Enter") sendGrant(); });

    const modal = document.getElementById("coach-day-modal");
    if (modal) {
      modal.addEventListener("click", e => {
        if (e.target === modal) return closeCoachDay();
        if (e.target.closest("#coach-day-close")) return closeCoachDay();
        if (e.target.closest("#coach-day-prev")) return shiftCoachDay(-1);
        if (e.target.closest("#coach-day-next")) return shiftCoachDay(1);
        if (e.target.closest("#coach-day-today")) return shiftCoachDay(0);
        const save = e.target.closest("[data-save-points]");
        if (save) return savePoints(save.dataset.savePoints);
      });
    }

    shell.addEventListener("change", e => {
      const selection = e.target.closest("[data-social-select]");
      if (selection) {
        if (selection.checked) selectedPosts.add(selection.dataset.socialSelect);
        else selectedPosts.delete(selection.dataset.socialSelect);
        return;
      }
      const roleSelect = e.target.closest("[data-role-for]");
      if (roleSelect) changeRole(roleSelect.dataset.roleFor, roleSelect.value);
    });

    shell.addEventListener("click", e => {
      const sectionTab = e.target.closest("[data-social-tab]");
      if (sectionTab) {
        shell.querySelector(".social-grid").dataset.socialActive = sectionTab.dataset.socialTab;
        shell.querySelectorAll("[data-social-tab]").forEach(button => button.classList.toggle("active", button === sectionTab));
        return;
      }
      if (e.target.closest("[data-social-open-share]")) return document.getElementById("todo-share-open")?.click();
      if (e.target.closest("[data-social-open-pet]")) return document.getElementById("pet-home-tab-btn")?.click();
      if (e.target.closest("[data-social-refresh-guests]")) return document.getElementById("todo-reactions-toggle")?.click();
      const revokeBtn = e.target.closest("[data-revoke]");
      if (revokeBtn) return revokeGrant(revokeBtn.dataset.revoke);
      const openDay = e.target.closest("[data-open-day]");
      if (openDay) return openCoachDay(openDay.dataset.openDay, openDay.dataset.ownerName);
      const respondBtn = e.target.closest("[data-respond]");
      if (respondBtn) return respond(respondBtn.dataset.respond, respondBtn.dataset.accept === "1");
      const publishBtn = e.target.closest("[data-publish]");
      if (publishBtn) return publish(publishBtn.dataset.publish);
      const hideBtn = e.target.closest("[data-hide]");
      if (hideBtn) return hide(hideBtn.dataset.hide);
    });
  }

  // Boot only fetches what the badge COUNTS. The full load() also pulls the feed
  // (the heaviest of the four: feed_posts joined to users and user_profiles under
  // a friendships subquery) and the friends list, neither of which the badge
  // reads, on every single page load.
  async function loadBadge() {
    const [publishable, requests] = await Promise.all([
      api("/api/social/feed/publishable").catch(() => state.publishable),
      api("/api/social/friends/requests").catch(() => state.requests)
    ]);
    state.publishable = publishable || [];
    state.requests = requests || [];
    updateBadge();
  }

  document.addEventListener("DOMContentLoaded", () => {
    bind();
    // Silent on failure: an unreachable social read must not break the dashboard.
    loadBadge().catch(() => {});
  });

  if (window.DCC && DCC.tabs) DCC.tabs.register("social", () => load().catch(() => {}));
  window.DCCSocial = { load, render: renderAll };
})();
