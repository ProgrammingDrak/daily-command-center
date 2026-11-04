// Anonymous shared-link event streams. A ping carries no data, only "changed";
// viewers re-read the filtered projection. Each viewer re-reads a full day per
// ping, so bursts of owner writes collapse into one trailing ping per workspace.
function createPublicSseHub({ maxClients = 100, maxPerWorkspace = 20, debounceMs = 750, heartbeatMs = 25000 } = {}) {
  const clients = new Map();
  const timers = new Map();
  let total = 0;
  let pingId = 0;

  function register(workspaceId, req, res) {
    const workspaceClients = clients.get(workspaceId) || new Set();
    if (total >= maxClients || workspaceClients.size >= maxPerWorkspace) return res.status(429).end();
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    // Viewers refetch on "connected", so every reconnect reconciles missed pings.
    res.write("retry: 3000\ndata: connected\n\n");
    if (!clients.has(workspaceId)) clients.set(workspaceId, workspaceClients);
    workspaceClients.add(res);
    total += 1;
    let registered = true;
    // Comment frames keep proxies from idling the stream out.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);
    heartbeat.unref?.();
    req.on("close", () => {
      clearInterval(heartbeat);
      if (!registered) return;
      registered = false;
      const set = clients.get(workspaceId);
      if (!set) return;
      set.delete(res);
      total = Math.max(0, total - 1);
      if (!set.size) clients.delete(workspaceId);
    });
  }

  function ping(workspaceId) {
    if (!clients.has(workspaceId) || timers.has(workspaceId)) return;
    const timer = setTimeout(() => {
      timers.delete(workspaceId);
      pingId += 1;
      for (const client of clients.get(workspaceId) || []) client.write(`id: ${pingId}\ndata: changed\n\n`);
    }, debounceMs);
    timer.unref?.();
    timers.set(workspaceId, timer);
  }

  function close(workspaceId) {
    clearTimeout(timers.get(workspaceId));
    timers.delete(workspaceId);
    for (const client of clients.get(workspaceId) || []) client.end();
  }

  return { register, ping, close, size: () => total };
}

module.exports = { createPublicSseHub };
