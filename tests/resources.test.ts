import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { openDb, migrate, seed } from '../src/db.js';
import { Identity } from '../src/auth.js';
import { startApi, Downstream, portOf } from '../src/api.js';
import { createServer } from '../src/mcp.js';

async function connectAs(subject: string) {
  const db = await openDb('memory://');
  await migrate(db);
  await seed(db);
  const identity = new Identity('http://test');
  const ta = await startApi('tasks', db, identity, 0), ka = await startApi('knowledge', db, identity, 0);
  const d = new Downstream({ tasks: `http://127.0.0.1:${portOf(ta)}`, knowledge: `http://127.0.0.1:${portOf(ka)}` }, identity);
  const server = createServer(db, d, subject);
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return { client, close: async () => { await client.close(); ta.close(); ka.close(); await db.close(); } };
}

// The SDK reports a resource that is not found as JSON-RPC "invalid params" (-32602) with the URI in data,
// which a host can tell apart from -32603, "internal error". It used to receive -32603 for every refusal.
const notFound = (uri: string) => (e: any) => e.code === -32602 && e.data?.uri === uri && /not found in your team/i.test(e.message);

test('a refused resource read is a structured not-found, the same as a page that does not exist', async () => {
  const uri = 'teamspace://pages/page-1';
  const alice = await connectAs('alice');
  try {
    const page: any = await alice.client.readResource({ uri });
    assert.match(page.contents[0].text, /Review completed tasks/);
    const missing = 'teamspace://pages/no-such-page';
    await assert.rejects(() => alice.client.readResource({ uri: missing }), notFound(missing));
  } finally { await alice.close(); }
  // Another team and another organisation get exactly the answer a missing page gets.
  for (const who of ['sam', 'eve']) {
    const c = await connectAs(who);
    try { await assert.rejects(() => c.client.readResource({ uri }), notFound(uri), who); } finally { await c.close(); }
  }
});
