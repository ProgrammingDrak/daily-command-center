// setup-wizards.js — the two OPTIONAL power-ups, each its own flow.
//
// Deliberately two separate wizards rather than one settings panel, because the
// two are not the same kind of setup and pretending otherwise over-promises:
//
//   SLACK REACTIONS  server-side state (a row in slack_identities). This wizard
//                    can actually finish and verify it, in the browser, now.
//   AI TRIAGE        state on the person's OWN machine (a Claude plugin plus a
//                    credential file). The server can report the one prerequisite
//                    it owns (does this account support session login) and can
//                    confirm afterwards that something authenticated as them from
//                    outside a browser. It cannot perform the install. So this is
//                    a guided checklist with a verification handshake, and its
//                    button says "Walk me through it", not "Set up".
//
// Neither is ever required and neither blocks the itinerary. Progress lives in
// users.onboarding_state.setup so a half-finished flow says Resume, and both are
// reachable forever from Settings, not just from the tour.
(function () {
  "use strict";
  const DCC = (window.DCC = window.DCC || {});
  const esc = (v) => (DCC.esc ? DCC.esc(v) : String(v == null ? "" : v)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));

  async function loadStatus() {
    const res = await fetch("/api/me/integrations");
    if (!res.ok) throw new Error("Could not read setup status (" + res.status + ")");
    return res.json();
  }

  // Merges into onboarding_state.setup. PATCH /api/me/onboarding spreads unknown
  // top-level keys, so `setup` rides along without a server change.
  async function saveSetup(patch) {
    try {
      const current = await loadStatus();
      await fetch("/api/me/onboarding", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setup: Object.assign({}, current.setup || {}, patch) }),
      });
    } catch (e) { /* progress tracking is cosmetic; never block the flow on it */ }
  }

  function stamp(flow, field) {
    const patch = {};
    patch[flow] = Object.assign({}, { [field]: new Date().toISOString() });
    return saveSetup(patch);
  }

  function row(label, value, ok) {
    return '<div class="dcc-sw-check">'
      + '<span class="dcc-sw-dot ' + (ok ? "ok" : "no") + '">' + (ok ? "✓" : "•") + "</span>"
      + '<span class="dcc-sw-check-label">' + esc(label) + "</span>"
      + '<span class="dcc-sw-check-val">' + esc(value) + "</span>"
      + "</div>";
  }

  // The Copy button gets its own row rather than floating over the <pre>. These
  // commands are longer than the modal is wide, so an overlaid button sat on top
  // of the text as soon as the block scrolled.
  function codeBlock(text, id, label) {
    return '<div class="dcc-sw-code-wrap">'
      + '<div class="dcc-sw-code-bar">'
        + '<span class="dcc-sw-code-label">' + esc(label || "run on your machine") + "</span>"
        + '<button class="dcc-sw-copy" type="button" data-copy="' + id + '">Copy</button>'
      + "</div>"
      + '<pre class="dcc-sw-code" id="' + id + '">' + esc(text) + "</pre>"
      + "</div>";
  }

  function wireCopy(root) {
    root.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const pre = root.querySelector("#" + btn.getAttribute("data-copy"));
        if (!pre) return;
        try {
          await navigator.clipboard.writeText(pre.textContent);
          const was = btn.textContent;
          btn.textContent = "Copied";
          setTimeout(() => { btn.textContent = was; }, 1400);
        } catch (e) {
          const range = document.createRange();
          range.selectNodeContents(pre);
          const sel = window.getSelection();
          sel.removeAllRanges(); sel.addRange(range);
        }
      });
    });
  }

  // ── Slack reactions ───────────────────────────────────────────────────────
  function openSlack() {
    const body = document.createElement("div");
    body.className = "dcc-sw";
    body.innerHTML = '<div class="dcc-sw-loading">Checking this server…</div>';
    const handle = DCC.modal({ title: "Slack task reactions", body });
    stamp("slack", "startedAt");

    async function render() {
      let data;
      try { data = await loadStatus(); }
      catch (e) {
        body.innerHTML = '<p class="dcc-sw-p">' + esc(e.message) + "</p>";
        return;
      }
      const slack = data.slack || {};

      // 1. Something only an admin can fix.
      if (!slack.sharedBot) {
        body.innerHTML = '<p class="dcc-sw-p">This server has no shared Slack bot configured yet, so reactions cannot reach the DCC at all.</p>'
          + row("Shared bot token", "missing", false)
          + '<p class="dcc-sw-note">An admin needs to set <code>SLACK_BOT_TOKEN</code> and <code>SLACK_TEAM_ALLOWLIST</code>, then invite the bot to the channels people use. There is nothing for you to do here yet.</p>';
        return;
      }
      if (!slack.autoLink) {
        body.innerHTML = '<p class="dcc-sw-p">The bot is here, but your Slack workspace is not on the allowlist, so it will not link accounts.</p>'
          + row("Shared bot token", "present", true)
          + row("Workspace allowlisted", "no", false)
          + '<p class="dcc-sw-note">Ask an admin to add your Slack team ID to <code>SLACK_TEAM_ALLOWLIST</code>.</p>';
        return;
      }

      // 3. Already linked: show it and let them test or unlink.
      if (slack.connected) {
        body.innerHTML = '<p class="dcc-sw-p"><strong>You are linked.</strong> React 🔖 to any Slack message in a channel the bot is in and it lands on your itinerary.</p>'
          + row("Shared bot", "ready", true)
          + row("Your Slack account", slack.slackUserId || "linked", true)
          + row("Coverage", slack.tier === "user" ? "channels, DMs and private channels" : "channels the bot is in", true)
          + '<div class="dcc-sw-emoji">🔖 bookmark → task &nbsp;·&nbsp; ⌛ hourglass → start timing &nbsp;·&nbsp; ✅ check → done + points</div>'
          + '<p class="dcc-sw-note">Removing a reaction reverses it, points included.</p>'
          + '<div class="dcc-sw-actions"><button class="dcc-sw-btn" id="dcc-sw-unlink" type="button">Unlink this Slack account</button></div>';
        stamp("slack", "completedAt");
        const unlink = body.querySelector("#dcc-sw-unlink");
        if (unlink) unlink.addEventListener("click", async () => {
          unlink.disabled = true;
          await fetch("/api/me/slack/claim", { method: "DELETE" });
          render();
        });
        return;
      }

      // 2b. A claim is recorded and waiting for its proof.
      if (slack.pending) {
        body.innerHTML = '<p class="dcc-sw-p">Claim recorded for <strong>' + esc(slack.slackUserId) + "</strong>. It stays inactive until a reaction actually arrives from that account, which is how we prove it is yours.</p>"
          + '<p class="dcc-sw-p"><strong>React 🔖 to any Slack message now</strong>, in a channel the bot is in. Then check below.</p>'
          + '<div class="dcc-sw-actions">'
            + '<button class="dcc-sw-btn dcc-sw-btn--primary" id="dcc-sw-check" type="button">Check now</button>'
            + '<button class="dcc-sw-btn" id="dcc-sw-cancel-claim" type="button">Cancel claim</button>'
          + "</div>"
          + '<div class="dcc-sw-status" id="dcc-sw-status"></div>';
        wireCheck(body, render);
        const cancel = body.querySelector("#dcc-sw-cancel-claim");
        if (cancel) cancel.addEventListener("click", async () => {
          cancel.disabled = true;
          await fetch("/api/me/slack/claim", { method: "DELETE" });
          render();
        });
        return;
      }

      // 2a. Not linked yet. Auto-link needs nothing but a reaction; the manual
      // claim is the fallback for an account with no email to match on.
      body.innerHTML = '<p class="dcc-sw-p">Nothing to install. <strong>React 🔖 to any Slack message</strong> in a channel the DCC bot is in, and we match your Slack email to this account automatically.</p>'
        + row("Shared bot", "ready", true)
        + row("Your workspace", "allowlisted", true)
        + row("Your Slack account", "not linked yet", false)
        + '<div class="dcc-sw-actions"><button class="dcc-sw-btn dcc-sw-btn--primary" id="dcc-sw-check" type="button">I reacted, check now</button></div>'
        + '<div class="dcc-sw-status" id="dcc-sw-status"></div>'
        + '<details class="dcc-sw-details"><summary>It did not link me</summary>'
          + '<p class="dcc-sw-note">That usually means this DCC account has no email address for us to match on. Paste your Slack member ID instead: in Slack, click your avatar, then <em>Profile</em>, then the ⋯ menu, then <em>Copy member ID</em>.</p>'
          + '<div class="dcc-sw-inline"><input class="dcc-sw-input" id="dcc-sw-uid" placeholder="U01234ABCDE" autocomplete="off" spellcheck="false" />'
          + '<button class="dcc-sw-btn" id="dcc-sw-claim" type="button">Claim</button></div>'
          + '<div class="dcc-sw-status" id="dcc-sw-claim-status"></div>'
        + "</details>";
      wireCheck(body, render);
      const claimBtn = body.querySelector("#dcc-sw-claim");
      if (claimBtn) claimBtn.addEventListener("click", async () => {
        const input = body.querySelector("#dcc-sw-uid");
        const out = body.querySelector("#dcc-sw-claim-status");
        const value = (input.value || "").trim();
        if (!value) { out.textContent = "Enter your Slack member ID first."; out.className = "dcc-sw-status warn"; return; }
        claimBtn.disabled = true;
        try {
          const res = await fetch("/api/me/slack/claim", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ slackUserId: value }),
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok) { out.textContent = json.error || "Could not record that claim."; out.className = "dcc-sw-status warn"; claimBtn.disabled = false; return; }
          render();
        } catch (e) {
          out.textContent = e.message; out.className = "dcc-sw-status warn"; claimBtn.disabled = false;
        }
      });
    }

    function wireCheck(root, again) {
      const btn = root.querySelector("#dcc-sw-check");
      if (!btn) return;
      btn.addEventListener("click", async () => {
        const out = root.querySelector("#dcc-sw-status");
        btn.disabled = true;
        if (out) { out.textContent = "Checking…"; out.className = "dcc-sw-status"; }
        try {
          const data = await loadStatus();
          if (data.slack && data.slack.connected) return again();
          if (out) {
            out.textContent = data.slack && data.slack.pending
              ? "Still waiting for a reaction from that account."
              : "No link yet. Make sure the bot is in the channel you reacted in.";
            out.className = "dcc-sw-status warn";
          }
        } catch (e) {
          if (out) { out.textContent = e.message; out.className = "dcc-sw-status warn"; }
        }
        btn.disabled = false;
      });
    }

    render();
    return handle;
  }

  // ── AI triage ─────────────────────────────────────────────────────────────
  function openTriage() {
    const body = document.createElement("div");
    body.className = "dcc-sw";
    body.innerHTML = '<div class="dcc-sw-loading">Checking this account…</div>';
    const handle = DCC.modal({ title: "AI triage", body });
    stamp("triage", "startedAt");

    async function render() {
      let data;
      try { data = await loadStatus(); }
      catch (e) { body.innerHTML = '<p class="dcc-sw-p">' + esc(e.message) + "</p>"; return; }
      const t = data.triage || {};
      const done = !!t.lastSeenAt;
      const loginCmd = "python3 ~/portable-programming/claude-brain/scripts/dcc_client.py login \\\n"
        + "  --name " + (t.username || "me") + " \\\n"
        + "  --base-url " + (t.baseUrl || window.location.origin) + " \\\n"
        + "  --username " + (t.username || "<your-dcc-username>") + " \\\n"
        + "  --password '<your-dcc-password>'";
      const whoamiCmd = "python3 ~/portable-programming/claude-brain/scripts/dcc_client.py whoami";

      body.innerHTML =
        '<p class="dcc-sw-p">This one runs in <strong>your own Claude</strong>, not in the DCC. It sweeps your email, Slack and calendar, drafts replies for your approval, and files the results onto your itinerary. Nothing sends without you saying so.</p>'
        + '<p class="dcc-sw-note">Because it runs on your machine, the DCC cannot install it for you. These are the three things to do, and the last step here confirms it worked.</p>'

        + '<div class="dcc-sw-step"><span class="dcc-sw-num">1</span><div>'
          + "<strong>Can this account be automated?</strong>"
          + row("Session login available", t.hasPassword ? "yes" : "no", !!t.hasPassword)
          + (t.hasPassword
            ? '<p class="dcc-sw-note">Good. The skill logs in as you, so everything it writes is scoped to your workspace.</p>'
            : '<p class="dcc-sw-note dcc-sw-warn">This account signs in with '
              + esc(t.authProvider || "an identity provider")
              + ", so it has no password and <code>dcc_client.py login</code> will return 401. Ask an admin to add a password for automation before doing the rest.</p>")
        + "</div></div>"

        + '<div class="dcc-sw-step"><span class="dcc-sw-num">2</span><div>'
          + "<strong>Install the skill bundle in Claude</strong>"
          + '<p class="dcc-sw-note">Whoever shared the DCC with you sends this as a zip plus an install page. It carries the sweep readers and the task writers. Your data sources (Gmail, Slack, Calendar) are your own connectors inside your Claude, so there is nothing to authorize here.</p>'
        + "</div></div>"

        + '<div class="dcc-sw-step"><span class="dcc-sw-num">3</span><div>'
          + "<strong>Point it at your DCC, once</strong>"
          + '<p class="dcc-sw-note">Run this on your machine. It stores a profile at <code>~/.claude/dcc/profiles.json</code>, mode 0600 and not synced anywhere.</p>'
          + codeBlock(loginCmd, "dcc-sw-cmd-login", "store your DCC profile")
          + '<p class="dcc-sw-note">Then confirm you are pointed at your own account, not somebody else\'s:</p>'
          + codeBlock(whoamiCmd, "dcc-sw-cmd-whoami", "confirm the target account")
        + "</div></div>"

        + '<div class="dcc-sw-step"><span class="dcc-sw-num">4</span><div>'
          + "<strong>Confirm it reached us</strong>"
          + (done
            ? row("Your Claude has authenticated as you", new Date(t.lastSeenAt).toLocaleString(), true)
            : '<p class="dcc-sw-note">After the login command runs, check here. We look for a non-browser client signing in as you.</p>'
              + '<div class="dcc-sw-actions"><button class="dcc-sw-btn dcc-sw-btn--primary" id="dcc-sw-tcheck" type="button">Check now</button></div>'
              + '<div class="dcc-sw-status" id="dcc-sw-tstatus"></div>')
        + "</div></div>";

      wireCopy(body);
      if (done) stamp("triage", "completedAt");
      const btn = body.querySelector("#dcc-sw-tcheck");
      if (btn) btn.addEventListener("click", async () => {
        const out = body.querySelector("#dcc-sw-tstatus");
        btn.disabled = true;
        out.textContent = "Checking…"; out.className = "dcc-sw-status";
        try {
          const fresh = await loadStatus();
          if (fresh.triage && fresh.triage.lastSeenAt) return render();
          out.textContent = "Nothing yet. Run the login command, then check again.";
          out.className = "dcc-sw-status warn";
        } catch (e) {
          out.textContent = e.message; out.className = "dcc-sw-status warn";
        }
        btn.disabled = false;
      });
    }

    render();
    return handle;
  }

  // ── The chooser: two optional power-ups, one at a time ────────────────────
  function cardFor(opts) {
    const state = opts.done ? '<span class="dcc-sw-pill done">✓ Done</span>'
      : opts.started ? '<span class="dcc-sw-pill">Resume</span>'
      : "";
    return '<button class="dcc-sw-card" type="button" data-open="' + opts.key + '">'
      + '<span class="dcc-sw-card-ico">' + opts.icon + "</span>"
      + '<span class="dcc-sw-card-main">'
        + '<span class="dcc-sw-card-title">' + esc(opts.title) + state + "</span>"
        + '<span class="dcc-sw-card-note">' + esc(opts.note) + "</span>"
      + "</span>"
      + '<span class="dcc-sw-card-cta">' + esc(opts.cta) + "</span>"
      + "</button>";
  }

  function openChooser() {
    const body = document.createElement("div");
    body.className = "dcc-sw";
    body.innerHTML = '<div class="dcc-sw-loading">Loading…</div>';
    const handle = DCC.modal({ title: "Optional setup", body });

    (async () => {
      let data = {};
      try { data = await loadStatus(); } catch (e) { /* render the cards anyway */ }
      const setup = data.setup || {};
      const slack = data.slack || {};
      const triage = data.triage || {};
      const google = data.google || {};
      body.innerHTML =
        '<p class="dcc-sw-p">Two power-ups. Both optional, both independent, do one at a time or neither.</p>'
        + cardFor({
          key: "slack", icon: "💬", title: "Slack task reactions",
          note: "React 🔖 on a message and it becomes a task on your day. ⌛ times it, ✅ finishes it.",
          cta: "Set up", done: !!slack.connected, started: !!(setup.slack && setup.slack.startedAt),
        })
        + cardFor({
          key: "triage", icon: "🤖", title: "AI-based triage",
          note: "Your Claude sweeps email, Slack and calendar, then files the results onto your itinerary.",
          cta: "Walk me through it", done: !!triage.lastSeenAt, started: !!(setup.triage && setup.triage.startedAt),
        })
        + '<div class="dcc-sw-hr"></div>'
        + '<div class="dcc-sw-oneclick">'
          + "<span>" + (google.connected ? "📅 Google Calendar is connected" : "📅 Pull your calendar onto the itinerary") + "</span>"
          + (google.connected ? '<span class="dcc-sw-pill done">✓ Done</span>'
            : '<a class="dcc-sw-btn" href="/api/gcal/auth">Connect</a>')
        + "</div>";
      body.querySelectorAll("[data-open]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const key = btn.getAttribute("data-open");
          handle.close();
          if (key === "slack") openSlack(); else openTriage();
        });
      });
    })();

    return handle;
  }

  window.DCCSetup = { openChooser, openSlack, openTriage };

  document.addEventListener("DOMContentLoaded", () => {
    const entry = document.getElementById("dcc-setup-integrations");
    if (entry) entry.addEventListener("click", () => {
      const wrap = document.getElementById("dcc-settings-wrap");
      if (wrap) wrap.classList.remove("open");
      openChooser();
    });
  });
})();
