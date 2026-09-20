import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Identity, requireToken } from '../src/auth.js';
import { listen, portOf } from '../src/api.js';

test('the /mcp edge answers 401 with a WWW-Authenticate challenge, never a 500', async () => {
  const origin = 'http://test.local';
  const identity = new Identity(origin);
  const app = express();
  app.use('/mcp', requireToken(identity, origin));
  app.all('/mcp', (_req, res) => { res.json({ reached: true }); });
  const server = await listen(app, 0);
  const url = `http://127.0.0.1:${portOf(server)}/mcp`;
  const post = (headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers });

  const cases: [string, Record<string, string>][] = [
    ['no token', {}],
    ['garbage token', { Authorization: 'Bearer abc.def.ghi' }],
    ['a token minted for another audience', { Authorization: `Bearer ${await identity.issue('alice', 'tasks')}` }],
    ['a token from another issuer', { Authorization: `Bearer ${await new Identity('http://elsewhere', 'x'.repeat(32)).issue('alice')}` }],
  ];
  for (const [name, headers] of cases) {
    const res = await post(headers);
    assert.equal(res.status, 401, name);
    assert.match(res.headers.get('www-authenticate') ?? '', /^Bearer resource_metadata="http:\/\/test\.local\/\.well-known\/oauth-protected-resource"$/, name);
    assert.equal(((await res.json()) as any).code, 'UNAUTHORIZED', name);
  }
  const ok = await post({ Authorization: `Bearer ${await identity.issue('alice')}` });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { reached: true });
  server.close();
});
