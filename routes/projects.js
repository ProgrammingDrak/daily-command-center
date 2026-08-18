const { resolveOwnerStrict } = require("../middleware/resolve-owner");
const { route } = require("../lib/route-helpers");
const { createProjectStore } = require("../project-store");

module.exports = function mountProjects(app, ctx) {
  const { blockDB, broadcast, crypto, pool } = ctx;
  const store = createProjectStore({ blockDB, crypto, pool });

  const owner = async req => {
    const resolved = await resolveOwnerStrict(req);
    return { userId: resolved.userId, workspaceId: resolved.workspaceId };
  };

  function announce(action, rows, workspaceId, extra) {
    const blockIds = (Array.isArray(rows) ? rows : [rows]).filter(Boolean).map(row => row.id || row).filter(Boolean);
    broadcast("blocks-changed", { action, blockIds, ...(extra || {}) }, workspaceId);
  }

  app.get("/api/task-library", route(async req => store.listLibrary(req.workspaceId)));

  app.post("/api/task-library/tasks", route(async req => {
    const taskOwner = await owner(req);
    const task = await store.createTask(req.body || {}, taskOwner);
    announce("task-library-create", task, taskOwner.workspaceId);
    return task;
  }));

  app.patch("/api/task-library/tasks/:id", route(async req => {
    const taskOwner = await owner(req);
    const task = await store.organizeTask(req.params.id, req.body || {}, taskOwner);
    announce("task-library-organize", task, taskOwner.workspaceId);
    return task;
  }));

  app.post("/api/task-library/tasks/reorder", route(async req => {
    const taskOwner = await owner(req);
    const tasks = await store.reorderTasks(req.body && req.body.ids, taskOwner);
    announce("task-library-reorder", tasks, taskOwner.workspaceId);
    return { ok: true, tasks };
  }));

  app.post("/api/task-library/tasks/:id/complete", route(async req => {
    const taskOwner = await owner(req);
    const current = await blockDB.getBlockIncludingDeleted(req.params.id);
    if (!current || current.deleted_at || (current.workspace_id && current.workspace_id !== taskOwner.workspaceId)) {
      const error = new Error("Task not found"); error.statusCode = 404; throw error;
    }
    const completed = req.body && req.body.completed !== false;
    const completedAt = String(req.body && req.body.completedAt || new Date().toISOString());
    const result = await blockDB.setTaskCompletion({
      taskRef: current.id,
      completed,
      completedAt,
      taskDate: current.date || completedAt.slice(0, 10),
      mutationId: String(req.body && req.body.mutationId || `task-library:${crypto.randomUUID()}`),
      expectedRevision: (current.properties || {})._completionRevision || null,
      userId: taskOwner.userId,
      workspaceId: taskOwner.workspaceId,
    });
    announce(completed ? "task-library-complete" : "task-library-reopen", result.broadcastIds || [current.id], taskOwner.workspaceId, {
      dependencyTransitions: result.dependencyTransitions || [], date: result.task && result.task.date,
    });
    return result;
  }));

  app.get("/api/projects", route(async req => {
    const data = await store.listOrganization(req.workspaceId);
    return data.projects;
  }));

  app.post("/api/projects", route(async req => {
    const taskOwner = await owner(req);
    const project = await store.createProject(req.body || {}, taskOwner);
    announce("project-create", project, taskOwner.workspaceId);
    return project;
  }));

  app.patch("/api/projects/:id", route(async req => {
    const taskOwner = await owner(req);
    const project = await store.patchProject(req.params.id, req.body || {}, taskOwner);
    announce("project-update", project, taskOwner.workspaceId);
    return project;
  }));

  app.get("/api/task-facets", route(async req => {
    const data = await store.listOrganization(req.workspaceId);
    return data.facets;
  }));

  app.post("/api/task-facets", route(async req => {
    const taskOwner = await owner(req);
    const facet = await store.createFacet(req.body || {}, taskOwner);
    announce("task-facet-create", facet, taskOwner.workspaceId);
    return facet;
  }));

  app.patch("/api/task-facets/:id", route(async req => {
    const taskOwner = await owner(req);
    const facet = await store.patchFacet(req.params.id, req.body || {}, taskOwner);
    announce("task-facet-update", facet, taskOwner.workspaceId);
    return facet;
  }));

  app.get("/api/task-views", route(async req => {
    const data = await store.listOrganization(req.workspaceId);
    return { builtin: require("../project-store").BUILTIN_VIEWS, saved: data.views };
  }));

  app.post("/api/task-views", route(async req => {
    const taskOwner = await owner(req);
    const view = await store.createView(req.body || {}, taskOwner);
    announce("task-view-create", view, taskOwner.workspaceId);
    return view;
  }));

  app.patch("/api/task-views/:id", route(async req => {
    const taskOwner = await owner(req);
    const view = await store.patchView(req.params.id, req.body || {}, taskOwner);
    announce("task-view-update", view, taskOwner.workspaceId);
    return view;
  }));

  app.delete("/api/task-views/:id", route(async req => {
    const taskOwner = await owner(req);
    const result = await store.deleteView(req.params.id, taskOwner);
    announce("task-view-delete", req.params.id, taskOwner.workspaceId);
    return result;
  }));

  app.post("/api/projects/import/preview", route(async req => store.previewImport(req.body || {})));

  app.post("/api/projects/import/commit", route(async req => {
    const taskOwner = await owner(req);
    const result = await store.commitImport(req.body && req.body.manifest, req.body || {}, taskOwner);
    announce("project-import", [result.project].concat(result.tasks || []), taskOwner.workspaceId);
    return result;
  }));
};
