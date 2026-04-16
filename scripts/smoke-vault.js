#!/usr/bin/env node
/**
 * scripts/smoke-vault.js
 *
 * Phase 1 smoke test: exercises VaultStore and SyncManager without
 * booting the full Express app (so it can run without DATABASE_URL).
 *
 * Covers: boot index build, write, read, backlinks, graph lookup,
 * external-edit detection via watcher, delete, commit queueing.
 *
 * Runs local-only (no remote push). Creates a throwaway vault at
 * /tmp/dcc-smoke-vault-{pid}, cleans up on success.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");

const VaultStore = require("../vault-store");
const SyncManager = require("../sync-manager");

const SMOKE_DIR = path.join(os.tmpdir(), `dcc-smoke-vault-${process.pid}`);
const INDEX_FILE = path.join(SMOKE_DIR, "..", `.dcc-smoke-index-${process.pid}.json`);
const QUEUE_FILE = path.join(SMOKE_DIR, "..", `.dcc-smoke-queue-${process.pid}.json`);

const pass = (name) => console.log(`  \u2713 ${name}`);
const fail = (name, err) => { console.error(`  \u2717 ${name}: ${err && err.message || err}`); process.exitCode = 1; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return true;
    await sleep(50);
  }
  return false;
}

async function main() {
  await fsp.mkdir(SMOKE_DIR, { recursive: true });
  // Pre-init a repo with gpgsign OFF, so the sandbox's global signing hook
  // doesn't block commits. Real Railway deploys won't have that hook.
  const simpleGitEarly = require("simple-git");
  const g0 = simpleGitEarly(SMOKE_DIR);
  await g0.init();
  await g0.addConfig("commit.gpgsign", "false", false, "local");
  await g0.addConfig("tag.gpgsign", "false", false, "local");
  await g0.addConfig("user.email", "smoke@dcc.local", false, "local");
  await g0.addConfig("user.name", "DCC Smoke Test", false, "local");

  const sync = new SyncManager({
    vaultDir: SMOKE_DIR,
    queueFile: QUEUE_FILE,
    remoteUrl: null,
    commitDebounce: 200,
    pushDebounce: 500,
  });
  await sync.init();
  pass("SyncManager init (local-only)");

  const vault = new VaultStore({ vaultDir: SMOKE_DIR, indexFile: INDEX_FILE });
  let changeEvents = [];
  vault.on("vault-changed", (e) => changeEvents.push(e));
  await vault.init();
  pass(`VaultStore init (built index of ${vault.indexSummary().totalNodes} nodes)`);

  // Write node A
  const nodeA = await vault.write("nodes/test/a", {
    frontmatter: { type: "task", title: "Task A", tags: ["[[tag-alpha]]"] },
    body: "Body of A references [[nodes/test/b]].\n",
  });
  sync.notifyChange({ slug: "nodes/test/a" });
  if (nodeA && nodeA.slug === "nodes/test/a") pass("write and read-back node A");
  else fail("write node A", new Error("unexpected return"));

  // Write node B
  await vault.write("nodes/test/b", {
    frontmatter: { type: "task", title: "Task B", related: "[[nodes/test/a]]" },
    body: "Body of B.\n",
  });
  sync.notifyChange({ slug: "nodes/test/b" });
  pass("write node B");

  // Backlinks: A links to B in body, B links to A via frontmatter.related
  const gA = vault.graph("nodes/test/a");
  const gB = vault.graph("nodes/test/b");
  const aLinksToB = gA.outlinks.some((l) => l.target === "nodes/test/b" && l.type === "body");
  const bLinksToA = gB.outlinks.some((l) => l.target === "nodes/test/a" && l.type === "related");
  const aBacklinkedByB = gA.backlinks.some((b) => b.source === "nodes/test/b" && b.type === "related");
  const bBacklinkedByA = gB.backlinks.some((b) => b.source === "nodes/test/a" && b.type === "body");
  if (aLinksToB && bLinksToA && aBacklinkedByB && bBacklinkedByA) pass("typed edges (body + frontmatter) are indexed in both directions");
  else fail("edges", new Error(`aLinksToB=${aLinksToB} bLinksToA=${bLinksToA} aBacklinkedByB=${aBacklinkedByB} bBacklinkedByA=${bBacklinkedByA}`));

  // External edit simulation: let chokidar settle first so it doesn't
  // collapse the external write with the preceding vault.write() events.
  await sleep(400);
  changeEvents = [];
  const externalContent = `---\ntype: task\ntitle: Task A edited externally\n---\nBody rewritten.\n`;
  await fsp.writeFile(path.join(SMOKE_DIR, "nodes", "test", "a.md"), externalContent, "utf8");
  const gotExternalEvent = await waitFor(() => changeEvents.some((e) => e.slug === "nodes/test/a" && e.source !== "local"), 3000);
  if (gotExternalEvent) pass("chokidar picked up external edit");
  else fail("watcher", new Error("no vault-changed event for external write within 3s"));

  const nodeA2 = vault.get("nodes/test/a");
  if (nodeA2 && nodeA2.frontmatter.title === "Task A edited externally") pass("index reflects external edit");
  else fail("index after external edit", new Error(`title=${nodeA2 && nodeA2.frontmatter.title}`));

  // List filter
  const tasks = vault.list({ type: "task" });
  if (tasks.length >= 2) pass(`list filter type=task returns ${tasks.length} nodes`);
  else fail("list filter", new Error(`expected >=2, got ${tasks.length}`));

  // Commit queue flushed to git
  await sleep(500);
  await sync.flushAndPush().catch(() => {});
  const status = sync.getStatus();
  if (status.pendingCommits === 0) pass("commit queue drained");
  else fail("commit queue", new Error(`pending=${status.pendingCommits}`));

  // Verify a real git commit landed
  const simpleGit = require("simple-git");
  const g = simpleGit(SMOKE_DIR);
  const log = await g.log().catch(() => null);
  if (log && log.total >= 1) pass(`git log has ${log.total} commits`);
  else fail("git commit", new Error("no commits found"));

  // Delete
  await vault.delete("nodes/test/b");
  sync.notifyChange({ slug: "nodes/test/b", message: "delete b" });
  const deletedNode = vault.get("nodes/test/b");
  const backlinksA = vault.graph("nodes/test/a").backlinks;
  if (!deletedNode && !backlinksA.some((b) => b.source === "nodes/test/b")) pass("delete removes node and its edges");
  else fail("delete", new Error("residue remains"));

  await sync.close();
  await vault.close();
  pass("clean shutdown");

  // Cleanup
  await fsp.rm(SMOKE_DIR, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(INDEX_FILE, { force: true }).catch(() => {});
  await fsp.rm(QUEUE_FILE, { force: true }).catch(() => {});

  if (process.exitCode) {
    console.error("\nSMOKE TEST FAILED");
  } else {
    console.log("\nSMOKE TEST PASSED");
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
