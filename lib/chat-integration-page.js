const P = require("./chat-permissions");
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
function choices(granted, allowed = P.scopes) {
  return (
    '<fieldset class="connection-permissions"><legend>Permissions</legend><button type="button" class="connection-text-button" data-select-all>Full control for all available categories</button>' +
    P.categories
      .filter((c) => allowed.includes(c.read))
      .map((c) => {
        const selected = P.level(granted, c.id);
        return (
          '<div class="connection-permission"><div id="permission-' +
          c.id +
          '"><strong>' +
          esc(c.label) +
          "</strong><small>" +
          esc(c.description) +
          '</small></div><div class="connection-levels" role="radiogroup" aria-labelledby="permission-' +
          c.id +
          '">' +
          [
            ["off", "Off"],
            ["read", "Read only"],
            ["write", "Full control"]
          ]
            .filter(([level]) => level !== "write" || allowed.includes(c.write))
            .map(
              ([level, label]) =>
                '<label><input type="radio" name="' +
                c.id +
                '" value="' +
                level +
                '"' +
                (selected === level ? " checked" : "") +
                "><span>" +
                label +
                "</span></label>"
            )
            .join("") +
          "</div></div>"
        );
      })
      .join("") +
    "</fieldset>"
  );
}
function layout(body, title = "Connect to DCC") {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    esc(title) +
    ' · DCC</title><link rel="stylesheet" href="/public/css/tokens.css"><link rel="stylesheet" href="/public/css/chat-integrations.css"><script src="/public/js/chat-integrations.js" defer></script></head><body class="dcc-connection-consent"><main class="connections-consent"><a href="/" class="connection-brand"><b>DCC</b> DAILY COMMAND CENTER</a><h1>' +
    esc(title) +
    "</h1>" +
    body +
    "</main></body></html>"
  );
}
function consent({ request, csrf, granted, account, workspace }) {
  const old = request.scopes.filter((s) => P.legacy.includes(s));
  return layout(
    '<p class="connection-intro">Choose what ' +
      esc(request.clientName) +
      ' can do in your DCC account.</p><p class="connection-footnote">Signed in as <strong>' +
      esc(account) +
      "</strong> · Workspace " +
      esc(workspace) +
      '</p><form method="post" action="/oauth/dcc/authorize"><input type="hidden" name="csrf" value="' +
      esc(csrf) +
      '">' +
      choices(granted, request.scopes) +
      (old.length
        ? '<fieldset class="connection-legacy"><legend>Permissions requested by this connection</legend>' +
          old
            .map(
              (s) =>
                '<label class="connection-legacy"><input type="checkbox" name="legacy" value="' +
                esc(s) +
                '"' +
                (granted.includes(s) ? " checked" : "") +
                "> " +
                esc(P.legacyDescriptions[s] || s) +
                "</label>"
            )
            .join("") +
          "</fieldset>"
        : "") +
      '<div class="connection-actions"><button class="connection-button is-primary" name="decision" value="allow">Allow selected access</button><button class="connection-button" name="decision" value="deny">Cancel</button></div></form><p class="connection-footnote">You can change access or disconnect any time in <a href="/?settings=connections&amp;connection=chatgpt">DCC Connections</a>.</p>',
    "Connect " + request.clientName
  );
}
module.exports = { esc, choices, layout, consent };
