import { openDb,migrate,seed } from '../src/db.js';
import { actor } from '../src/policy.js';
import { Product } from '../src/product.js';
const lab=process.argv[2]??'01',db=await openDb('memory://');await migrate(db);await seed(db);const p=new Product(db);
const alice=await actor(db,'alice'),eve=await actor(db,'eve');
const scenarios:Record<string,()=>Promise<unknown>>={
  '01':async()=>({alice:await p.searchTasks(alice,{}),eve:await p.searchTasks(eve,{})}),
  '02':async()=>p.createTask(alice,{title:'Lab-created task',operationKey:'lab-02-create'}),
  '03':async()=>p.searchTasks(alice,{status:'done',limit:1}),
  '07':async()=>{try{return await p.getTask(alice,'task-secret')}catch(e:any){return{rejected:e.code,message:e.message}}},
  '11':async()=>{const t=await p.getTask(alice,'task-2');await p.updateTask(alice,{id:t.id,status:'done',version:t.version,operationKey:'lab-update-1'});try{return await p.updateTask(alice,{id:t.id,status:'todo',version:t.version,operationKey:'lab-update-2'})}catch(e:any){return{rejected:e.code,message:e.message}}}
};
if(!scenarios[lab]) throw new Error(`Lab ${lab} has a reading checkpoint; runnable scenarios: ${Object.keys(scenarios).join(', ')}`);
console.log(JSON.stringify(await scenarios[lab](),null,2));await db.close();
