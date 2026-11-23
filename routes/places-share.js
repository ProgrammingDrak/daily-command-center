const { randomUUID } = require("node:crypto");
const multer = require("multer");
const { fail } = require("../lib/places-model");
const { validateFile, MAX_BYTES } = require("../lib/task-attachment-policy");

function sourceUrl(value) {
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2048) return url.href;
  } catch {}
  return "";
}

function mountShare(app, ctx, store) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 3, fieldSize: 10000, parts: 5 } }).single("media");
  let active = 0;
  const busy = new Set();
  // The installed PWA keeps its existing Vault share target. A signed-in
  // workspace opts in to receiving new shares in Places on this device.
  app.post("/api/vault/share", async (req, res, next) => {
    const userId = Number(req.session?.userId);
    const workspaceId = req.workspaceId;
    const identity = userId + ":" + workspaceId;
    if (!userId || !workspaceId || req.session.placesShareOwner !== identity) return next();
    if (req.get("sec-fetch-site") === "cross-site" || (req.get("origin") && req.get("origin") !== req.protocol + "://" + req.get("host")))
      return res.status(403).send("Use the installed DCC share action");
    if (busy.has(identity) || active >= 8) return res.status(429).send("A Places share is already in progress. Try again.");
    busy.add(identity);
    active++;
    let redirect = "/places?share=failed";
    try {
      const actor = { userId, workspaceId };
      await store.authorize(actor);
      await new Promise((resolve, reject) => upload(req, res, error => error ? reject(error) : resolve()));
      const originalText = String(req.body?.text || "").trim().slice(0, 5000);
      const title = String(req.body?.title || "").trim().slice(0, 160);
      const url = sourceUrl(req.body?.url) || sourceUrl(originalText);
      if (!title && !originalText && !url && !req.file) throw fail("No shared content");
      const value = { name: title || (url ? "Discovery from " + new URL(url).hostname.slice(0, 120) : originalText.slice(0, 160) || "Shared screenshot"),
        originalText, sources: url ? [{ kind: "discovery", url }] : [] };
      const id = randomUUID();
      await store.mutate(actor, randomUUID(), { action: "place-create", id, value });
      redirect = "/places?place=" + id;
      if (req.file) {
        try {
          const provider = ctx.taskAttachmentStore || require("../task-attachment-store").createStore({
            pool: ctx.pool, storage: require("../lib/task-attachment-storage").createStorage()
          });
          if (!provider.configured) throw fail("Files unavailable", 503);
          const metadata = validateFile(req.file);
          const fileActor = { ...actor, placeId: id };
          const parent = await provider.placeParent(fileActor, true);
          await provider.upload(fileActor, parent, randomUUID(), metadata, req.file.buffer);
        } catch { redirect += "&share=image-failed"; }
      }
    } catch {
      // The share payload is private. Report the supported recoverable path
      // through the view without logging its source or uploaded contents.
    } finally {
      busy.delete(identity);
      active--;
    }
    res.redirect(303, redirect);
  });
}

module.exports = { mountShare, sourceUrl };
