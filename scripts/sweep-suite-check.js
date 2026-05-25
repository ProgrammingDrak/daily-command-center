#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

function parseArgs(argv) {
  const args = { keepTmp: false, root: null, brainRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep-tmp") args.keepTmp = true;
    else if (arg === "--root") args.root = argv[++i];
    else if (arg === "--brain-root") args.brainRoot = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function exists(filePath) {
  return Boolean(filePath) && fs.existsSync(filePath);
}

function sweepRootFromBrain(brainRoot) {
  return brainRoot ? path.join(brainRoot, "plugins", "local", "sweep-suite") : null;
}

function candidateRoots(args) {
  const roots = [];
  if (args.root) roots.push(args.root);
  if (process.env.SWEEP_SUITE_ROOT) roots.push(process.env.SWEEP_SUITE_ROOT);
  if (args.brainRoot) roots.push(sweepRootFromBrain(args.brainRoot));
  if (process.env.CLAUDE_BRAIN_ROOT) roots.push(sweepRootFromBrain(process.env.CLAUDE_BRAIN_ROOT));

  const repoRoot = path.resolve(__dirname, "..");
  roots.push(path.resolve(repoRoot, "..", "claude-brain", "plugins", "local", "sweep-suite"));
  roots.push(path.resolve(repoRoot, "..", "..", "claude-brain", "plugins", "local", "sweep-suite"));
  roots.push(path.join(os.homedir(), "portable-programming", "claude-brain", "plugins", "local", "sweep-suite"));

  const codexWorktrees = path.join(os.homedir(), ".codex", "worktrees");
  if (exists(codexWorktrees)) {
    for (const entry of fs.readdirSync(codexWorktrees)) {
      roots.push(path.join(codexWorktrees, entry, "claude-brain", "plugins", "local", "sweep-suite"));
    }
  }

  return [...new Set(roots.filter(Boolean).map((root) => path.resolve(root)))];
}

function findSweepRoot(args) {
  const roots = candidateRoots(args);
  for (const root of roots) {
    const script = path.join(root, "scripts", "sweep_suite_check.py");
    if (exists(script)) return { root, script };
  }
  throw new Error(
    [
      "Could not find Sweep Suite. Checked:",
      ...roots.map((root) => `  - ${root}`),
      "Set SWEEP_SUITE_ROOT or pass --root <path>.",
    ].join("\n"),
  );
}

function findPython() {
  const candidates = process.env.PYTHON ? [process.env.PYTHON] : [];
  candidates.push("python3", "python", "py");
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }
  throw new Error("Could not find a Python executable. Set PYTHON to the desired interpreter.");
}

function printHelp() {
  console.log(`Usage: npm run sweep:check -- [--root PATH] [--brain-root PATH] [--keep-tmp]

Runs the executable Sweep Suite baseline from claude-brain/plugins/local/sweep-suite.

Options:
  --root PATH        Path to the sweep-suite plugin root.
  --brain-root PATH  Path to claude-brain; plugin path is inferred beneath it.
  --keep-tmp         Preserve Sweep Suite temporary fixture output.
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  const { root, script } = findSweepRoot(args);
  const python = findPython();
  const childArgs = [script];
  if (args.keepTmp) childArgs.push("--keep-tmp");

  console.error(`[sweep-suite-check] root=${root}`);
  const result = spawnSync(python, childArgs, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  return result.status || 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`[sweep-suite-check] ${err.message}`);
  process.exit(1);
}
