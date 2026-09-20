import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { openDb, migrate, seed } from '../src/db.js';
import { Identity } from '../src/auth.js';
import { startApi, Downstream, portOf } from '../src/api.js';
import { createServer } from '../src/mcp.js';
import { actor } from '../src/policy.js';
import { FairLimiter, Jobs, ProductionControls, SafeImporter } from '../src/production.js';

async function harness(subject: string, configure?: (p: ProductionControls) => void) {
  const db = await openDb('memory://');
  await migrate(db);
  await seed(db);
  const identity = new Identity('http://test');
  const ta = await startApi('tasks', db, identity, 0), ka = await startApi('knowledge', db, identity, 0);
  const d = new Downstream({ tasks: `http://127.0.0.1:${portOf(ta)}`, knowledge: `http://127.0.0.1:${portOf(ka)}` }, identity);
  const production = new ProductionControls(db);
  configure?.(production);
  const server = createServer(db, d, subject, production);
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return { db, client, close: async () => { await client.close(); ta.close(); ka.close(); await db.close(); } };
}
const body = (r: any) => JSON.parse(r.content[0].text);

test('the address check refuses internal space, including IPv4-mapped IPv6 and shared space', async () => {
  const internal = ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::1', '2001:db8::1'];
  const publicAddresses = ['93.184.216.34', '172.32.0.9', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946', '::ffff:93.184.216.34'];
  for (const [list, expectRefused] of [[internal, true], [publicAddresses, false]] as const) {
    for (const address of list) {
      const importer = new SafeImporter(1000, 1, (async () => [{ address, family: address.includes(':') ? 6 : 4 }]) as any);
      const verdict = await importer.validate('https://example.test/x').then(() => 'allowed', (e: any) => e.code);
      assert.equal(verdict, expectRefused ? 'URL_REJECTED' : 'allowed', address);
    }
  }
});

test('a viewer cannot queue a job, and a member on the free plan gets PLAN_REQUIRED', async () => {
  const db = await openDb('memory://');
  await migrate(db);
  await seed(db);
  const jobs = new Jobs(db);
  await assert.rejects(async () => jobs.create(await actor(db, 'viewer'), { q: 'x' }), (e: any) => e.code === 'FORBIDDEN');
  await assert.rejects(async () => jobs.create(await actor(db, 'eve'), {}), (e: any) => e.code === 'PLAN_REQUIRED');
  assert.equal((await jobs.create(await actor(db, 'bob'), {})).status, 'queued');
  await db.close();
});

test('job tools use the same pipeline: a structured error and an audit row', async () => {
  const h = await harness('eve');
  const res: any = await h.client.callTool({ name: 'start_release_job', arguments: {} });
  assert.equal(res.isError, true);
  const err = body(res);
  assert.equal(err.code, 'PLAN_REQUIRED');
  assert.equal(err.retryable, false);
  assert.match(err.traceId, /^[0-9a-f-]{36}$/);
  const audit = (await h.db.query('SELECT operation, outcome FROM audit WHERE trace_id=$1', [err.traceId])).rows;
  assert.deepEqual(audit, [{ operation: 'start_release_job', outcome: 'failure' }]);
  await h.close();
});

test('a successful job call is audited too', async () => {
  const h = await harness('alice');
  const started: any = await h.client.callTool({ name: 'start_release_job', arguments: { query: 'completed' } });
  assert.equal(started.isError, undefined);
  const { jobId } = started.structuredContent;
  const got: any = await h.client.callTool({ name: 'get_job', arguments: { jobId } });
  assert.equal(got.structuredContent.status, 'queued');
  const ops = (await h.db.query('SELECT operation, outcome FROM audit ORDER BY created_at')).rows;
  assert.deepEqual(ops, [{ operation: 'start_release_job', outcome: 'success' }, { operation: 'get_job', outcome: 'success' }]);
  await h.close();
});

test('the job tools now spend rate-limit permits, and throttling is audited as throttled', async () => {
  const h = await harness('alice', p => { p.limiter = new FairLimiter(1, 0, 3, () => 0); });
  const args = { jobId: '11111111-1111-4111-8111-111111111111' };
  const first: any = await h.client.callTool({ name: 'get_job', arguments: args });
  assert.equal(body(first).code, 'NOT_FOUND');        // it got its permit (capacity 1) and ran
  const second: any = await h.client.callTool({ name: 'get_job', arguments: args });
  assert.equal(body(second).code, 'RATE_LIMITED');    // the bucket is now empty
  const outcomes = (await h.db.query('SELECT outcome FROM audit ORDER BY created_at')).rows.map((r: any) => r.outcome);
  assert.deepEqual(outcomes, ['failure', 'throttled']);
  await h.close();
});

test('explain_route goes through the pipeline: it is audited and returns structured content', async () => {
  const h = await harness('alice');
  const res: any = await h.client.callTool({ name: 'explain_route', arguments: { capability: 'task.search', semantics: 'teamspace-v1', maxLatencyMs: 500, maxCostMicros: 100 } });
  assert.equal(res.isError, undefined);
  assert.equal(res.structuredContent.selected.id, 'teamspace-standard-us');
  const ops = (await h.db.query('SELECT operation, outcome FROM audit')).rows;
  assert.deepEqual(ops, [{ operation: 'explain_route', outcome: 'success' }]);
  await h.close();
});

test('draft_release_note carries one deadline, budget and route through both internal hops', async () => {
  const h = await harness('alice');
  const res: any = await h.client.callTool({ name: 'draft_release_note', arguments: {} });
  assert.equal(res.isError, undefined);
  const s = res.structuredContent;
  assert.deepEqual(s.route, ['teamspace', 'tasks-api', 'knowledge-api']);
  assert.equal(s.budgetLeft, 4);                        // 10, minus 3 for each of two hops
  assert.deepEqual(s.draft.taskIds, ['task-1']);
  assert.match(s.draft.body, /Ship the search endpoint \(task-1\)/);
  assert.ok(s.deadlineMsLeft > 0 && s.deadlineMsLeft <= 5000);
  assert.deepEqual((await h.db.query('SELECT operation, outcome FROM audit')).rows, [{ operation: 'draft_release_note', outcome: 'success' }]);
  await h.close();
  const sam = await harness('sam');                     // another team: same tool, its own scope
  const theirs: any = await sam.client.callTool({ name: 'draft_release_note', arguments: {} });
  assert.deepEqual(theirs.structuredContent.draft.taskIds, []);
  await sam.close();
});
