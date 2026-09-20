import type { Sql } from './db.js';
import { actor } from './policy.js';
import { Product } from './product.js';
import type { Jobs } from './production.js';

type Job = { id: string; actor: string; input: any };

// The release-report job: completed tasks that match the query, scoped to the job owner's own team.
export async function releaseReport(db: Sql, job: Job) {
  const a = await actor(db, job.actor);
  const found = await new Product(db).searchTasks(a, { query: String(job.input?.query ?? ''), status: 'done', limit: 50 });
  return { generatedFor: a.id, total: found.total, tasks: found.items.map((t: any) => ({ id: t.id, title: t.title })) };
}

// One turn of the loop: lease, run, then complete or fail. Returns what happened.
export async function processOne(db: Sql, jobs: Jobs, workerId: string, handler = releaseReport) {
  const job: any = await jobs.lease(workerId);
  if (!job) return 'idle' as const;
  try {
    const result = await handler(db, job);
    return (await jobs.complete(job.id, result, workerId)) ? ('completed' as const) : ('lease-lost' as const);
  } catch (e: any) {
    await jobs.fail(job.id, String(e?.message ?? e), workerId);
    return 'failed' as const;
  }
}

export function startWorker(db: Sql, jobs: Jobs, workerId: string, { pollMs = 1000 } = {}) {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const outcome = await processOne(db, jobs, workerId).catch(() => 'error' as const);
      if (outcome === 'idle' || outcome === 'error') await new Promise(r => setTimeout(r, pollMs));
    }
  })();
  return async () => { stopped = true; await loop; };
}
