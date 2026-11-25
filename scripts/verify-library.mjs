/* global JournalDrafts, document, innerWidth, caches */
const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE || "playwright-core");
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const base = process.env.LIBRARY_QA_URL || "http://127.0.0.1:8102";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(),
  errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
async function check(name, fn) {
  await fn();
  checks.push(name);
}
try {
  const health = await page.request.get(base + "/api/health").then((r) => r.json());
  assert.equal(health.reviewOnly, true, "Refuse fixture writes outside the local review server");
  await page.request.post(base + "/api/review/library/reset");
  await page.goto(base + "/library");
  await page.getByRole("button", { name: "Open Journals", exact: true }).waitFor();
  await check("Library opens its permanent Journals notebook", async () =>
    assert.equal(await page.locator(".lr-book").count(), 1)
  );
  await page.getByRole("button", { name: "Open Journals", exact: true }).click();
  await page.getByRole("textbox", { name: "Journal text", exact: true }).fill("A durable local journal note.");
  await page.getByRole("button", { name: "Paper options", exact: true }).click();
  await page.locator("[data-popup] [data-layout]").selectOption("engineering");
  await page.locator("[data-popup] [data-tone]").selectOption("cream");
  await page.locator("[data-apply]").click();
  await page.locator('[data-tool="pen"]').click();
  assert.equal(await page.locator('[data-pen-style] option').count(),7);
  await page.getByRole("button", { name: "Pencil", exact: true }).click();
  const canvas = page.locator("[data-canvas]");
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  for (let n = 0; n < 20; n++) {
    await page.mouse.move(box.x + 30, box.y + 40 + n * 5);
    await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + 45 + n * 5);
    await page.mouse.up();
  }
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("[data-status]")?.textContent.includes("Synced to vault"));
  await check("Journal text, 20 strokes, and rich paper metadata reach the vault", async () => {
    const state = await page.request.get(base + "/api/review/library/state").then((r) => r.json());
    const note = state.notes.find((n) => n.slug === "journal/2026/2026-11-25");
    assert.ok(note.body.includes("A durable local journal note."));
    const raw = JSON.parse(note.body.split("<!-- dcc-journal-ink:v1\n")[1].slice(0, -4));
    assert.equal(raw.pages[0].length, 20);
    assert.equal(raw.papers[0].type, "engineering");
  });
  await page.reload();
  await page.locator("[data-canvas]").waitFor();
  await check("Reload restores journal text and paper", async () => {
    assert.ok(
      (await page.getByRole("textbox", { name: "Journal text", exact: true }).innerText()).includes(
        "A durable local journal note."
      )
    );
    assert.equal(await page.locator("[data-paper]").inputValue(), "ink:engineering");
  });
  const storageChecks = await page.evaluate(async () => {
    const drafts = JournalDrafts.create("revision-qa"),
      other = JournalDrafts.create("different-owner-qa");
    const base = {
      slug: "journal/2026/2026-11-01",
      body: "one",
      frontmatter: { type: "journal" },
      hash: "h1",
      revision: 0,
      dirty: false
    };
    await drafts.put(base);
    const first = await drafts.edit({ ...base, body: "two" });
    await drafts.edit({ ...base, body: "three" });
    const stale = await drafts.acknowledge(base.slug, first.revision, "h2");
    if (!stale.dirty || stale.body !== "three" || stale.hash !== "h2")
      throw new Error("Stale acknowledgement lost newer ink");
    const cached = await drafts.cache({ ...base, body: "remote" });
    if (cached.body !== "three") throw new Error("Remote cache replaced a pending draft");
    if ((await other.list()).length) throw new Error("Account namespaces mixed");
    const clean = await drafts.acknowledge(base.slug, stale.revision, "h3");
    if (clean.dirty) throw new Error("Exact acknowledgement stayed dirty");
    return true;
  });
  assert.equal(storageChecks, true);
  checks.push("IndexedDB protects exact revisions, pending drafts, and separate owners");
  await context.setOffline(true);
  await page.getByRole("textbox", { name: "Journal text", exact: true }).fill("Written offline and kept locally.");
  await page.waitForFunction(() => document.querySelector("[data-status]")?.textContent.includes("Saved locally"));
  // Wait for the complete shell before exercising a cold offline navigation.
  await page.waitForFunction(async () => !!(await caches.match("/public/js/library-workspace.js")));
  await page.reload();
  await page.getByRole("textbox", { name: "Journal text", exact: true }).waitFor();
  await check("Cold offline reload keeps the journal and its newer local draft", async () =>
    assert.ok(
      (await page.getByRole("textbox", { name: "Journal text", exact: true }).innerText()).includes("Written offline")
    )
  );
  await context.setOffline(false);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("[data-status]")?.textContent.includes("Synced to vault"));
  await page.request.post(base + "/api/review/library/options", { data: { nextStatus: 409 } });
  await page.getByRole("textbox", { name: "Journal text", exact: true }).fill("Keep this conflicted draft.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("[data-export-conflict]").waitFor();
  await page.reload();
  await page.locator("[data-export-conflict]").waitFor();
  await check("A conflict retains the local draft across reload", async () =>
    assert.ok(
      (await page.getByRole("textbox", { name: "Journal text", exact: true }).innerText()).includes(
        "Keep this conflicted draft"
      )
    )
  );
  await page.locator('[data-vault-copy]').click();
  await page.getByRole('button',{name:'Use local draft; keep a copy of this version',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-status]')?.textContent.includes('Synced to vault'));
  await check('Explicit conflict resolution retains a downloadable vault copy',async()=>{
    assert.equal(await page.getByRole('button',{name:'Download earlier copy 1',exact:true}).count(),1);
    const state=await page.request.get(base+'/api/review/library/state').then(r=>r.json());
    assert.ok(state.notes.find(n=>n.slug==='journal/2026/2026-11-25').body.includes('Keep this conflicted draft'));
  });
  await page.locator("[data-library]").click();
  await page.getByRole("button", { name: "+ Notebook", exact: true }).click();
  await page.getByRole("textbox", { name: "Notebook title", exact: true }).fill("Integration QA notebook");
  await page.getByRole("button", { name: "Create notebook", exact: true }).click();
  const frame = page.frameLocator("iframe");
  await frame.locator("#writer.on").waitFor();
  await check("Notebooks retain the proven Ink editor and its complete tool library", async () => {
    await frame.locator("#penBtn").click();
    assert.equal(await frame.locator("#brushChoices button").count(), 9);
    await frame.locator("#brushClose").click();
    await frame.locator("#paperBtn").click();
    assert.equal(await frame.locator("#paperChoices button").count(), 15);
    await frame.locator("#paperClose").click();
  });
  await frame.locator("#backBtn").click();
  await page.getByRole("button", { name: "Open Integration QA notebook", exact: true }).waitFor();
  await check("Returning from Ink keeps its notebook on the Library shelf", async () =>
    assert.equal(await page.getByRole("button", { name: "Open Integration QA notebook", exact: true }).count(), 1)
  );
  const redirect = await page.request.get(base + "/ink", { maxRedirects: 0 });
  assert.equal(redirect.status(), 302);
  checks.push("Old Ink address redirects to Library");
  await page.setViewportSize({ width: 390, height: 844 });
  await check("Mobile Library has no horizontal overflow", async () =>
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  );
  await mkdir(new URL("../test-results/library/", import.meta.url), { recursive: true });
  await page.screenshot({
    path: fileURLToPath(new URL("../test-results/library/phone.png", import.meta.url)),
    fullPage: true
  });
  assert.deepEqual(errors, []);
  await writeFile(
    new URL("../test-results/library/results.json", import.meta.url),
    JSON.stringify({ checks, errors }, null, 2)
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser.close();
}
