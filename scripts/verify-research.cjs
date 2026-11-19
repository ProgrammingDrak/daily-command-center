/* global process, console, Buffer, window, document, innerWidth, URL, Event */
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { chromium } = require("playwright-core");
(async () => {
  let fixture;
  if (process.env.DCC_RESEARCH_SELF_HOST === "1") {
    process.env.DCC_RESEARCH_REVIEW = "1";
    process.env.PORT = "0";
    fixture = await require("./research-review-server.cjs").start();
  }
  const base = fixture
    ? "http://127.0.0.1:" + fixture.server.address().port
    : process.env.DCC_RESEARCH_REVIEW_URL || "http://127.0.0.1:8106";
  if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
    throw new Error("Use a synthetic localhost research review server");
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : chromium.executablePath()),
    args: ["--no-sandbox"]
  });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/research");
    await page.getByLabel("Capture title").waitFor();
    const title = "Browser embroidery " + randomUUID().slice(0, 8);
    await page.getByLabel("Capture title").fill(title);
    await page.getByRole("button", { name: "Capture", exact: true }).click();
    await page.getByRole("heading", { name: title, exact: true }).waitFor();
    const ideaId = new URL(page.url()).searchParams.get("id");
    assert.ok(ideaId);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Description", { exact: true }).fill("Explore small batches with Fae.");
    await page
      .getByLabel("Notes (Markdown)")
      .fill("**Preserved research**\n\n<script>window.researchXss=true</script>");
    await page.getByLabel("Tags, separated by commas").fill("Apparel, Fae");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator("#editor").waitFor({ state: "hidden" });
    await page.reload();
    await page.getByText("Explore small batches with Fae.", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.researchXss), undefined);
    assert.equal(await page.locator(".ri-rich strong").first().textContent(), "Preserved research");
    await page.getByRole("button", { name: "Add finding or question" }).click();
    await page.getByLabel("Entry type").selectOption("Question");
    await page.getByLabel("Title", { exact: true }).fill("What machine capacity is needed?");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator("#editor").waitFor({ state: "hidden" });
    await page.getByText("What machine capacity is needed?", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Resolve question" }).click();
    await page.getByRole("button", { name: "Reopen question" }).waitFor();
    // Seed only the isolated review API. No real account or production product data.
    const write = async (url, method, body) => {
      const r = await page.request.fetch(base + url, {
        method,
        headers: { "x-dcc-wishlist": "1", "content-type": "application/json" },
        data: body
      });
      assert.ok(r.ok(), await r.text());
      return r.json();
    };
    const requirementTitle = "Fixture embroidery requirement " + randomUUID().slice(0, 8);
    const productTitle = "Fixture machine " + randomUUID().slice(0, 8);
    const req = await write("/api/research", "POST", {
      id: randomUUID(),
      kind: "requirement",
      title: requirementTitle
    });
    const product = await write("/api/research", "POST", { id: randomUUID(), kind: "product", title: productTitle });
    await write("/api/research/" + product.id, "PATCH", {
      mutationId: randomUUID(),
      revision: product.revision,
      data: {
        price: "100.25",
        currency: "USD",
        priceObservedOn: "2026-01-01",
        specifications: "Synthetic fixture, 4 hoops"
      }
    });
    await write("/api/research/links", "PUT", {
      id: randomUUID(),
      mutationId: randomUUID(),
      revision: 0,
      fromId: req.id,
      toId: product.id,
      relation: "candidate"
    });
    const secondProduct = await write("/api/research", "POST", {
      id: randomUUID(),
      kind: "product",
      title: "Another fixture machine " + randomUUID().slice(0, 8)
    });
    await write("/api/research/" + secondProduct.id, "PATCH", {
      mutationId: randomUUID(),
      revision: secondProduct.revision,
      data: {
        price: "215.60",
        currency: "USD",
        priceObservedOn: "2026-01-01",
        specifications: "Synthetic fixture, 8 hoops"
      }
    });
    await write("/api/research/links", "PUT", {
      id: randomUUID(),
      mutationId: randomUUID(),
      revision: 0,
      fromId: req.id,
      toId: secondProduct.id,
      relation: "candidate"
    });
    await page.goto(base + "/research?id=" + ideaId);
    await page.getByRole("button", { name: "Link existing", exact: true }).click();
    await page.getByLabel("Find by title").fill(requirementTitle);
    await page.getByRole("button", { name: requirementTitle, exact: true }).click();
    await page.locator("#editor").waitFor({ state: "hidden" });
    await page.getByRole("link", { name: requirementTitle, exact: true }).click();
    await page.getByRole("heading", { name: "Product candidates", exact: true }).waitFor();
    assert.equal(await page.locator(".ri-compare article").count(), 2);
    const firstComparison = page
      .locator(".ri-compare > article")
      .filter({ has: page.getByRole("link", { name: productTitle, exact: true }) });
    assert.ok((await firstComparison.textContent()).includes("100.25"));
    assert.ok((await firstComparison.textContent()).includes("4 hoops"));
    const secondComparison = page
      .locator(".ri-compare > article")
      .filter({ has: page.getByRole("link", { name: secondProduct.title, exact: true }) });
    assert.ok((await secondComparison.textContent()).includes("215.60"));
    assert.ok((await secondComparison.textContent()).includes("8 hoops"));
    assert.ok((await page.locator(".ri-compare").textContent()).includes("Price needs rechecking."));
    await firstComparison.getByRole("button", { name: "Select product", exact: true }).click();
    await page.getByRole("link", { name: productTitle, exact: true }).first().click();
    await page.getByRole("heading", { name: productTitle, exact: true }).waitFor();
    await page.getByRole("button", { name: "Create purchase task", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator("#editor").waitFor({ state: "hidden" });
    await page.getByRole("link", { name: "Buy " + productTitle, exact: true }).waitFor();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Currency (ISO code)").fill("usd");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator("#editor-status").filter({ hasText: "currency" }).waitFor();
    await page.getByLabel("Currency (ISO code)").fill("USD");
    await page.getByLabel("Status", { exact: true }).selectOption("Owned");
    await page.getByLabel("Actual purchase price").fill("99.50");
    await page.getByLabel("Purchase date", { exact: true }).fill("2026-11-19");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator("#editor").waitFor({ state: "hidden" });
    await page.reload();
    await page.getByText("Owned", { exact: true }).first().waitFor();
    assert.ok((await page.locator("main").textContent()).includes("99.50"));
    await page
      .locator("#upload")
      .setInputFiles({ name: "fixture-notes.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic notes") });
    await page.getByRole("link", { name: "fixture-notes.txt" }).waitFor();
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await page.getByRole("button", { name: "Restore", exact: true }).waitFor();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await page.getByRole("button", { name: "Archive", exact: true }).waitFor();
    await page.getByRole("button", { name: "Activity history", exact: true }).click();
    await page.getByText("Saved details", { exact: true }).first().waitFor();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.evaluate(async () => {
      for (const r of await window.ResearchSync.pending())
        if (r.value.rejected) await window.ResearchSync.discard(r.key);
    });
    await page.goto(base + "/research?id=" + ideaId);
    await page
      .locator(".ri-links li")
      .filter({ has: page.getByRole("link", { name: requirementTitle, exact: true }) })
      .getByRole("button", { name: "Unlink", exact: true })
      .click();
    await page.getByRole("button", { name: "Link existing", exact: true }).click();
    await page.getByLabel("Find by title").fill(requirementTitle);
    await page.getByRole("button", { name: requirementTitle, exact: true }).click();
    await page.locator("#editor").waitFor({ state: "hidden" });
    await page.getByRole("link", { name: requirementTitle, exact: true }).waitFor();
    // Capture survives a failed push and reload in its durable outbox, then auto-retries.
    await page.goto(base + "/research");
    await page.getByLabel("Capture title").waitFor();
    const pendingTitle = "Offline fixture " + randomUUID().slice(0, 8);
    await page.route("**/api/research", (route) => route.abort("internetdisconnected"));
    await page.getByLabel("Capture title").fill(pendingTitle);
    await page.getByRole("button", { name: "Capture", exact: true }).click();
    await page
      .getByText(/Saved locally/)
      .first()
      .waitFor();
    assert.equal(
      await page.evaluate(async () => {
        const p = await window.ResearchSync.pending();
        return p.length;
      }),
      1
    );
    await page.reload();
    await page.getByLabel("Capture title").waitFor();
    assert.equal(await page.evaluate(async () => (await window.ResearchSync.pending()).length), 1);
    await page.unroute("**/api/research");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForFunction(async () => (await window.ResearchSync.pending()).length === 0);
    await page.reload();
    await page.getByRole("link", { name: pendingTitle, exact: true }).waitFor();
    assert.equal(await page.evaluate(async () => (await window.ResearchSync.pending()).length), 0);
    // Every real variant is reachable and responsive at phone/tablet/desktop sizes.
    for (const width of [375, 768, 1280])
      for (const layout of ["cards", "list", "notebook"]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(base + "/research?layout=" + layout);
        await page.getByRole("link", { name: title, exact: true }).waitFor();
        assert.equal(await page.locator("#results").getAttribute("data-layout"), layout);
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          layout + " overflow at " + width
        );
      }
    await page.getByText("Status filters", { exact: true }).click();
    await page.getByRole("button", { name: "Remove all", exact: true }).click();
    await page.getByText("No records match. Capture a title above to begin.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Add all", exact: true }).click();
    await page.getByRole("link", { name: title, exact: true }).waitFor();
    await page.screenshot({
      path: process.env.DCC_RESEARCH_SCREENSHOT || "/tmp/dcc-research-desktop.png",
      fullPage: true
    });
    assert.deepEqual(errors, []);
    console.log(
      "PASS: mobile capture, reload, rich notes, questions, relationships, comparison, purchase task, owned, attachment, archive/restore, history, durable retry, filters, 9 responsive variants"
    );
    await context.close();
  } finally {
    await browser.close();
    if (fixture) await fixture.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
