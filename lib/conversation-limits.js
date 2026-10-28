// Bounded per-process protection before session/database work. Shared edge limits
// remain necessary for a multi-replica deployment; identity headers are never keys.
function createBudget({ limit, windowMs = 60000, maxKeys = 4096, now = Date.now }) {
  const buckets = new Map();
  return (key) => {
    const time = now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= time) {
      if (buckets.size >= maxKeys) {
        for (const [id, value] of buckets) if (value.until <= time) buckets.delete(id);
        if (!buckets.has(key) && buckets.size >= maxKeys) return false;
      }
      bucket = { count: 0, until: time + windowMs };
      buckets.set(key, bucket);
    }
    return ++bucket.count <= limit;
  };
}
const consumed = Symbol("conversation-ingress");
const paths = new Set([
  "/mcp/dcc",
  "/oauth/dcc/authorize",
  "/oauth/dcc/token",
  "/connections/conversation",
  "/connections/conversation/revoke",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp/dcc"
]);
const limited = (res) =>
  res.status(429).set("Retry-After", "60").set("Cache-Control", "no-store").json({ error: "rate_limited" });
function createIngress(options = {}) {
  const global = createBudget({ limit: 1200, maxKeys: 1, ...options.global });
  const peer = createBudget({ limit: 180, ...options.peer });
  return (req, res, next) => {
    if (!paths.has(String(req.path).toLowerCase().replace(/\/+$/, "")) || req[consumed]) return next();
    req[consumed] = true;
    if (!global("all") || !peer(req.ip || req.socket?.remoteAddress || "unknown")) return limited(res);
    next();
  };
}
module.exports = { createBudget, createIngress, limited };
