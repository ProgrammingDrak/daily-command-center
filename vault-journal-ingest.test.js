"use strict";

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const express = require("express");
const matter = require("gray-matter");
const FormDataCtor = globalThis.FormData;
const BlobCtor = globalThis.Blob;
const ingestClient = require("./.agents/skills/ingest-mycelium-journal-image/scripts/ingest");

const VaultStore = require("./vault-store");
const mountVault = require("./routes/vault");
const { journalIngestRecord, validCaptureDate } = mountVault;

const IMAGE = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

async function startVault() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "dcc-journal-ingest-"));
  const vault = new VaultStore({ vaultDir: dir });
  await vault.init();
  const app = express();
  app.use(express.json());
  mountVault(app, {
    vault,
    syncMgr: null,
    VAULT_REPO_URL: "",
    VAULT_SENSITIVE_PIN: "",
    getTodayStr: () => "2026-08-07",
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    dir,
    vault,
    base,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await vault.close();
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

function journalForm(overrides = {}) {
  const image = overrides.__image || IMAGE;
  const filename = overrides.__filename || "page-1.png";
  const mime = overrides.__mime || "image/png";
  const values = {
    title: "Morning pages",
    date: "2026-08-07",
    classification: "journal",
    confidence: "0.94",
    classificationRationale: "First-person dated reflection.",
    transcript: "I felt clearer after walking beside the river.",
    highlights: JSON.stringify(["The walk brought clarity."]),
    lowConfidence: JSON.stringify(["The last word may be river."]),
    ...overrides,
  };
  delete values.__image;
  delete values.__filename;
  delete values.__mime;
  const form = new FormDataCtor();
  form.append("file", new BlobCtor([image], { type: mime }), filename);
  for (const [key, value] of Object.entries(values)) form.append(key, value);
  return form;
}

test("journal ingest record keeps a stable source, transcript revision, and evidence links", () => {
  const hash = "a".repeat(64);
  const record = journalIngestRecord({
    source: { hash, filename: "page-1.jpg" },
    transcript: "I felt optimistic after the walk.",
    highlights: ["The walk helped."],
    lowConfidence: ["One word may be optimistic."],
    classification: "journal",
    confidence: 0.92,
  });
  assert.strictEqual(record.type, "journal");
  assert.strictEqual(record.frontmatter.source_id, `media:sha256:${hash}`);
  assert.strictEqual(record.frontmatter.transcript_version, 1);
  assert.match(record.body, new RegExp(`evidence: media:sha256:${hash}#image:full`));
  assert.match(record.body, /\[check source\]\(#source-aaaaaaaaaaaa\)/);
  assert.strictEqual(journalIngestRecord({
    source: { hash, filename: "page.jpg" }, transcript: "Short note", classification: "journal", confidence: 0.69,
  }).type, "fleeting");
  assert.throws(() => journalIngestRecord({
    source: { hash, filename: "page.jpg" }, transcript: "", classification: "journal", confidence: 0.9,
  }), /transcript required/);
  assert.throws(() => journalIngestRecord({
    source: { hash, filename: "page.jpg" }, transcript: "note", classification: "journal", confidence: "  ",
  }), /confidence is required/);
  assert.ok(validCaptureDate("2026-08-07"));
  assert.ok(!validCaptureDate("2026-02-30"));
});

test("journal ingest client resolves the canonical token profile without exposing it", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "dcc-journal-profile-"));
  const previous = process.env.DCC_CONFIG_DIR;
  try {
    await fsp.writeFile(path.join(dir, "profiles.json"), JSON.stringify({
      default: "fixture",
      profiles: { fixture: { base_url: "https://dcc.example.test/", token: "fixture-secret" } },
    }));
    process.env.DCC_CONFIG_DIR = dir;
    const resolved = await ingestClient.resolveConnection({});
    assert.deepStrictEqual(resolved, {
      base: "https://dcc.example.test",
      token: "fixture-secret",
      profile: "fixture",
    });
    assert.doesNotMatch(JSON.stringify({ base: resolved.base, profile: resolved.profile }), /fixture-secret/);
  } finally {
    if (previous === undefined) delete process.env.DCC_CONFIG_DIR;
    else process.env.DCC_CONFIG_DIR = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("generated journal payload passes the shared Mycelium parser when available", (t) => {
  const vaultDir = process.env.VAULT_DIR;
  if (!vaultDir) return t.skip("set VAULT_DIR to run the shared-parser gate");
  const parse = require(path.join(vaultDir, ".mycelium", "lib", "parse.js"));
  const record = journalIngestRecord({
    source: { hash: "c".repeat(64), filename: "page.png" },
    transcript: "A parser-backed journal transcript.",
    highlights: ["Parser-backed highlight."],
    lowConfidence: [],
    classification: "journal",
    confidence: 0.95,
  });
  const raw = matter.stringify(record.body, {
    ...record.frontmatter,
    type: "journal",
    title: "Parser gate",
    date: "2026-08-07",
  });
  const parsed = parse.parseNode(raw);
  assert.ok(!parsed.frontmatter._parseError);
  assert.strictEqual(parsed.frontmatter.type, "journal");
  assert.strictEqual(parsed.frontmatter.source_id, record.sourceId);
  assert.match(parsed.body, /## Low-confidence passages/);
});

test("journal image upload writes a readable daily entry, original, manifest, and transcript sidecar", async () => {
  const h = await startVault();
  try {
    const response = await fetch(`${h.base}/api/vault/journal-image-ingest`, { method: "POST", body: journalForm() });
    const result = await response.json();
    assert.strictEqual(response.status, 201);
    assert.strictEqual(result.slug, "journal/2026/2026-08-07");
    assert.strictEqual(result.classification.type, "journal");
    assert.strictEqual(result.classification.fallback, false);

    const hash = result.source.id.replace("media:sha256:", "");
    const hash12 = hash.slice(0, 12);
    const node = h.vault.get(result.slug);
    assert.ok(node, "daily journal is indexed");
    assert.match(node.body, /I felt clearer after walking beside the river/);
    assert.match(node.body, new RegExp(`!\\[page-1.png\\]\\(media:sha256:${hash}\\)`));

    const mediaYear = String(new Date().getFullYear());
    const manifestPath = path.join(h.dir, "media", "manifests", mediaYear, `${hash12}.json`);
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    assert.strictEqual(manifest.hash, `sha256:${hash}`);
    assert.strictEqual(manifest.text_sidecar, `media/manifests/${mediaYear}/${hash12}.txt`);
    assert.match(await fsp.readFile(path.join(h.dir, manifest.text_sidecar), "utf8"), /walking beside the river/);

    const readBack = await fetch(`${h.base}/api/vault/node/${result.slug}`);
    const readNode = await readBack.json();
    assert.strictEqual(readBack.status, 200);
    assert.match(readNode.renderedBody, new RegExp(`data-media-hash="${hash}"`));
    assert.match(readNode.renderedBody, /## Transcription/);

    const source = await fetch(`${h.base}/api/vault/media/${hash}`);
    assert.strictEqual(source.status, 200);
    assert.deepStrictEqual(Buffer.from(await source.arrayBuffer()), IMAGE);

    const retry = await fetch(`${h.base}/api/vault/journal-image-ingest`, { method: "POST", body: journalForm() });
    const retryResult = await retry.json();
    assert.strictEqual(retry.status, 200);
    assert.strictEqual(retryResult.slug, result.slug);
    assert.strictEqual(retryResult.deduplicated, true);
    assert.strictEqual(retryResult.node, undefined, "dedupe response never returns a raw node");
    assert.strictEqual((h.vault.get(result.slug).body.match(/## Transcription/g) || []).length, 1);
  } finally {
    await h.close();
  }
});

test("malformed capture fails before media is written; low confidence files to inbox", async () => {
  const h = await startVault();
  try {
    const bad = await fetch(`${h.base}/api/vault/journal-image-ingest`, {
      method: "POST",
      body: journalForm({ transcript: "", confidence: "0.9" }),
    });
    assert.strictEqual(bad.status, 400);
    await assert.rejects(() => fsp.access(path.join(h.dir, "media")));

    const fallback = await fetch(`${h.base}/api/vault/journal-image-ingest`, {
      method: "POST",
      body: journalForm({ confidence: "0.52", lowConfidence: "Several lines are ambiguous." }),
    });
    const result = await fallback.json();
    assert.strictEqual(fallback.status, 201);
    assert.match(result.slug, /^inbox\//);
    assert.strictEqual(result.classification.type, "fleeting");
    assert.strictEqual(result.classification.fallback, true);
  } finally {
    await h.close();
  }
});

test("confident capture appends to the canonical daily note without replacing its title or body", async () => {
  const h = await startVault();
  try {
    await h.vault.write("journal/2026/2026-08-07", {
      frontmatter: { type: "journal", title: "Friday journal", date: "2026-08-07" },
      body: "Existing typed reflection.",
    });
    const response = await fetch(`${h.base}/api/vault/journal-image-ingest`, { method: "POST", body: journalForm() });
    const result = await response.json();
    assert.strictEqual(response.status, 200);
    assert.strictEqual(result.created, false);
    assert.strictEqual(result.node, undefined, "service-token response never returns a raw node");
    const node = h.vault.get(result.slug);
    assert.strictEqual(node.frontmatter.title, "Friday journal");
    assert.match(node.body, /^Existing typed reflection\./);
    assert.match(node.body, /## Transcription/);
  } finally {
    await h.close();
  }
});

test("journal ingest rejects missing confidence and mismatched active filenames before writing", async () => {
  const h = await startVault();
  try {
    const blank = await fetch(`${h.base}/api/vault/journal-image-ingest`, {
      method: "POST",
      body: journalForm({ confidence: " " }),
    });
    assert.strictEqual(blank.status, 400);

    const disguised = await fetch(`${h.base}/api/vault/journal-image-ingest`, {
      method: "POST",
      body: journalForm({ __filename: "poison.md", __mime: "image/png" }),
    });
    assert.strictEqual(disguised.status, 400);
    await assert.rejects(() => fsp.access(path.join(h.dir, "media")));
  } finally {
    await h.close();
  }
});

test("concurrent distinct pages append without losing either capture", async () => {
  const h = await startVault();
  try {
    const [a, b] = await Promise.all([
      fetch(`${h.base}/api/vault/journal-image-ingest`, {
        method: "POST",
        body: journalForm({ __image: Buffer.concat([IMAGE, Buffer.from("a")]), transcript: "Concurrent page alpha." }),
      }),
      fetch(`${h.base}/api/vault/journal-image-ingest`, {
        method: "POST",
        body: journalForm({ __image: Buffer.concat([IMAGE, Buffer.from("b")]), transcript: "Concurrent page beta." }),
      }),
    ]);
    assert.deepStrictEqual([a.status, b.status].sort(), [200, 201]);
    const node = h.vault.get("journal/2026/2026-08-07");
    assert.match(node.body, /Concurrent page alpha\./);
    assert.match(node.body, /Concurrent page beta\./);
    assert.strictEqual(node.frontmatter.source_ids.length, 2);
  } finally {
    await h.close();
  }
});

test("failed journal write restores a pre-existing attachment manifest", async () => {
  const h = await startVault();
  try {
    const attached = new FormDataCtor();
    attached.append("file", new BlobCtor([IMAGE], { type: "image/png" }), "original.png");
    attached.append("slug", "notes/source");
    const attachResponse = await fetch(`${h.base}/api/vault/attach`, { method: "POST", body: attached });
    const attachResult = await attachResponse.json();
    assert.strictEqual(attachResponse.status, 201);

    const hash = attachResult.hash;
    const manifestPath = path.join(h.dir, "media", "manifests", String(new Date().getFullYear()), `${hash.slice(0, 12)}.json`);
    const before = await fsp.readFile(manifestPath, "utf8");
    const originalMutate = h.vault.mutate.bind(h.vault);
    h.vault.mutate = async () => { throw new Error("forced node write failure"); };
    const failed = await fetch(`${h.base}/api/vault/journal-image-ingest`, {
      method: "POST",
      body: journalForm({ __filename: "journal.png" }),
    });
    h.vault.mutate = originalMutate;
    assert.strictEqual(failed.status, 400);
    assert.strictEqual(await fsp.readFile(manifestPath, "utf8"), before);
    const restored = JSON.parse(before);
    assert.strictEqual(restored.text_sidecar, null);
    await assert.rejects(() => fsp.access(manifestPath.replace(/\.json$/, ".txt")));
  } finally {
    await h.close();
  }
});

test("journal rollback cannot erase a concurrent attachment for the same media hash", async () => {
  const h = await startVault();
  try {
    const original = new FormDataCtor();
    original.append("file", new BlobCtor([IMAGE], { type: "image/png" }), "original.png");
    original.append("slug", "notes/source");
    const first = await fetch(`${h.base}/api/vault/attach`, { method: "POST", body: original });
    const firstResult = await first.json();
    assert.strictEqual(first.status, 201);

    let enteredMutate;
    let releaseMutate;
    const entered = new Promise((resolve) => { enteredMutate = resolve; });
    const release = new Promise((resolve) => { releaseMutate = resolve; });
    h.vault.mutate = async () => {
      enteredMutate();
      await release;
      throw new Error("forced node write failure");
    };

    const journalRequest = fetch(`${h.base}/api/vault/journal-image-ingest`, {
      method: "POST",
      body: journalForm({ __filename: "journal.png" }),
    });
    await entered;

    const concurrent = new FormDataCtor();
    concurrent.append("file", new BlobCtor([IMAGE], { type: "image/png" }), "concurrent.png");
    concurrent.append("slug", "notes/source");
    const concurrentRequest = fetch(`${h.base}/api/vault/attach`, { method: "POST", body: concurrent });
    releaseMutate();

    const [journalResponse, concurrentResponse] = await Promise.all([journalRequest, concurrentRequest]);
    assert.strictEqual(journalResponse.status, 400);
    assert.strictEqual(concurrentResponse.status, 201);
    const manifestPath = path.join(
      h.dir, "media", "manifests", String(new Date().getFullYear()), `${firstResult.hash.slice(0, 12)}.json`
    );
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    assert.strictEqual(manifest.filename, "concurrent.png");
    assert.strictEqual(manifest.text_sidecar, null);
  } finally {
    await h.close();
  }
});

test("service-token deduplication never returns a matching sensitive node", async () => {
  const h = await startVault();
  try {
    const sourceId = `media:sha256:${crypto.createHash("sha256").update(IMAGE).digest("hex")}`;
    await h.vault.write("journal/private/existing", {
      frontmatter: { type: "journal", title: "Private", date: "2026-08-07", source_id: sourceId },
      body: "private body",
    });
    const response = await fetch(`${h.base}/api/vault/journal-image-ingest`, { method: "POST", body: journalForm() });
    const result = await response.json();
    assert.strictEqual(response.status, 201);
    assert.strictEqual(result.slug, "journal/2026/2026-08-07");
    assert.doesNotMatch(JSON.stringify(result), /private body/);
  } finally {
    await h.close();
  }
});
