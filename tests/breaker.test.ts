import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, seed } from '../src/db.js';
import { Identity } from '../src/auth.js';
import { startApi, Downstream, portOf } from '../src/api.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const codeOf = async (p: Promise<unknown>) => p.then(() => 'ok', (e: any) => e.code as string);

async function setup(tasksDown: boolean) {
  const db = await openDb('memory://');
  await migrate(db);
  await seed(db);
  const identity = new Identity('http://test');
  const tasks = await startApi('tasks', db, identity, 0), knowledge = await startApi('knowledge', db, identity, 0);
  const tasksUrl = `http://127.0.0.1:${portOf(tasks)}`;
  if (tasksDown) tasks.close();                        // the port is now closed: connection refused
  const d = new Downstream({ tasks: tasksUrl, knowledge: `http://127.0.0.1:${portOf(knowledge)}` }, identity, { threshold: 2, recoveryMs: 80 });
  return { db, d, close: async () => { if (!tasksDown) tasks.close(); knowledge.close(); await db.close(); } };
}

test('an unreachable product API opens the circuit, and calls stop reaching it', async () => {
  const { d, close } = await setup(true);
  const write = (i: number) => codeOf(d.call('alice', 'create_task', { title: 'x', operationKey: `breaker-key-${i}` }));
  assert.deepEqual([await write(1), await write(2), await write(3), await write(4)], ['DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE', 'CIRCUIT_OPEN', 'CIRCUIT_OPEN']);
  // Each product API has its own breaker: knowledge is unaffected by the tasks outage.
  assert.equal((await d.call('alice', 'search_pages', {})).total, 1);
  // After the cool-down one probe goes through to the dependency again. It is still down, so the circuit re-opens.
  await sleep(100);
  assert.equal(await write(5), 'DEPENDENCY_UNAVAILABLE');
  assert.equal(await write(6), 'CIRCUIT_OPEN');
  await close();
});

test('a definite refusal from a healthy dependency is not an outage', async () => {
  const { d, close } = await setup(false);
  for (let i = 0; i < 5; i++) assert.equal(await codeOf(d.call('alice', 'get_task', { id: 'task-secret' })), 'NOT_FOUND');
  // Five refusals in a row with a threshold of two, and the circuit is still closed.
  assert.equal((await d.call('alice', 'get_task', { id: 'task-1' })).id, 'task-1');
  await close();
});
