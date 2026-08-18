const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BUILTIN_VIEWS,
  isLibraryTask,
  normalizeFacet,
  normalizeView,
  previewImport,
  validateImportManifest,
} = require("./project-store");

const deterministicCrypto = (() => {
  let counter = 0;
  return { randomUUID: () => `uuid-${++counter}` };
})();

test("the Task Library has useful backlog replacement views", () => {
  assert.deepEqual(BUILTIN_VIEWS.map(view => view.id), [
    "all-open", "unscheduled", "scheduled", "solo", "waiting", "completed",
  ]);
  assert.equal(BUILTIN_VIEWS.find(view => view.id === "solo").query.projectId, "solo");
  assert.equal(BUILTIN_VIEWS.find(view => view.id === "waiting").query.readiness, "blocked");
});

test("custom categories preserve stable values and archive removed values", () => {
  const current = {
    kind: "task_facet",
    name: "Area",
    scope: "workspace",
    cardinality: "single",
    values: [
      { id: "outside", name: "Outside", order: 1000, archived: false },
      { id: "kitchen", name: "Kitchen", order: 2000, archived: false },
    ],
  };
  const next = normalizeFacet({
    name: "Location",
    values: [{ id: "outside", name: "Exterior", order: 1000 }, { name: "Attic" }],
  }, current, deterministicCrypto);

  assert.equal(next.name, "Location");
  assert.equal(next.values.find(value => value.id === "outside").name, "Exterior");
  assert.equal(next.values.find(value => value.id === "kitchen").archived, true);
  assert.equal(next.values.find(value => value.name === "Attic").archived, false);
});

test("pasted renovation text becomes reviewed tasks, facets, workstreams, and dependencies", () => {
  const manifest = previewImport({
    projectName: "Griffin Renovation",
    sourceUrl: "https://docs.google.com/document/d/example/edit",
    text: [
      "House Tasks",
      "Outside",
      "Replace back door",
      "Living Room",
      "Buy & install baseboards",
      "Kitchen",
      "Paint baseboards",
    ].join("\n"),
  }, deterministicCrypto);

  assert.equal(manifest.project.name, "Griffin Renovation");
  assert.equal(manifest.parser, "deterministic-v1");
  const buy = manifest.items.find(item => item.title === "Buy baseboards");
  const install = manifest.items.find(item => item.title === "Install baseboards");
  const baseboards = manifest.items.find(item => item.title === "Baseboards" && item.role === "parent");
  assert.ok(buy);
  assert.ok(install);
  assert.ok(baseboards);
  assert.deepEqual(install.dependsOn, [buy.tempId]);
  assert.equal(buy.parentTempId, baseboards.tempId);
  assert.equal(install.area, "Living Room");
  assert.deepEqual(manifest.facets.map(facet => facet.name), ["Area", "Workstream", "Type"]);
  assert.ok(manifest.facets.find(facet => facet.name === "Area").values.includes("Outside"));
});

test("the Griffin document shape preserves nested context, owners, and purchase vendors", () => {
  const manifest = previewImport({
    projectName: "Griffin Renovation",
    text: [
      "\uFEFFWork List by Room",
      "Kitchen",
      "* Buy and replace lighting fixture",
      "* Door to laundry:",
      "   * Paint, install no-latch knob, rehang",
      "Living Room",
      "* Dave:",
      "   * Replacing front door",
      "Buy List",
      "MacBid 👀",
      "* Router (for door hinge cut outs)",
      "Home Depot (Home Improvement)",
      "* Gravel",
    ].join("\n"),
  }, deterministicCrypto);

  const replace = manifest.items.find(item => item.title === "Replace lighting fixture");
  const buy = manifest.items.find(item => item.title === "Buy lighting fixture");
  assert.deepEqual(replace.dependsOn, [buy.tempId]);
  assert.equal(manifest.items.find(item => item.title.startsWith("Door to laundry:")).area, "Kitchen");
  assert.equal(manifest.items.find(item => item.title === "Replacing front door").owner, "Dave");
  assert.equal(manifest.items.find(item => item.title.startsWith("Router")).vendor, "MacBid");
  assert.equal(manifest.items.find(item => item.title === "Gravel").vendor, "Home Depot (Home Improvement)");
  assert.deepEqual(manifest.facets.find(facet => facet.name === "Vendor").values,
    ["MacBid", "Home Depot (Home Improvement)"]);
});

test("organization rows never leak into task results", () => {
  const project = { id: "p", type: "block", properties: { kind: "project", title: "Project" } };
  const task = { id: "t", type: "block", properties: { kind: "backlog", title: "Do work" } };
  assert.equal(isLibraryTask(project), false);
  assert.equal(isLibraryTask(task), true);
});

test("saved views normalize user-defined columns, grouping, sorting, and scope", () => {
  const view = normalizeView({
    name: "Outside next",
    filters: [{ key: "facet:area", op: "in", value: ["outside"] }],
    groupBy: "facet:workstream",
    sort: { key: "projectOrder", dir: "desc" },
    columns: ["title", "facet:area", "readiness"],
    query: "door",
    density: "compact",
    scope: "all",
  });
  assert.equal(view.name, "Outside next");
  assert.equal(view.groupBy, "facet:workstream");
  assert.deepEqual(view.sort, { key: "projectOrder", dir: "desc" });
  assert.equal(view.scope, "all");
});

test("reviewed imports reject duplicate IDs, missing references, and cycles", () => {
  const base = { version: 1, facets: [], items: [{ tempId: "a", title: "A", dependsOn: [] }] };
  assert.equal(validateImportManifest(base), base);
  assert.throws(() => validateImportManifest({ ...base, items: base.items.concat({ tempId: "a", title: "Again" }) }), /unique stable IDs/);
  assert.throws(() => validateImportManifest({ ...base, items: [{ ...base.items[0], dependsOn: ["missing"] }] }), /reference another imported task/);
  assert.throws(() => validateImportManifest({ ...base, items: [
    { tempId: "a", title: "A", dependsOn: ["b"] },
    { tempId: "b", title: "B", dependsOn: ["a"] },
  ] }), /cannot contain a cycle/);
});
