// A worker that runs on its own, for a deployment with a shared PostgreSQL. Needs DATABASE_URL.
import { openDb, migrate } from './db.js';
import { ProductionControls } from './production.js';
import { startWorker } from './worker.js';

if (!process.env.DATABASE_URL?.startsWith('postgres')) throw new Error('DATABASE_URL must point at a shared PostgreSQL: a file or memory database cannot be shared with the API process.');
const db = await openDb(process.env.DATABASE_URL);
await migrate(db);
const stop = startWorker(db, new ProductionControls(db).jobs, `worker-${process.pid}`);
console.log('Teamspace worker running');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await stop(); await db.close(); process.exit(0); });
