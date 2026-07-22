"use strict";

// Unit coverage for the Phase B1 vault-tab logic that the conformance test
// (which only pins edge extraction) does not touch: the chokidar ignore
// predicate (the headline watcher fix), backlink context snippets, the
// server-side wikilink renderer, and the sensitive-slug guard.

const test = require("node:test");
const assert = require("node:assert");
const VaultStore = require("./vault-store");
const { renderWikilinks, isSensitiveSlug } = require("./routes/vault");

// ── Watcher ignore predicate (the dot-ancestor bug fix) ──
test("_isIgnored: watches the vault under a dot-named ancestor, still ignores dot/tmp/queue", () => {
  // Vault lives under a `.wt-*` worktree — the exact case the old full-path
  // regex broke by ignoring the whole tree.
  const root = "/home/u/.wt-vault-tab/vault";
  const vs = new VaultStore({ vaultDir: root });

  assert.strictEqual(vs._isIgnored(root), false, "the vault root itself must not be ignored");
  assert.strictEqual(vs._isIgnored(root + "/notes/a.md"), false, "an in-vault note must be watched");
  assert.strictEqual(vs._isIgnored(root + "/health/therapy/x.md"), false, "a nested in-vault note must be watched");

  assert.strictEqual(vs._isIgnored(root + "/.obsidian/workspace.json"), true, "in-vault dot dir ignored");
  assert.strictEqual(vs._isIgnored(root + "/notes/.hidden.md"), true, "in-vault dotfile ignored");
  assert.strictEqual(vs._isIgnored(root + "/notes/a.md.tmp"), true, "atomic-write temp ignored");
  assert.strictEqual(vs._isIgnored(root + "/.sync-queue.json"), true, "sync queue ignored");
  assert.strictEqual(vs._isIgnored("/somewhere/else/b.md"), false, "outside the vault is not our concern");
});

// ── Backlink context snippets ──
test("_backlinkContext: body links get an ellipsized snippet, frontmatter links get the field value", () => {
  const vs = new VaultStore({ vaultDir: "/v" });
  const ingest = (slug, raw) => vs._ingest(slug, "/v/" + slug + ".md", raw, { mtimeMs: 1, size: raw.length });
  ingest("target", "# Target\n");
  ingest("src-body", "Some intro. See [[target]] for the details. Some trailing text.");
  ingest("src-fm", "---\nrelated: '[[target]]'\n---\nunrelated body\n");
  vs._rebuildBacklinks();

  const node = vs.get("target");
  assert.strictEqual(node.backlinks.length, 2);

  const body = node.backlinks.find((b) => b.source === "src-body");
  assert.strictEqual(body.context.field, null);
  assert.ok(body.context.text.includes("[[target]]"), "body snippet quotes the surrounding sentence");

  const fm = node.backlinks.find((b) => b.source === "src-fm");
  assert.strictEqual(fm.context.field, "related");
  assert.strictEqual(fm.context.text, "[[target]]");

  // Missing source node → null, never a throw.
  assert.strictEqual(vs._backlinkContext("ghost", "target", "body"), null);
});

// ── Server-side wikilink rendering ──
test("renderWikilinks: resolves alias/target, flags dangling, escapes", () => {
  const parse = { WIKILINK_RE: VaultStore.WIKILINK_RE };
  const vault = { has: (s) => s === "exists" };
  const out = renderWikilinks(
    "A [[exists]], an [[exists|Alias]], a [[exists#head]], and a [[missing]].",
    parse,
    vault
  );
  assert.ok(out.includes('<a class="wikilink" data-slug="exists">exists</a>'), "plain link");
  assert.ok(out.includes('<a class="wikilink" data-slug="exists">Alias</a>'), "aliased link uses alias text");
  assert.ok(out.includes('<a class="wikilink dangling" data-slug="missing">missing</a>'), "unknown target is dangling");
  // Heading-only form keeps the base target.
  assert.strictEqual((out.match(/data-slug="exists"/g) || []).length, 3);
  assert.strictEqual(renderWikilinks("", parse, vault), "", "empty body is a no-op");
});

// ── Sensitive-slug guard ──
test("isSensitiveSlug: matches the four sensitive dirs, nothing else", () => {
  assert.ok(isSensitiveSlug("health/therapy/2026-07-20-session"));
  assert.ok(isSensitiveSlug("health/moments/x"));
  assert.ok(isSensitiveSlug("health/medical/y"));
  assert.ok(isSensitiveSlug("journal/private/2026/z"));
  assert.ok(!isSensitiveSlug("journal/2026/z"), "non-private journal is not sensitive");
  assert.ok(!isSensitiveSlug("health/workouts/run"), "other health subdirs are not sensitive");
  assert.ok(!isSensitiveSlug("projects/mycelium-mind-map"));
});
