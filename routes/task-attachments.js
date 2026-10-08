const multer = require("multer");
const { MAX_BYTES, UUID, fail, validateFile, disposition } = require("../lib/task-attachment-policy");
module.exports = function mount(app, ctx) {
  const store = ctx.taskAttachmentStore || require("../task-attachment-store").createStore({
    pool: ctx.pool, storage: require("../lib/task-attachment-storage").createStorage(),
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 0, parts: 2 } }).single("file");
  let active = 0;
  const byUser = new Map();
  async function bounded(actor, run) {
    const count = byUser.get(actor.userId) || 0;
    if (active >= 8 || count >= 2) throw fail("Too many file transfers. Retry when the current transfer finishes", 429);
    active++; byUser.set(actor.userId, count + 1);
    try { return await run(); }
    finally { active--; const remaining = byUser.get(actor.userId) - 1; if (remaining) byUser.set(actor.userId, remaining); else byUser.delete(actor.userId); }
  }
  const bases = ["/api/tasks/:blockId/attachments", "/api/notes/:blockId/attachments"];
  function route(run, mutation = false) {
    return async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      try {
        // Only established app sessions. Do not inherit dev/service/header owner fallbacks.
        const userId = Number(req.session?.userId);
        if (!Number.isSafeInteger(userId) || userId < 1 || !req.workspaceId) throw fail("Sign in to access task files", 401);
        if (mutation) {
          const origin = req.headers.origin;
          if (req.headers["x-dcc-attachment"] !== "1" || req.headers["sec-fetch-site"] === "cross-site" ||
            (origin && new URL(origin).origin !== `${req.protocol}://${req.get("host")}`)) throw fail("Use the task file controls in DCC", 403);
        }
        if (!req.params.blockId || req.params.blockId.length > 255 || (req.params.id && !UUID.test(req.params.id))) throw fail("Invalid attachment identity");
        const actor = { userId, workspaceId: req.workspaceId };
        await store.authorize(actor, req.params.blockId); // authorize before buffering multipart bytes
        await run(req, res, actor);
      } catch (error) {
        const code = error.statusCode || (error.code === "LIMIT_FILE_SIZE" ? 413 : error instanceof multer.MulterError ? 400 : 503);
        res.status(code).json({ error: error.statusCode ? error.message : code === 413 ? "Files must be 10 MB or smaller" : code === 400 ? "Upload one file per request" : "Task file service unavailable; retry shortly" });
      }
    };
  }
  for (const base of bases) {
    app.get(base, route(async (req, res, actor) => res.json({ configured: store.configured, files: await store.list(actor, req.params.blockId) })));
    app.post(base, route(async (req, res, actor) => {
      const id = req.headers["x-upload-id"];
      if (typeof id !== "string" || !UUID.test(id)) throw fail("Upload identity required");
      if (!store.configured) throw fail("Private task file storage is not configured", 503);
      await bounded(actor, async () => {
        await new Promise((resolve, reject) => upload(req, res, error => error ? reject(error) : resolve()));
        const meta = validateFile(req.file);
        res.status(201).json(await store.upload(actor, req.params.blockId, id.toLowerCase(), meta, req.file.buffer));
      });
    }, true));
    app.get(base + "/:id/download", route(async (req, res, actor) => {
      const file = await bounded(actor, () => store.download(actor, req.params.blockId, req.params.id.toLowerCase()));
      res.set({ "Content-Type": "application/octet-stream", "Content-Disposition": disposition(file.filename), "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" });
      res.send(file.bytes);
    }));
    app.delete(base + "/:id", route(async (req, res, actor) => { await store.remove(actor, req.params.blockId, req.params.id.toLowerCase()); res.json({ removed: true }); }, true));
    app.post(base + "/:id/restore", route(async (req, res, actor) => { await store.restore(actor, req.params.blockId, req.params.id.toLowerCase()); res.json({ restored: true }); }, true));
  }
};
