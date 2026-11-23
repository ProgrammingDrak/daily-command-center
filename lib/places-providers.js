const { spawn } = require("node:child_process");
const { z } = require("zod");
const Model = require("./places-model");

const profiles = { Walking: "foot-walking", Cycling: "cycling-regular", Driving: "driving-car" };
const coords = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const providerResult = z.object({ features: z.array(z.object({
  geometry: z.object({ type: z.literal("LineString"), coordinates: z.array(coords).min(2).max(40000) }),
  properties: z.object({
    summary: z.object({ distance: z.number().nonnegative(), duration: z.number().nonnegative() }),
    segments: z.array(z.object({ distance: z.number().nonnegative(), duration: z.number().nonnegative() }))
  })
})).min(1) });

function createRouter({ key = process.env.DCC_PLACES_ORS_KEY, request = fetch } = {}) {
  return {
    available: Boolean(key),
    async route(points, mode) {
      if (!key) throw Model.fail("Live routing is unavailable. Use the stop order or open directions.", 503);
      const profile = profiles[mode];
      if (!profile) throw Model.fail("Live routing supports walking, cycling and driving. Check public transit with its operator.", 422);
      const coordinates = Model.parse(z.array(coords).min(2).max(25), points);
      const response = await request("https://api.openrouteservice.org/v2/directions/" + profile + "/geojson", {
        method: "POST", redirect: "error", signal: globalThis.AbortSignal.timeout(10000),
        headers: { Authorization: key, "Content-Type": "application/json" },
        body: JSON.stringify({ coordinates, instructions: false, elevation: false })
      });
      if (!response.ok) throw Model.fail(response.status === 429 ? "The route provider’s limit was reached." : "No route was available for these stops.", 422);
      const raw = await response.json();
      const parsed = providerResult.safeParse(raw);
      if (!parsed.success) throw Model.fail("The provider returned an incomplete route.", 502);
      const feature = parsed.data.features[0];
      if (feature.properties.segments.length !== coordinates.length - 1)
        throw Model.fail("The provider did not return a route for every leg.", 502);
      return { provider: "openrouteservice", observedAt: new Date().toISOString(), mode,
        geometry: feature.geometry, summary: feature.properties.summary, segments: feature.properties.segments };
    }
  };
}

function imageReader(command = process.env.DCC_PLACES_TESSERACT) {
  return {
    available: Boolean(command),
    async read(bytes, mime) {
      if (!command) throw Model.fail("Screenshot text recognition is unavailable.", 503);
      if (!["image/png", "image/jpeg", "image/webp"].includes(mime) || bytes.length > 5 * 1024 * 1024)
        throw Model.fail("Text recognition supports PNG, JPEG and WebP up to 5 MiB.", 422);
      return new Promise((resolve, reject) => {
        const child = spawn(command, ["stdin", "stdout", "-l", "eng"], { timeout: 12000, stdio: ["pipe", "pipe", "ignore"] });
        let output = "";
        let tooLong = false;
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", chunk => {
          output += chunk;
          if (output.length > 32000) {
            tooLong = true;
            child.kill("SIGKILL");
          }
        });
        const error = () => Model.fail("Could not read screenshot text. Keep the original and enter the details manually.", 422);
        child.stdin.on("error", () => {});
        child.on("error", () => reject(error()));
        child.on("close", code => {
          if (code !== 0 || tooLong || !output.trim()) return reject(error());
          const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
          const name = lines.find(line => line.length >= 4 && line.length <= 160 && /\p{L}/u.test(line)) || "";
          resolve({ text: output.trim().slice(0, 5000), suggestion: name, status: "inferred" });
        });
        child.stdin.end(bytes);
      });
    }
  };
}

module.exports = { createRouter, imageReader };
