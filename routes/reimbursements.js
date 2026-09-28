const { route } = require("../lib/route-helpers");
const { resolveOwnerStrict } = require("../middleware/resolve-owner");

module.exports = function mount(app, ctx) {
  const { broadcast, reimbursementStore } = ctx;

  app.get("/api/reimbursements", route(async (req) => {
    const { userId } = await resolveOwnerStrict(req);
    return { reimbursements: await reimbursementStore.listForUser(userId) };
  }));

  app.post("/api/reimbursements", route(async (req, res) => {
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const reimbursement = await reimbursementStore.create({
      ownerUserId: userId,
      workspaceId,
      body: req.body || {},
    });
    broadcast("reimbursement-changed", { action: "create", id: reimbursement.id }, workspaceId);
    res.status(201).json({ reimbursement });
  }));

  app.post("/api/reimbursements/:id/payments", route(async (req) => {
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const payment = await reimbursementStore.addPaymentForUser(req.params.id, userId, req.body || {});
    broadcast("reimbursement-changed", { action: "payment", id: req.params.id }, workspaceId);
    return { payment };
  }));

  app.post("/api/reimbursements/:id/share/rotate", route(async (req) => {
    const { userId } = await resolveOwnerStrict(req);
    const share = await reimbursementStore.rotateShare(req.params.id, userId);
    return {
      share,
      url: `${req.protocol}://${req.get("host")}/reimburse/${share.token}`,
    };
  }));

  app.delete("/api/reimbursements/:id/share", route(async (req) => {
    const { userId } = await resolveOwnerStrict(req);
    return reimbursementStore.disableShare(req.params.id, userId);
  }));

  app.delete("/api/reimbursements/:id", route(async (req) => {
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const result = await reimbursementStore.archive(req.params.id, userId);
    broadcast("reimbursement-changed", { action: "archive", id: req.params.id }, workspaceId);
    return result;
  }));

  app.get("/api/public/reimbursements/:token", route(async (req) => ({
    reimbursement: await reimbursementStore.getPublic(req.params.token, req.session?.userId || null),
    signedIn: !!req.session?.userId,
  })));

  app.post("/api/public/reimbursements/:token/claim", route(async (req) => ({
    result: await reimbursementStore.claimPublic(
      req.params.token,
      req.session?.userId || null,
      String(req.body?.participantId || "")
    ),
  })));

  app.post("/api/public/reimbursements/:token/payments", route(async (req) => ({
    payment: await reimbursementStore.addPublicPayment(
      req.params.token,
      req.session?.userId || null,
      req.body || {}
    ),
  })));
};
