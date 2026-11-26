// Browser check for Notion-style journal blocks against the synthetic Library
// review server (DCC_REVIEW_LIBRARY=1 PORT=8102 npm run ui-review:serve).
/* global document, window, getSelection, DataTransfer, ClipboardEvent, Event */
import assert from "node:assert/strict";
const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE || "playwright-core");
const base = process.env.LIBRARY_QA_URL || "http://127.0.0.1:8102";
const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || "msedge", headless: true });
const checks = [];
const check = (condition, name) => { assert.ok(condition, name); checks.push(name); };
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const health = await page.request.get(base + "/api/health").then(r => r.json());
  assert.equal(health.reviewOnly, true, "Refuse fixture writes outside the local review server");
  await page.request.post(base + "/api/review/library/reset");
  await page.goto(base + "/library");
  await page.getByRole("button", { name: "Open Journals", exact: true }).click();
  const text = page.getByRole("textbox", { name: "Journal text", exact: true });
  await text.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  const html = () => text.evaluate(el => el.innerHTML);
  const type = async value => page.keyboard.type(value, { delay: 5 });

  await type("# My day");
  check(/<h1[^>]*>My day/.test(await html()), "'# ' makes a heading");
  await page.keyboard.press("Enter");
  await type("Plain words with **bold** and `code` ");
  check(/<strong>bold<\/strong>/.test(await html()) && /<code>code<\/code>/.test(await html()), "inline **bold** and `code` shortcuts");
  await page.keyboard.press("Enter");
  await type("- first");
  await page.keyboard.press("Enter");
  await type("second");
  check(/<ul[^>]*><li[^>]*>first<\/li><li[^>]*>second/.test((await html()).replace(/<br>/g, "")), "'- ' starts a bulleted list that continues on Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await type("[] call mom");
  check(/<input[^>]*type="checkbox"/.test(await html()), "'[] ' makes a to-do");
  await page.keyboard.press("Enter");
  await type("water plants");
  check(await text.evaluate(el => [...el.querySelectorAll("li")].filter(li => li.querySelector(":scope > input[type=checkbox]")).map(li => li.textContent.trim()).join("|")) === "call mom|water plants",
    "Enter in a to-do starts another to-do with its own box");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await type("> exits");
  check(/<blockquote[^>]*>exits/.test(await html()), "Enter on an empty to-do leaves the list");
  await text.evaluate(el => el.querySelector("blockquote").remove());
  await page.locator('.jb-root input[type="checkbox"]').first().click();
  // Return the caret to the end of the to-do line, as a click on its text would.
  await text.evaluate(el => {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents([...el.querySelectorAll("li:has(> input)")].pop());
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await type("/quo");
  check(await page.locator(".jb-menu").isVisible(), "'/' opens the block menu and filters");
  await page.keyboard.press("Enter");
  await type("A quote");
  check(/<blockquote[^>]*>A quote/.test(await html()), "choosing Quote from the menu converts the block");
  await page.keyboard.press("Enter");
  await type("---");
  check(/<hr>/.test(await html()), "'---' inserts a divider");
  await type("After the line");

  // The saved body is plain markdown.
  await page.waitForFunction(() => /Synced to vault|Saved locally/.test(document.querySelector("[data-status]")?.textContent || ""), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector("[data-status]")?.textContent.includes("Synced to vault"), null, { timeout: 30000 });
  const state = await page.request.get(base + "/api/review/library/state").then(r => r.json());
  const journalBody = notes => (notes.find(n => n.slug.startsWith("journal/") && n.body.includes("# My day"))?.body || "").split("<!-- dcc-journal-ink")[0];
  const body = journalBody(state.notes);
  for (const fragment of ["# My day", "**bold**", "`code`", "- first\n- second", "- [x] call mom\n- [ ] water plants", "> A quote", "---", "After the line"])
    check(body.includes(fragment), `markdown keeps ${JSON.stringify(fragment)}`);
  check(!/\u200b/.test(body), "no zero-width spacers reach the markdown");

  // Reload renders the same blocks from markdown.
  await page.reload();
  await page.getByRole("textbox", { name: "Journal text", exact: true }).waitFor();
  const reloaded = await page.getByRole("textbox", { name: "Journal text", exact: true }).evaluate(el => el.innerHTML);
  check(/<h1[^>]*>My day/.test(reloaded) && /<blockquote/.test(reloaded) && /<hr>/.test(reloaded) && /checked/.test(reloaded), "reload restores the blocks");

  // Markdown paste becomes blocks.
  await page.getByRole("textbox", { name: "Journal text", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "## Pasted\n\n- one\n- two");
    document.querySelector(".jb-root").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const pasted = await page.getByRole("textbox", { name: "Journal text", exact: true }).evaluate(el => el.innerHTML);
  check(/<h2[^>]*>Pasted<\/h2>/.test(pasted) && /<li>one<\/li>/.test(pasted), "pasted markdown becomes blocks");

  // An empty journal is empty and shows the placeholder.
  await page.getByRole("textbox", { name: "Journal text", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  check(await page.locator(".jb-root .jb-empty").count() >= 1, "an empty journal shows the typing placeholder");

  // Serializer edge cases: loose to-dos, nested lists, code blank lines, tildes.
  await page.getByRole("textbox", { name: "Journal text", exact: true }).evaluate(el => {
    el.innerHTML = '<h1>My day</h1>'
      + '<ul><li><p><input type="checkbox" checked disabled> loose done</p></li><li><p><input type="checkbox" disabled> loose open</p></li></ul>'
      + '<ol><li>a<ul><li>b</li></ul></li></ol>'
      + '<pre><code class="language-py">x = 1\n\n\n\ny = 2</code></pre>'
      + '<p>x~y</p>';
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  let edge = "";
  for (let i = 0; i < 60 && !edge.includes("x\\~y"); i++) {
    await page.waitForTimeout(500);
    edge = journalBody((await page.request.get(base + "/api/review/library/state").then(r => r.json())).notes);
  }
  check(edge.includes("- [x] loose done") && edge.includes("- [ ] loose open"), "loose to-do lists keep their checkbox state");
  check(edge.includes("1. a\n   - b"), "nested lists keep their indent");
  check(edge.includes("```py\nx = 1\n\n\n\ny = 2\n```"), "code blocks keep blank lines");
  check(edge.includes("x\\~y"), "tildes are escaped");
  check(errors.length === 0, "no page errors: " + errors.join("; "));
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally {
  await browser.close();
}
