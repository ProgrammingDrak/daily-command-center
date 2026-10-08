(function () {
  "use strict";
  const account = window.DCC_ACCOUNT_CONTEXT && { ...window.DCC_ACCOUNT_CONTEXT };
  if (!account || !Number.isSafeInteger(account.userId) || !account.workspaceId) return;
  const send = window.fetch.bind(window);
  // Capture, never update, this tab's principal. Also covers legacy direct fetch
  // call sites, keepalive note writes, and the normal shared DCC.api helper.
  window.fetch = function (input, init) {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) return send(input, init);
    const headers = new Headers(init?.headers || (typeof input === "object" ? input.headers : undefined));
    headers.set("X-DCC-User", String(account.userId));
    headers.set("X-DCC-Workspace", account.workspaceId);
    return send(input, { ...init, headers });
  };
})();
