const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(require.resolve('./routes/social-todo'),'utf8');
const ctx={crypto,getRequestOrigin:()=> 'synthetic-origin'};vm.createContext(ctx);
vm.runInContext(source.match(/function todoActorKey\(req\) \{[\s\S]*?\n\}/)[0],ctx);
test('anonymous reactions retain identity across requests while login keeps owner identity',()=>{
 const session={},first=ctx.todoActorKey({session,sessionID:'first-cookie',headers:{'user-agent':'synthetic'}});
 assert.match(first,/^guest:/);assert.equal(session.todoActorKey,first);
 assert.equal(ctx.todoActorKey({session,sessionID:'later-cookie',headers:{'user-agent':'synthetic'}}),first);
 assert.notEqual(ctx.todoActorKey({session:{},sessionID:'other-cookie',headers:{'user-agent':'synthetic'}}),first);
 session.userId=7;assert.equal(ctx.todoActorKey({session}),'user:7');
 delete session.userId;assert.equal(ctx.todoActorKey({session}),first);
});
