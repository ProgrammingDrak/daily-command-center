"use strict";

const { belongsToWorkspace, remainingAccessSeconds } = require("../meeting-access");
const defaultAudioStore = require("../meeting-audio-store");

function contentPath(blockId, seconds) {
  const base = `/meetings/${encodeURIComponent(blockId)}/dashboard-content`;
  return Number.isFinite(seconds) && seconds >= 0 ? `${base}?t=${encodeURIComponent(seconds)}` : base;
}

module.exports = function mount(app, ctx) {
  const { blockDB } = ctx;
  const fetchImpl = ctx.fetchImpl || fetch;
  const audioStore = ctx.audioStore || defaultAudioStore;
  const vaultToken = ctx.vaultToken === undefined ? process.env.GH_VAULT_TOKEN : ctx.vaultToken;

  async function meetingRecord(req, res) {
    const block = await blockDB.getBlock(req.params.blockId);
    if (!belongsToWorkspace(block, req.workspaceId)) {
      res.status(404).type("text/plain").send("Meeting dashboard unavailable.");
      return null;
    }
    const ref = block.properties && block.properties.dashboard_ref;
    if (!ref) {
      res.status(404).type("text/plain").send("No recording-review dashboard is attached to this meeting yet.");
      return null;
    }
    return { block, ref: String(ref).replace(/[^A-Za-z0-9._-]/g, "") };
  }

  app.get("/meetings/:blockId/dashboard", async (req, res) => {
    try {
      if (!await meetingRecord(req, res)) return;
      const seconds = Number.parseFloat(req.query.t);
      const src = contentPath(req.params.blockId, seconds);
      res.set("Content-Security-Policy", "default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self'");
      res.set("Cache-Control", "private, no-store");
      res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meeting review</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;background:#f5f5f5}iframe{display:block}</style></head><body><iframe title="Meeting review" sandbox="allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox" src="${src}"></iframe></body></html>`);
    } catch (error) {
      console.error("[meeting-dashboard wrapper] failed:", error);
      res.status(500).type("text/plain").send("Dashboard proxy error.");
    }
  });

  app.get("/meetings/:blockId/dashboard-content", async (req, res) => {
    try {
      const record = await meetingRecord(req, res);
      if (!record) return;
      const { block, ref: slug } = record;
      const token = vaultToken;
      if (!token) return res.status(503).type("text/plain").send("Meeting vault not configured (GH_VAULT_TOKEN unset).");
      const repo = process.env.GH_VAULT_REPO || "ProgrammingDrak/meeting-vault";
      const prefix = (process.env.GH_VAULT_PATH_PREFIX || "meetings").replace(/^\/+|\/+$/g, "");
      const url = `https://api.github.com/repos/${repo}/contents/${prefix}/${encodeURIComponent(slug)}/dashboard.html`;
      const ghResp = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw+json", "User-Agent": "dcc-meeting-vault-proxy" } });
      if (!ghResp.ok) return res.status(502).type("text/plain").send(`Vault fetch failed (${ghResp.status}).`);
      let html = await ghResp.text();
      const artifact = block.properties && block.properties.recording_artifact;
      const hotAudio = artifact && artifact.hot_audio;
      const expiresIn = artifact && artifact.status !== "compacted" && hotAudio
        ? remainingAccessSeconds(hotAudio.expires_at)
        : 0;
      if (expiresIn) {
        const signedAudio = await audioStore.presignHotAudio(hotAudio, {
          workspaceId: req.workspaceId,
          expiresIn,
        });
        html = html.replace(/<audio\b[^>]*>/i, tag => {
          if (!/\bid=(['"])audio\1/i.test(tag)) return tag;
          const escaped = String(signedAudio)
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
          return tag.replace(/\bsrc=(['"])audio\1/i, `src="${escaped}"`);
        });
      }
      res.set("Content-Security-Policy", "sandbox allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src 'self' https: data:; img-src https: data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
      res.set("Content-Type", "text/html; charset=utf-8");
      res.set("Cache-Control", "private, max-age=300");
      res.send(html);
    } catch (error) {
      console.error("[meeting-dashboard proxy] failed:", error);
      res.status(500).type("text/plain").send("Dashboard proxy error.");
    }
  });
};
