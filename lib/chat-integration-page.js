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
function approval({review,account,workspace,csrf}) {
  const p=review.payload;
  let title,body;
  if(review.operation==='dcc_bulk_cleanup') {
    title=p.action==='undo'?'Restore selected tasks':'Delete selected tasks';
    body='<p>'+review.manifest.cleanup.length+' selected tasks and routines.</p><ul>'+review.manifest.cleanup.map(item=>'<li>'+esc(item.title||'Untitled task')+(item.definition?' · routine':'')+'</li>').join('')+'</ul>';
  }else if(review.operation==='dcc_organization') {
    title='Import tasks';
    const manifest=p.input?.manifest;
    body='<p>Project: <strong>'+esc(manifest?.project?.name||'Imported project')+'</strong></p><ul>'+(manifest?.items||[]).map(item=>'<li>'+esc(item.title)+(item.owner?' · '+esc(item.owner):'')+'</li>').join('')+'</ul>';
  }else {
    title='Correct recorded time';
    const named=id=>review.manifest.records.find(row=>row.id===id)?.title||'Selected task';
    body='<p>'+esc(p.reason||'Review the proposed time allocation.')+'</p><ul>'+(p.parts||[]).map(part=>'<li>'+esc(part.kind==='unknown'?'Unknown activity':part.taskId?named(part.taskId):part.kind)+'<br>'+esc(part.start)+' → '+esc(part.end)+'</li>').join('')+'</ul>';
  }
  const controls=review.status==='pending'?'<form method="post"><input type="hidden" name="csrf" value="'+esc(csrf)+'"><div class="connection-actions"><button class="connection-button is-primary" name="decision" value="approve">Approve exact change</button><button class="connection-button" name="decision" value="deny">Decline</button></div></form>':'<p>Status: '+esc(review.status)+'</p>';
  return layout('<p class="connection-intro">Account: <strong>'+esc(account)+'</strong> · '+esc(workspace)+'</p>'+body+'<p class="connection-footnote">Review expires '+esc(new Date(review.expires_at).toLocaleString())+'. If your records change before approval, request a fresh review.</p>'+controls,title);
}
module.exports = { esc, choices, layout, consent, approval };
