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
const os = require("os");
const simpleGit = require("simple-git");
const { EventEmitter } = require("events");

const DEFAULT_COMMIT_DEBOUNCE = 30_000;
const DEFAULT_PUSH_DEBOUNCE = 60_000;
const PULL_INTERVAL = 5 * 60_000;
const GIT_TIMEOUT = 20_000;
const BACKOFF_SCHEDULE = [30_000, 120_000, 600_000, 1_800_000];

// Stop the LFS smudge filter from bulk-downloading pointer content on clone/
// checkout/pull, so cold boots never pull the media band (B3 adds on-demand
// fetch). Set on process.env so every simple-git child inherits it: passing it
// through simple-git's .env() would trip its env-safety guard whenever the
// ambient environment also defines GIT_EDITOR/GIT_SSH (which .env() rejects).
// DCC's only git usage is this vault sync, and skip-smudge is a safe default.
// Inert when git-lfs isn't installed.
process.env.GIT_LFS_SKIP_SMUDGE = process.env.GIT_LFS_SKIP_SMUDGE || "1";

class SyncManager extends EventEmitter {
  constructor({ vaultDir, queueFile, remoteUrl, branch = "main", commitDebounce, pushDebounce, gitcryptKeyB64 } = {}) {
    super();
    this.vaultDir = vaultDir;
    this.queueFile = queueFile;
    this.remoteUrl = remoteUrl;
    this.branch = branch;
    this.commitDebounce = commitDebounce || DEFAULT_COMMIT_DEBOUNCE;
    this.pushDebounce = pushDebounce || DEFAULT_PUSH_DEBOUNCE;
    // Base64 git-crypt key (A2). When set, init() unlocks the sensitive dirs
    // BEFORE the VaultStore indexes them (see docs/UNLOCK.md §2). gitcryptState
    // records the outcome for the status pill: unknown | no-key | already |
    // unlocked | failed. "failed"/"no-key" leave the dirs as ciphertext, which
    // the VaultStore magic-byte guard then skips — the vault stays up, locked.
    this.gitcryptKeyB64 = gitcryptKeyB64 || null;
    this.gitcryptState = "unknown";
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
    // Register the LFS clean/smudge filters for THIS repo so the 2-10 MB media
    // attach band commits pointers (git-lfs is added to the image in
    // nixpacks.toml but not globally `install`ed). Best-effort: inert if the
    // binary is missing (attach then degrades to inline-only) or already set.
    await this._gitLfsInstall();
    // Decrypt the sensitive dirs BEFORE VaultStore.init() runs (the caller
    // awaits this init() first). Order is load-bearing per docs/UNLOCK.md §2:
    // index-before-unlock would poison the graph with ciphertext.
    await this._gitCryptUnlock();
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
        // --depth 1 keeps cold boots fast: nothing server-side reads git
        // history. Background pull --rebase --autostash still fast-forwards a
        // shallow single-branch clone (verified in B1 QA). If history is ever
        // needed server-side, switch to --filter=blob:none instead of deepening.
        await git.clone(this.remoteUrl, this.vaultDir, ["--branch", this.branch, "--single-branch", "--depth", "1"]);
        console.log("[sync] cloned vault from remote (shallow, LFS smudge skipped)");
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

  // Best-effort per-repo `git lfs install`. Registers filter.lfs.* in this
  // clone's .git/config so committing a media/lfs/** file runs the clean filter
  // (stores an LFS pointer). Swallows everything: a missing binary just means
  // the attach route stays on the inline band.
  async _gitLfsInstall() {
    try {
      await this._runGit(() => this.git.raw(["lfs", "install", "--local", "--skip-smudge"]));
    } catch (e) {
      console.warn("[sync] git-lfs not available (media LFS band disabled):", e.message);
    }
  }

  // git-crypt unlock hook (docs/UNLOCK.md §2). Decodes the base64 key to a tmp
  // keyfile, runs `git crypt unlock <keyfile>` (which decrypts the working tree
  // and wires the smudge/clean filters), then shreds the keyfile. Idempotent:
  // a clone whose key is already installed is left alone. Every failure is
  // non-fatal — the vault boots with sensitive dirs still encrypted, and the
  // VaultStore magic-byte guard keeps them out of the graph until a good boot.
  async _gitCryptUnlock() {
    if (!this.gitcryptKeyB64) { this.gitcryptState = "no-key"; return; }
    const keysFile = path.join(this.vaultDir, ".git", "git-crypt", "keys", "default");
    if (fs.existsSync(keysFile)) { this.gitcryptState = "already"; return; }
    const keyfile = path.join(os.tmpdir(), `mycelium-gc-${process.pid}-${process.hrtime.bigint()}.key`);
    try {
      const buf = Buffer.from(this.gitcryptKeyB64, "base64");
      if (buf.length < 16) throw new Error("git-crypt key is empty or too short after base64 decode");
      await fsp.writeFile(keyfile, buf, { mode: 0o600 });
      await this._runGit(() => this.git.raw(["crypt", "unlock", keyfile]));
      this.gitcryptState = "unlocked";
      console.log("[sync] git-crypt: sensitive dirs unlocked");
    } catch (e) {
      this.gitcryptState = "failed";
      // Never log key material; the message is git-crypt's own (path/type only).
      console.warn("[sync] git-crypt unlock failed (sensitive dirs stay locked):", e.message);
    } finally {
      // Shred: overwrite then unlink so the plaintext key doesn't linger in tmp.
      try { const st = await fsp.stat(keyfile); await fsp.writeFile(keyfile, Buffer.alloc(st.size, 0)); } catch {}
      try { await fsp.unlink(keyfile); } catch {}
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
      gitcrypt: this.gitcryptState,
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
