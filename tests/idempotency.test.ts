import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, seed } from '../src/db.js';
import { actor, approve, once } from '../src/policy.js';
import { Product } from '../src/product.js';

async function setup() {
  const db = await openDb('memory://');
  await migrate(db);
  await seed(db);
  return { db, p: new Product(db) };
}
const base = { title: 'Release', body: 'Exact body', taskIds: ['task-1'] };

test('a refused write releases its key, so the same key can be used again', async () => {
  const { db, p } = await setup();
  const a = await actor(db, 'alice');
  const t: any = await p.getTask(a, 'task-2');
  await p.updateTask(a, { id: 'task-2', status: 'done', version: t.version, operationKey: 'first-update' });
  // A stale version is a definite refusal: nothing was written.
  await assert.rejects(() => p.updateTask(a, { id: 'task-2', status: 'todo', version: t.version, operationKey: 'retry-key-1' }), (e: any) => e.code === 'CONFLICT');
  const fresh: any = await p.getTask(a, 'task-2');
  const r: any = await p.updateTask(a, { id: 'task-2', status: 'todo', version: fresh.version, operationKey: 'retry-key-1' });
  assert.equal(r.status, 'todo');
  await db.close();
});

test('publishing without an approval does not burn the operation key', async () => {
  const { db, p } = await setup();
  const a = await actor(db, 'alice');
  const key = 'publish-key-A';
  await assert.rejects(() => p.publishPage(a, { ...base, operationKey: key, approvalId: 'invented' }), (e: any) => e.code === 'APPROVAL_REQUIRED');
  const approval = await approve(db, a, { op: 'publish_page', ...base, operationKey: key });
  const page: any = await p.publishPage(a, { ...base, operationKey: key, approvalId: approval });
  assert.equal(page.title, 'Release');
  await db.close();
});

test('a failed transaction rolls back both the write and its claim', async () => {
  const { db } = await setup();
  const a = await actor(db, 'alice');
  await assert.rejects(() => once(db, a, 'atomic-key-1', { x: 1 }, async tx => {
    await tx.query("INSERT INTO tasks(id,org,team,title,status) VALUES('rolled-back','acme','platform','Must vanish','todo')");
    throw new Error('connection dropped');
  }), /connection dropped/);
  assert.equal((await db.query("SELECT id FROM tasks WHERE id='rolled-back'")).rows.length, 0);
  assert.equal((await db.query("SELECT key FROM operations WHERE key LIKE '%:atomic-key-1'")).rows.length, 0);
  assert.equal(await once(db, a, 'atomic-key-1', { x: 1 }, async () => 'safe retry'), 'safe retry');
  await db.close();
});

test('a completed operation is replayed and its work is not run twice', async () => {
  const { db } = await setup();
  const a = await actor(db, 'alice');
  let runs = 0;
  const work = async () => ({ n: ++runs });
  const first = await once(db, a, 'replay-key-1', { x: 1 }, work);
  const second = await once(db, a, 'replay-key-1', { x: 1 }, work);
  assert.deepEqual(second, first);
  assert.equal(runs, 1);
  await db.close();
});
