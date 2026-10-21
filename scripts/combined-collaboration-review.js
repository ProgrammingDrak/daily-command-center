// Disposable combined review only. Both features share the same synthetic DB,
// identities, production route handlers, account binding and canonical blocks.
const helpers=require('../lib/route-helpers');
module.exports=function mount(app,ctx){
  if(process.env.DCC_COMBINED_REVIEW!=='1' || process.env.DCC_SHARED_TASK_REVIEW!=='1' || !process.env.DCC_PGLITE_MODULE)throw new Error('Explicit synthetic combined review required');
  Object.assign(ctx,helpers);
  ctx.commitmentBounty=require('../routes/social-todo')({get(){},post(){},use(){},delete(){},put(){},patch(){}},ctx);
  require('../routes/commitments')(app,ctx);
  require('../routes/friend-invites')(app,{...ctx,path:require('node:path'),PROJECT_DIR:require('node:path').resolve(__dirname,'..')});
};
