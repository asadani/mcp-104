import express, { type ErrorRequestHandler } from 'express';
import type { Server } from 'node:http';
import type { Sql } from './db.js';
import { Identity } from './auth.js';
import { actor, Fault } from './policy.js';
import { Product } from './product.js';
import { retry } from './resilience.js';

export const errors:ErrorRequestHandler=(error,_req,res,_next)=>{
  const fault=error instanceof Fault?error:new Fault('INVALID_INPUT',error?.name==='ZodError'?'Arguments do not match the schema. Check required fields and ranges.':'The request could not be completed.',error?.name==='ZodError'?400:500);
  res.status(fault.status).json({code:fault.code,message:fault.message,retryable:fault.retryable});
};
export function listen(app:express.Express,port:number,host='127.0.0.1'):Promise<Server> {
  return new Promise((resolve,reject)=>{const s=app.listen(port,host,()=>resolve(s));s.on('error',reject);});
}
export const portOf=(s:Server)=>(s.address() as {port:number}).port;
export async function startApi(kind:'tasks'|'knowledge',db:Sql,identity:Identity,port=0) {
  const app=express(),product=new Product(db);app.use(express.json({limit:'64kb'}));
  app.post('/invoke/:operation',async(req,res,next)=>{try {
    const a=await actor(db,await identity.subject(req.headers.authorization,kind));
    const p=req.body;
    const operations:Record<string,()=>Promise<unknown>>=kind==='tasks'?{
      search_tasks:()=>product.searchTasks(a,p),get_task:()=>product.getTask(a,p.id),create_task:()=>product.createTask(a,p),update_task:()=>product.updateTask(a,p)
    }:{search_pages:()=>product.searchPages(a,p),read_page:()=>product.readPage(a,p.id),publish_page:()=>product.publishPage(a,p),revise_page:()=>product.revisePage(a,p.id,p.body,p.version)};
    const work=operations[String(req.params.operation)];if(!work) throw new Fault('NOT_FOUND','Unknown API operation.',404);
    res.json(await work());
  }catch(e){next(e);}});app.use(errors);
  return listen(app,port);
}
export class Downstream {
  constructor(public urls:{tasks:string;knowledge:string},public identity:Identity){}
  async call(subject:string,operation:string,args:unknown,deadline=Date.now()+5000) {
    const kind=['search_tasks','get_task','create_task','update_task'].includes(operation)?'tasks':'knowledge';
    const token=await this.identity.issue(subject,kind);
    // A freshly scoped downstream token is used; the incoming MCP token is never forwarded.
    return retry(async signal=>{
      let response:Response;
      try {response=await fetch(`${this.urls[kind]}/invoke/${operation}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(args),signal});}
      catch{throw new Fault('DEPENDENCY_UNAVAILABLE','The product service is unavailable.',503,true);}
      const body=await response.json() as any;
      if(!response.ok) throw new Fault(body.code,body.message,response.status,body.retryable);
      return body;
    },{deadline,safe:operation.startsWith('search_')||operation.startsWith('read_')||operation==='get_task'});
  }
}
