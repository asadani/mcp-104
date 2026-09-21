import express from 'express';
import { createServer } from 'node:http';
import { openDb,migrate,seed,startOperationalCleanup } from './db.js';
import { Identity, requireToken } from './auth.js';
import { startApi,Downstream,errors,portOf } from './api.js';
import { mcpHandler } from './mcp.js';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { actor,approve,operatorAllowed } from './policy.js';
import { Product } from './product.js';
import { prepareRelease } from './host.js';
import { ProductionControls } from './production.js';
import { startWorker } from './worker.js';
import { defaultExperiment } from './economics.js';

// Fail fast: a production process without these would quietly use a local file database, a random token key and the wrong issuer.
if(process.env.NODE_ENV==='production') for(const k of ['DATABASE_URL','TOKEN_SECRET','PUBLIC_ORIGIN']) if(!process.env[k]) throw new Error(`${k} is required when NODE_ENV=production`);
const port=Number(process.env.PORT??3102),host=process.env.HOST??'127.0.0.1';
const origin=process.env.PUBLIC_ORIGIN??`http://${host}:${port}`;
const db=await openDb(process.env.DATABASE_URL??'file://.data/teamspace-104'); await migrate(db); if(process.env.NODE_ENV!=='production'||process.env.SEED_DEMO_DATA==='1') await seed(db);
const stopCleanup=startOperationalCleanup(db);
const identity=new Identity(origin,process.env.TOKEN_SECRET);
const taskServer=await startApi('tasks',db,identity,0),knowledgeServer=await startApi('knowledge',db,identity,0);
const downstream=new Downstream({tasks:`http://127.0.0.1:${portOf(taskServer)}`,knowledge:`http://127.0.0.1:${portOf(knowledgeServer)}`},identity);
const production=new ProductionControls(db);
// In-process worker for convenience. Set WORKER=off and run `npm run worker` (against a shared PostgreSQL) for a separate process.
const stopWorker=process.env.WORKER==='off'?undefined:startWorker(db,production.jobs,`worker-${process.pid}`);
const app=express();
app.get('/healthz',async(_req,res)=>{try{await db.query('SELECT 1');res.json({status:'ok'});}catch{res.status(503).json({status:'unavailable'});}});
app.use('/mcp',requireToken(identity,origin));
app.all('/mcp',toNodeHandler(mcpHandler(db,downstream,production)));
app.use(express.json({limit:'64kb'})); identity.mount(app,process.env.NODE_ENV!=='production');
app.get('/api/session',async(req,res,next)=>{try{const subject=await identity.subject(req.headers.authorization);res.json(await actor(db,subject));}catch(e){next(e);}});
app.get('/api/tasks',async(req,res,next)=>{try{const a=await actor(db,await identity.subject(req.headers.authorization));res.json(await new Product(db).searchTasks(a,{query:req.query.q??'',status:req.query.status||undefined,offset:Number(req.query.offset??0),limit:20}));}catch(e){next(e);}});
app.get('/api/pages',async(req,res,next)=>{try{const a=await actor(db,await identity.subject(req.headers.authorization));res.json(await new Product(db).searchPages(a,{query:req.query.q??'',offset:0,limit:20}));}catch(e){next(e);}});
app.post('/api/host/prepare',async(req,res,next)=>{try{const token=String(req.headers.authorization??'').replace(/^Bearer /,'');res.json(await prepareRelease(`${origin}/mcp`,token));}catch(e){next(e);}});
app.post('/api/approve',async(req,res,next)=>{try{const a=await actor(db,await identity.subject(req.headers.authorization));res.json({approvalId:await approve(db,a,{op:'publish_page',...req.body})});}catch(e){next(e);}});
app.post('/api/publish',async(req,res,next)=>{try{const a=await actor(db,await identity.subject(req.headers.authorization));res.json(await new Product(db).publishPage(a,req.body));}catch(e){next(e);}});
app.get('/api/ops',async(req,res,next)=>{try{const a=await actor(db,await identity.subject(req.headers.authorization));operatorAllowed(a);const usage=(await db.query('SELECT spent,reserved,allowance FROM usage WHERE org=$1',[a.org])).rows[0];const auditRows=(await db.query('SELECT operation,outcome,trace_id,created_at FROM audit WHERE org=$1 ORDER BY created_at DESC LIMIT 12',[a.org])).rows;res.json({usage,audit:auditRows});}catch(e){next(e);}});
app.get('/api/economics',async(req,res,next)=>{try{await actor(db,await identity.subject(req.headers.authorization));res.json(defaultExperiment());}catch(e){next(e);}});
app.use(errors);
if(process.env.NODE_ENV==='production'){app.use(express.static('dist'));app.get('/{*path}',(_q,r)=>r.sendFile(`${process.cwd()}/dist/index.html`));}
const server=createServer(app);server.listen(port,host,()=>console.log(`Teamspace 104 API and MCP: ${origin}\nUI development: npm run ui`));
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(async()=>{stopCleanup();await stopWorker?.();taskServer.close();knowledgeServer.close();await db.close();process.exit(0);}));
