// Anonymous shared-link event streams. A ping carries no data, only "changed";
// viewers re-read the filtered projection. Each viewer re-reads a full day per
// ping, so bursts of owner writes collapse into one trailing ping per workspace.
function createPublicSseHub({ maxClients = 100, maxPerWorkspace = 20, debounceMs = 750, heartbeatMs = 25000, capacityRetryMs = 60000 } = {}) {
  const clients = new Map();
  const timers = new Map();
  let total = 0;
  let pingId = 0;

  function register(workspaceId, req, res) {
    const workspaceClients = clients.get(workspaceId) || new Set();
    const headers = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" };
    if (total >= maxClients || workspaceClients.size >= maxPerWorkspace) {
      // Browsers' EventSource cannot read an HTTP status, so a 429 would look like
      // any other failure. Say "over capacity" as a readable event instead; the
      // browser reconnects after `retry` and the page polls meanwhile.
      res.writeHead(200, headers);
      res.end("retry: " + capacityRetryMs + "\nevent: capacity\ndata: polling\n\n");
      return;
    }
    res.writeHead(200, headers);
    // Viewers refetch on "connected", so every reconnect reconciles missed pings.
    res.write("retry: 3000\ndata: connected\n\n");
    if (!clients.has(workspaceId)) clients.set(workspaceId, workspaceClients);
    workspaceClients.add(res);
    total += 1;
    let registered = true;
    // A named event, not a comment: comment frames never reach page script, so
    // only a real event lets the page notice a silently dead socket.
    const heartbeat = setInterval(() => res.write("event: heartbeat\ndata: " + new Date().toISOString() + "\n\n"), heartbeatMs);
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
    // Revoke or rotate: tell open pages before closing, so they clear at once.
    for (const client of clients.get(workspaceId) || []) client.end("event: revoked\ndata: 1\n\n");
  }

  return { register, ping, close, size: () => total };
}

module.exports = { createPublicSseHub };
