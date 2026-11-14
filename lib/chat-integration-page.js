const P = require("./chat-permissions");
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
function choices(granted, allowed = P.scopes) {
  return `<fieldset class="permissions"><legend>What can the chat control?</legend><button type="button" data-select-all>Full control for all available categories</button>${P.categories
    .map((c) => {
      const value = P.level(granted, c.id);
      return `<label class="permission"><span><strong>${c.label}</strong><small>${c.description}</small></span><select name="${c.id}" aria-label="${c.label}"><option value="off"${value === "off" ? " selected" : ""}>Off</option>${allowed.includes(c.read) ? `<option value="read"${value === "read" ? " selected" : ""}>Read only</option>` : ""}${allowed.includes(c.read) && allowed.includes(c.write) ? `<option value="write"${value === "write" ? " selected" : ""}>Full control</option>` : ""}</select></label>`;
    })
    .join("")}</fieldset>`;
}
function layout(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chat integrations · DCC</title><link rel="stylesheet" href="/public/css/chat-integrations.css"><script src="/public/js/chat-integrations.js" defer></script></head><body><main><a href="/">← Daily Command Center</a><h1>Chat integrations</h1><p class="intro">Connect your chat to DCC. You choose what it can read and control.</p>${body}</main></body></html>`;
}
function form(granted, csrf, action, extra = "", allowed) {
  return `<form method="post" action="${esc(action)}"><input type="hidden" name="csrf" value="${esc(csrf)}">${extra}${choices(granted, allowed)}<p>Full control lets the chat act on your clear instructions, including recoverable deletion and bulk changes. Unclear instructions still need clarification. It does not grant external messaging, permanent history erasure or database access.</p>`;
}
function management({ grants, preferences, csrf, account, workspace, resource, enabled, clientsReady, notice }) {
  return layout(`<p class="account">Signed in as <strong>${esc(account)}</strong> · Workspace <strong>${esc(workspace)}</strong></p>${notice ? `<p role="status">${esc(notice)}</p>` : ""}
    <section><h2>1. Choose access</h2>${form(preferences, csrf, "/connections/conversation/preferences")}<button type="submit">Save connection preferences</button><p>Preferences guide your next authorization; saving them does not grant new access.</p><label>Scopes to request in ChatGPT<textarea readonly data-scopes aria-label="Scopes to request">${esc(preferences.join(" "))}</textarea></label><button type="button" data-copy-scopes>Copy permissions</button><span data-copy-status role="status"></span></form></section>
    <section><h2>2. Connect ChatGPT</h2><p><a href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">Open ChatGPT to connect ↗</a></p><p class="status">${!enabled ? "Setup required: remote integration is disabled." : !clientsReady ? "Setup required: an OAuth client and its exact callback must be registered." : "Awaiting authorization for a new connection."}</p><ol><li>In ChatGPT, add or edit the custom DCC integration using OAuth.</li><li>Use this server URL: <code data-server-url>${esc(resource)}</code> <button type="button" data-copy-server>Copy URL</button></li><li>Request the scopes above. Complete any installation required by ChatGPT.</li><li>Return here through the authorization screen, sign in, review your choices and allow access.</li><li>Ask the chat to check its DCC connection. A successful tool call verifies it.</li></ol><p>ChatGPT may require a public client ID and exact HTTPS callback registration by the DCC operator. No password, shared admin token or client secret belongs in the chat.</p></section>
    <section><h2>3. Connected clients</h2>${
      grants
        .map(
          (g) =>
            `<article><h3>${esc(g.client_id)}</h3><p class="status">${g.revoked_at ? "Disconnected" : g.last_verified_at ? "Verified · last successful call " + esc(g.last_verified_at) : "Authorized · awaiting first successful call"}</p>${
              g.scopes.some((s) => P.legacy.includes(s))
                ? `<p>Legacy access: ${g.scopes
                    .filter((s) => P.legacy.includes(s))
                    .map((s) => esc(P.legacyDescriptions[s] || s))
                    .join(" · ")}. It retains its original authority until you reconnect or disconnect it.</p>`
                : ""
            }${g.revoked_at ? "" : `${form(g.scopes, csrf, "/connections/conversation/permissions", `<input type="hidden" name="grantId" value="${esc(g.id)}">`, g.scopes)}<button type="submit">Apply permission reductions</button><p>Additional access requires a new ChatGPT authorization. Legacy access cannot be expanded here.</p></form><form method="post" action="/connections/conversation/revoke"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="grantId" value="${esc(g.id)}"><button type="submit" class="danger">Disconnect</button></form>`}</article>`
        )
        .join("") || "<p>No connected clients yet.</p>"
    }</section>`);
}
function consent({ request, csrf, granted, account, workspace }) {
  const old = request.scopes.filter((s) => P.legacy.includes(s));
  return layout(
    `<h2>Connect ${esc(request.clientName)}</h2><p>Signed in as <strong>${esc(account)}</strong> · Workspace <strong>${esc(workspace)}</strong></p>${form(granted, csrf, "/oauth/dcc/authorize", "", request.scopes)}${old.length ? `<fieldset><legend>Legacy permissions requested by this client</legend>${old.map((s) => `<label><input type="checkbox" name="legacy" value="${esc(s)}"${granted.includes(s) ? " checked" : ""}> ${esc(P.legacyDescriptions[s] || s)}</label>`).join("")}<p>Legacy dcc.read includes private task notes, queue, timing and activity history. Other legacy scopes retain their existing actions.</p></fieldset>` : ""}<button name="decision" value="allow">Allow selected access</button><button name="decision" value="deny">Cancel</button></form><p>You can reduce access or disconnect at any time on <a href="/connections/conversation">Chat integrations</a>.</p>`
  );
}
module.exports = { esc, choices, layout, management, consent };
