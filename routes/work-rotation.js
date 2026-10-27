const {route}=require("../lib/route-helpers");
const {createWorkRotationStore}=require("../work-rotation-store");
module.exports=function mount(app,ctx) {
 const store=createWorkRotationStore(ctx);
 app.use("/api/work-rotation",async(req,res,next)=>{
  res.setHeader("Cache-Control","private, no-store");
  if(!req.session?.userId || !req.workspaceId) return res.status(401).json({error:"Sign in to switch tasks"});
  try {
   const {rows}=await ctx.pool.query("SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role='owner'",[req.workspaceId,req.session.userId]);
   if(!rows.length) return res.status(403).json({error:"Only the workspace owner can switch tasks"});
   req.rotationOwner={userId:req.session.userId,workspaceId:req.workspaceId};next();
  }catch(e){next(e);}
 });
 app.get("/api/work-rotation",route(req=>store.get(req.rotationOwner)));
 app.post("/api/work-rotation",route(async req=>{
  const result=await store.mutate(req.rotationOwner,req.body||{});
  if(result.blocks?.length) ctx.broadcast("blocks-changed",{action:"work-switch",blockIds:result.blocks.map(b=>b.id)},req.workspaceId);
  return result;
 }));
};
