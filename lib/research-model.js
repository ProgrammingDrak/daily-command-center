const { z } = require('zod');
const W = require('./wishlist-model');
const kind = z.enum(['idea','research','requirement','product']);
const id = W.uuid;
const create = z.strictObject({id,kind,title:W.overview.shape.title});
const search = z.strictObject({
  query:z.string().max(300).optional(), kind:z.enum(['all','wishlist','idea','research','requirement','product']).default('all'),
  status:z.array(z.string().max(40)).max(30).optional(), category:z.string().max(300).optional(),
  tag:z.string().max(80).optional(), archived:z.boolean().default(false),
  purchases:z.boolean().default(false), dormantBefore:z.iso.date().optional(),
  sort:z.enum(['recent','created','priority']).default('recent'),
  offset:z.int().min(0).max(100000).default(0),limit:z.int().min(1).max(100).default(40)
});
const edge = z.strictObject({
  mutationId:id,id,revision:z.int().min(0),fromId:id,toId:id.optional(),blockId:z.string().min(1).max(255).optional(),
  relation:z.enum(['related','research','requires','candidate','task','project']),active:z.boolean().default(true),
  data:z.strictObject({quantity:z.int().min(1).max(1000000).optional(),estimatedUnitCost:W.overview.shape.estimatedUnitCost,
    currency:W.overview.shape.currency,notes:z.string().max(8000).optional()}).default({})
}).refine(v=>Boolean(v.toId)!==Boolean(v.blockId),'Supply one relationship target');
const entry = z.strictObject({id,mutationId:id,revision:z.int().min(0),data:W.entry.partial()});
const action = z.strictObject({id,mutationId:id,action:z.enum(['task','purchase-task','project']),title:W.overview.shape.title.optional()});
module.exports={kind,create,search,edge,entry,action};
