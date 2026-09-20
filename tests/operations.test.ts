import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, seed } from '../src/db.js';
import { actor } from '../src/policy.js';
import { Budget, FairLimiter, Jobs, SharedRate } from '../src/production.js';
import { processOne } from '../src/worker.js';

async function setup() {
  const db = await openDb('memory://');
  await migrate(db);
  await seed(db);
  return db;
}
const usage = async (db: any, org = 'acme') => (await db.query('SELECT spent, reserved, allowance FROM usage WHERE org=$1', [org])).rows[0];
const codeOf = async (p: Promise<unknown> | (() => unknown)) => (typeof p === 'function' ? Promise.resolve().then(p) : p).then(() => 'ok', (e: any) => e.code as string);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/* ---------- budget ---------- */
test('a reservation that is never settled expires and frees its hold', async () => {
  const db = await setup(), alice = await actor(db, 'alice');
  const stale = new Budget(db, -1);                   // a hold that is already past its expiry
  const lost = await stale.reserve(alice, 600);
  assert.equal((await usage(db)).reserved, 600);
  // Without expiry this would be 600 + 600 > 1000 and fail with BUDGET_EXCEEDED.
  await new Budget(db).reserve(alice, 600);
  assert.equal((await usage(db)).reserved, 600);       // only the live hold remains
  // The abandoned work did happen, so its real cost is still recorded, without releasing the hold twice.
  await stale.reconcile(alice, lost, 50);
  assert.deepEqual(await usage(db), { spent: 50, reserved: 600, allowance: 1000 });
  await db.close();
});

test('a reservation is a ceiling: settlement never charges more than was reserved', async () => {
  const db = await setup(), alice = await actor(db, 'alice'), b = new Budget(db);
  const r = await b.reserve(alice, 100);
  await b.reconcile(alice, r, 500);
  assert.deepEqual(await usage(db), { spent: 100, reserved: 0, allowance: 1000 });
  assert.equal((await db.query('SELECT actual FROM reservations WHERE id=$1', [r])).rows[0].actual, 500);   // the overrun is still on record
  assert.equal(await codeOf(b.reconcile(alice, r, 1)), 'INVALID_RESERVATION');
  await db.close();
});

/* ---------- jobs and the worker ---------- */
test('a worker runs a release-report job for its owner, scoped to the owner’s team', async () => {
  const db = await setup(), jobs = new Jobs(db);
  const mine = await jobs.create(await actor(db, 'alice'), { query: '' });
  const theirs = await jobs.create(await actor(db, 'sam'), { query: '' });
  assert.equal(await processOne(db, jobs, 'w1'), 'completed');
  assert.equal(await processOne(db, jobs, 'w1'), 'completed');
  assert.equal(await processOne(db, jobs, 'w1'), 'idle');
  const a: any = await jobs.get(await actor(db, 'alice'), mine.jobId), s: any = await jobs.get(await actor(db, 'sam'), theirs.jobId);
  assert.equal(a.status, 'completed');
  assert.deepEqual(a.result.tasks, [{ id: 'task-1', title: 'Ship the search endpoint' }]);
  assert.equal(s.result.total, 0);                     // Sam's team has no completed work, and cannot see Platform's
  await db.close();
});

test('a slow worker cannot complete a job that another worker has taken over', async () => {
  const db = await setup(), jobs = new Jobs(db), alice = await actor(db, 'alice');
  const { jobId } = await jobs.create(alice, {});
  await jobs.lease('w1');
  await db.query(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id=$1`, [jobId]);
  const second: any = await jobs.lease('w2');
  assert.equal(second.lease_owner, 'w2');
  assert.equal(await jobs.complete(jobId, { late: true }, 'w1'), false);
  assert.equal(await jobs.complete(jobId, { ok: true }, 'w2'), true);
  assert.deepEqual((await jobs.get(alice, jobId)).result, { ok: true });
  await db.close();
});

test('a job that keeps failing is retried, then dead-lettered with its reason', async () => {
  const db = await setup(), jobs = new Jobs(db, 2), alice = await actor(db, 'alice');
  const { jobId } = await jobs.create(alice, {});
  const boom = async () => { throw new Error('report service down'); };
  assert.equal(await processOne(db, jobs, 'w1', boom), 'failed');      // attempt 1: back in the queue
  assert.equal((await jobs.get(alice, jobId)).status, 'queued');
  assert.equal(await processOne(db, jobs, 'w1', boom), 'failed');      // attempt 2: out of attempts
  const done: any = await jobs.get(alice, jobId);
  assert.deepEqual([done.status, done.attempts, done.result], ['failed', 2, { error: 'report service down' }]);
  assert.equal(await processOne(db, jobs, 'w1'), 'idle');              // and it is not leased again
  await db.close();
});

test('a job whose worker keeps crashing is dead-lettered instead of re-leased forever', async () => {
  const db = await setup(), jobs = new Jobs(db, 2), alice = await actor(db, 'alice');
  const { jobId } = await jobs.create(alice, {});
  const lapse = () => db.query(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id=$1`, [jobId]);
  assert.ok(await jobs.lease('w1')); await lapse();
  assert.ok(await jobs.lease('w2')); await lapse();
  assert.equal(await jobs.lease('w3'), undefined);
  const j: any = await jobs.get(alice, jobId);
  assert.deepEqual([j.status, j.attempts, j.result], ['failed', 2, { error: 'attempts exhausted' }]);
  await db.close();
});

/* ---------- rate limiting ---------- */
test('the token bucket is shared: two replicas draw from one allowance', async () => {
  const db = await setup(), alice = await actor(db, 'alice');
  const replicaA = new SharedRate(db, 3, 0), replicaB = new SharedRate(db, 3, 0);
  assert.equal(await codeOf(replicaA.take(alice)), 'ok');
  assert.equal(await codeOf(replicaB.take(alice)), 'ok');
  assert.equal(await codeOf(replicaA.take(alice)), 'ok');
  assert.equal(await codeOf(replicaB.take(alice)), 'RATE_LIMITED');    // each replica alone would have allowed three more
  assert.equal(await codeOf(new SharedRate(db, 3, 0).take(await actor(db, 'bob'))), 'ok');   // another member has their own bucket
  assert.equal(await codeOf(new SharedRate(db, 2, 0).take(await actor(db, 'sam'), 3)), 'RATE_LIMITED');   // dearer than the whole bucket
  await db.close();
});

test('the token bucket refills over time', async () => {
  const db = await setup(), bob = await actor(db, 'bob'), r = new SharedRate(db, 2, 10);   // 10 tokens a second: slow enough that the second call is refused even on a busy machine
  assert.equal(await codeOf(r.take(bob, 2)), 'ok');
  assert.equal(await codeOf(r.take(bob, 2)), 'RATE_LIMITED');
  await sleep(400);                                    // 0.4 s at 10 a second is 4 tokens, capped at the capacity of 2
  assert.equal(await codeOf(r.take(bob, 2)), 'ok');
  await db.close();
});

test('one member cannot hold every slot their organisation has', async () => {
  const db = await setup(), alice = await actor(db, 'alice'), bob = await actor(db, 'bob'), eve = await actor(db, 'eve');
  const l = new FairLimiter(100, 100, 3, () => 0);     // an organisation may run three at once; a member, two
  l.enter(alice); l.enter(alice);
  assert.equal(await codeOf(() => l.enter(alice)), 'CONCURRENCY_LIMIT');
  const leave = l.enter(bob);                           // a colleague still gets in
  assert.equal(await codeOf(() => l.enter(bob)), 'CONCURRENCY_LIMIT');   // now the organisation is full
  assert.equal(await codeOf(() => l.enter(eve)), 'ok');                  // and another organisation is untouched
  leave();
  await db.close();
});
