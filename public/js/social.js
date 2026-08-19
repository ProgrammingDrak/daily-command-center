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

  let state = { publishable: [], requests: [], friends: [], feed: [] };
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

  // ── renderers ──────────────────────────────────────────────────────────────

  function renderPublishable() {
    const list = document.getElementById("social-publishable");
    const count = document.getElementById("social-publishable-count");
    if (!list) return;
    if (count) count.textContent = state.publishable.length ? state.publishable.length + " waiting" : "nothing waiting";
    if (!state.publishable.length) {
      list.innerHTML = '<div class="social-empty">Finish a task and it shows up here, private, until you publish it.</div>';
      return;
    }
    list.innerHTML = state.publishable.map(post =>
      '<div class="social-item">' +
        '<div class="social-item-body">' +
          '<strong>' + esc(post.title_snapshot || "A task") + '</strong>' +
          '<span class="social-item-meta">' + metaLine(post) + '</span>' +
          '<input class="social-caption" data-caption-for="' + post.id + '" type="text" maxlength="280" placeholder="Say something about it (optional)">' +
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
      list.innerHTML = '<div class="social-empty">No friends yet. Add someone by username above.</div>';
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

  function renderAll() {
    renderPublishable();
    renderRequests();
    renderFriends();
    renderFeed();
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
      const [publishable, requests, friends, feed] = await Promise.all([
        api("/api/social/feed/publishable").catch(() => state.publishable),
        api("/api/social/friends/requests").catch(() => state.requests),
        api("/api/social/friends").catch(() => state.friends),
        api("/api/social/feed").catch(() => state.feed)
      ]);
      state = {
        publishable: publishable || [],
        requests: requests || [],
        friends: friends || [],
        feed: feed || []
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
    const username = input ? input.value.trim() : "";
    if (!username) return;
    if (status) { status.textContent = ""; status.className = "social-status"; }
    try {
      // Two steps on purpose: the lookup gives a clear "no such user" before any
      // friendship row is written, so a typo does not create a pending request
      // against nobody.
      const user = await api("/api/social/users/lookup?username=" + encodeURIComponent(username));
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
    try {
      await api("/api/social/feed/" + encodeURIComponent(postId) + "/hide", { method: "POST" });
      load();
    } catch (e) { toast(e.message || "Could not hide that", "error"); }
  }

  // ── wiring ─────────────────────────────────────────────────────────────────

  function bind() {
    const send = document.getElementById("social-lookup-send");
    if (send) send.addEventListener("click", sendRequest);
    const input = document.getElementById("social-lookup-input");
    if (input) input.addEventListener("keydown", e => { if (e.key === "Enter") sendRequest(); });

    const shell = document.getElementById("tab-social");
    if (!shell) return;
    shell.addEventListener("click", e => {
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
