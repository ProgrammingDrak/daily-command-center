// Old clients must reload rather than write an independent rotation revision.
module.exports = function mount(app) {
  app.use("/api/work-rotation", (_req, res) => res.status(410).json({ error: "Reload DCC to use Working Queue" }));
};
