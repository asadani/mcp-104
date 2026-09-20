import { openDb,migrate,seed } from '../src/db.js';
import { actor } from '../src/policy.js';
import { ProductionControls,nextHop } from '../src/production.js';

const db=await openDb('memory://');await migrate(db);await seed(db);
const alice=await actor(db,'alice'),controls=new ProductionControls(db);
const reservation=await controls.budget.reserve(alice,25);
await controls.budget.reconcile(alice,reservation,7);
const job=await controls.jobs.create(alice,{kind:'release-report',query:'completed'});
const hop=nextHop({traceId:'lab-trace',deadline:Date.now()+5000,budget:10,visited:['teamspace']},'knowledge',3);
console.log(JSON.stringify({usage:(await db.query('SELECT * FROM usage WHERE org=$1',[alice.org])).rows[0],job,hop},null,2));
await db.close();
