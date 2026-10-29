// Read-only ingress check. Does not log in, send tokens, grant access, create a
// plugin, or claim that an assistant lifecycle hook is installed.
const RESOURCE_PATH = "/.well-known/oauth-protected-resource/mcp/dcc";
async function checkConversationReadiness(baseUrl, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/")
    throw new Error("Provide the canonical public HTTPS origin without credentials, query or path");
  const origin = base.origin,
    resource = origin + "/mcp/dcc";
  const paths = ["/api/health", RESOURCE_PATH, "/.well-known/oauth-authorization-server", "/mcp/dcc"];
  const results = await Promise.all(
    paths.map(async (path) => {
      try {
        const response = await fetchImpl(origin + path, {
          redirect: "manual",
          headers: { Accept: "application/json" },
          signal: globalThis.AbortSignal.timeout(timeoutMs)
        });
        const json = (response.headers.get("content-type") || "").includes("application/json")
          ? await response.json()
          : null;
        return { path, status: response.status, json, challenge: response.headers.get("www-authenticate") || "" };
      } catch {
        return { path, status: null, json: null, challenge: "" };
      }
    })
  );
  const [health, metadata, auth, mcp] = results;
  const checks = {
    healthy: health.status === 200 && health.json?.status === "ok",
    protectedResource:
      metadata.status === 200 &&
      metadata.json?.resource === resource &&
      metadata.json?.authorization_servers?.includes(origin),
    authorizationServer:
      auth.status === 200 &&
      auth.json?.issuer === origin &&
      auth.json?.authorization_endpoint === origin + "/oauth/dcc/authorize" &&
      auth.json?.token_endpoint === origin + "/oauth/dcc/token" &&
      auth.json?.code_challenge_methods_supported?.includes("S256") &&
      auth.json?.token_endpoint_auth_methods_supported?.includes("none"),
    unauthenticatedChallenge:
      mcp.status === 401 && mcp.challenge.includes('resource_metadata="' + origin + RESOURCE_PATH + '"')
  };
  return {
    status: Object.values(checks).every(Boolean) ? "ingress_ready" : "setup_required",
    origin,
    revision:
      typeof health.json?.revision === "string" && /^[a-f0-9]{7,40}$/.test(health.json.revision)
        ? health.json.revision
        : null,
    checks: Object.fromEntries(Object.entries(checks).map(([key, value]) => [key, Boolean(value)])),
    endpoints: results.map(({ path, status, json }) => ({
      path,
      status,
      ...(json?.error === "conversation_remote_disabled"
        ? { reason: "remote_disabled" }
        : status >= 300 && status < 400
          ? { reason: "redirect_instead_of_protocol_response" }
          : {})
    })),
    accountConnection: "not_verified",
    assistantLifecycleHook: "not_verified"
  };
}
if (require.main === module) {
  checkConversationReadiness(process.argv[2])
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.status === "ingress_ready" ? 0 : 1;
    })
    .catch(() => {
      console.error("Readiness check could not run: provide a valid public HTTPS origin.");
      process.exitCode = 1;
    });
}
module.exports = { checkConversationReadiness };
