// Account-level journal preferences (today: the paper a new journal starts on).
// Storage and validation live in journal-preferences-store.js; an illegal value
// throws there and lands here as a 400.
const journalPreferencesStore = require("../journal-preferences-store");

module.exports = function mount(app) {
  app.get("/api/journal/preferences", async (req, res) => {
    try {
      res.json(await journalPreferencesStore.getJournalPreferences(req.workspaceId));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch("/api/journal/preferences", async (req, res) => {
    try {
      res.json(await journalPreferencesStore.updateJournalPreferences(
        req.workspaceId, req.session && req.session.userId, req.body || {}
      ));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
};
