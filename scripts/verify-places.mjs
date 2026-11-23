/* global document, innerWidth */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";

const base = process.argv[2] || "http://localhost:4198";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)) throw new Error("Use a disposable loopback DCC instance");
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--no-sandbox"] });
const button = (context, name) => context.getByRole("button", { name, exact: true });
const heading = (context, name) => context.getByRole("heading", { name, exact: true }).waitFor();
try {
  for (const width of [1365, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });
    try {
      const registration = await context.request.post(base + "/api/auth/register", {
        data: { username: "places-" + randomUUID().slice(0, 10), password: "fixture-local-review-only" }
      });
      assert.ok(registration.ok(), "Fixture registration: " + await registration.text());
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const dialog = page.getByRole("dialog");
      const problems = [];
      page.on("pageerror", error => problems.push(error.message));
      await page.goto(base + "/places");
      await heading(page, "Places & Experiences");

      if (width === 390) {
        await button(page, "Mobile shares").click();
        await dialog.getByLabel("Send new shares to Places").check();
        await button(dialog, "Save destination").click();
        await page.getByText("New mobile shares go to Places.").waitFor();
        const shared = await context.request.post(base + "/api/vault/share", {
          multipart: { title: "Shared trail guide", url: "https://example.org/trail-guide" }, maxRedirects: 0
        });
        assert.equal(shared.status(), 303);
        assert.match(shared.headers().location, /^\/places\?place=/);
        await page.goto(base + shared.headers().location);
        await heading(dialog, "Shared trail guide");
        await button(dialog, "Close").click();
      }
      const quick = page.getByRole("textbox", { name: "Place name or link" });
      await quick.fill("https://www.instagram.com/p/fixture-trail/");
      await button(page, "Save place").click();
      await button(page, "Discovery from www.instagram.com").click();
      await heading(dialog, "Discovery from www.instagram.com");
      assert.match(await dialog.innerText(), /fixture-trail/);
      await button(dialog, "Edit place").click();
      await dialog.getByLabel("Place name").fill("Michinoku Coastal Trail");
      await dialog.getByLabel("Location text").fill("Sanriku Coast");
      await dialog.getByLabel("Category", { exact: true }).selectOption("Outdoors");
      await dialog.getByText("Location, collections and details").click();
      await dialog.getByLabel("Longitude").fill("141.61");
      await dialog.getByLabel("Latitude").fill("40.51");
      await dialog.getByLabel("Collections, separated by commas").fill("Japan, Someday");
      await dialog.getByLabel("Estimated visit duration (minutes)").fill("45");
      await button(dialog, "Save changes").click();
      await button(page, "Michinoku Coastal Trail").waitFor();

      await quick.fill("Ramen with Fae");
      await button(page, "Save place").click();
      await button(page, "Ramen with Fae").waitFor();
      await page.getByRole("searchbox").fill("Ramen with Fae");
      await button(page, "Ramen with Fae").click();
      await heading(dialog, "Ramen with Fae");
      assert.match(await dialog.innerText(), /Location unresolved/);
      await button(dialog, "Close").click();
      await page.getByRole("searchbox").fill("");

      await button(page, "Map").click();
      await button(page, "Set origin").click();
      await dialog.getByLabel("Longitude").fill("141.62");
      await dialog.getByLabel("Latitude").fill("40.52");
      await button(dialog, "Find nearby places").click();
      await page.getByText(/Saved places within 25 km straight-line/).waitFor();
      assert.equal(await button(page, "Ramen with Fae").count(), 0);
      await button(page, "Select map marker Michinoku Coastal Trail").click();
      await button(page, "Plan undated trip").click();
      await dialog.getByLabel("Trip name").fill("October coast walk");
      await dialog.getByLabel("Days", { exact: true }).fill("5");
      await dialog.getByLabel("Destination timezone").selectOption("Asia/Tokyo");
      await button(dialog, "Create undated trip").click();
      await heading(page, "October coast walk");
      await button(page, "Timeline").click();
      await page.getByLabel("Add to", { exact: true }).selectOption("1");
      await button(page, "Add Ramen with Fae to day").click();
      const first = page.locator('[data-day="0"]');
      const second = page.locator('[data-day="1"]');
      await button(second, "Edit Ramen with Fae").click();
      await dialog.getByLabel("Part of day").selectOption("Evening");
      await button(dialog, "Save activity").click();
      await second.getByText("Evening", { exact: true }).waitFor();
      await button(first, "Edit Michinoku Coastal Trail").click();
      await dialog.getByLabel("Local start (optional)").fill("08:30");
      await button(dialog, "Save activity").click();
      await first.getByText(/08:30/).waitFor();
      await button(page, "Compare versions").click();
      await heading(dialog, "Relaxed");
      await button(dialog, "Save as separate version").click();
      await button(page, "October coast walk · Original").click();
      await button(page, "Schedule this trip").click();
      await dialog.getByLabel("Day 1 start date").fill("2027-10-04");
      await button(dialog, "Preview dated itinerary").click();
      await heading(dialog, "Day 5 · Fri, Oct 8, 2027");
      await button(dialog, "Save scheduled copy").click();
      await button(page, "DCC scheduling preview").click();
      await dialog.getByLabel("Michinoku Coastal Trail", { exact: true }).check();
      await button(dialog, "Publish selected activities").click();
      await page.getByText("Published the selected activities to DCC.").waitFor();
      await page.reload();
      await button(page, "Trip planner").click();
      await button(page, "October coast walk · Original").click();
      await page.getByText("5 days · No dates · Asia/Tokyo", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(problems, []);
      console.log(width + "px: capture, origin, map selection, relative days, comparison, copy, publication and reload passed");
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
