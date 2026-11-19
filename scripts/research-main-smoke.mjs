// Real application shell coverage. The caller owns its isolated local test account.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
/* global window, Event, document, innerWidth, location */
export async function verifyResearchMain(page, base) {
  if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
    throw new Error("Research shell smoke requires a localhost test account");
  await page.addInitScript(() => {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        if (/research(Task|Project)=/.test(location.search)) window.dispatchEvent(new Event("dcc:data-ready"));
      },
      { once: true }
    );
  });
  const write = async (path, body) => {
    const r = await page.request.post(base + path, { headers: { "x-dcc-wishlist": "1" }, data: body });
    assert.ok(r.ok(), await r.text());
    return r.json();
  };
  const idea = await write("/api/research", {
    id: randomUUID(),
    kind: "idea",
    title: "Main shell Research fixture " + randomUUID().slice(0, 8)
  });
  const action = (type) =>
    write("/api/research/" + idea.id + "/action", { id: randomUUID(), mutationId: randomUUID(), action: type });
  const task = await action("task"),
    project = await action("project");
  await page.goto(base + task.url);
  await page.locator("#tlb-task-title").waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event("dcc:data-ready")));
  assert.equal(await page.locator(".tlb-modal").count(), 1, "One dialog despite overlapping startup events");
  await page
    .locator(".tlb-modal")
    .getByRole("link", { name: "Linked research, ideas and products", exact: true })
    .click();
  await page.getByRole("heading", { name: "Connected research", exact: true }).waitFor();
  await page.getByRole("link", { name: idea.title, exact: true }).waitFor();
  await page.goto(base + project.url);
  await page.locator("#tlb-project-id").waitFor({ state: "attached" });
  await page.evaluate(() => window.dispatchEvent(new Event("dcc:data-ready")));
  assert.equal(await page.locator(".tlb-modal").count(), 1, "One project dialog");
  assert.equal(await page.locator("#tlb-project-id").inputValue(), project.id);
  await page.locator(".tlb-overlay [data-modal-close]").click();
  assert.equal(await page.getByRole("link", { name: "Research & Ideas", exact: true }).count(), 1);
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "Mobile shell has no overflow"
  );
  return { ideaId: idea.id, taskId: task.id, projectId: project.id };
}
