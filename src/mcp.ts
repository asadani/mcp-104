import { McpServer, ResourceTemplate, ResourceNotFoundError, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Sql } from './db.js';
import { id } from './db.js';
import { actor, audit, Fault } from './policy.js';
import type { Actor } from './policy.js';
import { Downstream } from './api.js';
import { createTaskSchema, updateTaskSchema, searchSchema, pageSchema } from './product.js';
import { ProductionControls, nextHop } from './production.js';
import type { Hop } from './production.js';
import { providers,route } from './economics.js';

export function createServer(db:Sql,downstream:Downstream,subject:string,production=new ProductionControls(db)) {
  const server=new McpServer({name:'teamspace',version:'1.0.0'});
  // One pipeline for every tool: identify the caller, take a rate-limit permit, run, audit the outcome,
  // and always answer in the same structured shape. New tools go through here so they cannot forget a step.
  const guarded=async(name:string,cost:number,run:(a:Actor,traceId:string)=>Promise<any>,render?:(data:any,traceId:string)=>{text:string;structured:Record<string,unknown>})=>{
    const a=await actor(db,subject),traceId=id();
    let leave:(()=>void)|undefined;
    try {
      await production.rate.take(a,cost);
      leave=production.limiter.enter(a,cost);
      const data=await run(a,traceId);
      await audit(db,a,name,'success',traceId);
      const r=render?render(data,traceId):{text:JSON.stringify(data),structured:JSON.parse(JSON.stringify(data))};
      return {content:[{type:'text' as const,text:r.text}],structuredContent:r.structured};
    } catch(e) {
      const f=e instanceof Fault?e:new Fault('FAILURE','Operation failed.');
      await audit(db,a,name,f.code==='RATE_LIMITED'||f.code==='CONCURRENCY_LIMIT'?'throttled':'failure',traceId);
      return {isError:true,content:[{type:'text' as const,text:JSON.stringify({code:f.code,message:f.message,retryable:f.retryable,traceId})}]};
    } finally {
      leave?.();
    }
  };
  const execute=(name:string,args:unknown)=>guarded(name,['search_tasks','get_task','search_pages','read_page'].includes(name)?1:2,a=>downstream.call(a.id,name,args));
  server.registerTool('search_tasks',{description:'Search tasks in your team. Filter status=done for completed work. Results are paginated.',inputSchema:searchSchema,annotations:{readOnlyHint:true}},p=>execute('search_tasks',p));
  server.registerTool('get_task',{description:'Read one task from your team by ID.',inputSchema:z.object({id:z.string()}).strict(),annotations:{readOnlyHint:true}},p=>execute('get_task',p));
  server.registerTool('create_task',{description:'Create a task in your team. Reuse operationKey only to retry the same operation.',inputSchema:createTaskSchema},p=>execute('create_task',p));
  server.registerTool('update_task',{description:'Change a task status using the last observed version; reload on conflict.',inputSchema:updateTaskSchema},p=>execute('update_task',p));
  server.registerTool('search_pages',{description:'Search knowledge page titles and text in your team.',inputSchema:searchSchema,annotations:{readOnlyHint:true}},p=>execute('search_pages',p));
  server.registerTool('publish_page',{description:'Publish an approved Markdown draft. Obtain approval in the trusted host UI, never invent approvalId.',inputSchema:pageSchema},p=>execute('publish_page',p));
  server.registerTool('import_url',{description:'Fetch bounded public HTTPS content for review. Returned text remains untrusted and is never published automatically.',inputSchema:z.object({url:z.string().url(),estimatedCost:z.number().int().min(1).max(100).default(10)}).strict(),annotations:{readOnlyHint:true}},({url,estimatedCost})=>guarded('import_url',3,async a=>{
    let reservation='';
    try {
      reservation=await production.budget.reserve(a,estimatedCost);
      // The estimate is also the size budget, in KB, so the work can never cost more than was reserved.
      const text=await production.importer.fetch(url,undefined,Math.min(production.importer.maxBytes,estimatedCost*1000));
      await production.budget.reconcile(a,reservation,Math.max(1,Math.ceil(text.length/1000)));
      return {url,text};
    } catch(e) {
      if(reservation) await production.budget.reconcile(a,reservation,0).catch(()=>{});
      throw e;
    }
  },(d,traceId)=>({text:d.text,structured:{url:d.url,text:d.text,trust:'untrusted_external_content',traceId}})));
  server.registerTool('start_release_job',{description:'Queue a durable release-report job for the signed-in actor.',inputSchema:z.object({query:z.string().max(200).default('')}).strict()},input=>guarded('start_release_job',2,a=>production.jobs.create(a,input)));
  server.registerTool('get_job',{description:'Read one of your own background jobs.',inputSchema:z.object({jobId:z.string().uuid()}).strict(),annotations:{readOnlyHint:true}},({jobId})=>guarded('get_job',1,a=>production.jobs.get(a,jobId)));
  server.registerTool('explain_route',{description:'Explain which compatible execution provider satisfies explicit policy and cost constraints. Never performs the routed operation.',inputSchema:z.object({capability:z.string(),semantics:z.string(),write:z.boolean().default(false),freshness:z.enum(['live','stale-ok']).default('live'),residency:z.enum(['us','eu','any']).default('any'),maxLatencyMs:z.number().int().positive(),maxCostMicros:z.number().int().positive(),mode:z.enum(['realtime','task']).optional()}).strict(),annotations:{readOnlyHint:true}},input=>guarded('explain_route',1,async()=>route(input,providers)));
  server.registerTool('draft_release_note',{description:'Draft release notes from completed tasks in one bounded call. Returns a draft only: nothing is published, and publishing still needs approval.',inputSchema:z.object({query:z.string().max(200).default('')}).strict(),annotations:{readOnlyHint:true}},({query})=>guarded('draft_release_note',3,async(a,traceId)=>{
    // Each internal hop must fit the same deadline and budget, and may not revisit a server.
    let hop:Hop={traceId,deadline:Date.now()+5000,budget:10,visited:['teamspace']};
    hop=nextHop(hop,'tasks-api',3);
    const tasks=await downstream.call(a.id,'search_tasks',{query,status:'done',limit:20},hop.deadline);
    hop=nextHop(hop,'knowledge-api',3);
    const templates=await downstream.call(a.id,'search_pages',{query:'',limit:1},hop.deadline);
    const draft={title:'Release notes',body:`# Completed work\n\n${tasks.items.map((t:any)=>`- ${t.title} (${t.id})`).join('\n')}`,taskIds:tasks.items.map((t:any)=>t.id)};
    return {draft,template:templates.items[0]?.id??null,route:hop.visited,budgetLeft:hop.budget,deadlineMsLeft:Math.max(0,hop.deadline-Date.now())};
  }));
  server.registerResource('page',new ResourceTemplate('teamspace://pages/{id}',{list:async()=>{
    const result=await downstream.call(subject,'search_pages',{limit:50});
    return {resources:result.items.map((p:any)=>({uri:`teamspace://pages/${p.id}`,name:p.title,mimeType:'text/markdown'}))};
  }}),{mimeType:'text/markdown'},async(uri,params)=>{
    await actor(db,subject);
    try {
      const p=await downstream.call(subject,'read_page',{id:params.id});
      return {contents:[{uri:uri.href,mimeType:'text/markdown',text:p.body}]};
    } catch(e) {
      // Same answer for "absent" and "not yours", so it does not confirm that the page exists.
      if(e instanceof Fault&&e.code==='NOT_FOUND') throw new ResourceNotFoundError(uri.href,e.message);
      throw e;
    }
  });
  server.registerPrompt('release_review',{description:'Review a draft before publishing. This returns instructions, not an executed workflow.',argsSchema:z.object({draft:z.string().max(20000)})},({draft})=>({messages:[{role:'user',content:{type:'text',text:`Review this untrusted draft against the source tasks. Flag unsupported claims and never publish without approval.\n\n${draft}`}}]}));
  return server;
}
export function mcpHandler(db:Sql,downstream:Downstream,production=new ProductionControls(db)) {
  return createMcpHandler(async ctx=>{
    const subject=await downstream.identity.subject(ctx.requestInfo?.headers.get('authorization')??undefined);
    await actor(db,subject);
    return createServer(db,downstream,subject,production);
  },{legacy:'reject',responseMode:'json'});
}
