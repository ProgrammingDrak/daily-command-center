/**
 * SyncManager — durable, debounced git sync for the vault.
 *
 * On boot: clone if absent, pull --rebase otherwise.
 * On write: commit debounced 30s (coalesces bursts), push debounced 60s.
 * Queues persist to disk so a crash doesn't lose in-flight work.
 * Every git call has a 20s timeout. Failures back off exponentially.
 *
 * Status states: syncing | synced | local-only | offline | auth-expired | conflict
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const simpleGit = require("simple-git");
const { EventEmitter } = require("events");

const DEFAULT_COMMIT_DEBOUNCE = 30_000;
const DEFAULT_PUSH_DEBOUNCE = 60_000;
const PULL_INTERVAL = 5 * 60_000;
const GIT_TIMEOUT = 20_000;
const BACKOFF_SCHEDULE = [30_000, 120_000, 600_000, 1_800_000];

class SyncManager extends EventEmitter {
  constructor({ vaultDir, queueFile, remoteUrl, branch = "main", commitDebounce, pushDebounce } = {}) {
    super();
    this.vaultDir = vaultDir;
    this.queueFile = queueFile;
    this.remoteUrl = remoteUrl;
    this.branch = branch;
    this.commitDebounce = commitDebounce || DEFAULT_COMMIT_DEBOUNCE;
    this.pushDebounce = pushDebounce || DEFAULT_PUSH_DEBOUNCE;
    this.status = "syncing";
    this.lastError = null;
    this.queue = { pendingCommits: [], pendingPush: false };
    this.git = null;
    this._commitTimer = null;
    this._pushTimer = null;
    this._pullInterval = null;
    this._pushBackoffIdx = 0;
    this._shuttingDown = false;
  }

  async init() {
    await this._loadQueue();
    await this._ensureRepo();
    this.git = simpleGit(this.vaultDir, { timeout: { block: GIT_TIMEOUT } });
    if (this.remoteUrl) {
      try { await this._runGit(() => this.git.pull(["--rebase", "--autostash", "origin", this.branch])); }
      catch (e) { console.warn("[sync] initial pull failed:", e.message); }
    }
    this._setStatus("synced");
    if (this.queue.pendingCommits.length || this.queue.pendingPush) this._scheduleCommit();
    this._pullInterval = setInterval(() => this._backgroundPull(), PULL_INTERVAL);
  }

  async close() {
    this._shuttingDown = true;
    if (this._pullInterval) clearInterval(this._pullInterval);
    clearTimeout(this._commitTimer);
    clearTimeout(this._pushTimer);
    await this._flushNow().catch(() => {});
    await this._saveQueue();
  }

  async _ensureRepo() {
    const gitDir = path.join(this.vaultDir, ".git");
    if (fs.existsSync(gitDir)) return;
    await fsp.mkdir(this.vaultDir, { recursive: true });
    if (this.remoteUrl) {
      const git = simpleGit({ timeout: { block: GIT_TIMEOUT } });
      try {
        // --single-branch so we only fetch the vault branch's objects.
        // Matters when the vault is an orphan branch on the same repo as DCC
        // code — without this, the clone would also pull main's history.
        await git.clone(this.remoteUrl, this.vaultDir, ["--branch", this.branch, "--single-branch"]);
        console.log("[sync] cloned vault from remote");
      } catch (e) {
        console.warn("[sync] clone failed, initializing empty repo:", e.message);
        await this._initEmptyRepo();
      }
    } else {
      await this._initEmptyRepo();
    }
  }

  async _initEmptyRepo() {
    const g = simpleGit(this.vaultDir, { timeout: { block: GIT_TIMEOUT } });
    await g.init();
    await g.checkoutLocalBranch(this.branch).catch(() => {});
    if (this.remoteUrl) {
      try { await g.addRemote("origin", this.remoteUrl); } catch {}
    }
    const readme = path.join(this.vaultDir, "README.md");
    if (!fs.existsSync(readme)) {
      await fsp.writeFile(readme, "# Vault\n\nManaged by Daily Command Center.\n", "utf8");
      await g.add(".");
      await g.commit("init: seed vault").catch(() => {});
    }
  }

  async _loadQueue() {
    if (!this.queueFile || !fs.existsSync(this.queueFile)) return;
    try {
      const raw = await fsp.readFile(this.queueFile, "utf8");
      const parsed = JSON.parse(raw);
      this.queue = {
        pendingCommits: Array.isArray(parsed.pendingCommits) ? parsed.pendingCommits : [],
        pendingPush: !!parsed.pendingPush,
      };
    } catch {}
  }

  async _saveQueue() {
    if (!this.queueFile) return;
    try {
      const dir = path.dirname(this.queueFile);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(this.queueFile + ".tmp", JSON.stringify(this.queue), "utf8");
      await fsp.rename(this.queueFile + ".tmp", this.queueFile);
    } catch {}
  }

  _setStatus(status, error) {
    if (this.status === status && !error) return;
    this.status = status;
    this.lastError = error || null;
    this.emit("status", { status, error });
  }

  // ── Public ──

  notifyChange({ slug, message }) {
    this.queue.pendingCommits.push({ slug, message, at: Date.now() });
    this._saveQueue().catch(() => {});
    this._scheduleCommit();
  }

  async flushAndPush() {
    await this._flushCommit();
    await this._runPush();
  }

  getStatus() {
    return {
      status: this.status,
      lastError: this.lastError ? this.lastError.message || String(this.lastError) : null,
      pendingCommits: this.queue.pendingCommits.length,
      pendingPush: this.queue.pendingPush,
    };
  }

  // ── Internals ──

  _scheduleCommit() {
    clearTimeout(this._commitTimer);
    this._commitTimer = setTimeout(() => {
      this._flushCommit().catch((e) => console.error("[sync] commit failed:", e.message));
    }, this.commitDebounce);
  }

  _schedulePush(delay) {
    clearTimeout(this._pushTimer);
    const d = typeof delay === "number" ? delay : this.pushDebounce;
    this._pushTimer = setTimeout(() => {
      this._runPush().catch((e) => console.error("[sync] push failed:", e.message));
    }, d);
  }

  async _flushNow() {
    await this._flushCommit();
    await this._runPush();
  }

  async _flushCommit() {
    if (!this.queue.pendingCommits.length) return;
    this._setStatus("syncing");
    const message = this._buildCommitMessage(this.queue.pendingCommits);
    try {
      await this._runGit(() => this.git.add("."));
      const statusRes = await this._runGit(() => this.git.status());
      if (statusRes.files.length === 0) {
        this.queue.pendingCommits = [];
        await this._saveQueue();
        return;
      }
      await this._runGit(() => this.git.commit(message));
      this.queue.pendingCommits = [];
      this.queue.pendingPush = true;
      await this._saveQueue();
      this._setStatus("local-only");
      this._schedulePush();
    } catch (e) {
      this._setStatus("local-only", e);
      throw e;
    }
  }

  _buildCommitMessage(pending) {
    const slugs = Array.from(new Set(pending.map((p) => p.slug).filter(Boolean)));
    if (pending.length === 1 && pending[0].message) return pending[0].message;
    if (slugs.length === 1) return `update ${slugs[0]}`;
    if (slugs.length <= 3) return `update ${slugs.join(", ")}`;
    return `update ${slugs.length} nodes`;
  }

  async _runPush() {
    if (!this.queue.pendingPush) return;
    if (!this.remoteUrl) { this.queue.pendingPush = false; await this._saveQueue(); return; }
    this._setStatus("syncing");
    try {
      await this._runGit(() => this.git.push("origin", this.branch));
      this.queue.pendingPush = false;
      this._pushBackoffIdx = 0;
      await this._saveQueue();
      this._setStatus("synced");
    } catch (e) {
      const msg = (e && e.message) || String(e);
      const auth = /authentic|credential|permission denied|403|401/i.test(msg);
      const offline = /could not resolve host|network|timeout|unreachable/i.test(msg);
      const conflict = /rejected|non-fast-forward|fetch first/i.test(msg);
      if (conflict) {
        try {
          await this._runGit(() => this.git.pull(["--rebase", "--autostash", "origin", this.branch]));
          await this._runGit(() => this.git.push("origin", this.branch));
          this.queue.pendingPush = false;
          this._pushBackoffIdx = 0;
          await this._saveQueue();
          this._setStatus("synced");
          return;
        } catch (ee) {
          this._setStatus("conflict", ee);
        }
      } else if (auth) {
        this._setStatus("auth-expired", e);
      } else if (offline) {
        this._setStatus("offline", e);
      } else {
        this._setStatus("local-only", e);
      }
      const delay = BACKOFF_SCHEDULE[Math.min(this._pushBackoffIdx, BACKOFF_SCHEDULE.length - 1)];
      this._pushBackoffIdx++;
      this._schedulePush(delay);
    }
  }

  async _backgroundPull() {
    if (this._shuttingDown || !this.remoteUrl) return;
    if (this.queue.pendingCommits.length || this.queue.pendingPush) return;
    try {
      await this._runGit(() => this.git.pull(["--rebase", "--autostash", "origin", this.branch]));
    } catch (e) {
      console.warn("[sync] background pull failed:", e.message);
    }
  }

  async _runGit(fn) {
    return await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("git timeout")), GIT_TIMEOUT + 2000)
      ),
    ]);
  }
}

module.exports = SyncManager;
