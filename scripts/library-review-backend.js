// Explicitly enabled synthetic boundary for the production Library UI.
module.exports = function mountLibraryReview(app, root) {
  const path = require("node:path");
  let counter = 1;
  const notes = new Map(
    ["2026-11-25", "2026-11-24", "2026-11-23"].map((date) => {
      const slug = `journal/2026/${date}`;
      return [
        slug,
        {
          slug,
          frontmatter: { type: "journal", title: date, date },
          body: "A place for today’s thoughts.\n\nKeep text and sketches together.",
          hash: "review-" + counter++
        }
      ];
    })
  );
  const options = { delayMs: 0, nextStatus: 0, writes: 0, owner: "library-review-owner" };
  const initialNotes = JSON.stringify([...notes]);
  app.post("/api/review/library/reset", (_req, res) => {
    notes.clear();
    for (const [slug, note] of JSON.parse(initialNotes)) notes.set(slug, note);
    counter = 4;
    Object.assign(options, { delayMs: 0, nextStatus: 0, writes: 0, owner: "library-review-owner" });
    res.json({ ok: true });
  });
  app.get("/api/me", (_req, res) =>
    res.json({ userId: 1, workspaceId: options.owner, username: "review", role: "admin" })
  );
  app.get("/api/completion-memories", (_req, res) => res.json([]));
  app.get("/api/itinerary-journal-photos", (_req, res) => res.json([]));
  app.get("/api/vault/nodes", (_req, res) => res.json([...notes.values()].map(({ body: _body, ...node }) => node)));
  app.get("/api/vault/node/*", (req, res) => {
    const note = notes.get(req.params[0]);
    if (!note) return res.status(404).json({ error: "not found" });
    res.json(note);
  });
  app.delete("/api/vault/node/*", (req, res) => {
    if (!notes.delete(req.params[0])) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  });
  app.post("/api/vault/daily", (req, res) => {
    const date = req.body.date || "2026-11-25",
      slug = `journal/${date.slice(0, 4)}/${date}`;
    const created = !notes.has(slug);
    if (created)
      notes.set(slug, {
        slug,
        frontmatter: { type: "journal", title: date, date },
        body: "",
        hash: "review-" + counter++
      });
    res.json({ slug, node: notes.get(slug), created });
  });
  app.put("/api/vault/node/*", async (req, res) => {
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (options.nextStatus) {
      const status = options.nextStatus;
      options.nextStatus = 0;
      return res.status(status).json({ error: "Synthetic save rejected" });
    }
    const current = notes.get(req.params[0]);
    if (!current || current.hash !== req.body.expectedHash) return res.status(409).json({ error: "conflict" });
    const next = {
      slug: current.slug,
      frontmatter: req.body.frontmatter,
      body: req.body.body,
      hash: "review-" + counter++
    };
    notes.set(next.slug, next);
    options.writes++;
    res.json(next);
  });
  app.post("/api/vault/notebook-page-ingest", (_req, res) => res.json({ ok: true, hash: "notebook-review" }));
  app.delete("/api/vault/notebook/:notebookId", (req, res) => res.json({ ok: true, removed: false, slug: "notebooks/review" }));
  app.post("/api/review/library/options", (req, res) => {
    options.delayMs = Math.min(5000, Math.max(0, Number(req.body.delayMs) || 0));
    options.nextStatus = [0, 409, 503].includes(req.body.nextStatus) ? req.body.nextStatus : 0;
    if (req.body.owner) options.owner = req.body.owner;
    res.json(options);
  });
  app.get("/api/review/library/state", (_req, res) => res.json({ notes: [...notes.values()], ...options }));
  app.get(["/ink", "/ink.html"], (_req, res) => res.redirect(302, "/library"));
  app.get(["/library", "/library.html"], (_req, res) => res.sendFile(path.join(root, "library.html")));
  app.get("/library/notebook", (_req, res) => res.sendFile(path.join(root, "ink.html")));
};
